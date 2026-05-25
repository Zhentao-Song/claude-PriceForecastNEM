"""Grid topology endpoints — interconnector flows + (later) generators."""
from __future__ import annotations

from datetime import datetime, timedelta

from fastapi import APIRouter, Query

from ..db import locked_conn
from ..static.generators import FUEL_COLORS, GENERATORS, GENERATORS_BY_DUID
from ..static.interconnectors import INTERCONNECTORS, REGION_CENTROIDS

router = APIRouter(prefix="/api/grid", tags=["grid"])


def _iso(v) -> str | None:
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.isoformat()
    return str(v)


@router.get("/interconnectors/snapshot")
def interconnectors_snapshot() -> dict:
    """Latest dispatch interval per interconnector, joined with static
    geometry. Returns one entry per known IC; missing data → nulls."""
    with locked_conn() as con:
        rows = con.execute(
            """
            SELECT f.interconnectorid, f.settlementdate,
                   f.metered_mw_flow, f.mw_flow,
                   f.export_limit, f.import_limit, f.mnsp
            FROM nem_interconnector_flow f
            JOIN (
                SELECT interconnectorid, MAX(settlementdate) AS mx
                FROM nem_interconnector_flow
                GROUP BY interconnectorid
            ) m ON m.interconnectorid = f.interconnectorid
              AND m.mx = f.settlementdate
            """
        ).fetchall()

    by_id = {r[0]: r for r in rows}
    out = []
    for ic_id, meta in INTERCONNECTORS.items():
        row = by_id.get(ic_id)
        # Prefer cleared MWFLOW; fall back to metered.
        flow = None
        ts = None
        export_lim = None
        import_lim = None
        if row:
            ts = _iso(row[1])
            flow = row[3] if row[3] is not None else row[2]
            export_lim = row[4]
            import_lim = row[5]

        # Utilisation: how close to the binding limit in the *active*
        # direction. MMS sign convention: EXPORTLIMIT >= 0 (nominal dir),
        # IMPORTLIMIT <= 0 (against nominal). So we always abs() both.
        util = None
        if flow is not None:
            if flow >= 0 and export_lim:
                util = abs(flow) / abs(export_lim) if export_lim != 0 else None
            elif flow < 0 and import_lim:
                util = abs(flow) / abs(import_lim) if import_lim != 0 else None

        out.append({
            "id": ic_id,
            "name": meta["name"],
            "long_name": meta["long_name"],
            "region_from": meta["region_from"],
            "region_to": meta["region_to"],
            "from": meta["from"],
            "to": meta["to"],
            "nominal_limit_mw": meta["nominal_limit_mw"],
            "mnsp": meta["mnsp"],
            "settlementdate": ts,
            "flow_mw": flow,
            "export_limit_mw": export_lim,
            "import_limit_mw": import_lim,
            "utilisation": util,        # 0.0 - 1.0 (or > 1 if over limit, rare)
        })
    return {
        "interconnectors": out,
        "region_centroids": REGION_CENTROIDS,
        "generated_at": datetime.utcnow().isoformat(),
    }


@router.get("/generators/snapshot")
def generators_snapshot() -> dict:
    """Latest MW per known DUID, aggregated to station level for the map.

    A station's coordinates and fuel type come from the curated metadata;
    its current MW is the sum of all its units' latest SCADA values.
    """
    with locked_conn() as con:
        rows = con.execute(
            """
            SELECT u.duid, u.settlementdate, u.mw
            FROM nem_unit_dispatch u
            JOIN (
                SELECT duid, MAX(settlementdate) AS mx
                FROM nem_unit_dispatch
                GROUP BY duid
            ) m ON m.duid = u.duid AND m.mx = u.settlementdate
            """
        ).fetchall()

    latest_by_duid: dict[str, tuple[datetime | str | None, float | None]] = {}
    for r in rows:
        latest_by_duid[r[0]] = (r[1], r[2])

    # Aggregate by station (same name + region + lat/lon).
    stations: dict[tuple[str, str, float, float], dict] = {}
    for g in GENERATORS:
        key = (g["station"], g["region"], g["lat"], g["lon"])
        s = stations.setdefault(key, {
            "station": g["station"],
            "region": g["region"],
            "fuel": g["fuel"],
            "lat": g["lat"],
            "lon": g["lon"],
            "capacity_mw": 0.0,
            "mw": 0.0,
            "units": [],
            "settlementdate": None,
            "online_units": 0,
        })
        s["capacity_mw"] += g["capacity_mw"]
        ts_mw = latest_by_duid.get(g["duid"])
        if ts_mw:
            ts, mw = ts_mw
            if mw is not None:
                s["mw"] += mw
                s["online_units"] += 1
                # Carry the latest interval timestamp seen.
                ts_iso = _iso(ts)
                if ts_iso and (s["settlementdate"] is None or ts_iso > s["settlementdate"]):
                    s["settlementdate"] = ts_iso
        s["units"].append({
            "duid": g["duid"],
            "capacity_mw": g["capacity_mw"],
            "mw": ts_mw[1] if ts_mw else None,
        })

    # Fuel summary per region for the legend / regional summary card.
    by_region: dict[str, dict[str, float]] = {}
    for s in stations.values():
        d = by_region.setdefault(s["region"], {})
        d[s["fuel"]] = d.get(s["fuel"], 0.0) + (s["mw"] or 0.0)

    return {
        "stations": list(stations.values()),
        "fuel_colors": FUEL_COLORS,
        "by_region_fuel_mw": by_region,
        "duid_count_total": len(GENERATORS_BY_DUID),
        "duid_count_with_data": len(latest_by_duid),
        "generated_at": datetime.utcnow().isoformat(),
    }


