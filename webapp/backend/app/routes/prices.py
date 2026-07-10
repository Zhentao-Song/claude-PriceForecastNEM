from __future__ import annotations

from datetime import datetime, timedelta

from fastapi import APIRouter, Query

from .. import scheduler
from ..cache import ttl_cache
from ..config import APC_PRICE_AUD, CPT_INTERVALS, CPT_THRESHOLD_AUD, NEM_REGIONS
from ..db import locked_conn
from ..fcas_forecast import MAX_FCAS_FORECAST_HOURS, MARKET_KEYS, build_fcas_forecast
from ..scrapers import backfill

router = APIRouter(prefix="/api", tags=["prices"])


@router.get("/health")
def health() -> dict:
    """Scraper status + per-table data ages. `stale: true` on a feed means
    its newest row is older than 3× the expected publish cadence — the
    quickest tell that NEMWeb changed format or the scraper is wedged."""
    nem_now = _nem_now()
    ages = {}
    checks = [
        # table, ts column, expected cadence (min)
        ("nem_dispatch_price", "settlementdate", 5),
        ("nem_unit_dispatch", "settlementdate", 5),
        ("nem_interconnector_flow", "settlementdate", 5),
        ("nem_rooftop_pv", "settlementdate", 30),
        ("nem_predispatch_price", "interval_datetime", None),  # future-dated
        ("nem_st_pasa", "interval_datetime", None),            # future-dated
        ("nem_market_notice", "creation_date", None),          # event-driven
        # WEM stores naive AWST (UTC+8, 2 h behind NEM) and publishes the
        # reference price progressively through the day — judge it on a
        # daily cadence, not 30-min, to avoid false staleness alarms.
        ("wem_price", "interval_start", 480),
    ]
    try:
        with locked_conn() as con:
            for tbl, col, cadence in checks:
                row = con.execute(f"SELECT MAX({col}) FROM {tbl}").fetchone()
                latest = row[0] if row else None
                if latest is None:
                    ages[tbl] = {"latest": None, "age_min": None, "stale": True}
                    continue
                latest_s = str(latest)[:19].replace("T", " ")
                try:
                    dt = datetime.strptime(latest_s, "%Y-%m-%d %H:%M:%S")
                    age_min = round((nem_now - dt).total_seconds() / 60, 1)
                except ValueError:
                    age_min = None
                stale = (cadence is not None and age_min is not None
                         and age_min > cadence * 3 + 10)
                ages[tbl] = {"latest": latest_s, "age_min": age_min, "stale": stale}
    except Exception as e:
        ages["error"] = str(e)

    any_stale = any(isinstance(v, dict) and v.get("stale") for v in ages.values())
    return {
        "status": "degraded" if any_stale else "ok",
        "scrapers": scheduler.status(),
        "data_age": ages,
    }


def _latest_per_region_sql(extra_join: str = "") -> str:
    """Latest dispatch interval per region. SQLite has no QUALIFY, so we
    self-join on the max settlementdate."""
    return f"""
        SELECT p.regionid, p.settlementdate, p.rrp,
               p.raise6sec_rrp, p.raise60sec_rrp, p.raise5min_rrp,
               p.raisereg_rrp, p.raise1sec_rrp,
               p.lower6sec_rrp, p.lower60sec_rrp, p.lower5min_rrp,
               p.lowerreg_rrp, p.lower1sec_rrp
               {extra_join}
        FROM nem_dispatch_price p
        JOIN (
            SELECT regionid, MAX(settlementdate) AS mx
            FROM nem_dispatch_price
            GROUP BY regionid
        ) m ON m.regionid = p.regionid AND m.mx = p.settlementdate
        ORDER BY p.regionid
    """


