"""Forecast logging, backtest seeding, accuracy metrics, and live series.

Fair accuracy needs each model's *day-ahead vintage* — the prediction it would
have made ~24h out, frozen and never peeked-at again. `log_forecasts()` records
that going forward (first write per (target, model) wins; later runs INSERT OR
IGNORE), so the numbers are genuinely out-of-sample. `seed_recent()` backtests
the last few days at boot so the page isn't empty on day one; the forward log
then keeps improving it.

Actuals always come from `nem_dispatch_price`. Everything is on the 30-min
trading grid in NEM time.
"""
from __future__ import annotations

import logging
import math
from datetime import datetime, timedelta

from ..db import locked_conn, write_conn
from . import data
from .models import active_models, benchmark

log = logging.getLogger("forecast.eval")

HORIZON_HH = 48          # 24h of half-hours
SEED_DAYS = 7            # backtest window seeded at boot
_Z90 = 1.2816            # ±z for P10/P90
_Z75 = 0.6745            # ±z for P25/P75


# ── Forward logging (locked day-ahead vintage) ───────────────────────────────

def log_forecasts(region: str = "NSW1") -> int:
    """Record each active model's forecast for the next 24h. First vintage per
    (target, model) is locked via INSERT OR IGNORE — so a target logged ~24h
    ahead keeps that genuine day-ahead prediction."""
    now = data.nem_now()
    targets = data.half_hour_targets(now, HORIZON_HH)
    made = data.fmt(now)
    rows: list[tuple] = []
    with locked_conn() as con:
        for m in active_models():
            try:
                preds = m.predict(con, region, targets, asof=now)
            except Exception:
                log.exception("model %s predict failed", m.name)
                continue
            for t, v in preds.items():
                rows.append((data.fmt(t), region, m.name, v, made))
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


# ── Boot-time backtest seed ──────────────────────────────────────────────────

# Models whose day-ahead vintage we can HONESTLY reconstruct from history at a
# past as-of (they only use actuals before the cutoff). The AEMO benchmark is
# excluded: the live predispatch table only retains a near-nowcast for past
# targets, so "seeding" it would fabricate an unrealistically accurate AEMO and
# bias the comparison. AEMO comes only from the forward logger (genuine
# day-ahead vintage) and the archive backfill (true historical day-ahead).
_SEEDABLE = ("ours", "naive")


def seed_recent(region: str = "NSW1", days: int = SEED_DAYS) -> int:
    """Backtest the last `days` complete days so the accuracy panel has data
    immediately. For each target day D we stand at D 00:00 (NEM) and let each
    model use only actuals strictly before D — a genuine day-ahead backtest.
    INSERT OR IGNORE so live (forward-logged) vintages are never overwritten."""
    now = data.nem_now()
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    rows: list[tuple] = []
    with locked_conn() as con:
        for d in range(1, days + 1):
            day_start = today - timedelta(days=d)
            asof = day_start                      # information cutoff
            targets = [day_start + timedelta(minutes=30 * (i + 1)) for i in range(HORIZON_HH)]
            made = data.fmt(asof)
            for m in active_models():
                if m.name not in _SEEDABLE:
                    continue
                try:
                    preds = m.predict(con, region, targets, asof=asof)
                except Exception:
                    log.exception("seed model %s failed", m.name)
                    continue
                for t, v in preds.items():
                    rows.append((data.fmt(t), region, m.name, v, made))
    if not rows:
        return 0
    with write_conn() as con:
        con.executemany(
            """INSERT OR IGNORE INTO forecast_eval
               (target_datetime, regionid, model, predicted_rrp, made_at)
               VALUES (?,?,?,?,?)""",
            rows,
        )
    log.info("forecast seed: %d (region=%s, days=%d)", len(rows), region, days)
    return len(rows)


# ── Accuracy metrics ─────────────────────────────────────────────────────────

