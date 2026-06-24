"""AEMO predispatch (forecast) price scraper.

We ingest two AEMO feeds and merge them into one table:

- **P5MIN** (`PUBLIC_P5MIN_*.zip`): 5-minute forecasts published every 5
  minutes covering roughly the next 55 minutes. Source = 'P5MIN'.
  Table: P5MIN_REGIONSOLUTION.
- **PREDISPATCHIS** (`PUBLIC_PREDISPATCHIS_*.zip`): 30-minute forecasts
  published every 30 minutes covering the rest of the current trading day
  plus the next day (~24–40 hours horizon). Source = 'PREDISPATCH'.
  Tables: PREDISPATCH_REGION_PRICES + PREDISPATCH_REGION_SOLUTION (we use
  REGION_SOLUTION which carries both RRP and FCAS RRPs alongside DATETIME).

Same upsert philosophy as `nem.py` (DispatchIS actuals): only `INTERVENTION=0`
rows; on conflict we overwrite with the freshest `run_datetime`, so the chart
always reflects AEMO's most recent forecast for each target interval.
"""
from __future__ import annotations

import io
import logging
import re
import zipfile
from datetime import datetime, timedelta
from typing import Iterable

import httpx

from ..config import (
    HTTP_TIMEOUT,
    NEM_P5MIN_DIR,
    NEM_PREDISPATCHIS_DIR,
    NEM_REGIONS,
    USER_AGENT,
)
from ..db import write_conn
from .mms import parse_mms_csv
from .nem import get_last_file, set_state

log = logging.getLogger("scraper.predispatch")

P5MIN_FILENAME_RE = re.compile(r"PUBLIC_P5MIN_(\d{12})_\d+\.zip", re.IGNORECASE)
PREDISPATCH_FILENAME_RE = re.compile(r"PUBLIC_PREDISPATCHIS_(\d{14}|\d{12})_\d+\.zip",
                                     re.IGNORECASE)


# ---- Generic helpers (mirrors nem.py) ------------------------------------

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


