"""VPP (Virtual Power Plant) trading console API.

Aggregator-style bidding for a C&I fleet of BESS + EV chargers, with full
AEMO compliance: 10-band monotonic bid ladder (NER 3.8.6A.1), gate closure
at T-5min (NER 3.8.20), per-resource capability check, fleet aggregated
co-optimisation trapezium, rebid reason codes (NER 3.8.22A).

Mirrors the existing paper.py architecture but generalised for a fleet:
  * `paper_bid` → `vpp_bid` (with allocation_json showing per-resource split)
  * `paper_bess_state` → `vpp_portfolio` + `vpp_resource` (1-to-N)
  * Settlement still TODO — bids go to PENDING and stay there for now;
    we'll wire settlement once the bid surface is validated end-to-end.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from ..db import locked_conn

router = APIRouter(prefix="/api/vpp", tags=["vpp"])

INTERVAL_MIN = 5
GATE_BUFFER_SECONDS = 30      # same buffer as paper.py
MAX_BANDS = 10
MPF = -1000                    # AEMO market price floor
MPC = 17500                    # AEMO market price cap (2024-25)

# Markets the same as paper.py for symmetry.
ENERGY = "ENERGY"
RAISE_FCAS = {"RAISEREG", "RAISE5MIN", "RAISE60SEC", "RAISE6SEC", "RAISE1SEC"}
LOWER_FCAS = {"LOWERREG", "LOWER5MIN", "LOWER60SEC", "LOWER6SEC", "LOWER1SEC"}
REG_FCAS = {"RAISEREG", "LOWERREG"}
ALL_MARKETS = {ENERGY} | RAISE_FCAS | LOWER_FCAS

REBID_REASON_CODES = {
    "INITIAL", "PRICE", "FORECAST", "DEMAND", "OUTAGE",
    "RAMP", "ENERGY_LIMIT", "TEMPERATURE", "STRATEGY", "OTHER",
}

# Required FCAS response time per market (T1+T2 must fit within this).
# Source: NER 4.4 + AEMO Market Ancillary Service Specification (MASS).
FCAS_RESPONSE_WINDOW_SEC: dict[str, float] = {
    "RAISE1SEC": 1.0,   "LOWER1SEC": 1.0,
    "RAISE6SEC": 6.0,   "LOWER6SEC": 6.0,
    "RAISE60SEC": 60.0, "LOWER60SEC": 60.0,
    "RAISE5MIN": 300.0, "LOWER5MIN": 300.0,
    # Regulation is continuous SCADA — T1+T2 typically ≤ 4s. Strictly
    # MASS says <4s ramp from 0 to full capability for new units.
    "RAISEREG": 4.0,    "LOWERREG": 4.0,
}


# ---- Time helpers ---------------------------------------------------------

def _nem_now() -> datetime:
    return datetime.utcnow() + timedelta(hours=10)


def _parse_iso(s: str) -> datetime:
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        try:
            return datetime.strptime(s, "%Y-%m-%d %H:%M:%S")
        except ValueError as e:
            raise HTTPException(400, f"invalid timestamp '{s}': {e}")


def _trading_date_for(interval_dt: datetime) -> date:
    """NEM trading day boundary at 04:00 (NER 3.4.1)."""
    return (interval_dt - timedelta(hours=4, minutes=1)).date()


def _ceil_to_dispatch(now: datetime) -> datetime:
    m = now.minute - (now.minute % 5)
    base = now.replace(minute=m, second=0, microsecond=0)
    if base <= now:
        base += timedelta(minutes=5)
    return base


def _check_gate_closure(target_iso: str, *, action: str = "submit") -> None:
    """Raise 400 if we're past the AEMO bid lock for `target_iso`.
    Same logic as paper.py — keeps the two surfaces in sync."""
    target = _parse_iso(target_iso).replace(second=0, microsecond=0)
    gate = target - timedelta(minutes=INTERVAL_MIN, seconds=GATE_BUFFER_SECONDS)
    now = _nem_now()
    if now >= gate:
        raise HTTPException(
            400,
            f"gate closure for {target_iso} was at {gate.isoformat()} "
            f"({(now - gate).total_seconds():.0f}s ago) — AEMO rejects "
            f"{action} calls post-gate (NER 3.8.20)",
        )


# ---- Schemas --------------------------------------------------------------

class Band(BaseModel):
    price: float = Field(..., ge=MPF, le=MPC,
                         description=f"Price in $/MWh, clamped to AEMO bounds [{MPF}, {MPC}]")
    mw: float = Field(..., ge=0, description="Availability at this band, in MW")


class FcasTrapezium(BaseModel):
    """FCAS co-optimisation trapezium (NER 3.8.7A + MASS).

    Defines how much FCAS capacity is available at each ENERGY dispatch
    level. NEMDE uses this to jointly clear ENERGY + FCAS so the unit
    doesn't double-book physical headroom.
    """
    enablement_min_mw: float = Field(..., description="ENERGY dispatch below this -> 0 FCAS available")
    low_breakpoint_mw: float = Field(..., description="ENERGY dispatch at this -> full FCAS available")
    high_breakpoint_mw: float = Field(..., description="ENERGY dispatch at this -> still full FCAS")
    enablement_max_mw: float = Field(..., description="ENERGY dispatch above this -> 0 FCAS available")
    # Response time profile (seconds). Sum of T1+T2 must satisfy the
    # market's required response window.
    t1_sec: float = Field(..., ge=0, description="Response delay (s)")
    t2_sec: float = Field(..., ge=0, description="Ramp to full capability (s)")
    t3_sec: float = Field(..., ge=0, description="Sustain duration (s)")
    t4_sec: float = Field(..., ge=0, description="Release time (s)")


class VppBidIn(BaseModel):
    portfolio_id: str = Field("NSW_CI_VPP")
    target_settlementdate: str = Field(..., description="ISO timestamp, NEM time")
    market: str = Field(..., description="ENERGY or one of 10 FCAS keys")
    direction: str = Field(..., description="GEN or LOAD")
    bands: list[Band] = Field(..., min_length=1, max_length=MAX_BANDS)
    notes: str | None = None
    rebid_reason: str | None = Field(
        None, description="One of: INITIAL/PRICE/FORECAST/DEMAND/OUTAGE/RAMP/ENERGY_LIMIT/TEMPERATURE/STRATEGY/OTHER",
    )
    # Optional explicit per-resource allocation. If omitted, the server
    # proportionally allocates the bid envelope across all eligible
    # sub-resources by their available capacity right now.
    allocation: list[dict] | None = Field(
        None,
        description='Optional list of {"resource_id": "...", "alloc_kw": N} entries',
    )
    replaces_bid_id: int | None = None

    # ----- AEMO BIDPEROFFER + BIDDAYOFFER extras (all optional) -----
    max_avail_mw: float | None = Field(
        None, ge=0,
        description="Independent hard cap on total dispatch for this "
                    "interval (BIDPEROFFER.MaxAvail). NEMDE won't enable "
                    "more than this regardless of cleared bands.",
    )
    daily_energy_constraint_mwh: float | None = Field(
        None, ge=0,
        description="BIDDAYOFFER.DailyEnergyConstraint — MWh cap for THIS "
                    "DUID across all intervals of the trading day. Critical "
                    "for BESS to prevent over-committing total throughput.",
    )
    ramp_up_mw_per_min: float | None = Field(None, gt=0)
    ramp_down_mw_per_min: float | None = Field(None, gt=0)
    fcas_trapezium: FcasTrapezium | None = None


class VppTradingDayIn(BaseModel):
    """BIDDAYOFFER-style trading-day bulk submission.

    One price ladder + one set of operational parameters applied to
    every OPEN dispatch interval in the trading day. The server fans
    this out into N standalone vpp_bid rows (one per 5-min interval),
    all tagged with the same `trading_day_batch_id` so they show up as
    a single batch in the UI.
    """
    portfolio_id: str = Field("NSW_CI_VPP")
    trading_date: str = Field(..., description="YYYY-MM-DD, NEM trading day boundary 04:00")
    market: str
    direction: str
    bands: list[Band] = Field(..., min_length=1, max_length=MAX_BANDS)
    max_avail_mw: float | None = Field(None, ge=0)
    daily_energy_constraint_mwh: float | None = Field(None, ge=0)
    ramp_up_mw_per_min: float | None = Field(None, gt=0)
    ramp_down_mw_per_min: float | None = Field(None, gt=0)
    fcas_trapezium: FcasTrapezium | None = None
    # Optional per-interval MaxAvail override: [{"interval": "ISO", "max_avail_mw": N}, ...].
    # Lets the operator submit a base bid + shape MW only where it differs
    # (e.g. lower availability during planned maintenance windows).
    per_interval_overrides: list[dict] | None = None
    notes: str | None = None
    rebid_reason: str | None = None


# ---- Validation -----------------------------------------------------------

def _validate_bands(bands: list[Band]) -> list[dict]:
    """Monotonic strictly-ascending price check + MW range. Returns the
    cleaned list of {price, mw} dicts ready for JSON storage."""
    if len(bands) == 0:
        raise HTTPException(400, "at least one band required")
    if len(bands) > MAX_BANDS:
        raise HTTPException(400, f"max {MAX_BANDS} bands per market (NER 3.8.6)")
    cleaned: list[dict] = []
    for b in bands:
        if not (MPF <= b.price <= MPC):
            raise HTTPException(400, f"band price ${b.price} outside [{MPF}, {MPC}]")
        if b.mw < 0:
            raise HTTPException(400, f"band MW {b.mw} cannot be negative")
        cleaned.append({"price": float(b.price), "mw": float(b.mw)})
    # Strict monotonic ascending (NER 3.8.6A.1)
    for i in range(1, len(cleaned)):
        prev_p, cur_p = cleaned[i - 1]["price"], cleaned[i]["price"]
        if cur_p <= prev_p:
            raise HTTPException(
                400,
                f"band {i+1}: price ${cur_p:.2f} must be strictly greater "
                f"than band {i} price ${prev_p:.2f} (AEMO requires monotonic "
                f"ascending bands, NER 3.8.6A.1)",
            )
    return cleaned


def _validate_max_avail(bands: list[dict], max_avail_mw: float | None) -> float:
    """Returns the effective MaxAvail for the bid. If user omitted it,
    defaults to sum(bands.mw). Otherwise clamp it (MaxAvail < sum is
    valid AEMO behaviour — top bands just never reach dispatch)."""
    sum_mw = sum(float(b.get("mw", 0)) for b in bands)
    if max_avail_mw is None:
        return sum_mw
    if max_avail_mw < 0:
        raise HTTPException(400, "max_avail_mw cannot be negative")
    return float(max_avail_mw)


def _validate_ramp(ramp_up: float | None, ramp_down: float | None,
                   *, market: str) -> None:
    """Ramp rates are MW/min. NEMDE uses them between consecutive
    intervals; without them the inter-interval transition is unbounded.
    For ENERGY they should generally cover going from current dispatch
    to max_avail within 5min (i.e. ramp_rate × 5 ≥ swing MW)."""
    for name, val in (("ramp_up_mw_per_min", ramp_up),
                       ("ramp_down_mw_per_min", ramp_down)):
        if val is not None and val <= 0:
            raise HTTPException(400, f"{name} must be > 0 MW/min")
    # FCAS bids don't strictly need ramp rates (FCAS is a separate market
    # from ENERGY ramp), but real participants still supply them so NEMDE
    # can compute the joint envelope. We don't enforce.


def _validate_fcas_trapezium(market: str, trap: FcasTrapezium | None,
                              max_avail_mw: float) -> None:
    """Trapezium consistency + response-time check. Only required for
    FCAS markets (skipped for ENERGY)."""
    if market not in (RAISE_FCAS | LOWER_FCAS):
        if trap is not None:
            raise HTTPException(
                400, f"fcas_trapezium is only valid for FCAS markets, got {market}",
            )
        return
    if trap is None:
        return  # optional even for FCAS — NEMDE will treat as rectangular
    # Monotonic check
    pts = [trap.enablement_min_mw, trap.low_breakpoint_mw,
           trap.high_breakpoint_mw, trap.enablement_max_mw]
    if not all(pts[i] <= pts[i+1] + 1e-9 for i in range(3)):
        raise HTTPException(
            400,
            f"Trapezium points must satisfy enablement_min ≤ low_breakpoint ≤ "
            f"high_breakpoint ≤ enablement_max; got "
            f"{trap.enablement_min_mw}/{trap.low_breakpoint_mw}/"
            f"{trap.high_breakpoint_mw}/{trap.enablement_max_mw}",
        )
    # FCAS plateau height = max_avail; can't promise more FCAS than total
    # availability. Real BIDPEROFFER ties trapezium plateau to MaxAvail.
    if max_avail_mw <= 0:
        raise HTTPException(400, "FCAS bid must have MaxAvail > 0")
    # Response window check
    window = FCAS_RESPONSE_WINDOW_SEC.get(market)
    if window is not None:
        response = trap.t1_sec + trap.t2_sec
        if response > window + 0.01:
            raise HTTPException(
                400,
                f"{market} requires full response within {window:.0f}s "
                f"(MASS); T1+T2 = {response:.2f}s exceeds. Reduce delay or "
                f"ramp-up time, or pick a slower FCAS market.",
            )
    # Hold + release sanity
    if trap.t3_sec <= 0:
        raise HTTPException(400, "T3 (hold duration) must be > 0s")


def _check_daily_energy_constraint(
    portfolio_id: str, target: datetime,
    market: str, direction: str,
    bands: list[dict], max_avail_mw: float,
    daily_energy_mwh: float | None,
) -> None:
    """If the user set a DailyEnergyConstraint, check it against ALREADY
    settled + ALREADY pending bids for this DUID on the same trading day.
    Real NEMDE enforces this at day-ahead optimisation; we enforce at
    submit time per-DUID per-direction (charge vs discharge tracked
    separately — they don't offset, since both consume battery cycles)."""
    if daily_energy_mwh is None or daily_energy_mwh <= 0:
        return
    if market != ENERGY:
        return  # constraint applies to ENERGY only (FCAS is capacity)
    # NEM trading day [04:00 today, 04:00 tomorrow)
    trading_date = _trading_date_for(target)
    day_start = datetime.combine(trading_date, datetime.min.time()) + timedelta(hours=4)
    day_end = day_start + timedelta(days=1)
    day_start_s = day_start.strftime("%Y-%m-%d %H:%M:%S")
    day_end_s = day_end.strftime("%Y-%m-%d %H:%M:%S")

    with locked_conn() as con:
        # Already settled (signed mwh — abs it for the cap, since charge
        # and discharge BOTH consume battery throughput).
        settled_mwh = con.execute(
            """
            SELECT COALESCE(SUM(ABS(energy_mwh)), 0)
            FROM vpp_fill
            WHERE portfolio_id = ? AND market = 'ENERGY' AND direction = ?
              AND settlementdate >= ? AND settlementdate < ?
            """,
            (portfolio_id, direction, day_start_s, day_end_s),
        ).fetchone()[0] or 0
        # Already-pending bids on same DUID/direction/day — count their
        # worst-case throughput so we don't allow overlapping bids to
        # collectively breach the cap.
        pending_rows = con.execute(
            """
            SELECT bands_json, max_avail_mw FROM vpp_bid
            WHERE portfolio_id = ? AND market = 'ENERGY' AND direction = ?
              AND status = 'PENDING'
              AND target_settlementdate >= ? AND target_settlementdate < ?
            """,
            (portfolio_id, direction, day_start_s, day_end_s),
        ).fetchall()
    pending_mwh = 0.0
    for bands_json, prev_max_avail in pending_rows:
        try:
            prev_bands = json.loads(bands_json or "[]")
        except Exception:
            continue
        prev_sum = sum(float(b.get("mw", 0)) for b in prev_bands)
        cap = float(prev_max_avail) if prev_max_avail is not None else prev_sum
        # 5-min interval = 1/12 h
        pending_mwh += min(prev_sum, cap) * (INTERVAL_MIN / 60.0)

    # This bid's worst-case throughput
    this_max_mw = min(sum(float(b.get("mw", 0)) for b in bands), max_avail_mw)
    this_mwh = this_max_mw * (INTERVAL_MIN / 60.0)

    projected = float(settled_mwh) + pending_mwh + this_mwh
    if projected > daily_energy_mwh + 1e-6:
        raise HTTPException(
            400,
            f"DailyEnergyConstraint breach: {direction} cap is "
            f"{daily_energy_mwh:.2f} MWh/day, already accounted "
            f"{settled_mwh:.2f} MWh settled + {pending_mwh:.2f} MWh pending. "
            f"This bid adds {this_mwh:.2f} MWh (projected {projected:.2f}). "
            f"Lower MW or MaxAvail, or shed pending bids.",
        )


def _validate_market_direction(market: str, direction: str) -> None:
    if market not in ALL_MARKETS:
        raise HTTPException(400, f"unknown market '{market}'; valid: {sorted(ALL_MARKETS)}")
    direction = direction.upper()
    if direction not in ("GEN", "LOAD"):
        raise HTTPException(400, f"direction must be GEN or LOAD, got '{direction}'")
    # FCAS direction sanity
    if market in RAISE_FCAS and direction != "GEN":
        raise HTTPException(400, f"{market} requires direction=GEN (RAISE = inject/curtail-load)")
    if market in LOWER_FCAS and direction != "LOAD":
        raise HTTPException(400, f"{market} requires direction=LOAD (LOWER = absorb/charge)")


def _resources_for(portfolio_id: str) -> list[dict]:
    with locked_conn() as con:
        rows = con.execute(
            """
            SELECT resource_id, kind, site_name, lat, lon,
                   nameplate_kw, capacity_kwh, rte_pct, soc_kwh, availability_now,
                   window_start_hr, window_end_hr,
                   can_inject, can_curtail, can_raise_fcas, can_lower_fcas, can_reg_fcas,
                   max_events_per_day, max_duration_min, recovery_min,
                   mlf, opted_in, dispatch_type, retail_plan
            FROM vpp_resource WHERE portfolio_id = ? ORDER BY resource_id
            """,
            (portfolio_id,),
        ).fetchall()
    cols = ["resource_id","kind","site_name","lat","lon",
            "nameplate_kw","capacity_kwh","rte_pct","soc_kwh","availability_now",
            "window_start_hr","window_end_hr",
            "can_inject","can_curtail","can_raise_fcas","can_lower_fcas","can_reg_fcas",
            "max_events_per_day","max_duration_min","recovery_min",
            "mlf","opted_in","dispatch_type","retail_plan"]
    return [dict(zip(cols, r)) for r in rows]


def _resource_channels(r: dict) -> list[str]:
    """The set of market-access channels this resource can serve, based
    on its dispatch_type + retail_plan + capability flags. Used by the
    UI to label each row ("which money taps are connected to this site?")
    and by `_resource_eligible` to gate FCAS for non-scheduled assets.

    Channels (mirrors real-world AEMO C&I VPP plumbing):
      * 'wholesale_full'      — scheduled / semi_scheduled with can_inject.
                                Full NEMDE access: ENERGY GEN/LOAD + all FCAS.
      * 'embedded_generation' — non_scheduled BTM resource with can_inject
                                AND retail_plan='wholesale_passthrough'.
                                Earns RRP × MWh × MLF passively (NER 2.2.5)
                                via the retailer; NO FCAS access.
      * 'wdr'                 — any resource with can_curtail. Non-scheduled
                                load-side curtailment paid against a baseline
                                (NER 3.8.2A).
      * 'customer_tou'        — every site can do customer-side TOU
                                shifting / peak shaving for the host.
    """
    out: list[str] = []
    dt = r.get("dispatch_type") or "non_scheduled"
    rp = r.get("retail_plan") or "wholesale_passthrough"
    if dt in ("scheduled", "semi_scheduled") and r.get("can_inject"):
        out.append("wholesale_full")
    if dt == "non_scheduled" and r.get("can_inject") and rp == "wholesale_passthrough":
        out.append("embedded_generation")
    if r.get("can_curtail"):
        out.append("wdr")
    out.append("customer_tou")
    return out


def _resource_eligible(r: dict, market: str, direction: str, target: datetime) -> bool:
    """Can this resource take a slice of this (market, direction) bid for
    the given target interval? Checks capability flags + opt-in + window
    + dispatch-type channel rules."""
    if not r["opted_in"]:
        return False
    # Time-of-day window check (inclusive start, exclusive end; supports wrap
    # at midnight: window 22→6 means 22:00–24:00 + 00:00–06:00).
    h = target.hour
    s, e = int(r["window_start_hr"]), int(r["window_end_hr"])
    in_window = (s < e and s <= h < e) or (s > e and (h >= s or h < e)) or (s == e)
    if not in_window:
        return False

    dispatch_type = (r.get("dispatch_type") or "non_scheduled").lower()
    retail_plan = (r.get("retail_plan") or "wholesale_passthrough").lower()
    is_scheduled = dispatch_type in ("scheduled", "semi_scheduled")

    # ----- Capability + channel gating --------------------------------
    if market == ENERGY:
        # GEN: needs can_inject + a valid channel to monetise. Scheduled
        # resources go via wholesale; non_scheduled need the embedded-gen
        # channel (can_inject + wholesale_passthrough retail plan).
        if direction == "GEN":
            if not r["can_inject"]:
                return False
            if not is_scheduled and retail_plan != "wholesale_passthrough":
                # Non-scheduled BTM with a TOU/FiT plan can't pass through
                # to RRP — refuse to include it in the wholesale envelope.
                return False
        # LOAD = WDR / charge. Anyone with can_curtail can participate;
        # the WDR baseline check inside settlement enforces verifiable
        # reduction.
        if direction == "LOAD" and not r["can_curtail"]:
            return False
    elif market in REG_FCAS:
        if not r["can_reg_fcas"]: return False
        if not is_scheduled: return False     # FCAS = scheduled only
    elif market in RAISE_FCAS:
        if not r["can_raise_fcas"]: return False
        if not is_scheduled: return False
    elif market in LOWER_FCAS:
        if not r["can_lower_fcas"]: return False
        if not is_scheduled: return False
    return True


def _max_kw_available(r: dict, *, market: str = ENERGY, direction: str = "GEN") -> float:
    """How many kW this resource can dispatch right now toward the target
    market/direction.

    BESS physical constraints (binding for ENERGY only — FCAS is a
    capacity-availability product, not a sustained energy delivery):
      • GEN  : cannot discharge more than soc_kwh worth of energy in one
               5-min interval. max_kw = soc_kwh / (5/60) = soc_kwh × 12.
      • LOAD : cannot charge more than (capacity − soc) worth in one
               interval. max_kw = (capacity − soc) × 12.
    For FCAS we use nameplate × availability without SoC constraint
    because being "enabled" doesn't mean sustained dispatch.

    EV chargers have no SoC — `availability_now` reflects how many plugs
    are actively charging (only those can be curtailed). Returns nameplate
    × availability_now for all market/direction combinations they can
    legitimately serve.
    """
    base = float(r["nameplate_kw"]) * float(r["availability_now"])
    if r["kind"] == "bess" and market == ENERGY:
        soc = float(r["soc_kwh"])
        cap = float(r["capacity_kwh"])
        # 5 min = 1/12 of an hour → kW that sustains 5 min = kWh × 12
        per_5min_factor = 60.0 / INTERVAL_MIN
        if direction == "GEN":
            soc_limited = soc * per_5min_factor
        else:  # LOAD
            headroom = max(0.0, cap - soc)
            soc_limited = headroom * per_5min_factor
        return max(0.0, min(base, soc_limited))
    return base


def _aggregate_envelope(portfolio_id: str, market: str, direction: str,
                        target: datetime) -> tuple[float, list[dict]]:
    """Sum of eligible resources' max-available kW = the upper bound on
    total bid MW for this (market, direction) at this target interval.
    Returns (envelope_kw, list_of_eligible_resources)."""
    resources = _resources_for(portfolio_id)
    eligible = [r for r in resources if _resource_eligible(r, market, direction, target)]
    envelope = sum(_max_kw_available(r, market=market, direction=direction)
                   for r in eligible)
    return envelope, eligible


def _allocate_proportional(
    bands: list[dict], eligible: list[dict],
    *, market: str = ENERGY, direction: str = "GEN",
) -> list[dict]:
    """Spread the bid's TOTAL commitment (sum of all band MWs — worst case
    if all bands clear) proportionally across the eligible resources by
    their SoC-aware max-available kW.

    AEMO band semantics treat each band as independent availability at
    its price, so the upper envelope is sum(bands.mw), not max — using
    the sum here keeps the allocation accurate for the worst case.
    """
    total_mw = sum(float(b.get("mw", 0)) for b in bands)
    total_kw = total_mw * 1000
    pool_kw = sum(_max_kw_available(r, market=market, direction=direction)
                  for r in eligible)
    if pool_kw <= 0 or total_kw <= 0:
        return []
    out = []
    for r in eligible:
        share = _max_kw_available(r, market=market, direction=direction) / pool_kw
        out.append({
            "resource_id": r["resource_id"],
            "alloc_kw": round(total_kw * share, 1),
        })
    return out


# ---- Customer-contract limits (events/day, duration, recovery) ----------

def _check_customer_contract_limits(
    eligible: list[dict],
    target: datetime,
    portfolio_id: str,
) -> list[str]:
    """For each eligible resource, verify that a new ENERGY dispatch at
    `target` does not violate the per-customer commitments encoded in the
    resource row:

      * max_events_per_day  — events already settled today + 1
      * max_duration_min    — sum of settled minutes today + 5
      * recovery_min        — last event's end + recovery_min ≤ target

    'Today' = NEM-local calendar day of the target interval. An 'event' =
    a fill_alloc row in ENERGY market for that resource. Returns a list of
    error messages (empty list = all clear). Real DR aggregators ENFORCE
    these because exceeding them leads to customer churn, not just penalty.
    """
    if not eligible:
        return []
    nem_day_start = target.replace(hour=0, minute=0, second=0, microsecond=0).strftime("%Y-%m-%d %H:%M:%S")
    nem_day_end = (target.replace(hour=0, minute=0, second=0, microsecond=0)
                   + timedelta(days=1)).strftime("%Y-%m-%d %H:%M:%S")
    target_str = target.strftime("%Y-%m-%d %H:%M:%S")
    errors: list[str] = []

    # Fetch per-resource history in ONE query for efficiency.
    rids = [r["resource_id"] for r in eligible]
    if not rids:
        return []
    placeholders = ",".join(["?"] * len(rids))
    with locked_conn() as con:
        rows = con.execute(
            f"""
            SELECT resource_id, COUNT(*), MAX(settlementdate)
            FROM vpp_fill_alloc
            WHERE resource_id IN ({placeholders})
              AND market = 'ENERGY'
              AND settlementdate >= ? AND settlementdate < ?
            GROUP BY resource_id
            """,
            (*rids, nem_day_start, nem_day_end),
        ).fetchall()
    history = {r[0]: {"event_count": int(r[1]), "last_event": r[2]} for r in rows}

    for r in eligible:
        rid = r["resource_id"]
        h = history.get(rid, {"event_count": 0, "last_event": None})
        max_events = int(r.get("max_events_per_day", 999))
        max_duration = int(r.get("max_duration_min", 1440))
        recovery = int(r.get("recovery_min", 0))

        # Event count
        if h["event_count"] + 1 > max_events:
            errors.append(
                f"{r['site_name']}: dispatching would exceed customer "
                f"contract limit of {max_events} events/day "
                f"(already {h['event_count']} settled today)"
            )
            continue
        # Cumulative duration: each event = 5 min.
        cumulative_min = (h["event_count"] + 1) * INTERVAL_MIN
        if cumulative_min > max_duration:
            errors.append(
                f"{r['site_name']}: total dispatch today would be "
                f"{cumulative_min} min, exceeding customer cap of "
                f"{max_duration} min/day"
            )
            continue
        # Recovery between events. last_event is the previous interval
        # end; the next ALLOWED interval starts at last_event + INTERVAL_MIN
        # + recovery_min.
        if h["last_event"] and recovery > 0:
            last_str = h["last_event"]
            if isinstance(last_str, datetime):
                last_dt = last_str
            else:
                last_dt = datetime.fromisoformat(str(last_str).replace(" ", "T")[:19])
            earliest_next = last_dt + timedelta(minutes=INTERVAL_MIN + recovery)
            if target < earliest_next:
                wait_min = int((earliest_next - target).total_seconds() / 60)
                errors.append(
                    f"{r['site_name']}: still in {recovery}-min recovery "
                    f"after last event at {last_dt:%H:%M}; next dispatch "
                    f"allowed at {earliest_next:%H:%M} (wait {wait_min} min)"
                )
    return errors


# ---- Endpoints ------------------------------------------------------------

@router.get("/competitors")
def vpp_competitors() -> dict:
    """Real VPPs / DER aggregators / WDR units registered with AEMO, plus
    the FCAS markets each one actually bids.

    Sources: nem_facility_registry (weekly MMSDM PARTICIPANT_REGISTRATION
    scrape) name-matched for VPP/aggregator patterns + the WDR 'DR…' DUID
    prefix, joined against nem_bidday_offer for live bidding activity.
    Bid volumes are AEMO D+1 disclosure — same data ez2view charges for.
    Units that are registered but have never bid in our 14-day window are
    dropped (dormant registrations would just be noise)."""
    with locked_conn() as con:
        units = con.execute(
            """
            SELECT duid, station, region, dispatch_type, schedule_type
            FROM nem_facility_registry
            WHERE UPPER(station) LIKE '%VPP%'
               OR UPPER(station) LIKE '%VIRTUAL%'
               OR UPPER(station) LIKE '%AGGREG%'
               OR UPPER(station) LIKE '%RESPONSE%'
               -- WDR units carry the DR… prefix; fuel IS NULL excludes
               -- coincidental matches like DRYCGT* (Dry Creek gas turbines).
               OR (duid LIKE 'DR%' AND fuel IS NULL)
            ORDER BY station
            """
        ).fetchall()
        duids = [u[0] for u in units]
        markets: dict[str, list[str]] = {}
        latest_day: dict[str, str] = {}
        if duids:
            ph = ",".join(["?"] * len(duids))
            for d, bt, mx in con.execute(
                f"""
                SELECT duid, bidtype, MAX(date(settlementdate))
                FROM nem_bidday_offer
                WHERE duid IN ({ph})
                GROUP BY duid, bidtype
                """,
                duids,
            ).fetchall():
                markets.setdefault(d, []).append(bt)
                if mx:
                    latest_day[d] = max(latest_day.get(d, ""), mx)

    out = []
    for duid, station, region, dispatch_type, schedule_type in units:
        mkts = sorted(markets.get(duid, []))
        if not mkts:
            continue
        out.append({
            "duid": duid,
            "station": station,
            "region": region,
            "dispatch_type": dispatch_type,
            "schedule_type": schedule_type,
            "markets": mkts,
            "latest_bid_day": latest_day.get(duid),
        })
    return {"units": out, "count": len(out)}


@router.get("/competitors/{duid}/summary")
def vpp_competitor_summary(duid: str) -> dict:
    """Per-market profile of one registered VPP/aggregator.

    For each FCAS market the unit bids: the latest BIDDAYOFFER price ladder
    and the peak MAXAVAIL seen in BIDPEROFFER over the last 7 days — the
    best public proxy for the aggregated fleet's real usable capacity
    (DUDETAIL registered capacity is a 1 MW placeholder for these units).
    No SCADA exists for non-scheduled aggregations, so there is no output
    chart — bids ARE the visible footprint."""
    duid = duid.upper()
    with locked_conn() as con:
        meta = con.execute(
            """
            SELECT station, region, dispatch_type, schedule_type, capacity_mw
            FROM nem_facility_registry WHERE duid = ?
            """,
            (duid,),
        ).fetchone()
        if meta is None:
            raise HTTPException(404, f"unknown DUID {duid}")

        day_rows = con.execute(
            """
            SELECT b.bidtype, b.direction, date(b.settlementdate), b.submitted_at,
                   b.priceband1, b.priceband2, b.priceband3, b.priceband4,
                   b.priceband5, b.priceband6, b.priceband7, b.priceband8,
                   b.priceband9, b.priceband10
            FROM nem_bidday_offer b
            JOIN (
                SELECT bidtype, MAX(settlementdate) AS mx
                FROM nem_bidday_offer WHERE duid = ?
                GROUP BY bidtype
            ) m ON m.bidtype = b.bidtype AND m.mx = b.settlementdate
            WHERE b.duid = ?
            """,
            (duid, duid),
        ).fetchall()

        avail_rows = con.execute(
            """
            SELECT bidtype, MAX(maxavail)
            FROM nem_bidper_offer
            WHERE duid = ?
              AND interval_datetime >= datetime('now', '+10 hours', '-7 days')
            GROUP BY bidtype
            """,
            (duid,),
        ).fetchall()

    max_avail = {r[0]: r[1] for r in avail_rows}
    markets = []
    for r in day_rows:
        prices = [r[i] for i in range(4, 14)]
        markets.append({
            "bidtype": r[0],
            "direction": r[1],
            "latest_day": r[2],
            "submitted_at": (r[3].isoformat() if isinstance(r[3], datetime)
                             else str(r[3]) if r[3] else None),
            "max_avail_mw": max_avail.get(r[0]),
            "price_min": min((p for p in prices if p is not None), default=None),
            "price_max": max((p for p in prices if p is not None), default=None),
        })
    markets.sort(key=lambda m: m["bidtype"])

    fleet_mw = max((m["max_avail_mw"] or 0) for m in markets) if markets else 0
    return {
        "duid": duid,
        "station": meta[0],
        "region": meta[1],
        "dispatch_type": meta[2],
        "schedule_type": meta[3],
        "registered_capacity_mw": meta[4],
        "fleet_max_avail_mw": fleet_mw,
        "markets": markets,
    }


@router.get("/state")
def state(portfolio_id: str = Query("NSW_CI_VPP")) -> dict:
    """Portfolio summary + per-resource live state. Drives the UI."""
    with locked_conn() as con:
        prow = con.execute(
            "SELECT portfolio_id, display_name, registered_duid, region, "
            "       cumulative_pnl_aud, updated_at, baseline_method, "
            "       classification, customer_share_pct "
            "FROM vpp_portfolio WHERE portfolio_id = ?",
            (portfolio_id,),
        ).fetchone()
    if not prow:
        raise HTTPException(404, f"portfolio '{portfolio_id}' not found")
    portfolio = {
        "portfolio_id": prow[0], "display_name": prow[1],
        "registered_duid": prow[2], "region": prow[3],
        "cumulative_pnl_aud": prow[4], "updated_at": _iso(prow[5]),
        "baseline_method": prow[6],
        "classification": prow[7],
        "customer_share_pct": prow[8],
    }
    resources = _resources_for(portfolio_id)
    # Decorate each row with its derived channel list so the UI can render
    # a "money taps" badge per site without having to recompute the rules.
    for r in resources:
        r["channels"] = _resource_channels(r)

    # Aggregate stats — total nameplate / available now / SoC across BESS.
    total_nameplate_kw = sum(r["nameplate_kw"] for r in resources if r["opted_in"])
    total_available_kw = sum(_max_kw_available(r) for r in resources if r["opted_in"])
    bess = [r for r in resources if r["kind"] == "bess"]
    ev = [r for r in resources if r["kind"] == "evcharger"]
    bess_capacity_kwh = sum(r["capacity_kwh"] for r in bess if r["opted_in"])
    bess_soc_kwh = sum(r["soc_kwh"] for r in bess if r["opted_in"])
    # Split nameplate by dispatch_type so the header can show "of 4500 kW
    # nameplate, 2300 kW is NEMDE-dispatched scheduled and 2200 kW is
    # BTM non_scheduled".
    scheduled_kw = sum(r["nameplate_kw"] for r in resources
                       if r["opted_in"]
                       and (r.get("dispatch_type") in ("scheduled", "semi_scheduled")))
    non_scheduled_kw = sum(r["nameplate_kw"] for r in resources
                            if r["opted_in"]
                            and r.get("dispatch_type") == "non_scheduled")
    return {
        "portfolio": portfolio,
        "resources": resources,
        "aggregate": {
            "total_nameplate_kw": round(total_nameplate_kw, 1),
            "total_available_now_kw": round(total_available_kw, 1),
            "resource_count": len(resources),
            "opted_in_count": sum(1 for r in resources if r["opted_in"]),
            "bess_count": len(bess),
            "ev_charger_count": len(ev),
            "bess_capacity_kwh": round(bess_capacity_kwh, 1),
            "bess_soc_kwh": round(bess_soc_kwh, 1),
            "bess_soc_pct": round((bess_soc_kwh / bess_capacity_kwh * 100)
                                  if bess_capacity_kwh > 0 else 0, 1),
            # Split nameplate by AEMO dispatch-class so the UI can label
            # "X kW NEMDE-scheduled · Y kW BTM (embedded gen + WDR)".
            "scheduled_kw": round(scheduled_kw, 1),
            "non_scheduled_kw": round(non_scheduled_kw, 1),
        },
    }


@router.get("/envelope")
def envelope(
    portfolio_id: str = Query("NSW_CI_VPP"),
    market: str = Query(ENERGY),
    direction: str = Query("GEN"),
    interval: str | None = Query(None),
) -> dict:
    """Compute the maximum biddable MW for one (market, direction, interval)
    plus the list of contributing resources. Frontend uses this to render
    'you can bid up to X MW for this interval from these N sites'."""
    market = market.upper()
    direction = direction.upper()
    _validate_market_direction(market, direction)
    target = _parse_iso(interval) if interval else _ceil_to_dispatch(_nem_now())
    target = target.replace(second=0, microsecond=0)
    envelope_kw, eligible = _aggregate_envelope(portfolio_id, market, direction, target)
    # Identify which AEMO channel this (market, direction) corresponds to
    # so the UI can label the envelope ("FCAS — wholesale only" vs
    # "ENERGY GEN — wholesale + embedded gen"). Keep channel info on each
    # eligible row so the frontend can show "via wholesale" vs "via embedded
    # generation" per site.
    if market in (RAISE_FCAS | LOWER_FCAS):
        envelope_channel = "wholesale_full"
    elif market == ENERGY and direction == "GEN":
        envelope_channel = "wholesale_or_embedded_generation"
    elif market == ENERGY and direction == "LOAD":
        envelope_channel = "wholesale_or_wdr"
    else:
        envelope_channel = "unknown"
    return {
        "interval": _iso(target),
        "market": market,
        "direction": direction,
        "envelope_kw": round(envelope_kw, 1),
        "envelope_mw": round(envelope_kw / 1000, 3),
        "channel": envelope_channel,
        "eligible_resources": [
            {
                "resource_id": r["resource_id"],
                "site_name": r["site_name"],
                "kind": r["kind"],
                "dispatch_type": r.get("dispatch_type"),
                "retail_plan": r.get("retail_plan"),
                "channels": _resource_channels(r),
                "max_kw_now": round(_max_kw_available(r), 1),
            }
            for r in eligible
        ],
    }


@router.post("/bids")
def submit_bid(bid: VppBidIn) -> dict:
    """Submit a new VPP bid. Runs full AEMO validation:
    1. monotonic strictly-ascending price bands (NER 3.8.6A.1)
    2. price range [MPF, MPC]
    3. market/direction sanity
    4. gate-closure check (T-5min, NER 3.8.20)
    5. rebid reason code is one of the allowed set (NER 3.8.22A)
    6. aggregated bid MW ≤ portfolio envelope for that interval
    """
    market = bid.market.upper()
    direction = bid.direction.upper()
    _validate_market_direction(market, direction)
    _check_gate_closure(bid.target_settlementdate, action="submit")
    cleaned_bands = _validate_bands(bid.bands)

    # DRSP_ONLY portfolios are not registered with AEMO as scheduled
    # generators — they can only bid ENERGY (interpreted as load
    # reduction via WDR) and have NO access to contingency FCAS markets.
    # Enforce that here so the bid is rejected at submit time, mirroring
    # what AEMO would do when matching the DUID against its registration.
    with locked_conn() as con:
        prow = con.execute(
            "SELECT classification FROM vpp_portfolio WHERE portfolio_id = ?",
            (bid.portfolio_id,),
        ).fetchone()
    classification = (prow and prow[0]) or 'ARU'
    if classification == 'DRSP_ONLY' and market in (RAISE_FCAS | LOWER_FCAS):
        raise HTTPException(
            400,
            f"DRSP-only portfolio cannot bid into {market} — FCAS markets "
            f"require Scheduled or ARU registration (NER 3.8). Consider "
            f"upgrading the portfolio classification.",
        )

    # Rebid reason validation
    reason = (bid.rebid_reason or "INITIAL").upper()
    if reason not in REBID_REASON_CODES:
        raise HTTPException(
            400, f"rebid_reason must be one of {sorted(REBID_REASON_CODES)} "
                 f"(NER 3.8.22A); got '{reason}'",
        )

    # Envelope check — SUM of all band MWs is the worst-case dispatch
    # (every band clears = full bid MW landed). AEMO band semantics treat
    # each band as INDEPENDENT availability at its price, so the right
    # envelope is sum, not max. Using `max` (our old behaviour) silently
    # let participants over-commit physical capacity, which is exactly the
    # kind of bug AER would fine a real participant for.
    target = _parse_iso(bid.target_settlementdate).replace(second=0, microsecond=0)
    sum_bid_mw = sum(float(b.get("mw", 0)) for b in cleaned_bands)

    # ----- New AEMO BIDPEROFFER + BIDDAYOFFER fields ------------------
    # MaxAvail: independent cap on total dispatch. Defaults to sum(bands)
    # if omitted. Effective commitment = min(sum_bands, max_avail).
    max_avail_mw = _validate_max_avail(cleaned_bands, bid.max_avail_mw)
    # Ramp rates
    _validate_ramp(bid.ramp_up_mw_per_min, bid.ramp_down_mw_per_min, market=market)
    # FCAS trapezium consistency
    _validate_fcas_trapezium(market, bid.fcas_trapezium, max_avail_mw)

    # The physical commitment AEMO would see is min(sum bands, max_avail).
    effective_commit_mw = min(sum_bid_mw, max_avail_mw)
    envelope_kw, eligible = _aggregate_envelope(bid.portfolio_id, market, direction, target)
    envelope_mw = envelope_kw / 1000
    if effective_commit_mw > envelope_mw + 1e-6:
        # Build a helpful hint when the envelope collapses because of a
        # dispatch-type mismatch — e.g. user picks RAISE6SEC but every
        # asset in the portfolio is non_scheduled (so FCAS is gated off).
        all_resources = _resources_for(bid.portfolio_id)
        n_scheduled = sum(1 for r in all_resources
                          if (r.get("dispatch_type") in ("scheduled", "semi_scheduled"))
                          and r.get("opted_in"))
        n_embedded = sum(1 for r in all_resources
                          if r.get("dispatch_type") == "non_scheduled"
                          and r.get("can_inject")
                          and r.get("retail_plan") == "wholesale_passthrough"
                          and r.get("opted_in"))
        hint = ""
        if envelope_mw < 1e-6:
            if market in (RAISE_FCAS | LOWER_FCAS) and n_scheduled == 0:
                hint = (f" Hint: {market} requires scheduled/semi-scheduled "
                        f"assets; this portfolio has 0 such resources opted-in "
                        f"(non-scheduled BTM assets cannot bid FCAS).")
            elif market == ENERGY and direction == "GEN" and n_embedded == 0 and n_scheduled == 0:
                hint = (" Hint: no eligible inject-capable resources — "
                        "either register a scheduled asset or set a BTM "
                        "BESS to wholesale_passthrough retail plan.")
        raise HTTPException(
            400,
            f"effective commitment {effective_commit_mw:.2f} MW "
            f"(min of sum-of-bands {sum_bid_mw:.2f} and MaxAvail "
            f"{max_avail_mw:.2f}) exceeds portfolio envelope {envelope_mw:.2f} MW "
            f"for {market}/{direction} at {bid.target_settlementdate}. "
            f"{len(eligible)} eligible resources; include resource SoC + "
            f"customer-contract limits in your bid sizing." + hint,
        )

    # DailyEnergyConstraint — enforced at submit so we catch breaches
    # before they accumulate. Skipped for FCAS markets (capacity payment).
    _check_daily_energy_constraint(
        bid.portfolio_id, target, market, direction,
        cleaned_bands, max_avail_mw, bid.daily_energy_constraint_mwh,
    )

    # Per-resource customer-contract limits — only meaningful for ENERGY
    # (FCAS is a capacity-availability product, doesn't count as a
    # "dispatch event" from the customer's POV). Skip for FCAS markets.
    if market == ENERGY:
        contract_errors = _check_customer_contract_limits(
            eligible, target, bid.portfolio_id,
        )
        if contract_errors:
            raise HTTPException(400, " · ".join(contract_errors))

    # Allocation: caller-provided OR proportional.
    allocation = bid.allocation
    if allocation is None:
        allocation = _allocate_proportional(
            cleaned_bands, eligible, market=market, direction=direction,
        )
    else:
        # Validate caller-provided allocation totals match sum of bands.
        total_alloc_kw = sum(float(a.get("alloc_kw", 0)) for a in allocation)
        if abs(total_alloc_kw / 1000 - sum_bid_mw) > 0.5:   # 0.5 MW tolerance
            raise HTTPException(
                400,
                f"allocation total {total_alloc_kw/1000:.2f} MW does not "
                f"match cumulative bands {sum_bid_mw:.2f} MW (±0.5 MW tolerance)",
            )
        eligible_ids = {r["resource_id"] for r in eligible}
        for a in allocation:
            rid = a.get("resource_id")
            if rid not in eligible_ids:
                raise HTTPException(
                    400, f"resource '{rid}' not eligible for {market}/{direction} "
                         f"at this interval (capability, opt-in, or window mismatch)",
                )

    # Rebid handling — chain old → new.
    prev_id = None
    if bid.replaces_bid_id is not None:
        with locked_conn() as con:
            row = con.execute(
                "SELECT bid_id, portfolio_id, target_settlementdate, market, "
                "       direction, status FROM vpp_bid WHERE bid_id = ?",
                (bid.replaces_bid_id,),
            ).fetchone()
        if not row:
            raise HTTPException(404, f"replaces_bid_id {bid.replaces_bid_id} not found")
        if row[1] != bid.portfolio_id or row[3] != market or row[4] != direction:
            raise HTTPException(
                400, "replaces_bid_id scope mismatch (portfolio/market/direction)",
            )
        if row[5] != "PENDING":
            raise HTTPException(400, f"can only rebid PENDING bids; status={row[5]}")
        prev_id = bid.replaces_bid_id

    now_str = _nem_now().strftime("%Y-%m-%d %H:%M:%S")
    # sqlite's PARSE_DECLTYPES converter for TIMESTAMP expects a SPACE
    # between date and time, not the ISO 'T'. Normalise once on the way in.
    target_str = bid.target_settlementdate.replace("T", " ")[:19]
    note_prefix = f"[{reason}] "
    notes = note_prefix + (bid.notes or "").strip()

    # Spread FCAS trapezium into individual columns so we don't have to
    # parse JSON every settlement.
    trap = bid.fcas_trapezium
    trap_cols = (
        trap.t1_sec if trap else None, trap.t2_sec if trap else None,
        trap.t3_sec if trap else None, trap.t4_sec if trap else None,
        trap.enablement_min_mw if trap else None,
        trap.enablement_max_mw if trap else None,
        trap.low_breakpoint_mw if trap else None,
        trap.high_breakpoint_mw if trap else None,
    )

    with locked_conn() as con:
        if prev_id is not None:
            con.execute("UPDATE vpp_bid SET status='CANCELLED' WHERE bid_id = ?", (prev_id,))
        cur = con.execute(
            """
            INSERT INTO vpp_bid
                (portfolio_id, target_settlementdate, market, direction,
                 submitted_at, status, bands_json, allocation_json, notes,
                 rebid_reason, previous_bid_id,
                 max_avail_mw, daily_energy_constraint_mwh,
                 ramp_up_mw_per_min, ramp_down_mw_per_min,
                 t1_sec, t2_sec, t3_sec, t4_sec,
                 enablement_min_mw, enablement_max_mw,
                 low_breakpoint_mw, high_breakpoint_mw)
            VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                bid.portfolio_id, target_str, market, direction,
                now_str, json.dumps(cleaned_bands), json.dumps(allocation),
                notes, reason, prev_id,
                max_avail_mw, bid.daily_energy_constraint_mwh,
                bid.ramp_up_mw_per_min, bid.ramp_down_mw_per_min,
                *trap_cols,
            ),
        )
        bid_id = cur.lastrowid

    return {
        "bid_id": bid_id, "status": "PENDING",
        "envelope_mw": round(envelope_mw, 3),
        "effective_commit_mw": round(effective_commit_mw, 3),
        "max_avail_mw": round(max_avail_mw, 3),
        "allocation": allocation,
        "trading_date": _trading_date_for(target).isoformat(),
        "gate_closure": _iso(target - timedelta(minutes=INTERVAL_MIN, seconds=GATE_BUFFER_SECONDS)),
        "previous_bid_id": prev_id,
    }


@router.post("/bids/trading_day")
def submit_trading_day(req: VppTradingDayIn) -> dict:
    """BIDDAYOFFER-style bulk submit.

    Apply ONE price ladder + operational parameters to EVERY open
    dispatch interval in the chosen trading day. Mirrors real AEMO
    workflow where a participant locks the price bands at 12:30 D-1
    via BIDDAYOFFER and the same prices apply to all 288 dispatch
    intervals of the trading day (BIDPEROFFER rebids MW only).

    Returns the list of created bid_ids + a `batch_id` they share so
    they can be cancelled / inspected as a group.
    """
    market = req.market.upper()
    direction = req.direction.upper()
    _validate_market_direction(market, direction)
    cleaned_bands = _validate_bands(req.bands)
    max_avail_mw = _validate_max_avail(cleaned_bands, req.max_avail_mw)
    _validate_ramp(req.ramp_up_mw_per_min, req.ramp_down_mw_per_min, market=market)
    _validate_fcas_trapezium(market, req.fcas_trapezium, max_avail_mw)

    reason = (req.rebid_reason or "INITIAL").upper()
    if reason not in REBID_REASON_CODES:
        raise HTTPException(400, f"rebid_reason must be one of {sorted(REBID_REASON_CODES)}")

    # Parse trading_date (YYYY-MM-DD) and build the 04:00→04:00 window.
    try:
        td = date.fromisoformat(req.trading_date)
    except ValueError as e:
        raise HTTPException(400, f"invalid trading_date '{req.trading_date}': {e}")
    day_start = datetime.combine(td, datetime.min.time()) + timedelta(hours=4)
    day_end = day_start + timedelta(days=1)

    # DRSP_ONLY portfolio + FCAS gate
    with locked_conn() as con:
        prow = con.execute(
            "SELECT classification FROM vpp_portfolio WHERE portfolio_id = ?",
            (req.portfolio_id,),
        ).fetchone()
    classification = (prow and prow[0]) or 'ARU'
    if classification == 'DRSP_ONLY' and market in (RAISE_FCAS | LOWER_FCAS):
        raise HTTPException(400, f"DRSP-only portfolio cannot bid {market}")

    # Per-interval MaxAvail overrides indexed by ISO timestamp
    override_map: dict[str, float] = {}
    for o in (req.per_interval_overrides or []):
        try:
            iv = _parse_iso(str(o.get("interval"))).strftime("%Y-%m-%d %H:%M:%S")
            override_map[iv] = float(o.get("max_avail_mw"))
        except Exception:
            continue

    # Build the list of open intervals (gate not closed yet).
    now = _nem_now()
    candidate = _ceil_to_dispatch(max(now, day_start))
    open_intervals: list[datetime] = []
    while candidate < day_end:
        gate = candidate - timedelta(minutes=INTERVAL_MIN, seconds=GATE_BUFFER_SECONDS)
        if now < gate:
            open_intervals.append(candidate)
        candidate += timedelta(minutes=INTERVAL_MIN)
    if not open_intervals:
        raise HTTPException(
            400,
            f"no open intervals remain in trading day {req.trading_date} "
            f"(NEM time {day_start:%H:%M}–{day_end:%H:%M}); all gates have closed",
        )

    # Generate a batch_id from epoch ms — monotonic-enough for the UI
    # to group/cancel in one click without needing a separate sequence table.
    batch_id = int(now.timestamp() * 1000) & 0x7FFFFFFF

    now_str = now.strftime("%Y-%m-%d %H:%M:%S")
    note_prefix = f"[{reason}][batch {batch_id}] "
    notes = note_prefix + (req.notes or "").strip()
    trap = req.fcas_trapezium
    trap_cols = (
        trap.t1_sec if trap else None, trap.t2_sec if trap else None,
        trap.t3_sec if trap else None, trap.t4_sec if trap else None,
        trap.enablement_min_mw if trap else None,
        trap.enablement_max_mw if trap else None,
        trap.low_breakpoint_mw if trap else None,
        trap.high_breakpoint_mw if trap else None,
    )

    created: list[dict] = []
    skipped: list[dict] = []
    sum_bid_mw = sum(float(b.get("mw", 0)) for b in cleaned_bands)

    for iv in open_intervals:
        iv_str = iv.strftime("%Y-%m-%d %H:%M:%S")
        per_iv_max_avail = override_map.get(iv_str, max_avail_mw)
        # Re-check envelope per interval — bid form's static envelope is
        # for "now", but availability shifts as the day progresses.
        env_kw, eligible = _aggregate_envelope(req.portfolio_id, market, direction, iv)
        env_mw = env_kw / 1000
        commit_mw = min(sum_bid_mw, per_iv_max_avail)
        if commit_mw > env_mw + 1e-6:
            skipped.append({
                "interval": iv.isoformat(),
                "reason": f"commit {commit_mw:.2f} MW > envelope {env_mw:.2f} MW",
            })
            continue
        # Allocation per interval (envelope shifts → allocation re-derived)
        allocation = _allocate_proportional(
            cleaned_bands, eligible, market=market, direction=direction,
        )
        try:
            with locked_conn() as con:
                cur = con.execute(
                    """
                    INSERT INTO vpp_bid
                        (portfolio_id, target_settlementdate, market, direction,
                         submitted_at, status, bands_json, allocation_json, notes,
                         rebid_reason, previous_bid_id,
                         max_avail_mw, daily_energy_constraint_mwh,
                         ramp_up_mw_per_min, ramp_down_mw_per_min,
                         t1_sec, t2_sec, t3_sec, t4_sec,
                         enablement_min_mw, enablement_max_mw,
                         low_breakpoint_mw, high_breakpoint_mw,
                         trading_day_batch_id)
                    VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, NULL,
                            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        req.portfolio_id, iv_str, market, direction,
                        now_str, json.dumps(cleaned_bands), json.dumps(allocation),
                        notes, reason,
                        per_iv_max_avail, req.daily_energy_constraint_mwh,
                        req.ramp_up_mw_per_min, req.ramp_down_mw_per_min,
                        *trap_cols, batch_id,
                    ),
                )
                created.append({"bid_id": cur.lastrowid, "interval": iv.isoformat()})
        except Exception as e:
            skipped.append({"interval": iv.isoformat(), "reason": f"insert failed: {e}"})

    return {
        "batch_id": batch_id,
        "trading_date": req.trading_date,
        "market": market,
        "direction": direction,
        "max_avail_mw": round(max_avail_mw, 3),
        "open_intervals": len(open_intervals),
        "created_count": len(created),
        "skipped_count": len(skipped),
        "created": created,
        "skipped": skipped,
    }