@router.get("/snapshot")
def snapshot() -> dict:
    with locked_conn() as con:
        nem_rows = con.execute("""
            SELECT p.regionid, p.settlementdate, p.rrp,
                   p.raise6sec_rrp, p.raise60sec_rrp, p.raise5min_rrp,
                   p.raisereg_rrp, p.raise1sec_rrp,
                   p.lower6sec_rrp, p.lower60sec_rrp, p.lower5min_rrp,
                   p.lowerreg_rrp, p.lower1sec_rrp,
                   s.totaldemand, s.availablegeneration, s.netinterchange
            FROM nem_dispatch_price p
            JOIN (
                SELECT regionid, MAX(settlementdate) AS mx
                FROM nem_dispatch_price
                GROUP BY regionid
            ) m ON m.regionid = p.regionid AND m.mx = p.settlementdate
            LEFT JOIN nem_region_summary s
                   ON s.settlementdate = p.settlementdate
                  AND s.regionid = p.regionid
            ORDER BY p.regionid
        """).fetchall()

        wem_row = con.execute(
            "SELECT interval_start, reference_trading_price, mcap_price "
            "FROM wem_price ORDER BY interval_start DESC LIMIT 1"
        ).fetchone()

        # 1-hour-ago RRP per region: find the row closest to (max_time - 1h).
        prior_rows = con.execute("""
            SELECT p.regionid, p.rrp
            FROM nem_dispatch_price p
            JOIN (
                SELECT p2.regionid,
                       MIN(ABS(strftime('%s', p2.settlementdate) -
                               strftime('%s', datetime((SELECT MAX(settlementdate) FROM nem_dispatch_price), '-1 hour')))) AS d
                FROM nem_dispatch_price p2
                GROUP BY p2.regionid
            ) m ON m.regionid = p.regionid
              AND ABS(strftime('%s', p.settlementdate) -
                      strftime('%s', datetime((SELECT MAX(settlementdate) FROM nem_dispatch_price), '-1 hour'))) = m.d
            GROUP BY p.regionid
        """).fetchall()
        prior_map = {r[0]: r[1] for r in prior_rows}

        # Cumulative price per region — rolling sum of the last 2,016
        # dispatch prices (NER cumulative price / CPT mechanism). Window
        # pre-filtered to 8 days so ROW_NUMBER only ranks recent rows.
        cum_rows = con.execute(
            """
            WITH recent AS (
                SELECT regionid, rrp,
                       ROW_NUMBER() OVER (PARTITION BY regionid
                                          ORDER BY settlementdate DESC) AS rn
                FROM nem_dispatch_price
                WHERE settlementdate >= datetime(
                    (SELECT MAX(settlementdate) FROM nem_dispatch_price),
                    '-8 days')
            )
            SELECT regionid, SUM(rrp), COUNT(*)
            FROM recent WHERE rn <= ?
            GROUP BY regionid
            """,
            (CPT_INTERVALS,),
        ).fetchall()
        cum_map = {r[0]: {"sum": r[1] or 0.0, "n": r[2]} for r in cum_rows}

        # Next-interval AEMO forecast per region. Prefer P5MIN (5-min);
        # fall back to PREDISPATCH (30-min) if P5MIN hasn't published yet
        # for that interval. `latest_actual` is the cutoff so we always show
        # the forecast for the interval *after* the one rendered as actual.
        latest_actual = con.execute(
            "SELECT MAX(settlementdate) FROM nem_dispatch_price"
        ).fetchone()[0]
        next_map: dict[str, dict] = {}
        if latest_actual:
            next_rows = con.execute(
                """
                SELECT p.regionid, p.interval_datetime, p.rrp, p.source,
                       p.run_datetime, p.total_demand
                FROM nem_predispatch_price p
                JOIN (
                    SELECT regionid, source, MIN(interval_datetime) AS mn
                    FROM nem_predispatch_price
                    WHERE interval_datetime > ?
                    GROUP BY regionid, source
                ) m ON m.regionid = p.regionid
                   AND m.source = p.source
                   AND m.mn = p.interval_datetime
                ORDER BY p.regionid,
                         CASE p.source WHEN 'P5MIN' THEN 0 ELSE 1 END
                """,
                (latest_actual,),
            ).fetchall()
            # First row per region wins (P5MIN sorted ahead of PREDISPATCH).
            for rid, idt, frrp, src, rdt, fdem in next_rows:
                if rid not in next_map:
                    next_map[rid] = {
                        "interval_datetime": _iso(idt),
                        "rrp": frrp,
                        "source": src,
                        "run_datetime": _iso(rdt),
                        "demand": fdem,
                    }

    regions = []
    for r in nem_rows:
        (rid, ts, rrp,
         r6, r60, r5m, rreg, r1s,
         l6, l60, l5m, lreg, l1s,
         demand, avail_gen, neti) = r
        regions.append({
            "regionid": rid,
            "settlementdate": _iso(ts),
            "rrp": rrp,
            "rrp_1h_ago": prior_map.get(rid),
            "next_forecast": next_map.get(rid),
            "fcas": {
                "raise6sec": r6, "raise60sec": r60, "raise5min": r5m,
                "raisereg": rreg, "raise1sec": r1s,
                "lower6sec": l6, "lower60sec": l60, "lower5min": l5m,
                "lowerreg": lreg, "lower1sec": l1s,
            },
            "totaldemand": demand,
            "availablegeneration": avail_gen,
            "netinterchange": neti,
            # NER cumulative-price mechanism: rolling 2,016-interval RRP sum
            # vs the FY threshold. apc_active=True → $600 administered cap.
            "cumulative_price": round(cum_map.get(rid, {}).get("sum", 0.0), 0),
            "cpt_threshold": CPT_THRESHOLD_AUD,
            "cpt_pct": round(cum_map.get(rid, {}).get("sum", 0.0)
                             / CPT_THRESHOLD_AUD * 100, 1),
            "cpt_intervals": cum_map.get(rid, {}).get("n", 0),
            "apc_active": cum_map.get(rid, {}).get("sum", 0.0) >= CPT_THRESHOLD_AUD,
            "apc_price": APC_PRICE_AUD,
        })

    wem = None
    if wem_row:
        wem = {
            "interval_start": _iso(wem_row[0]),
            "reference_trading_price": wem_row[1],
            "mcap_price": wem_row[2],
        }

    return {"nem": regions, "wem": wem, "generated_at": datetime.utcnow().isoformat()}


