"""Observed SA BESS operating-revenue benchmarks and target-asset scaling.

Energy revenue uses public DISPATCHLOAD ``INITIALMW`` as the best available
five-minute dispatch/SCADA proxy and values it at the regional RRP.  FCAS
revenue uses the actual per-service enablement targets published by NEMDE.
The latter follows AEMO's settlement formula: enabled MW x regional clearing
price / 12 for each five-minute interval.

The observed comparator basket is used directly: realised energy cash margin
per discharged MWh and realised equivalent cycles are scaled to the target
asset.  The perfect-foresight optimisation remains an audit ceiling only; it
is not used as a haircut base.  This is a benchmark, not a claim to reproduce
participant metering, contracts, FPP, or fees.
"""
from __future__ import annotations

from functools import lru_cache
import json
from .bess_backtest import run_energy_backtest
from .db import locked_conn, write_conn


FCAS_PAIRS = (
    ("RAISE6SEC", "raise6sec_mw", "raise6sec_rrp"),
    ("RAISE60SEC", "raise60sec_mw", "raise60sec_rrp"),
    ("RAISE5MIN", "raise5min_mw", "raise5min_rrp"),
    ("RAISEREG", "raisereg_mw", "raisereg_rrp"),
    ("RAISE1SEC", "raise1sec_mw", "raise1sec_rrp"),
    ("LOWER6SEC", "lower6sec_mw", "lower6sec_rrp"),
    ("LOWER60SEC", "lower60sec_mw", "lower60sec_rrp"),
    ("LOWER5MIN", "lower5min_mw", "lower5min_rrp"),
    ("LOWERREG", "lowerreg_mw", "lowerreg_rrp"),
    ("LOWER1SEC", "lower1sec_mw", "lower1sec_rrp"),
)


def _quantile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = fraction * (len(ordered) - 1)
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    weight = position - lower
    return ordered[lower] * (1.0 - weight) + ordered[upper] * weight


def _range(values: list[float]) -> dict:
    return {
        "p25": round(_quantile(values, 0.25), 3),
        "median": round(_quantile(values, 0.50), 3),
        "p75": round(_quantile(values, 0.75), 3),
        "min": round(min(values), 3) if values else 0.0,
        "max": round(max(values), 3) if values else 0.0,
        "n": len(values),
    }


