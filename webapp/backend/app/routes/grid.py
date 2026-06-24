"""Grid topology endpoints — interconnector flows + (later) generators."""
from __future__ import annotations

from datetime import datetime, timedelta

from fastapi import APIRouter, Query

from ..cache import ttl_cache
from ..db import locked_conn
from ..registry import generation_fuel_capacity, generation_fuel_map
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
        # Count only curated (map-visible) DUIDs — SCADA now ingests all
        # ~510 NEM units, but this stat backs the map header.
        "duid_count_with_data": sum(1 for d in GENERATORS_BY_DUID if d in latest_by_duid),
        "generated_at": datetime.utcnow().isoformat(),
    }


@router.get("/bess/leaderboard")
@ttl_cache(120)
def bess_leaderboard(
    region: str | None = Query(None, description="NEM region; omit for whole NEM"),
    hours: int = Query(24, ge=1, le=168),
) -> dict:
    """Battery revenue league table — Modo-style daily ranking.

    For every battery DUID (registry fuel='battery', generation side):
      revenue     Σ MW>0 × 5/60 h × RRP × MLF     (discharge earnings)
      charge_cost Σ |MW<0| × 5/60 h × RRP / MLF   (charging spend)
      net         revenue − charge_cost
      spread      realised $/MWh discharge minus $/MWh charge — the
                  arbitrage quality metric traders actually compare.

    Energy-only (no FCAS): honest lower bound on actual earnings.
    """
    from ..registry import merged_generators

    bats = [g for g in merged_generators()
            if g["fuel"] == "battery" and g["dispatch_type"] != "LOAD"
            and (region is None or g["region"] == region.upper())]
    if not bats:
        return {"hours": hours, "entries": []}

    by_duid = {g["duid"]: g for g in bats}
    duids = list(by_duid.keys())
    cutoff = (datetime.utcnow() + timedelta(hours=10) - timedelta(hours=hours)
              ).strftime("%Y-%m-%d %H:%M:%S")
    placeholders = ",".join(["?"] * len(duids))

    regions_needed = sorted({g["region"] for g in bats})
    region_ph = ",".join(["?"] * len(regions_needed))

    with locked_conn() as con:
        unit_rows = con.execute(
            f"""
            SELECT settlementdate, duid, mw FROM nem_unit_dispatch
            WHERE duid IN ({placeholders}) AND settlementdate >= ?
            """,
            (*duids, cutoff),
        ).fetchall()
        price_rows = con.execute(
            f"""
            SELECT settlementdate, regionid, rrp FROM nem_dispatch_price
            WHERE regionid IN ({region_ph}) AND settlementdate >= ?
            """,
            (*regions_needed, cutoff),
        ).fetchall()
        mlf_rows = con.execute(
            f"SELECT duid, mlf FROM nem_mlf WHERE duid IN ({placeholders}) "
            "GROUP BY duid HAVING financial_year = MAX(financial_year)",
            duids,
        ).fetchall()

    price_at: dict[tuple[str, str], float] = {
        (_iso(r[0]) or "", r[1]): r[2] for r in price_rows if r[2] is not None
    }
    mlf_by_duid = {r[0]: r[1] for r in mlf_rows}
    acc: dict[str, dict] = {}
    for ts, duid, mw in unit_rows:
        if mw is None:
            continue
        rrp = price_at.get((_iso(ts) or "", by_duid[duid]["region"]))
        if rrp is None:
            continue
        a = acc.setdefault(duid, {"dis_mwh": 0.0, "chg_mwh": 0.0,
                                  "rev": 0.0, "cost": 0.0})
        mlf = mlf_by_duid.get(duid, 1.0) or 1.0
        e = mw * 5 / 60
        if mw > 0:
            a["dis_mwh"] += e
            a["rev"] += e * rrp * mlf
        elif mw < 0:
            a["chg_mwh"] += -e
            a["cost"] += -e * rrp / mlf

    entries = []
    for duid, a in acc.items():
        g = by_duid[duid]
        if a["dis_mwh"] < 0.5 and a["chg_mwh"] < 0.5:
            continue  # slept through the window — not leaderboard material
        avg_dis = a["rev"] / a["dis_mwh"] if a["dis_mwh"] > 0 else None
        avg_chg = a["cost"] / a["chg_mwh"] if a["chg_mwh"] > 0 else None
        entries.append({
            "duid": duid,
            "station": g["station"],
            "region": g["region"],
            "capacity_mw": g["capacity_mw"],
            "discharged_mwh": round(a["dis_mwh"], 1),
            "charged_mwh": round(a["chg_mwh"], 1),
            "revenue_aud": round(a["rev"], 0),
            "charge_cost_aud": round(a["cost"], 0),
            "net_aud": round(a["rev"] - a["cost"], 0),
            "avg_discharge_price": round(avg_dis, 2) if avg_dis is not None else None,
            "avg_charge_price": round(avg_chg, 2) if avg_chg is not None else None,
            "spread": round(avg_dis - avg_chg, 2)
                      if avg_dis is not None and avg_chg is not None else None,
        })

    entries.sort(key=lambda e: -e["net_aud"])
    return {"hours": hours, "region": region, "entries": entries,
            "generated_at": datetime.utcnow().isoformat()}


