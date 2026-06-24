"""ST PASA scraper — Short-Term Projected Assessment of System Adequacy.

AEMO publishes this hourly at:
  https://nemweb.com.au/Reports/Current/Short_Term_PASA_Reports/

Each ZIP contains a single MMS CSV with two relevant tables:
  - STPASA_REGIONSOLUTION : per-region, per-30-min-interval demand forecasts
                            and reserve conditions (this is what we ingest)
  - STPASA_CASESOLUTION   : case-level summary only, no REGIONID column

Key columns ingested from STPASA_REGIONSOLUTION
------------------------------------------------
  INTERVAL_DATETIME      : end of 30-min interval (NEM time, naive)
  REGIONID               : NEM region
  DEMAND10/50/90         : demand percentile forecasts (MW)
  AVAILABLEGENERATION    : total available generation (MW)
  LOR1LEVEL              : LOR1 threshold (MW) — used as LRC proxy
  RESERVECONDITION       : 0=OK, 1=LOR1, 2=LOR2, 3=LOR3
  RUN_DATETIME           : when AEMO ran this forecast

We only keep the latest-run values per (interval, region); re-running is safe.
"""
from __future__ import annotations

import io
import logging
import re
import zipfile
from datetime import datetime

import httpx

from ..config import HTTP_TIMEOUT, NEM_ST_PASA_DIR, USER_AGENT
from ..db import write_conn
from .mms import parse_mms_csv
from .nem import get_last_file, set_state

log = logging.getLogger("scraper.pasa")

FILENAME_RE = re.compile(r"PUBLIC_STPASA_(\d{12})_\d+\.zip", re.IGNORECASE)
SOURCE_KEY  = "stpasa"


def _to_float(s: str) -> float | None:
    v = s.strip().strip('"')
    if v in ("", "NULL"):
        return None
    try:
        return float(v)
    except ValueError:
        return None


def _to_int(s: str) -> int | None:
    f = _to_float(s)
    return int(f) if f is not None else None