@router.get("/generators/history")
def generators_history(
    region: str = Query("NSW1",
                        description="NEM region; default NSW1 to power the deep-dive view."),
    hours: int = Query(6, ge=1, le=48,
                       description="Lookback window in NEM-time hours."),
    bucket_minutes: int = Query(5, ge=5, le=60,
                                description="Aggregation granularity. 5 = native dispatch resolution."),
) -> dict:
    """Time-series of generation by FUEL type for one region.

    Joins `nem_unit_dispatch` (per-DUID SCADA) with the static DUID→fuel
    table, sums MW per (interval, fuel), and returns a dense time grid so
    the frontend can render a stacked area without gap-filling. Fuels with
    zero production over the entire window are dropped from the output.

    Powers the "live fuel mix" component below the NSW map — the user
    wanted a 此消彼长 (ebb-and-flow) visualisation showing renewables
    rising while coal falls, etc.
    """
    # Pre-filter DUIDs to the requested region so the join is cheap.
    region_duids = [g["duid"] for g in GENERATORS if g["region"] == region]
    duid_to_fuel = {g["duid"]: g["fuel"]
                    for g in GENERATORS if g["region"] == region}
    if not region_duids:
        return {"region": region, "hours": hours, "bucket_minutes": bucket_minutes,
                "series": [], "fuels": []}

    # NEM time = UTC+10. The DB stores wall-clock NEM time.
    nem_now = datetime.utcnow() + timedelta(hours=10)
    cutoff = (nem_now - timedelta(hours=hours)).strftime("%Y-%m-%d %H:%M:%S")
    placeholders = ",".join(["?"] * len(region_duids))

    with locked_conn() as con:
        rows = con.execute(
            f"""
            SELECT settlementdate, duid, mw
            FROM nem_unit_dispatch
            WHERE settlementdate >= ?
              AND duid IN ({placeholders})
            ORDER BY settlementdate
            """,
            (cutoff, *region_duids),
        ).fetchall()

    # Aggregate (interval, fuel) → MW. Bucket only if requested != 5 min,
    # since dispatch is already at 5-min resolution — for bigger buckets
    # we floor to the bucket start.
    by_key: dict[tuple[str, str], float] = {}
    for ts, duid, mw in rows:
        if mw is None: continue
        fuel = duid_to_fuel.get(duid)
        if not fuel: continue
        ts_iso = _iso(ts)
        if not ts_iso: continue
        # ts_iso has form "YYYY-MM-DD HH:MM:SS"; bucket the minute field.
        if bucket_minutes != 5:
            try:
                dt = datetime.fromisoformat(ts_iso.replace(" ", "T")[:19])
                floored_min = (dt.minute // bucket_minutes) * bucket_minutes
                dt = dt.replace(minute=floored_min, second=0, microsecond=0)
                ts_iso = dt.isoformat()
            except Exception:
                pass
        key = (ts_iso, fuel)
        by_key[key] = by_key.get(key, 0.0) + float(mw)

    # Pivot into [{t, fuel1_mw, fuel2_mw, ...}, ...] sorted by time.
    times = sorted({k[0] for k in by_key.keys()})
    fuels_present = sorted({k[1] for k in by_key.keys()})
    series = []
    for t in times:
        row: dict = {"t": t}
        for f in fuels_present:
            row[f] = round(by_key.get((t, f), 0.0), 2)
        series.append(row)

    return {
        "region": region,
        "hours": hours,
        "bucket_minutes": bucket_minutes,
        "fuels": fuels_present,
        "fuel_colors": {f: FUEL_COLORS.get(f, "#86868b") for f in fuels_present},
        "series": series,
    }
