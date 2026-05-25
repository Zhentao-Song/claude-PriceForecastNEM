"""API for bid stack + market timeline (BIDDAYOFFER → DISPATCH lifecycle).

Three endpoints:
- `GET /api/bids/timeline`  — lifecycle stages + status for one target interval
- `GET /api/bids/stack`     — merit-order bid stack (top-N DUIDs) at one interval
- `GET /api/bids/duid`      — all rebid versions for one DUID on one trading day
"""
from __future__ import annotations

from datetime import date, datetime, timedelta

from fastapi import APIRouter, HTTPException, Query

from ..config import NEM_REGIONS
from ..db import locked_conn

router = APIRouter(prefix="/api/bids", tags=["bids"])


# ---- Time helpers -------------------------------------------------------

def _nem_now() -> datetime:
    """NEM time = AEST = UTC+10, no DST. DB stores everything in NEM time."""
    return datetime.utcnow() + timedelta(hours=10)


def _trading_date_for(interval_dt: datetime) -> date:
    """NEM trading day runs 04:00 → 04:00 (NER 3.4.1). An interval ending
    at 04:00 belongs to the *previous* trading day; one ending at 04:05
    belongs to the new one. Shift back ~4 h to put the boundary at midnight."""
    return (interval_dt - timedelta(hours=4, minutes=1)).date()


def _parse_iso(s: str) -> datetime:
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        try:
            return datetime.strptime(s, "%Y-%m-%d %H:%M:%S")
        except ValueError as e:
            raise HTTPException(400, f"invalid timestamp '{s}': {e}")


def _ceil_to_dispatch(now: datetime) -> datetime:
    """Snap forward to the next 5-min dispatch boundary."""
    m = now.minute - (now.minute % 5)
    base = now.replace(minute=m, second=0, microsecond=0)
    if base <= now:
        base += timedelta(minutes=5)
    return base


# ---- Timeline endpoint --------------------------------------------------

# Constants from the NER. Settlement window per NER 3.15.5 is T+~20 business
# days for final, but the preliminary statement lands at T+7 — we use the
# preliminary as the "first money settled" marker since that's what traders
# track.
INTERVAL_MIN = 5
GATE_BUFFER_SECONDS = 30       # mirror paper.py's submission gate
SETTLEMENT_BUSINESS_DAYS = 7   # preliminary settlement statement


def _add_business_days(d: datetime, n: int) -> datetime:
    """Skip weekends — close enough for the "settlement statement" marker.
    (Australia public holidays would require a calendar; we ignore those.)"""
    out = d
    added = 0
    while added < n:
        out = out + timedelta(days=1)
        if out.weekday() < 5:  # 0..4 = Mon..Fri
            added += 1
    return out


