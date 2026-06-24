"""One-shot backfill of NEM dispatch history from NEMWEB Archive.

The live scraper (`scrapers/nem.py`) only sees ~1-2 days of files because
`Reports/Current/DispatchIS_Reports/` rolls fast. For the 90-day heatmap to
mean anything we have to walk `Reports/Archive/DispatchIS_Reports/` once at
install time (or when the user requests it) and ingest every interval.

Archive layout (verified May 2026):
    PUBLIC_DISPATCHIS_YYYYMMDD.zip       (outer: one per calendar day)
        PUBLIC_DISPATCHIS_YYYYMMDDHHMM_NNNNNNN.zip   (inner: 288 per day)
            PUBLIC_DISPATCHIS_*.CSV       (MMS-format CSV)

We process serially per day, batching all 288 intervals into one upsert
so writes are cheap. Skipping a day that's already fully populated keeps
re-runs idempotent.
"""
from __future__ import annotations

import asyncio
import io
import logging
import re
import zipfile
from datetime import date, datetime, timedelta
from threading import Thread
from typing import Callable

import httpx

from ..config import HTTP_TIMEOUT, NEMWEB_BASE, USER_AGENT
from ..db import write_conn
from .mms import parse_mms_csv
from .nem import (
    set_state, upsert_dispatch_constraint, upsert_interconnector_flow,
    upsert_prices, upsert_region_summary,
)

log = logging.getLogger("scraper.backfill")

ARCHIVE_DIR = f"{NEMWEB_BASE}/Reports/Archive/DispatchIS_Reports/"
DAILY_RE = re.compile(r"PUBLIC_DISPATCHIS_(\d{8})\.zip", re.IGNORECASE)


def _nem_today() -> date:
    """Today in NEM time (UTC+10, no DST)."""
    return (datetime.utcnow() + timedelta(hours=10)).date()


def _intervals_for_day(d: date) -> tuple[str, str]:
    """Inclusive-exclusive bounds for one NEM day, formatted for sqlite."""
    start = d.strftime("%Y-%m-%d 00:00:00")
    end = (d + timedelta(days=1)).strftime("%Y-%m-%d 00:00:00")
    return start, end


def _row_count_for_day(d: date) -> int:
    start, end = _intervals_for_day(d)
    with write_conn() as con:
        row = con.execute(
            "SELECT COUNT(*) FROM nem_dispatch_price "
            "WHERE settlementdate >= ? AND settlementdate < ?",
            (start, end),
        ).fetchone()
    return int(row[0]) if row else 0


# A full day = 288 intervals × 5 NEM regions = 1440 rows. We treat ≥1400
# as "good enough" so a day with 1-2 missing dispatches doesn't trigger a
# re-download.
FULL_DAY_THRESHOLD = 1400


