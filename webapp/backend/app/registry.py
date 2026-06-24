"""Merged generator metadata: curated list ∪ AEMO facility registry.

The curated static/generators.py list carries hand-checked lat/lon and
display names for the map. The nem_facility_registry table (weekly scrape
of MMSDM PARTICIPANT_REGISTRATION) covers *every* registered DUID with
authoritative region / fuel / capacity / dispatch type.

Merge rules
  * curated entry exists → it wins (map needs its coords; fuel hand-checked)
  * registry-only DUID   → included with lat/lon = None (no map dot, but
    counted in the fuel mix, station explorer and BESS leaderboard)
  * dispatch_type LOAD   → excluded from generation fuel-mix helpers
    (pumps and battery-charging units consume, not produce)

Cached for 10 minutes — registration data changes weekly at most.
"""
from __future__ import annotations

import time
from typing import Any

from .db import locked_conn
from .static.generators import GENERATORS

_CACHE_TTL = 600.0
_cache: dict[str, Any] = {"ts": 0.0, "merged": None}


def _load_registry_rows() -> list[dict]:
    with locked_conn() as con:
        rows = con.execute(
            """
            SELECT duid, station, region, fuel, capacity_mw,
                   dispatch_type, schedule_type, tlf
            FROM nem_facility_registry
            """
        ).fetchall()
    return [
        {
            "duid": r[0], "station": r[1], "region": r[2], "fuel": r[3],
            "capacity_mw": r[4], "dispatch_type": r[5],
            "schedule_type": r[6], "tlf": r[7],
        }
        for r in rows
    ]


def merged_generators(refresh: bool = False) -> list[dict]:
    """Curated entries (with coords) + registry-only entries (no coords).

    Every entry has: duid, station, region, fuel (may be None for
    registry-only loads/unmapped), capacity_mw, lat, lon, dispatch_type.
    """
    now = time.time()
    if not refresh and _cache["merged"] is not None and now - _cache["ts"] < _CACHE_TTL:
        return _cache["merged"]

    curated_by_duid = {g["duid"]: g for g in GENERATORS}
    merged: list[dict] = []

    for g in GENERATORS:
        merged.append({
            "duid": g["duid"], "station": g["station"], "region": g["region"],
            "fuel": g["fuel"], "capacity_mw": g["capacity_mw"],
            "lat": g["lat"], "lon": g["lon"],
            "dispatch_type": "GENERATOR",
        })

    try:
        for r in _load_registry_rows():
            if r["duid"] in curated_by_duid:
                continue
            merged.append({
                "duid": r["duid"], "station": r["station"] or r["duid"],
                "region": r["region"], "fuel": r["fuel"],
                "capacity_mw": r["capacity_mw"] or 0.0,
                "lat": None, "lon": None,
                "dispatch_type": (r["dispatch_type"] or "GENERATOR").upper(),
            })
    except Exception:
        # Registry table empty/missing (first boot) — curated list still works.
        pass

    _cache["merged"] = merged
    _cache["ts"] = now
    return merged


def generation_fuel_map(region: str) -> dict[str, str]:
    """DUID → fuel for one region, GENERATOR-side units with known fuel only.
    This is what the fuel-mix history endpoint joins SCADA against."""
    return {
        g["duid"]: g["fuel"]
        for g in merged_generators()
        if g["region"] == region and g["fuel"]
        and g["dispatch_type"] != "LOAD"
    }


def generation_fuel_capacity(region: str) -> dict[str, float]:
    """Installed nameplate MW per fuel for one region (GENERATOR side)."""
    out: dict[str, float] = {}
    for g in merged_generators():
        if g["region"] == region and g["fuel"] and g["dispatch_type"] != "LOAD":
            out[g["fuel"]] = out.get(g["fuel"], 0.0) + (g["capacity_mw"] or 0.0)
    return out
