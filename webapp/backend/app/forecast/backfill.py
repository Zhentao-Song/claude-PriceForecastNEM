"""Backfill TRUE day-ahead AEMO forecasts from the NEMWEB weekly archive.

The live `nem_predispatch_price` table only keeps the *latest* run per interval
(≈ a near-nowcast for past targets), which makes AEMO look unrealistically
accurate in hindsight. To score forecasts fairly we need the genuine
*day-ahead vintage*: what AEMO predicted for interval T from a run made well
before T.

NEMWEB archives the full PREDISPATCHIS feed as weekly bundles:
    Reports/ARCHIVE/PredispatchIS_Reports/PUBLIC_PREDISPATCHIS_<from>_<to>.zip
      → 336 inner zips (7 days × 48 half-hourly runs)
          → one MMS CSV each (PREDISPATCH / REGION_PRICES, all periods/regions)

For each target T we keep the forecast from the LATEST run issued at least
`lead_hours` before T (default 16h) — a real, well-ahead forecast. Those land
in `forecast_eval` as model='aemo' (INSERT OR REPLACE, overriding the optimistic
seed). We then fill `ours`/`naive` day-ahead vintages over the same days so the
accuracy panel compares like-for-like.

Each weekly bundle is ~300 MB, so this is an on-demand job (route-triggered),
streamed to a temp file and read member-by-member to stay memory-light. ~1 week
of archive lag means the most recent ~7 days are covered by the live forward
logger instead.
"""
from __future__ import annotations

import io
import logging
import os
import re
import tempfile
import zipfile
from datetime import datetime, timedelta
from threading import Thread

import httpx

from ..config import NEMWEB_BASE, USER_AGENT
from ..db import locked_conn, write_conn
from . import data
from .models import active_models

log = logging.getLogger("forecast.backfill")

ARCHIVE_DIR = f"{NEMWEB_BASE}/Reports/ARCHIVE/PredispatchIS_Reports/"
_BUNDLE_RE = re.compile(r"PUBLIC_PREDISPATCHIS_(\d{8})_(\d{8})\.zip", re.IGNORECASE)
_RUN_RE = re.compile(r"PUBLIC_PREDISPATCHIS_(\d{12})_", re.IGNORECASE)
_LEAD_HOURS = 16

_state: dict = {
    "running": False, "done": False, "weeks_total": 0, "weeks_done": 0,
    "current": None, "rows_aemo": 0, "rows_models": 0, "error": None,
}


def get_state() -> dict:
    return dict(_state)


def _pdt(s: str) -> datetime:
    return datetime.strptime(s.strip().strip('"')[:19], "%Y/%m/%d %H:%M:%S")


def _list_bundles(client: httpx.Client) -> list[str]:
    r = client.get(ARCHIVE_DIR, timeout=60.0)
    r.raise_for_status()
    files = sorted(set(m.group(0) for m in _BUNDLE_RE.finditer(r.text)))
    return files


def _extract_day_ahead(
    path: str, region: str, lead: timedelta,
    into: dict[datetime, tuple[datetime, float]],
) -> None:
    """Merge one weekly bundle's day-ahead AEMO RRPs into `into`
    (target → (run_datetime, rrp), keeping the latest qualifying run)."""
    with zipfile.ZipFile(path) as outer:
        for nm in outer.namelist():
            if not nm.lower().endswith(".zip"):
                continue
            m = _RUN_RE.search(nm)
            if not m:
                continue
            run = datetime.strptime(m.group(1), "%Y%m%d%H%M")
            try:
                inner = zipfile.ZipFile(io.BytesIO(outer.read(nm)))
            except zipfile.BadZipFile:
                continue
            csvs = [x for x in inner.namelist() if x.lower().endswith(".csv")]
            if not csvs:
                continue
            di = ri = None
            for line in io.TextIOWrapper(inner.open(csvs[0]),
                                         encoding="utf-8", errors="replace"):
                p = line.rstrip("\n").split(",")
                if p[0] == "I" and len(p) > 3 and p[2] == "REGION_PRICES":
                    di = p.index("DATETIME"); ri = p.index("RRP")
                elif (p[0] == "D" and di is not None and p[2] == "REGION_PRICES"
                      and p[6] == region and p[8] == "0"):
                    try:
                        tgt = data.half_hour_end(_pdt(p[di]))
                        rrp = float(p[ri])
                    except (ValueError, IndexError):
                        continue
                    if run <= tgt - lead:
                        cur = into.get(tgt)
                        if cur is None or run > cur[0]:
                            into[tgt] = (run, rrp)


