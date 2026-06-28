"""AEMO facility registry scraper — authoritative DUID metadata.

Pulls five PARTICIPANT_REGISTRATION tables from the MMSDM monthly archive
and joins them into one per-DUID record in `nem_facility_registry`:

    DUDETAILSUMMARY  DUID → REGIONID, DISPATCHTYPE, STATIONID,
                     TRANSMISSIONLOSSFACTOR (= the FY MLF), SCHEDULE_TYPE
    DUDETAIL         DUID → REGISTEREDCAPACITY / MAXCAPACITY
    DUALLOC          DUID → GENSETID
    GENUNITS         GENSETID → CO2E_ENERGY_SOURCE (fuel), emissions factor
    STATION          STATIONID → STATIONNAME

This replaces hand-curating ~500 DUIDs in static/generators.py: the curated
list keeps providing lat/lon + display names for the map, while this registry
covers *every* registered unit for the fuel mix, station explorer and BESS
leaderboard. It also refreshes `nem_mlf` each run — when AEMO's next-FY loss
factors take effect (July 1), the new archive month carries them automatically.

The archive lags ~1-2 months, which is fine: registration data changes slowly.
URL quirk: the file names contain literal '#', URL-encoded as %23 in the path.
httpx 0.28+ sends a literal %23 correctly (verified %23 → HTTP 200, %2523 → 404
on 2026-06); an older httpx needed the %2523 double-encode, now removed.
"""
from __future__ import annotations

import io
import logging
import zipfile
from datetime import datetime, timedelta, timezone

import httpx

from ..config import HTTP_TIMEOUT, USER_AGENT
from ..db import write_conn
from .mms import parse_mms_csv
from .nem import set_state

log = logging.getLogger("scraper.facilities")

_ARCHIVE_BASE = (
    "https://nemweb.com.au/Data_Archive/Wholesale_Electricity/MMSDM/"
    "{year}/MMSDM_{year}_{month:02d}/MMSDM_Historical_Data_SQLLoader/DATA/"
)
_TABLES = ("DUDETAILSUMMARY", "DUDETAIL", "DUALLOC", "GENUNITS", "STATION")

NEM_REGIONS = {"NSW1", "QLD1", "VIC1", "SA1", "TAS1"}


def _archive_url(table: str, year: int, month: int) -> str:
    base = _ARCHIVE_BASE.format(year=year, month=month)
    return f"{base}PUBLIC_ARCHIVE%23{table}%23FILE01%23{year}{month:02d}010000.zip"


def map_fuel(co2e_source: str | None) -> str | None:
    """Map AEMO CO2E_ENERGY_SOURCE → our Fuel enum (None = unmapped/load)."""
    if not co2e_source:
        return None
    s = co2e_source.lower()
    if "black coal" in s:
        return "coal_black"
    if "brown coal" in s:
        return "coal_brown"
    if any(k in s for k in ("gas", "methane", "diesel", "kerosene", "oil", "distillate")):
        return "gas"
    if "hydro" in s or "water" in s:
        return "hydro"
    if "wind" in s:
        return "wind"
    if "solar" in s or "photovolt" in s:
        return "solar"
    if "battery" in s:
        return "battery"
    if any(k in s for k in ("bagasse", "biogas", "biomass", "landfill", "sewage", "sewerage", "waste")):
        return "bioenergy"
    return None


async def _fetch_table(client: httpx.AsyncClient, table: str,
                       year: int, month: int) -> list[dict[str, str]]:
    url = _archive_url(table, year, month)
    r = await client.get(url, timeout=120.0)
    r.raise_for_status()
    with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
        name = next((n for n in zf.namelist() if n.lower().endswith(".csv")), None)
        if not name:
            raise RuntimeError(f"no CSV in {table} archive zip")
        text = zf.read(name).decode("utf-8", errors="replace")
    tables = parse_mms_csv(text)
    return tables.get(f"PARTICIPANT_REGISTRATION_{table}", [])


async def _find_latest_month(client: httpx.AsyncClient) -> tuple[int, int]:
    """Walk back from the current month until the archive exists (max 4)."""
    now = datetime.now(timezone.utc) + timedelta(hours=10)
    y, m = now.year, now.month
    for _ in range(4):
        url = _archive_url("DUDETAILSUMMARY", y, m)
        try:
            r = await client.head(url, timeout=30.0)
            if r.status_code == 200:
                return y, m
        except httpx.HTTPError:
            pass
        m -= 1
        if m == 0:
            y, m = y - 1, 12
    raise RuntimeError("no MMSDM archive month found in the last 4 months")


def _latest_per_key(rows: list[dict[str, str]], key_col: str,
                    sort_col: str) -> dict[str, dict[str, str]]:
    """Keep the most recent row (max sort_col, string compare works for
    MMS 'YYYY/MM/DD ...' dates) per key."""
    out: dict[str, dict[str, str]] = {}
    for r in rows:
        k = r.get(key_col, "").strip().strip('"')
        if not k:
            continue
        prev = out.get(k)
        if prev is None or r.get(sort_col, "") >= prev.get(sort_col, ""):
            out[k] = r
    return out


def _fy_label(year: int, month: int) -> str:
    """Financial-year label for an archive month (AU FY: Jul–Jun)."""
    if month >= 7:
        return f"{year}-{(year + 1) % 100:02d}"
    return f"{year - 1}-{year % 100:02d}"


