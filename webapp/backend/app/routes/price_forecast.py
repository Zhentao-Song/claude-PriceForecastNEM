"""P5MIN price forecast endpoint with historical error bands.

Returns the latest predispatch price forecast for a NEM region together with
±1σ / ±2σ uncertainty bands derived from historical forecast errors vs actual
RRP over the last 30 days.
"""
from __future__ import annotations

import math
from datetime import datetime, timezone

from fastapi import APIRouter, Query

from ..db import locked_conn

router = APIRouter()

# Quantile z-scores (normal distribution)
_Z_P10_P90 = 1.2816   # ±z gives P10/P90
_Z_P25_P75 = 0.6745   # ±z gives P25/P75

# NEM floor price (administrative minimum)
_NEM_FLOOR = -1000.0


@router.get("/api/price-forecast")
def get_price_forecast(
    region: str = Query("NSW1", description="NEM region ID, e.g. NSW1"),
):
    """Return the latest predispatch price forecast with historical error bands."""

    # ── 1. Latest predispatch forecast (up to 12 intervals = 1 hour ahead) ──
    with locked_conn() as con:
        forecast_rows = con.execute(
            """
            SELECT interval_datetime, rrp, source
            FROM nem_predispatch_price
            WHERE regionid = ?
              AND run_datetime = (
                SELECT MAX(run_datetime)
                FROM nem_predispatch_price
                WHERE regionid = ?
              )
            ORDER BY interval_datetime
            LIMIT 12
            """,
            (region, region),
        ).fetchall()

        # ── 2. Historical forecast errors (last 30 days) ──────────────────
        error_rows = con.execute(
            """
            SELECT
                p.interval_datetime,
                p.rrp  AS forecast_rrp,
                a.rrp  AS actual_rrp,
                p.rrp - a.rrp AS error
            FROM nem_predispatch_price p
            JOIN nem_dispatch_price a
                ON a.settlementdate = p.interval_datetime
               AND a.regionid = p.regionid
            WHERE p.regionid = ?
              AND p.interval_datetime >= datetime('now', '-30 days')
            ORDER BY p.interval_datetime
            """,
            (region,),
        ).fetchall()

    # ── Compute error statistics ──────────────────────────────────────────
    errors = [float(r[3]) for r in error_rows if r[3] is not None]
    n_errors = len(errors)

    if n_errors > 1:
        mean_err = sum(errors) / n_errors
        variance = sum((e - mean_err) ** 2 for e in errors) / (n_errors - 1)
        error_std = math.sqrt(variance)
    else:
        mean_err = 0.0
        error_std = 50.0  # conservative fallback when no history

    # ── Build forecast points with quantile bands ─────────────────────────
    generated_at = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()

    forecast_out = []
    for row in forecast_rows:
        interval_dt, fc_rrp, source = row
        if fc_rrp is None:
            continue
        p50 = float(fc_rrp) - mean_err  # bias-corrected median

        p10 = max(_NEM_FLOOR, p50 - _Z_P10_P90 * error_std)
        p25 = max(_NEM_FLOOR, p50 - _Z_P25_P75 * error_std)
        p75 = p50 + _Z_P25_P75 * error_std
        p90 = p50 + _Z_P10_P90 * error_std

        forecast_out.append({
            "interval_datetime": str(interval_dt),
            "source": source,
            "p50": round(p50, 2),
            "p10": round(p10, 2),
            "p25": round(p25, 2),
            "p75": round(p75, 2),
            "p90": round(p90, 2),
        })

    return {
        "region": region,
        "generated_at": generated_at,
        "forecast": forecast_out,
        "error_std": round(error_std, 2),
        "mean_bias": round(mean_err, 2),
        "n_historical_errors": n_errors,
    }
