"""BESS project finance model.

Pure functions — no FastAPI / no DB. The route layer (`routes/bess_calc.py`)
wires DB-derived real-world calibration values into the inputs and calls
`project_cashflow()`, then serialises the result.

Conventions:
- All money in AUD nominal (with explicit inflation handled in cashflow).
- Year 0 = construction (CapEx outflow only).
- Year 1..N = operating years (revenue + opex + debt service).
- Debt is a standard amortising loan repaid over `loan_tenor_years`
  starting Year 1. Interest is on opening principal each year.
- Depreciation uses straight-line over `depreciation_life_years` for
  simplicity; ATO actually allows DV 18.18% effective-life-11-years for
  batteries, but straight-line keeps the model transparent and is the
  conservative tax assumption.
- Augmentation: a one-off CapEx in `augmentation_year` to replace cells
  and restore capacity to nameplate.

Why we don't use numpy_financial: the venv this ships in is minimal and
we want to ship without adding deps. The IRR Newton solver below is ~30
lines and converges in <10 iterations for any sensible BESS cashflow.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict, field
from typing import Literal


# ---- Inputs --------------------------------------------------------------

@dataclass
class BessFinanceInputs:
    # ---- Asset spec ----
    region: str = "NSW1"
    power_mw: float = 100.0
    duration_h: float = 2.0           # → energy_mwh = power × duration
    capex_aud: float = 80_000_000.0   # All-in including BoP, EPC, grid connection

    # ---- Capital structure ----
    debt_pct: float = 60.0            # % of CapEx financed by debt
    interest_rate_pct: float = 6.5
    loan_tenor_years: int = 10

    # ---- Engineering / operating ----
    rte_pct: float = 88.0             # round-trip efficiency
    cycles_per_day: float = 1.2       # avg per-day equivalent full cycles
    degradation_pct_year: float = 2.0 # capacity loss per year (lithium typical)
    aux_load_pct: float = 1.5         # parasitic load (BMS, HVAC)
    mlf: float = 0.98                 # marginal loss factor
    project_life_years: int = 20
    augmentation_capex_pct: float = 15.0   # % of original CapEx
    augmentation_year: int = 12

    # ---- OpEx (nominal year 1, escalated by inflation thereafter) ----
    opex_per_kw_year: float = 10.0           # fixed O&M $/kW/yr
    insurance_per_mwh_year: float = 2.0      # $ per MWh capacity / yr
    land_rent_aud_year: float = 50_000.0     # annual land lease
    nuos_per_mw_year: float = 8000.0         # network use-of-system

    # ---- Revenue calibration (per-MWh / per-MW; can be overridden by
    #      historical data on the route side) ----
    # `arb_spread_per_mwh` is retained as the public API field name for
    # compatibility, but its value is the captured cash settlement margin per
    # discharged MWh after RTE, MLF, auxiliary load and bidding/capture effects.
    # The dispatch optimiser may use a degradation hurdle to avoid uneconomic
    # cycling, but no non-cash degradation reserve is deducted here because
    # physical fade and augmentation CapEx are modelled separately below.
    arb_spread_per_mwh: float | None = None
    # The SA route can supply an observed DUID-comparator benchmark. Users can
    # override it with contracted or asset-specific revenue when available.
    fcas_revenue_per_mw_year: float | None = None
    fcas_decline_pct_year: float = 0.0       # explicit user scenario; no hidden decline
    cis_floor_revenue_per_mw_year: float = 0.0    # Capacity Investment Scheme floor

    # ---- Financial ----
    discount_rate_pct: float = 7.0
    tax_rate_pct: float = 30.0
    depreciation_life_years: int = 18        # ATO storage assets
    inflation_pct: float = 2.5


# ---- Math helpers --------------------------------------------------------

def npv(rate: float, cashflows: list[float]) -> float:
    """Year-0 NPV of a sequence cf[0], cf[1], ..., cf[N]."""
    return sum(cf / ((1 + rate) ** i) for i, cf in enumerate(cashflows))


def irr(cashflows: list[float], guess: float = 0.1, tol: float = 1e-6,
        max_iter: int = 200) -> float | None:
    """IRR via Newton-Raphson. Returns None if it doesn't converge or if
    the cashflow profile is degenerate (e.g. all positive or all negative).
    Most BESS deals converge in 5-15 iterations from guess 0.10."""
    # Sanity: need at least one sign change.
    signs = {1 if cf > 0 else -1 if cf < 0 else 0 for cf in cashflows}
    if {1, -1}.isdisjoint(signs) or len(signs - {0}) < 2:
        return None

    r = guess
    for _ in range(max_iter):
        f = sum(cf / ((1 + r) ** i) for i, cf in enumerate(cashflows))
        # Derivative w.r.t. r
        df = sum(-i * cf / ((1 + r) ** (i + 1)) for i, cf in enumerate(cashflows))
        if abs(df) < 1e-12:
            return None
        r_new = r - f / df
        if not (-0.99 < r_new < 10):    # diverging
            return None
        if abs(r_new - r) < tol:
            return r_new
        r = r_new
    return None


def amortisation_schedule(principal: float, rate: float, years: int) -> list[dict]:
    """Standard amortising loan: equal annual payments. Returns one row
    per year with opening balance, interest, principal, closing balance."""
    if years <= 0 or principal <= 0:
        return []
    if rate <= 0:
        # Interest-free loan — equal principal repayment
        annuity = principal / years
        rows = []
        bal = principal
        for _ in range(years):
            interest = 0.0
            principal_pmt = annuity
            bal_close = max(0, bal - principal_pmt)
            rows.append({"opening": bal, "interest": interest,
                         "principal": principal_pmt, "closing": bal_close,
                         "payment": annuity})
            bal = bal_close
        return rows
    annuity = principal * rate / (1 - (1 + rate) ** -years)
    rows = []
    bal = principal
    for _ in range(years):
        interest = bal * rate
        principal_pmt = annuity - interest
        bal_close = max(0, bal - principal_pmt)
        rows.append({"opening": bal, "interest": interest,
                     "principal": principal_pmt, "closing": bal_close,
                     "payment": annuity})
        bal = bal_close
    return rows


# ---- Cashflow projection -------------------------------------------------

def project_cashflow(inputs: BessFinanceInputs) -> dict:
    """Run the full 20-ish year cashflow.

    Returns:
        {
          "inputs": dict (echo),
          "summary": {NPV, project_irr, equity_irr, payback_simple,
                      payback_discounted, lcos_per_mwh, total_revenue_lifetime,
                      total_opex_lifetime, debt_amount, equity_amount, ...},
          "yearly": [ {year, revenue_*, opex_*, ebitda, tax, capex, debt_*,
                       cashflow_*, cumulative_cf_*}, ... ],
          "amortisation": [ {opening, interest, principal, closing, payment}, ...],
          "sensitivity": {...} (computed by caller — kept separate to allow
                          parallel runs),
        }
    """
    # Convenience locals
    inp = inputs
    inflation = inp.inflation_pct / 100
    discount = inp.discount_rate_pct / 100
    tax = inp.tax_rate_pct / 100
    energy_mwh = inp.power_mw * inp.duration_h
    capex_initial = inp.capex_aud
    debt_amount = capex_initial * inp.debt_pct / 100
    equity_amount = capex_initial - debt_amount

    # ---- Revenue assumptions (must be supplied or defaulted by caller) ----
    arb_spread = inp.arb_spread_per_mwh if inp.arb_spread_per_mwh is not None else 120.0
    fcas_rev_yr1 = inp.fcas_revenue_per_mw_year if inp.fcas_revenue_per_mw_year is not None else 25_000.0
    fcas_decline = inp.fcas_decline_pct_year / 100

    # ---- Amortisation schedule ----
    schedule = amortisation_schedule(debt_amount,
                                       inp.interest_rate_pct / 100,
                                       inp.loan_tenor_years)

    # ---- Depreciation (straight-line) ----
    annual_depreciation = capex_initial / inp.depreciation_life_years

    # ---- Year-by-year ----
    yearly: list[dict] = []
    cum_cf_unlev = 0.0
    cum_cf_eq = 0.0
    cum_cf_unlev_disc = 0.0
    cum_cf_eq_disc = 0.0

    # Year 0: construction — CapEx outflow, no revenue/opex
    yearly.append({
        "year": 0,
        "energy_revenue": 0, "fcas_revenue": 0, "cis_revenue": 0,
        "total_revenue": 0,
        "opex": 0, "ebitda": 0,
        "depreciation": 0, "interest": 0, "ebt": 0, "tax": 0,
        "principal_repayment": 0, "capex": -capex_initial,
        "cashflow_unlevered": -capex_initial,
        "cashflow_equity": -equity_amount,
        "cumulative_cf_unlevered": -capex_initial,
        "cumulative_cf_equity": -equity_amount,
        "dscr": None,
        "discharge_mwh": 0,
        "capacity_factor_pct": 0,
    })
    cum_cf_unlev = -capex_initial
    cum_cf_eq = -equity_amount
    cum_cf_unlev_disc = -capex_initial
    cum_cf_eq_disc = -equity_amount

    # Cashflows arrays for IRR computation (project = unlevered, equity = levered)
    cf_unlevered = [-capex_initial]
    cf_equity = [-equity_amount]

    total_revenue_lifetime = 0.0
    total_opex_lifetime = 0.0
    total_discharge_mwh = 0.0
    pv_discharge_mwh = 0.0
    pv_costs_for_lcos = capex_initial   # year-0 cost
    payback_simple_year: float | None = None
    payback_disc_year: float | None = None

    for y in range(1, inp.project_life_years + 1):
        # ---- Capacity degradation ----
        # Pre-augmentation: degrades each year. Post-augmentation: capacity
        # restored to nameplate, degradation clock resets.
        if y <= inp.augmentation_year:
            cap_factor = (1 - inp.degradation_pct_year / 100) ** (y - 1)
        else:
            yrs_post_aug = y - inp.augmentation_year - 1
            cap_factor = (1 - inp.degradation_pct_year / 100) ** yrs_post_aug
        effective_energy_mwh = energy_mwh * cap_factor

        # ---- Energy arbitrage revenue ----
        # discharge_mwh = cycles × days × effective_capacity.  `arb_spread`
        # is already the net earned margin per discharged MWh from the SOC
        # backtest, including RTE, MLF, auxiliary load and capture efficiency.
        # Cycling has already been screened using the degradation hurdle;
        # capacity fade and augmentation are represented separately here.
        discharge_mwh_yr = inp.cycles_per_day * 365 * effective_energy_mwh
        energy_revenue = discharge_mwh_yr * arb_spread
        # ---- FCAS revenue (declining as BESS saturates) ----
        fcas_rev_per_mw = fcas_rev_yr1 * (1 - fcas_decline) ** (y - 1)
        fcas_revenue = inp.power_mw * fcas_rev_per_mw
        # ---- CIS floor (if applicable) ----
        cis_revenue = inp.power_mw * inp.cis_floor_revenue_per_mw_year

        total_revenue = energy_revenue + fcas_revenue + cis_revenue

        # ---- OpEx (inflated from Year 1 base) ----
        infl_factor = (1 + inflation) ** (y - 1)
        opex_fixed = inp.opex_per_kw_year * inp.power_mw * 1000 * infl_factor
        opex_insurance = inp.insurance_per_mwh_year * energy_mwh * infl_factor
        opex_land = inp.land_rent_aud_year * infl_factor
        opex_nuos = inp.nuos_per_mw_year * inp.power_mw * infl_factor
        total_opex = opex_fixed + opex_insurance + opex_land + opex_nuos

        ebitda = total_revenue - total_opex

        # ---- Debt service ----
        if y <= inp.loan_tenor_years and y - 1 < len(schedule):
            row = schedule[y - 1]
            interest = row["interest"]
            principal_pmt = row["principal"]
        else:
            interest = 0.0
            principal_pmt = 0.0

        # ---- Tax: EBT = EBITDA − depreciation − interest ----
        # Depreciation only counts while we have depreciable base; for
        # simplicity assume CapEx fully depreciates over depreciation_life
        # (post-life depreciation = 0). Augmentation CapEx adds depreciable
        # base over the augmentation life.
        if y <= inp.depreciation_life_years:
            base_dep = annual_depreciation
        else:
            base_dep = 0.0
        # Augmentation depreciation: spread over min(depr_life, life-aug_year)
        aug_dep = 0.0
        if y > inp.augmentation_year:
            aug_capex = capex_initial * inp.augmentation_capex_pct / 100
            aug_dep_life = min(inp.depreciation_life_years, inp.project_life_years - inp.augmentation_year)
            if y <= inp.augmentation_year + aug_dep_life:
                aug_dep = aug_capex / aug_dep_life
        total_depreciation = base_dep + aug_dep
        ebt = ebitda - total_depreciation - interest
        tax_pmt = max(0.0, ebt * tax)

        # ---- Augmentation CapEx ----
        capex_this_year = 0.0
        if y == inp.augmentation_year:
            capex_this_year = capex_initial * inp.augmentation_capex_pct / 100

        # ---- Cashflow ----
        # Unlevered (project) = EBITDA − tax − CapEx
        cf_unlev_yr = ebitda - tax_pmt - capex_this_year
        # Equity (levered) = Unlevered − debt service
        cf_eq_yr = cf_unlev_yr - interest - principal_pmt

        cum_cf_unlev += cf_unlev_yr
        cum_cf_eq += cf_eq_yr
        cum_cf_unlev_disc += cf_unlev_yr / ((1 + discount) ** y)
        cum_cf_eq_disc += cf_eq_yr / ((1 + discount) ** y)

        # DSCR = CFADS / debt service
        # CFADS = EBITDA − tax (post-debt-service comes after CFADS)
        cfads = ebitda - tax_pmt
        debt_service = interest + principal_pmt
        dscr = (cfads / debt_service) if debt_service > 0 else None

        # Payback detection (first year cum cf > 0)
        if payback_simple_year is None and cum_cf_unlev > 0 and y > 0:
            # Linear interp within the year
            prev = cum_cf_unlev - cf_unlev_yr
            payback_simple_year = (y - 1) + (-prev / cf_unlev_yr) if cf_unlev_yr != 0 else y
        if payback_disc_year is None and cum_cf_unlev_disc > 0 and y > 0:
            prev_disc = cum_cf_unlev_disc - cf_unlev_yr / ((1 + discount) ** y)
            this_disc = cf_unlev_yr / ((1 + discount) ** y)
            payback_disc_year = (y - 1) + (-prev_disc / this_disc) if this_disc != 0 else y

        # LCOS components (discounted)
        pv_discharge_mwh += discharge_mwh_yr / ((1 + discount) ** y)
        pv_costs_for_lcos += (total_opex + interest + capex_this_year) / ((1 + discount) ** y)

        yearly.append({
            "year": y,
            "energy_revenue": round(energy_revenue, 0),
            "fcas_revenue": round(fcas_revenue, 0),
            "cis_revenue": round(cis_revenue, 0),
            "total_revenue": round(total_revenue, 0),
            "opex": round(total_opex, 0),
            "ebitda": round(ebitda, 0),
            "depreciation": round(total_depreciation, 0),
            "interest": round(interest, 0),
            "ebt": round(ebt, 0),
            "tax": round(tax_pmt, 0),
            "principal_repayment": round(principal_pmt, 0),
            "capex": round(-capex_this_year, 0) if capex_this_year > 0 else 0,
            "cashflow_unlevered": round(cf_unlev_yr, 0),
            "cashflow_equity": round(cf_eq_yr, 0),
            "cumulative_cf_unlevered": round(cum_cf_unlev, 0),
            "cumulative_cf_equity": round(cum_cf_eq, 0),
            "dscr": round(dscr, 2) if dscr is not None else None,
            "discharge_mwh": round(discharge_mwh_yr, 0),
            "capacity_factor_pct": round(cap_factor * 100, 1),
        })
        total_revenue_lifetime += total_revenue
        total_opex_lifetime += total_opex
        total_discharge_mwh += discharge_mwh_yr

        cf_unlevered.append(cf_unlev_yr)
        cf_equity.append(cf_eq_yr)

    project_npv = npv(discount, cf_unlevered)
    project_irr = irr(cf_unlevered)
    equity_irr = irr(cf_equity)

    lcos = (pv_costs_for_lcos / pv_discharge_mwh) if pv_discharge_mwh > 0 else None

    summary = {
        "energy_mwh": round(energy_mwh, 1),
        "debt_amount": round(debt_amount, 0),
        "equity_amount": round(equity_amount, 0),
        "annual_debt_service": round(schedule[0]["payment"], 0) if schedule else 0,
        "npv_aud": round(project_npv, 0),
        "project_irr_pct": round(project_irr * 100, 2) if project_irr is not None else None,
        "equity_irr_pct": round(equity_irr * 100, 2) if equity_irr is not None else None,
        "payback_simple_years": round(payback_simple_year, 2) if payback_simple_year is not None else None,
        "payback_discounted_years": round(payback_disc_year, 2) if payback_disc_year is not None else None,
        "lcos_per_mwh": round(lcos, 1) if lcos is not None else None,
        "total_revenue_lifetime": round(total_revenue_lifetime, 0),
        "total_opex_lifetime": round(total_opex_lifetime, 0),
        "total_discharge_mwh": round(total_discharge_mwh, 0),
        "min_dscr": min((r["dscr"] for r in yearly if r["dscr"] is not None), default=None),
        "avg_dscr": round(
            sum(r["dscr"] for r in yearly if r["dscr"] is not None) /
            max(1, sum(1 for r in yearly if r["dscr"] is not None)), 2),
    }

    return {
        "inputs": asdict(inputs),
        "summary": summary,
        "yearly": yearly,
        "amortisation": schedule,
    }


# ---- Sensitivity ---------------------------------------------------------

def tornado(inputs: BessFinanceInputs) -> list[dict]:
    """Tornado-chart data: vary each driver ±X% and report the resulting
    equity IRR delta. Caller renders these as horizontal bars sorted by
    absolute delta.

    Variables varied: cycles_per_day ±20%, net arbitrage margin ±20%, FCAS
    price exposure ±50%, CapEx ±15%, interest rate ±200bp.

    RTE is intentionally not varied independently here because the calibrated
    net arbitrage margin already embeds RTE.  To test a different RTE, rerun
    the historical backtest so dispatch and the net margin are recalibrated.
    """
    base = project_cashflow(inputs)
    base_eq_irr = base["summary"]["equity_irr_pct"]
    if base_eq_irr is None:
        return []

    drivers = [
        ("cycles_per_day", 0.20, "Cycles per day"),
        ("arb_spread_per_mwh", 0.20, "Captured energy cash margin $/MWh"),
        ("fcas_revenue_per_mw_year", 0.50, "Observed FCAS benchmark $/MW/yr"),
        ("capex_aud", 0.15, "CapEx"),
        ("interest_rate_pct", 200, "Interest rate (bp)"),    # absolute bp, not %
    ]

    out = []
    for attr, delta_pct, label in drivers:
        # Build up/down variants
        up_kwargs = asdict(inputs); down_kwargs = asdict(inputs)
        base_val = getattr(inputs, attr)
        # Special: arb_spread / fcas_revenue may be None — use base run's
        # default (120 / 25k) so the sensitivity is meaningful.
        if base_val is None:
            if attr == "arb_spread_per_mwh": base_val = 120.0
            elif attr == "fcas_revenue_per_mw_year": base_val = 25_000.0
            else: continue
            up_kwargs[attr] = base_val; down_kwargs[attr] = base_val

        if attr in ("interest_rate_pct",):   # bp = absolute %
            up_kwargs[attr] = base_val + delta_pct / 100
            down_kwargs[attr] = base_val - delta_pct / 100
        else:                                  # relative %
            up_kwargs[attr] = base_val * (1 + delta_pct)
            down_kwargs[attr] = base_val * (1 - delta_pct)

        up_res = project_cashflow(BessFinanceInputs(**up_kwargs))
        down_res = project_cashflow(BessFinanceInputs(**down_kwargs))
        up_irr = up_res["summary"]["equity_irr_pct"]
        down_irr = down_res["summary"]["equity_irr_pct"]
        out.append({
            "driver": label,
            "base_irr_pct": base_eq_irr,
            "up_irr_pct": up_irr,
            "down_irr_pct": down_irr,
            "swing_pct": (up_irr - down_irr) if (up_irr is not None and down_irr is not None) else None,
        })

    # Sort by absolute swing desc
    out.sort(key=lambda r: abs(r["swing_pct"] or 0), reverse=True)
    return out
