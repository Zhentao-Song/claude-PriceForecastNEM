"""Auditable BESS revenue backtests over historical NEM prices.

Energy is solved chronologically for each complete NEM day.  The optimiser
enforces power, state-of-charge, round-trip efficiency, a cyclic daily SOC,
and a daily equivalent-cycle limit.  Reported energy revenue is *net* of the
configured capture haircut and marginal degradation cost.

This module now handles energy only.  FCAS revenue is calculated separately
from DUID-level DISPATCHLOAD enablement in ``bess_benchmarks``; the former
regional-price-times-utilisation proxy has been removed.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta
from functools import wraps
import logging
from threading import Lock

from scipy.optimize import Bounds, LinearConstraint, linprog, milp
from scipy.sparse import lil_matrix

from .db import locked_conn


INTERVAL_HOURS = 5.0 / 60.0
# NEM dispatch days contain exactly 288 five-minute intervals (market time is
# fixed AEST).  For an accuracy backtest, do not compress days with gaps into
# a shorter artificial chronology: exclude anything other than 288 rows.
COMPLETE_DAY_INTERVALS = 288
_ENERGY_BACKTEST_LOCK = Lock()
# Four independent days per sparse model is materially faster than hundreds
# of one-day solver startups, while avoiding the poor scaling of very large
# block-diagonal HiGHS models on the lightweight local runtime.
ENERGY_BATCH_DAYS = 4
_SOLVER_RETRIES = 1
logger = logging.getLogger(__name__)


def _serialised_energy_backtest(func):
    """Keep HiGHS runs serial inside the API worker.

    SciPy/HiGHS is CPU-bound and the UI can request defaults, finance and a
    365-day backtest at nearly the same time.  Serialising whole energy runs
    prevents concurrent solver pools from saturating the machine or stalling
    localhost after a reload.
    """
    @wraps(func)
    def wrapped(*args, **kwargs):
        with _ENERGY_BACKTEST_LOCK:
            return func(*args, **kwargs)
    return wrapped


def _pct_reduction(before: float, after: float) -> float:
    """Signed percentage reduction; negative means the next step added value."""
    if abs(before) < 1e-9:
        return 0.0
    return 100.0 * (before - after) / abs(before)


def _summarise_dispatch(
    prices: list[float],
    charge: list[float],
    discharge: list[float],
    soc: list[float],
    *,
    energy_mwh: float,
    mlf: float,
    aux: float,
    capture: float,
    deg_cost_per_mwh: float,
) -> dict:
    """Calculate the auditable revenue waterfall for one solved day."""
    n = len(prices)
    charge_mwh = sum(charge) * INTERVAL_HOURS
    discharge_mwh = sum(discharge) * INTERVAL_HOURS
    sell_raw = sum(discharge[t] * prices[t] * INTERVAL_HOURS for t in range(n))
    buy_raw = sum(charge[t] * prices[t] * INTERVAL_HOURS for t in range(n))
    sell_settled = sum(
        discharge[t] * prices[t] * mlf * (1.0 - aux) * INTERVAL_HOURS
        for t in range(n)
    )
    buy_settled = sum(
        charge[t] * prices[t] / mlf * INTERVAL_HOURS for t in range(n)
    )

    sell_avg = sell_raw / discharge_mwh if discharge_mwh > 1e-9 else 0.0
    buy_avg = buy_raw / charge_mwh if charge_mwh > 1e-9 else 0.0
    gross_spread_revenue = discharge_mwh * (sell_avg - buy_avg)
    after_rte_revenue = sell_raw - buy_raw
    after_mlf_aux_revenue = sell_settled - buy_settled
    captured_market_revenue = after_mlf_aux_revenue * capture
    degradation_cost = discharge_mwh * deg_cost_per_mwh
    net_revenue = captured_market_revenue - degradation_cost

    return {
        "charge_mw": charge,
        "discharge_mw": discharge,
        "soc_mwh": soc,
        "charge_mwh": charge_mwh,
        "discharge_mwh": discharge_mwh,
        "cycles": discharge_mwh / energy_mwh if energy_mwh > 0 else 0.0,
        "sell_revenue_raw": sell_raw,
        "charge_cost_raw": buy_raw,
        "charge_cost_settled": buy_settled,
        "gross_spread_revenue": gross_spread_revenue,
        "after_rte_revenue": after_rte_revenue,
        "after_mlf_aux_revenue": after_mlf_aux_revenue,
        "captured_market_revenue": captured_market_revenue,
        "degradation_cost": degradation_cost,
        "net_revenue": net_revenue,
        "sell_avg": sell_avg,
        "buy_avg": buy_avg,
    }


def _optimise_day_milp(
    prices: list[float],
    power_mw: float,
    energy_mwh: float,
    rte_pct: float,
    *,
    mlf: float,
    aux: float,
    capture: float,
    deg_cost_per_mwh: float,
    max_cycles_per_day: float,
    initial_soc_fraction: float,
) -> dict:
    """Exact fallback that forbids simultaneous charge and discharge.

    The continuous LP is exact for ordinary price paths, but at sufficiently
    negative prices its relaxation can profit from artificial simultaneous
    charging and discharging.  A binary mode variable is only invoked for a
    day where the LP actually exhibits that behaviour, keeping the normal
    year-long backtest fast while enforcing physical dispatch in edge cases.
    """
    n = len(prices)
    eta = (rte_pct / 100.0) ** 0.5
    initial_soc = energy_mwh * initial_soc_fraction
    n_vars = 4 * n  # charge, discharge, SOC, binary charge-mode

    objective = [0.0] * n_vars
    a_eq = lil_matrix((n + 1, n_vars))
    b_eq = [0.0] * (n + 1)
    a_ub = lil_matrix((2 * n + 1, n_vars))
    b_ub = [0.0] * (2 * n) + [max_cycles_per_day * energy_mwh]

    for t, price in enumerate(prices):
        objective[t] = capture * price / mlf * INTERVAL_HOURS
        objective[n + t] = (
            -capture * price * mlf * (1.0 - aux) * INTERVAL_HOURS
            + deg_cost_per_mwh * INTERVAL_HOURS
        )

        a_eq[t, 2 * n + t] = 1.0
        if t > 0:
            a_eq[t, 2 * n + t - 1] = -1.0
        a_eq[t, t] = -eta * INTERVAL_HOURS
        a_eq[t, n + t] = INTERVAL_HOURS / eta
        b_eq[t] = initial_soc if t == 0 else 0.0

        # z=1 permits charge and blocks discharge; z=0 does the reverse.
        a_ub[2 * t, t] = 1.0
        a_ub[2 * t, 3 * n + t] = -power_mw
        a_ub[2 * t + 1, n + t] = 1.0
        a_ub[2 * t + 1, 3 * n + t] = power_mw
        b_ub[2 * t + 1] = power_mw
        a_ub[2 * n, n + t] = INTERVAL_HOURS

    a_eq[n, 3 * n - 1] = 1.0
    b_eq[n] = initial_soc

    result = milp(
        c=objective,
        integrality=[0] * (3 * n) + [1] * n,
        bounds=Bounds(
            [0.0] * n_vars,
            [power_mw] * (2 * n) + [energy_mwh] * n + [1.0] * n,
        ),
        constraints=(
            LinearConstraint(a_eq.tocsr(), b_eq, b_eq),
            LinearConstraint(a_ub.tocsr(), [float("-inf")] * (2 * n + 1), b_ub),
        ),
        options={"time_limit": 60.0},
    )
    if not result.success:
        raise RuntimeError(f"BESS daily complementarity optimisation failed: {result.message}")

    charge = [0.0 if abs(v) < 1e-7 else float(v) for v in result.x[:n]]
    discharge = [0.0 if abs(v) < 1e-7 else float(v) for v in result.x[n:2 * n]]
    soc = [float(v) for v in result.x[2 * n:3 * n]]
    solved = _summarise_dispatch(
        prices,
        charge,
        discharge,
        soc,
        energy_mwh=energy_mwh,
        mlf=mlf,
        aux=aux,
        capture=capture,
        deg_cost_per_mwh=deg_cost_per_mwh,
    )
    solved["used_milp_complementarity"] = True
    return solved


def _optimise_days(
    day_prices: list[tuple[str, list[float]]],
    power_mw: float,
    energy_mwh: float,
    rte_pct: float,
    *,
    mlf: float,
    aux: float,
    capture: float,
    deg_cost_per_mwh: float,
    max_cycles_per_day: float,
    initial_soc_fraction: float = 0.5,
) -> dict[str, dict]:
    """Solve independent chronological days in one sparse HiGHS model.

    Each day retains its own cyclic SOC and cycle-cap constraints.  Batching
    removes hundreds of solver-startup calls without changing the mathematical
    result or allowing energy to cross day boundaries.
    """
    if not day_prices or any(not prices for _, prices in day_prices):
        raise ValueError("day_prices must contain non-empty price series")

    n_days = len(day_prices)
    total_n = sum(len(prices) for _, prices in day_prices)
    n_vars = 3 * total_n
    eta = (rte_pct / 100.0) ** 0.5
    initial_soc = energy_mwh * initial_soc_fraction

    objective = [0.0] * n_vars
    a_eq = lil_matrix((total_n + n_days, n_vars))
    b_eq = [0.0] * (total_n + n_days)
    a_ub = lil_matrix((total_n + n_days, n_vars))
    b_ub = [power_mw] * total_n + [max_cycles_per_day * energy_mwh] * n_days

    offsets: list[tuple[str, list[float], int, int]] = []
    offset = 0
    for day_index, (day, prices) in enumerate(day_prices):
        end = offset + len(prices)
        offsets.append((day, prices, offset, end))
        for local_t, price in enumerate(prices):
            t = offset + local_t
            objective[t] = capture * price / mlf * INTERVAL_HOURS
            objective[total_n + t] = (
                -capture * price * mlf * (1.0 - aux) * INTERVAL_HOURS
                + deg_cost_per_mwh * INTERVAL_HOURS
            )

            a_eq[t, 2 * total_n + t] = 1.0
            if local_t > 0:
                a_eq[t, 2 * total_n + t - 1] = -1.0
            a_eq[t, t] = -eta * INTERVAL_HOURS
            a_eq[t, total_n + t] = INTERVAL_HOURS / eta
            b_eq[t] = initial_soc if local_t == 0 else 0.0

            a_ub[t, t] = 1.0
            a_ub[t, total_n + t] = 1.0
            a_ub[total_n + day_index, total_n + t] = INTERVAL_HOURS

        a_eq[total_n + day_index, 2 * total_n + end - 1] = 1.0
        b_eq[total_n + day_index] = initial_soc
        offset = end

    result = linprog(
        objective,
        A_ub=a_ub.tocsr(),
        b_ub=b_ub,
        A_eq=a_eq.tocsr(),
        b_eq=b_eq,
        bounds=(
            [(0.0, power_mw)] * (2 * total_n)
            + [(0.0, energy_mwh)] * total_n
        ),
        method="highs",
    )
    if not result.success:
        raise RuntimeError(f"BESS batched dispatch optimisation failed: {result.message}")

    solved: dict[str, dict] = {}
    for day, prices, start, end in offsets:
        charge = [
            0.0 if abs(v) < 1e-7 else float(v)
            for v in result.x[start:end]
        ]
        discharge = [
            0.0 if abs(v) < 1e-7 else float(v)
            for v in result.x[total_n + start:total_n + end]
        ]
        soc = [float(v) for v in result.x[2 * total_n + start:2 * total_n + end]]
        solved[day] = _summarise_dispatch(
            prices,
            charge,
            discharge,
            soc,
            energy_mwh=energy_mwh,
            mlf=mlf,
            aux=aux,
            capture=capture,
            deg_cost_per_mwh=deg_cost_per_mwh,
        )
        if any(
            charge_mw > 1e-6 and discharge_mw > 1e-6
            for charge_mw, discharge_mw in zip(charge, discharge)
        ):
            solved[day] = _optimise_day_milp(
                prices,
                power_mw,
                energy_mwh,
                rte_pct,
                mlf=mlf,
                aux=aux,
                capture=capture,
                deg_cost_per_mwh=deg_cost_per_mwh,
                max_cycles_per_day=max_cycles_per_day,
                initial_soc_fraction=initial_soc_fraction,
            )
        else:
            solved[day]["used_milp_complementarity"] = False
    return solved


def _optimise_days_resilient(
    day_prices: list[tuple[str, list[float]]],
    power_mw: float,
    energy_mwh: float,
    rte_pct: float,
    *,
    mlf: float,
    aux: float,
    capture: float,
    deg_cost_per_mwh: float,
    max_cycles_per_day: float,
    initial_soc_fraction: float = 0.5,
) -> dict[str, dict]:
    """Solve a batch with exact retries and progressively smaller fallbacks.

    HiGHS can very occasionally return an ``Unknown`` status for an otherwise
    valid sparse batch.  Retrying is safe because the model is deterministic.
    If the batch remains unstable, splitting it preserves the same independent
    daily constraints.  A repeatedly failing single-day LP finally falls back
    to the exact complementarity MILP instead of failing the annual backtest.
    """
    if not day_prices:
        return {}

    kwargs = {
        "mlf": mlf,
        "aux": aux,
        "capture": capture,
        "deg_cost_per_mwh": deg_cost_per_mwh,
        "max_cycles_per_day": max_cycles_per_day,
        "initial_soc_fraction": initial_soc_fraction,
    }
    last_error: RuntimeError | None = None
    for attempt in range(_SOLVER_RETRIES + 1):
        try:
            return _optimise_days(
                day_prices,
                power_mw,
                energy_mwh,
                rte_pct,
                **kwargs,
            )
        except RuntimeError as exc:
            last_error = exc
            logger.warning(
                "BESS dispatch solve failed for %d day(s), attempt %d/%d: %s",
                len(day_prices),
                attempt + 1,
                _SOLVER_RETRIES + 1,
                exc,
            )

    if len(day_prices) > 1:
        midpoint = len(day_prices) // 2
        solved = _optimise_days_resilient(
            day_prices[:midpoint],
            power_mw,
            energy_mwh,
            rte_pct,
            **kwargs,
        )
        solved.update(_optimise_days_resilient(
            day_prices[midpoint:],
            power_mw,
            energy_mwh,
            rte_pct,
            **kwargs,
        ))
        return solved

    day, prices = day_prices[0]
    logger.warning(
        "BESS daily LP remained unavailable for %s; using exact MILP fallback",
        day,
    )
    try:
        return {day: _optimise_day_milp(
            prices,
            power_mw,
            energy_mwh,
            rte_pct,
            **kwargs,
        )}
    except RuntimeError as milp_error:
        raise RuntimeError(
            "BESS dispatch optimisation failed after retry, batch splitting, "
            f"and exact daily fallback; LP error: {last_error}; "
            f"MILP error: {milp_error}"
        ) from milp_error


def _optimise_day(
    prices: list[float],
    power_mw: float,
    energy_mwh: float,
    rte_pct: float,
    *,
    mlf: float,
    aux: float,
    capture: float,
    deg_cost_per_mwh: float,
    max_cycles_per_day: float,
    initial_soc_fraction: float = 0.5,
) -> dict:
    """Chronological perfect-foresight dispatch for one day."""
    return _optimise_days(
        [("day", prices)],
        power_mw,
        energy_mwh,
        rte_pct,
        mlf=mlf,
        aux=aux,
        capture=capture,
        deg_cost_per_mwh=deg_cost_per_mwh,
        max_cycles_per_day=max_cycles_per_day,
        initial_soc_fraction=initial_soc_fraction,
    )["day"]


@_serialised_energy_backtest
def run_energy_backtest(
    region: str,
    power_mw: float,
    duration_h: float,
    rte_pct: float,
    *,
    lookback_days: int = 365,
    capture_efficiency: float = 1.0,
    mlf: float = 0.985,
    aux_load_pct: float = 1.5,
    deg_cost_per_mwh: float = 35.0,
    max_cycles_per_day: float = 2.0,
    period_start: str | None = None,
    period_end_exclusive: str | None = None,
) -> dict | None:
    """Run a chronological, SOC-constrained energy arbitrage backtest."""
    if power_mw <= 0 or duration_h <= 0:
        return None

    energy_mwh = power_mw * duration_h
    aux = aux_load_pct / 100.0
    nowdt = datetime.utcnow() + timedelta(hours=10)
    cutoff = (
        period_start
        if period_start is not None
        else (nowdt - timedelta(days=lookback_days)).strftime("%Y-%m-%d %H:%M:%S")
    )

    with locked_conn() as con:
        if period_end_exclusive is None:
            rows = con.execute(
                """
                SELECT settlementdate, rrp
                FROM nem_dispatch_price
                WHERE regionid = ? AND settlementdate >= ? AND rrp IS NOT NULL
                ORDER BY settlementdate
                """,
                (region, cutoff),
            ).fetchall()
        else:
            rows = con.execute(
                """
                SELECT settlementdate, rrp
                FROM nem_dispatch_price
                WHERE regionid = ? AND settlementdate >= ?
                  AND settlementdate < ? AND rrp IS NOT NULL
                ORDER BY settlementdate
                """,
                (region, cutoff, period_end_exclusive),
            ).fetchall()
    if not rows:
        return None

    by_day: dict[str, list[float]] = defaultdict(list)
    for ts, rrp in rows:
        by_day[str(ts)[:10]].append(float(rrp))

    complete_days = {
        day: prices for day, prices in by_day.items()
        if len(prices) == COMPLETE_DAY_INTERVALS
    }
    n_excluded = len(by_day) - len(complete_days)
    if not complete_days:
        return None

    daily_results: list[dict] = []
    monthly_agg: dict[str, dict] = defaultdict(lambda: {
        "energy_revenue_aud": 0.0,
        "gross_market_revenue_aud": 0.0,
        "degradation_cost_aud": 0.0,
        "discharge_mwh": 0.0,
        "charge_cost_aud": 0.0,
        "n_days": 0,
        "best_spread": 0.0,
    })
    cycle_hist: dict[str, int] = defaultdict(int)
    best_day = {"date": None, "revenue": float("-inf")}
    worst_day = {"date": None, "revenue": float("inf")}

    totals = defaultdict(float)
    raw_daily_spreads: list[float] = []
    n_positive = 0
    n_idle = 0
    n_days_milp_complementarity = 0

    complete_items = sorted(complete_days.items())
    solved_days: dict[str, dict] = {}
    for start in range(0, len(complete_items), ENERGY_BATCH_DAYS):
        solved_days.update(_optimise_days_resilient(
            complete_items[start:start + ENERGY_BATCH_DAYS],
            power_mw,
            energy_mwh,
            rte_pct,
            mlf=mlf,
            aux=aux,
            capture=capture_efficiency,
            deg_cost_per_mwh=deg_cost_per_mwh,
            max_cycles_per_day=max_cycles_per_day,
        ))

    for day, prices in complete_items:
        solved = solved_days[day]
        if solved["used_milp_complementarity"]:
            n_days_milp_complementarity += 1

        discharge_mwh = solved["discharge_mwh"]
        cycles = solved["cycles"]
        net_revenue = solved["net_revenue"]
        net_margin = net_revenue / discharge_mwh if discharge_mwh > 1e-9 else 0.0
        captured_market_margin = (
            solved["captured_market_revenue"] / discharge_mwh
            if discharge_mwh > 1e-9 else 0.0
        )

        if discharge_mwh <= 1e-6:
            n_idle += 1
        if net_revenue > 1e-6:
            n_positive += 1

        bucket = f"{round(cycles * 2) / 2:.1f}"
        cycle_hist[bucket] += 1

        sorted_prices = sorted(prices)
        n_four_hours = min(48, len(sorted_prices) // 2)
        daily_raw_spread = (
            sum(sorted_prices[-n_four_hours:]) / n_four_hours
            - sum(sorted_prices[:n_four_hours]) / n_four_hours
        )
        raw_daily_spreads.append(daily_raw_spread)

        for key in (
            "gross_spread_revenue", "after_rte_revenue",
            "after_mlf_aux_revenue", "captured_market_revenue",
            "degradation_cost", "net_revenue", "discharge_mwh", "charge_mwh",
        ):
            totals[key] += solved[key]

        if net_revenue > best_day["revenue"]:
            best_day = {"date": day, "revenue": round(net_revenue, 0)}
        if net_revenue < worst_day["revenue"]:
            worst_day = {"date": day, "revenue": round(net_revenue, 0)}

        month = day[:7]
        m = monthly_agg[month]
        m["energy_revenue_aud"] += net_revenue
        m["gross_market_revenue_aud"] += solved["captured_market_revenue"]
        m["degradation_cost_aud"] += solved["degradation_cost"]
        m["discharge_mwh"] += discharge_mwh
        m["charge_cost_aud"] += solved["charge_cost_settled"]
        m["n_days"] += 1
        m["best_spread"] = max(m["best_spread"], daily_raw_spread)

        daily_results.append({
            "date": day,
            "revenue_aud": round(net_revenue, 0),
            "gross_market_revenue_aud": round(solved["captured_market_revenue"], 0),
            "degradation_cost_aud": round(solved["degradation_cost"], 0),
            "discharge_mwh": round(discharge_mwh, 3),
            "charge_mwh": round(solved["charge_mwh"], 3),
            "net_margin_per_mwh": round(net_margin, 3),
            "captured_market_margin_per_mwh": round(captured_market_margin, 3),
            "cycles": round(cycles, 4),
        })

    n_days = len(daily_results)
    annual_scale = 365.0 / n_days
    annual_net = totals["net_revenue"] * annual_scale
    annual_captured_market = totals["captured_market_revenue"] * annual_scale
    annual_degradation = totals["degradation_cost"] * annual_scale
    annual_discharge = totals["discharge_mwh"] * annual_scale
    annual_charge = totals["charge_mwh"] * annual_scale
    net_margin = annual_net / annual_discharge if annual_discharge > 1e-9 else 0.0
    captured_margin = (
        annual_captured_market / annual_discharge if annual_discharge > 1e-9 else 0.0
    )

    denominator = totals["discharge_mwh"] or 1.0
    gross_per_mwh = totals["gross_spread_revenue"] / denominator
    rte_per_mwh = totals["after_rte_revenue"] / denominator
    mlf_aux_per_mwh = totals["after_mlf_aux_revenue"] / denominator
    capture_per_mwh = totals["captured_market_revenue"] / denominator
    net_per_mwh = totals["net_revenue"] / denominator

    haircuts = {
        "gross_market_spread_per_mwh": round(gross_per_mwh, 2),
        "after_rte_per_mwh": round(rte_per_mwh, 2),
        "after_mlf_aux_per_mwh": round(mlf_aux_per_mwh, 2),
        "after_capture_per_mwh": round(capture_per_mwh, 2),
        "after_degradation_per_mwh": round(net_per_mwh, 2),
        "mean_daily_top_minus_bottom": round(sum(raw_daily_spreads) / len(raw_daily_spreads), 2),
        "rte_loss_pct": round(_pct_reduction(gross_per_mwh, rte_per_mwh), 2),
        "mlf_aux_loss_pct": round(_pct_reduction(rte_per_mwh, mlf_aux_per_mwh), 2),
        "capture_loss_pct": round(_pct_reduction(mlf_aux_per_mwh, capture_per_mwh), 2),
        "degradation_loss_pct": round(_pct_reduction(capture_per_mwh, net_per_mwh), 2),
    }

    monthly = [
        {
            "month": month,
            **{
                key: int(value) if key == "n_days" else round(value, 0)
                for key, value in values.items()
            },
        }
        for month, values in sorted(monthly_agg.items())
    ]

    return {
        "annual_revenue_aud": round(annual_net, 0),
        "annual_captured_market_revenue_aud": round(annual_captured_market, 0),
        "annual_degradation_cost_aud": round(annual_degradation, 0),
        "implied_spread_per_mwh": round(net_margin, 3),
        "captured_market_margin_per_mwh": round(captured_margin, 3),
        "annual_discharge_mwh": round(annual_discharge, 2),
        "annual_charge_mwh": round(annual_charge, 2),
        "capture_efficiency": capture_efficiency,
        "deg_cost_per_mwh": deg_cost_per_mwh,
        "mean_cycles_per_day": round(totals["discharge_mwh"] / energy_mwh / n_days, 4),
        "max_cycles_per_day": max_cycles_per_day,
        "n_days_backtested": n_days,
        "n_days_excluded_incomplete": n_excluded,
        "n_days_positive": n_positive,
        "n_days_idle": n_idle,
        "n_days_milp_complementarity": n_days_milp_complementarity,
        "cycle_histogram": dict(sorted(cycle_hist.items())),
        "best_day": best_day,
        "worst_day": worst_day,
        "monthly": monthly,
        "mlf_applied": mlf,
        "methodology": "chronological_soc_lp",
        "is_perfect_foresight": True,
        "haircuts": haircuts,
        "daily_results": daily_results,
    }


def run_full_backtest(
    region: str,
    power_mw: float,
    duration_h: float,
    rte_pct: float = 88.0,
    mlf: float = 0.985,
    aux_load_pct: float = 1.5,
    lookback_days: int = 365,
    capture_efficiency: float = 1.0,
    deg_cost_per_mwh: float = 35.0,
    max_cycles_per_day: float = 2.0,
) -> dict:
    """Return the energy cash-revenue upper bound; FCAS is benchmarked elsewhere."""
    energy = run_energy_backtest(
        region,
        power_mw,
        duration_h,
        rte_pct,
        lookback_days=lookback_days,
        capture_efficiency=capture_efficiency,
        mlf=mlf,
        aux_load_pct=aux_load_pct,
        deg_cost_per_mwh=deg_cost_per_mwh,
        max_cycles_per_day=max_cycles_per_day,
    )
    # A regional-price-only FCAS proxy is not project revenue.  Do not include
    # it in the investment backtest; DUID-observed benchmarks are calculated
    # separately in ``bess_benchmarks``.
    fcas = None
    energy_revenue = (
        energy["annual_captured_market_revenue_aud"] if energy else 0.0
    )

    return {
        "region": region,
        "spec": {
            "power_mw": power_mw,
            "duration_h": duration_h,
            "rte_pct": rte_pct,
            "deg_cost_per_mwh": deg_cost_per_mwh,
            "max_cycles_per_day": max_cycles_per_day,
            "mlf": mlf,
        },
        "lookback_days": lookback_days,
        "capture_efficiency": capture_efficiency,
        "energy": energy,
        "fcas": fcas,
        "annual_energy_revenue_aud": round(energy_revenue, 0),
        "annual_fcas_price_exposure_aud": 0.0,
        "annual_total_revenue_aud": round(energy_revenue, 0),
        "total_is_scenario_not_realised": False,
    }
