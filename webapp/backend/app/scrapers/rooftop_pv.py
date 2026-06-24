"""AEMO Rooftop PV (satellite-derived actual) scraper.

Polls /Reports/CURRENT/ROOFTOP_PV/ACTUAL/, downloads new ZIP files, parses
the MMS CSV, and upserts per-region rooftop PV output into nem_rooftop_pv.

Each file covers one 30-min interval and has one row per NEM region:
    INTERVAL_DATETIME  REGIONID  POWER (MW)

POWER can be several thousand MW at midday — this is the behind-the-meter
residential + commercial rooftop solar that AEMO derives from satellite
imagery and smart-meter reads. It does NOT appear in Dispatch_SCADA because
rooftop PV is non-scheduled (no DUID); instead AEMO publishes it separately
so operators can close the demand/generation balance gap.
"""
from __future__ import annotations

import io
import logging
import re
import zipfile
from datetime import datetime
from typing import Iterable

import httpx

from ..config import HTTP_TIMEOUT, NEM_ROOFTOP_PV_DIR, USER_AGENT
from ..db import write_conn
from .mms import parse_mms_csv
from .nem import _parse_dt, _to_float, get_last_file, set_state

log = logging.getLogger("scraper.rooftop_pv")

# e.g. PUBLIC_ROOFTOP_PV_ACTUAL_SATELLITE_20260531120000_0000000520195575.zip
# The datetime stamp is 14 digits: YYYYMMDDHHMMSS.
FILENAME_RE = re.compile(
    r"PUBLIC_ROOFTOP_PV_ACTUAL(?:_SATELLITE)?_(\d{14})_\d+\.zip",
    re.IGNORECASE,
)


