"""VPP bid settlement worker.

Runs after every NEM tick. Picks up PENDING vpp_bid rows whose target
interval now has a cleared price in `nem_dispatch_price`, walks the bid
ladder to determine `enabled_mw`, applies the correct settlement formula
per market category, writes a `vpp_fill` row, marks the bid SETTLED, and
accrues `cumulative_pnl_aud` on the portfolio.

Settlement formulas (per AEMO):
- ENERGY GEN  : revenue = enabled_mw × RRP × 5/60 × MLF
- ENERGY LOAD : revenue = − enabled_mw × RRP × 5/60 ÷ MLF
- FCAS (any)  : revenue = enabled_mw × FCAS_RRP × 5/60         (no MLF)

Ladder clearing rules:
- ENERGY GEN / RAISE FCAS : band clears when band.price ≤ RRP
                             (the band asked for at-or-below the cleared price)
- ENERGY LOAD / LOWER FCAS: band clears when band.price ≥ RRP
                             (the buyer is willing to pay at-or-above RRP
                              to absorb energy / lower frequency)
- enabled_mw on a single band = band.mw (its declared availability at
  that price). Total enabled = sum of cleared bands' MW, capped at the
  bid's top-band MW (the envelope).
"""
from __future__ import annotations

import json
import logging
from datetime import datetime

from .db import write_conn
from .vpp_baseline import compute_baseline_kw, wdr_revenue

log = logging.getLogger("vpp.settle")

INTERVAL_MIN = 5
FCAS_RRP_COL: dict[str, str] = {
    "RAISEREG":   "raisereg_rrp",
    "RAISE5MIN":  "raise5min_rrp",
    "RAISE60SEC": "raise60sec_rrp",
    "RAISE6SEC":  "raise6sec_rrp",
    "RAISE1SEC":  "raise1sec_rrp",
    "LOWERREG":   "lowerreg_rrp",
    "LOWER5MIN":  "lower5min_rrp",
    "LOWER60SEC": "lower60sec_rrp",
    "LOWER6SEC":  "lower6sec_rrp",
    "LOWER1SEC":  "lower1sec_rrp",
}
RAISE_FCAS = {k for k in FCAS_RRP_COL if k.startswith("RAISE")}
LOWER_FCAS = {k for k in FCAS_RRP_COL if k.startswith("LOWER")}


def _portfolio_region(con, portfolio_id: str) -> str:
    row = con.execute(
        "SELECT region FROM vpp_portfolio WHERE portfolio_id = ?",
        (portfolio_id,),
    ).fetchone()
    return row[0] if row else "NSW1"


def _allocation_weighted_mlf(con, allocation_json: str) -> float:
    """Compute the MW-weighted MLF across the resources actually allocated
    for this bid. If allocation is empty or resources missing, default 1.0.
    For FCAS we always return 1.0 (FCAS isn't loss-adjusted)."""
    try:
        alloc = json.loads(allocation_json or "[]")
    except Exception:
        return 1.0
    if not alloc:
        return 1.0
    ids = [a.get("resource_id") for a in alloc if a.get("resource_id")]
    if not ids:
        return 1.0
    placeholders = ",".join(["?"] * len(ids))
    rows = con.execute(
        f"SELECT resource_id, mlf FROM vpp_resource WHERE resource_id IN ({placeholders})",
        ids,
    ).fetchall()
    mlf_by_id = {r[0]: float(r[1]) for r in rows}
    total_kw = 0.0
    weighted_sum = 0.0
    for a in alloc:
        rid = a.get("resource_id")
        kw = float(a.get("alloc_kw") or 0)
        m = mlf_by_id.get(rid, 1.0)
        total_kw += kw
        weighted_sum += kw * m
    return weighted_sum / total_kw if total_kw > 0 else 1.0


def _cleared_mw(bands: list[dict], rrp: float, market: str, direction: str,
                *, max_avail_mw: float | None = None) -> float:
    """Walk the ladder ascending by price and return total cleared MW,
    capped by MaxAvail if supplied.

    AEMO band semantics: each band's MW is offered AT THAT BAND'S PRICE
    independently. NEMDE picks cheapest-first up to RRP and accumulates.
    BIDPEROFFER also carries a MaxAvail field that hard-caps total dispatch
    independently of how many bands clear — we honour that here.
    """
    if rrp is None:
        return 0.0
    is_sell_side = (market == "ENERGY" and direction == "GEN") or market in RAISE_FCAS
    is_buy_side = (market == "ENERGY" and direction == "LOAD") or market in LOWER_FCAS
    total = 0.0
    # Iterate ascending by price — sell-side accumulates while price ≤ RRP,
    # buy-side accumulates while price ≥ RRP. For buy-side we still iterate
    # cheapest-first conceptually (a buyer offers high → pays high; the
    # bands ABOVE RRP clear because they're willing to pay).
    for b in sorted(bands, key=lambda x: float(x.get("price", 0))):
        price = float(b.get("price", 0))
        mw = float(b.get("mw", 0))
        if is_sell_side and price <= rrp:
            total += mw
        elif is_buy_side and price >= rrp:
            total += mw
    # BIDPEROFFER.MaxAvail hard cap. Applied AFTER band accumulation.
    if max_avail_mw is not None and max_avail_mw >= 0:
        total = min(total, max_avail_mw)
    return total


