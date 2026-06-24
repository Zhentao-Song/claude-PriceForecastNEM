"""BESS-Calc — project finance modelling for new BESS investments.

Two endpoints:
  GET  /api/bess/defaults  — recommended assumptions for a given region,
                             pre-calibrated from real historical RRP/FCAS data.
  POST /api/bess/model     — full 20-year cashflow + IRR + sensitivity.

The defaults endpoint is the bridge between our real NEM data and the
pure-function finance model: it reads the last N days of
`nem_dispatch_price` to estimate daily arbitrage spread and FCAS revenue
per MW, then hands those as `arb_spread_per_mwh` + `fcas_revenue_per_mw_year`
into BessFinanceInputs.
"""
from __future__ import annotations

from datetime import datetime, timedelta

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from ..bess_finance import BessFinanceInputs, project_cashflow, tornado
from ..bess_backtest import run_full_backtest
from ..db import locked_conn
from ..scrapers.backfill import get_mmsdm_state, start_mmsdm_backfill

router = APIRouter(prefix="/api/bess", tags=["bess-calc"])

NEM_REGIONS = {"NSW1", "QLD1", "VIC1", "SA1", "TAS1"}

# Region-level MLF baseline (representative 2024-25 values from AEMO
# published transmission MLF tables; transmission-connected BESS sit in
# this range — exact value is per DUID).
REGION_MLF: dict[str, float] = {
    "NSW1": 0.985,
    "QLD1": 0.982,
    "VIC1": 0.972,
    "SA1":  0.965,
    "TAS1": 0.952,
}


# ---- MLF helpers ---------------------------------------------------------

CURRENT_MLF_FY = "2025-26"


def _regional_mlf_from_db(con, region: str, fy: str = CURRENT_MLF_FY) -> float | None:
    """Capacity-weighted average MLF for a region from the nem_mlf table.

    Returns None when the table is empty (fresh install before DB seed).
    The caller falls back to REGION_MLF in that case.
    """
    row = con.execute(
        """
        SELECT SUM(mlf * COALESCE(capacity_mw, 1)) / SUM(COALESCE(capacity_mw, 1))
        FROM nem_mlf
        WHERE region = ? AND financial_year = ?
        """,
        (region, fy),
    ).fetchone()
    if row and row[0] is not None:
        return round(float(row[0]), 4)
    return None


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


def _historical_arb_spread(region: str, lookback_days: int = 90,
                            top_hours: int = 4) -> dict | None:
    """Daily arbitrage spread distribution for a region.

    For each day in the lookback window:
        spread = avg(top 4h RRP) − avg(bottom 4h RRP)
    This captures what a BESS doing 1 cycle/day could realistically earn
    per MWh discharged (before round-trip losses + fees).

    Returns a dict with mean / median / p25 / p75 / last_7d_mean /
    min / max / n_days so the UI can show "typical $148, recent $165,
    range $95–$205" instead of one opaque number. Returns None when
    not enough data is available (typical right after install).
    """
    nowdt = datetime.utcnow() + timedelta(hours=10)
    cutoff = (nowdt - timedelta(days=lookback_days)).strftime("%Y-%m-%d %H:%M:%S")
    cutoff_7d = (nowdt - timedelta(days=7)).strftime("%Y-%m-%d %H:%M:%S")
    with locked_conn() as con:
        rows = con.execute(
            """
            SELECT DATE(settlementdate), rrp, settlementdate
            FROM nem_dispatch_price
            WHERE regionid = ? AND settlementdate >= ? AND rrp IS NOT NULL
            """,
            (region, cutoff),
        ).fetchall()
    if not rows:
        return None
    by_day: dict[str, list[float]] = {}
    recent_days: set[str] = set()
    for d, p, ts in rows:
        by_day.setdefault(d, []).append(float(p))
        if str(ts) >= cutoff_7d:
            recent_days.add(d)
    n_per_hour = 12
    n_top = top_hours * n_per_hour
    spreads: list[float] = []
    spreads_7d: list[float] = []
    for d, prices in by_day.items():
        if len(prices) < n_top * 2:
            continue
        sorted_p = sorted(prices)
        bottom_avg = sum(sorted_p[:n_top]) / n_top
        top_avg = sum(sorted_p[-n_top:]) / n_top
        spread = top_avg - bottom_avg
        spreads.append(spread)
        if d in recent_days:
            spreads_7d.append(spread)
    if not spreads:
        return None
    spreads_sorted = sorted(spreads)
    return {
        "mean":           sum(spreads) / len(spreads),
        "median":         _quantile(spreads_sorted, 0.5),
        "p25":            _quantile(spreads_sorted, 0.25),
        "p75":            _quantile(spreads_sorted, 0.75),
        "min":            spreads_sorted[0],
        "max":            spreads_sorted[-1],
        "last_7d_mean":   (sum(spreads_7d) / len(spreads_7d)) if spreads_7d else None,
        "n_days":         len(spreads),
        "lookback_days":  lookback_days,
    }


