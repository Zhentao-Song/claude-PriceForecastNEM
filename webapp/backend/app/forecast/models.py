"""Forecast model registry — the pluggable "our own forecast structure".

Every model implements `ForecastModel.predict(region, targets, asof)`:
returns {target_halfhour_end: predicted_rrp}. `asof` bounds the information a
model may use (so the same code does both a genuine day-ahead backtest and a
live forecast). New models just subclass and register — routes, logging,
accuracy and the UI all iterate the registry, so nothing else changes.

v1 ships four live models + one stub:
  - AemoModel     — AEMO PREDISPATCH (the industry benchmark to beat).
  - NaiveModel    — seasonal-naive (last week, same weekday/time). Academic
                    baseline; fully backtestable over all history.
  - ResidualModel — our own: a weekly/daily/recent ensemble, anchored to AEMO
                    when available. Lightweight, no heavy deps, backtestable.
  - AmberModel    — real third party (Amber Electric API), token-gated; hidden
                    when AMBER_API_TOKEN is unset.
  - MLModel       — reserved (lightgbm / quantile regression). Not active.
"""
from __future__ import annotations

import logging
import os
import sqlite3
from datetime import datetime, timedelta

import httpx

from . import data

log = logging.getLogger("forecast.models")


class ForecastModel:
    """Base interface. `name` is the stable key stored in forecast_eval;
    `label`/`color` drive the UI legend."""

    name: str = "base"
    label: str = "Base"
    color: str = "#888888"
    # When True this is the official operator benchmark; the accuracy panel
    # computes every other model's skill score relative to it.
    is_benchmark: bool = False

    @property
    def enabled(self) -> bool:
        return True

    def predict(
        self,
        con: sqlite3.Connection,
        region: str,
        targets: list[datetime],
        asof: datetime | None = None,
    ) -> dict[datetime, float]:
        raise NotImplementedError


# ── AEMO PREDISPATCH (benchmark) ─────────────────────────────────────────────

class AemoModel(ForecastModel):
    name = "aemo"
    label = "AEMO 预测"
    color = "#3b82f6"   # blue
    is_benchmark = True

    def predict(self, con, region, targets, asof=None):
        return data.fetch_aemo_hh(con, region, targets)


# ── Seasonal-naive baseline ──────────────────────────────────────────────────

class NaiveModel(ForecastModel):
    name = "naive"
    label = "朴素基准"
    color = "#9ca3af"   # gray

    def predict(self, con, region, targets, asof=None):
        if not targets:
            return {}
        asof = asof or data.nem_now()
        lo = min(targets) - timedelta(days=8)
        hist = data.fetch_actuals_hh(con, region, lo, asof)
        last = _last_known(hist, asof)
        out: dict[datetime, float] = {}
        for t in targets:
            # last week, same weekday & time → last day same time → persistence
            v = hist.get(t - timedelta(days=7))
            if v is None:
                v = hist.get(t - timedelta(days=1))
            if v is None:
                v = last
            if v is not None:
                out[t] = round(data.clip(v), 2)
        return out


# ── Our own model: weekly/daily/recent ensemble + AEMO anchor ────────────────