# ---- Per-resource allocation + SoC math ---------------------------------

def _split_fill_across_resources(
    con,
    bid_id: int,
    settlement_str: str,
    market: str,
    direction: str,
    signed_total_mw: float,
    cleared_price: float,
    mlf: float,
    alloc_json: str,
    now_str: str,
) -> tuple[float, list[tuple[str, float]]]:
    """Distribute a fill's enabled MW across the resources in its
    allocation, write one vpp_fill_alloc row per resource, and (for BESS
    on ENERGY) update each resource's SoC.

    Returns (revenue_total, list_of_(resource_id, soc_delta_kwh)) so the
    caller can confirm and use for logging.
    """
    try:
        alloc = json.loads(alloc_json or "[]")
    except Exception:
        alloc = []
    if not alloc or abs(signed_total_mw) < 1e-9:
        return 0.0, []

    # Fetch resource specs for the participating IDs — pull ALL fields
    # the per-resource branches might need so we don't re-query later.
    ids = [a.get("resource_id") for a in alloc if a.get("resource_id")]
    if not ids:
        return 0.0, []
    placeholders = ",".join(["?"] * len(ids))
    rows = con.execute(
        f"SELECT resource_id, kind, capacity_kwh, soc_kwh, rte_pct, mlf, "
        f"       nameplate_kw, window_start_hr, window_end_hr "
        f"FROM vpp_resource WHERE resource_id IN ({placeholders})",
        ids,
    ).fetchall()
    spec_by_id = {r[0]: {"resource_id": r[0], "kind": r[1], "capacity_kwh": r[2],
                          "soc_kwh": r[3], "rte_pct": r[4], "mlf": r[5],
                          "nameplate_kw": r[6], "window_start_hr": r[7],
                          "window_end_hr": r[8]} for r in rows}
    # Cache the portfolio's baseline method so WDR calls don't re-query.
    portfolio_meta = con.execute(
        "SELECT vp.baseline_method FROM vpp_fill vf "
        "JOIN vpp_portfolio vp ON vp.portfolio_id = vf.portfolio_id "
        "WHERE vf.bid_id = ? AND vf.settlementdate = ? AND vf.market = ?",
        (bid_id, settlement_str, market),
    ).fetchone()
    baseline_method = (portfolio_meta and portfolio_meta[0]) or "LBL_N10"

    # Look up the parent fill_id (must already be inserted by caller).
    frow = con.execute(
        "SELECT fill_id FROM vpp_fill WHERE bid_id = ? AND settlementdate = ? AND market = ?",
        (bid_id, settlement_str, market),
    ).fetchone()
    if not frow:
        return 0.0, []
    fill_id = frow[0]

    # Pro-rata each resource by its alloc_kw share. Total alloc kW is the
    # sum of declared allocations; we use proportional split of the actual
    # signed_total_mw (which is the cleared MW, potentially != bid envelope).
    total_alloc_kw = sum(float(a.get("alloc_kw") or 0) for a in alloc)
    if total_alloc_kw <= 0:
        return 0.0, []

    hours = INTERVAL_MIN / 60.0
    rev_total = 0.0
    soc_changes: list[tuple[str, float]] = []
    is_energy = market == "ENERGY"
    is_gen = direction == "GEN"
    sign = 1.0 if is_gen else -1.0   # signed direction for alloc_mw

    for a in alloc:
        rid = a.get("resource_id")
        if not rid: continue
        share = float(a.get("alloc_kw") or 0) / total_alloc_kw
        # alloc_mw uses parent's signed_total_mw share. signed_total_mw
        # is already signed by caller (+GEN/RAISE, -LOAD/LOWER).
        alloc_mw_signed = signed_total_mw * share
        alloc_mw_abs = abs(alloc_mw_signed)

        # Energy delivered/absorbed at the grid side, in MWh signed.
        # For FCAS: 0 (capacity-only).
        alloc_mwh = (alloc_mw_signed * hours) if is_energy else 0.0

        # Revenue calculation per AEMO settlement rules, with the
        # important resource-kind distinction for LOAD direction:
        #
        #   BESS GEN  → discharge into grid → +revenue (RRP × MWh × MLF)
        #   BESS LOAD → charge from grid    → −cost  (RRP × MWh ÷ MLF)
        #   EV  LOAD  → curtailment via WDR → +revenue (paid by AEMO for
        #               reduced consumption, NER 3.8.2A baseline payment)
        #   FCAS      → capacity-only payment, no MLF, sign by raise/lower
        spec = spec_by_id.get(rid, {})
        is_evcharger = spec.get("kind") == "evcharger"
        if is_energy:
            if is_gen:
                alloc_rev = alloc_mw_abs * cleared_price * hours * mlf
            elif is_evcharger:
                # WDR PAYMENT — positive revenue. Capped at baseline kW.
                target_dt = datetime.fromisoformat(settlement_str.replace(" ", "T")[:19])
                baseline, _meta = compute_baseline_kw(spec, target_dt, method=baseline_method)
                alloc_rev = wdr_revenue(spec, baseline, alloc_mw_abs * 1000.0,
                                         cleared_price, mlf, INTERVAL_MIN)
            else:
                # BESS LOAD = real charging cost (negative revenue).
                alloc_rev = -(alloc_mw_abs * cleared_price * hours / max(mlf, 1e-6))
        else:
            # FCAS capacity payment, no MLF, no sign games — both raise
            # and lower FCAS pay the participant cash for being enabled.
            alloc_rev = alloc_mw_abs * cleared_price * hours

        # SoC delta for BESS on ENERGY (uses the spec we already fetched).
        soc_delta_kwh = 0.0
        if is_energy and spec and spec.get("kind") == "bess":
            one_way_eff = (float(spec["rte_pct"]) ** 0.5) if spec["rte_pct"] else 1.0
            grid_kwh = alloc_mw_abs * hours * 1000.0   # convert MWh → kWh
            if is_gen:
                # Battery had to release more than what reached the grid
                soc_delta_kwh = -(grid_kwh / max(one_way_eff, 1e-6))
            else:
                # Battery stores less than what came off the grid
                soc_delta_kwh = +(grid_kwh * one_way_eff)
            # Update soc_kwh, clamped to [0, capacity]
            new_soc = max(0.0, min(float(spec["capacity_kwh"]),
                                    float(spec["soc_kwh"]) + soc_delta_kwh))
            con.execute(
                "UPDATE vpp_resource SET soc_kwh = ?, updated_at = ? WHERE resource_id = ?",
                (new_soc, now_str, rid),
            )

        con.execute(
            """
            INSERT INTO vpp_fill_alloc
                (fill_id, portfolio_id, resource_id, settlementdate, market, direction,
                 alloc_mw, alloc_mwh, revenue_aud, soc_delta_kwh, created_at)
            VALUES (?,
                    (SELECT portfolio_id FROM vpp_fill WHERE fill_id = ?),
                    ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (fill_id, fill_id, rid, settlement_str, market, direction,
             alloc_mw_signed, alloc_mwh, alloc_rev, soc_delta_kwh, now_str),
        )
        rev_total += alloc_rev
        soc_changes.append((rid, soc_delta_kwh))

    return rev_total, soc_changes


def _lookup_cleared_price(con, target_ts: str, region: str, market: str) -> float | None:
    """Pull the cleared price for this (market, interval, region) out of
    nem_dispatch_price. Returns None if the interval hasn't cleared yet."""
    col = "rrp" if market == "ENERGY" else FCAS_RRP_COL.get(market)
    if col is None:
        return None
    row = con.execute(
        f"SELECT {col} FROM nem_dispatch_price "
        "WHERE settlementdate = ? AND regionid = ?",
        (target_ts, region),
    ).fetchone()
    return float(row[0]) if row and row[0] is not None else None


def settle_pending(*, max_rows: int = 500) -> dict:
    """Settle all PENDING vpp_bid rows whose target interval has cleared.

    Returns a summary dict suitable for logging. Safe to run repeatedly
    (the vpp_fill table has UNIQUE(bid_id, settlementdate, market)).
    """
    out = {"checked": 0, "settled": 0, "skipped_no_price": 0, "revenue": 0.0,
           "by_market": {}}

    with write_conn() as con:
        rows = con.execute(
            """
            SELECT bid_id, portfolio_id, target_settlementdate, market, direction,
                   bands_json, allocation_json, max_avail_mw
            FROM vpp_bid
            WHERE status = 'PENDING'
            ORDER BY target_settlementdate
            LIMIT ?
            """,
            (max_rows,),
        ).fetchall()

    for r in rows:
        bid_id, portfolio_id, target_ts, market, direction, bands_json, alloc_json, max_avail_mw = r
        out["checked"] += 1

        # Normalise target timestamp to "YYYY-MM-DD HH:MM:SS" — matches the
        # format nem_dispatch_price uses.
        target_str = target_ts
        if isinstance(target_str, datetime):
            target_str = target_str.strftime("%Y-%m-%d %H:%M:%S")
        target_str = str(target_str).replace("T", " ")[:19]

        try:
            bands = json.loads(bands_json or "[]")
        except Exception:
            log.warning("vpp_bid %s: malformed bands_json", bid_id)
            continue

        with write_conn() as con:
            region = _portfolio_region(con, portfolio_id)
            rrp = _lookup_cleared_price(con, target_str, region, market)
            if rrp is None:
                out["skipped_no_price"] += 1
                continue

            enabled_mw = _cleared_mw(
                bands, rrp, market, direction,
                max_avail_mw=float(max_avail_mw) if max_avail_mw is not None else None,
            )
            mlf = _allocation_weighted_mlf(con, alloc_json) if market == "ENERGY" else 1.0

            # Revenue per AEMO settlement formulas
            hours = INTERVAL_MIN / 60.0
            if market == "ENERGY":
                if direction == "GEN":
                    revenue = enabled_mw * rrp * hours * mlf
                    energy_mwh = enabled_mw * hours
                    signed_mw = enabled_mw
                else:  # LOAD
                    cost = enabled_mw * rrp * hours / max(mlf, 1e-6)
                    revenue = -cost
                    energy_mwh = -enabled_mw * hours
                    signed_mw = -enabled_mw
            else:
                # FCAS — capacity payment, no MLF.
                revenue = enabled_mw * rrp * hours
                energy_mwh = 0.0
                # Sign by raise/lower for consistency in the UI.
                signed_mw = enabled_mw if market in RAISE_FCAS else -enabled_mw

            now_str = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
            inserted_fresh = False
            try:
                con.execute(
                    """
                    INSERT INTO vpp_fill
                        (bid_id, portfolio_id, settlementdate, market, direction,
                         cleared_price, enabled_mw, energy_mwh, revenue_aud,
                         mlf_applied, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (bid_id, portfolio_id, target_str, market, direction,
                     rrp, signed_mw, energy_mwh, revenue, mlf, now_str),
                )
                inserted_fresh = True
            except Exception as e:
                # Likely a duplicate (UNIQUE constraint). That means we
                # already settled this bid in a prior tick — just mark
                # it SETTLED so we stop reconsidering it.
                if "UNIQUE constraint" not in str(e):
                    log.warning("vpp_fill insert failed for bid %s: %s", bid_id, e)

            # Per-resource breakdown — only on a fresh insert so re-running
            # the worker doesn't double-credit resources or double-deplete
            # SoC. The split also evolves BESS SoC + applies WDR semantics
            # for EV LOAD, so its RETURNED revenue total is the authoritative
            # number (may differ from the parent's BESS-formula `revenue`
            # when EV chargers are in the allocation).
            actual_revenue = revenue
            if inserted_fresh:
                alloc_rev_total, _ = _split_fill_across_resources(
                    con, bid_id, target_str, market, direction,
                    signed_mw, rrp, mlf, alloc_json, now_str,
                )
                # If alloc-level math materially diverged from the BESS-
                # formula parent (i.e. mixed EV+BESS or EV-only LOAD),
                # patch the parent fill so the ledger row matches reality.
                if abs(alloc_rev_total - revenue) > 0.005:
                    con.execute(
                        "UPDATE vpp_fill SET revenue_aud = ? WHERE bid_id = ? "
                        "AND settlementdate = ? AND market = ?",
                        (alloc_rev_total, bid_id, target_str, market),
                    )
                    actual_revenue = alloc_rev_total

            con.execute(
                "UPDATE vpp_bid SET status = 'SETTLED' WHERE bid_id = ?",
                (bid_id,),
            )
            if inserted_fresh:
                con.execute(
                    "UPDATE vpp_portfolio SET cumulative_pnl_aud = cumulative_pnl_aud + ?, "
                    "       updated_at = ? WHERE portfolio_id = ?",
                    (actual_revenue, now_str, portfolio_id),
                )
                out["settled"] += 1
                out["revenue"] += actual_revenue
                cat = "ENERGY" if market == "ENERGY" else (
                    "FCAS_RAISE" if market in RAISE_FCAS else "FCAS_LOWER"
                )
                out["by_market"][cat] = out["by_market"].get(cat, 0.0) + actual_revenue

    if out["settled"] > 0:
        log.info("vpp settle: %d bids → $%.2f (by market: %s)",
                 out["settled"], out["revenue"],
                 {k: round(v, 2) for k, v in out["by_market"].items()})
    return out