def _clean_dt(s: str) -> str | None:
    """Normalise an AEMO datetime string to 'YYYY-MM-DD HH:MM:SS'."""
    v = s.strip().strip('"')
    if not v:
        return None
    for fmt in ("%Y/%m/%d %H:%M:%S", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(v, fmt).strftime("%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue
    return v[:19] if len(v) >= 19 else None


# ---- Remote helpers -------------------------------------------------------

async def _list_remote(client: httpx.AsyncClient) -> list[str]:
    r = await client.get(NEM_ST_PASA_DIR, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    # Scan both href anchors and raw text — AEMO listing pages vary in format
    hrefs = re.findall(r'href="([^"]+\.zip)"', r.text, flags=re.IGNORECASE)
    from_hrefs = {h.rsplit("/", 1)[-1] for h in hrefs if FILENAME_RE.search(h)}
    from_text  = set(FILENAME_RE.findall(r.text))  # returns just the timestamp part
    # Reconstruct full filenames for matches found only in raw text
    all_files = from_hrefs | {
        f"PUBLIC_STPASA_{ts}_0000000000001.zip"
        for ts in from_text
        if not any(ts in f for f in from_hrefs)
    }
    return sorted(all_files)


async def _fetch_zip(client: httpx.AsyncClient, filename: str) -> bytes:
    r = await client.get(NEM_ST_PASA_DIR + filename, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    return r.content


def _extract_csv(zip_bytes: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        name = next((n for n in zf.namelist() if n.lower().endswith(".csv")), None)
        if not name:
            raise RuntimeError("No CSV inside ST PASA zip")
        with zf.open(name) as f:
            return f.read().decode("utf-8", errors="replace")


# ---- Upsert ---------------------------------------------------------------

def _upsert(rows: list[dict[str, str]]) -> int:
    """Write ST PASA rows to the DB. Returns count inserted/updated."""
    payload: list[tuple] = []
    for r in rows:
        interval = _clean_dt(r.get("INTERVAL_DATETIME", ""))
        region   = r.get("REGIONID", "").strip().strip('"').upper()
        if not interval or not region:
            continue

        # Column aliases: AEMO has varied naming across file versions.
        # STPASA_REGIONSOLUTION uses DEMAND10/50/90 and AVAILABLEGENERATION
        # (no underscores). Older/alternate formats kept as fallbacks.
        d10   = _to_float(r.get("DEMAND10", r.get("DEMAND_10", "")))
        d50   = _to_float(r.get("DEMAND50", r.get("DEMAND_50", "")))
        d90   = _to_float(r.get("DEMAND90", r.get("DEMAND_90", "")))
        avgen = _to_float(r.get("AVAILABLEGENERATION",
                  r.get("AVAILABLE_GENERATION",
                  r.get("AGGREGATEPASAAVAILABILITY", ""))))
        # LRC: LOR1LEVEL is the LOR1 threshold (MW) in REGIONSOLUTION
        lrc   = _to_float(r.get("LRC", r.get("LOR1LEVEL", "")))
        rescond = _to_int(r.get("RESERVECONDITION", ""))
        run_dt  = _clean_dt(r.get("RUN_DATETIME", r.get("LASTCHANGED", "")))

        payload.append((interval, region, d10, d50, d90, avgen, lrc, rescond, run_dt))

    if not payload:
        return 0

    with write_conn() as con:
        con.executemany(
            """
            INSERT INTO nem_st_pasa
                (interval_datetime, regionid, demand10, demand50, demand90,
                 available_generation, lrc, reservecondition, run_datetime)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(interval_datetime, regionid) DO UPDATE SET
                demand10             = COALESCE(excluded.demand10, demand10),
                demand50             = COALESCE(excluded.demand50, demand50),
                demand90             = COALESCE(excluded.demand90, demand90),
                available_generation = COALESCE(excluded.available_generation, available_generation),
                lrc                  = COALESCE(excluded.lrc, lrc),
                reservecondition     = COALESCE(excluded.reservecondition, reservecondition),
                run_datetime         = COALESCE(excluded.run_datetime, run_datetime)
            """,
            payload,
        )
    return len(payload)


# ---- Main entry point -----------------------------------------------------

async def run_once() -> dict:
    """Fetch and ingest the latest ST PASA file. Returns a status summary."""
    headers = {"User-Agent": USER_AGENT}
    async with httpx.AsyncClient(headers=headers, follow_redirects=True) as client:
        try:
            files = await _list_remote(client)
        except Exception as e:
            set_state(SOURCE_KEY, None, error=str(e))
            return {"error": str(e), "new_files": 0}

        last = get_last_file(SOURCE_KEY)
        new_files = [f for f in files if f > (last or "")]

        if not new_files:
            return {"new_files": 0, "last_file": last}

        # Process only the single newest file (ST PASA is additive per run)
        target = new_files[-1]
        try:
            zdata = await _fetch_zip(client, target)
            csv_text = _extract_csv(zdata)
            tables = parse_mms_csv(csv_text)

            # STPASA_REGIONSOLUTION has per-region DEMAND10/50/90 + RESERVECONDITION.
            # STPASA_CASESOLUTION is a case-level summary with no REGIONID — don't use it.
            rows: list[dict[str, str]] = []
            for key, val in tables.items():
                if "STPASA" in key.upper() and "REGIONSOLUTION" in key.upper():
                    rows = val
                    break
            if not rows:
                log.warning("ST PASA: REGIONSOLUTION table not found in %s; keys=%s",
                            target, list(tables.keys()))

            n = _upsert(rows)
            set_state(SOURCE_KEY, target, error=None)
            log.info("ST PASA: ingested %s → %d rows", target, n)
            return {"new_files": 1, "rows": n, "last_file": target}

        except Exception as e:
            log.warning("ST PASA fetch failed (%s): %s", target, e)
            set_state(SOURCE_KEY, None, error=str(e))
            return {"error": str(e), "new_files": 0}
