"""Paper-trading endpoints. Front-end uses these to submit/inspect bids
against the WTAHB1 (Waratah Super Battery) paper account."""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from .. import paper

router = APIRouter(prefix="/api/paper", tags=["paper"])


class Band(BaseModel):
    price: float = Field(..., description="$/MWh (energy) or $/MW/hr (FCAS)")
    mw: float = Field(..., ge=0, description="Available MW at this band")


class FCASTrapezium(BaseModel):
    """AEMO FCAS co-optimisation trapezium (NER 3.8.7A + MASS).

    Defines the joint ENERGY + FCAS feasible region used by NEMDE. Stored
    as JSON alongside the bid for display/audit; not used in the paper-trading
    settlement simulation (which settles at FCAS_RRP × MW as a capacity payment).
    """
    enablement_min_mw: float
    low_breakpoint_mw: float
    high_breakpoint_mw: float
    enablement_max_mw: float
    t1_sec: float = 0
    t2_sec: float = 4
    t3_sec: float = 60
    t4_sec: float = 60


class BidIn(BaseModel):
    duid: str = "WTAHB1"
    target_settlementdate: str = Field(..., description="ISO timestamp, end of 5-min interval")
    market: str = Field("ENERGY", description="ENERGY or one of the 10 FCAS markets")
    direction: str = Field("GEN", description="GEN (sell/raise) or LOAD (buy/lower)")
    bands: list[Band]
    notes: str | None = None
    replaces_bid_id: int | None = Field(
        None,
        description=(
            "Optional: bid_id of an existing PENDING bid that this submission "
            "supersedes. Must match the same (DUID, target, market, direction). "
            "The old bid is cancelled atomically and linked via previous_bid_id."
        ),
    )
    fcas_trapezium: FCASTrapezium | None = Field(
        None,
        description="Optional FCAS enablement trapezoid. Required for NEMDE co-optimisation. "
                    "Stored for audit; does not affect paper-trading settlement.",
    )


@router.get("/markets")
def markets() -> dict:
    """All market keys (energy + 10 FCAS), grouped."""
    return {
        "energy": [paper.ENERGY],
        "raise_fcas": sorted(paper.RAISE_FCAS),
        "lower_fcas": sorted(paper.LOWER_FCAS),
    }


@router.get("/intervals")
def intervals(n: int = Query(6, ge=1, le=24)) -> dict:
    """Next N dispatch interval boundaries (UTC, ISO)."""
    ts = paper.next_intervals(n)
    return {
        "intervals": [t.isoformat() for t in ts],
        "interval_minutes": paper.INTERVAL_MIN,
    }


@router.get("/state")
def state(duid: str = Query("WTAHB1")) -> dict:
    s = paper.get_state(duid)
    if not s:
        raise HTTPException(404, f"no paper-trading state for {duid}")
    return s


@router.get("/bids")
def bids(duid: str | None = None, limit: int = Query(50, ge=1, le=500)) -> dict:
    return {"bids": paper.list_bids(duid, limit)}


@router.get("/fills")
def fills(duid: str | None = None, limit: int = Query(50, ge=1, le=500)) -> dict:
    return {"fills": paper.list_fills(duid, limit)}


@router.post("/bids")
def submit(bid: BidIn) -> dict:
    try:
        bands = [b.model_dump() for b in bid.bands]
        return paper.submit_bid(
            duid=bid.duid,
            target_settlementdate=bid.target_settlementdate,
            market=bid.market,
            direction=bid.direction,
            bands=bands,
            notes=bid.notes,
            replaces_bid_id=bid.replaces_bid_id,
            fcas_trapezium=bid.fcas_trapezium.model_dump() if bid.fcas_trapezium else None,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.delete("/bids/{bid_id}")
def cancel(bid_id: int) -> dict:
    try:
        return paper.cancel_bid(bid_id)
    except ValueError as e:
        # Only the literal "bid not found" string is a 404; everything else
        # (already-settled, gate-closed, …) is a 400 Bad Request.
        msg = str(e)
        status = 404 if msg.startswith("bid not found") else 400
        raise HTTPException(status, msg)


class BatchBidItem(BaseModel):
    target_settlementdate: str
    market: str = "ENERGY"
    direction: str = "GEN"
    bands: list[Band]
    fcas_trapezium: FCASTrapezium | None = None


class BatchBidIn(BaseModel):
    duid: str = "WTAHB1"
    bids: list[BatchBidItem]


@router.post("/bids/batch")
def submit_batch(req: BatchBidIn) -> dict:
    """Submit multiple bids in one call.

    Each bid is attempted independently; gate-closed or co-opt errors on one
    bid do not abort the rest. The caller receives per-bid ok/error so the UI
    can show exactly which intervals were accepted.
    """
    results = []
    for item in req.bids:
        try:
            r = paper.submit_bid(
                duid=req.duid,
                target_settlementdate=item.target_settlementdate,
                market=item.market,
                direction=item.direction,
                bands=[b.model_dump() for b in item.bands],
                fcas_trapezium=item.fcas_trapezium.model_dump() if item.fcas_trapezium else None,
            )
            results.append({
                "ok": True,
                "target": item.target_settlementdate,
                "market": item.market,
                "direction": item.direction,
                "bid_id": r["bid_id"],
            })
        except ValueError as e:
            results.append({
                "ok": False,
                "target": item.target_settlementdate,
                "market": item.market,
                "direction": item.direction,
                "error": str(e),
            })
    n_ok = sum(1 for r in results if r["ok"])
    return {"submitted": n_ok, "failed": len(results) - n_ok, "results": results}


@router.post("/reset")
def reset(duid: str = Query("WTAHB1")) -> dict:
    """Demo helper: wipe bids/fills, reset SoC to 50%."""
    return paper.reset_state(duid)


@router.post("/settle")
def settle_now() -> dict:
    """Force a settlement sweep (normally runs after each NEM tick)."""
    return {"settled": paper.settle_pending()}


@router.get("/analytics")
def paper_analytics(duid: str = Query("WTAHB1")) -> dict:
    """Daily P&L aggregation + summary stats for the paper-trading analytics panel.

    Returns daily buckets (energy vs FCAS split), a cumulative P&L series,
    and summary stats (total, 7d, 30d, annualised, win-rate).
    """
    return paper.analytics(duid)