def _nem_now() -> datetime:
    """DB stores NEM time (UTC+10, no DST). Cutoffs must match."""
    return datetime.utcnow() + timedelta(hours=10)


def _bucket_minutes_for(hours: int) -> int:
    """Pick aggregation granularity so the chart stays legible.
    Returning 0 means "no bucketing" — keep the raw 5-min rows."""
    if hours <= 24:
        return 0          # native 5-min resolution
    if hours <= 72:
        return 30         # 3-day view: 30-minute means
    return 60             # 7-day view: hourly means


@router.get("/history")
@ttl_cache(30)
def history(
    region: str = Query(..., description="NEM region (NSW1...) or 'WEM'"),
    hours: int = Query(24, ge=1, le=168),
) -> dict:
    cutoff = (_nem_now() - timedelta(hours=hours)).strftime("%Y-%m-%d %H:%M:%S")
    bucket_min = _bucket_minutes_for(hours)
    with locked_conn() as con:
        if region.upper() == "WEM":
            rows = con.execute(
                "SELECT interval_start, reference_trading_price FROM wem_price "
                "WHERE interval_start >= ? ORDER BY interval_start",
                (cutoff,),
            ).fetchall()
            series = [{"t": _iso(r[0]), "rrp": r[1]} for r in rows]
            return {"region": region.upper(), "series": series, "bucket_minutes": bucket_min}

        rid = region.upper()
        if rid not in NEM_REGIONS:
            return {"region": region, "series": [], "bucket_minutes": bucket_min}

        if bucket_min == 0:
            rows = con.execute(
                """
                SELECT p.settlementdate, p.rrp,
                       p.raisereg_rrp, p.raise5min_rrp, p.raise60sec_rrp, p.raise6sec_rrp, p.raise1sec_rrp,
                       p.lowerreg_rrp, p.lower5min_rrp, p.lower60sec_rrp, p.lower6sec_rrp, p.lower1sec_rrp,
                       p.rrp AS rrp_min, p.rrp AS rrp_max,
                       s.totaldemand
                FROM nem_dispatch_price p
                LEFT JOIN nem_region_summary s
                       ON s.settlementdate = p.settlementdate
                      AND s.regionid = p.regionid
                WHERE p.regionid = ? AND p.settlementdate >= ?
                ORDER BY p.settlementdate
                """,
                (rid, cutoff),
            ).fetchall()
        else:
            # Server-side bucketing. SQLite has no DATE_TRUNC, so we floor the
            # minute field via integer division and re-stitch the timestamp.
            # MIN/MAX go alongside the mean so the chart can paint an envelope
            # if it wants to convey intra-bucket volatility.
            rows = con.execute(
                f"""
                SELECT
                    strftime('%Y-%m-%d %H:', p.settlementdate) ||
                    printf('%02d:00',
                        (CAST(strftime('%M', p.settlementdate) AS INTEGER) / {bucket_min}) * {bucket_min}
                    ) AS bucket,
                    AVG(p.rrp) AS rrp,
                    AVG(p.raisereg_rrp), AVG(p.raise5min_rrp), AVG(p.raise60sec_rrp),
                    AVG(p.raise6sec_rrp), AVG(p.raise1sec_rrp),
                    AVG(p.lowerreg_rrp), AVG(p.lower5min_rrp), AVG(p.lower60sec_rrp),
                    AVG(p.lower6sec_rrp), AVG(p.lower1sec_rrp),
                    MIN(p.rrp), MAX(p.rrp),
                    AVG(s.totaldemand)
                FROM nem_dispatch_price p
                LEFT JOIN nem_region_summary s
                       ON s.settlementdate = p.settlementdate
                      AND s.regionid = p.regionid
                WHERE p.regionid = ? AND p.settlementdate >= ?
                GROUP BY bucket
                ORDER BY bucket
                """,
                (rid, cutoff),
            ).fetchall()

        series = [{
            "t": _iso(r[0]), "rrp": r[1],
            "raisereg": r[2], "raise5min": r[3], "raise60sec": r[4],
            "raise6sec": r[5], "raise1sec": r[6],
            "lowerreg": r[7], "lower5min": r[8], "lower60sec": r[9],
            "lower6sec": r[10], "lower1sec": r[11],
            "rrp_min": r[12], "rrp_max": r[13],
            "demand": r[14],
        } for r in rows]
    return {"region": region.upper(), "series": series, "bucket_minutes": bucket_min}