class ResidualModel(ForecastModel):
    """Our own model (v2). Three ideas, all from local data, no heavy deps:

    1. Actuals ensemble (weekly + daily + recent same-hour level): a robust,
       regime-aware base — the level the market has actually been clearing at.
    2. AEMO anchor with a SPIKE HAIRCUT — the Amber/CSIRO insight: AEMO
       predispatch ignores supply response, so it systematically *overstates*
       high/spiky prices (high predispatch → generators come online → price
       falls). We discount the part of AEMO's forecast sitting above the recent
       high-price threshold; the discount slope is LEARNED from recent
       day-ahead AEMO error and floored at a small prior.
    3. Forward DEMAND feature — AEMO's own forecast TOTALDEMAND per target,
       relative to the recent normal, nudges the ensemble up on heavy-load
       intervals and down on light ones.

    Reserved for the ML model: weather, wind/solar availability, generator bid
    behaviour, quantile outputs.
    """

    name = "ours"
    label = "自研模型"
    color = "#f59e0b"   # amber/gold

    # Ensemble weights, tilted toward recent signals (NEM price levels shift
    # regime fast, so week-old values lag a rising market).
    _W_WEEK1 = 0.20    # T-7d   (weekly seasonality / weekday shape)
    _W_WEEK2 = 0.10    # T-14d
    _W_DAY = 0.30      # T-1d   (yesterday, same time)
    _W_RECENT = 0.40   # median of same hour-of-day over last 7 days (level)

    _AEMO_W = 0.55          # weight on the haircut-corrected AEMO anchor
    _SPIKE_PRIOR = 0.20     # min fraction of above-threshold excess to discount
    _DEMAND_GAIN = 0.25     # sensitivity of the demand nudge
    _DEMAND_CLAMP = (0.85, 1.25)

    def predict(self, con, region, targets, asof=None):
        if not targets:
            return {}
        asof = asof or data.nem_now()
        lo = min(targets) - timedelta(days=15)
        hist = data.fetch_actuals_hh(con, region, lo, asof)
        last = _last_known(hist, asof)

        # Recent same-hour median (fast level) + recent price distribution.
        recent_by_hour: dict[int, float] = {}
        hour_vals: dict[int, list[float]] = {}
        recent_vals: list[float] = []
        cutoff = asof - timedelta(days=7)
        for e, v in hist.items():
            if e > cutoff:
                hour_vals.setdefault(e.hour, []).append(v)
                recent_vals.append(v)
        for h, vals in hour_vals.items():
            vals.sort()
            recent_by_hour[h] = vals[len(vals) // 2]
        base_level = _median(recent_vals) if recent_vals else (last or 0.0)
        # High-price threshold above which AEMO's spike overstatement applies.
        thresh = (_percentile(recent_vals, 0.85)
                  if len(recent_vals) >= 10 else base_level * 2 + 100)

        aemo = data.fetch_aemo_hh(con, region, targets)
        # Backtest/historical anchor: when the live predispatch table no longer
        # holds the forecast, fall back to the recorded day-ahead vintage.
        for t, v in data.fetch_eval_aemo_hh(con, region, targets).items():
            aemo.setdefault(t, v)
        slope = self._haircut_slope(con, region, asof, thresh)

        demand = data.fetch_pred_demand_hh(con, region, targets)
        dem_ref = data.recent_demand_median(con, region, asof)

        out: dict[datetime, float] = {}
        for t in targets:
            comps: list[tuple[float, float]] = []  # (weight, value)
            w1 = hist.get(t - timedelta(days=7))
            w2 = hist.get(t - timedelta(days=14))
            d1 = hist.get(t - timedelta(days=1))
            rh = recent_by_hour.get(t.hour)
            if w1 is not None:
                comps.append((self._W_WEEK1, w1))
            if w2 is not None:
                comps.append((self._W_WEEK2, w2))
            if d1 is not None:
                comps.append((self._W_DAY, d1))
            if rh is not None:
                comps.append((self._W_RECENT, rh))
            if comps:
                tw = sum(w for w, _ in comps)
                blend = sum(w * v for w, v in comps) / tw
            elif last is not None:
                blend = last
            else:
                continue

            # Forward demand nudge on the ensemble component.
            dem = demand.get(t)
            if dem is not None and dem_ref:
                f = 1.0 + self._DEMAND_GAIN * (dem / dem_ref - 1.0)
                f = min(self._DEMAND_CLAMP[1], max(self._DEMAND_CLAMP[0], f))
                blend *= f

            a = aemo.get(t)
            if a is not None:
                excess = max(0.0, a - thresh)          # the spiky part
                a_corr = a - slope * excess            # discount it (CSIRO)
                pred = self._AEMO_W * a_corr + (1 - self._AEMO_W) * blend
            else:
                pred = blend
            out[t] = round(data.clip(pred), 2)
        return out

    def _haircut_slope(self, con, region, asof, thresh) -> float:
        """Fraction of AEMO's above-threshold 'excess' that is overstated,
        learned from recent day-ahead AEMO vintages vs actuals. Floored at a
        small prior (CSIRO: predispatch overstates spikes), capped for safety."""
        start = asof - timedelta(days=21)
        rows = con.execute(
            """SELECT target_datetime, predicted_rrp FROM forecast_eval
               WHERE regionid=? AND model='aemo'
                 AND target_datetime>=? AND target_datetime<=?
                 AND predicted_rrp > ?""",
            (region, data.fmt(start), data.fmt(asof), thresh),
        ).fetchall()
        if len(rows) < 15:
            return self._SPIKE_PRIOR
        actuals = data.fetch_actuals_hh(con, region, start, asof)
        num = den = 0.0
        for t, pred in rows:
            a = actuals.get(data._as_dt(t))
            if a is None:
                continue
            ex = float(pred) - thresh
            if ex > 0:
                num += float(pred) - a   # overstatement (can be negative)
                den += ex
        if den <= 0:
            return self._SPIKE_PRIOR
        return min(0.7, max(self._SPIKE_PRIOR, num / den))


# ── Amber Electric (real third party, optional) ──────────────────────────────

class AmberModel(ForecastModel):
    name = "amber"
    label = "Amber"
    color = "#22c55e"   # green

    _BASE = "https://api.amber.com.au/v1"

    def __init__(self) -> None:
        self._token = os.getenv("AMBER_API_TOKEN", "").strip()
        # Optional explicit site id; otherwise we resolve the first NSW site.
        self._site = os.getenv("AMBER_SITE_ID", "").strip()

    @property
    def enabled(self) -> bool:
        return bool(self._token)

    def predict(self, con, region, targets, asof=None):
        # Amber only forecasts the customer's own site (NSW for this account).
        # Best-effort and non-fatal: any failure just hides the line.
        if not self.enabled or region != "NSW1" or not targets:
            return {}
        try:
            headers = {"Authorization": f"Bearer {self._token}",
                       "Accept": "application/json"}
            with httpx.Client(timeout=20.0, headers=headers) as client:
                site = self._site or self._resolve_site(client)
                if not site:
                    return {}
                # General-channel intervals for the next 24h. We want the
                # forecast (and current) ones; spotPerKwh is the wholesale spot
                # component in CENTS per kWh.
                r = client.get(
                    f"{self._BASE}/sites/{site}/prices/current",
                    params={"next": 48, "resolution": 30},
                )
                r.raise_for_status()
                rows = r.json()
            want = set(targets)
            out: dict[datetime, float] = {}
            for row in rows:
                if row.get("channelType") != "general":
                    continue
                spot = row.get("spotPerKwh")
                end = row.get("endTime") or row.get("nemTime")
                if spot is None or not end:
                    continue
                t = data.half_hour_end(data._as_dt(str(end).replace("Z", "")[:19]))
                # c/kWh → $/MWh: 1 c/kWh = $10/MWh.
                if t in want:
                    out[t] = round(data.clip(float(spot) * 10.0), 2)
            return out
        except Exception as e:  # pragma: no cover - network dependent
            log.warning("Amber forecast failed: %s", e)
            return {}

    def _resolve_site(self, client: httpx.Client) -> str | None:
        """First active site on the account (Amber accounts are single-site for
        most users). Set AMBER_SITE_ID to pin a specific one."""
        r = client.get(f"{self._BASE}/sites")
        r.raise_for_status()
        sites = r.json()
        active = [s for s in sites if (s.get("status") or "active") == "active"]
        chosen = active[0] if active else (sites[0] if sites else None)
        return chosen.get("id") if chosen else None


# ── Reserved: full ML model ──────────────────────────────────────────────────

class MLModel(ForecastModel):
    """Reserved hook for a learned model — lightgbm / quantile regression over
    features (hour, weekday, demand & rooftop-PV forecast, price lags, recent
    volatility). Not implemented in v1 to keep the image slim; the registry and
    forecast_eval schema already accommodate it, so adding it is drop-in."""

    name = "ml"
    label = "ML (预留)"
    color = "#a855f7"

    @property
    def enabled(self) -> bool:
        return False

    def predict(self, con, region, targets, asof=None):
        return {}


# ── Helpers + registry ───────────────────────────────────────────────────────

def _last_known(hist: dict[datetime, float], asof: datetime) -> float | None:
    """Most recent actual at or before `asof` (persistence fallback)."""
    past = [(e, v) for e, v in hist.items() if e <= asof]
    if not past:
        return None
    return max(past, key=lambda kv: kv[0])[1]


def _median(vals: list[float]) -> float:
    if not vals:
        return 0.0
    s = sorted(vals)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def _percentile(vals: list[float], q: float) -> float:
    if not vals:
        return 0.0
    s = sorted(vals)
    i = min(len(s) - 1, max(0, int(round(q * (len(s) - 1)))))
    return s[i]


# Instantiated once; AmberModel reads its token at construction.
_REGISTRY: list[ForecastModel] = [
    AemoModel(),
    ResidualModel(),
    NaiveModel(),
    AmberModel(),
    MLModel(),
]


def all_models() -> list[ForecastModel]:
    return list(_REGISTRY)


def active_models() -> list[ForecastModel]:
    """Models that should appear on the chart / accuracy panel right now."""
    return [m for m in _REGISTRY if m.enabled]


def benchmark() -> ForecastModel:
    for m in _REGISTRY:
        if m.is_benchmark:
            return m
    return _REGISTRY[0]