def observed_bess_benchmarks(
    region: str = "SA1",
    period_start: str = "2025-07-01 00:00:00",
    period_end_exclusive: str = "2026-07-01 00:00:00",
) -> dict:
    """Calculate annualised observed energy and FCAS revenue by BESS DUID."""
    service_select = ",\n".join(
        f"SUM(MAX(COALESCE(b.{mw_col}, 0), 0) * "
        f"COALESCE(p.{price_col}, 0) / 12.0) AS {code.lower()}_revenue"
        for code, mw_col, price_col in FCAS_PAIRS
    )

    with locked_conn() as con:
        metadata_rows = con.execute(
            """
            SELECT r.duid, r.station, r.capacity_mw,
                   COALESCE(m.mlf, r.tlf, 1.0) AS mlf
            FROM nem_facility_registry r
            LEFT JOIN nem_mlf m
              ON m.duid = r.duid AND m.financial_year = '2025-26'
            WHERE r.region = ? AND r.fuel = 'battery'
              AND UPPER(COALESCE(r.dispatch_type, '')) = 'BIDIRECTIONAL'
              AND COALESCE(r.capacity_mw, 0) >= 20
            """,
            (region.upper(),),
        ).fetchall()
        metadata = {
            str(row[0]): {
                "station": row[1] or row[0],
                "capacity_mw": float(row[2]),
                "mlf": float(row[3]),
            }
            for row in metadata_rows
        }
        if not metadata:
            return {"available": False, "reason": "no registered battery metadata"}

        rows = con.execute(
            f"""
            SELECT b.duid,
                   COUNT(*) AS intervals,
                   COUNT(DISTINCT substr(b.settlementdate, 1, 10)) AS coverage_days,
                   MIN(b.settlementdate) AS first_interval,
                   MAX(b.settlementdate) AS last_interval,
                   COUNT(DISTINCT CASE WHEN
                       ABS(COALESCE(b.initial_mw, 0)) > 0.5 OR
                       ({' + '.join(f'COALESCE(b.{mw}, 0)' for _, mw, _ in FCAS_PAIRS)}) > 0.5
                       THEN substr(b.settlementdate, 1, 10) END) AS active_days,
                   MAX(MAX(COALESCE(b.initial_energy_storage_mwh, 0),
                           COALESCE(b.energy_storage_mwh, 0))) AS observed_energy_mwh,
                   MAX(ABS(COALESCE(b.initial_mw, 0))) AS observed_power_mw,
                   SUM(CASE WHEN COALESCE(b.initial_mw, 0) >= 0
                       THEN b.initial_mw * p.rrp / 12.0
                            * COALESCE(meta.mlf, 1.0)
                       ELSE b.initial_mw * p.rrp / 12.0
                            / COALESCE(meta.mlf, 1.0)
                       END) AS energy_revenue,
                   SUM(MAX(COALESCE(b.initial_mw, 0), 0) / 12.0) AS discharge_mwh,
                   SUM(MAX(-COALESCE(b.initial_mw, 0), 0) / 12.0) AS charge_mwh,
                   SUM(MAX(COALESCE(b.initial_mw, 0), 0) * p.rrp / 12.0
                       * COALESCE(meta.mlf, 1.0)) AS discharge_revenue_settled,
                   SUM(MAX(-COALESCE(b.initial_mw, 0), 0) * p.rrp / 12.0
                       / COALESCE(meta.mlf, 1.0)) AS charge_cost_settled,
                   {service_select},
                   COUNT(DISTINCT CASE WHEN
                       ({' + '.join(f'COALESCE(b.{mw}, 0)' for _, mw, _ in FCAS_PAIRS)}) > 0.5
                       THEN substr(b.settlementdate, 1, 10) END) AS fcas_active_days
            FROM nem_bess_dispatch b
            JOIN nem_dispatch_price p
              ON p.settlementdate = b.settlementdate AND p.regionid = ?
            LEFT JOIN (
                SELECT r.duid, COALESCE(m.mlf, r.tlf, 1.0) AS mlf
                FROM nem_facility_registry r
                LEFT JOIN nem_mlf m
                  ON m.duid = r.duid AND m.financial_year = '2025-26'
            ) meta ON meta.duid = b.duid
            WHERE b.settlementdate >= ? AND b.settlementdate < ?
            GROUP BY b.duid
            ORDER BY b.duid
            """,
            (region.upper(), period_start, period_end_exclusive),
        ).fetchall()

    entries: list[dict] = []
    for row in rows:
        duid = str(row[0])
        meta = metadata.get(duid)
        if meta is None:
            continue
        intervals = int(row[1])
        coverage_days = int(row[2])
        annual_factor = 365.0 / coverage_days if coverage_days else 0.0
        by_market_observed = {
            FCAS_PAIRS[i][0]: float(row[13 + i] or 0.0)
            for i in range(len(FCAS_PAIRS))
        }
        fcas_observed = sum(by_market_observed.values())
        capacity_mw = meta["capacity_mw"]
        energy_observed = float(row[8] or 0.0)
        discharge_mwh = float(row[9] or 0.0)
        charge_mwh = float(row[10] or 0.0)
        discharge_revenue_settled = float(row[11] or 0.0)
        charge_cost_settled = float(row[12] or 0.0)
        energy_cash_margin = (
            energy_observed / discharge_mwh if discharge_mwh > 0 else 0.0
        )
        observed_energy_mwh = float(row[6] or 0.0)
        duration_h = observed_energy_mwh / capacity_mw if capacity_mw > 0 else 0.0
        equivalent_cycles_per_day = (
            float(row[9] or 0.0) / observed_energy_mwh / coverage_days
            if observed_energy_mwh > 0 and coverage_days > 0 else 0.0
        )
        coverage_ratio = intervals / (coverage_days * 288.0) if coverage_days else 0.0
        entries.append({
            "duid": duid,
            "station": meta["station"],
            "capacity_mw": round(capacity_mw, 3),
            "mlf": round(meta["mlf"], 5),
            "observed_energy_mwh": round(observed_energy_mwh, 3),
            "inferred_duration_h": round(duration_h, 3),
            "equivalent_cycles_per_day": round(equivalent_cycles_per_day, 4),
            "observed_power_mw": round(float(row[7] or 0.0), 3),
            "intervals": intervals,
            "coverage_days": coverage_days,
            "coverage_ratio": round(coverage_ratio, 4),
            "active_days": int(row[5]),
            "fcas_active_days": int(row[23]),
            "first_interval": str(row[3]),
            "last_interval": str(row[4]),
            "energy_revenue_observed_aud": round(energy_observed, 0),
            "energy_cash_margin_per_discharge_mwh": round(energy_cash_margin, 3),
            "discharge_revenue_settled_aud": round(discharge_revenue_settled, 3),
            "charge_cost_settled_aud": round(charge_cost_settled, 3),
            "energy_revenue_per_mw_year": round(
                energy_observed * annual_factor / capacity_mw, 3
            ),
            "discharge_mwh_observed": round(discharge_mwh, 3),
            "charge_mwh_observed": round(charge_mwh, 3),
            "fcas_revenue_observed_aud": round(fcas_observed, 0),
            "fcas_revenue_per_mw_year": round(
                fcas_observed * annual_factor / capacity_mw, 3
            ),
            "fcas_by_market_observed_aud": {
                key: round(value, 0) for key, value in by_market_observed.items()
            },
            "annualisation_factor": round(annual_factor, 5),
        })

    # Use only established, substantially operational assets for the
    # calibration basket.  Newly commissioned projects remain visible in
    # `entries`, but their partial commissioning year must not drag down a
    # representative annual operating benchmark.
    eligible = [
        entry for entry in entries
        if entry["coverage_days"] >= 330
        and entry["coverage_ratio"] >= 0.90
        and entry["active_days"] >= 0.80 * entry["coverage_days"]
    ]
    fcas_active = [
        entry for entry in eligible
        if entry["fcas_active_days"] >= 30
    ]
    eligible_ids = {entry["duid"] for entry in eligible}
    fcas_active_ids = {entry["duid"] for entry in fcas_active}
    for entry in entries:
        entry["operational_comparable"] = entry["duid"] in eligible_ids
        entry["fcas_comparable"] = entry["duid"] in fcas_active_ids
    energy_values = [entry["energy_revenue_per_mw_year"] for entry in eligible]
    energy_margin_values = [
        entry["energy_cash_margin_per_discharge_mwh"] for entry in eligible
        if entry["discharge_mwh_observed"] > 0
    ]
    fcas_values = [entry["fcas_revenue_per_mw_year"] for entry in fcas_active]
    cycle_values = [entry["equivalent_cycles_per_day"] for entry in eligible]
    return {
        "available": bool(entries),
        "region": region.upper(),
        "period_start": period_start,
        "period_end_exclusive": period_end_exclusive,
        "methodology": "observed DUID cash margin per discharged MWh + actual cycles + actual FCAS enablement",
        "limitations": [
            "Energy uses public INITIALMW rather than revenue-metered MWh.",
            "FCAS excludes Frequency Performance Payments, contracts and participant fees.",
            "Partial-year assets are annualised and identified by their coverage fields.",
            "Commissioning-year assets with under 330 coverage days are shown but excluded from quartiles.",
            "The SA basket is mostly 0.4-2.4h; applying its realised equivalent-cycle distribution to a 4h target is an extrapolation.",
        ],
        "entries": entries,
        "eligible_duids": [entry["duid"] for entry in eligible],
        "fcas_active_duids": [entry["duid"] for entry in fcas_active],
        "observed_energy_per_mw_year": _range(energy_values),
        "observed_energy_cash_margin_per_mwh": _range(energy_margin_values),
        "observed_fcas_per_mw_year": _range(fcas_values),
        "observed_cycles_per_day": _range(cycle_values),
    }