@router.get("/prices/day")
def prices_day(
    region: str = Query("NSW1", description="NEM region (NSW1…TAS1)"),
    date: str = Query(..., description="NEM-time trading date, YYYY-MM-DD"),
) -> dict:
    """Full 5-minute price + demand series for one historical day.

    Powers the date-picker history explorer. Returns whatever range the
    local archive holds (backfill loads ~14 months); the frontend greys
    out dates outside `available_from`..`available_to`.
    """
    rid = region.upper()
    if rid not in NEM_REGIONS:
        return {"region": rid, "date": date, "series": []}
    try:
        day = datetime.strptime(date, "%Y-%m-%d")
    except ValueError:
        return {"region": rid, "date": date, "series": [], "error": "bad date"}

    start = day.strftime("%Y-%m-%d 00:00:00")
    end = (day + timedelta(days=1)).strftime("%Y-%m-%d 00:05:00")

    with locked_conn() as con:
        rows = con.execute(
            """
            SELECT p.settlementdate, p.rrp, s.totaldemand
            FROM nem_dispatch_price p
            LEFT JOIN nem_region_summary s
                   ON s.settlementdate = p.settlementdate
                  AND s.regionid = p.regionid
            WHERE p.regionid = ? AND p.settlementdate > ? AND p.settlementdate <= ?
            ORDER BY p.settlementdate
            """,
            (rid, start, end),
        ).fetchall()
        bounds = con.execute(
            "SELECT MIN(settlementdate), MAX(settlementdate) FROM nem_dispatch_price"
        ).fetchone()

    series = [{"t": _iso(r[0]), "rrp": r[1], "demand": r[2]} for r in rows]
    prices = [r[1] for r in rows if r[1] is not None]
    stats = None
    if prices:
        stats = {
            "max": max(prices), "min": min(prices),
            "avg": sum(prices) / len(prices),
            "spread": max(prices) - min(prices),
            "neg_intervals": sum(1 for p in prices if p < 0),
            "over300_intervals": sum(1 for p in prices if p > 300),
        }

    return {
        "region": rid,
        "date": date,
        "series": series,
        "stats": stats,
        "available_from": _iso(bounds[0])[:10] if bounds and bounds[0] else None,
        "available_to": _iso(bounds[1])[:10] if bounds and bounds[1] else None,
    }