def _historical_fcas_per_mw_year(region: str, lookback_days: int = 30,
                                   utilisation: float = 0.35) -> dict | None:
    """FCAS revenue per MW per year, calibrated from cleared FCAS RRPs.

    Returns dict with daily distribution stats + per-market breakdown.
    The "default" value the UI uses is `per_mw_year_after_util`, which is
    `raw_per_mw_year × utilisation`. Utilisation = 0.35 reflects that a
    BESS sharing capacity between energy arbitrage and FCAS can't keep
    100% MW in FCAS 24/7.
    """
    nowdt = datetime.utcnow() + timedelta(hours=10)
    cutoff = (nowdt - timedelta(days=lookback_days)).strftime("%Y-%m-%d %H:%M:%S")
    cutoff_7d = (nowdt - timedelta(days=7)).strftime("%Y-%m-%d %H:%M:%S")
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
    by_day: dict[str, float] = {}
    by_day_7d: dict[str, float] = {}
    market_totals = [0.0] * len(fcas_cols)
    market_intervals = 0
    for r in rows:
        ts = r[0]
        prices = [float(p or 0) for p in r[1:]]
        day = str(ts)[:10]
        # Per-interval per-MW $ = sum(prices) × 5/60   (prices are $/MW/h)
        rev_per_mw = sum(prices) * (5.0 / 60.0)
        by_day[day] = by_day.get(day, 0) + rev_per_mw
        if str(ts) >= cutoff_7d:
            by_day_7d[day] = by_day_7d.get(day, 0) + rev_per_mw
        for i, p in enumerate(prices):
            market_totals[i] += p
        market_intervals += 1
    if not by_day:
        return None
    daily_vals = sorted(by_day.values())
    daily_mean = sum(daily_vals) / len(daily_vals)
    # Per-market avg annualised $/MW (raw — no utilisation)
    market_breakdown: dict[str, float] = {}
    if market_intervals > 0:
        for i, col in enumerate(fcas_cols):
            avg_price = market_totals[i] / market_intervals   # $/MW/h
            market_breakdown[col.replace("_rrp", "").upper()] = round(avg_price * 8760, 0)
    raw_per_mw_year = daily_mean * 365
    last_7d_daily_mean = (sum(by_day_7d.values()) / len(by_day_7d)) if by_day_7d else None
    # Annualised + utilisation-adjusted 7d value so the UI can compare
    # like-for-like with the main `per_mw_year_after_util` figure. Without
    # this the strip mixed daily and annual units (genuine bug).
    last_7d_per_mw_year_after_util = (
        round(last_7d_daily_mean * 365 * utilisation, 0)
        if last_7d_daily_mean is not None else None
    )
    return {
        "raw_per_mw_year":                  round(raw_per_mw_year, 0),
        "utilisation":                      utilisation,
        "per_mw_year_after_util":           round(raw_per_mw_year * utilisation, 0),
        "daily_mean":                       daily_mean,
        "daily_median":                     _quantile(daily_vals, 0.5),
        "daily_p25":                        _quantile(daily_vals, 0.25),
        "daily_p75":                        _quantile(daily_vals, 0.75),
        "last_7d_daily_mean":               last_7d_daily_mean,
        "last_7d_per_mw_year_after_util":   last_7d_per_mw_year_after_util,
        "n_days":                           len(by_day),
        "lookback_days":                    lookback_days,
        "by_market_per_mw_year":            market_breakdown,
    }


# ---- /defaults ------------------------------------------------------------

