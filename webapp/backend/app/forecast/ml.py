"""LightGBM price-forecast model — the reserved ML slot, now implemented.

Gradient-boosted trees are the workhorse that the NEM price-forecasting
literature uses to beat AEMO predispatch. We train one model per region on the
full price history with engineered features:

  · calendar       — hour, day-of-week, month, weekend, cyclical hour
  · price lags     — 30 min, 1 day, 2 days, 7 days ago
  · rolling level  — mean over the last 1 day and 7 days
  · weather        — temperature, solar radiation (GHI), wind (Open-Meteo)
  · AEMO anchor    — predispatch RRP for the target (so the model literally
                     learns how/when to correct AEMO); NaN where unavailable,
                     which LightGBM handles natively

Target is the actual 30-min RRP; objective is L1 (robust to price spikes).
The model is retrained daily by the scheduler and persisted to DATA_DIR; it is
loaded lazily for prediction and re-loaded when the file changes. If LightGBM
isn't installed or no model has been trained yet, the model reports itself
disabled and is simply hidden — nothing else has to know.
"""
from __future__ import annotations

import logging
import math
import os
from datetime import datetime, timedelta

from ..config import DATA_DIR
from ..db import locked_conn
from . import data, weather

log = logging.getLogger("forecast.ml")

try:
    import lightgbm as lgb
    import numpy as np
    HAVE_LGB = True
except Exception:  # pragma: no cover - dependency optional
    HAVE_LGB = False

# Feature column order — must match between train and predict.
FEATURES = [
    "hour", "dow", "month", "is_weekend", "hour_sin", "hour_cos",
    "lag_30m", "lag_1d", "lag_2d", "lag_7d",
    "roll_1d", "roll_7d",
    "temp", "ghi", "wind",
    "aemo",
]
TRAIN_DAYS = 540          # ~18 months of history
_HALF = timedelta(minutes=30)

_cache: dict[str, tuple[float, object]] = {}   # region -> (mtime, booster)


def _model_path(region: str) -> str:
    return str(DATA_DIR / f"ml_forecast_{region}.txt")


# ── Feature engineering ──────────────────────────────────────────────────────

def _grid(start: datetime, end: datetime) -> list[datetime]:
    """Complete 30-min grid [start, end] so positional lags are exact."""
    out, t = [], start
    while t <= end:
        out.append(t)
        t += _HALF
    return out


def _matrix(grid, price, wx, aemo):
    """Build the LightGBM feature matrix (np.ndarray) for the grid. `price` is a
    dict t->RRP (target + lags), `wx` t->(temp,ghi,wind), `aemo` t->RRP."""
    n = len(grid)
    idx = {t: i for i, t in enumerate(grid)}
    parr = np.array([price.get(t, np.nan) for t in grid], dtype=float)

    def shifted(steps):
        a = np.full(n, np.nan)
        if steps < n:
            a[steps:] = parr[:n - steps]
        return a

    def rolling(w):
        a = np.full(n, np.nan)
        c = np.concatenate([[0.0], np.nancumsum(parr)])
        cnt = np.concatenate([[0.0], np.cumsum(~np.isnan(parr))])
        for i in range(w, n):
            k = cnt[i] - cnt[i - w]
            if k > 0:
                a[i] = (c[i] - c[i - w]) / k
        return a

    cols = {
        "hour": np.array([t.hour for t in grid], float),
        "dow": np.array([t.weekday() for t in grid], float),
        "month": np.array([t.month for t in grid], float),
        "is_weekend": np.array([1.0 if t.weekday() >= 5 else 0.0 for t in grid]),
        "hour_sin": np.array([math.sin(2 * math.pi * t.hour / 24) for t in grid]),
        "hour_cos": np.array([math.cos(2 * math.pi * t.hour / 24) for t in grid]),
        "lag_30m": shifted(1),
        "lag_1d": shifted(48),
        "lag_2d": shifted(96),
        "lag_7d": shifted(336),
        "roll_1d": rolling(48),
        "roll_7d": rolling(336),
        "temp": np.array([(wx.get(t) or (np.nan,))[0] for t in grid], float),
        "ghi": np.array([(wx.get(t) or (np.nan, np.nan))[1] for t in grid], float),
        "wind": np.array([(wx.get(t) or (np.nan, np.nan, np.nan))[2] for t in grid], float),
        "aemo": np.array([aemo.get(t, np.nan) for t in grid], float),
    }
    X = np.column_stack([cols[f] for f in FEATURES])
    return X, parr