@router.delete("/bids/trading_day/{batch_id}")
def cancel_trading_day(batch_id: int) -> dict:
    """Cancel every PENDING bid in a trading-day batch in one shot.
    Bids whose gate has already closed are left alone (server-side gate
    check fires per row)."""
    cancelled: list[int] = []
    locked_out: list[int] = []
    with locked_conn() as con:
        rows = con.execute(
            "SELECT bid_id, target_settlementdate, status FROM vpp_bid "
            "WHERE trading_day_batch_id = ? AND status = 'PENDING'",
            (batch_id,),
        ).fetchall()
    if not rows:
        raise HTTPException(404, f"batch {batch_id} has no pending bids")
    now = _nem_now()
    with locked_conn() as con:
        for bid_id, target_ts, _ in rows:
            target_str = str(target_ts).replace("T", " ")[:19]
            try:
                target = datetime.strptime(target_str, "%Y-%m-%d %H:%M:%S")
            except ValueError:
                continue
            gate = target - timedelta(minutes=INTERVAL_MIN, seconds=GATE_BUFFER_SECONDS)
            if now >= gate:
                locked_out.append(bid_id)
                continue
            con.execute("UPDATE vpp_bid SET status='CANCELLED' WHERE bid_id = ?", (bid_id,))
            cancelled.append(bid_id)
    return {"batch_id": batch_id, "cancelled": cancelled, "locked_out": locked_out}