@router.get("/timeline")
def timeline(
    interval: str | None = Query(None, description="Target dispatch interval (ISO). Defaults to next."),
    duid: str | None = Query(None, description="Optional DUID to inspect its own bid history."),
) -> dict:
    """Lifecycle stages for one dispatch interval. Each stage has a timestamp
    plus a status (`complete` | `in_progress` | `upcoming`) so the UI can
    render past/now/future with the right styling and countdowns."""
    now = _nem_now()
    target = _parse_iso(interval) if interval else _ceil_to_dispatch(now)
    target = target.replace(second=0, microsecond=0)
    trading = _trading_date_for(target)

    # ---- Key timestamps ------------------------------------------------
    bidday_deadline = datetime.combine(trading - timedelta(days=1), datetime.min.time()) \
                              + timedelta(hours=12, minutes=30)
    trading_day_start = datetime.combine(trading, datetime.min.time()) + timedelta(hours=4)
    trading_day_end = trading_day_start + timedelta(hours=24)
    # PREDISPATCH covers the rest of the trading day from when the first run
    # after bid lockdown publishes (~13:00 day before) through end of trading day.
    predispatch_start = bidday_deadline.replace(hour=13, minute=0)
    predispatch_end = trading_day_end
    # P5MIN runs every 5 min, covering 12 intervals (60 min) ahead, so the
    # earliest P5MIN that includes `target` runs at target - 60 min.
    p5min_start = target - timedelta(minutes=60)
    p5min_end = target - timedelta(minutes=INTERVAL_MIN)
    gate_close = target - timedelta(minutes=INTERVAL_MIN, seconds=GATE_BUFFER_SECONDS)
    dispatch_run = target - timedelta(minutes=INTERVAL_MIN)   # NEMDE runs at start of interval window
    settlement = _add_business_days(target, SETTLEMENT_BUSINESS_DAYS).replace(
        hour=0, minute=0, second=0, microsecond=0
    )

    # ---- Pull data we have ---------------------------------------------
    cutoff_str = predispatch_start.strftime("%Y-%m-%d %H:%M:%S")
    target_str = target.strftime("%Y-%m-%d %H:%M:%S")

    with locked_conn() as con:
        # Predispatch run count + latest run for this target
        pd_rows = con.execute(
            """
            SELECT COUNT(DISTINCT run_datetime), MAX(run_datetime)
            FROM nem_predispatch_price
            WHERE source = 'PREDISPATCH'
              AND interval_datetime = ?
            """,
            (target_str,),
        ).fetchone()
        pd_runs = int(pd_rows[0]) if pd_rows and pd_rows[0] else 0
        pd_latest_run = pd_rows[1] if pd_rows else None
        pd_latest_rrp = None
        if pd_latest_run:
            row = con.execute(
                """
                SELECT AVG(rrp) FROM nem_predispatch_price
                WHERE interval_datetime = ? AND source = 'PREDISPATCH' AND run_datetime = ?
                """,
                (target_str, pd_latest_run),
            ).fetchone()
            pd_latest_rrp = row[0] if row else None

        # P5MIN run count + latest
        p5_rows = con.execute(
            """
            SELECT COUNT(DISTINCT run_datetime), MAX(run_datetime)
            FROM nem_predispatch_price
            WHERE source = 'P5MIN' AND interval_datetime = ?
            """,
            (target_str,),
        ).fetchone()
        p5_runs = int(p5_rows[0]) if p5_rows and p5_rows[0] else 0
        p5_latest_run = p5_rows[1] if p5_rows else None
        p5_latest_rrp = None
        if p5_latest_run:
            row = con.execute(
                """
                SELECT AVG(rrp) FROM nem_predispatch_price
                WHERE interval_datetime = ? AND source = 'P5MIN' AND run_datetime = ?
                """,
                (target_str, p5_latest_run),
            ).fetchone()
            p5_latest_rrp = row[0] if row else None

        # Dispatch — did we clear yet?
        d_row = con.execute(
            "SELECT AVG(rrp), COUNT(*) FROM nem_dispatch_price WHERE settlementdate = ?",
            (target_str,),
        ).fetchone()
        cleared_rrp = d_row[0] if d_row else None
        cleared_regions = int(d_row[1]) if d_row else 0

        # Day-ahead bid count for this trading date
        td_str = trading.strftime("%Y-%m-%d 00:00:00")
        bd_row = con.execute(
            "SELECT COUNT(DISTINCT duid), COUNT(*) FROM nem_bidday_offer "
            "WHERE settlementdate = ?",
            (td_str,),
        ).fetchone()
        bd_duids = int(bd_row[0]) if bd_row else 0
        bd_total = int(bd_row[1]) if bd_row else 0

        # Rebid activity for this target interval
        rb_row = con.execute(
            """
            SELECT COUNT(*), COUNT(DISTINCT duid),
                   MAX(submitted_at)
            FROM nem_bidper_offer
            WHERE interval_datetime = ? AND version >= 2
            """,
            (target_str,),
        ).fetchone()
        rebid_count = int(rb_row[0]) if rb_row else 0
        rebid_duids = int(rb_row[1]) if rb_row else 0
        rebid_latest = rb_row[2] if rb_row else None

        # If a DUID is specified, look up its specific state
        duid_state = None
        if duid:
            row = con.execute(
                "SELECT submitted_at, priceband1, priceband10 FROM nem_bidday_offer "
                "WHERE duid = ? AND settlementdate = ? AND bidtype = 'ENERGY' LIMIT 1",
                (duid, td_str),
            ).fetchone()
            day_ahead_submitted = row[0] if row else None
            row2 = con.execute(
                """
                SELECT COUNT(*), MAX(submitted_at) FROM nem_bidper_offer
                WHERE duid = ? AND interval_datetime = ? AND bidtype = 'ENERGY'
                """,
                (duid, target_str),
            ).fetchone()
            duid_state = {
                "day_ahead_submitted": _iso(day_ahead_submitted),
                "versions_for_interval": int(row2[0]) if row2 else 0,
                "latest_version_submitted": _iso(row2[1]) if row2 else None,
            }

    # ---- Build stage list ----------------------------------------------
    def status(ts: datetime) -> str:
        if now >= ts: return "complete"
        return "upcoming"

    def span_status(ts_start: datetime, ts_end: datetime) -> str:
        if now >= ts_end: return "complete"
        if now >= ts_start: return "in_progress"
        return "upcoming"

    stages = [
        {
            "key": "bidday_deadline",
            "name": "BIDDAYOFFER lockdown",
            "ts": _iso(bidday_deadline),
            "status": status(bidday_deadline),
            "rule": "NER 3.8.6 · prices fixed for trading day",
            "detail": {
                "duids_with_day_ahead": bd_duids,
                "bid_rows": bd_total,
                "your_duid_submitted": (duid_state or {}).get("day_ahead_submitted"),
            },
        },
        {
            "key": "predispatch",
            "name": "PREDISPATCH forecasts",
            "ts_start": _iso(predispatch_start),
            "ts_end": _iso(predispatch_end),
            "frequency_minutes": 30,
            "status": span_status(predispatch_start, predispatch_end),
            "rule": "NER 3.7 · 30-min look-ahead, rolls every 30 min",
            "detail": {
                "runs_so_far": pd_runs,
                "latest_run": _iso(pd_latest_run),
                "latest_forecast_rrp": _round(pd_latest_rrp),
            },
        },
        {
            "key": "p5min",
            "name": "P5MIN forecasts",
            "ts_start": _iso(p5min_start),
            "ts_end": _iso(p5min_end),
            "frequency_minutes": 5,
            "status": span_status(p5min_start, p5min_end),
            "rule": "5-min look-ahead, 12 intervals (60 min) horizon",
            "detail": {
                "runs_so_far": p5_runs,
                "latest_run": _iso(p5_latest_run),
                "latest_forecast_rrp": _round(p5_latest_rrp),
            },
        },
        {
            "key": "gate_closure",
            "name": "Gate closure",
            "ts": _iso(gate_close),
            "status": status(gate_close),
            "rule": "NER 3.8.20 · MaxAvail frozen, no more rebids",
            "detail": {
                "rebid_count_this_interval": rebid_count,
                "rebidding_duids": rebid_duids,
                "latest_rebid": _iso(rebid_latest),
                "countdown_seconds": max(0, int((gate_close - now).total_seconds())),
            },
        },
        {
            "key": "dispatch",
            "name": "DISPATCH clearing",
            "ts": _iso(dispatch_run),
            "interval_end": _iso(target),
            "status": (
                "complete" if cleared_regions >= len(NEM_REGIONS)
                else ("in_progress" if now >= dispatch_run else "upcoming")
            ),
            "rule": "NEMDE LP solve · 5-min RRP determined",
            "detail": {
                "cleared_regions": cleared_regions,
                "expected_regions": len(NEM_REGIONS),
                "cleared_rrp_avg": _round(cleared_rrp),
            },
        },
        {
            "key": "settlement",
            "name": "Preliminary settlement",
            "ts": _iso(settlement),
            "status": status(settlement),
            "rule": "T+7 business days · prelim statement (NER 3.15.5)",
            "detail": {},
        },
    ]

    return {
        "now": _iso(now),
        "target_interval": _iso(target),
        "trading_date": trading.isoformat(),
        "interval_minutes": INTERVAL_MIN,
        "duid": duid,
        "duid_state": duid_state,
        "stages": stages,
    }