@router.get("/prices/ohlc")
@ttl_cache(60)
def prices_ohlc(
    region: str = Query("NSW1", description="NEM region (NSW1…TAS1)"),
    hours: int = Query(24, ge=1, le=168),
    bucket_minutes: int = Query(30, ge=5, le=240,
                                description="Candle width in minutes"),
) -> dict:
    """OHLC candlestick data from raw 5-min dispatch prices.

    Each candle covers `bucket_minutes` of dispatch intervals:
      open  — first 5-min RRP in the bucket
      high  — max RRP
      low   — min RRP
      close — last 5-min RRP (equivalent to the settlement price for the period)

    Prices can be negative (excess renewables) or very high (gas peakers).
    """
    rid = region.upper()
    if rid not in NEM_REGIONS:
        return {"region": rid, "bucket_minutes": bucket_minutes, "series": []}

    cutoff = (_nem_now() - timedelta(hours=hours)).strftime("%Y-%m-%d %H:%M:%S")
    bm = bucket_minutes

    with locked_conn() as con:
        rows = con.execute(
            """
            WITH bucketed AS (
                SELECT
                    rrp,
                    settlementdate,
                    /* floor epoch seconds to bucket boundary */
                    (CAST(strftime('%s', settlementdate) AS INTEGER) / (:bm * 60))
                        * (:bm * 60) AS bucket_sec
                FROM nem_dispatch_price
                WHERE regionid = :rid AND settlementdate >= :cutoff
            ),
            ranked AS (
                SELECT *,
                    ROW_NUMBER() OVER (PARTITION BY bucket_sec ORDER BY settlementdate ASC)  AS rn_asc,
                    ROW_NUMBER() OVER (PARTITION BY bucket_sec ORDER BY settlementdate DESC) AS rn_desc,
                    COUNT(*) OVER (PARTITION BY bucket_sec) AS cnt
                FROM bucketed
            )
            SELECT
                bucket_sec,
                MAX(CASE WHEN rn_asc  = 1 THEN rrp END) AS open,
                MAX(rrp) AS high,
                MIN(rrp) AS low,
                MAX(CASE WHEN rn_desc = 1 THEN rrp END) AS close,
                MAX(cnt)  AS count
            FROM ranked
            GROUP BY bucket_sec
            HAVING open IS NOT NULL AND close IS NOT NULL
            ORDER BY bucket_sec
            """,
            {"bm": bm, "rid": rid, "cutoff": cutoff},
        ).fetchall()

    series = []
    for bucket_sec, open_, high, low, close, count in rows:
        from datetime import timezone
        t_dt = datetime.fromtimestamp(bucket_sec, tz=timezone.utc) + timedelta(hours=10)  # → NEM time
        series.append({
            "t":     t_dt.strftime("%Y-%m-%dT%H:%M"),
            "open":  round(open_,  2),
            "high":  round(high,   2),
            "low":   round(low,    2),
            "close": round(close,  2),
            "count": count,
        })

    return {
        "region": rid,
        "bucket_minutes": bm,
        "hours": hours,
        "series": series,
    }


@router.get("/forecast")
def forecast(
    region: str = Query(..., description="NEM region (NSW1...)"),
    past_hours: int = Query(24, ge=0, le=168,
                            description="How far back to include forecast rows"),
    future_hours: int = Query(8, ge=0, le=60,
                              description="How far ahead to include forecast rows. "
                                          "AEMO PREDISPATCHIS publishes ~24-40h out, "
                                          "so 48 covers the full horizon with margin."),
) -> dict:
    """Return AEMO's latest forecast for `region` spanning past + future.

    The dashed forecast line on the chart overlays the solid actuals so the
    user can compare what AEMO predicted vs what actually cleared. For each
    target interval we keep the *most recent* forecast we have stored — for
    past intervals that's the final run before the interval became actual.

    Merges P5MIN (5-min) and PREDISPATCH (30-min); where they overlap,
    P5MIN wins because it's higher resolution and refreshed every 5 min.
    """
    rid = region.upper()
    if rid not in NEM_REGIONS:
        return {"region": region, "series": [], "p5min_run": None, "predispatch_run": None}
    start = (_nem_now() - timedelta(hours=past_hours)).strftime("%Y-%m-%d %H:%M:%S")
    end = (_nem_now() + timedelta(hours=future_hours)).strftime("%Y-%m-%d %H:%M:%S")
    with locked_conn() as con:
        rows = con.execute(
            """
            SELECT interval_datetime, source, rrp, run_datetime, total_demand,
                   raisereg_rrp, raise5min_rrp, raise60sec_rrp,
                   raise6sec_rrp, raise1sec_rrp,
                   lowerreg_rrp, lower5min_rrp, lower60sec_rrp,
                   lower6sec_rrp, lower1sec_rrp
            FROM nem_predispatch_price
            WHERE regionid = ?
              AND interval_datetime >= ?
              AND interval_datetime <= ?
            ORDER BY interval_datetime,
                     CASE source WHEN 'P5MIN' THEN 0 ELSE 1 END,
                     run_datetime DESC
            """,
            (rid, start, end),
        ).fetchall()
        # Latest run vintage per source, so the UI can show
        # "AEMO forecast issued X minutes ago" — something AEMO's own
        # dashboard doesn't surface.
        run_rows = con.execute(
            """
            SELECT source, MAX(run_datetime)
            FROM nem_predispatch_price
            WHERE regionid = ?
            GROUP BY source
            """,
            (rid,),
        ).fetchall()
    runs = {src: _iso(rdt) for src, rdt in run_rows}

    # Keep only the first row per interval (already sorted to prefer P5MIN
    # then freshest run). FCAS RRPs flow through so the front-end's
    # SuggestedBids panel can build co-optimised energy + FCAS suggestions
    # without a separate round-trip.
    seen: set = set()
    series = []
    for r in rows:
        key = r[0]
        if key in seen:
            continue
        seen.add(key)
        series.append({
            "t": _iso(r[0]),
            "rrp": r[2],
            "demand": r[4],
            "source": r[1],
            "fcas": {
                "raisereg":  r[5],  "raise5min": r[6],  "raise60sec": r[7],
                "raise6sec": r[8],  "raise1sec": r[9],
                "lowerreg":  r[10], "lower5min": r[11], "lower60sec": r[12],
                "lower6sec": r[13], "lower1sec": r[14],
            },
        })
    return {
        "region": rid,
        "series": series,
        "p5min_run": runs.get("P5MIN"),
        "predispatch_run": runs.get("PREDISPATCH"),
    }