@router.delete("/bids/{bid_id}")
def cancel_bid(bid_id: int) -> dict:
    with locked_conn() as con:
        row = con.execute(
            "SELECT bid_id, target_settlementdate, status FROM vpp_bid "
            "WHERE bid_id = ?", (bid_id,),
        ).fetchone()
        if not row:
            raise HTTPException(404, f"bid {bid_id} not found")
        if row[2] != "PENDING":
            raise HTTPException(400, f"can only cancel PENDING bids; status={row[2]}")
        _check_gate_closure(_iso(row[1]) or "", action="cancel")
        con.execute("UPDATE vpp_bid SET status='CANCELLED' WHERE bid_id = ?", (bid_id,))
    return {"bid_id": bid_id, "status": "CANCELLED"}


@router.get("/bids")
def list_bids(
    portfolio_id: str = Query("NSW_CI_VPP"),
    limit: int = Query(50, ge=1, le=500),
) -> dict:
    with locked_conn() as con:
        rows = con.execute(
            """
            SELECT bid_id, portfolio_id, target_settlementdate, market, direction,
                   submitted_at, status, bands_json, allocation_json, notes,
                   rebid_reason, previous_bid_id,
                   max_avail_mw, daily_energy_constraint_mwh,
                   ramp_up_mw_per_min, ramp_down_mw_per_min,
                   t1_sec, t2_sec, t3_sec, t4_sec,
                   enablement_min_mw, enablement_max_mw,
                   low_breakpoint_mw, high_breakpoint_mw,
                   trading_day_batch_id
            FROM vpp_bid WHERE portfolio_id = ?
            ORDER BY submitted_at DESC LIMIT ?
            """,
            (portfolio_id, limit),
        ).fetchall()
    bids = []
    for r in rows:
        # Surface the trapezium back as a structured object when present.
        trap = None
        if r[16] is not None and r[20] is not None:
            trap = {
                "t1_sec": r[16], "t2_sec": r[17], "t3_sec": r[18], "t4_sec": r[19],
                "enablement_min_mw": r[20], "enablement_max_mw": r[21],
                "low_breakpoint_mw": r[22], "high_breakpoint_mw": r[23],
            }
        bids.append({
            "bid_id": r[0], "portfolio_id": r[1],
            "target_settlementdate": _iso(r[2]),
            "market": r[3], "direction": r[4],
            "submitted_at": _iso(r[5]), "status": r[6],
            "bands": json.loads(r[7] or "[]"),
            "allocation": json.loads(r[8] or "[]"),
            "notes": r[9], "rebid_reason": r[10],
            "previous_bid_id": r[11],
            "max_avail_mw": r[12],
            "daily_energy_constraint_mwh": r[13],
            "ramp_up_mw_per_min": r[14],
            "ramp_down_mw_per_min": r[15],
            "fcas_trapezium": trap,
            "trading_day_batch_id": r[24],
        })
    return {"portfolio_id": portfolio_id, "bids": bids, "count": len(bids)}