@router.get("/defaults")
def bess_defaults(region: str = Query("NSW1"),
                   lookback_days: int = Query(90, ge=7, le=365)) -> dict:
    """Recommended BESS finance inputs for the chosen region.

    Returns the FULL BessFinanceInputs object pre-populated with:
      - Region-specific MLF (from REGION_MLF table)
      - arb_spread_per_mwh derived from last N days of RRP history
      - fcas_revenue_per_mw_year derived from last 30 days of FCAS RRPs
      - Industry-standard defaults for everything else

    Each value comes back with a `provenance` tag so the UI can show
    "this number is calibrated from real data" vs "this is an industry
    default — feel free to override".
    """
    region = region.upper()
    if region not in NEM_REGIONS:
        raise HTTPException(400, f"region must be one of {sorted(NEM_REGIONS)}")

    spread_stats = _historical_arb_spread(region, lookback_days)
    fcas_stats = _historical_fcas_per_mw_year(region)

    # Real MLF from nem_mlf table (capacity-weighted FY average).
    # Falls back to hardcoded REGION_MLF when the table is empty.
    with locked_conn() as con:
        db_mlf = _regional_mlf_from_db(con, region)
    real_mlf    = db_mlf if db_mlf is not None else REGION_MLF.get(region, 0.98)
    mlf_source  = "db" if db_mlf is not None else "regional_baseline"

    # If we have NO data (fresh DB), fall back to representative NSW
    # numbers so the UI still shows a sane starting point.
    spread_fallback = {"NSW1": 150, "QLD1": 140, "VIC1": 130, "SA1": 160, "TAS1": 80}
    fcas_fallback   = {"NSW1": 30_000, "QLD1": 28_000, "VIC1": 25_000, "SA1": 35_000, "TAS1": 15_000}

    # Point estimates fed into the finance model.
    # For arb spread we use the MEDIAN (more robust than mean — NSW has
    # big positive-skew outliers from spike events that mean would over-
    # weight). For FCAS we use the utilisation-adjusted annualised mean.
    arb_default = round(spread_stats["median"], 1) if spread_stats else float(spread_fallback[region])
    fcas_default = float(fcas_stats["per_mw_year_after_util"]) if fcas_stats else float(fcas_fallback[region])

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
        "cycles_per_day": 1.2,
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
        "fcas_decline_pct_year": 8.0,
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
            "note": (
                f"AEMO {CURRENT_MLF_FY} capacity-weighted regional avg "
                f"({real_mlf:.4f}), {region}"
                if mlf_source == "db"
                else f"AEMO 2024-25 representative for {region}"
            ),
        },
        "arb_spread_per_mwh": {
            "source": "historical" if spread_stats else "fallback",
            "note": (f"Top 4h vs bottom 4h daily spread, last {lookback_days}d of {region} RRP"
                     if spread_stats else "no historical data yet — using NSW representative starter"),
            "stats": ({
                "value": round(spread_stats["median"], 1),     # point used
                "mean":  round(spread_stats["mean"], 1),
                "median": round(spread_stats["median"], 1),
                "p25": round(spread_stats["p25"], 1),
                "p75": round(spread_stats["p75"], 1),
                "min": round(spread_stats["min"], 1),
                "max": round(spread_stats["max"], 1),
                "last_7d_mean": round(spread_stats["last_7d_mean"], 1) if spread_stats["last_7d_mean"] is not None else None,
                "n_days": spread_stats["n_days"],
                "lookback_days": spread_stats["lookback_days"],
                "unit": "$/MWh",
                "label": "Daily arb spread (top 4h − bottom 4h)",
            } if spread_stats else None),
        },
        "fcas_revenue_per_mw_year": {
            "source": "historical" if fcas_stats else "fallback",
            "note": ("10-market sum × 0.35 utilisation, last 30d"
                     if fcas_stats else "no historical data yet — using NSW representative starter"),
            "stats": ({
                "value": round(fcas_stats["per_mw_year_after_util"], 0),
                "raw_per_mw_year": round(fcas_stats["raw_per_mw_year"], 0),
                "utilisation": fcas_stats["utilisation"],
                "daily_mean": round(fcas_stats["daily_mean"], 0),
                "daily_median": round(fcas_stats["daily_median"], 0),
                "daily_p25": round(fcas_stats["daily_p25"], 0),
                "daily_p75": round(fcas_stats["daily_p75"], 0),
                "last_7d_daily_mean": round(fcas_stats["last_7d_daily_mean"], 0) if fcas_stats["last_7d_daily_mean"] is not None else None,
                # 7d value shown in the CalibrationStrip — same units as `value`
                # so the strip's "7d X" is apples-to-apples with the input box.
                "last_7d_mean": fcas_stats["last_7d_per_mw_year_after_util"],
                "n_days": fcas_stats["n_days"],
                "lookback_days": fcas_stats["lookback_days"],
                "by_market": fcas_stats["by_market_per_mw_year"],
                "unit": "$/MW/yr",
                "label": f"Cleared FCAS revenue, last {fcas_stats['lookback_days']}d {region}",
            } if fcas_stats else None),
        },
        # Hardcoded industry-standard defaults
        "rte_pct":                  {"source": "industry", "note": "Lithium 2024 typical"},
        "cycles_per_day":           {"source": "industry", "note": "Arb-led BESS average"},
        "degradation_pct_year":     {"source": "industry", "note": "Lithium ~1.5-2.5%/yr"},
        "opex_per_kw_year":         {"source": "industry", "note": "AEMO ISP cost assumption"},
        "insurance_per_mwh_year":   {"source": "industry"},
        "fcas_decline_pct_year":    {"source": "industry", "note": "BESS saturation 2026-2030 trend"},
        "discount_rate_pct":        {"source": "industry", "note": "Infrastructure WACC benchmark"},
        "tax_rate_pct":             {"source": "regulatory", "note": "Australian corporate 30%"},
        "depreciation_life_years":  {"source": "regulatory", "note": "ATO storage assets (DV 18.18%)"},
        "inflation_pct":            {"source": "industry", "note": "RBA inflation target midpoint"},
        "augmentation_capex_pct":   {"source": "industry", "note": "Year-12 cell replacement"},
        "nuos_per_mw_year":         {"source": "industry", "note": "TNSP/DNSP charge typical"},
        "land_rent_aud_year":       {"source": "industry"},
    }
    return {
        "region": region,
        "lookback_days": lookback_days,
        "inputs": defaults,
        "provenance": provenance,
    }


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

    defaults = bess_defaults(region=region, lookback_days=90)["inputs"]

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
    prov = bess_defaults(region=region, lookback_days=90)["provenance"]
    result["provenance"] = prov
    return result


