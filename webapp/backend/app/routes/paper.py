"""Paper-trading endpoints. Front-end uses these to submit/inspect bids
against the simulated RYAN1 BESS."""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from .. import paper

router = APIRouter(prefix="/api/paper", tags=["paper"])


class Band(BaseModel):
    price: float = Field(..., description="$/MWh (energy) or $/MW/hr (FCAS)")
    mw: float = Field(..., ge=0, description="Available MW at this band")


class BidIn(BaseModel):
    duid: str = "RYAN1"
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
def state(duid: str = Query("RYAN1")) -> dict:
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


@router.post("/reset")
def reset(duid: str = Query("RYAN1")) -> dict:
    """Demo helper: wipe bids/fills, reset SoC to 50%."""
    return paper.reset_state(duid)


@router.post("/settle")
def settle_now() -> dict:
    """Force a settlement sweep (normally runs after each NEM tick)."""
    return {"settled": paper.settle_pending()}