# ── Training ─────────────────────────────────────────────────────────────────

def train(region: str = "NSW1", days: int = TRAIN_DAYS) -> dict:
    if not HAVE_LGB:
        return {"error": "lightgbm not installed"}
    now = data.nem_now()
    start = now - timedelta(days=days)
    with locked_conn() as con:
        price = data.fetch_actuals_hh(con, region, start, now)
        if len(price) < 2000:
            return {"error": f"insufficient history ({len(price)} rows)"}
        wx = weather.fetch_weather_hh(con, region, start, now)
        aemo = data.fetch_eval_aemo_hh(con, region, _grid(start, now))

    grid = _grid(min(price), max(price))
    X, y = _matrix(grid, price, wx, aemo)
    # Train only on rows with a known target and enough lag history (skip first 7d).
    mask = ~np.isnan(y)
    mask[:336] = False
    Xtr, ytr = X[mask], y[mask]
    if len(ytr) < 1000:
        return {"error": f"too few training rows ({len(ytr)})"}

    dtrain = lgb.Dataset(Xtr, label=ytr, feature_name=FEATURES)
    params = {
        "objective": "regression_l1",   # MAE — robust to price spikes
        "num_leaves": 48,
        "learning_rate": 0.05,
        "feature_fraction": 0.85,
        "bagging_fraction": 0.85,
        "bagging_freq": 1,
        "min_data_in_leaf": 50,
        "verbose": -1,
    }
    booster = lgb.train(params, dtrain, num_boost_round=400)
    booster.save_model(_model_path(region))
    _cache.pop(region, None)
    log.info("ML trained region=%s rows=%d", region, len(ytr))
    return {"region": region, "rows": int(len(ytr)), "model": _model_path(region)}


def _load(region: str):
    path = _model_path(region)
    if not os.path.exists(path):
        return None
    mtime = os.path.getmtime(path)
    cached = _cache.get(region)
    if cached and cached[0] == mtime:
        return cached[1]
    booster = lgb.Booster(model_file=path)
    _cache[region] = (mtime, booster)
    return booster


def available(region: str = "NSW1") -> bool:
    return HAVE_LGB and os.path.exists(_model_path(region))


# ── Prediction ───────────────────────────────────────────────────────────────

def predict(con, region: str, targets: list[datetime],
            asof: datetime | None = None) -> dict[datetime, float]:
    if not HAVE_LGB or not targets:
        return {}
    booster = _load(region)
    if booster is None:
        return {}
    asof = asof or data.nem_now()
    # History for lags/rolling (actuals strictly before each target's needs).
    lo = min(targets) - timedelta(days=8)
    price = data.fetch_actuals_hh(con, region, lo, asof)
    wx = weather.fetch_weather_hh(con, region, min(targets), max(targets))
    aemo = data.fetch_aemo_hh(con, region, targets)
    for t, v in data.fetch_eval_aemo_hh(con, region, targets).items():
        aemo.setdefault(t, v)

    # Build a grid spanning history + targets so positional lags resolve.
    grid = _grid(lo, max(targets))
    # price for lag lookups = actuals; targets themselves have no actual (future)
    X, _ = _matrix(grid, price, wx, aemo)
    tset = set(targets)
    rows = [i for i, t in enumerate(grid) if t in tset]
    if not rows:
        return {}
    preds = booster.predict(X[rows])
    out: dict[datetime, float] = {}
    for i, gi in enumerate(rows):
        out[grid[gi]] = round(data.clip(float(preds[i])), 2)
    return out
