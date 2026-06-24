"""ST PASA API routes.

GET /api/pasa/st?region=NSW1&days=14
  Returns per-region 14-day demand forecasts (P10/P50/P90), available
  generation and reserve conditions from the latest STPASA run.
"""
from __future__ import annotations

from datetime import datetime, timedelta

from fastapi import APIRouter, Query

from ..config import NEM_REGIONS
from ..db import locked_conn

router = APIRouter(prefix="/api/pasa", tags=["pasa"])


@router.get("/st")
def st_pasa(
    region: str = Query("NSW1", description="NEM region ID"),
    days: int = Query(14, ge=1, le=14, description="Forecast horizon (days)"),
) -> dict:
    """Return the latest-run ST PASA forecast for a region."""
    region = region.upper()
    cutoff = (datetime.utcnow() + timedelta(hours=10)).strftime("%Y-%m-%d %H:%M:%S")
    horizon = (datetime.utcnow() + timedelta(hours=10, days=days)).strftime("%Y-%m-%d %H:%M:%S")

    with locked_conn() as con:
        # Latest run_datetime available in the table
        latest_run_row = con.execute(
            "SELECT MAX(run_datetime) FROM nem_st_pasa WHERE regionid = ?",
            (region,),
        ).fetchone()
        latest_run = latest_run_row[0] if latest_run_row else None

        # If we have a latest run, filter to that run only (avoid mixing runs)
        if latest_run:
            rows = con.execute(
                """
                SELECT interval_datetime, demand10, demand50, demand90,
                       available_generation, lrc, reservecondition, run_datetime
                FROM nem_st_pasa
                WHERE regionid = ?
                  AND run_datetime = ?
                  AND interval_datetime >= ?
                  AND interval_datetime <= ?
                ORDER BY interval_datetime
                """,
                (region, latest_run, cutoff, horizon),
            ).fetchall()
        else:
            rows = []

        # All available regions (for the region selector)
        available_regions = [
            r[0] for r in con.execute(
                "SELECT DISTINCT regionid FROM nem_st_pasa ORDER BY regionid"
            ).fetchall()
        ]

    series = [
        {
            "interval_datetime": r[0],
            "demand10": r[1],
            "demand50": r[2],
            "demand90": r[3],
            "available_generation": r[4],
            "lrc": r[5],
            "reservecondition": r[6],
            "run_datetime": r[7],
        }
        for r in rows
    ]

    # Summarise reserve conditions
    lor_counts = {0: 0, 1: 0, 2: 0, 3: 0}
    for pt in series:
        rc = pt["reservecondition"]
        if rc is not None and rc in lor_counts:
            lor_counts[rc] += 1

    return {
        "region": region,
        "days": days,
        "latest_run": latest_run,
        "series": series,
        "count": len(series),
        "lor_counts": lor_counts,
        "available_regions": available_regions or NEM_REGIONS,
    }


@router.get("/st/summary")
def st_pasa_summary() -> dict:
    """Return the worst reserve condition for each region across the next 7 days.

    Used by the NEM overview to show a compact LOR badge per region without
    fetching the full 14-day time series.
    """
    horizon = (datetime.utcnow() + timedelta(hours=10, days=7)).strftime("%Y-%m-%d %H:%M:%S")
    now_nem = (datetime.utcnow() + timedelta(hours=10)).strftime("%Y-%m-%d %H:%M:%S")

    with locked_conn() as con:
        rows = con.execute(
            """
            SELECT p.regionid,
                   MAX(p.reservecondition) AS worst_lor,
                   COUNT(*) FILTER (WHERE p.reservecondition >= 1) AS lor_intervals,
                   MAX(p.run_datetime) AS latest_run
            FROM nem_st_pasa p
            JOIN (
                SELECT regionid, MAX(run_datetime) AS mx
                FROM nem_st_pasa
                GROUP BY regionid
            ) r ON r.regionid = p.regionid AND r.mx = p.run_datetime
            WHERE p.interval_datetime >= ? AND p.interval_datetime <= ?
            GROUP BY p.regionid
            """,
            (now_nem, horizon),
        ).fetchall()

    regions = {}
    for r in rows:
        regions[r[0]] = {
            "regionid": r[0],
            "worst_lor": r[1],
            "lor_intervals": r[2],
            "latest_run": r[3],
        }

    return {"regions": regions, "horizon_days": 7}