@router.get("/heatmap")
@ttl_cache(600)
def heatmap(
    days: int = Query(90, ge=7, le=180,
                      description="How many days back to include"),
) -> dict:
    """Daily MAX(rrp) and MAX(raisereg_rrp) per region for the past N days.

    The cell list is *always* `days` long per region — days with no data
    come back as nulls so the frontend can render a full N-day grid (with
    blanks for days the local DB hasn't seen yet) instead of a short
    sparse strip.
    """
    end_day = _nem_now().date()
    start_day = end_day - timedelta(days=days - 1)
    all_days = [(start_day + timedelta(days=i)).isoformat() for i in range(days)]
    cutoff = start_day.strftime("%Y-%m-%d 00:00:00")
    with locked_conn() as con:
        rows = con.execute(
            """
            SELECT regionid,
                   substr(settlementdate, 1, 10) AS day,
                   MAX(rrp)            AS rrp_max,
                   MAX(raisereg_rrp)   AS raisereg_max
            FROM nem_dispatch_price
            WHERE settlementdate >= ?
            GROUP BY regionid, day
            ORDER BY regionid, day
            """,
            (cutoff,),
        ).fetchall()

    # Pivot into {region: {day: (rrp_max, raisereg_max)}}.
    by_region: dict[str, dict[str, tuple]] = {r: {} for r in NEM_REGIONS}
    for rid, day, rmax, fmax in rows:
        if rid in by_region:
            by_region[rid][day] = (rmax, fmax)

    out_regions = []
    for rid in NEM_REGIONS:
        per_day = by_region.get(rid, {})
        cells = []
        for d in all_days:
            v = per_day.get(d)
            cells.append({
                "day": d,
                "rrp_max": v[0] if v else None,
                "raisereg_max": v[1] if v else None,
            })
        rrp_vals = [c["rrp_max"] for c in cells if c["rrp_max"] is not None]
        fcas_vals = [c["raisereg_max"] for c in cells if c["raisereg_max"] is not None]
        rrp_mean = sum(rrp_vals) / len(rrp_vals) if rrp_vals else None
        fcas_mean = sum(fcas_vals) / len(fcas_vals) if fcas_vals else None
        out_regions.append({
            "regionid": rid,
            "cells": cells,
            "rrp_mean": rrp_mean,
            "raisereg_mean": fcas_mean,
        })
    return {"days": days, "regions": out_regions}


@router.post("/admin/backfill")
async def admin_backfill(
    days: int = Query(90, ge=1, le=180,
                      description="How many days of DispatchIS history to backfill"),
    force: bool = Query(False,
                        description="Re-download days that already have a full set of intervals"),
) -> dict:
    """Pull historical dispatch data from NEMWEB Archive so the 90-day
    heatmap isn't mostly empty. Safe to re-run — days that are already full
    are skipped unless `force=True`. Long-running (≈30-60s per missing day
    over a slow link); returns a summary when complete."""
    return await backfill.backfill_days(days=days, force=force)


# AEMO constraint ID region prefixes. Some constraints span multiple
# regions; we include a constraint if it matches the region's prefix OR if
# the user requests `region=ALL`. This is a heuristic — AEMO constraint
# naming isn't perfectly normalised, but for the dashboard's "why is the
# price spiking?" use case it catches the binding constraints that matter
# (interconnector limits, regional reserve, etc.).
_REGION_PREFIX = {
    "NSW1": ("N",),
    "QLD1": ("Q",),
    "VIC1": ("V",),
    "SA1":  ("S",),
    "TAS1": ("T",),
}