# ---- Stack endpoint -----------------------------------------------------

@router.get("/stack")
def stack(
    interval: str | None = Query(None, description="Target dispatch interval (ISO)."),
    bidtype: str = Query("ENERGY", description="ENERGY / RAISEREG / RAISE6SEC / ..."),
    direction: str = Query("GEN", description="GEN or LOAD (only meaningful for ENERGY)"),
    limit_duids: int = Query(40, ge=1, le=200),
) -> dict:
    """Merit-order bid stack: top N DUIDs ranked by their cheapest available
    band. For each, we return all 10 prices + each band's latest available MW
    (from the most recent BIDPEROFFER version we have).

    The frontend renders this as a stacked horizontal bar — sorted ascending
    by lowest band, you can read the supply curve directly."""
    bidtype = bidtype.upper()
    direction = direction.upper()
    target = _parse_iso(interval) if interval else _ceil_to_dispatch(_nem_now())
    target = target.replace(second=0, microsecond=0)
    trading = _trading_date_for(target)
    td_str = trading.strftime("%Y-%m-%d 00:00:00")
    target_str = target.strftime("%Y-%m-%d %H:%M:%S")

    with locked_conn() as con:
        # Join BIDDAYOFFER (prices) with the latest BIDPEROFFER (MW availability).
        # SQLite lacks DISTINCT ON; we use a correlated subquery for the max
        # submitted_at per (duid, bidtype, interval).
        rows = con.execute(
            f"""
            WITH latest_per AS (
                SELECT duid, bidtype, interval_datetime,
                       MAX(submitted_at) AS sa
                FROM nem_bidper_offer
                WHERE interval_datetime = ? AND bidtype = ?
                GROUP BY duid, bidtype, interval_datetime
            )
            SELECT d.duid, d.direction, d.entrytype,
                   d.priceband1, d.priceband2, d.priceband3, d.priceband4, d.priceband5,
                   d.priceband6, d.priceband7, d.priceband8, d.priceband9, d.priceband10,
                   d.daily_energy_constraint,
                   p.bandavail1, p.bandavail2, p.bandavail3, p.bandavail4, p.bandavail5,
                   p.bandavail6, p.bandavail7, p.bandavail8, p.bandavail9, p.bandavail10,
                   p.maxavail, p.fixedload, p.rampuprate, p.rampdownrate,
                   p.rebid_reason, p.submitted_at, p.version
            FROM nem_bidday_offer d
            JOIN latest_per lp ON lp.duid = d.duid AND lp.bidtype = d.bidtype
            JOIN nem_bidper_offer p
              ON p.duid = lp.duid AND p.bidtype = lp.bidtype
             AND p.interval_datetime = lp.interval_datetime
             AND p.submitted_at = lp.sa
            WHERE d.settlementdate = ? AND d.bidtype = ?
              AND ({"d.direction = ?" if bidtype == "ENERGY" else "1=1"})
            ORDER BY COALESCE(d.priceband1, 999999) ASC
            LIMIT ?
            """,
            (
                (target_str, bidtype, td_str, bidtype) + ((direction,) if bidtype == "ENERGY" else ())
                + (limit_duids,)
            ),
        ).fetchall()

    out = []
    for r in rows:
        prices = list(r[3:13])
        avails = list(r[14:24])
        bands = [
            {"i": i+1, "price": prices[i], "mw": avails[i] or 0.0}
            for i in range(10)
        ]
        out.append({
            "duid": r[0], "direction": r[1], "entrytype": r[2],
            "bands": bands,
            "daily_energy_constraint": r[13],
            "maxavail": r[24], "fixedload": r[25],
            "rampuprate": r[26], "rampdownrate": r[27],
            "rebid_reason": r[28],
            "submitted_at": _iso(r[29]),
            "version": r[30],
        })
    return {
        "interval": _iso(target),
        "trading_date": trading.isoformat(),
        "bidtype": bidtype,
        "direction": direction if bidtype == "ENERGY" else None,
        "stack": out,
        "count": len(out),
    }