def _seed_models_for_days(region: str, targets: list[datetime]) -> int:
    """Fill `ours`/`naive` day-ahead vintages for the backfilled target days
    (asof = start of each target day). INSERT OR IGNORE so any live/forward
    vintage already present wins."""
    from collections import defaultdict
    by_day: dict = defaultdict(list)
    for t in targets:
        by_day[t.date()].append(t)
    rows: list[tuple] = []
    models = [m for m in active_models() if m.name in ("ours", "naive")]
    with locked_conn() as con:
        for day, ts in by_day.items():
            asof = datetime(day.year, day.month, day.day)
            for m in models:
                try:
                    preds = m.predict(con, region, ts, asof=asof)
                except Exception:
                    log.exception("backfill seed %s failed", m.name)
                    continue
                for t, v in preds.items():
                    rows.append((data.fmt(t), region, m.name, v, data.fmt(asof)))
    if not rows:
        return 0
    with write_conn() as con:
        con.executemany(
            """INSERT OR IGNORE INTO forecast_eval
               (target_datetime, regionid, model, predicted_rrp, made_at)
               VALUES (?,?,?,?,?)""",
            rows,
        )
    return len(rows)


def run_backfill(weeks: int = 4, region: str = "NSW1",
                 lead_hours: int = _LEAD_HOURS) -> None:
    """Download the `weeks` most recent weekly bundles and write true day-ahead
    AEMO vintages (+ matching ours/naive) into forecast_eval."""
    global _state
    _state.update(running=True, done=False, error=None, weeks_done=0,
                  rows_aemo=0, rows_models=0, current=None)
    lead = timedelta(hours=lead_hours)
    aemo_best: dict[datetime, tuple[datetime, float]] = {}
    try:
        headers = {"User-Agent": USER_AGENT}
        with httpx.Client(headers=headers, follow_redirects=True) as client:
            bundles = _list_bundles(client)[-weeks:]
            _state["weeks_total"] = len(bundles)
            for fn in bundles:
                _state["current"] = fn
                url = ARCHIVE_DIR + fn
                log.info("forecast backfill: downloading %s", fn)
                tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
                try:
                    with client.stream("GET", url, timeout=600.0) as resp:
                        resp.raise_for_status()
                        for chunk in resp.iter_bytes(1 << 20):
                            tmp.write(chunk)
                    tmp.close()
                    _extract_day_ahead(tmp.name, region, lead, aemo_best)
                finally:
                    try:
                        os.unlink(tmp.name)
                    except OSError:
                        pass
                _state["weeks_done"] += 1

        # Write AEMO day-ahead vintages (override the optimistic seed).
        aemo_rows = [
            (data.fmt(t), region, "aemo", round(rrp, 2), data.fmt(run))
            for t, (run, rrp) in aemo_best.items()
        ]
        if aemo_rows:
            with write_conn() as con:
                con.executemany(
                    """INSERT OR REPLACE INTO forecast_eval
                       (target_datetime, regionid, model, predicted_rrp, made_at)
                       VALUES (?,?,?,?,?)""",
                    aemo_rows,
                )
        _state["rows_aemo"] = len(aemo_rows)
        _state["rows_models"] = _seed_models_for_days(region, list(aemo_best))
        _state.update(running=False, done=True, current=None)
        log.info("forecast backfill done: %d aemo + %d model rows",
                 _state["rows_aemo"], _state["rows_models"])
    except Exception as exc:
        log.exception("forecast backfill failed")
        _state.update(running=False, done=False, error=str(exc))


def start_backfill(weeks: int = 4, region: str = "NSW1") -> bool:
    if _state["running"]:
        return False
    Thread(target=run_backfill, args=(weeks, region), daemon=True).start()
    return True