def _constraint_matches_region(cid: str, region: str) -> bool:
    if region == "ALL":
        return True
    prefixes = _REGION_PREFIX.get(region, ())
    if not prefixes:
        return False
    # AEMO IDs come in a few shapes:
    #   "N::N_NIL_2"            single-region NSW
    #   "NSW1_FCASRR_500"       region name spelled out
    #   "Q^^N_NIL_S2"           cross-region QLD→NSW (so we want this in BOTH)
    #   "V^SML_NSWRB_1"         VIC constraint
    # We match if any of: full region name appears anywhere, head letter
    # matches, OR a "^<prefix>" / "^^<prefix>" / "::<prefix>" appears
    # (catches the "affected region" half of a cross-region constraint).
    if region in cid:
        return True
    if cid[:1] in prefixes:
        return True
    for p in prefixes:
        if f"^{p}" in cid or f"::{p}" in cid:
            return True
    return False


@router.get("/constraints")
def constraints(
    region: str = Query("NSW1",
                         description="NEM region or 'ALL' to return every binding constraint"),
    hours: int = Query(6, ge=1, le=72,
                        description="How far back to look (in NEM-time hours)"),
    limit: int = Query(500, ge=1, le=5000),
) -> dict:
    """Binding network/security constraints over the last `hours` hours.

    We store only rows with non-zero `marginalvalue` (= binding), so any
    row returned was actively constraining NEMDE at that dispatch interval.
    The region filter is a heuristic on the AEMO constraint ID prefix —
    callers can pass `region=ALL` to get every binding constraint."""
    cutoff = (_nem_now() - timedelta(hours=hours)).strftime("%Y-%m-%d %H:%M:%S")
    with locked_conn() as con:
        rows = con.execute(
            """
            SELECT settlementdate, constraintid, rhs, marginalvalue, violationdegree
            FROM nem_dispatch_constraint
            WHERE settlementdate >= ?
            ORDER BY settlementdate DESC, ABS(marginalvalue) DESC
            LIMIT ?
            """,
            (cutoff, limit),
        ).fetchall()
    out = [
        {
            "settlementdate": _iso(r[0]),
            "constraintid": r[1],
            "rhs": r[2],
            "marginalvalue": r[3],
            "violationdegree": r[4],
        }
        for r in rows
        if _constraint_matches_region(r[1], region)
    ]
    # Group settlement dates so the frontend can plot a small badge per
    # interval that had any binding constraint, without re-walking the list.
    intervals = sorted({c["settlementdate"] for c in out if c["settlementdate"]})
    return {
        "region": region,
        "hours": hours,
        "constraints": out,
        "binding_intervals": intervals,
    }


@router.get("/constraints/active")
def constraints_active(
    region: str = Query("NSW1",
                         description="NEM region or 'ALL'"),
) -> dict:
    """Binding constraints in the most recent dispatch interval.

    Used by the UI to show a real-time alert banner without fetching the full
    6-hour window. Returns at most the last 2 settlement intervals to tolerate
    the ~30-60 s lag between AEMO publishing and our ingestion."""
    # Last 15 minutes in NEM time covers up to 3 dispatch intervals with slack.
    cutoff = (_nem_now() - timedelta(minutes=15)).strftime("%Y-%m-%d %H:%M:%S")
    with locked_conn() as con:
        latest_ts = con.execute(
            "SELECT MAX(settlementdate) FROM nem_dispatch_constraint WHERE settlementdate >= ?",
            (cutoff,),
        ).fetchone()[0]

        if not latest_ts:
            return {"region": region, "active": [], "as_at": None}

        rows = con.execute(
            """
            SELECT settlementdate, constraintid, rhs, marginalvalue, violationdegree
            FROM nem_dispatch_constraint
            WHERE settlementdate = ?
            ORDER BY ABS(marginalvalue) DESC
            LIMIT 100
            """,
            (latest_ts,),
        ).fetchall()

    active = [
        {
            "settlementdate": _iso(r[0]),
            "constraintid": r[1],
            "rhs": r[2],
            "marginalvalue": r[3],
            "violationdegree": r[4],
        }
        for r in rows
        if _constraint_matches_region(r[1], region)
    ]
    # Severity: 0=none, 1=binding (marginalvalue nonzero), 2=violated (violationdegree > 0)
    severity = 0
    if active:
        severity = 2 if any(c["violationdegree"] and c["violationdegree"] > 0 for c in active) else 1
    return {"region": region, "active": active, "as_at": _iso(latest_ts), "severity": severity}