async def list_remote_files(client: httpx.AsyncClient) -> list[str]:
    r = await client.get(NEM_ROOFTOP_PV_DIR, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    hrefs = re.findall(r'href="([^"]+\.zip)"', r.text, flags=re.IGNORECASE)
    files = [h.rsplit("/", 1)[-1] for h in hrefs if FILENAME_RE.search(h)]
    return sorted(set(files))


async def fetch_zip(client: httpx.AsyncClient, filename: str) -> bytes:
    r = await client.get(NEM_ROOFTOP_PV_DIR + filename, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    return r.content


def extract_csv(zip_bytes: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        name = next((n for n in zf.namelist() if n.lower().endswith(".csv")), None)
        if not name:
            raise RuntimeError("No CSV in Rooftop PV zip")
        with zf.open(name) as f:
            return f.read().decode("utf-8", errors="replace")


def upsert_rooftop(rows: Iterable[dict[str, str]]) -> int:
    """Parse ROOFTOP_ACTUAL rows and upsert into nem_rooftop_pv."""
    NEM_REGIONS = {"NSW1", "QLD1", "VIC1", "SA1", "TAS1"}
    payload = []
    for r in rows:
        regionid = r.get("REGIONID", "").strip().strip('"')
        if regionid not in NEM_REGIONS:
            continue
        ts = _parse_dt(r.get("INTERVAL_DATETIME", ""))
        if ts is None:
            continue
        power = _to_float(r.get("POWER", ""))
        if power is None or power < 0:
            continue
        # Store as NEM-time string matching existing table conventions.
        ts_str = ts.strftime("%Y-%m-%d %H:%M:%S")
        payload.append((ts_str, regionid, power))

    if not payload:
        return 0

    with write_conn() as con:
        con.executemany(
            """
            INSERT INTO nem_rooftop_pv (settlementdate, regionid, power_mw)
            VALUES (?, ?, ?)
            ON CONFLICT(settlementdate, regionid) DO UPDATE SET
                power_mw = excluded.power_mw
            """,
            payload,
        )
    return len(payload)


async def process_file(client: httpx.AsyncClient, filename: str) -> int:
    zip_bytes = await fetch_zip(client, filename)
    csv_text = extract_csv(zip_bytes)
    tables = parse_mms_csv(csv_text)
    return upsert_rooftop(tables.get("ROOFTOP_ACTUAL", []))


# Weekly ARCHIVE bundles: PUBLIC_ROOFTOP_PV_ACTUAL_SATELLITE_YYYYMMDD.zip,
# each containing ~336 inner per-interval zips (7 days × 48 half-hours).
ARCHIVE_DIR = NEM_ROOFTOP_PV_DIR.replace("/Reports/CURRENT/", "/Reports/ARCHIVE/")
ARCHIVE_RE = re.compile(
    r"PUBLIC_ROOFTOP_PV_ACTUAL(?:_SATELLITE)?_(\d{8})\.zip", re.IGNORECASE)


async def backfill_archive(weeks: int = 5) -> dict:
    """One-shot deep backfill from the weekly ARCHIVE bundles (~30 days).

    Each archive zip nests one zip per 30-min interval; we open both layers
    in memory and upsert every region row. Called from the scheduler only
    when nem_rooftop_pv looks shallow (fresh deploy / wiped volume).
    """
    headers = {"User-Agent": USER_AGENT}
    async with httpx.AsyncClient(headers=headers, follow_redirects=True) as client:
        r = await client.get(ARCHIVE_DIR, timeout=HTTP_TIMEOUT)
        r.raise_for_status()
        hrefs = re.findall(r'href="([^"]+\.zip)"', r.text, flags=re.IGNORECASE)
        files = sorted({h.rsplit("/", 1)[-1] for h in hrefs if ARCHIVE_RE.search(h)})
        if not files:
            return {"archives": 0, "rows": 0}

        total = 0
        done = 0
        for fn in files[-weeks:]:
            try:
                resp = await client.get(ARCHIVE_DIR + fn, timeout=120.0)
                resp.raise_for_status()
                with zipfile.ZipFile(io.BytesIO(resp.content)) as outer:
                    for inner_name in outer.namelist():
                        if not inner_name.lower().endswith(".zip"):
                            continue
                        try:
                            with zipfile.ZipFile(io.BytesIO(outer.read(inner_name))) as zf:
                                csv_name = next(
                                    (n for n in zf.namelist()
                                     if n.lower().endswith(".csv")), None)
                                if not csv_name:
                                    continue
                                csv_text = zf.read(csv_name).decode(
                                    "utf-8", errors="replace")
                            tables = parse_mms_csv(csv_text)
                            total += upsert_rooftop(tables.get("ROOFTOP_ACTUAL", []))
                        except Exception:
                            continue  # one bad inner file shouldn't kill the week
                done += 1
                log.info("rooftop_pv archive %s done (cum rows %d)", fn, total)
            except Exception as e:
                log.warning("rooftop_pv archive %s failed: %s", fn, e)
        return {"archives": done, "rows": total}


async def run_once(backfill_n: int = 12) -> dict:
    """Pull any new Rooftop PV files; backfill last `backfill_n` on first run.

    12 files × 30 min = 6 h of initial rooftop data — enough to fill the
    FuelMixLive 6-hour chart on first launch without a heavy download.
    """
    headers = {"User-Agent": USER_AGENT}
    async with httpx.AsyncClient(headers=headers, follow_redirects=True) as client:
        try:
            files = await list_remote_files(client)
        except Exception as e:
            set_state("nem_rooftop_pv", None, error=f"list failed: {e}")
            log.exception("rooftop_pv list failed")
            return {"error": str(e)}
        if not files:
            return {"new_files": 0}

        last = get_last_file("nem_rooftop_pv")
        todo = files[-backfill_n:] if last is None else [f for f in files if f > last]

        total = 0
        last_done = last
        for fn in todo:
            try:
                n = await process_file(client, fn)
                total += n
                last_done = fn
                log.info("rooftop_pv ingested %s: %d rows", fn, n)
            except Exception as e:
                log.warning("rooftop_pv file %s failed: %s", fn, e)
                set_state("nem_rooftop_pv", last_done, error=str(e))
                break

        set_state("nem_rooftop_pv", last_done, error=None)
        return {"new_files": len(todo), "rows": total}