def _calibration_cache_key(
    region: str, period_start: str, period_end_exclusive: str,
) -> str:
    """Fingerprint the exact source slice used by the empirical calibration."""
    with locked_conn() as con:
        dispatch = con.execute(
            """
            SELECT COUNT(*), COALESCE(MAX(b.settlementdate), '')
            FROM nem_bess_dispatch b
            JOIN nem_facility_registry r ON r.duid = b.duid
            WHERE r.region = ? AND b.settlementdate >= ? AND b.settlementdate < ?
            """,
            (region.upper(), period_start, period_end_exclusive),
        ).fetchone()
        prices = con.execute(
            """
            SELECT COUNT(*), COALESCE(MAX(settlementdate), '')
            FROM nem_dispatch_price
            WHERE regionid = ? AND settlementdate >= ? AND settlementdate < ?
            """,
            (region.upper(), period_start, period_end_exclusive),
        ).fetchone()
    return "|".join(map(str, (
        "v4", region.upper(), period_start, period_end_exclusive,
        dispatch[0], dispatch[1], prices[0], prices[1],
    )))


@lru_cache(maxsize=8)
def calibrated_bess_benchmarks(
    region: str = "SA1",
    period_start: str = "2025-07-01 00:00:00",
    period_end_exclusive: str = "2026-07-01 00:00:00",
) -> dict:
    """Add empirical energy capture ratios to the observed DUID benchmark."""
    cache_key = _calibration_cache_key(region, period_start, period_end_exclusive)
    with locked_conn() as con:
        cached = con.execute(
            "SELECT payload_json FROM nem_bess_benchmark_cache WHERE cache_key = ?",
            (cache_key,),
        ).fetchone()
    if cached:
        return json.loads(str(cached[0]))

    result = observed_bess_benchmarks(region, period_start, period_end_exclusive)
    if not result.get("available"):
        return result

    eligible = set(result["eligible_duids"])
    capture_values: list[float] = []
    for entry in result["entries"]:
        if entry["duid"] not in eligible:
            continue
        duration_h = float(entry["inferred_duration_h"])
        if not 0.2 <= duration_h <= 6.0:
            continue
        upper = run_energy_backtest(
            region,
            power_mw=1.0,
            duration_h=duration_h,
            rte_pct=88.0,
            capture_efficiency=1.0,
            mlf=float(entry["mlf"]),
            aux_load_pct=1.5,
            deg_cost_per_mwh=0.0,
            max_cycles_per_day=3.0,
            period_start=period_start,
            period_end_exclusive=period_end_exclusive,
        )
        upper_revenue = (
            float(upper["annual_captured_market_revenue_aud"])
            if upper else 0.0
        )
        actual_revenue = float(entry["energy_revenue_per_mw_year"])
        if upper_revenue <= 0 or actual_revenue < 0:
            continue
        capture_ratio = min(actual_revenue / upper_revenue, 1.0)
        entry["perfect_foresight_energy_per_mw_year"] = round(upper_revenue, 3)
        entry["observed_energy_capture_ratio"] = round(capture_ratio, 4)
        capture_values.append(capture_ratio)

    result["energy_capture_ratio"] = _range(capture_values)
    result["energy_capture_ratio"]["method"] = (
        "observed DUID energy revenue divided by same-period perfect-foresight LP"
    )
    with write_conn() as con:
        con.execute(
            """
            INSERT OR REPLACE INTO nem_bess_benchmark_cache
                (cache_key, payload_json, created_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            """,
            (cache_key, json.dumps(result, separators=(",", ":"))),
        )
    return result


