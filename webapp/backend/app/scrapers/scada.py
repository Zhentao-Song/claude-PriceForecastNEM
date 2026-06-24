"""NEM Dispatch_SCADA scraper.

Polls /Reports/Current/Dispatch_SCADA/, downloads new ZIPs, and stores
unit-level MW output for ALL DUIDs (~500 units per 5-min interval).

Full ingest (no curated-list filter) so the fuel mix, station explorer
and BESS leaderboard see every unit AEMO publishes — display-side code
joins against static/generators.py or nem_dudetail for metadata.
~500 rows × 288 intervals/day ≈ 145k rows/day; SQLite handles this fine
with the (settlementdate, duid) PK.
"""
from __future__ import annotations

import io
import logging
import re
import zipfile
from datetime import datetime
from typing import Iterable

import httpx

from ..config import HTTP_TIMEOUT, NEM_DISPATCHSCADA_DIR, USER_AGENT
from ..db import write_conn
from .mms import parse_mms_csv
from .nem import _parse_dt, _to_float, get_last_file, set_state

log = logging.getLogger("scraper.scada")

FILENAME_RE = re.compile(r"PUBLIC_DISPATCHSCADA_(\d{12})_\d+\.zip", re.IGNORECASE)


async def list_remote_files(client: httpx.AsyncClient) -> list[str]:
    r = await client.get(NEM_DISPATCHSCADA_DIR, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    hrefs = re.findall(r'href="([^"]+\.zip)"', r.text, flags=re.IGNORECASE)
    files = [h.rsplit("/", 1)[-1] for h in hrefs if FILENAME_RE.search(h)]
    return sorted(set(files))


async def fetch_zip(client: httpx.AsyncClient, filename: str) -> bytes:
    r = await client.get(NEM_DISPATCHSCADA_DIR + filename, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    return r.content


def extract_csv(zip_bytes: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        name = next((n for n in zf.namelist() if n.lower().endswith(".csv")), None)
        if not name:
            raise RuntimeError("No CSV in SCADA zip")
        with zf.open(name) as f:
            return f.read().decode("utf-8", errors="replace")


def upsert_unit_dispatch(rows: Iterable[dict[str, str]]) -> int:
    """Upsert (settlementdate, duid, mw) for every DUID in the file."""
    payload = []
    for r in rows:
        duid = r.get("DUID", "").strip().strip('"')
        if not duid:
            continue
        ts = _parse_dt(r.get("SETTLEMENTDATE", ""))
        if ts is None:
            continue
        mw = _to_float(r.get("SCADAVALUE", ""))
        payload.append((ts, duid, mw))
    if not payload:
        return 0
    with write_conn() as con:
        con.executemany(
            """
            INSERT INTO nem_unit_dispatch VALUES (?,?,?)
            ON CONFLICT(settlementdate, duid) DO UPDATE SET
                mw = excluded.mw
            """,
            payload,
        )
    return len(payload)


async def process_file(client: httpx.AsyncClient, filename: str) -> int:
    zip_bytes = await fetch_zip(client, filename)
    csv_text = extract_csv(zip_bytes)
    tables = parse_mms_csv(csv_text)
    return upsert_unit_dispatch(tables.get("DISPATCH_UNIT_SCADA", []))


async def run_once(backfill_n: int = 6) -> dict:
    """Pull any new SCADA files; on first run, backfill last `backfill_n`."""
    headers = {"User-Agent": USER_AGENT}
    async with httpx.AsyncClient(headers=headers, follow_redirects=True) as client:
        try:
            files = await list_remote_files(client)
        except Exception as e:
            set_state("nem_scada", None, error=f"list failed: {e}")
            log.exception("scada list failed")
            return {"error": str(e)}
        if not files:
            return {"new_files": 0}

        last = get_last_file("nem_scada")
        todo = files[-backfill_n:] if last is None else [f for f in files if f > last]

        total = 0
        last_done = last
        for fn in todo:
            try:
                n = await process_file(client, fn)
                total += n
                last_done = fn
                log.info("SCADA ingested %s: %d unit rows", fn, n)
            except Exception as e:
                log.warning("SCADA file %s failed: %s", fn, e)
                set_state("nem_scada", last_done, error=str(e))
                break
        set_state("nem_scada", last_done, error=None)
        return {"new_files": len(todo), "rows_unit": total}
