"""AEMO Marginal Loss Factor (MLF) API.

Marginal Loss Factors are used in NEM settlement:
  - Generator revenue  = RRP × MWh × MLF
  - Load/charge cost   = RRP × MWh / MLF
  - FCAS capacity payments are NOT adjusted by MLF

AEMO publishes per-DUID MLFs once per financial year (typically Feb–Mar).
The values seeded in nem_mlf represent AEMO's 2025-26 Loss Factor Report.

Endpoints
---------
GET /api/mlf
    Returns all DUIDs, optionally filtered by `region` or `financial_year`.
    Includes region-level averages (capacity-weighted) for each NEM region.

GET /api/mlf/regions
    Lightweight: just the capacity-weighted regional average MLF per region.
    Used by the BESS Calculator default-fill logic.
"""
from __future__ import annotations

from fastapi import APIRouter, Query

from ..db import get_conn

router = APIRouter(prefix="/api/mlf", tags=["mlf"])

# Current published financial year — bump each Feb/Mar when AEMO releases.
CURRENT_FY = "2025-26"


def _region_averages(con, fy: str) -> dict[str, float]:
    """Capacity-weighted average MLF per NEM region."""
    rows = con.execute(
        """
        SELECT region,
               SUM(mlf * COALESCE(capacity_mw, 1)) / SUM(COALESCE(capacity_mw, 1))
        FROM nem_mlf
        WHERE financial_year = ?
        GROUP BY region
        """,
        (fy,),
    ).fetchall()
    return {r[0]: round(r[1], 4) for r in rows if r[1] is not None}


@router.get("")
def get_mlf(
    region: str | None = Query(None, description="Filter by NEM region (e.g. NSW1)"),
    financial_year: str = Query(CURRENT_FY, description="Financial year (default: current)"),
    fuel_type: str | None = Query(None, description="Filter by fuel type"),
):
    """Return per-DUID MLF data, optionally filtered.

    Response includes:
    - `entries`: list of DUID records with MLF + coordinates for heatmap
    - `regional_averages`: capacity-weighted average MLF per region
    - `financial_year`: the FY these values belong to
    """
    con = get_conn()

    clauses: list[str] = ["financial_year = ?"]
    params: list = [financial_year]

    if region:
        clauses.append("UPPER(region) = UPPER(?)")
        params.append(region)
    if fuel_type:
        clauses.append("LOWER(fuel_type) = LOWER(?)")
        params.append(fuel_type)

    where = " AND ".join(clauses)
    rows = con.execute(
        f"""
        SELECT duid, station_name, region, fuel_type,
               capacity_mw, mlf, lat, lon, financial_year
        FROM nem_mlf
        WHERE {where}
        ORDER BY region, mlf DESC
        """,
        params,
    ).fetchall()

    entries = [
        {
            "duid":           r[0],
            "station_name":   r[1],
            "region":         r[2],
            "fuel_type":      r[3],
            "capacity_mw":    r[4],
            "mlf":            r[5],
            "lat":            r[6],
            "lon":            r[7],
            "financial_year": r[8],
        }
        for r in rows
    ]

    regional_averages = _region_averages(con, financial_year)

    # Simple unweighted stats per region (for the returned entries only)
    region_stats: dict[str, dict] = {}
    for e in entries:
        reg = e["region"]
        if reg not in region_stats:
            region_stats[reg] = {"mlfs": [], "cap_sum": 0.0, "cap_mlf_sum": 0.0}
        region_stats[reg]["mlfs"].append(e["mlf"])
        cap = e["capacity_mw"] or 1.0
        region_stats[reg]["cap_sum"] += cap
        region_stats[reg]["cap_mlf_sum"] += e["mlf"] * cap

    return {
        "financial_year":    financial_year,
        "source":            "AEMO Loss Factor Report 2025-26",
        "regional_averages": regional_averages,
        "entries":           entries,
        "count":             len(entries),
    }


@router.get("/regions")
def get_mlf_regions(
    financial_year: str = Query(CURRENT_FY),
):
    """Return only the capacity-weighted regional average MLF for each NEM region.

    Lightweight endpoint consumed by the BESS Calculator's default-fill logic
    to suggest a sensible starting MLF based on the chosen region.
    """
    con = get_conn()
    averages = _region_averages(con, financial_year)

    # Fallback industry estimates if DB is empty (e.g. first boot before seed).
    _fallback = {
        "NSW1": 0.985,
        "QLD1": 0.980,
        "VIC1": 0.975,
        "SA1":  0.965,
        "TAS1": 0.955,
    }
    for region, val in _fallback.items():
        averages.setdefault(region, val)

    return {
        "financial_year": financial_year,
        "source":         "AEMO Loss Factor Report 2025-26",
        "averages":       averages,
    }