def accuracy(region: str = "NSW1", window_days: int = 30) -> dict:
    """Fair, apples-to-apples accuracy. Every model is scored on the SAME set of
    intervals — those where an actual exists AND every compared model has a
    prediction. This matters because AEMO predispatch only reaches the end of
    the next trading day, so its day-ahead coverage is partial; scoring each
    model on its own (different) targets would compare apples to oranges."""
    now = data.nem_now()
    start = now - timedelta(days=window_days)

    with locked_conn() as con:
        actuals = data.fetch_actuals_hh(con, region, start, now)
        rows = con.execute(
            """
            SELECT model, target_datetime, predicted_rrp
            FROM forecast_eval
            WHERE regionid = ? AND target_datetime >= ? AND target_datetime <= ?
              AND predicted_rrp IS NOT NULL
            """,
            (region, data.fmt(start), data.fmt(now)),
        ).fetchall()

    # model -> {target_dt: pred}
    preds: dict[str, dict] = {}
    for model, t, pred in rows:
        preds.setdefault(model, {})[data._as_dt(t)] = float(pred)

    bench = benchmark().name
    # Each model's own coverage (intervals where it has a pred AND an actual).
    coverage = {
        name: sum(1 for t in pm if t in actuals)
        for name, pm in preds.items()
    }
    # Compared models = active models that actually have predictions. The common
    # target set is the intersection of their targets ∩ actuals.
    compare = [m for m in active_models() if coverage.get(m.name, 0) > 0]
    common: set = set(actuals)
    for m in compare:
        common &= set(preds[m.name])
    common_sorted = sorted(common)
    n_common = len(common_sorted)

    def _metrics(name: str):
        pm = preds.get(name, {})
        trip = [(actuals[t], pm[t], t.hour) for t in common_sorted if t in pm]
        if not trip:
            return None
        errs = [pr - ac for ac, pr, _ in trip]
        mae = sum(abs(e) for e in errs) / len(errs)
        rmse = _rmse(trip)
        bias = sum(errs) / len(errs)
        smape = 100.0 * sum(
            abs(pr - ac) / ((abs(ac) + abs(pr)) / 2 + 1e-9) for ac, pr, _ in trip
        ) / len(trip)
        by_hour_acc: list[list[float]] = [[] for _ in range(24)]
        for ac, pr, h in trip:
            by_hour_acc[h].append(abs(pr - ac))
        by_hour = [round(sum(v) / len(v), 1) if v else None for v in by_hour_acc]
        return mae, rmse, bias, smape, by_hour

    bench_m = _metrics(bench) if bench in {m.name for m in compare} else None
    bench_rmse = bench_m[1] if bench_m else 0.0

    out_models = []
    for m in active_models():
        res = _metrics(m.name) if m.name in {c.name for c in compare} else None
        if res is None:
            out_models.append({
                "name": m.name, "label": m.label, "color": m.color,
                "is_benchmark": m.is_benchmark, "n": 0,
                "n_total": coverage.get(m.name, 0),
                "mae": None, "rmse": None, "smape": None, "bias": None,
                "skill": None, "by_hour": [None] * 24,
            })
            continue
        mae, rmse, bias, smape, by_hour = res
        skill = (1.0 - rmse / bench_rmse) if (bench_rmse and not m.is_benchmark) else None
        out_models.append({
            "name": m.name, "label": m.label, "color": m.color,
            "is_benchmark": m.is_benchmark, "n": n_common,
            "n_total": coverage.get(m.name, 0),
            "mae": round(mae, 2), "rmse": round(rmse, 2),
            "smape": round(smape, 1), "bias": round(bias, 2),
            "skill": round(skill, 3) if skill is not None else None,
            "by_hour": by_hour,
        })

    rated = [m for m in out_models if m["rmse"] is not None]
    winner = min(rated, key=lambda m: m["rmse"])["name"] if rated else None

    return {
        "region": region,
        "window_days": window_days,
        "benchmark": bench,
        "winner": winner,
        "n_common": n_common,        # intervals all models share (the fair set)
        "models": out_models,
        "generated_at": data.fmt(now),
        # peak-volatility window the UI highlights
        "evening_peak": [16, 20],
    }


# ── Live series for the chart ────────────────────────────────────────────────

def series(region: str = "NSW1", past_hours: int = 12) -> dict:
    now = data.nem_now()
    past_start = now - timedelta(hours=past_hours)
    targets = data.half_hour_targets(now, HORIZON_HH)

    with locked_conn() as con:
        actuals = data.fetch_actuals_hh(con, region, past_start, now)
        model_preds = {}
        for m in active_models():
            try:
                model_preds[m.name] = m.predict(con, region, targets, asof=now)
            except Exception:
                log.exception("series model %s failed", m.name)
                model_preds[m.name] = {}
        std, bias = _aemo_error_stats(con, region, now)

    actual_points = [
        {"t": data.fmt(t), "rrp": round(v, 2)}
        for t, v in sorted(actuals.items())
    ]

    out_models = []
    for m in active_models():
        preds = model_preds.get(m.name, {})
        points = []
        for t in targets:
            v = preds.get(t)
            if v is None:
                continue
            pt = {"t": data.fmt(t), "rrp": v}
            if m.is_benchmark:  # uncertainty band on the AEMO benchmark line
                pt["p10"] = round(data.clip(v - _Z90 * std), 2)
                pt["p25"] = round(data.clip(v - _Z75 * std), 2)
                pt["p75"] = round(data.clip(v + _Z75 * std), 2)
                pt["p90"] = round(data.clip(v + _Z90 * std), 2)
            points.append(pt)
        out_models.append({
            "name": m.name, "label": m.label, "color": m.color,
            "is_benchmark": m.is_benchmark, "points": points,
        })

    return {
        "region": region,
        "now": data.fmt(now),
        "actuals": actual_points,
        "models": out_models,
        "aemo_error_std": round(std, 2),
        "aemo_bias": round(bias, 2),
    }


# ── internals ────────────────────────────────────────────────────────────────

def _rmse(pairs: list[tuple[float, float, int]]) -> float:
    if not pairs:
        return 0.0
    return math.sqrt(sum((pred - act) ** 2 for act, pred, _ in pairs) / len(pairs))


def _aemo_error_stats(con, region: str, now: datetime,
                      lookback_days: int = 14) -> tuple[float, float]:
    """(std, bias) of AEMO forecast error vs actual over the recent window,
    from logged vintages. Falls back to a conservative std when sparse."""
    start = now - timedelta(days=lookback_days)
    actuals = data.fetch_actuals_hh(con, region, start, now)
    rows = con.execute(
        """SELECT target_datetime, predicted_rrp FROM forecast_eval
           WHERE regionid=? AND model='aemo' AND target_datetime>=? AND target_datetime<=?
             AND predicted_rrp IS NOT NULL""",
        (region, data.fmt(start), data.fmt(now)),
    ).fetchall()
    errs = []
    for t, pred in rows:
        a = actuals.get(data._as_dt(t))
        if a is not None:
            errs.append(float(pred) - a)
    if len(errs) < 2:
        return 50.0, 0.0
    mean = sum(errs) / len(errs)
    var = sum((e - mean) ** 2 for e in errs) / (len(errs) - 1)
    return math.sqrt(var), mean