@router.get("/generators/history")
@ttl_cache(30)
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
    # Merged curated + AEMO registry mapping: every GENERATOR-side DUID in
    # the region with a known fuel. LOAD units (pumps, battery charging)
    # are excluded so the chart shows production, not consumption.
    duid_to_fuel = generation_fuel_map(region)
    region_duids = list(duid_to_fuel.keys())

    # Installed (nameplate) capacity per fuel type — used by the frontend to
    # compute per-fuel utilisation: current_mw / capacity_mw × 100.
    fuel_capacity_mw = generation_fuel_capacity(region)

    if not region_duids:
        return {"region": region, "hours": hours, "bucket_minutes": bucket_minutes,
                "series": [], "fuels": [], "fuel_capacity_mw": {}}

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

    # ── Rooftop PV — join behind-the-meter satellite actuals ──────────────
    # Rooftop PV is published at 30-min resolution; we interpolate into
    # the 5-min SCADA grid by repeating the 30-min value for each of the
    # 6 dispatch intervals within that half-hour (nearest-neighbour fill).
    # This keeps the chart consistent with the SCADA bars (no sudden
    # gaps in the rooftop_solar series between 30-min data points).
    if region in ("NSW1", "QLD1", "VIC1", "SA1", "TAS1"):
        with locked_conn() as con:
            pv_rows = con.execute(
                """
                SELECT settlementdate, power_mw
                FROM nem_rooftop_pv
                WHERE regionid = ?
                  AND settlementdate >= ?
                ORDER BY settlementdate
                """,
                (region, cutoff),
            ).fetchall()

        # Build a lookup: window-START → MW so we can fill every 5-min slot.
        #
        # AEMO convention: INTERVAL_DATETIME is the END of the 30-min window.
        # e.g. INTERVAL_DATETIME=18:30 covers the period 18:00–18:30.
        # SCADA 5-min intervals within that window (18:05, 18:10 … 18:25) all
        # floor to 18:00 when we do (minute // 30)*30, so we must store the PV
        # value at the window *start* (INTERVAL_DATETIME − 30 min), not the end.
        pv_by_halfhour: dict[str, float] = {}
        for pv_ts, pv_mw in pv_rows:
            if pv_mw is None or pv_mw < 0:
                continue
            pv_ts_iso = _iso(pv_ts)
            if not pv_ts_iso:
                continue
            try:
                dt = datetime.fromisoformat(pv_ts_iso.replace(" ", "T")[:19])
                # Convert END → START of the 30-min window.
                window_start = (dt - timedelta(minutes=30)).replace(second=0,
                                                                     microsecond=0)
                pv_by_halfhour[window_start.isoformat()] = float(pv_mw)
            except Exception:
                pass

        # Stamp each 5-min interval with the containing 30-min rooftop value.
        # SCADA ts_iso floors to the start of its 30-min window — same key as above.
        all_ts = sorted({k[0] for k in by_key.keys()})
        for ts_iso in all_ts:
            try:
                dt = datetime.fromisoformat(ts_iso.replace(" ", "T")[:19])
                hh = dt.replace(minute=(dt.minute // 30) * 30,
                                 second=0, microsecond=0).isoformat()
                mw_val = pv_by_halfhour.get(hh)
                if mw_val is not None:
                    key = (ts_iso, "rooftop_solar")
                    by_key[key] = mw_val
            except Exception:
                pass

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
        # Nameplate capacity per fuel (MW). rooftop_solar is behind-the-meter
        # and has no registered DUID, so it is absent from this dict.
        "fuel_capacity_mw": fuel_capacity_mw,
        "series": series,
    }
