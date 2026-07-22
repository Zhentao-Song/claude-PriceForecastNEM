"""BESS-Calc — project finance modelling for new BESS investments.

Two endpoints:
  GET  /api/bess/defaults  — recommended assumptions for a given region,
                             pre-calibrated from real historical RRP/FCAS data.
  POST /api/bess/model     — full 20-year cashflow + IRR + sensitivity.

The defaults endpoint is the bridge between real NEM data and the
pure-function finance model.  SA comparator benchmarks use public DUID-level
dispatch and actual per-service FCAS enablement; no regional-price utilisation
proxy is fed into project cashflow.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from functools import wraps
from threading import Lock

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from ..bess_finance import BessFinanceInputs, project_cashflow, tornado
from ..bess_backtest import run_energy_backtest, run_full_backtest
from ..bess_benchmarks import observed_bess_benchmarks, target_bess_benchmark
from ..db import locked_conn
from ..scrapers.backfill import get_mmsdm_state, start_mmsdm_backfill

router = APIRouter(prefix="/api/bess", tags=["bess-calc"])

NEM_REGIONS = {"NSW1", "QLD1", "VIC1", "SA1", "TAS1"}
_DEFAULTS_CACHE: dict[tuple[str, int, int], dict] = {}
_DEFAULTS_LOCK = Lock()
_BACKTEST_CACHE: dict[tuple, dict] = {}
_BACKTEST_LOCK = Lock()


def _serialised_defaults(func):
    """Deduplicate simultaneous defaults/model calibration requests."""
    @wraps(func)
    def wrapped(*args, **kwargs):
        with _DEFAULTS_LOCK:
            return func(*args, **kwargs)
    return wrapped


def _serialised_backtest(func):
    """Coalesce duplicate full backtests triggered by UI reloads."""
    @wraps(func)
    def wrapped(*args, **kwargs):
        with _BACKTEST_LOCK:
            return func(*args, **kwargs)
    return wrapped

# ---- Real-data calibration helpers ---------------------------------------

def _quantile(sorted_vals: list[float], q: float) -> float:
    """Linear-interpolation quantile, q ∈ [0, 1]. Pure-python so we don't
    add numpy just for one helper."""
    if not sorted_vals:
        return 0.0
    if q <= 0: return sorted_vals[0]
    if q >= 1: return sorted_vals[-1]
    pos = q * (len(sorted_vals) - 1)
    lo = int(pos)
    hi = min(lo + 1, len(sorted_vals) - 1)
    frac = pos - lo
    return sorted_vals[lo] * (1 - frac) + sorted_vals[hi] * frac


# ---- /defaults ------------------------------------------------------------

@router.get("/defaults")
@_serialised_defaults
def bess_defaults(region: str = Query("NSW1"),
                   lookback_days: int = Query(90, ge=7, le=365)) -> dict:
    """Recommended BESS finance inputs for the chosen region.

    Returns the FULL BessFinanceInputs object pre-populated with:
      - Neutral MLF placeholder pending a project connection-point input
      - arb_spread_per_mwh: captured cash margin per discharged MWh
      - fcas_revenue_per_mw_year: zero until calibrated from DUID actuals
      - Industry-standard defaults for everything else

    Each value comes back with a `provenance` tag so the UI can show
    "this number is calibrated from real data" vs "this is an industry
    default — feel free to override".
    """
    region = region.upper()
    if region not in NEM_REGIONS:
        raise HTTPException(400, f"region must be one of {sorted(NEM_REGIONS)}")

    # Defaults are expensive because they include one LP per complete day.
    # Cache within the current five-minute market interval so the initial
    # defaults request and subsequent finance-model requests stay responsive,
    # while still refreshing as new dispatch prices arrive.
    cache_bucket = int(datetime.utcnow().timestamp()) // 300
    cache_key = (region, int(lookback_days), cache_bucket)
    cached = _DEFAULTS_CACHE.get(cache_key)
    if cached is not None:
        return cached

    # MLF is connection-point/DUID specific.  A regional capacity-weighted
    # average is not a valid project assumption (and can be polluted by
    # reserve-trader/interconnector records), so use a neutral placeholder
    # until the user supplies the project's connection-point MLF.
    real_mlf = 1.0
    mlf_source = "project_input_required"

    # Defaults use the theoretical energy upper bound only as a temporary
    # starter.  The SA UI replaces it with the observed-comparator median as
    # soon as /benchmarks returns.  No hidden 80% capture haircut is applied.
    energy_stats = run_energy_backtest(
        region,
        power_mw=100.0,
        duration_h=2.0,
        rte_pct=88.0,
        lookback_days=lookback_days,
        capture_efficiency=1.0,
        mlf=real_mlf,
        aux_load_pct=1.5,
        deg_cost_per_mwh=35.0,
        max_cycles_per_day=2.0,
    )

    margin_days = (
        [
            float(day["captured_market_margin_per_mwh"])
            for day in energy_stats["daily_results"]
            if float(day["discharge_mwh"]) > 1e-6
        ]
        if energy_stats else []
    )
    margin_days_sorted = sorted(margin_days)
    last_7_margin_days = margin_days[-7:]

    # If we have NO data (fresh DB), fall back to representative NSW
    # numbers so the UI still shows a sane starting point.
    margin_fallback = {"NSW1": 90, "QLD1": 85, "VIC1": 80, "SA1": 100, "TAS1": 55}
    # Point estimates fed into the finance model.
    arb_default = (
        round(float(energy_stats["captured_market_margin_per_mwh"]), 3)
        if energy_stats else float(margin_fallback[region])
    )
    cycles_default = (
        round(float(energy_stats["mean_cycles_per_day"]), 4)
        if energy_stats else 1.2
    )
    # Never feed a regional-price proxy into project cashflow.  FCAS remains
    # zero until a DUID-observed comparator benchmark is available.
    fcas_default = 0.0

    defaults = {
        # Asset spec: caller will overwrite
        "region": region,
        "power_mw": 100.0,
        "duration_h": 2.0,
        "capex_aud": 80_000_000.0,
        # Capital structure
        "debt_pct": 60.0,
        "interest_rate_pct": 6.5,
        "loan_tenor_years": 10,
        # Engineering
        "rte_pct": 88.0,
        "cycles_per_day": cycles_default,
        "degradation_pct_year": 2.0,
        "aux_load_pct": 1.5,
        "mlf": real_mlf,
        "project_life_years": 20,
        "augmentation_capex_pct": 15.0,
        "augmentation_year": 12,
        # OpEx
        "opex_per_kw_year": 10.0,
        "insurance_per_mwh_year": 2.0,
        "land_rent_aud_year": 50_000.0,
        "nuos_per_mw_year": 8000.0,
        # Revenue (calibrated from real data if we have it)
        "arb_spread_per_mwh": arb_default,
        "fcas_revenue_per_mw_year": fcas_default,
        "fcas_decline_pct_year": 0.0,
        "cis_floor_revenue_per_mw_year": 0.0,
        # Financial
        "discount_rate_pct": 7.0,
        "tax_rate_pct": 30.0,
        "depreciation_life_years": 18,
        "inflation_pct": 2.5,
    }
    # Provenance: every input gets a tag + (where applicable) a `stats`
    # block. The UI uses `stats` to render the calibration strip below
    # each input: "median 148 · IQR 95-205 · last 7d 165".
    provenance = {
        "mlf": {
            "source": mlf_source,
            "note": "Enter the project connection-point/DUID MLF; regional averaging is disabled",
        },
        "arb_spread_per_mwh": {
            "source": "historical" if energy_stats else "fallback",
            "note": (
                f"Perfect-foresight energy upper bound, last {lookback_days}d of {region}; "
                "cash margin after RTE, MLF and aux; SA comparator calibration loads separately"
                if energy_stats else "no complete historical data — using representative net-margin starter"
            ),
            "stats": ({
                "value": arb_default,
                "mean": round(sum(margin_days) / len(margin_days), 1) if margin_days else 0,
                "median": round(_quantile(margin_days_sorted, 0.5), 1),
                "p25": round(_quantile(margin_days_sorted, 0.25), 1),
                "p75": round(_quantile(margin_days_sorted, 0.75), 1),
                "min": round(margin_days_sorted[0], 1) if margin_days_sorted else 0,
                "max": round(margin_days_sorted[-1], 1) if margin_days_sorted else 0,
                "last_7d_mean": (
                    round(sum(last_7_margin_days) / len(last_7_margin_days), 1)
                    if last_7_margin_days else None
                ),
                "n_days": energy_stats["n_days_backtested"],
                "lookback_days": lookback_days,
                "unit": "$/MWh",
                "label": "Captured energy cash margin per discharged MWh",
            } if energy_stats else None),
        },
        "fcas_revenue_per_mw_year": {
            "source": "unmodelled",
            "note": "Excluded until calibrated from DUID-level actual FCAS enablement",
            "stats": None,
        },
        # Hardcoded industry-standard defaults
        "rte_pct":                  {"source": "industry", "note": "Lithium 2024 typical"},
        "cycles_per_day": {
            "source": "historical" if energy_stats else "industry",
            "note": (
                f"Chronological SOC backtest average over {energy_stats['n_days_backtested']} complete days"
                if energy_stats else "Arbitrage-led BESS starter"
            ),
        },
        "degradation_pct_year":     {"source": "industry", "note": "Lithium ~1.5-2.5%/yr"},
        "opex_per_kw_year":         {"source": "industry", "note": "AEMO ISP cost assumption"},
        "insurance_per_mwh_year":   {"source": "industry"},
        "fcas_decline_pct_year":    {"source": "unmodelled", "note": "Explicit user scenario; no automatic decline is assumed"},
        "discount_rate_pct":        {"source": "industry", "note": "Infrastructure WACC benchmark"},
        "tax_rate_pct":             {"source": "regulatory", "note": "Australian corporate 30%"},
        "depreciation_life_years":  {"source": "regulatory", "note": "ATO storage assets (DV 18.18%)"},
        "inflation_pct":            {"source": "industry", "note": "RBA inflation target midpoint"},
        "augmentation_capex_pct":   {"source": "industry", "note": "Year-12 cell replacement"},
        "nuos_per_mw_year":         {"source": "industry", "note": "TNSP/DNSP charge typical"},
        "land_rent_aud_year":       {"source": "industry"},
    }
    payload = {
        "region": region,
        "lookback_days": lookback_days,
        "inputs": defaults,
        "provenance": provenance,
    }
    _DEFAULTS_CACHE.clear()
    _DEFAULTS_CACHE[cache_key] = payload
    return payload


# ---- /model ---------------------------------------------------------------

class BessModelRequest(BaseModel):
    """Subset of BessFinanceInputs that's user-driven. Anything omitted
    falls back to /defaults values."""
    region: str = Field("NSW1")
    power_mw: float = Field(..., gt=0)
    duration_h: float = Field(..., gt=0)
    capex_aud: float = Field(..., gt=0)
    debt_pct: float = Field(60.0, ge=0, le=100)
    interest_rate_pct: float = Field(6.5, ge=0, le=30)
    loan_tenor_years: int = Field(10, ge=0, le=30)

    rte_pct: float | None = None
    cycles_per_day: float | None = None
    degradation_pct_year: float | None = None
    aux_load_pct: float | None = None
    mlf: float | None = None
    project_life_years: int | None = None
    augmentation_capex_pct: float | None = None
    augmentation_year: int | None = None

    opex_per_kw_year: float | None = None
    insurance_per_mwh_year: float | None = None
    land_rent_aud_year: float | None = None
    nuos_per_mw_year: float | None = None

    arb_spread_per_mwh: float | None = None
    fcas_revenue_per_mw_year: float | None = None
    fcas_decline_pct_year: float | None = None
    cis_floor_revenue_per_mw_year: float | None = None

    discount_rate_pct: float | None = None
    tax_rate_pct: float | None = None
    depreciation_life_years: int | None = None
    inflation_pct: float | None = None


@router.post("/model")
def bess_model(req: BessModelRequest, with_sensitivity: bool = Query(True)) -> dict:
    """Project cashflow + IRR + sensitivity for the supplied BESS spec.

    Any field set to None on the request will pull from /defaults — so a
    minimal client can POST just {region, power_mw, duration_h, capex_aud,
    debt_pct, interest_rate_pct, loan_tenor_years} and get a full model
    back using historically-calibrated revenue assumptions.
    """
    region = req.region.upper()
    if region not in NEM_REGIONS:
        raise HTTPException(400, f"region must be one of {sorted(NEM_REGIONS)}")

    defaults_payload = bess_defaults(region=region, lookback_days=90)
    defaults = defaults_payload["inputs"]

    # Merge: user values win, otherwise defaults.
    merged = {**defaults}
    user_dict = req.model_dump(exclude_none=True)
    merged.update(user_dict)

    inputs = BessFinanceInputs(**merged)
    result = project_cashflow(inputs)
    if with_sensitivity:
        result["sensitivity"] = tornado(inputs)
    else:
        result["sensitivity"] = []
    # Include provenance so the UI can flag derived-from-real-data vs default.
    result["provenance"] = defaults_payload["provenance"]
    return result


# ---- /backtest ------------------------------------------------------------

class BessBacktestRequest(BaseModel):
    """Backtest a specific BESS spec against historical RRP.

    Energy uses a chronological perfect-foresight LP with explicit SOC,
    power, round-trip efficiency, daily cyclic SOC and a warranty-cycle cap.
    FCAS is deliberately excluded here and is supplied only through the
    observed DUID benchmark endpoint.
    """
    region: str = Field("NSW1")
    power_mw: float = Field(..., gt=0)
    duration_h: float = Field(..., gt=0)
    rte_pct: float = Field(88.0, gt=50, le=100)
    mlf: float = Field(0.985, gt=0.5, le=1.05)
    aux_load_pct: float = Field(1.5, ge=0, le=10)
    lookback_days: int = Field(365, ge=30, le=730)
    capture_efficiency: float = Field(1.0, gt=0, le=1)
    # Dynamic dispatch parameters
    deg_cost_per_mwh: float = Field(
        35.0, ge=0, le=500,
        description=(
            "Marginal degradation cost in $/MWh discharged. "
            "LFP default: ~$175/kWh replacement × 1000 kWh/MWh ÷ 5 000 cycle life = $35/MWh. "
            "Higher value → fewer cycles on low-spread days."
        ),
    )
    max_cycles_per_day: float = Field(
        2.0, gt=0, le=6,
        description="Hard cap on cycles per day (thermal / warranty limit).",
    )


@router.post("/backtest")
@_serialised_backtest
def bess_backtest(req: BessBacktestRequest) -> dict:
    """Return the SOC-constrained energy upper bound; FCAS is excluded."""
    region = req.region.upper()
    if region not in NEM_REGIONS:
        raise HTTPException(400, f"region must be one of {sorted(NEM_REGIONS)}")

    cache_bucket = int(datetime.utcnow().timestamp()) // 300
    cache_key = (
        cache_bucket,
        region,
        req.power_mw,
        req.duration_h,
        req.rte_pct,
        req.mlf,
        req.aux_load_pct,
        req.lookback_days,
        req.capture_efficiency,
        req.deg_cost_per_mwh,
        req.max_cycles_per_day,
    )
    cached = _BACKTEST_CACHE.get(cache_key)
    if cached is not None:
        return cached

    result = run_full_backtest(
        region=region,
        power_mw=req.power_mw, duration_h=req.duration_h,
        rte_pct=req.rte_pct,
        mlf=req.mlf, aux_load_pct=req.aux_load_pct,
        lookback_days=req.lookback_days,
        capture_efficiency=req.capture_efficiency,
        deg_cost_per_mwh=req.deg_cost_per_mwh,
        max_cycles_per_day=req.max_cycles_per_day,
    )
    for old_key in list(_BACKTEST_CACHE):
        if old_key[0] != cache_bucket:
            del _BACKTEST_CACHE[old_key]
    _BACKTEST_CACHE[cache_key] = result
    return result


@router.get("/benchmarks")
def bess_benchmarks(
    region: str = Query("SA1"),
    power_mw: float = Query(250.0, gt=0),
    duration_h: float = Query(4.0, gt=0),
    rte_pct: float = Query(88.0, gt=50, le=100),
    mlf: float = Query(1.0, gt=0.5, le=1.05),
    aux_load_pct: float = Query(1.5, ge=0, le=10),
    deg_cost_per_mwh: float = Query(35.0, ge=0, le=500),
    max_cycles_per_day: float = Query(2.0, gt=0, le=6),
    calibrated: bool = Query(True),
) -> dict:
    """Observed SA BESS revenue and a comparator-calibrated target range."""
    region = region.upper()
    if region not in NEM_REGIONS:
        raise HTTPException(400, f"region must be one of {sorted(NEM_REGIONS)}")
    if not calibrated:
        return observed_bess_benchmarks(region)
    return target_bess_benchmark(
        region,
        round(power_mw, 4),
        round(duration_h, 4),
        round(rte_pct, 4),
        round(mlf, 6),
        round(aux_load_pct, 4),
        round(deg_cost_per_mwh, 4),
        round(max_cycles_per_day, 4),
    )


# ---- /backfill — one-click 365-day data top-up ----------------------------

@router.post("/backfill")
def bess_start_backfill(
    lookback_days: int = Query(400, ge=90, le=730,
                               description="Days of price history to ensure"),
) -> dict:
    """Trigger background download of missing months from the AEMO MMSDM
    archive so the backtest has a full year of data. Safe to call repeatedly
    — months already in the DB are skipped. Returns immediately; poll
    /api/bess/backfill/status for progress."""
    started = start_mmsdm_backfill(lookback_days=lookback_days)
    state = get_mmsdm_state()
    return {
        "started": started,
        "already_running": not started,
        "months_to_fill": state.get("months_total", 0),
        **state,
    }


@router.get("/backfill/status")
def bess_backfill_status() -> dict:
    """Current state of the MMSDM price backfill job."""
    state = get_mmsdm_state()
    # Also report current DB coverage so the UI can show before/after.
    with locked_conn() as con:
        rows = con.execute(
            """
            SELECT COUNT(DISTINCT substr(settlementdate,1,10))
            FROM nem_dispatch_price WHERE regionid = 'NSW1'
            """
        ).fetchone()
    state["db_days_nsw1"] = int(rows[0]) if rows else 0
    return state


# ---- Real-time BESS dispatch recommendation --------------------------------

@router.get("/dispatch-plan")
def get_dispatch_plan(
    duid: str = Query("WTAHB1", description="BESS DUID to plan for"),
    region: str = Query("NSW1", description="NEM region for price lookup"),
    n_intervals: int = Query(24, ge=1, le=72, description="Forecast horizon (5-min intervals, max 72 = 6h)"),
):
    """Generate a real-time BESS dispatch recommendation.

    Uses the current SoC from `paper_bess_state` plus AEMO P5MIN/PREDISPATCH
    forecast prices to recommend charge / discharge / idle actions for the
    next `n_intervals` × 5-minute intervals.

    Optimisation strategy
    ----------------------
    * Sort forecast intervals by price.
    * Assign discharge to the highest-priced slots (revenue maximising).
    * Assign charge to the lowest-priced slots (cheapest recharge).
    * Both assignments are bounded by SoC headroom and the spread threshold
      (charge-price must be low enough vs. discharge-price to cover RTE losses
      + MLF cost, i.e. expected net spread > min_spread_threshold).
    * Idle when no profitable spread exists.

    Returns per-interval plan with action, expected revenue, and SoC trajectory.
    """
    region = region.upper()
    if region not in NEM_REGIONS:
        raise HTTPException(400, f"Unknown region '{region}'. Use one of: {sorted(NEM_REGIONS)}")

    with locked_conn() as con:
        # 1. Current BESS state
        state_row = con.execute(
            """
            SELECT capacity_mwh, power_mw, rte_pct, soc_mwh, mlf
            FROM paper_bess_state WHERE duid = ?
            """,
            (duid,),
        ).fetchone()
        if state_row is None:
            raise HTTPException(404, f"BESS DUID '{duid}' not found in paper_bess_state")

        capacity_mwh, power_mw, rte_pct, soc_mwh, mlf = state_row
        rte = rte_pct / 100.0

        # 2. Compute NEM-time "now" (UTC + 10 h).
        #    All dispatch intervals are stored in NEM time (naive, no tz).
        nem_now = (datetime.utcnow() + timedelta(hours=10)).strftime("%Y-%m-%d %H:%M:%S")

        # Fetch future intervals only (interval_datetime > now).
        # Priority rule: P5MIN covers ~1h at 5-min resolution; PREDISPATCH
        # covers ~40h at 30-min resolution. Where both exist for the same
        # interval (e.g. on-the-hour :30/:00 boundaries), P5MIN wins because
        # its run_datetime is fresher (5-min publication cycle vs 30-min).
        # CASE sort: P5MIN=0, PREDISPATCH=1 → ascending puts P5MIN first
        # in the result set so the dedup below picks it for shared intervals.
        forecast_rows = con.execute(
            """
            SELECT interval_datetime, COALESCE(rrp, 0.0) AS rrp, source
            FROM nem_predispatch_price
            WHERE regionid = ?
              AND rrp IS NOT NULL
              AND interval_datetime > ?
            ORDER BY
              CASE WHEN source = 'P5MIN' THEN 0 ELSE 1 END,  -- P5MIN first
              interval_datetime
            LIMIT ?
            """,
            (region, nem_now, n_intervals * 4),   # over-fetch; dedup below
        ).fetchall()

        # Deduplicate per interval: first occurrence wins (P5MIN thanks to sort)
        seen: dict[str, tuple[float, str]] = {}
        for iv, rrp, src in forecast_rows:
            if iv not in seen:
                seen[iv] = (rrp, src)
        intervals_sorted = sorted(seen.items())[:n_intervals]   # chronological

    if not intervals_sorted:
        raise HTTPException(503, "No P5MIN/PREDISPATCH data for region — try again in a moment")

    n = len(intervals_sorted)
    # Per-interval duration in hours. P5MIN = 5-min dispatch intervals (5/60).
    # PREDISPATCH = 30-min trading periods (30/60). Revenue and SoC changes
    # are scaled by the actual duration so a PREDISPATCH discharge earns 6×
    # what a single 5-min dispatch interval earns at the same price.
    def interval_hours(src: str) -> float:
        return 5.0 / 60.0 if src == "P5MIN" else 30.0 / 60.0

    # Representative interval size for SoC-budget arithmetic (use smallest unit
    # = 5 min so we don't over-allocate slots on the PREDISPATCH side).
    mwh_per_5min = power_mw * (5.0 / 60.0)

    min_soc = capacity_mwh * 0.05   # 5 % DoD floor
    max_soc = capacity_mwh * 0.95   # 95 % ceiling

    # 3. Build price index and determine charge / discharge assignment.
    #    Each interval has a different energy capacity:
    #      P5MIN    →  power_mw × 5/60  MWh
    #      PREDISPATCH → power_mw × 30/60 MWh
    prices  = [rrp for _, (rrp, _) in intervals_sorted]
    sources = [src for _, (_, src) in intervals_sorted]
    ivh     = [interval_hours(src) for src in sources]   # hours per interval
    iv_mwh  = [power_mw * h for h in ivh]               # max MWh per interval

    idx_by_price_asc = sorted(range(n), key=lambda i: prices[i])

    # Minimum net spread to justify dispatch ($/MWh discharged).
    # net = discharge_price × mlf − charge_price / (rte × mlf)
    MIN_NET_SPREAD = 30.0

    actions: list[str] = ["idle"] * n

    # ── Step 1: Assign discharge slots ──────────────────────────────────
    # Highest-priced intervals first, limited by available SoC headroom.
    dischg_budget_mwh = max(0.0, soc_mwh - min_soc)
    dischg_used = 0.0
    for idx in reversed(idx_by_price_asc):
        remaining = dischg_budget_mwh - dischg_used
        if remaining <= 0:
            break
        actions[idx] = "discharge"
        dischg_used += min(iv_mwh[idx], remaining)

    # ── Step 2: Assign charge slots ──────────────────────────────────────
    # Only charge enough to *replenish* what we plan to discharge,
    # i.e. charge_input_budget = dischg_used / rte. This prevents the
    # optimiser charging speculatively for energy it won't dispatch in
    # the current horizon.
    charge_input_budget = dischg_used / rte           # MWh of charge input needed
    capacity_headroom   = (max_soc - soc_mwh) / rte  # physical headroom cap
    charge_budget_mwh   = min(charge_input_budget, capacity_headroom)

    # Only charge if it makes economic sense vs best discharge price.
    dischg_prices = [prices[i] for i in range(n) if actions[i] == "discharge"]
    best_d = max(dischg_prices) if dischg_prices else 0.0

    charge_used = 0.0
    for idx in idx_by_price_asc:
        remaining = charge_budget_mwh - charge_used
        if remaining <= 0:
            break
        if actions[idx] == "discharge":
            continue    # don't double-book
        p_charge = prices[idx]
        net = best_d * mlf - p_charge / (rte * mlf)
        if net < MIN_NET_SPREAD:
            break   # remaining charge prices don't yield profitable spread
        actions[idx] = "charge"
        charge_used += min(iv_mwh[idx], remaining)

    # 4. Simulate SoC trajectory and compute revenue
    plan: list[dict] = []
    current_soc = soc_mwh
    total_rev = 0.0

    for i, (interval_dt, (price, source)) in enumerate(intervals_sorted):
        action  = actions[i]
        h       = interval_hours(source)          # 5/60 for P5MIN, 30/60 for PREDISPATCH
        mwh_cap = power_mw * h                    # max energy in this interval
        rev     = 0.0
        soc_after = current_soc

        if action == "discharge" and current_soc > min_soc:
            actual_mwh = min(mwh_cap, current_soc - min_soc)
            rev = actual_mwh * price * mlf
            soc_after = current_soc - actual_mwh
        elif action == "charge" and current_soc < max_soc:
            space = max_soc - current_soc          # MWh of free headroom
            charge_in_mwh = min(mwh_cap, space / rte)
            energy_stored = charge_in_mwh * rte
            rev = -charge_in_mwh * price / mlf    # cost (negative)
            soc_after = current_soc + energy_stored
        else:
            action = "idle"
            rev = 0.0

        current_soc = max(min_soc, min(max_soc, soc_after))
        total_rev += rev

        plan.append({
            "interval":             interval_dt,
            "source":               source,
            "interval_minutes":     5 if source == "P5MIN" else 30,
            "action":               action,
            "power_mw":             power_mw if action != "idle" else 0.0,
            "price_forecast_aud":   round(price, 2),
            "expected_revenue_aud": round(rev, 2),
            "soc_after_mwh":        round(current_soc, 2),
            "soc_after_pct":        round(current_soc / capacity_mwh * 100, 1),
        })

    # Summary statistics
    discharge_intervals = [p for p in plan if p["action"] == "discharge"]
    charge_intervals    = [p for p in plan if p["action"] == "charge"]
    avg_discharge_price = (
        sum(p["price_forecast_aud"] for p in discharge_intervals) / len(discharge_intervals)
        if discharge_intervals else None
    )
    avg_charge_price = (
        sum(p["price_forecast_aud"] for p in charge_intervals) / len(charge_intervals)
        if charge_intervals else None
    )

    return {
        "duid":                    duid,
        "region":                  region,
        "generated_at":            datetime.utcnow().isoformat() + "Z",
        "current_soc_mwh":         round(soc_mwh, 2),
        "current_soc_pct":         round(soc_mwh / capacity_mwh * 100, 1),
        "capacity_mwh":            capacity_mwh,
        "power_mw":                power_mw,
        "mlf":                     mlf,
        "rte_pct":                 rte_pct,
        "n_intervals":             n,
        "horizon_minutes":         n * 5,
        "expected_total_revenue_aud": round(total_rev, 2),
        "n_discharge":             len(discharge_intervals),
        "n_charge":                len(charge_intervals),
        "n_idle":                  sum(1 for p in plan if p["action"] == "idle"),
        "avg_discharge_price":     round(avg_discharge_price, 2) if avg_discharge_price is not None else None,
        "avg_charge_price":        round(avg_charge_price, 2) if avg_charge_price is not None else None,
        "plan":                    plan,
    }
