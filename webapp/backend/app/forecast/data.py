"""Shared time + aggregation helpers for the forecast subsystem.

Everything here works on the **30-minute trading grid in NEM time** (UTC+10,
no DST). That matches AEMO's PREDISPATCH resolution, so all models, the AEMO
benchmark, and the actuals line up on the same x-axis.

Timestamps in the DB are interval *end* times. A 5-minute dispatch interval
ending at 14:05 belongs to the half-hour ending 14:30 (it aggregates the six
5-min intervals 14:05…14:30). `half_hour_end()` implements that rounding.
"""
from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta

# NEM administrative price bounds (FY2025-26): floor -$1,000, MPC $17,500.
# We clip a touch above MPC so a model is never *penalised* for a legitimate
# cap-hitting forecast.
NEM_FLOOR = -1000.0
NEM_CAP = 17_500.0

# NEM time is UTC+10 year-round (no daylight saving in the market clock).
_NEM_OFFSET = timedelta(hours=10)


def nem_now() -> datetime:
    """Current wall-clock time on the NEM market clock (UTC+10), naive."""
    return (datetime.utcnow() + _NEM_OFFSET).replace(microsecond=0)


def fmt(dt: datetime) -> str:
    """DB string form ('YYYY-MM-DD HH:MM:SS')."""
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def _as_dt(v) -> datetime:
    """sqlite returns TIMESTAMP columns as datetime (PARSE_DECLTYPES) but be
    defensive about plain strings too."""
    if isinstance(v, datetime):
        return v.replace(microsecond=0)
    s = str(v).strip()
    for f in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y/%m/%d %H:%M:%S"):
        try:
            return datetime.strptime(s[:19], f)
        except ValueError:
            continue
    raise ValueError(f"unparseable datetime: {v!r}")


def half_hour_end(s: datetime) -> datetime:
    """Round an interval-end timestamp UP to the half-hour it settles into.
    14:05→14:30, 14:30→14:30, 14:35→15:00, 14:00→14:00."""
    s = s.replace(second=0, microsecond=0)
    rem = s.minute % 30
    if rem == 0:
        return s
    return s + timedelta(minutes=30 - rem)


def floor_half_hour(s: datetime) -> datetime:
    """Round DOWN to the current half-hour boundary (:00 / :30)."""
    return s.replace(minute=(s.minute // 30) * 30, second=0, microsecond=0)


def clip(v: float) -> float:
    return max(NEM_FLOOR, min(NEM_CAP, v))


def half_hour_targets(start: datetime, n: int) -> list[datetime]:
    """`n` consecutive half-hour end-times starting just after `start`."""
    base = floor_half_hour(start)
    return [base + timedelta(minutes=30 * (i + 1)) for i in range(n)]


# ── Actuals (dispatch) on the 30-min grid ────────────────────────────────────

def fetch_actuals_hh(
    con: sqlite3.Connection,
    region: str,
    start: datetime,
    end: datetime,
) -> dict[datetime, float]:
    """Mean dispatch RRP per half-hour end-time, for half-hours settling in
    (start, end]. Aggregated in Python (cheap: ≤ a few weeks of 5-min rows)."""
    rows = con.execute(
        """
        SELECT settlementdate, rrp FROM nem_dispatch_price
        WHERE regionid = ? AND settlementdate > ? AND settlementdate <= ?
          AND rrp IS NOT NULL
        ORDER BY settlementdate
        """,
        (region, fmt(start - timedelta(minutes=30)), fmt(end)),
    ).fetchall()
    buckets: dict[datetime, list[float]] = {}
    for sd, rrp in rows:
        e = half_hour_end(_as_dt(sd))
        if start < e <= end:
            buckets.setdefault(e, []).append(float(rrp))
    return {e: sum(v) / len(v) for e, v in buckets.items()}


def fetch_aemo_hh(
    con: sqlite3.Connection,
    region: str,
    targets: list[datetime],
) -> dict[datetime, float]:
    """AEMO PREDISPATCH (day-ahead) RRP for the given half-hour targets, taking
    the freshest run stored for each interval. PREDISPATCH is already on the
    30-min grid (interval_datetime = period end)."""
    if not targets:
        return {}
    lo, hi = fmt(min(targets)), fmt(max(targets))
    rows = con.execute(
        """
        SELECT interval_datetime, rrp, run_datetime
        FROM nem_predispatch_price
        WHERE regionid = ? AND source = 'PREDISPATCH'
          AND interval_datetime BETWEEN ? AND ?
          AND rrp IS NOT NULL
        """,
        (region, lo, hi),
    ).fetchall()
    best: dict[datetime, tuple[datetime, float]] = {}
    for iv, rrp, run in rows:
        e = half_hour_end(_as_dt(iv))
        r = _as_dt(run)
        cur = best.get(e)
        if cur is None or r > cur[0]:
            best[e] = (r, float(rrp))
    want = set(targets)
    return {e: v[1] for e, v in best.items() if e in want}


def fetch_pred_demand_hh(
    con: sqlite3.Connection,
    region: str,
    targets: list[datetime],
) -> dict[datetime, float]:
    """AEMO PREDISPATCH forecast TOTALDEMAND (MW) per target half-hour, freshest
    run. A forward-looking demand feature aligned to each target interval."""
    if not targets:
        return {}
    lo, hi = fmt(min(targets)), fmt(max(targets))
    rows = con.execute(
        """
        SELECT interval_datetime, total_demand, run_datetime
        FROM nem_predispatch_price
        WHERE regionid = ? AND source = 'PREDISPATCH'
          AND interval_datetime BETWEEN ? AND ?
          AND total_demand IS NOT NULL
        """,
        (region, lo, hi),
    ).fetchall()
    best: dict[datetime, tuple[datetime, float]] = {}
    for iv, dem, run in rows:
        e = half_hour_end(_as_dt(iv))
        r = _as_dt(run)
        cur = best.get(e)
        if cur is None or r > cur[0]:
            best[e] = (r, float(dem))
    want = set(targets)
    return {e: v[1] for e, v in best.items() if e in want}


def fetch_eval_aemo_hh(
    con: sqlite3.Connection,
    region: str,
    targets: list[datetime],
) -> dict[datetime, float]:
    """AEMO day-ahead vintages recorded in forecast_eval (live forward log or
    archive backfill). Used as the anchor for historical targets where the live
    predispatch table no longer holds the forecast — not look-ahead, since the
    vintage was made before the target."""
    if not targets:
        return {}
    lo, hi = fmt(min(targets)), fmt(max(targets))
    rows = con.execute(
        """SELECT target_datetime, predicted_rrp FROM forecast_eval
           WHERE regionid=? AND model='aemo'
             AND target_datetime BETWEEN ? AND ? AND predicted_rrp IS NOT NULL""",
        (region, lo, hi),
    ).fetchall()
    return {half_hour_end(_as_dt(t)): float(v) for t, v in rows}


def recent_demand_median(
    con: sqlite3.Connection,
    region: str,
    asof: datetime,
    days: int = 14,
) -> float | None:
    """Median forecast demand over the recent window — the 'normal' load level
    a target's forecast demand is compared against."""
    start = asof - timedelta(days=days)
    rows = con.execute(
        """
        SELECT total_demand FROM nem_predispatch_price
        WHERE regionid = ? AND source = 'PREDISPATCH'
          AND interval_datetime >= ? AND interval_datetime <= ?
          AND total_demand IS NOT NULL
        """,
        (region, fmt(start), fmt(asof)),
    ).fetchall()
    vals = sorted(float(r[0]) for r in rows)
    if not vals:
        return None
    return vals[len(vals) // 2]