# ---- DUID lineage endpoint ---------------------------------------------

@router.get("/duid")
def duid_history(
    duid: str = Query(..., description="DUID code (e.g. BAYSW1, HORNSDALEBESS1)"),
    date: str | None = Query(None, description="Trading date (YYYY-MM-DD). Defaults to today."),
    bidtype: str = Query("ENERGY"),
) -> dict:
    """All BIDPEROFFER versions for a DUID on one trading day — shows the
    rebid history per interval, with reason codes. Powers the "how this DUID
    rebid through the day" view."""
    bidtype = bidtype.upper()
    td = datetime.strptime(date, "%Y-%m-%d").date() if date else _trading_date_for(_nem_now())
    td_str = td.strftime("%Y-%m-%d 00:00:00")
    td_start = datetime.combine(td, datetime.min.time()) + timedelta(hours=4)
    td_end = td_start + timedelta(hours=24)

    with locked_conn() as con:
        day_row = con.execute(
            """
            SELECT priceband1, priceband2, priceband3, priceband4, priceband5,
                   priceband6, priceband7, priceband8, priceband9, priceband10,
                   direction, entrytype, daily_energy_constraint, submitted_at
            FROM nem_bidday_offer
            WHERE duid = ? AND settlementdate = ? AND bidtype = ?
            """,
            (duid, td_str, bidtype),
        ).fetchone()

        per_rows = con.execute(
            """
            SELECT interval_datetime, submitted_at, version, rebid_reason, rebid_explanation,
                   bandavail1, bandavail2, bandavail3, bandavail4, bandavail5,
                   bandavail6, bandavail7, bandavail8, bandavail9, bandavail10,
                   maxavail, fixedload, rampuprate, rampdownrate
            FROM nem_bidper_offer
            WHERE duid = ? AND bidtype = ?
              AND interval_datetime >= ? AND interval_datetime < ?
            ORDER BY interval_datetime, submitted_at
            """,
            (duid, bidtype, td_start.strftime("%Y-%m-%d %H:%M:%S"),
                            td_end.strftime("%Y-%m-%d %H:%M:%S")),
        ).fetchall()

    bidday = None
    if day_row:
        bidday = {
            "prices": list(day_row[0:10]),
            "direction": day_row[10],
            "entrytype": day_row[11],
            "daily_energy_constraint": day_row[12],
            "submitted_at": _iso(day_row[13]),
        }

    versions = [
        {
            "interval": _iso(r[0]),
            "submitted_at": _iso(r[1]),
            "version": r[2],
            "rebid_reason": r[3],
            "rebid_explanation": r[4],
            "bandavail": list(r[5:15]),
            "maxavail": r[15], "fixedload": r[16],
            "rampuprate": r[17], "rampdownrate": r[18],
        }
        for r in per_rows
    ]
    return {
        "duid": duid, "trading_date": td.isoformat(), "bidtype": bidtype,
        "bidday": bidday, "versions": versions, "version_count": len(versions),
    }


# ---- Helpers ------------------------------------------------------------

def _iso(v) -> str | None:
    if v is None: return None
    if isinstance(v, datetime): return v.isoformat()
    return str(v)


def _round(v, n=2):
    if v is None: return None
    return round(float(v), n)