@router.get("/fcas/matrix")
def fcas_matrix() -> dict:
    with locked_conn() as con:
        rows = con.execute("""
            SELECT p.regionid, p.settlementdate,
                   p.raise6sec_rrp, p.raise60sec_rrp, p.raise5min_rrp, p.raisereg_rrp, p.raise1sec_rrp,
                   p.lower6sec_rrp, p.lower60sec_rrp, p.lower5min_rrp, p.lowerreg_rrp, p.lower1sec_rrp
            FROM nem_dispatch_price p
            JOIN (
                SELECT regionid, MAX(settlementdate) AS mx
                FROM nem_dispatch_price GROUP BY regionid
            ) m ON m.regionid = p.regionid AND m.mx = p.settlementdate
            ORDER BY p.regionid
        """).fetchall()
    markets = ["raise6sec", "raise60sec", "raise5min", "raisereg", "raise1sec",
               "lower6sec", "lower60sec", "lower5min", "lowerreg", "lower1sec"]
    matrix = []
    for r in rows:
        matrix.append({
            "regionid": r[0],
            "settlementdate": _iso(r[1]),
            **{m: r[i + 2] for i, m in enumerate(markets)},
        })
    return {"markets": markets, "regions": matrix}


@router.get("/fcas/forecast")
def fcas_forecast(
    region: str = Query("NSW1", description="Focus NEM region for product cards"),
    future_hours: int = Query(1, ge=1, le=MAX_FCAS_FORECAST_HOURS,
                              description="Forecast horizon. P5MIN covers ~1h; PREDISPATCH extends further."),
    power_mw: float = Query(10.0, ge=0, le=10000,
                            description="Enabled FCAS capacity for the revenue simulator"),
    availability_pct: float = Query(100.0, ge=0, le=100,
                                    description="Share of power offered as FCAS availability"),
) -> dict:
    """AEMO forecast-driven FCAS predictor.

    Reads the same P5MIN/PREDISPATCH rows already used for the RRP forecast
    overlay, but aggregates the 10 FCAS markets into product cards, regional
    comparisons, and a simple capacity-payment simulator.
    """
    focus = region.upper()
    if focus not in NEM_REGIONS:
        focus = "NSW1"

    placeholders = ",".join("?" for _ in NEM_REGIONS)
    modifier = f"+{future_hours} hours"
    with locked_conn() as con:
        latest_actual = con.execute(
            "SELECT MAX(settlementdate) FROM nem_dispatch_price"
        ).fetchone()[0]
        if latest_actual is None:
            return build_fcas_forecast(
                [], focus_region=focus, power_mw=power_mw,
                availability_pct=availability_pct,
            )

        window_end = con.execute(
            "SELECT datetime(?, ?)",
            (latest_actual, modifier),
        ).fetchone()[0]

        rows = con.execute(
            f"""
            SELECT regionid, interval_datetime, source, run_datetime,
                   raise1sec_rrp, raise6sec_rrp, raise60sec_rrp,
                   raise5min_rrp, raisereg_rrp,
                   lower1sec_rrp, lower6sec_rrp, lower60sec_rrp,
                   lower5min_rrp, lowerreg_rrp
            FROM nem_predispatch_price
            WHERE interval_datetime > ?
              AND interval_datetime <= ?
              AND regionid IN ({placeholders})
            ORDER BY regionid, interval_datetime,
                     CASE source WHEN 'P5MIN' THEN 0 ELSE 1 END,
                     run_datetime DESC
            """,
            (latest_actual, window_end, *NEM_REGIONS),
        ).fetchall()

    mapped = []
    for row in rows:
        item = {
            "regionid": row[0],
            "interval_datetime": row[1],
            "source": row[2],
            "run_datetime": row[3],
        }
        for market, value in zip(MARKET_KEYS, row[4:]):
            item[market] = value
        mapped.append(item)

    out = build_fcas_forecast(
        mapped,
        focus_region=focus,
        power_mw=power_mw,
        availability_pct=availability_pct,
    )
    out["window_start"] = _iso(latest_actual)
    out["window_end"] = _iso(window_end)
    out["generated_at"] = datetime.utcnow().isoformat()
    return out


def _iso(v) -> str | None:
    """SQLite returns TIMESTAMP as datetime (when detect_types is set) or str."""
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.isoformat()
    return str(v)