async def _fetch(client: httpx.AsyncClient, url: str) -> bytes:
    r = await client.get(url, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    return r.content


def _process_outer_zip(zip_bytes: bytes) -> tuple[int, int, int, int]:
    """Walk every nested 5-min zip inside the day archive, upsert all rows.

    Returns (n_price, n_region, n_interconnector, n_constraint). One outer
    zip → one transaction batch per inner zip via the existing upsert
    helpers (which already executemany), so writes stay efficient without
    rewriting them.
    """
    n_price = n_sum = n_ic = n_con = 0
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as outer:
        for inner_name in outer.namelist():
            if not inner_name.lower().endswith(".zip"):
                continue
            with outer.open(inner_name) as inner_fh:
                inner_bytes = inner_fh.read()
            try:
                with zipfile.ZipFile(io.BytesIO(inner_bytes)) as inner:
                    csv_name = next(
                        (n for n in inner.namelist() if n.lower().endswith(".csv")),
                        None,
                    )
                    if not csv_name:
                        continue
                    with inner.open(csv_name) as f:
                        csv_text = f.read().decode("utf-8", errors="replace")
            except zipfile.BadZipFile:
                log.warning("backfill: bad inner zip %s", inner_name)
                continue
            tables = parse_mms_csv(csv_text)
            n_price += upsert_prices(tables.get("DISPATCH_PRICE", []))
            n_sum += upsert_region_summary(tables.get("DISPATCH_REGIONSUM", []))
            n_ic += upsert_interconnector_flow(tables.get("DISPATCH_INTERCONNECTORRES", []))
            n_con += upsert_dispatch_constraint(tables.get("DISPATCH_CONSTRAINT", []))
    return n_price, n_sum, n_ic, n_con


async def backfill_days(days: int = 90, force: bool = False) -> dict:
    """Backfill the last `days` days of DispatchIS data into the local DB.

    Skips days that already have a full set of intervals unless `force=True`.
    Returns a per-day summary so a caller can show progress / errors.
    """
    end_day = _nem_today()
    # Archive lags ~1 day, so skip today and yesterday — the live scraper
    # has those covered from `Reports/Current/` anyway.
    end_day = end_day - timedelta(days=2)
    start_day = end_day - timedelta(days=days - 1)

    summary: dict[str, dict] = {}
    skipped = downloaded = 0
    total_price = total_sum = total_ic = total_con = 0
    headers = {"User-Agent": USER_AGENT}

    async with httpx.AsyncClient(headers=headers, follow_redirects=True) as client:
        for i in range(days):
            d = start_day + timedelta(days=i)
            if not force and _row_count_for_day(d) >= FULL_DAY_THRESHOLD:
                summary[d.isoformat()] = {"status": "skipped (already full)"}
                skipped += 1
                continue

            fname = f"PUBLIC_DISPATCHIS_{d.strftime('%Y%m%d')}.zip"
            url = ARCHIVE_DIR + fname
            try:
                zip_bytes = await _fetch(client, url)
            except httpx.HTTPStatusError as e:
                summary[d.isoformat()] = {"status": f"http {e.response.status_code}"}
                continue
            except Exception as e:
                summary[d.isoformat()] = {"status": f"fetch error: {e}"}
                continue

            try:
                np, ns, nic, ncon = await asyncio.to_thread(_process_outer_zip, zip_bytes)
            except Exception as e:
                log.exception("backfill: processing %s failed", fname)
                summary[d.isoformat()] = {"status": f"parse error: {e}"}
                continue

            total_price += np
            total_sum += ns
            total_ic += nic
            total_con += ncon
            downloaded += 1
            summary[d.isoformat()] = {
                "status": "ok", "rows_price": np, "rows_region": ns,
                "rows_ic": nic, "rows_constraint": ncon,
            }
            log.info(
                "backfill %s: %d price + %d region + %d ic + %d constraint rows",
                d.isoformat(), np, ns, nic, ncon,
            )

    set_state("nem_backfill",
              f"backfilled {downloaded}/{days} days (last={end_day})",
              error=None)
    return {
        "start": start_day.isoformat(),
        "end": end_day.isoformat(),
        "days": days,
        "downloaded": downloaded,
        "skipped": skipped,
        "rows_price": total_price,
        "rows_region": total_sum,
        "rows_ic": total_ic,
        "rows_constraint": total_con,
        "per_day": summary,
    }


# ===========================================================================
# MMSDM monthly backfill — much faster than daily archive for 365d backfill.
#
# AEMO publishes a flat CSV (no nested zips) per month at:
#   https://nemweb.com.au/Data_Archive/Wholesale_Electricity/MMSDM/
#     {YYYY}/MMSDM_{YYYY}_{MM}/MMSDM_Historical_Data_SQLLoader/DATA/
#     PUBLIC_ARCHIVE%23DISPATCHPRICE%23FILE01%23{YYYYMM}010000.zip
#
# Each file is ~2 MB compressed, covering all 5 NEM regions for the month.
# 10-11 downloads fills a full year — vs 265 daily-archive downloads.
# ===========================================================================

MMSDM_BASE_URL = "https://nemweb.com.au/Data_Archive/Wholesale_Electricity/MMSDM"


def _mmsdm_price_url(year: int, month: int) -> str:
    """Build the MMSDM monthly DISPATCHPRICE archive URL.

    The file name contains literal '#' characters. The server expects them
    URL-encoded as %23 in the path, but httpx normalises %23 → fragment
    separator and truncates the URL. Passing %2523 (double-encoded) causes
    httpx to send %2523 on the wire, which the NEMWEB server then decodes
    once to %23, which it further decodes to '#' when resolving the filename.
    Verified empirically: %2523 → HTTP 200, %23 → HTTP 400.
    """
    ym = f"{year}{month:02d}"
    # %2523 = double-encoded '#': httpx sends %2523, server sees %23 → '#'
    fname = f"PUBLIC_ARCHIVE%2523DISPATCHPRICE%2523FILE01%2523{ym}010000.zip"
    return (
        f"{MMSDM_BASE_URL}/{year}/MMSDM_{year}_{month:02d}/"
        f"MMSDM_Historical_Data_SQLLoader/DATA/{fname}"
    )


def _months_missing(lookback_days: int = 400) -> list[tuple[int, int]]:
    """Return (year, month) pairs not yet covered in the DB."""
    cutoff = (datetime.utcnow() + timedelta(hours=10)).date() - timedelta(days=lookback_days)

    with write_conn() as con:
        rows = con.execute(
            """
            SELECT substr(settlementdate,1,7) as ym,
                   COUNT(DISTINCT substr(settlementdate,1,10)) as n
            FROM nem_dispatch_price WHERE regionid = 'NSW1' GROUP BY ym
            """
        ).fetchall()
    present: dict[str, int] = {r[0]: r[1] for r in rows}

    result: list[tuple[int, int]] = []
    m = date(cutoff.year, cutoff.month, 1)
    today = (datetime.utcnow() + timedelta(hours=10)).date()
    # stop at the month BEFORE current (MMSDM only publishes completed months)
    if today.month == 1:
        stop = date(today.year - 1, 12, 1)
    else:
        stop = date(today.year, today.month - 1, 1)

    while m <= stop:
        key = m.strftime("%Y-%m")
        days_in_month = (
            date(m.year + (m.month // 12), (m.month % 12) + 1, 1) - timedelta(days=1)
        ).day if m.month < 12 else 31
        if present.get(key, 0) < days_in_month * 0.9:
            result.append((m.year, m.month))
        # advance month
        if m.month == 12:
            m = date(m.year + 1, 1, 1)
        else:
            m = date(m.year, m.month + 1, 1)
    return result


# --- shared progress state ---------------------------------------------------

_mmsdm_state: dict = {
    "running": False,
    "done": False,
    "months_total": 0,
    "months_done": 0,
    "current_month": None,
    "progress": [],   # list of {month, status, rows, detail?}
    "error": None,
}


def get_mmsdm_state() -> dict:
    return dict(_mmsdm_state)


def _run_mmsdm_backfill(lookback_days: int) -> None:
    global _mmsdm_state
    _mmsdm_state.update(running=True, done=False, progress=[], error=None, months_done=0)

    months = _months_missing(lookback_days)
    _mmsdm_state["months_total"] = len(months)

    if not months:
        _mmsdm_state.update(running=False, done=True)
        log.info("MMSDM backfill: nothing to do")
        return

    for year, month in months:
        key = f"{year}-{month:02d}"
        _mmsdm_state["current_month"] = key
        url = _mmsdm_price_url(year, month)
        log.info("MMSDM backfill: downloading %s", url)
        try:
            with httpx.Client(timeout=300.0,
                              headers={"User-Agent": USER_AGENT},
                              follow_redirects=True) as client:
                resp = client.get(url)
                resp.raise_for_status()

            with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
                csv_name = next(
                    (n for n in zf.namelist() if n.lower().endswith(".csv")), None
                )
                if not csv_name:
                    raise RuntimeError("No CSV in zip")
                csv_text = zf.read(csv_name).decode("utf-8", errors="replace")

            tables = parse_mms_csv(csv_text)
            price_rows = tables.get("DISPATCH_PRICE", [])
            if not price_rows:
                raise RuntimeError(f"No DISPATCH_PRICE rows (tables: {list(tables.keys())})")

            n = upsert_prices(price_rows)
            log.info("MMSDM backfill: %s → %d rows", key, n)
            _mmsdm_state["progress"].append({"month": key, "status": "ok", "rows": n})

        except Exception as exc:
            log.warning("MMSDM backfill: %s failed — %s", key, exc)
            _mmsdm_state["progress"].append({
                "month": key, "status": "error", "rows": 0, "detail": str(exc)
            })

        _mmsdm_state["months_done"] += 1

    _mmsdm_state.update(running=False, done=True, current_month=None)
    set_state("mmsdm_backfill",
              f"filled {len(months)} months (last={months[-1][0]}-{months[-1][1]:02d})",
              error=None)


def start_mmsdm_backfill(lookback_days: int = 400) -> bool:
    """Start background MMSDM price backfill. Returns False if already running."""
    if _mmsdm_state["running"]:
        return False
    Thread(target=_run_mmsdm_backfill, args=(lookback_days,), daemon=True).start()
    return True