async def _list_dir(client: httpx.AsyncClient, url: str, regex: re.Pattern) -> list[str]:
    r = await client.get(url, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    hrefs = re.findall(r'href="([^"]+\.zip)"', r.text, flags=re.IGNORECASE)
    files = [h.rsplit("/", 1)[-1] for h in hrefs if regex.search(h)]
    return sorted(set(files))


async def _fetch_zip(client: httpx.AsyncClient, url: str) -> bytes:
    r = await client.get(url, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    return r.content


def _extract_csv(zip_bytes: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        name = next((n for n in zf.namelist() if n.lower().endswith(".csv")), None)
        if not name:
            raise RuntimeError("No CSV inside predispatch zip")
        with zf.open(name) as f:
            return f.read().decode("utf-8", errors="replace")


# ---- Upserts -------------------------------------------------------------

def _upsert(payload: list[tuple], source: str) -> int:
    if not payload:
        return 0
    with write_conn() as con:
        # Only overwrite if the incoming run_datetime is fresher than what's
        # already stored — keeps the table monotonic w.r.t. forecast vintage.
        con.executemany(
            """
            INSERT INTO nem_predispatch_price
                (interval_datetime, regionid, source, run_datetime,
                 rrp, total_demand,
                 raise6sec_rrp, raise60sec_rrp, raise5min_rrp, raisereg_rrp, raise1sec_rrp,
                 lower6sec_rrp, lower60sec_rrp, lower5min_rrp, lowerreg_rrp, lower1sec_rrp)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(interval_datetime, regionid, source) DO UPDATE SET
                run_datetime = excluded.run_datetime,
                rrp = excluded.rrp,
                total_demand = excluded.total_demand,
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
            WHERE excluded.run_datetime >= nem_predispatch_price.run_datetime
            """,
            payload,
        )
    log.info("predispatch %s upserted %d rows", source, len(payload))
    return len(payload)


def _parse_p5min_rows(rows: Iterable[dict[str, str]]) -> list[tuple]:
    """P5MIN_REGIONSOLUTION rows.

    Columns of interest: RUN_DATETIME, INTERVAL_DATETIME, REGIONID, RRP,
    plus the six FCAS *RRP columns matching DispatchIS naming.
    """
    out: list[tuple] = []
    for r in rows:
        if r.get("INTERVENTION", "0").strip().strip('"') not in ("0", ""):
            continue
        region = r.get("REGIONID", "").strip().strip('"')
        if region not in NEM_REGIONS:
            continue
        interval = _parse_dt(r.get("INTERVAL_DATETIME", ""))
        run_dt = _parse_dt(r.get("RUN_DATETIME", ""))
        if interval is None or run_dt is None:
            continue
        out.append((
            interval, region, "P5MIN", run_dt,
            _to_float(r.get("RRP", "")),
            _to_float(r.get("TOTALDEMAND", "")),
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
    return out


def _parse_predispatch_rows(
    price_rows: Iterable[dict[str, str]],
    sol_rows: Iterable[dict[str, str]] = (),
) -> list[tuple]:
    """Merge PREDISPATCH_REGION_PRICES (RRP + FCAS) with PREDISPATCH_REGION_SOLUTION
    (TOTALDEMAND), keyed by (DATETIME, REGIONID).

    AEMO splits the PREDISPATCHIS feed across two subtables: REGION_PRICES
    carries every RRP column (energy + 10 FCAS markets), REGION_SOLUTION
    carries demand and operational fields but NO price column. Reading only
    one of them — as the prior version of this code did — loses either all
    prices or all demand. We parse both and merge.

    Run vintage prefers `PREDISPATCH_RUN_DATETIME`, falling back to
    `LASTCHANGED` (older feeds only have the latter).
    """
    # Index demand by (interval, region) so we can attach it to each price row.
    demand_by_key: dict[tuple, float | None] = {}
    for r in sol_rows:
        if r.get("INTERVENTION", "0").strip().strip('"') not in ("0", ""):
            continue
        region = r.get("REGIONID", "").strip().strip('"')
        if region not in NEM_REGIONS:
            continue
        interval = _parse_dt(r.get("DATETIME", ""))
        if interval is None:
            continue
        demand_by_key[(interval, region)] = _to_float(r.get("TOTALDEMAND", ""))

    out: list[tuple] = []
    for r in price_rows:
        if r.get("INTERVENTION", "0").strip().strip('"') not in ("0", ""):
            continue
        region = r.get("REGIONID", "").strip().strip('"')
        if region not in NEM_REGIONS:
            continue
        interval = _parse_dt(r.get("DATETIME", ""))
        run_dt = (
            _parse_dt(r.get("PREDISPATCH_RUN_DATETIME", ""))
            or _parse_dt(r.get("LASTCHANGED", ""))
        )
        if interval is None or run_dt is None:
            continue
        out.append((
            interval, region, "PREDISPATCH", run_dt,
            _to_float(r.get("RRP", "")),
            demand_by_key.get((interval, region)),
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
    return out


# ---- File processors ----------------------------------------------------

async def _process_p5min(client: httpx.AsyncClient, fn: str) -> int:
    csv_text = _extract_csv(await _fetch_zip(client, NEM_P5MIN_DIR + fn))
    tables = parse_mms_csv(csv_text)
    rows = tables.get("P5MIN_REGIONSOLUTION", [])
    return _upsert(_parse_p5min_rows(rows), "P5MIN")


async def _process_predispatch(client: httpx.AsyncClient, fn: str) -> int:
    csv_text = _extract_csv(await _fetch_zip(client, NEM_PREDISPATCHIS_DIR + fn))
    tables = parse_mms_csv(csv_text)
    # REGION_PRICES has every RRP column (energy + 10 FCAS); REGION_SOLUTION
    # carries demand. We merge by (DATETIME, REGIONID) so each row has both.
    price_rows = tables.get("PREDISPATCH_REGION_PRICES", [])
    sol_rows = tables.get("PREDISPATCH_REGION_SOLUTION", [])
    return _upsert(_parse_predispatch_rows(price_rows, sol_rows), "PREDISPATCH")


# ---- Pruning ------------------------------------------------------------

def _prune_stale() -> int:
    """Drop forecast rows older than 8 days. We deliberately keep up to a
    week of *past* forecasts so the chart can render forecast-vs-actual
    comparison over the same 6h / 1d window. Anything older than that is
    dead weight — actuals are authoritative."""
    cutoff = (datetime.utcnow() + timedelta(hours=10) - timedelta(days=8)).strftime(
        "%Y-%m-%d %H:%M:%S"
    )
    with write_conn() as con:
        cur = con.execute(
            "DELETE FROM nem_predispatch_price WHERE interval_datetime < ?",
            (cutoff,),
        )
        return cur.rowcount or 0


# ---- Public entry point -------------------------------------------------

async def run_once(backfill_n: int = 3) -> dict:
    """Fetch any new predispatch files from both feeds.

    `backfill_n` is intentionally small (default 3) — predispatch files
    are large-ish and we only care about the freshest forecast horizon.
    """
    headers = {"User-Agent": USER_AGENT}
    result = {"p5min": {}, "predispatch": {}}
    async with httpx.AsyncClient(headers=headers, follow_redirects=True) as client:
        # ---- P5MIN ------------------------------------------------------
        try:
            files = await _list_dir(client, NEM_P5MIN_DIR, P5MIN_FILENAME_RE)
            last = get_last_file("nem_p5min")
            todo = [f for f in files if f > last] if last else files[-backfill_n:]
            rows = 0
            last_done = last
            for fn in todo[-backfill_n:]:  # never process more than backfill_n at once
                try:
                    rows += await _process_p5min(client, fn)
                    last_done = fn
                except Exception as e:
                    log.warning("p5min file %s failed: %s", fn, e)
                    set_state("nem_p5min", last_done, error=str(e))
                    break
            set_state("nem_p5min", last_done, error=None)
            result["p5min"] = {"new_files": len(todo), "rows": rows}
        except Exception as e:
            log.exception("p5min list failed")
            set_state("nem_p5min", None, error=str(e))
            result["p5min"] = {"error": str(e)}

        # ---- PREDISPATCHIS ---------------------------------------------
        try:
            files = await _list_dir(client, NEM_PREDISPATCHIS_DIR, PREDISPATCH_FILENAME_RE)
            last = get_last_file("nem_predispatchis")
            todo = [f for f in files if f > last] if last else files[-backfill_n:]
            rows = 0
            last_done = last
            for fn in todo[-backfill_n:]:
                try:
                    rows += await _process_predispatch(client, fn)
                    last_done = fn
                except Exception as e:
                    log.warning("predispatchis file %s failed: %s", fn, e)
                    set_state("nem_predispatchis", last_done, error=str(e))
                    break
            set_state("nem_predispatchis", last_done, error=None)
            result["predispatch"] = {"new_files": len(todo), "rows": rows}
        except Exception as e:
            log.exception("predispatchis list failed")
            set_state("nem_predispatchis", None, error=str(e))
            result["predispatch"] = {"error": str(e)}

    # Best-effort housekeeping; failure doesn't affect the ingest result.
    try:
        result["pruned"] = _prune_stale()
    except Exception:
        log.exception("predispatch prune failed")

    return result