@router.post("/resources/{resource_id}/opt")
def toggle_resource(resource_id: str, opted_in: bool = Query(True)) -> dict:
    """Toggle a single sub-resource's participation in bids. Real
    aggregators expose this so a site owner can pull their asset from
    the fleet (e.g. customer override, maintenance window)."""
    with locked_conn() as con:
        cur = con.execute(
            "UPDATE vpp_resource SET opted_in = ?, updated_at = ? WHERE resource_id = ?",
            (1 if opted_in else 0, _nem_now().strftime("%Y-%m-%d %H:%M:%S"), resource_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(404, f"resource '{resource_id}' not found")
    return {"resource_id": resource_id, "opted_in": opted_in}


@router.get("/revenue")
def revenue_breakdown(
    portfolio_id: str = Query("NSW_CI_VPP"),
    hours: int = Query(24, ge=1, le=168,
                       description="Lookback window for the breakdown."),
) -> dict:
    """Revenue split by market category over the last `hours`.

    Categorises every vpp_fill row into one of three buckets:
      * `ENERGY` (energy arbitrage — BESS discharge/charge revenue)
      * `FCAS_RAISE` (raise contingency + reg — capacity payments)
      * `FCAS_LOWER` (lower contingency + reg)
    Plus an estimate of customer-side demand-charge savings (computed
    deterministically from BESS resources × an assumed demand-charge
    rate × VPP share, since real customer billing data isn't in scope).

    The C&I aggregator's revenue answer to "Energy vs FCAS, which is
    bigger?" — exposes the trend the user wanted to inspect.
    """
    cutoff = (datetime.utcnow() + timedelta(hours=10) - timedelta(hours=hours)).strftime("%Y-%m-%d %H:%M:%S")
    with locked_conn() as con:
        # Cumulative since cutoff
        rows = con.execute(
            """
            SELECT market, direction, SUM(revenue_aud), SUM(energy_mwh),
                   COUNT(*)
            FROM vpp_fill
            WHERE portfolio_id = ? AND settlementdate >= ?
            GROUP BY market, direction
            ORDER BY market
            """,
            (portfolio_id, cutoff),
        ).fetchall()
        # Also pull portfolio for the share calc
        prow = con.execute(
            "SELECT customer_share_pct, classification FROM vpp_portfolio "
            "WHERE portfolio_id = ?",
            (portfolio_id,),
        ).fetchone()
        # BESS resources for the demand-charge estimate
        bess_rows = con.execute(
            "SELECT resource_id, site_name, nameplate_kw, opted_in "
            "FROM vpp_resource WHERE portfolio_id = ? AND kind = 'bess'",
            (portfolio_id,),
        ).fetchall()

    by_market: dict[str, dict] = {}
    by_category: dict[str, float] = {"ENERGY": 0.0, "FCAS_RAISE": 0.0, "FCAS_LOWER": 0.0}
    total_rev = 0.0
    total_fills = 0
    for market, direction, rev_sum, mwh_sum, n in rows:
        rev_sum = float(rev_sum or 0)
        mwh_sum = float(mwh_sum or 0)
        by_market[f"{market}_{direction}"] = {
            "market": market, "direction": direction,
            "revenue_aud": round(rev_sum, 2),
            "energy_mwh": round(mwh_sum, 3),
            "fills": int(n or 0),
        }
        total_rev += rev_sum
        total_fills += int(n or 0)
        cat = ("ENERGY" if market == "ENERGY"
               else "FCAS_RAISE" if market in RAISE_FCAS
               else "FCAS_LOWER")
        by_category[cat] += rev_sum

    # Customer demand-charge savings ESTIMATE.
    # Heuristic: each opted-in BESS could shave ~25% of nameplate kW off
    # the customer's monthly peak; at $40/kVA/month demand charge × VPP
    # share, prorated to the window. This is purely informational — when
    # we wire real customer meter data we replace this block.
    customer_share_pct = float((prow and prow[0]) or 30.0)
    DEMAND_CHARGE_AUD_PER_KW_PER_MO = 40.0
    PEAK_REDUCTION_FRAC = 0.25
    monthly_savings = sum(
        float(r[2]) * PEAK_REDUCTION_FRAC * DEMAND_CHARGE_AUD_PER_KW_PER_MO
        for r in bess_rows if r[3]   # opted_in
    )
    # Window prorate (hours / hours-in-month)
    window_savings_total = monthly_savings * (hours / (30 * 24))
    vpp_share_savings = window_savings_total * (customer_share_pct / 100.0)

    return {
        "portfolio_id": portfolio_id,
        "classification": (prow and prow[1]) or "ARU",
        "hours": hours,
        "totals": {
            "wholesale_revenue_aud": round(total_rev, 2),
            "wholesale_fills": total_fills,
            "energy_aud": round(by_category["ENERGY"], 2),
            "fcas_raise_aud": round(by_category["FCAS_RAISE"], 2),
            "fcas_lower_aud": round(by_category["FCAS_LOWER"], 2),
            "customer_demand_charge_aud": round(vpp_share_savings, 2),
            "customer_total_savings_aud": round(window_savings_total, 2),
            "all_revenue_aud": round(total_rev + vpp_share_savings, 2),
        },
        "by_market": list(by_market.values()),
    }


@router.get("/suggestions")
def suggested_bids(
    portfolio_id: str = Query("NSW_CI_VPP"),
    n_intervals: int = Query(6, ge=1, le=12,
                              description="How many upcoming intervals to suggest for."),
) -> dict:
    """Algorithmic bid suggestions for the next N dispatch intervals.

    Looks at AEMO P5MIN forecast prices + current FCAS RRPs and
    generates a recommended 10-band ladder per (interval, market) that
    respects the portfolio envelope, BESS SoC, and customer-contract
    limits. The user clicks 'Submit' to push any suggestion into the
    real bid table.

    Strategy:
      * ENERGY GEN  — bid if forecast RRP > $80; ladder anchored at
                      forecast/2, $forecast, $forecast×2 to capture
                      arbitrage from any cleared point.
      * ENERGY LOAD — bid for BESS charging if forecast RRP < $30;
                      ladder of $forecast, forecast+10, +30.
      * RAISE60SEC  — always bid (cheapest FCAS to enter); ladder
                      $1, $3, $10. Almost always clears in NSW.
    """
    nem_now = _nem_now()
    candidate = _ceil_to_dispatch(nem_now)
    suggestions: list[dict] = []

    # Fetch the latest forecast prices once (P5MIN row per upcoming interval).
    with locked_conn() as con:
        prow = con.execute(
            "SELECT region, classification FROM vpp_portfolio WHERE portfolio_id = ?",
            (portfolio_id,),
        ).fetchone()
        if not prow:
            return {"suggestions": []}
        region, classification = prow[0], prow[1]
        # Latest P5MIN forecast per upcoming interval
        forecast_rows = con.execute(
            """
            SELECT interval_datetime, rrp, raise60sec_rrp, lower60sec_rrp
            FROM nem_predispatch_price
            WHERE regionid = ? AND source = 'P5MIN'
              AND interval_datetime >= ?
            ORDER BY interval_datetime, run_datetime DESC
            """,
            (region, candidate.strftime("%Y-%m-%d %H:%M:%S")),
        ).fetchall()
    # Keep only the LATEST forecast per interval (first row wins after DESC)
    seen: set = set()
    forecast_by_iv: dict[str, dict] = {}
    for r in forecast_rows:
        iv = _iso(r[0])
        if iv in seen: continue
        seen.add(iv)
        forecast_by_iv[iv] = {"rrp": r[1] or 0,
                              "raise60": r[2] or 0,
                              "lower60": r[3] or 0}

    # For each upcoming interval, generate suggestions.
    intervals_emitted = 0
    while intervals_emitted < n_intervals:
        # Skip closed-gate intervals
        gate = candidate - timedelta(minutes=INTERVAL_MIN, seconds=GATE_BUFFER_SECONDS)
        if nem_now >= gate:
            candidate += timedelta(minutes=INTERVAL_MIN)
            continue
        iv_iso = candidate.isoformat()
        f = forecast_by_iv.get(iv_iso, {"rrp": 0, "raise60": 0, "lower60": 0})
        # Compute envelopes for the three markets we suggest into.
        env_gen_kw, elig_gen = _aggregate_envelope(portfolio_id, ENERGY, "GEN", candidate)
        env_load_kw, elig_load = _aggregate_envelope(portfolio_id, ENERGY, "LOAD", candidate)
        env_r60_kw, elig_r60 = _aggregate_envelope(portfolio_id, "RAISE60SEC", "GEN", candidate)

        # ----- ENERGY GEN (discharge) — only if forecast > $80 -----
        fc_rrp = float(f["rrp"])
        if fc_rrp > 80 and env_gen_kw / 1000 > 0.1:
            mw_each = round(env_gen_kw / 1000 * 0.25, 2)   # 25% of envelope per band
            anchor = max(20, fc_rrp / 2)
            bands = [
                {"price": round(anchor, 0), "mw": mw_each},
                {"price": round(fc_rrp, 0), "mw": mw_each},
                {"price": round(fc_rrp * 2, 0), "mw": mw_each},
            ]
            suggestions.append({
                "target_settlementdate": iv_iso,
                "market": "ENERGY", "direction": "GEN",
                "bands": bands,
                "rationale": f"P5MIN forecast ${fc_rrp:.0f}/MWh — ladder captures arbitrage from anchor to spike",
                "envelope_mw": round(env_gen_kw / 1000, 2),
                "eligible_resources": len(elig_gen),
                "estimated_revenue_aud": round(sum(b["mw"] for b in bands) * fc_rrp * (INTERVAL_MIN/60), 2),
                "expected_clear": fc_rrp >= anchor,
            })

        # ----- ENERGY LOAD (BESS charge) — only if forecast < $30 -----
        if fc_rrp < 30 and env_load_kw / 1000 > 0.1:
            # Restrict to BESS-only resources (EV LOAD = WDR which is the
            # opposite direction economically)
            bess_load = [r for r in elig_load if r["kind"] == "bess"]
            bess_kw = sum(_max_kw_available(r, market=ENERGY, direction="LOAD")
                           for r in bess_load)
            if bess_kw / 1000 > 0.1:
                mw_each = round(bess_kw / 1000 * 0.3, 2)
                bands = [
                    {"price": round(max(fc_rrp, 5), 0), "mw": mw_each},
                    {"price": round(fc_rrp + 15, 0), "mw": mw_each},
                    {"price": round(fc_rrp + 50, 0), "mw": mw_each},
                ]
                suggestions.append({
                    "target_settlementdate": iv_iso,
                    "market": "ENERGY", "direction": "LOAD",
                    "bands": bands,
                    "rationale": f"P5MIN forecast ${fc_rrp:.0f}/MWh — cheap charge window for BESS",
                    "envelope_mw": round(bess_kw / 1000, 2),
                    "eligible_resources": len(bess_load),
                    "estimated_revenue_aud": -round(sum(b["mw"] for b in bands) * fc_rrp * (INTERVAL_MIN/60), 2),
                    "expected_clear": True,
                })

        # ----- RAISE60SEC — always suggest if portfolio can do it -----
        if classification != 'DRSP_ONLY' and env_r60_kw / 1000 > 0.1:
            fc_r60 = float(f["raise60"])
            mw_each = round(env_r60_kw / 1000 * 0.3, 2)
            # Bid below forecast so we're guaranteed to clear if it holds.
            base_price = max(0.5, fc_r60 * 0.5) if fc_r60 > 0 else 1
            bands = [
                {"price": round(base_price, 1), "mw": mw_each},
                {"price": round(base_price * 3 + 1, 1), "mw": mw_each},
                {"price": round(base_price * 10 + 5, 1), "mw": mw_each},
            ]
            suggestions.append({
                "target_settlementdate": iv_iso,
                "market": "RAISE60SEC", "direction": "GEN",
                "bands": bands,
                "rationale": f"P5MIN R60SEC RRP ${fc_r60:.2f}/MW/h — capacity-paid even if quiet",
                "envelope_mw": round(env_r60_kw / 1000, 2),
                "eligible_resources": len(elig_r60),
                "estimated_revenue_aud": round(sum(b["mw"] for b in bands) * max(fc_r60, 0.01) * (INTERVAL_MIN/60), 2),
                "expected_clear": fc_r60 >= base_price,
            })

        candidate += timedelta(minutes=INTERVAL_MIN)
        intervals_emitted += 1

    return {
        "portfolio_id": portfolio_id,
        "generated_at": _iso(nem_now),
        "suggestions": suggestions,
    }


@router.get("/customer/demand-charge")
def customer_demand_charge(
    portfolio_id: str = Query("NSW_CI_VPP"),
    rate_aud_per_kva_month: float = Query(40.0, ge=0,
                                          description="Customer's network demand charge rate. NSW C&I average ~$40."),
    peak_window_start: int = Query(17, ge=0, le=23,
                                   description="Peak window start hour (NEM time)."),
    peak_window_end: int = Query(21, ge=0, le=24),
) -> dict:
    """Per-site customer demand-charge savings.

    AEMO BTM (behind-the-meter) batteries flatten the customer's monthly
    PEAK demand at the connection point, which slashes the network demand
    charge (typically $30-50/kVA/month in NSW C&I tariffs). The VPP gets
    a contracted share (`customer_share_pct`) of those savings.

    We compute this from REAL settled BESS GEN events during the peak
    window over the last 30 days — no fakery, the discharge that already
    happened literally flattened the customer's recorded peak.
    """
    nem_now = datetime.utcnow() + timedelta(hours=10)
    window_start = (nem_now - timedelta(days=30)).strftime("%Y-%m-%d %H:%M:%S")
    with locked_conn() as con:
        prow = con.execute(
            "SELECT customer_share_pct FROM vpp_portfolio WHERE portfolio_id = ?",
            (portfolio_id,),
        ).fetchone()
        share_pct = float((prow and prow[0]) or 30.0)

        # Pull peak-window BESS GEN allocations from the last 30 days.
        # A "peak event" for the customer = BESS discharge that
        # happened during 17:00-21:00. The MAX such event in the month
        # is the customer's peak-demand reduction.
        rows = con.execute(
            """
            SELECT a.resource_id, r.site_name, r.kind, r.nameplate_kw,
                   MAX(ABS(a.alloc_mw)),
                   COUNT(*),
                   SUM(ABS(a.alloc_mw))
            FROM vpp_fill_alloc a
            JOIN vpp_resource r ON r.resource_id = a.resource_id
            WHERE a.portfolio_id = ?
              AND a.market = 'ENERGY' AND a.direction = 'GEN'
              AND r.kind = 'bess'
              AND a.settlementdate >= ?
              AND CAST(strftime('%H', a.settlementdate) AS INTEGER) >= ?
              AND CAST(strftime('%H', a.settlementdate) AS INTEGER) < ?
            GROUP BY a.resource_id
            """,
            (portfolio_id, window_start, peak_window_start, peak_window_end),
        ).fetchall()

    per_site = []
    total_customer_saved = 0.0
    total_vpp_share = 0.0
    for r in rows:
        rid, site_name, kind, nameplate_kw, peak_reduction_mw, n_events, total_mwh = r
        peak_reduction_kw = float(peak_reduction_mw or 0) * 1000.0
        # Demand charge is per kVA. Approximate kW=kVA for unity power factor.
        monthly_saving = peak_reduction_kw * rate_aud_per_kva_month
        vpp_share = monthly_saving * (share_pct / 100.0)
        customer_keeps = monthly_saving - vpp_share
        per_site.append({
            "resource_id": rid,
            "site_name": site_name,
            "kind": kind,
            "nameplate_kw": nameplate_kw,
            "peak_reduction_kw": round(peak_reduction_kw, 1),
            "peak_events_last_30d": int(n_events or 0),
            "monthly_savings_aud": round(monthly_saving, 2),
            "vpp_share_aud": round(vpp_share, 2),
            "customer_keeps_aud": round(customer_keeps, 2),
        })
        total_customer_saved += monthly_saving
        total_vpp_share += vpp_share

    # Sites that haven't done any peak-window discharge yet (potential
    # but unrealised savings) — list separately so customer sees the
    # opportunity.
    with locked_conn() as con:
        idle_bess = con.execute(
            "SELECT resource_id, site_name, nameplate_kw "
            "FROM vpp_resource WHERE portfolio_id = ? AND kind = 'bess' "
            "  AND resource_id NOT IN ("
            "    SELECT DISTINCT resource_id FROM vpp_fill_alloc "
            "    WHERE portfolio_id = ? AND market = 'ENERGY' AND direction = 'GEN'"
            "      AND settlementdate >= ?"
            "  )",
            (portfolio_id, portfolio_id, window_start),
        ).fetchall()
    idle = [{
        "resource_id": r[0], "site_name": r[1], "kind": "bess",
        "nameplate_kw": r[2],
        "peak_reduction_kw": 0.0, "peak_events_last_30d": 0,
        "monthly_savings_aud": 0.0, "vpp_share_aud": 0.0,
        "customer_keeps_aud": 0.0,
        "potential_kw": r[2],          # full nameplate of unrealised peak shave
        "potential_monthly_aud": round(float(r[2] or 0) * rate_aud_per_kva_month, 2),
    } for r in idle_bess]

    return {
        "portfolio_id": portfolio_id,
        "rate_aud_per_kva_month": rate_aud_per_kva_month,
        "peak_window": f"{peak_window_start:02d}:00–{peak_window_end:02d}:00",
        "share_pct": share_pct,
        "totals": {
            "customer_monthly_savings_aud": round(total_customer_saved, 2),
            "vpp_monthly_share_aud": round(total_vpp_share, 2),
            "active_sites": len(per_site),
            "idle_sites": len(idle),
        },
        "active_sites": per_site,
        "idle_sites": idle,
    }


@router.get("/resources/pnl")
def resources_pnl(
    portfolio_id: str = Query("NSW_CI_VPP"),
    hours: int = Query(24, ge=1, le=168),
) -> dict:
    """Per-resource revenue + dispatch counters over `hours` hours.
    Drives the 'which sites earned what' breakdown real C&I platforms
    show their customers.
    """
    cutoff = (datetime.utcnow() + timedelta(hours=10) - timedelta(hours=hours)).strftime("%Y-%m-%d %H:%M:%S")
    with locked_conn() as con:
        rows = con.execute(
            """
            SELECT a.resource_id, r.site_name, r.kind,
                   r.nameplate_kw, r.soc_kwh, r.capacity_kwh,
                   COUNT(*),
                   SUM(CASE WHEN a.market = 'ENERGY' THEN 1 ELSE 0 END),
                   SUM(a.revenue_aud),
                   SUM(a.alloc_mwh),
                   SUM(a.soc_delta_kwh)
            FROM vpp_fill_alloc a
            JOIN vpp_resource r ON r.resource_id = a.resource_id
            WHERE a.portfolio_id = ? AND a.settlementdate >= ?
            GROUP BY a.resource_id
            ORDER BY SUM(a.revenue_aud) DESC
            """,
            (portfolio_id, cutoff),
        ).fetchall()
        # Also list resources with ZERO activity so the UI can show
        # idle sites alongside active ones.
        active_ids = {r[0] for r in rows}
        idle_rows = con.execute(
            "SELECT resource_id, site_name, kind, nameplate_kw, soc_kwh, capacity_kwh "
            "FROM vpp_resource WHERE portfolio_id = ?",
            (portfolio_id,),
        ).fetchall()

    active = [
        {
            "resource_id": r[0], "site_name": r[1], "kind": r[2],
            "nameplate_kw": r[3], "soc_kwh": r[4], "capacity_kwh": r[5],
            "fill_count": int(r[6]), "energy_fill_count": int(r[7]),
            "revenue_aud": round(r[8] or 0, 2),
            "energy_mwh": round(r[9] or 0, 3),
            "soc_delta_kwh": round(r[10] or 0, 1),
        }
        for r in rows
    ]
    idle = [
        {
            "resource_id": r[0], "site_name": r[1], "kind": r[2],
            "nameplate_kw": r[3], "soc_kwh": r[4], "capacity_kwh": r[5],
            "fill_count": 0, "energy_fill_count": 0,
            "revenue_aud": 0.0, "energy_mwh": 0.0, "soc_delta_kwh": 0.0,
        }
        for r in idle_rows if r[0] not in active_ids
    ]
    return {
        "portfolio_id": portfolio_id,
        "hours": hours,
        "resources": active + idle,
    }


@router.get("/resources/{resource_id}/history")
def resource_history(
    resource_id: str,
    hours: int = Query(24, ge=1, le=168),
) -> dict:
    """24h history for one resource: SoC trajectory (reconstructed from
    fill_alloc soc_delta_kwh in reverse), cumulative revenue, per-event
    markers. Drives the expandable per-row chart in the UI.
    """
    nem_now = datetime.utcnow() + timedelta(hours=10)
    cutoff = (nem_now - timedelta(hours=hours)).strftime("%Y-%m-%d %H:%M:%S")
    with locked_conn() as con:
        r = con.execute(
            "SELECT resource_id, site_name, kind, nameplate_kw, "
            "       capacity_kwh, soc_kwh "
            "FROM vpp_resource WHERE resource_id = ?",
            (resource_id,),
        ).fetchone()
        if not r:
            raise HTTPException(404, f"resource '{resource_id}' not found")
        meta = {"resource_id": r[0], "site_name": r[1], "kind": r[2],
                "nameplate_kw": r[3], "capacity_kwh": r[4],
                "soc_now_kwh": r[5]}
        # Pull all fill_alloc rows for this resource in window, oldest first
        rows = con.execute(
            """
            SELECT settlementdate, market, direction, alloc_mw, alloc_mwh,
                   revenue_aud, soc_delta_kwh
            FROM vpp_fill_alloc
            WHERE resource_id = ? AND settlementdate >= ?
            ORDER BY settlementdate
            """,
            (resource_id, cutoff),
        ).fetchall()

    # Reconstruct SoC trajectory by walking BACKWARDS from soc_now_kwh.
    # SoC_t = soc_now − sum(soc_delta for events after t)
    cur_soc = float(meta["soc_now_kwh"] or 0)
    # Build event list with derived SoC AFTER this event.
    events = []
    revenue_cum = 0.0
    for row in rows:
        ts, market, direction, alloc_mw, alloc_mwh, revenue, soc_delta = row
        revenue_cum += float(revenue or 0)
        events.append({
            "t": _iso(ts),
            "market": market, "direction": direction,
            "alloc_mw": round(alloc_mw or 0, 3),
            "alloc_mwh": round(alloc_mwh or 0, 4),
            "revenue_aud": round(revenue or 0, 2),
            "revenue_cum_aud": round(revenue_cum, 2),
            "soc_delta_kwh": round(soc_delta or 0, 1),
        })
    # Now walk FORWARD to derive SoC AT each event (start with soc reconstructed
    # by removing all soc_deltas from current).
    starting_soc = cur_soc - sum(float(e["soc_delta_kwh"]) for e in events)
    running = starting_soc
    for e in events:
        running += float(e["soc_delta_kwh"])
        e["soc_after_kwh"] = round(running, 1)

    return {
        "resource": meta,
        "hours": hours,
        "starting_soc_kwh": round(starting_soc, 1),
        "events": events,
        "summary": {
            "total_events": len(events),
            "energy_events": sum(1 for e in events if e["market"] == "ENERGY"),
            "fcas_events": sum(1 for e in events if e["market"] != "ENERGY"),
            "total_revenue_aud": round(revenue_cum, 2),
            "total_mwh": round(sum(float(e["alloc_mwh"]) for e in events), 3),
        },
    }


@router.get("/fills")
def list_fills(
    portfolio_id: str = Query("NSW_CI_VPP"),
    limit: int = Query(50, ge=1, le=500),
) -> dict:
    """Recent settlement rows for the ledger / debug view."""
    with locked_conn() as con:
        rows = con.execute(
            """
            SELECT fill_id, bid_id, portfolio_id, settlementdate, market, direction,
                   cleared_price, enabled_mw, energy_mwh, revenue_aud,
                   mlf_applied, created_at
            FROM vpp_fill WHERE portfolio_id = ?
            ORDER BY settlementdate DESC, fill_id DESC LIMIT ?
            """,
            (portfolio_id, limit),
        ).fetchall()
    fills = [
        {
            "fill_id": r[0], "bid_id": r[1], "portfolio_id": r[2],
            "settlementdate": _iso(r[3]), "market": r[4], "direction": r[5],
            "cleared_price": r[6], "enabled_mw": r[7], "energy_mwh": r[8],
            "revenue_aud": r[9], "mlf_applied": r[10],
            "created_at": _iso(r[11]),
        }
        for r in rows
    ]
    return {"portfolio_id": portfolio_id, "fills": fills, "count": len(fills)}


@router.get("/markets")
def markets() -> dict:
    """Static metadata for the bid form dropdowns."""
    return {
        "energy": [ENERGY],
        "raise_fcas": sorted(RAISE_FCAS),
        "lower_fcas": sorted(LOWER_FCAS),
        "rebid_reasons": sorted(REBID_REASON_CODES),
        "mpf": MPF, "mpc": MPC,
        "interval_minutes": INTERVAL_MIN,
        "max_bands": MAX_BANDS,
    }


@router.get("/compliance")
def compliance_scorecard(
    portfolio_id: str = Query("NSW_CI_VPP"),
    days: int = Query(7, ge=1, le=90,
                       description="Lookback window for participant-conduct analysis."),
) -> dict:
    """Compliance + prudent-participant scorecard for the portfolio.

    Four sections:
      1. Rule enforcement matrix — which NER rules our validators cover
         vs which we don't model (honest disclosure of gaps).
      2. Participant conduct — rebid frequency, reason quality, gate-timing
         (mirrors what AER looks at when assessing prudent participation).
      3. Customer contract compliance — events/day, recovery, daily energy
         caps per opted-in resource.
      4. Data freshness — NEM scraper lag as a proxy for whether the
         platform could actually react in time.

    Returns an overall_score (0–100) + status string. Rule-enforcement
    section is informational only — it doesn't add to the score because
    "we wrote validators" is a self-assertion, not a measurement.
    """
    now = _nem_now()
    window_start = now - timedelta(days=days)
    window_start_s = window_start.strftime("%Y-%m-%d %H:%M:%S")

    # ---- Pull bid history for conduct analysis ----
    with locked_conn() as con:
        bids = con.execute(
            """
            SELECT bid_id, target_settlementdate, submitted_at, rebid_reason,
                   notes, previous_bid_id, status, market, direction
            FROM vpp_bid
            WHERE portfolio_id = ? AND submitted_at >= ?
            ORDER BY submitted_at DESC
            """,
            (portfolio_id, window_start_s),
        ).fetchall()

    total_bids = len(bids)
    rebids = sum(1 for b in bids if b[5] is not None)
    cancelled = sum(1 for b in bids if b[6] == 'CANCELLED')
    settled = sum(1 for b in bids if b[6] == 'SETTLED')
    pending = sum(1 for b in bids if b[6] == 'PENDING')

    # Reason distribution
    reason_counts: dict[str, int] = {}
    for b in bids:
        r = b[3] or 'INITIAL'
        reason_counts[r] = reason_counts.get(r, 0) + 1

    # Reason explanation quality — notes always carries a "[REASON] "
    # prefix from submit_bid; we want to know whether the user added
    # meaningful text AFTER that bracket.
    explained_count = 0
    for b in bids:
        notes = b[4] or ''
        if ']' in notes:
            after_bracket = notes.split(']', 1)[1].strip()
            if len(after_bracket) >= 3:
                explained_count += 1

    # AER red flags: high STRATEGY/OTHER share, late submits, low
    # explanation rate when rebidding.
    strategy_other = reason_counts.get('STRATEGY', 0) + reason_counts.get('OTHER', 0)
    rebid_ratio = rebids / total_bids if total_bids > 0 else 0
    strategy_other_rate = strategy_other / total_bids if total_bids > 0 else 0
    explanation_rate = explained_count / total_bids if total_bids > 0 else 1.0

    # Late-submit rate — bids submitted within 60s of their gate closure.
    # AER takes a dim view of consistent last-second rebids without strong
    # justification (looks like price manipulation).
    late_count = 0
    for b in bids:
        try:
            target = _parse_iso(str(b[1]).replace('T', ' ')[:19])
            submitted = _parse_iso(str(b[2]).replace('T', ' ')[:19])
        except Exception:
            continue
        gate = target - timedelta(minutes=INTERVAL_MIN, seconds=GATE_BUFFER_SECONDS)
        if (gate - submitted).total_seconds() <= 60:
            late_count += 1
    late_rate = late_count / total_bids if total_bids > 0 else 0

    # ---- Conduct score (0-100) ----
    conduct_score = 100
    deductions: list[str] = []
    if rebid_ratio > 0.5:
        d = min(20, int((rebid_ratio - 0.5) * 40))
        conduct_score -= d
        deductions.append(f"high rebid ratio {rebid_ratio*100:.0f}% (−{d})")
    if strategy_other_rate > 0.3 and total_bids >= 5:
        d = min(20, int((strategy_other_rate - 0.3) * 50))
        conduct_score -= d
        deductions.append(f"STRATEGY/OTHER {strategy_other_rate*100:.0f}% (−{d})")
    if rebids > 0 and explanation_rate < 0.5:
        d = min(15, int((0.5 - explanation_rate) * 30))
        conduct_score -= d
        deductions.append(f"weak rebid explanations {explanation_rate*100:.0f}% (−{d})")
    if late_rate > 0.2 and total_bids >= 5:
        d = min(15, int((late_rate - 0.2) * 40))
        conduct_score -= d
        deductions.append(f"late-submit pattern {late_rate*100:.0f}% (−{d})")
    conduct_score = max(0, conduct_score)

    # ---- Customer-contract compliance ----
    # For each opted-in resource: events_today vs max_events_per_day,
    # was today's dispatch within window, did recovery_min hold.
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0).strftime("%Y-%m-%d %H:%M:%S")
    with locked_conn() as con:
        resources = con.execute(
            """
            SELECT resource_id, site_name, max_events_per_day, max_duration_min,
                   recovery_min, opted_in, window_start_hr, window_end_hr
            FROM vpp_resource WHERE portfolio_id = ? AND opted_in = 1
            """,
            (portfolio_id,),
        ).fetchall()
        # Today's fill_alloc events per resource (ENERGY only counts as "events")
        events_rows = con.execute(
            """
            SELECT resource_id, COUNT(*), MAX(settlementdate)
            FROM vpp_fill_alloc
            WHERE portfolio_id = ? AND market = 'ENERGY'
              AND settlementdate >= ?
            GROUP BY resource_id
            """,
            (portfolio_id, today_start),
        ).fetchall()
    event_map = {r[0]: {"count": int(r[1]), "last": r[2]} for r in events_rows}

    contract_items: list[dict] = []
    contracts_ok = 0
    contracts_warn = 0
    contracts_breach = 0
    for r in resources:
        rid, name, max_ev, max_dur, recovery, _opted, _ws, _we = r
        ev = event_map.get(rid, {"count": 0, "last": None})
        cnt = ev["count"]
        util = cnt / max_ev if max_ev > 0 else 0
        if util > 1.0:
            status = "breach"; contracts_breach += 1
        elif util > 0.8:
            status = "warn"; contracts_warn += 1
        else:
            status = "ok"; contracts_ok += 1
        contract_items.append({
            "resource_id": rid, "site_name": name,
            "events_today": cnt, "max_events_per_day": int(max_ev),
            "util_pct": round(util * 100, 0),
            "status": status,
        })
    contracts_total = len(resources)
    contracts_score = round(
        100 * (contracts_ok + 0.5 * contracts_warn) / max(contracts_total, 1)
    )

    # ---- Data freshness ----
    with locked_conn() as con:
        latest_disp = con.execute(
            "SELECT MAX(settlementdate) FROM nem_dispatch_price WHERE regionid = 'NSW1'"
        ).fetchone()[0]
        latest_predisp = con.execute(
            "SELECT MAX(run_datetime) FROM nem_predispatch_price WHERE source = 'P5MIN'"
        ).fetchone()[0]
        latest_fill = con.execute(
            "SELECT MAX(settlementdate) FROM vpp_fill WHERE portfolio_id = ?",
            (portfolio_id,),
        ).fetchone()[0]
    def _staleness_sec(ts) -> int | None:
        if ts is None: return None
        try:
            t = ts if isinstance(ts, datetime) else _parse_iso(str(ts).replace('T', ' ')[:19])
        except Exception:
            return None
        return int((now - t).total_seconds())

    data_items: list[dict] = []
    data_score = 100
    for label, ts, target_sec, ner in [
        ("DispatchIS RRP (NSW1)", latest_disp, 360, "NER 3.13.4"),
        ("P5MIN predispatch",     latest_predisp, 600, "NER 3.7"),
        ("VPP settlement",        latest_fill, None, "—"),
    ]:
        st = _staleness_sec(ts)
        if st is None:
            status = "warn"; deduct = 10
        elif target_sec is None:
            status = "info"; deduct = 0
        elif st <= target_sec:
            status = "ok"; deduct = 0
        elif st <= target_sec * 2:
            status = "warn"; deduct = 5
        else:
            status = "breach"; deduct = 15
        data_score -= deduct
        data_items.append({
            "label": label, "ner": ner,
            "latest": _iso(ts) if ts else None,
            "staleness_sec": st,
            "target_sec": target_sec,
            "status": status,
        })
    data_score = max(0, data_score)

    # ---- Rule enforcement matrix (informational) ----
    rule_items = [
        {"ner": "NER 3.8.6",     "rule": "10-band max + price range [MPF, MPC]",
         "enforced": True, "where": "_validate_bands"},
        {"ner": "NER 3.8.6A.1",  "rule": "Monotonic strictly-ascending bands",
         "enforced": True, "where": "_validate_bands"},
        {"ner": "NER 3.8.20",    "rule": "Gate closure T-5min",
         "enforced": True, "where": "_check_gate_closure"},
        {"ner": "NER 3.8.22A",   "rule": "Rebid reason code required",
         "enforced": True, "where": "submit_bid()"},
        {"ner": "NER 3.8.7A",    "rule": "FCAS trapezium monotonicity",
         "enforced": True, "where": "_validate_fcas_trapezium"},
        {"ner": "MASS",          "rule": "FCAS T1+T2 ≤ response window",
         "enforced": True, "where": "_validate_fcas_trapezium"},
        {"ner": "BIDPEROFFER",   "rule": "MaxAvail cap on dispatch",
         "enforced": True, "where": "vpp_settle._cleared_mw"},
        {"ner": "BIDDAYOFFER",   "rule": "DailyEnergyConstraint per DUID-day",
         "enforced": True, "where": "_check_daily_energy_constraint"},
        {"ner": "NER 3.8.2A",    "rule": "WDR baseline calculation (LBL_N10)",
         "enforced": True, "where": "vpp_baseline.wdr_revenue"},
        {"ner": "NER 2.2.5",     "rule": "Embedded generation channel for non-scheduled",
         "enforced": True, "where": "_resource_channels"},
        {"ner": "IESS 2024",     "rule": "ARU registration class + FCAS gating for non-scheduled",
         "enforced": True, "where": "_resource_eligible"},
        # ---- Honest gaps ----
        {"ner": "NER 3.8.21",    "rule": "Dispatch instruction via SCADA (B2B)",
         "enforced": False, "note": "Not modelled — needs AEMO MarketNet B2B"},
        {"ner": "NER 3.13.6",    "rule": "Causer-pays for regulation FCAS",
         "enforced": False, "note": "Not modelled — needs 4s AGC SCADA contribution data"},
        {"ner": "NER 3.15.13/14", "rule": "AEMO settlement reconciliation (T+1bd / T+15bd)",
         "enforced": False, "note": "Shadow-settle via RRP × MWh × MLF only"},
        {"ner": "NER 3.7.2",     "rule": "Pre-dispatch sensitivity analysis",
         "enforced": False, "note": "P5MIN/PREDISPATCH stored but no sensitivity runs"},
        {"ner": "NER 3.8.22A",   "rule": "Rebid explanation length + keyword check",
         "enforced": False, "note": "Field present, no minimum-length enforcement"},
    ]
    enforced_count = sum(1 for r in rule_items if r["enforced"])
    rule_coverage_pct = round(100 * enforced_count / len(rule_items))

    # ---- Overall score ----
    # Weighted average: conduct 45%, contracts 30%, data 25%.
    # Rule-enforcement section is informational (it's "we wrote validators",
    # not a measured behaviour — including it inflates the score artificially).
    overall_score = round(
        0.45 * conduct_score + 0.30 * contracts_score + 0.25 * data_score
    )
    if overall_score >= 85: status_label = "PRUDENT"
    elif overall_score >= 70: status_label = "ACCEPTABLE"
    elif overall_score >= 55: status_label = "NEEDS REVIEW"
    else: status_label = "AT RISK"

    return {
        "portfolio_id": portfolio_id,
        "window_days": days,
        "generated_at": _iso(now),
        "overall_score": overall_score,
        "overall_status": status_label,
        "summary": {
            "total_bids": total_bids,
            "rebids": rebids,
            "settled": settled,
            "pending": pending,
            "cancelled": cancelled,
            "rule_coverage_pct": rule_coverage_pct,
            "rules_enforced": enforced_count,
            "rules_total": len(rule_items),
        },
        "categories": [
            {
                "id": "rules",
                "title": "Rule enforcement",
                "score": None,   # informational
                "items": rule_items,
            },
            {
                "id": "conduct",
                "title": "Participant conduct (AER lens)",
                "score": conduct_score,
                "deductions": deductions,
                "reason_distribution": [
                    {"reason": k, "count": v} for k, v in sorted(reason_counts.items(),
                                                                  key=lambda x: -x[1])
                ],
                "items": [
                    {"metric": "Total bids", "value": str(total_bids), "status": "info"},
                    {"metric": "Rebid ratio", "value": f"{rebid_ratio*100:.0f}%",
                     "threshold": "≤ 50%",
                     "status": "ok" if rebid_ratio <= 0.5 else "warn"},
                    {"metric": "Rebid explanation rate", "value": f"{explanation_rate*100:.0f}%",
                     "threshold": "≥ 50%",
                     "status": "ok" if explanation_rate >= 0.5 or rebids == 0 else "warn"},
                    {"metric": "STRATEGY/OTHER reason share", "value": f"{strategy_other_rate*100:.0f}%",
                     "threshold": "≤ 30%",
                     "status": "ok" if strategy_other_rate <= 0.3 else "warn"},
                    {"metric": "Last-minute submit rate (≤60s to gate)",
                     "value": f"{late_rate*100:.0f}%", "threshold": "≤ 20%",
                     "status": "ok" if late_rate <= 0.2 else "warn"},
                ],
            },
            {
                "id": "contracts",
                "title": "Customer contract compliance",
                "score": contracts_score,
                "summary": {"ok": contracts_ok, "warn": contracts_warn, "breach": contracts_breach},
                "items": contract_items,
            },
            {
                "id": "data",
                "title": "Data freshness (operational health)",
                "score": data_score,
                "items": data_items,
            },
        ],
    }


@router.get("/intervals")
def next_intervals(n: int = Query(8, ge=1, le=24)) -> dict:
    """N upcoming dispatch intervals whose gate hasn't closed yet."""
    now = _nem_now()
    out = []
    candidate = _ceil_to_dispatch(now)
    while len(out) < n:
        gate = candidate - timedelta(minutes=INTERVAL_MIN, seconds=GATE_BUFFER_SECONDS)
        if now < gate:
            out.append(candidate.isoformat())
        candidate += timedelta(minutes=INTERVAL_MIN)
    return {"intervals": out, "interval_minutes": INTERVAL_MIN}


# ---- Helpers --------------------------------------------------------------

def _iso(v) -> str | None:
    if v is None: return None
    if isinstance(v, datetime): return v.isoformat()
    return str(v)