# ---- /backtest ------------------------------------------------------------

class BessBacktestRequest(BaseModel):
    """Backtest a specific BESS spec against historical RRP.

    The backtest finds the *economically-optimal* cycle count for each
    individual day rather than using a fixed cycles/day assumption: it
    adds dispatch intervals (best-price sell + cheapest-price buy) until
    the marginal net revenue equals the marginal battery degradation cost.
    """
    region: str = Field("NSW1")
    power_mw: float = Field(..., gt=0)
    duration_h: float = Field(..., gt=0)
    rte_pct: float = Field(88.0, gt=50, le=100)
    mlf: float = Field(0.985, gt=0.5, le=1.05)
    aux_load_pct: float = Field(1.5, ge=0, le=10)
    lookback_days: int = Field(365, ge=30, le=730)
    capture_efficiency: float = Field(0.80, gt=0, le=1)
    fcas_utilisation: float = Field(0.35, ge=0, le=1)
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
def bess_backtest(req: BessBacktestRequest) -> dict:
    """Simulate the BESS over historical RRP data with per-day optimal cycling.

    Each day the algorithm finds how many 5-min intervals to dispatch by
    comparing marginal spread revenue against marginal degradation cost —
    more cycles on spike days, fewer (or zero) on flat days.

    Returns annual_total_revenue_aud + energy{..., mean_cycles_per_day,
    n_days_idle, cycle_histogram, ...} + fcas{...}.
    """
    region = req.region.upper()
    if region not in NEM_REGIONS:
        raise HTTPException(400, f"region must be one of {sorted(NEM_REGIONS)}")
    result = run_full_backtest(
        region=region,
        power_mw=req.power_mw, duration_h=req.duration_h,
        rte_pct=req.rte_pct,
        mlf=req.mlf, aux_load_pct=req.aux_load_pct,
        lookback_days=req.lookback_days,
        capture_efficiency=req.capture_efficiency,
        fcas_utilisation=req.fcas_utilisation,
        deg_cost_per_mwh=req.deg_cost_per_mwh,
        max_cycles_per_day=req.max_cycles_per_day,
    )
    return result


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
