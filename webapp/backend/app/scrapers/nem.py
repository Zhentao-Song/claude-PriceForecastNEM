"""NEM DispatchIS scraper.

Polls http://nemweb.com.au/Reports/Current/DispatchIS_Reports/, downloads
new ZIP files, parses the embedded MMS CSV, and upserts into DuckDB.
"""
from __future__ import annotations

import io
import logging
import re
import zipfile
from datetime import datetime
from typing import Iterable

import httpx

from ..config import (
    HTTP_TIMEOUT,
    NEM_DISPATCHIS_DIR,
    NEM_REGIONS,
    USER_AGENT,
)
from ..db import locked_conn
from .mms import parse_mms_csv

log = logging.getLogger("scraper.nem")

FILENAME_RE = re.compile(r"PUBLIC_DISPATCHIS_(\d{12})_\d+\.zip", re.IGNORECASE)


def _parse_dt(s: str) -> datetime | None:
    s = s.strip().strip('"')
    if not s:
        return None
    for fmt in ("%Y/%m/%d %H:%M:%S", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def _to_float(s: str) -> float | None:
    s = s.strip().strip('"')
    if s in ("", "NULL"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


async def list_remote_files(client: httpx.AsyncClient) -> list[str]:
    r = await client.get(NEM_DISPATCHIS_DIR, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    names = set(FILENAME_RE.findall(r.text))
    # findall returns timestamps; reconstruct full filenames via href scan
    hrefs = re.findall(r'href="([^"]+\.zip)"', r.text, flags=re.IGNORECASE)
    files = [h.rsplit("/", 1)[-1] for h in hrefs if FILENAME_RE.search(h)]
    return sorted(set(files))


def get_last_file(source: str) -> str | None:
    with locked_conn() as con:
        row = con.execute(
            "SELECT last_file FROM scraper_state WHERE source = ?", (source,)
        ).fetchone()
    return row[0] if row else None


def set_state(source: str, last_file: str | None, error: str | None = None) -> None:
    with locked_conn() as con:
        con.execute(
            """
            INSERT INTO scraper_state (source, last_file, last_run, last_error)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(source) DO UPDATE SET
                last_file = COALESCE(excluded.last_file, scraper_state.last_file),
                last_run  = excluded.last_run,
                last_error = excluded.last_error
            """,
            (source, last_file, datetime.utcnow(), error),
        )


async def fetch_zip(client: httpx.AsyncClient, filename: str) -> bytes:
    url = NEM_DISPATCHIS_DIR + filename
    r = await client.get(url, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    return r.content


def extract_csv(zip_bytes: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        # File typically has one CSV inside.
        name = next((n for n in zf.namelist() if n.lower().endswith(".csv")), None)
        if not name:
            raise RuntimeError("No CSV inside DispatchIS zip")
        with zf.open(name) as f:
            return f.read().decode("utf-8", errors="replace")


def upsert_prices(rows: Iterable[dict[str, str]]) -> int:
    """Upsert DISPATCH_PRICE rows. Returns count written."""
    payload = []
    for r in rows:
        if r.get("INTERVENTION", "0").strip().strip('"') not in ("0", ""):
            # Skip intervention runs to avoid double-counting.
            continue
        region = r.get("REGIONID", "").strip().strip('"')
        if region not in NEM_REGIONS:
            continue
        ts = _parse_dt(r.get("SETTLEMENTDATE", ""))
        if ts is None:
            continue
        payload.append((
            ts, region,
            _to_float(r.get("RRP", "")),
            _to_float(r.get("RAISE6SECRRP", "")),
            _to_float(r.get("RAISE60SECRRP", "")),
            _to_float(r.get("RAISE5MINRRP", "")),
            _to_float(r.get("RAISEREGRRP", "")),
            _to_float(r.get("RAISE1SECRRP", "")),
            _to_float(r.get("LOWER6SECRRP", "")),
            _to_float(r.get("LOWER60SECRRP", "")),
            _to_float(r.get("LOWER5MINRRP", "")),
            _to_float(r.get("LOWERREGRRP", "")),
            _to_float(r.get("LOWER1SECRRP", "")),
        ))
    if not payload:
        return 0
    with locked_conn() as con:
        con.executemany(
            """
            INSERT INTO nem_dispatch_price VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(settlementdate, regionid) DO UPDATE SET
                rrp = excluded.rrp,
                raise6sec_rrp = excluded.raise6sec_rrp,
                raise60sec_rrp = excluded.raise60sec_rrp,
                raise5min_rrp = excluded.raise5min_rrp,
                raisereg_rrp = excluded.raisereg_rrp,
                raise1sec_rrp = excluded.raise1sec_rrp,
                lower6sec_rrp = excluded.lower6sec_rrp,
                lower60sec_rrp = excluded.lower60sec_rrp,
                lower5min_rrp = excluded.lower5min_rrp,
                lowerreg_rrp = excluded.lowerreg_rrp,
                lower1sec_rrp = excluded.lower1sec_rrp
            """,
            payload,
        )
    return len(payload)


def upsert_interconnector_flow(rows: Iterable[dict[str, str]]) -> int:
    """Upsert DISPATCH_INTERCONNECTORRES rows. Captures cleared/metered MW
    flow plus the binding limits, which is what we need to colour congestion.
    """
    payload = []
    for r in rows:
        if r.get("INTERVENTION", "0").strip().strip('"') not in ("0", ""):
            continue
        ic = r.get("INTERCONNECTORID", "").strip().strip('"')
        if not ic:
            continue
        ts = _parse_dt(r.get("SETTLEMENTDATE", ""))
        if ts is None:
            continue
        payload.append((
            ts, ic,
            _to_float(r.get("METEREDMWFLOW", "")),
            _to_float(r.get("MWFLOW", "")),
            _to_float(r.get("MWLOSSES", "")),
            _to_float(r.get("EXPORTLIMIT", "")),
            _to_float(r.get("IMPORTLIMIT", "")),
            _to_float(r.get("MNSP", "")),
        ))
    if not payload:
        return 0
    with locked_conn() as con:
        con.executemany(
            """
            INSERT INTO nem_interconnector_flow VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(settlementdate, interconnectorid) DO UPDATE SET
                metered_mw_flow = excluded.metered_mw_flow,
                mw_flow         = excluded.mw_flow,
                mw_losses       = excluded.mw_losses,
                export_limit    = excluded.export_limit,
                import_limit    = excluded.import_limit,
                mnsp            = excluded.mnsp
            """,
            payload,
        )
    return len(payload)


def upsert_dispatch_constraint(rows: Iterable[dict[str, str]]) -> int:
    """Upsert DISPATCH_CONSTRAINT rows. We only keep *binding* constraints
    (marginalvalue != 0) — non-binding ones produce ~300k rows/day and
    aren't useful for explaining price spikes. Constraint IDs follow AEMO
    naming: prefix encodes region (N=NSW, Q=QLD, V=VIC, S=SA, T=TAS), and
    the rest names the LHS terms (lines, units, demand)."""
    payload = []
    for r in rows:
        if r.get("INTERVENTION", "0").strip().strip('"') not in ("0", ""):
            continue
        constraintid = r.get("CONSTRAINTID", "").strip().strip('"')
        if not constraintid:
            continue
        mv = _to_float(r.get("MARGINALVALUE", ""))
        if mv is None or abs(mv) < 1e-9:
            # Non-binding constraint — drop to keep table small.
            continue
        ts = _parse_dt(r.get("SETTLEMENTDATE", ""))
        if ts is None:
            continue
        payload.append((
            ts, constraintid,
            _to_float(r.get("RHS", "")),
            mv,
            _to_float(r.get("VIOLATIONDEGREE", "")),
        ))
    if not payload:
        return 0
    with locked_conn() as con:
        con.executemany(
            """
            INSERT INTO nem_dispatch_constraint VALUES (?,?,?,?,?)
            ON CONFLICT(settlementdate, constraintid) DO UPDATE SET
                rhs             = excluded.rhs,
                marginalvalue   = excluded.marginalvalue,
                violationdegree = excluded.violationdegree
            """,
            payload,
        )
    return len(payload)


def upsert_region_summary(rows: Iterable[dict[str, str]]) -> int:
    payload = []
    for r in rows:
        if r.get("INTERVENTION", "0").strip().strip('"') not in ("0", ""):
            continue
        region = r.get("REGIONID", "").strip().strip('"')
        if region not in NEM_REGIONS:
            continue
        ts = _parse_dt(r.get("SETTLEMENTDATE", ""))
        if ts is None:
            continue
        payload.append((
            ts, region,
            _to_float(r.get("TOTALDEMAND", "")),
            _to_float(r.get("AVAILABLEGENERATION", "")),
            _to_float(r.get("NETINTERCHANGE", "")),
        ))
    if not payload:
        return 0
    with locked_conn() as con:
        con.executemany(
            """
            INSERT INTO nem_region_summary VALUES (?,?,?,?,?)
            ON CONFLICT(settlementdate, regionid) DO UPDATE SET
                totaldemand = excluded.totaldemand,
                availablegeneration = excluded.availablegeneration,
                netinterchange = excluded.netinterchange
            """,
            payload,
        )
    return len(payload)


async def process_file(client: httpx.AsyncClient, filename: str) -> tuple[int, int, int, int]:
    zip_bytes = await fetch_zip(client, filename)
    csv_text = extract_csv(zip_bytes)
    tables = parse_mms_csv(csv_text)
    n_price = upsert_prices(tables.get("DISPATCH_PRICE", []))
    n_sum = upsert_region_summary(tables.get("DISPATCH_REGIONSUM", []))
    n_ic = upsert_interconnector_flow(tables.get("DISPATCH_INTERCONNECTORRES", []))
    n_con = upsert_dispatch_constraint(tables.get("DISPATCH_CONSTRAINT", []))
    return n_price, n_sum, n_ic, n_con


async def run_once(backfill_n: int = 12) -> dict:
    """Fetch any new DispatchIS files. On first run, pull last `backfill_n` files."""
    headers = {"User-Agent": USER_AGENT}
    async with httpx.AsyncClient(headers=headers, follow_redirects=True) as client:
        try:
            files = await list_remote_files(client)
        except Exception as e:
            set_state("nem_dispatchis", None, error=f"list failed: {e}")
            log.exception("nem list failed")
            return {"error": str(e)}

        if not files:
            return {"new_files": 0}

        last = get_last_file("nem_dispatchis")
        if last is None:
            todo = files[-backfill_n:]
        else:
            todo = [f for f in files if f > last]

        total_price = total_sum = total_ic = total_con = 0
        last_done = last
        for fn in todo:
            try:
                np, ns, nic, ncon = await process_file(client, fn)
                total_price += np
                total_sum += ns
                total_ic += nic
                total_con += ncon
                last_done = fn
                log.info("NEM ingested %s: %d price, %d region, %d ic, %d constraints",
                         fn, np, ns, nic, ncon)
            except Exception as e:
                log.warning("NEM file %s failed: %s", fn, e)
                set_state("nem_dispatchis", last_done, error=str(e))
                break
        set_state("nem_dispatchis", last_done, error=None)
        return {
            "new_files": len(todo),
            "rows_price": total_price,
            "rows_region": total_sum,
            "rows_interconnector": total_ic,
            "rows_constraint": total_con,
        }
