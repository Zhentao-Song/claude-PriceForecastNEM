"""BESS revenue backtest — runs the asset over historical RRP data.

Algorithm (per day) — DYNAMIC DISPATCH:
  1. Pull all 5-min RRPs for the region on that day and sort them.
  2. Greedily add discharge intervals (best-price first) and matching charge
     intervals (cheapest first, scaled by 1/√RTE for round-trip losses).
  3. Stop adding intervals the moment the MARGINAL net revenue from one more
     interval falls below the MARGINAL DEGRADATION COST of that MWh cycled.
     This gives the economically-optimal dispatch for each individual day —
     more cycles on high-spread days, fewer (or zero) on flat days.
  4. Apply MLF + aux load losses.
  5. Apply capture efficiency (~0.80) to reflect real autobidder vs
     perfect-foresight benchmark.

Degradation cost default:
  LFP cell replacement cost ≈ $175/kWh pack (2025 estimate) / 5000 cycle
  lifetime = $35/MWh. Exposed as a tunable parameter so the user can plug in
  their actual capex and cycle warranty.

FCAS backtest: unchanged — sum cleared FCAS RRPs × utilisation × annualise.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta

from .db import locked_conn


# ---------------------------------------------------------------------------
# Core per-day optimal dispatch
# ---------------------------------------------------------------------------

def _optimal_dispatch(
    sorted_p: list[float],
    one_way_eff: float,
    mlf: float,
    aux: float,
    capture: float,
    mwh_per_interval: float,
    deg_cost_per_mwh: float,
    max_cycles_per_day: float,
    duration_h: float,
) -> tuple[int, int]:
    """Return (discharge_intervals, charge_intervals) that maximise net daily
    revenue after subtracting marginal degradation cost.

    Uses O(n) prefix-sum approach:
      - Iterate k = 1 … max_each, adding the k-th best sell interval and the
        corresponding charge intervals needed (ceil(k / one_way_eff)).
      - Stop when TOTAL net revenue starts to fall — since prices are
        monotonically ordered the function is concave and the first drop is
        the true optimum.

    Hard cap: discharge_intervals ≤ max_cycles_per_day × duration_h × 12.
    """
    n = len(sorted_p)
    half = n // 2

    max_d_cap = int(round(max_cycles_per_day * duration_h * 12))
    max_d = min(half, max_d_cap)

    if max_d == 0:
        return 0, 0

    best_net = 0.0        # "do nothing" is always an option
    best_k = 0
    best_charge_k = 0

    sell_cumsum = 0.0     # Σ top-k prices (with MLF/aux)
    buy_cumsum = 0.0      # Σ bottom-c prices (with MLF)
    prev_c = 0

    for k in range(1, max_d + 1):
        # k-th sell interval (index from top, zero-based → n-k)
        sell_cumsum += sorted_p[n - k] * mlf * (1.0 - aux)

        # Corresponding charge count (must buy more due to RTE)
        c = int(round(k / one_way_eff))
        c = min(c, half)

        # Add newly required charge intervals
        for ci in range(prev_c, c):
            buy_cumsum += sorted_p[ci] / mlf
        prev_c = c

        # Total net revenue at this dispatch level
        sell_rev = sell_cumsum * mwh_per_interval
        buy_cost = buy_cumsum * mwh_per_interval
        gross = sell_rev - buy_cost
        net = gross * capture - k * mwh_per_interval * deg_cost_per_mwh

        if net >= best_net:
            best_net = net
            best_k = k
            best_charge_k = c
        else:
            # Net is strictly decreasing beyond the optimum (concave function,
            # monotone prices). Allow a tiny 3-interval buffer for numerical
            # flatness at the peak, then stop early.
            if k > best_k + 3:
                break

    return best_k, best_charge_k


# ---------------------------------------------------------------------------
# Energy arbitrage backtest
# ---------------------------------------------------------------------------

def run_energy_backtest(
    region: str,
    power_mw: float,
    duration_h: float,
    rte_pct: float,
    *,
    lookback_days: int = 365,
    capture_efficiency: float = 0.80,
    mlf: float = 0.985,
    aux_load_pct: float = 1.5,
    deg_cost_per_mwh: float = 35.0,
    max_cycles_per_day: float = 2.0,
    fcas_capture: float = 0.70,
) -> dict | None:
    """Backtest a BESS doing energy arbitrage with per-day optimal cycling.

    Also integrates FCAS revenue from idle (non-energy) intervals.

    Returns None when not enough RRP history is available.
    """
    if power_mw <= 0 or duration_h <= 0:
        return None

    one_way_eff = (rte_pct / 100) ** 0.5
    aux = aux_load_pct / 100
    mwh_per_interval = power_mw * (5 / 60)

    nowdt = datetime.utcnow() + timedelta(hours=10)
    cutoff = (nowdt - timedelta(days=lookback_days)).strftime("%Y-%m-%d %H:%M:%S")

    with locked_conn() as con:
        rows = con.execute(
            """
            SELECT settlementdate, rrp,
                COALESCE(raise6sec_rrp,0) + COALESCE(raise60sec_rrp,0) +
                COALESCE(raise5min_rrp,0) + COALESCE(raisereg_rrp,0) + COALESCE(raise1sec_rrp,0) +
                COALESCE(lower6sec_rrp,0) + COALESCE(lower60sec_rrp,0) +
                COALESCE(lower5min_rrp,0) + COALESCE(lowerreg_rrp,0) + COALESCE(lower1sec_rrp,0)
                AS total_fcas_rrp
            FROM nem_dispatch_price
            WHERE regionid = ? AND settlementdate >= ? AND rrp IS NOT NULL
            """,
            (region, cutoff),
        ).fetchall()
    if not rows:
        return None

    # Group by date — pairs of (rrp, fcas_total)
    by_day: dict[str, list[tuple[float, float]]] = defaultdict(list)
    for ts, rrp, fcas_total in rows:
        by_day[str(ts)[:10]].append((float(rrp), float(fcas_total or 0)))

    # Per-day backtest
    daily_results: list[dict] = []
    monthly_agg: dict[str, dict] = defaultdict(lambda: {
        "energy_revenue_aud": 0.0, "discharge_mwh": 0.0,
        "charge_cost_aud": 0.0, "n_days": 0, "best_spread": 0.0,
    })

    n_active_days = 0
    n_positive_days = 0
    n_idle_days = 0          # days where optimal dispatch = 0 (too flat)
    best_day: dict = {"date": None, "revenue": float("-inf")}
    worst_day: dict = {"date": None, "revenue": float("inf")}

    # Waterfall accumulators
    sum_gross_revenue = 0.0
    sum_after_rte = 0.0
    sum_after_mlf_aux = 0.0
    sum_after_capture = 0.0
    sum_discharge_mwh = 0.0
    sum_gross_daily_spread = 0.0
    n_spread_days = 0

    # Cycle stats
    sum_cycles_per_day = 0.0   # accumulated implied cycles (for mean)
    cycle_hist: dict[str, int] = defaultdict(int)  # "0.5" → n_days bucket

    # FCAS accumulators
    sum_fcas_revenue = 0.0
    sum_fcas_raw_per_mw_yr = 0.0  # annualized market FCAS $/MW/yr (raw, before capture)
    n_idle_intervals_total = 0
    n_active_days_for_fcas = 0

    for day, day_data in by_day.items():
        if len(day_data) < 24:
            continue

        # Sort by RRP, keep FCAS values paired
        sorted_data = sorted(day_data, key=lambda x: x[0])
        sorted_p = [x[0] for x in sorted_data]
        sorted_f = [x[1] for x in sorted_data]
        n = len(sorted_p)

        discharge_intervals, charge_intervals = _optimal_dispatch(
            sorted_p, one_way_eff, mlf, aux,
            capture_efficiency, mwh_per_interval,
            deg_cost_per_mwh, max_cycles_per_day, duration_h,
        )

        if discharge_intervals == 0:
            n_idle_days += 1
            # Still counts as an active (observed) day for annualisation
            n_active_days += 1
            # All intervals are idle for FCAS
            fcas_rev = sum(sorted_f) * mwh_per_interval * mlf * fcas_capture
            sum_fcas_revenue += fcas_rev
            sum_fcas_raw_per_mw_yr += sum(sorted_f) * (5 / 60)
            n_idle_intervals_total += n
            n_active_days_for_fcas += 1
            daily_results.append({
                "date": day,
                "revenue_aud": 0,
                "discharge_mwh": 0.0,
                "implied_spread": 0.0,
                "cycles": 0.0,
                "fcas_revenue_aud": round(fcas_rev, 0),
            })
            continue

        top_prices    = sorted_p[-discharge_intervals:]
        bottom_prices = sorted_p[:charge_intervals]

        # Implied cycles for this day
        cycles_today = discharge_intervals / (duration_h * 12)
        sum_cycles_per_day += cycles_today
        bucket = f"{round(cycles_today * 2) / 2:.1f}"  # round to 0.5
        cycle_hist[bucket] += 1

        # ── Waterfall haircuts ────────────────────────────────────────────
        top_avg    = sum(top_prices) / len(top_prices)
        bottom_avg = sum(bottom_prices) / len(bottom_prices)

        # 1) GROSS (symmetric, no RTE multiplier on charge side)
        raw_rev = discharge_intervals * mwh_per_interval * (top_avg - bottom_avg)
        sum_gross_daily_spread += (top_avg - bottom_avg)
        n_spread_days += 1

        # 2) AFTER RTE (extra charge MWh due to round-trip loss)
        rte_charge_extra_mwh = (charge_intervals - discharge_intervals) * mwh_per_interval
        after_rte = raw_rev - rte_charge_extra_mwh * bottom_avg

        # 3) AFTER MLF + aux
        discharge_rev_mlf = sum(top_prices) * mwh_per_interval * mlf * (1 - aux)
        charge_cost_mlf   = sum(bottom_prices) * mwh_per_interval / mlf
        after_mlf_aux = discharge_rev_mlf - charge_cost_mlf

        # 4) AFTER CAPTURE (real autobidder vs perfect foresight)
        net_rev = after_mlf_aux * capture_efficiency

        # ── FCAS from idle (non-energy) intervals ─────────────────────────
        # Middle intervals [charge_k : n - discharge_k] not used for energy
        idle_fcas_slice = sorted_f[charge_intervals : n - discharge_intervals]
        n_idle_today = len(idle_fcas_slice)
        fcas_rev = sum(idle_fcas_slice) * mwh_per_interval * mlf * fcas_capture
        sum_fcas_revenue += fcas_rev
        sum_fcas_raw_per_mw_yr += sum(idle_fcas_slice) * (5 / 60)
        n_idle_intervals_total += n_idle_today
        n_active_days_for_fcas += 1

        # ── Accumulators ─────────────────────────────────────────────────
        sum_gross_revenue  += raw_rev
        sum_after_rte      += after_rte
        sum_after_mlf_aux  += after_mlf_aux
        sum_after_capture  += net_rev
        discharge_mwh       = discharge_intervals * mwh_per_interval
        sum_discharge_mwh  += discharge_mwh
        charge_cost         = charge_cost_mlf

        n_active_days += 1
        if net_rev > 0:
            n_positive_days += 1
        if net_rev > best_day["revenue"]:
            best_day = {"date": day, "revenue": round(net_rev, 0)}
        if net_rev < worst_day["revenue"]:
            worst_day = {"date": day, "revenue": round(net_rev, 0)}

        month = day[:7]
        m = monthly_agg[month]
        m["energy_revenue_aud"] += net_rev
        m["discharge_mwh"]      += discharge_mwh
        m["charge_cost_aud"]    += charge_cost
        m["n_days"]             += 1
        spread = top_avg - bottom_avg
        if spread > m["best_spread"]:
            m["best_spread"] = spread

        daily_results.append({
            "date":          day,
            "revenue_aud":   round(net_rev, 0),
            "discharge_mwh": round(discharge_mwh, 1),
            "implied_spread": round(spread, 1),
            "cycles":        round(cycles_today, 2),
            "fcas_revenue_aud": round(fcas_rev, 0),
        })

    if not daily_results:
        return None

    # Annualise: scale by 365 / n_active_days
    total_rev          = sum(d["revenue_aud"] for d in daily_results)
    total_fcas_rev     = sum(d["fcas_revenue_aud"] for d in daily_results)
    total_discharge_mwh = sum(d["discharge_mwh"] for d in daily_results)
    annual_rev         = total_rev * 365 / n_active_days
    annual_fcas_rev    = total_fcas_rev * 365 / n_active_days
    annual_discharge_mwh = total_discharge_mwh * 365 / n_active_days
    implied_spread     = annual_rev / annual_discharge_mwh if annual_discharge_mwh > 0 else 0

    # Mean FCAS raw $/MW/yr (annualised, before capture)
    mean_fcas_per_mwh_yr = (sum_fcas_raw_per_mw_yr * 365 / max(n_active_days_for_fcas, 1)) if n_active_days_for_fcas > 0 else 0

    # Mean idle intervals per day (for UI note)
    mean_idle_intervals = n_idle_intervals_total / max(n_active_days_for_fcas, 1) if n_active_days_for_fcas > 0 else 0

    # Mean implied cycles/day (excluding idle days to avoid deflating)
    n_dispatching = n_active_days - n_idle_days
    mean_cycles   = sum_cycles_per_day / max(n_dispatching, 1)

    denom = sum_discharge_mwh or 1
    haircuts = {
        "gross_market_spread_per_mwh":  round(sum_gross_revenue / denom, 1),
        "after_rte_per_mwh":            round(sum_after_rte / denom, 1),
        "after_mlf_aux_per_mwh":        round(sum_after_mlf_aux / denom, 1),
        "after_capture_per_mwh":        round(sum_after_capture / denom, 1),
        "mean_daily_top_minus_bottom":  round(sum_gross_daily_spread / max(n_spread_days, 1), 1),
        "rte_loss_pct":     round(100 * (sum_gross_revenue - sum_after_rte)   / max(sum_gross_revenue, 1e-9), 1),
        "mlf_aux_loss_pct": round(100 * (sum_after_rte   - sum_after_mlf_aux) / max(sum_after_rte,    1e-9), 1),
        "capture_loss_pct": round(100 * (sum_after_mlf_aux - sum_after_capture)/ max(sum_after_mlf_aux,1e-9), 1),
    }

    monthly = [
        {"month": mo, **{k: round(v, 0) if k != "n_days" else int(v) for k, v in vals.items()}}
        for mo, vals in sorted(monthly_agg.items())
    ]

    return {
        "annual_revenue_aud":           round(annual_rev, 0),
        "annual_fcas_revenue_aud":      round(annual_fcas_rev, 0),
        "annual_combined_revenue_aud":  round(annual_rev + annual_fcas_rev, 0),
        "mean_fcas_per_mwh_yr":         round(mean_fcas_per_mwh_yr, 0),
        "mean_idle_intervals_per_day":  round(mean_idle_intervals, 1),
        "implied_spread_per_mwh":       round(implied_spread, 1),
        "annual_discharge_mwh":         round(annual_discharge_mwh, 0),
        "capture_efficiency":           capture_efficiency,
        "fcas_capture":                 fcas_capture,
        "deg_cost_per_mwh":             deg_cost_per_mwh,
        "mean_cycles_per_day":          round(mean_cycles, 2),
        "max_cycles_per_day":           max_cycles_per_day,
        "n_days_backtested":            n_active_days,
        "n_days_positive":              n_positive_days,
        "n_days_idle":                  n_idle_days,
        "cycle_histogram":              dict(sorted(cycle_hist.items())),
        "best_day":                     best_day,
        "worst_day":                    worst_day,
        "monthly":                      monthly,
        "mlf_applied":                  mlf,
        "haircuts":                     haircuts,
        "daily_results":                daily_results,
    }


# ---------------------------------------------------------------------------
# FCAS backtest (unchanged)
# ---------------------------------------------------------------------------

def run_fcas_backtest(
    region: str,
    power_mw: float,
    *,
    lookback_days: int = 365,
    utilisation: float = 0.35,
) -> dict | None:
    """Backtest FCAS revenue: sum cleared FCAS RRPs across the window,
    apply utilisation factor, annualise.
    """
    if power_mw <= 0:
        return None
    nowdt = datetime.utcnow() + timedelta(hours=10)
    cutoff = (nowdt - timedelta(days=lookback_days)).strftime("%Y-%m-%d %H:%M:%S")
    fcas_cols = ["raise6sec_rrp", "raise60sec_rrp", "raise5min_rrp",
                  "raisereg_rrp", "raise1sec_rrp",
                  "lower6sec_rrp", "lower60sec_rrp", "lower5min_rrp",
                  "lowerreg_rrp", "lower1sec_rrp"]
    col_select = ", ".join(f"COALESCE({c}, 0)" for c in fcas_cols)
    with locked_conn() as con:
        rows = con.execute(
            f"""
            SELECT settlementdate, {col_select}
            FROM nem_dispatch_price
            WHERE regionid = ? AND settlementdate >= ?
            """,
            (region, cutoff),
        ).fetchall()
    if not rows:
        return None

    market_per_mw_yr: dict[str, float] = defaultdict(float)
    monthly_per_mw: dict[str, float] = defaultdict(float)
    by_day: set = set()

    for r in rows:
        ts = r[0]
        prices = [float(p or 0) for p in r[1:]]
        day = str(ts)[:10]
        month = day[:7]
        by_day.add(day)
        per_mw_interval = sum(prices) * (5 / 60)
        monthly_per_mw[month] += per_mw_interval
        for i, p in enumerate(prices):
            market_per_mw_yr[fcas_cols[i].replace("_rrp", "").upper()] += p * (5 / 60)

    n_days = len(by_day)
    if n_days == 0:
        return None

    total_per_mw_window = sum(monthly_per_mw.values())
    raw_per_mw_year = total_per_mw_window * 365 / n_days
    annual_revenue = raw_per_mw_year * power_mw * utilisation

    by_market_per_mw_year = {
        k: round(v * 365 / n_days, 0) for k, v in market_per_mw_yr.items()
    }

    monthly = []
    for mo in sorted(monthly_per_mw):
        per_mw = monthly_per_mw[mo]
        monthly.append({
            "month": mo,
            "fcas_revenue_aud": round(per_mw * power_mw * utilisation, 0),
            "per_mw_window": round(per_mw, 0),
        })

    return {
        "annual_revenue_aud":     round(annual_revenue, 0),
        "per_mw_year_after_util": round(raw_per_mw_year * utilisation, 0),
        "raw_per_mw_year":        round(raw_per_mw_year, 0),
        "utilisation":            utilisation,
        "n_days_backtested":      n_days,
        "by_market_per_mw_year":  by_market_per_mw_year,
        "monthly":                monthly,
    }


# ---------------------------------------------------------------------------
# Combined entry point
# ---------------------------------------------------------------------------

def run_full_backtest(
    region: str,
    power_mw: float,
    duration_h: float,
    rte_pct: float = 88.0,
    mlf: float = 0.985,
    aux_load_pct: float = 1.5,
    lookback_days: int = 365,
    capture_efficiency: float = 0.80,
    fcas_utilisation: float = 0.35,
    fcas_capture: float = 0.70,
    deg_cost_per_mwh: float = 35.0,
    max_cycles_per_day: float = 2.0,
) -> dict:
    """Energy + FCAS backtest combined into one response.

    The integrated FCAS (from idle intervals in run_energy_backtest) is the
    primary FCAS result. The legacy run_fcas_backtest is kept for backward
    compatibility but annual_total_revenue_aud uses the integrated result.
    """
    energy = run_energy_backtest(
        region, power_mw, duration_h, rte_pct,
        lookback_days=lookback_days,
        capture_efficiency=capture_efficiency,
        mlf=mlf, aux_load_pct=aux_load_pct,
        deg_cost_per_mwh=deg_cost_per_mwh,
        max_cycles_per_day=max_cycles_per_day,
        fcas_capture=fcas_capture,
    )
    fcas = run_fcas_backtest(
        region, power_mw,
        lookback_days=lookback_days,
        utilisation=fcas_utilisation,
    )
    # Use integrated FCAS from energy result as the primary combined total
    integrated_fcas_rev = energy["annual_fcas_revenue_aud"] if energy else 0
    return {
        "region": region,
        "spec": {
            "power_mw": power_mw, "duration_h": duration_h,
            "rte_pct": rte_pct,
            "deg_cost_per_mwh": deg_cost_per_mwh,
            "max_cycles_per_day": max_cycles_per_day,
            "mlf": mlf,
        },
        "lookback_days": lookback_days,
        "capture_efficiency": capture_efficiency,
        "fcas_utilisation": fcas_utilisation,
        "fcas_capture": fcas_capture,
        "energy": energy,
        "fcas": fcas,
        "annual_total_revenue_aud": round(
            (energy["annual_combined_revenue_aud"] if energy else 0), 0),
    }
