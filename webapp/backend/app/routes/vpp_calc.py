"""VPP-Calc — C&I "should I join a VPP?" revenue simulator.

Models a commercial & industrial (C&I) site with PV + battery and compares
three operating modes, annualised. Joining a VPP switches the SITE from a
retail ToU tariff to a wholesale (spot pass-through) plan — so the load is
billed at SPOT in modes B/C, at retail in A — and changes how the battery is
operated. The VPP uplift therefore combines the tariff switch (the dominant
term) with the battery's spot arbitrage and FCAS:

  Mode A  无 VPP (retail ToU)
          Retail ToU tariff. Battery does retail ToU arbitrage during working
          hours (charge cheap off-peak, discharge to serve load at the peak),
          idle otherwise.

  Mode B  VPP · 非工作时段 (wholesale tariff)
          Load billed at spot. Working hours: battery just serves the site
          ("不管它", one self-use cycle). Non-working hours: the VPP runs the
          otherwise-idle battery for spot arbitrage, discharging to the grid.

  Mode C  VPP · 全程 (wholesale tariff)
          Load billed at spot. The VPP controls the battery 24/7 for spot
          arbitrage to the grid (more cycles, whole-day flexibility).

Battery arbitrage is valued on the REAL per-day 5-minute spot curves
(Jan–May 2026), so intraday spikes — including rare extreme events up to
thousands of $/MWh — drive the numbers, not a flattened average. A separate
EXTREME-DAY scenario replays the single highest-price real day to show the
tail upside a VPP captures.
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta

from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..cache import ttl_cache
from ..config import NEM_REGIONS
from ..db import locked_conn

router = APIRouter(prefix="/api/vpp-calc", tags=["vpp-calc"])

STEPS = 288         # 5-min dispatch intervals in a day (matches NEM 5MS)
DT = 1.0 / 12.0     # hours per step (5 min)
WEEKDAYS = 252      # annual working days
WEEKENDS = 113      # annual non-working days (incl. holidays)

# Reference period for the representative spot curve & arbitrage valuation:
# real 5-minute prices, Jan–May 2026 (most recent complete 5-month window).
PRICE_FROM = "2026-01-01"
PRICE_TO = "2026-06-01"

# Max charge/discharge cycles per day per mode. A: one ToU self-use cycle.
# B (非工作时段VPP): a couple of cycles. C (全程VPP): cycles hard to exploit
# every profitable spread — the core VPP value of maximising asset use.
MAX_CYCLES = {"A": 1, "B": 2, "C": 3}

# Minimum round-trip spread ($/kWh) before a cycle is worth doing — covers
# battery wear/degradation. Stops the model churning on $4/MWh spreads.
MIN_SPREAD = 0.03


# Residential "at-home" self-use windows (battery serves the household): a
# morning block and an evening block. Outside these (daytime away + late night)
# the battery is idle in mode A — the slack a VPP monetises, mirroring the C&I
# after-hours idle window.
RES_HOME_MORNING = (6, 9)
RES_HOME_EVENING = (16, 23)


# ── Inputs ────────────────────────────────────────────────────────────────
class VPPCalcInput(BaseModel):
    region: str = Field("NSW1")
    segment: str = Field("ci")                       # "ci" (C&I) | "residential"
    annual_load_mwh: float = Field(1000, gt=0)      # site annual consumption
    pv_kw: float = Field(100, ge=0)                 # PV DC capacity
    bess_power_kw: float = Field(100, ge=0)         # battery power
    bess_energy_kwh: float = Field(215, ge=0)       # battery energy (≈2 h cabinet)
    rte_pct: float = Field(88, gt=0, le=100)        # round-trip efficiency

    # Retail ToU tariff ($/kWh) — ALL-IN small-business rates (incl. network),
    # blend of AGL + Origin NSW Ausgrid published rates (2025, incl. GST).
    # Windows (AGL NSW): peak wkday 14-20, shoulder 7-14 & 20-22, offpeak 22-7
    # + all weekend. Network is bundled into these, so it is NOT added again
    # on top in retail mode (only added in the wholesale modes B/C).
    retail_peak: float = Field(0.66)
    retail_shoulder: float = Field(0.36)
    retail_offpeak: float = Field(0.25)
    feed_in_tariff: float = Field(0.05)             # PV export under retail (business FiT)

    # Working hours (site active) — also the ToU peak window driver
    work_start_h: int = Field(9, ge=0, le=23)
    work_end_h: int = Field(17, ge=1, le=24)

    # Network + environmental charges ($/kWh) added on the WHOLESALE plans
    # (B/C), where energy is unbundled spot. In retail (A) these are already
    # baked into the all-in ToU rate above, so they're not double-counted.
    network_per_kwh: float = Field(0.10, ge=0)

    # VPP economics — FCAS availability for a SINGLE contingency market the
    # VPP can realistically win. RAISE6SEC is the highest-value contingency
    # service (NSW1 90-day avg ~$2.5/MW/day). We model one market, not a sum:
    # raise & lower can't share the same MW and FCAS competes with energy for
    # inverter capacity. Lucrative regulation (~$97/MW/day) is out of reach
    # for aggregated DER and is excluded.
    fcas_per_mw_day: float = Field(2.5, ge=0)       # single-market FCAS availability $/MW/day
    vpp_customer_share_pct: float = Field(80, ge=0, le=100)  # customer keeps this % of VPP uplift
    wholesale_uplift_pct: float = Field(0, ge=-50, le=50)    # adj. to spot shape (scenario knob)


# ── Representative profiles ─────────────────────────────────────────────────
def _weekday_load_shape() -> list[float]:
    """Normalised C&I weekday load (0..1), high during working hours."""
    s = []
    for i in range(STEPS):
        h = i * DT
        if 8 <= h < 18:
            base = 1.0
        elif 6 <= h < 8 or 18 <= h < 21:
            base = 0.55
        else:
            base = 0.30
        s.append(base)
    return s


def _weekend_load_shape() -> list[float]:
    return [0.35 + 0.1 * math.sin((i * DT - 6) / 24 * math.pi) for i in range(STEPS)]


def _residential_weekday_load_shape() -> list[float]:
    """Normalised residential weekday load (0..1): evening-peak shaped — low
    overnight, morning bump, low midday (occupants away), big evening peak."""
    s = []
    for i in range(STEPS):
        h = i * DT
        if 17 <= h < 22:
            base = 1.0            # evening peak (cooking, AC, screens)
        elif 6 <= h < 9:
            base = 0.75           # morning bump
        elif 9 <= h < 16:
            base = 0.40           # daytime, mostly away
        elif 22 <= h < 24 or 16 <= h < 17:
            base = 0.60           # shoulder
        else:
            base = 0.30           # overnight
        s.append(base)
    return s


def _residential_weekend_load_shape() -> list[float]:
    """Weekend home load: flatter, higher daytime (occupants home), evening peak."""
    s = []
    for i in range(STEPS):
        h = i * DT
        if 17 <= h < 22:
            base = 0.95
        elif 8 <= h < 17:
            base = 0.60           # home during the day
        elif 22 <= h < 24:
            base = 0.55
        else:
            base = 0.35
        s.append(base)
    return s


def _pv_shape() -> list[float]:
    """Normalised PV output (0..1), bell curve ~6:00–19:00 peak at 12:30."""
    s = []
    for i in range(STEPS):
        h = i * DT
        if 6 <= h <= 19:
            x = (h - 12.5) / 6.5
            s.append(max(0.0, math.cos(x * math.pi / 2) ** 1.5))
        else:
            s.append(0.0)
    return s


def _self_use_hours(segment: str, ws: int, we: int) -> list[int]:
    """Slot indices where the battery is in SELF-USE mode (serving the site's
    own load). C&I: working hours [ws, we). Residential: at-home blocks
    (morning + evening). Hour-based (weekend handled separately in the chart)."""
    if segment == "residential":
        (ms, me), (es, ee) = RES_HOME_MORNING, RES_HOME_EVENING
        return [i for i in range(STEPS)
                if (ms <= i * DT < me) or (es <= i * DT < ee)]
    return [i for i in range(STEPS) if ws <= i * DT < we]


@ttl_cache(900)
def _wholesale_shape(region: str) -> list[float]:
    """Representative intraday spot ($/kWh) — arithmetic mean of REAL 5-minute
    prices over Jan–May 2026, by 5-min bucket (288). Captures the sharp evening
    peak (e.g. ~17:55) that 30-min averaging flattens out."""
    with locked_conn() as con:
        rows = con.execute(
            """
            SELECT (CAST(strftime('%H',settlementdate) AS INT)*60
                    + CAST(strftime('%M',settlementdate) AS INT))/5 AS bucket,
                   AVG(rrp)
            FROM nem_dispatch_price
            WHERE regionid=? AND settlementdate >= ? AND settlementdate < ?
            GROUP BY bucket ORDER BY bucket
            """,
            (region, PRICE_FROM, PRICE_TO),
        ).fetchall()
    arr: list[float | None] = [None] * STEPS
    for b, p in rows:
        if b is not None and 0 <= int(b) < STEPS and p is not None:
            arr[int(b)] = max(p / 1000.0, -1.0)   # $/MWh → $/kWh
    for i in range(STEPS):
        if arr[i] is None:
            arr[i] = arr[i - 1] if i > 0 and arr[i - 1] is not None else 0.0
    return [x for x in arr]  # type: ignore[return-value]


@ttl_cache(900)
def _daily_price_shapes(region: str) -> list[list[float]]:
    """Per-DAY 5-minute spot shapes ($/kWh), Jan–May 2026. Battery arbitrage is
    valued on these REAL daily curves (incl. intra-day 5-min spikes up to
    thousands of $/MWh) — averaging to a single curve hides where the money is."""
    with locked_conn() as con:
        rows = con.execute(
            """
            SELECT date(settlementdate) AS d,
                   (CAST(strftime('%H',settlementdate) AS INT)*60
                    + CAST(strftime('%M',settlementdate) AS INT))/5 AS b,
                   rrp
            FROM nem_dispatch_price
            WHERE regionid=? AND settlementdate >= ? AND settlementdate < ?
            """,
            (region, PRICE_FROM, PRICE_TO),
        ).fetchall()
    by_day: dict[str, list[float | None]] = {}
    for d, b, p in rows:
        if b is None or p is None:
            continue
        arr = by_day.setdefault(d, [None] * STEPS)
        if 0 <= int(b) < STEPS:
            arr[int(b)] = p / 1000.0
    out = []
    for arr in by_day.values():
        if sum(1 for x in arr if x is not None) >= STEPS - 12:   # allow ≤1h gaps
            filled = [arr[i] if arr[i] is not None else 0.0 for i in range(STEPS)]
            out.append(filled)
    return out


# ── Multi-cycle, SoC-feasible foresight arbitrage ───────────────────────────
def _arb_pairs(prices: list[float], win: list[int], max_pairs: int,
               eff: float, cap_u: int) -> list[tuple[int, int]]:
    """Greedy multi-cycle arbitrage that respects battery CAPACITY over time.

    Process discharge slots dearest-first (so limited energy is spent on the
    very HIGHEST peaks). Each peak is backed by the cheapest earlier slot at
    which the battery still has ROOM to carry one more unit all the way to the
    peak (held < cap_u across the interval). This forces a re-charge in the
    dip between two peaks — e.g. discharge the 14:30 spike, recharge ~15:30,
    discharge the 18:40 spike — instead of dumping all overnight charge early.

    cap_u = battery capacity in slot-units (usable energy / one slot's energy).
    Returns (charge_slot, discharge_slot) pairs = the multi-cycle schedule."""
    if not win or max_pairs <= 0 or cap_u <= 0:
        return []
    order = sorted(win)                              # time order
    pos = {k: idx for idx, k in enumerate(order)}
    held = [0] * (len(order) + 1)                    # units carried into each step
    asc = sorted(win, key=lambda i: prices[i])       # cheapest first
    desc = sorted(win, key=lambda i: -prices[i])     # dearest first
    used: set[int] = set()
    pairs: list[tuple[int, int]] = []
    for dj in desc:
        if len(pairs) >= max_pairs:
            break
        if dj in used:
            continue
        dpos = pos[dj]
        chosen = None
        for ci in asc:
            if prices[dj] * eff - prices[ci] <= MIN_SPREAD:   # asc → rest worse
                break
            if ci in used:
                continue
            cpos = pos[ci]
            if cpos >= dpos:
                continue
            if all(held[k] < cap_u for k in range(cpos + 1, dpos + 1)):
                chosen = ci
                break
        if chosen is None:
            continue
        pairs.append((chosen, dj)); used.add(chosen); used.add(dj)
        for k in range(pos[chosen] + 1, dpos + 1):
            held[k] += 1
    return pairs


def _cap_units(usable: float, pmax: float) -> int:
    return max(1, round(usable / (pmax * DT))) if pmax > 0 else 0


def _max_pairs(max_cycles: int, usable: float, pmax: float) -> int:
    if pmax <= 0:
        return 0
    return max(1, round(max_cycles * usable / (pmax * DT)))


@ttl_cache(900)
def _real_arb_per_year(region: str, pmax: float, usable: float, eff: float,
                       max_cycles, uplift: float,
                       window: str, ws: int, we: int, segment: str = "ci") -> float:
    """Annual battery wholesale-arbitrage $, valued on REAL daily 5-min spot
    shapes. window: "work" = self-use window only, "nonwork" = its complement
    (mode B's VPP window), "all" = whole day (mode C). The self-use window is
    segment-specific (C&I working hours vs residential at-home blocks).
    max_cycles=None → UNCAPPED: cycle as many times as the price spread justifies
    (the MIN_SPREAD profitability gate + SoC feasibility are the only limits)."""
    if pmax <= 0:
        return 0.0
    days = _daily_price_shapes(region)
    if not days:
        return 0.0
    self_use = set(_self_use_hours(segment, ws, we))
    if window == "nonwork":
        win = [i for i in range(STEPS) if i not in self_use]
    elif window == "work":
        win = sorted(self_use)
    else:  # "all"
        win = list(range(STEPS))
    mp = len(win) if max_cycles is None else _max_pairs(max_cycles, usable, pmax)
    cap_u = _cap_units(usable, pmax)
    slot_kwh = pmax * DT
    total = 0.0
    for shape in days:
        prices = [max(shape[i] * (1 + uplift / 100.0), 0.0) for i in range(STEPS)]
        for ci, di in _arb_pairs(prices, win, mp, eff, cap_u):
            total += slot_kwh * eff * prices[di] - slot_kwh * prices[ci]
    return total / len(days) * 365.0


# ── Extreme-price day scenario ──────────────────────────────────────────────
@ttl_cache(900)
def _extreme_day(region: str) -> dict | None:
    """The single highest-spike REAL day for the region (Jan–May 2026): its
    date, peak $/MWh and full 5-min spot curve ($/kWh). NEM occasionally hits
    scarcity prices of thousands of $/MWh — this is where a VPP earns its keep."""
    with locked_conn() as con:
        top = con.execute(
            """
            SELECT date(settlementdate) d, MAX(rrp) mx
            FROM nem_dispatch_price
            WHERE regionid=? AND settlementdate >= ? AND settlementdate < ?
            GROUP BY d ORDER BY mx DESC LIMIT 1
            """,
            (region, PRICE_FROM, PRICE_TO),
        ).fetchone()
        if not top or top[0] is None:
            return None
        day = top[0]
        rows = con.execute(
            """
            SELECT (CAST(strftime('%H',settlementdate) AS INT)*60
                    + CAST(strftime('%M',settlementdate) AS INT))/5 AS b, rrp
            FROM nem_dispatch_price
            WHERE regionid=? AND date(settlementdate)=?
            """,
            (region, day),
        ).fetchall()
    arr: list[float | None] = [None] * STEPS
    for b, p in rows:
        if b is not None and 0 <= int(b) < STEPS and p is not None:
            arr[int(b)] = p / 1000.0
    for i in range(STEPS):
        if arr[i] is None:
            arr[i] = arr[i - 1] if i > 0 and arr[i - 1] is not None else 0.0
    return {"date": day, "peak_mwh": float(top[1]), "shape": [x for x in arr]}


def _extreme_day_result(inp: VPPCalcInput) -> dict | None:
    """Replay the VPP (24/7, mode-C style) battery dispatch on the extreme day's
    REAL 5-min curve and report the single-day revenue + dispatch for charting.
    Shows the tail value: discharging a full battery into a multi-thousand-$/MWh
    spike earns in one event what a normal day yields in a year of arbitrage."""
    ed = _extreme_day(inp.region)
    if not ed or inp.bess_power_kw <= 0:
        return None
    eff = math.sqrt(inp.rte_pct / 100.0)
    usable = inp.bess_energy_kwh * 0.9
    pmax = inp.bess_power_kw
    cap_u = _cap_units(usable, pmax)
    slot_kwh = pmax * DT
    prices = [max(ed["shape"][i] * (1 + inp.wholesale_uplift_pct / 100.0), 0.0)
              for i in range(STEPS)]
    # Uncapped (mode-C): cycle as many times as the spike-day spread justifies.
    pairs = _arb_pairs(prices, list(range(STEPS)), STEPS, eff, cap_u)
    revenue = discharged_kwh = 0.0
    bess = [0.0] * STEPS
    discharge_price_mwh = 0.0
    for ci, di in pairs:
        revenue += slot_kwh * eff * prices[di] - slot_kwh * prices[ci]
        discharged_kwh += slot_kwh * eff
        bess[ci] = round(-pmax, 1)
        bess[di] = round(pmax, 1)
        discharge_price_mwh = max(discharge_price_mwh, prices[di] * 1000)
    price_mwh = [round(ed["shape"][i] * 1000, 1) for i in range(STEPS)]
    # Normal-day arbitrage baseline (full-day, average over Jan–May) for context.
    normal_year = _real_arb_per_year(
        inp.region, pmax, usable, eff, None,
        inp.wholesale_uplift_pct, "all", inp.work_start_h, inp.work_end_h)
    normal_day = normal_year / 365.0
    return {
        "date": ed["date"],
        "peak_price_mwh": round(ed["peak_mwh"]),
        "discharge_price_mwh": round(discharge_price_mwh),
        "revenue": round(revenue),
        "equiv_cycles": round(discharged_kwh / usable, 1) if usable else 0,
        "normal_day_revenue": round(normal_day),
        "x_normal_days": round(revenue / normal_day) if normal_day > 1 else None,
        "curves": {"price": price_mwh, "bess": bess},
    }


def _retail_price(h: float, inp: VPPCalcInput, weekend: bool) -> float:
    """Retail ToU $/kWh at hour h."""
    if weekend:
        return inp.retail_offpeak
    if 14 <= h < 20:
        return inp.retail_peak
    if 7 <= h < 14 or 20 <= h < 22:
        return inp.retail_shoulder
    return inp.retail_offpeak


# ── Battery dispatch + economics for one representative day ──────────────────
def _simulate_day(
    inp: VPPCalcInput, mode: str, weekend: bool,
    load_shape: list[float], pv_shape: list[float],
    wholesale: list[float], load_scale_kw: float, pv_scale_kw: float,
    *, bess_on: bool = True,
) -> dict:
    """Run one representative day with FORESIGHT, energy-limited dispatch.

      Mode A 无VPP    : working-hours ToU self-use — charge cheapest retail
                        slots, discharge dearest, all serving the site.
      Mode B 非工作VPP: working-hours wholesale self-use — charge lowest spot,
                        discharge highest spot, serving the site (BTM only).
      Mode C 全程VPP  : Mode-B working-hours self-use PLUS, in non-working
                        hours, wholesale arbitrage exporting to the grid.

    Battery energy (e.g. 100 kW / 215 kWh ≈ 2 h) caps how many slots it can
    charge/discharge — no more 3-hour full-power runs."""
    eff = math.sqrt(inp.rte_pct / 100.0)
    cap = inp.bess_energy_kwh if bess_on else 0.0
    pmax = inp.bess_power_kw if bess_on else 0.0
    soc_min, soc_max = cap * 0.05, cap * 0.95
    usable = soc_max - soc_min
    soc = soc_min                                   # start empty, fill on cheap slots

    # Per-slot inputs
    loads = [load_shape[i] * load_scale_kw for i in range(STEPS)]
    pvs = [pv_shape[i] * pv_scale_kw for i in range(STEPS)]
    whp = [max(wholesale[i] * (1 + inp.wholesale_uplift_pct / 100.0), 0.0)
           for i in range(STEPS)]
    # Joining a VPP switches the site from a retail ToU tariff to a wholesale
    # (spot pass-through) plan, so in modes B/C the LOAD is billed at spot;
    # only mode A is on retail. Export at FiT (retail) or spot (VPP).
    if mode == "A":
        buy = [_retail_price(i * DT, inp, weekend) for i in range(STEPS)]
        sell = [inp.feed_in_tariff] * STEPS
    else:
        buy = list(whp)
        sell = list(whp)

    # Self-use vs VPP slots (C&I working hours, or residential at-home blocks)
    self_use = set(_self_use_hours(inp.segment, inp.work_start_h, inp.work_end_h))
    def _working(i: int) -> bool:
        return (not weekend) and (i in self_use)
    work_slots = [i for i in range(STEPS) if _working(i)]
    nonwork_slots = [i for i in range(STEPS) if not _working(i)]

    # Dispatch per mode (representative-day visualisation):
    #   A — retail ToU self-use during working hours (charge cheap, discharge
    #       to load at peak), one cycle. Idle outside working hours.
    #   B — working hours unmanaged ("不管它"); after-hours spot arbitrage to
    #       the grid (the VPP part), spread-driven (≥2 cycles).
    #   C — VPP runs the battery 24/7 on spot arbitrage → grid, UNCAPPED:
    #       as many cycles as the price spread justifies.
    all_slots = list(range(STEPS))
    charge_set: set[int] = set()
    load_dis: set[int] = set()      # discharge to serve site load (BTM / ToU)
    grid_dis: set[int] = set()      # discharge to grid (VPP wholesale arb)
    charge_tag: dict[int, str] = {}  # "btm" (ToU cycle) | "arb" (VPP cycle)
    charge_cap: dict[int, float] = {}  # per-slot charge power cap (kW); default = pmax
    if bess_on and pmax > 0:
        cap_u = _cap_units(usable, pmax)
        mp_tou = _max_pairs(MAX_CYCLES["A"], usable, pmax)
        if mode == "A" and inp.segment == "residential":
            # Residential mode A = SOLAR SELF-CONSUMPTION. A home battery's main
            # value is storing the free midday PV SURPLUS (opportunity cost = the
            # FiT it would otherwise earn) and discharging it into the evening
            # retail peak — NOT charging from the grid at the retail off-peak.
            # Energy-balanced so the small evening load is never over-charged.
            resid = [max(loads[k] - pvs[k], 0.0) for k in range(STEPS)]
            surp = [max(pvs[k] - loads[k], 0.0) for k in range(STEPS)]
            e_dis = 0.0  # discharge into the dearest-retail residual-load slots
            for k in sorted((k for k in range(STEPS) if resid[k] > 0), key=lambda k: -buy[k]):
                if e_dis >= usable:
                    break
                load_dis.add(k); e_dis += resid[k] * DT
            e_chg = 0.0  # charge the matching energy from the biggest PV surplus
            for k in sorted((k for k in range(STEPS) if surp[k] > 0), key=lambda k: -surp[k]):
                if e_chg >= e_dis / eff:
                    break
                charge_set.add(k); charge_tag[k] = "btm"; charge_cap[k] = surp[k]
                e_chg += surp[k] * DT
        elif mode == "A":
            # C&I: retail ToU arbitrage, one working-hours cycle.
            for ci, di in _arb_pairs(buy, work_slots, mp_tou, eff, cap_u):
                charge_set.add(ci); load_dis.add(di); charge_tag[ci] = "btm"
        elif mode == "B":   # daytime self-use (1 cycle) + after-hours grid arb (uncapped)
            for ci, di in _arb_pairs(whp, work_slots, mp_tou, eff, cap_u):
                charge_set.add(ci); load_dis.add(di); charge_tag[ci] = "btm"
            for ci, di in _arb_pairs(whp, nonwork_slots, len(nonwork_slots), eff, cap_u):
                charge_set.add(ci); grid_dis.add(di); charge_tag.setdefault(ci, "arb")
        elif mode == "C":   # 24/7 grid arbitrage, spread-driven (uncapped)
            for ci, di in _arb_pairs(whp, all_slots, len(all_slots), eff, cap_u):
                charge_set.add(ci); grid_dis.add(di); charge_tag.setdefault(ci, "arb")

    load_c, pv_c, bess_c, price_c = [], [], [], []
    import_cost = export_rev = 0.0
    gross_load_cost = pv_self_saving = pv_export_rev = 0.0
    btm_value = arb_value = 0.0

    def _step_cost(net_kw: float, b: float, s: float) -> float:
        return net_kw * b if net_kw >= 0 else net_kw * s

    for i in range(STEPS):
        load, pv = loads[i], pvs[i]
        buy_price, sell_price = buy[i], sell[i]
        pv_to_load = min(pv, load)
        residual = load - pv_to_load
        surplus = pv - pv_to_load

        gross_load_cost += load * buy_price * DT
        pv_self_saving += pv_to_load * buy_price * DT
        pv_export_rev += surplus * sell_price * DT

        # ── Battery action from the foresight schedule (power + energy limited) ──
        bess_p = 0.0
        if i in charge_set and soc < soc_max:
            bess_p = -min(pmax, charge_cap.get(i, pmax), (soc_max - soc) / eff / DT)
        elif i in load_dis and residual > 0 and soc > soc_min:
            bess_p = min(pmax, residual, (soc - soc_min) * eff / DT)  # self-use only
        elif i in grid_dis and soc > soc_min:
            bess_p = min(pmax, (soc - soc_min) * eff / DT)            # export to grid

        if bess_p < 0:
            soc += -bess_p * eff * DT
        elif bess_p > 0:
            soc -= bess_p / eff * DT
        soc = max(soc_min, min(soc_max, soc))

        # Value this step vs no-battery. The representative-day btm_value
        # (working-hours retail ToU self-use) is what the ANNUAL waterfall uses
        # for both A and B. Grid arbitrage value is NOT taken from here — it is
        # valued on the real daily 5-min curves in _real_arb_per_year.
        net_with = residual - max(bess_p, 0.0) + max(-bess_p, 0.0) - surplus
        net_without = residual - surplus
        value_step = (_step_cost(net_without, buy_price, sell_price)
                      - _step_cost(net_with, buy_price, sell_price)) * DT
        # Attribute: ToU self-use cycle → btm; VPP grid-arbitrage cycle → arb.
        if bess_p < 0:  # charging
            if charge_tag.get(i) == "arb":
                arb_value += value_step
            else:
                btm_value += value_step
        elif bess_p > 0:  # discharging
            if i in grid_dis:
                arb_value += value_step
            else:
                btm_value += value_step

        if net_with >= 0:
            import_cost += net_with * buy_price * DT
        else:
            export_rev += -net_with * sell_price * DT

        load_c.append(round(load, 1))
        pv_c.append(round(pv, 1))
        bess_c.append(round(bess_p, 1))
        # Price line: retail ToU for mode A, wholesale spot for VPP modes B/C
        # (matches the price the VPP battery actually responds to).
        price_c.append(round((buy_price if mode == "A" else whp[i]) * 1000, 1))

    return {
        "curves": {"load": load_c, "pv": pv_c, "bess": bess_c, "price": price_c},
        "import_cost": import_cost,
        "export_rev": export_rev,
        "gross_load_cost": gross_load_cost,
        "pv_self_saving": pv_self_saving,
        "pv_export_rev": pv_export_rev,
        "btm_value": btm_value,
        "arb_value": arb_value,
        "net_cost": import_cost - export_rev,
    }


def _annual_fcas(inp: VPPCalcInput, mode: str) -> float:
    """Annual FCAS availability revenue (customer share)."""
    if mode == "A" or inp.fcas_per_mw_day <= 0:
        return 0.0
    mw = inp.bess_power_kw / 1000.0
    # Mode B: enrolled only outside working hours (~14h/day) → ~0.58 factor.
    frac = 0.58 if mode == "B" else 1.0
    gross = inp.fcas_per_mw_day * mw * 365 * frac
    return gross * inp.vpp_customer_share_pct / 100.0


def _annualise(wd: dict, we: dict, key: str) -> float:
    return wd[key] * WEEKDAYS + we[key] * WEEKENDS


def _run_mode(inp: VPPCalcInput, mode: str, wholesale: list[float],
              wd_load: list[float], we_load: list[float], pv: list[float],
              wd_scale: float, we_scale: float, pv_scale: float) -> dict:
    """Full annual result for one mode as a reconciling waterfall, with the
    battery value split by ENERGY FLOW (not net-cost differences):

      net_bill = gross_load_cost + network
               − pv_self_saving − pv_export_revenue   (PV)
               − btm_value                            (battery → site load)
               − vpp_arbitrage                        (battery → grid sales)
               − fcas_revenue
    Each term is an explicit cash flow, so battery grid-export revenue lands
    in VPP arbitrage, never hidden in the energy-cost line."""
    def day(m, weekend, load, scale):
        return _simulate_day(inp, m, weekend, load, pv, wholesale, scale, pv_scale, bess_on=True)

    # Mode-specific dispatch — used for the representative-day CHART only.
    wd = day(mode, False, wd_load, wd_scale)
    we = day(mode, True, we_load, we_scale)

    gross = _annualise(wd, we, "gross_load_cost")        # A: retail · B/C: spot
    pv_self = _annualise(wd, we, "pv_self_saving")
    pv_export = _annualise(wd, we, "pv_export_rev")
    fcas = _annual_fcas(inp, mode)

    # Battery value. Mode A is retail ToU self-use (fixed retail prices →
    # representative-day sim is exact). Modes B/C are valued on REAL daily 5-min
    # spot shapes (Jan–May 2026), computed directly (not from the merged-cycle
    # sim, which would double-use energy):
    #   A — btm = retail ToU self-use; no VPP arbitrage.
    #   B — battery serves load during working hours (1 self-use cycle, "不管它"),
    #       and the VPP runs the after-hours idle battery for grid arbitrage.
    #       btm = work-window self-use, arb = non-work grid arbitrage.
    #   C — the VPP runs the battery 24/7 for grid arbitrage (more cycles,
    #       whole-day flexibility). btm = 0, arb = whole-day arbitrage.
    eff = math.sqrt(inp.rte_pct / 100.0)
    usable = inp.bess_energy_kwh * 0.9

    def real_arb(window, cycles):
        return _real_arb_per_year(inp.region, inp.bess_power_kw, usable, eff,
                                  cycles, inp.wholesale_uplift_pct, window,
                                  inp.work_start_h, inp.work_end_h, inp.segment)

    # Battery ASSET value per mode (all positive — it's what the storage earns):
    #   A — retail ToU self-use (working hours), idle after hours.
    #   B — working hours: 1 passive self-use cycle ("不管它"); after hours: the
    #       VPP runs the idle battery for spot arbitrage (spread-driven, ≥2).
    #   C — VPP runs the battery in BOTH windows, uncapped. Computed window-wise
    #       so C ≥ B by construction: C's working arb (uncapped) ≥ B's working
    #       self-use (1 cycle), and both share the same after-hours arb.
    if mode == "A":
        btm = _annualise(wd, we, "btm_value")          # retail ToU self-use
        arb = 0.0
    elif mode == "B":
        btm = real_arb("work", MAX_CYCLES["A"])        # daytime self-use (1 cycle, spot)
        arb = real_arb("nonwork", None)                # after-hours VPP grid arb
    else:  # C
        btm = 0.0
        arb = real_arb("work", None) + real_arb("nonwork", None)  # 24/7 grid arb (≥ B)

    # Retail (A) all-in rate already bundles network; the VPP wholesale plans
    # (B/C) buy energy at spot and pay network ($/kWh) separately on top.
    annual_kwh = inp.annual_load_mwh * 1000
    network_cost = 0.0 if mode == "A" else annual_kwh * inp.network_per_kwh
    net_bill = gross + network_cost - pv_self - pv_export - btm - arb - fcas

    return {
        "mode": mode,
        "curves": wd["curves"],                    # representative weekday, mode dispatch
        "annual": {
            "gross_load_cost": round(gross),       # load energy at this tariff, no PV/BESS
            "network_cost": round(network_cost),   # network + green (all modes)
            "pv_self_saving": round(pv_self),      # PV avoids buying load energy
            "pv_export_revenue": round(pv_export), # PV export earnings
            "bess_value": round(btm),              # battery → site load (behind-the-meter)
            "vpp_arbitrage": round(arb),           # battery → grid sales (VPP energy arbitrage)
            "fcas_revenue": round(fcas),           # VPP FCAS (customer share)
            "battery_asset_value": round(btm + arb + fcas),  # total annual earnings of the storage asset
            "net_bill": round(net_bill),           # final annual cost (lower = better)
        },
    }


@router.post("/simulate")
def simulate(inp: VPPCalcInput) -> dict:
    region = inp.region.upper() if inp.region.upper() in NEM_REGIONS else "NSW1"
    inp.region = region                      # normalise so _run_mode arb uses it
    wholesale = _wholesale_shape(region)

    if inp.segment == "residential":
        wd_load = _residential_weekday_load_shape()
        we_load = _residential_weekend_load_shape()
    else:
        wd_load = _weekday_load_shape()
        we_load = _weekend_load_shape()
    pv = _pv_shape()

    # Scale shapes so annual energy matches the input.
    annual_kwh = inp.annual_load_mwh * 1000
    wd_day_kwh_unit = sum(wd_load) * DT     # per unit peak kW
    we_day_kwh_unit = sum(we_load) * DT
    denom = wd_day_kwh_unit * WEEKDAYS + we_day_kwh_unit * WEEKENDS
    peak_kw = annual_kwh / denom if denom else 0.0
    wd_scale = peak_kw
    we_scale = peak_kw

    # PV scale: peak kW = pv_kw; shape already 0..1 of capacity.
    pv_scale = inp.pv_kw

    modes = {m: _run_mode(inp, m, wholesale, wd_load, we_load, pv,
                          wd_scale, we_scale, pv_scale) for m in ("A", "B", "C")}

    # VPP uplift = the value the VPP itself generates from the battery, by mode:
    #   B — only what the VPP actively manages: grid arbitrage + FCAS. The
    #       working-hours self-use is "不管它" (the customer's own use), excluded.
    #   C — the VPP manages the battery 24/7, so EVERYTHING the battery earns
    #       counts: self-use + grid arbitrage + FCAS (= battery asset value).
    # The load's retail→spot tariff change is a separate effect (visible in the
    # energy-cost line) and is deliberately NOT shown as a VPP saving.
    A = modes["A"]["annual"]
    base = A["net_bill"]
    load_net_A = (A["gross_load_cost"] + A["network_cost"]
                  - A["pv_self_saving"] - A["pv_export_revenue"])
    for mode in modes.values():
        a = mode["annual"]
        m = mode["mode"]
        if m == "B":
            a["vpp_uplift"] = a["vpp_arbitrage"] + a["fcas_revenue"]
        elif m == "C":
            a["vpp_uplift"] = a["bess_value"] + a["vpp_arbitrage"] + a["fcas_revenue"]
        else:  # A — no VPP
            a["vpp_uplift"] = 0
        load_net = (a["gross_load_cost"] + a["network_cost"]
                    - a["pv_self_saving"] - a["pv_export_revenue"])
        a["tariff_switch_saving"] = round(load_net_A - load_net)
        a["total_saving"] = round(base - a["net_bill"])
        a["savings_vs_a"] = a["vpp_uplift"]

    # Time axis labels (HH:MM) at 5-min resolution
    axis = [f"{(i*5)//60:02d}:{(i*5)%60:02d}" for i in range(STEPS)]

    return {
        "region": region,
        "inputs": inp.model_dump(),
        "axis": axis,
        "modes": modes,
        "extreme_day": _extreme_day_result(inp),
        "generated_at": datetime.utcnow().isoformat(),
    }