@lru_cache(maxsize=64)
def target_bess_benchmark(
    region: str,
    power_mw: float,
    duration_h: float,
    rte_pct: float,
    mlf: float,
    aux_load_pct: float,
    deg_cost_per_mwh: float,
    max_cycles_per_day: float,
    period_start: str = "2025-07-01 00:00:00",
    period_end_exclusive: str = "2026-07-01 00:00:00",
) -> dict:
    """Apply observed comparator ranges to a target BESS specification."""
    source_key = _calibration_cache_key(region, period_start, period_end_exclusive)
    target_cache_key = "|".join(map(str, (
        "target-v3-operating", source_key, round(power_mw, 4), round(duration_h, 4),
        round(rte_pct, 4), round(mlf, 6), round(aux_load_pct, 4),
        round(deg_cost_per_mwh, 4), round(max_cycles_per_day, 4),
    )))
    with locked_conn() as con:
        cached_target = con.execute(
            "SELECT payload_json FROM nem_bess_benchmark_cache WHERE cache_key = ?",
            (target_cache_key,),
        ).fetchone()
    if cached_target:
        return json.loads(str(cached_target[0]))

    benchmark = observed_bess_benchmarks(
        region.upper(), period_start, period_end_exclusive
    )
    fcas = benchmark.get("observed_fcas_per_mw_year") or {}
    eligible = [
        entry for entry in benchmark.get("entries", [])
        if entry.get("operational_comparable")
        and float(entry.get("discharge_mwh_observed") or 0.0) > 0
    ]
    if not benchmark.get("available") or not eligible:
        return {
            "available": False,
            "reason": "DUID operating benchmark data is incomplete",
            "benchmark": benchmark,
        }

    # Preserve every comparator's realised margin/cycling pair.  Dividing
    # actual low-cycle revenue by a three-cycle perfect-foresight ceiling and
    # then separately applying actual cycles would double-count utilisation.
    projected_energy_revenues: list[float] = []
    projected_cycles: list[float] = []
    target_adjusted_margins: list[float] = []
    for entry in eligible:
        observed_mlf = max(float(entry.get("mlf") or 1.0), 1e-9)
        discharge_mwh = float(entry["discharge_mwh_observed"])
        # Reverse the comparator MLF settlement, then apply the target MLF.
        raw_sell = float(entry.get("discharge_revenue_settled_aud") or 0.0) / observed_mlf
        raw_charge_cost = float(entry.get("charge_cost_settled_aud") or 0.0) * observed_mlf
        target_net_revenue = raw_sell * mlf - raw_charge_cost / mlf
        target_margin = target_net_revenue / discharge_mwh
        observed_cycles = min(
            max_cycles_per_day,
            max(0.0, float(entry.get("equivalent_cycles_per_day") or 0.0)),
        )
        target_discharge = power_mw * duration_h * observed_cycles * 365.0
        target_adjusted_margins.append(target_margin)
        projected_cycles.append(observed_cycles)
        projected_energy_revenues.append(target_discharge * target_margin)

    definitions = (
        ("conservative", 0.25, float(fcas.get("p25", 0.0))),
        ("base", 0.50, float(fcas.get("median", 0.0))),
        ("upside", 0.75, float(fcas.get("p75", 0.0))),
    )
    upper = run_energy_backtest(
        region.upper(),
        power_mw=power_mw,
        duration_h=duration_h,
        rte_pct=rte_pct,
        capture_efficiency=1.0,
        mlf=mlf,
        aux_load_pct=aux_load_pct,
        deg_cost_per_mwh=0.0,
        max_cycles_per_day=max_cycles_per_day,
        period_start=period_start,
        period_end_exclusive=period_end_exclusive,
    )
    if not upper:
        return {"available": False, "reason": "target energy price history is incomplete", "benchmark": benchmark}

    upper_cash_revenue = float(upper["annual_captured_market_revenue_aud"])
    scenarios: dict[str, dict] = {}
    for name, quantile, fcas_per_mw_year in definitions:
        energy_revenue = _quantile(projected_energy_revenues, quantile)
        mean_cycles = _quantile(projected_cycles, quantile)
        annual_discharge = power_mw * duration_h * mean_cycles * 365.0
        cash_margin = energy_revenue / annual_discharge if annual_discharge > 0 else 0.0
        degradation_hurdle = annual_discharge * deg_cost_per_mwh
        economic_net = energy_revenue - degradation_hurdle
        fcas_revenue = power_mw * fcas_per_mw_year
        scenarios[name] = {
            "operating_benchmark_quantile": quantile,
            "energy_revenue_aud": round(energy_revenue, 0),
            "energy_economic_net_aud": round(economic_net, 0),
            "degradation_hurdle_cost_aud": round(degradation_hurdle, 0),
            "energy_cash_margin_per_mwh": round(cash_margin, 3),
            "energy_net_margin_per_mwh": round(cash_margin - deg_cost_per_mwh, 3),
            "mean_cycles_per_day": round(mean_cycles, 4),
            "fcas_revenue_per_mw_year": round(fcas_per_mw_year, 0),
            "fcas_revenue_aud": round(fcas_revenue, 0),
            "combined_revenue_aud": round(energy_revenue + fcas_revenue, 0),
        }

    scenarios["perfect_foresight_upper"] = {
        "capture_ratio": 1.0,
        "energy_revenue_aud": round(upper_cash_revenue, 0),
        "energy_economic_net_aud": round(upper_cash_revenue, 0),
        "degradation_hurdle_cost_aud": 0.0,
        "energy_cash_margin_per_mwh": upper["captured_market_margin_per_mwh"],
        "energy_net_margin_per_mwh": upper["captured_market_margin_per_mwh"],
        "mean_cycles_per_day": upper["mean_cycles_per_day"],
        "fcas_revenue_per_mw_year": 0.0,
        "fcas_revenue_aud": 0.0,
        "combined_revenue_aud": round(upper_cash_revenue, 0),
    }

    response = {
        "available": True,
        "region": region.upper(),
        "period_start": period_start,
        "period_end_exclusive": period_end_exclusive,
        "target": {
            "power_mw": power_mw,
            "duration_h": duration_h,
            "rte_pct": rte_pct,
            "mlf": mlf,
            "aux_load_pct": aux_load_pct,
            "deg_cost_per_mwh": deg_cost_per_mwh,
            "max_cycles_per_day": max_cycles_per_day,
        },
        "scenarios": scenarios,
        "benchmark": benchmark,
        "target_adjusted_energy_cash_margin_per_mwh": _range(target_adjusted_margins),
        "projected_energy_revenue_aud": _range(projected_energy_revenues),
        "methodology": (
            "Observed SA DUID energy cash margin per discharged MWh and realised cycles scaled to target "
            "power/duration, with target MLF applied; FCAS uses actual FCAS-active DUID $/MW/year quartiles"
        ),
        "is_observed_benchmark_not_forecast": True,
    }
    with write_conn() as con:
        con.execute(
            """
            INSERT OR REPLACE INTO nem_bess_benchmark_cache
                (cache_key, payload_json, created_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            """,
            (target_cache_key, json.dumps(response, separators=(",", ":"))),
        )
    return response
