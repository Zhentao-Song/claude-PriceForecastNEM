"""Forecast page endpoints.

Two read-only endpoints backed by the `app.forecast` subsystem:

- GET /api/forecast/series    — the live chart: recent actuals + each active
  model's next-24h forecast (with an uncertainty band on the AEMO benchmark).
- GET /api/forecast/accuracy  — the analysis panel: per-model MAE / RMSE /
  sMAPE / bias / skill-vs-AEMO + error-by-hour over a trailing window.

Both are sync `def` (FastAPI threadpool) and read-only, so they never contend
with the scraper/forecast writers. v1 is NSW1; `region` is a parameter.
"""
from __future__ import annotations

from fastapi import APIRouter, Query

from ..forecast import backfill as fc_backfill
from ..forecast import eval as fc_eval

router = APIRouter()


@router.get("/api/forecast/series")
def get_forecast_series(
    region: str = Query("NSW1", description="NEM region ID, e.g. NSW1"),
    past_hours: int = Query(12, ge=0, le=48,
                            description="Hours of recent actuals to include"),
):
    """Recent actuals + each model's next-24h forecast (30-min grid)."""
    return fc_eval.series(region=region, past_hours=past_hours)


@router.get("/api/forecast/accuracy")
def get_forecast_accuracy(
    region: str = Query("NSW1", description="NEM region ID, e.g. NSW1"),
    window_days: int = Query(30, ge=1, le=365,
                             description="Trailing window for the metrics"),
):
    """Per-model accuracy metrics over the trailing window."""
    return fc_eval.accuracy(region=region, window_days=window_days)


@router.post("/api/forecast/backfill")
def post_forecast_backfill(
    weeks: int = Query(4, ge=1, le=26,
                       description="Recent weekly archive bundles to ingest"),
    region: str = Query("NSW1", description="NEM region ID, e.g. NSW1"),
):
    """Kick off the true day-ahead AEMO backfill (background). Each weekly
    bundle is ~300 MB, so this is on-demand, not automatic."""
    started = fc_backfill.start_backfill(weeks=weeks, region=region)
    return {"started": started, **fc_backfill.get_state()}


@router.get("/api/forecast/backfill/status")
def get_forecast_backfill_status():
    return fc_backfill.get_state()


@router.post("/api/forecast/reseed")
def post_forecast_reseed(
    days: int = Query(35, ge=1, le=120,
                      description="Days of day-ahead backtest to (re)state"),
    replace: bool = Query(True, description="Overwrite existing seedable rows"),
    region: str = Query("NSW1"),
):
    """Re-state the seedable models (ours/naive/ml) over the recent window in a
    background thread — used after a model changes so the accuracy panel
    reflects the current code. AEMO vintages are never touched."""
    from threading import Thread
    Thread(target=fc_eval.seed_recent,
           kwargs={"region": region, "days": days, "replace": replace},
           daemon=True).start()
    return {"started": True, "days": days, "replace": replace, "region": region}