async def run_once() -> dict:
    headers = {"User-Agent": USER_AGENT}
    async with httpx.AsyncClient(headers=headers, follow_redirects=True) as client:
        try:
            year, month = await _find_latest_month(client)
        except Exception as e:
            set_state("nem_facilities", None, error=f"month probe failed: {e}")
            log.exception("facilities month probe failed")
            return {"error": str(e)}

        data: dict[str, list[dict[str, str]]] = {}
        for t in _TABLES:
            try:
                data[t] = await _fetch_table(client, t, year, month)
            except Exception as e:
                set_state("nem_facilities", None, error=f"{t} fetch failed: {e}")
                log.exception("facilities %s fetch failed", t)
                return {"error": f"{t}: {e}"}

    # Drop lapsed registrations: DUDETAILSUMMARY is a full history — retired
    # units (Hazelwood, Liddell, …) have END_DATE in the past. Active rows
    # carry END_DATE in the future (often 2999/12/31). MMS dates are
    # 'YYYY/MM/DD HH:MM:SS' strings, so a string compare against today works.
    today_str = (datetime.now(timezone.utc) + timedelta(hours=10)).strftime("%Y/%m/%d")
    active = [
        r for r in data["DUDETAILSUMMARY"]
        if (r.get("END_DATE", "").strip().strip('"') or "9999") >= today_str
    ]
    summary = _latest_per_key(active, "DUID", "START_DATE")
    detail = _latest_per_key(data["DUDETAIL"], "DUID", "EFFECTIVEDATE")
    dualloc = _latest_per_key(data["DUALLOC"], "DUID", "EFFECTIVEDATE")
    genunits = _latest_per_key(data["GENUNITS"], "GENSETID", "LASTCHANGED")
    stations = _latest_per_key(data["STATION"], "STATIONID", "LASTCHANGED")

    src_month = f"{year}-{month:02d}"
    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    rows = []
    for duid, s in summary.items():
        region = s.get("REGIONID", "").strip().strip('"')
        if region not in NEM_REGIONS:
            continue
        # AEMO internal placeholders are not real generation — they'd
        # pollute the station explorer and capacity sums:
        #   DG_*  dispatch dummy generators, RT_* RERT reserve-trader
        #   placeholders, BLNK* Basslink HVDC pseudo-units.
        if duid.startswith(("DG_", "RT_", "BLNK")):
            continue
        station_id = s.get("STATIONID", "").strip().strip('"')
        gensetid = dualloc.get(duid, {}).get("GENSETID", "").strip().strip('"')
        gu = genunits.get(gensetid, {})
        det = detail.get(duid, {})

        def _f(v: str | None) -> float | None:
            try:
                return float(v) if v not in (None, "", '""') else None
            except ValueError:
                return None

        co2e_source = gu.get("CO2E_ENERGY_SOURCE", "").strip().strip('"') or None
        capacity = (_f(det.get("REGISTEREDCAPACITY")) or _f(det.get("MAXCAPACITY"))
                    or _f(gu.get("REGISTEREDCAPACITY")))
        station_name = stations.get(station_id, {}).get("STATIONNAME", "").strip().strip('"')

        rows.append((
            duid,
            station_name or station_id or duid,
            region,
            map_fuel(co2e_source),
            capacity,
            s.get("DISPATCHTYPE", "").strip().strip('"') or None,
            s.get("SCHEDULE_TYPE", "").strip().strip('"') or None,
            _f(s.get("TRANSMISSIONLOSSFACTOR")),
            co2e_source,
            _f(gu.get("CO2E_EMISSIONS_FACTOR")),
            src_month,
            now_iso,
        ))

    if not rows:
        set_state("nem_facilities", None, error="parsed 0 rows")
        return {"error": "parsed 0 rows"}

    with write_conn() as con:
        con.executemany(
            """
            INSERT INTO nem_facility_registry
                (duid, station, region, fuel, capacity_mw, dispatch_type,
                 schedule_type, tlf, co2e_source, emissions_factor,
                 source_month, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(duid) DO UPDATE SET
                station=excluded.station, region=excluded.region,
                fuel=excluded.fuel, capacity_mw=excluded.capacity_mw,
                dispatch_type=excluded.dispatch_type,
                schedule_type=excluded.schedule_type, tlf=excluded.tlf,
                co2e_source=excluded.co2e_source,
                emissions_factor=excluded.emissions_factor,
                source_month=excluded.source_month, updated_at=excluded.updated_at
            """,
            rows,
        )

        # ── Refresh nem_mlf from TLF (the FY marginal loss factor). ──────
        # Curated seed rows keep their lat/lon; archive rows fill the rest.
        fy = _fy_label(year, month)
        mlf_rows = [
            (r[0], fy, r[1], r[2], r[3], r[4], r[7])
            for r in rows if r[7] is not None
        ]
        con.executemany(
            """
            INSERT INTO nem_mlf (duid, financial_year, station_name, region,
                                 fuel_type, capacity_mw, mlf)
            VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(duid, financial_year) DO UPDATE SET
                mlf=excluded.mlf,
                station_name=excluded.station_name,
                capacity_mw=COALESCE(excluded.capacity_mw, nem_mlf.capacity_mw)
            """,
            mlf_rows,
        )

    set_state("nem_facilities", f"MMSDM_{src_month}", error=None)
    log.info("facilities: %d DUIDs from %s archive (%d MLF rows, FY %s)",
             len(rows), src_month, len(mlf_rows), fy)
    return {"duids": len(rows), "month": src_month, "mlf_rows": len(mlf_rows)}
