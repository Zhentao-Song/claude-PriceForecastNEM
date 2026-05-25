"""WDR (Wholesale Demand Response) baseline calculator.

The DRSP settlement formula under NER 3.8.2A pays a participant for
*demonstrated* load reduction:

    revenue = (baseline_MW − actual_MW) × RRP × hours × MLF

Where `baseline_MW` is the participant's expected consumption ABSENT the
dispatch event — the counterfactual. Real platforms use one of several
baseline methods:

  * **LBL_N10**       — Load Before Load, average of the last 10 SAME
                        weekday non-event observations at this minute.
                        AEMO's reference method.
  * **HIGH_4OF5**     — Highest 4 of the last 5 non-event days. Skews
                        baseline UP so participant gets paid more;
                        common in PJM / ISO-NE.
  * **WEATHER_REG**   — Regression-adjusted baseline using temperature
                        as a covariate. Most accurate, hardest to audit.

For OUR paper sim we don't have customer telemetry history. We compute
a SYNTHETIC baseline from the resource's diurnal occupancy curve and
nameplate — i.e. "this is what this site would normally be consuming at
this time of day". The calculation is deterministic + parameterised so
the front-end can show the curve and the user can compare against actual
dispatch.

When real telemetry feeds are wired in, the only change is to replace
`_synthetic_baseline_kw` with a query against historical actuals.
"""
from __future__ import annotations

import math
from datetime import datetime
from typing import Optional


# Map portfolio `baseline_method` strings to internal computation IDs.
SUPPORTED_METHODS = {"LBL_N10", "HIGH_4OF5", "WEATHER_REG"}


def _ev_occupancy_factor(h_local: float, window_start: int, window_end: int) -> float:
    """Same diurnal curve the telemetry simulator uses — keep them in
    lock-step so 'baseline' looks like 'typical'."""
    if window_start < window_end:
        in_window = window_start <= h_local < window_end
        if not in_window: return 0.05
        mid = (window_start + window_end) / 2
        half_width = (window_end - window_start) / 2
        rel = (h_local - mid) / max(half_width, 1)
        return 0.25 + 0.65 * max(0.0, math.cos(rel * math.pi / 2)) ** 2
    else:
        in_window = h_local >= window_start or h_local < window_end
        if not in_window: return 0.05
        if h_local >= window_start:
            adj = h_local - window_start
        else:
            adj = (24 - window_start) + h_local
        width = (24 - window_start) + window_end
        mid = width / 2
        rel = (adj - mid) / max(mid, 1)
        return 0.30 + 0.60 * max(0.0, math.cos(rel * math.pi / 2)) ** 2


def _synthetic_baseline_kw(resource: dict, target_dt: datetime) -> float:
    """Counterfactual consumption (kW) for this resource at this time,
    ABSENT any VPP dispatch event. Used by all baseline methods as the
    underlying "actual" since we don't have customer meter data.

    Only meaningful for resources that consume energy by default:
        * EV chargers — consume to charge vehicles
        * (BESS doesn't have a "default consumption" — it sits at SoC
          target; we return 0 since BESS is settled directly via
          energy market, not WDR)
    """
    if resource.get("kind") != "evcharger":
        return 0.0
    h_local = target_dt.hour + target_dt.minute / 60.0
    occ = _ev_occupancy_factor(
        h_local, int(resource.get("window_start_hr") or 0),
        int(resource.get("window_end_hr") or 24),
    )
    # Nameplate × occupancy = what they're "normally" drawing at this minute.
    return float(resource.get("nameplate_kw") or 0) * occ


def compute_baseline_kw(
    resource: dict,
    target_dt: datetime,
    method: str = "LBL_N10",
    *,
    samples: Optional[list[float]] = None,
) -> tuple[float, dict]:
    """Compute the WDR baseline (kW) for one resource at one interval.

    Returns `(baseline_kw, metadata)` where metadata contains debugging
    info shown in the UI tooltip — what method was used, how many
    samples informed it, etc.

    `samples` is an optional list of historical actual-kW observations
    at the same minute-of-day across the lookback window. If omitted, we
    derive samples from `_synthetic_baseline_kw` + small daily noise so
    methods produce different numbers (otherwise they'd all collapse to
    the same synthetic value).
    """
    method = method.upper()
    if method not in SUPPORTED_METHODS:
        method = "LBL_N10"

    base_synth = _synthetic_baseline_kw(resource, target_dt)
    # Fabricate a sample set if not provided — N=10 days of similar
    # observations with ±10% noise. Real impl: pull last N matching days
    # from `vpp_resource_telemetry` (when that table exists).
    if samples is None:
        # Deterministic noise from a seeded sequence so values are stable
        # across requests (avoid the UI jiggling on every refresh).
        seed = hash((resource.get("resource_id"), target_dt.hour, target_dt.minute)) % 10_000
        noise = [(((seed + i * 37) % 200) - 100) / 1000.0 for i in range(10)]
        samples = [max(0.0, base_synth * (1 + n)) for n in noise]

    if method == "LBL_N10":
        if not samples: return 0.0, {"method": method, "samples": 0}
        avg = sum(samples) / len(samples)
        return avg, {"method": method, "samples": len(samples), "raw_avg": round(avg, 1)}

    if method == "HIGH_4OF5":
        # Top 4 of the last 5 days
        recent = sorted(samples[-5:], reverse=True)[:4]
        if not recent: return 0.0, {"method": method, "samples": 0}
        avg = sum(recent) / len(recent)
        return avg, {"method": method, "samples": len(recent), "raw_avg": round(avg, 1)}

    if method == "WEATHER_REG":
        # Regression-adjusted: not implemented; fall back to LBL with a
        # tiny upward bias to differentiate visually.
        if not samples: return 0.0, {"method": method, "samples": 0, "note": "fallback"}
        avg = sum(samples) / len(samples)
        adjusted = avg * 1.05
        return adjusted, {"method": method, "samples": len(samples),
                          "raw_avg": round(avg, 1), "adjustment": "+5% temp bias (stub)"}

    return 0.0, {"method": method, "samples": 0, "error": "unknown"}


def wdr_revenue(
    resource: dict, baseline_kw: float, dispatched_kw: float,
    rrp: float, mlf: float = 1.0, interval_min: int = 5,
) -> float:
    """WDR settlement: payment for delivered curtailment.

    The participant bid `dispatched_kw` as their committed reduction.
    AEMO pays them at RRP × MWh × MLF where MWh = dispatched_kw × hours.
    Real DRSPs settle the LESSER of (baseline − actual) and (committed),
    but in our paper sim we trust the dispatch number directly.
    """
    if baseline_kw <= 0 or dispatched_kw <= 0:
        return 0.0
    # Cap dispatched at baseline (can't curtail more than what you'd
    # normally use). Mirrors AEMO's verifiable-reduction check.
    actual_reduction_kw = min(dispatched_kw, baseline_kw)
    hours = interval_min / 60.0
    return (actual_reduction_kw / 1000.0) * rrp * hours * mlf
