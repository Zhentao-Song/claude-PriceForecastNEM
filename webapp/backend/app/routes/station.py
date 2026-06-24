"""Station X-Ray — per-DUID drill-down endpoints.

Powers the Stations view: search any registered DUID, see its live output,
output/price history, today's energy + revenue estimate, and its actual
AEMO bid bands (BIDDAYOFFER prices × BIDPEROFFER availabilities).

Revenue estimate = Σ (MW × 5/60 h × RRP × MLF) over GENERATING intervals,
charging cost for storage = Σ over negative-MW intervals. This is the
standard back-of-envelope spot-revenue model (no FCAS, no contracts).
"""
from __future__ import annotations

from datetime import datetime, timedelta

from fastapi import APIRouter, HTTPException, Query

from ..db import locked_conn
from ..registry import merged_generators

router = APIRouter(prefix="/api/station", tags=["station"])


def _nem_now() -> datetime:
    return datetime.utcnow() + timedelta(hours=10)


def _iso(v) -> str | None:
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.isoformat()
    return str(v)


def _meta_for(duid: str) -> dict | None:
    for g in merged_generators():
        if g["duid"] == duid:
            return g
    return None


@router.get("/list")
def station_list(
    region: str | None = Query(None, description="Filter by NEM region"),
    fuel: str | None = Query(None, description="Filter by fuel"),
) -> dict:
    """All known DUIDs (curated ∪ AEMO registry) for the station picker."""
    out = []
    for g in merged_generators():
        if region and g["region"] != region.upper():
            continue
        if fuel and g["fuel"] != fuel:
            continue
        out.append({
            "duid": g["duid"],
            "station": g["station"],
            "region": g["region"],
            "fuel": g["fuel"],
            "capacity_mw": g["capacity_mw"],
            "dispatch_type": g["dispatch_type"],
            "on_map": g["lat"] is not None,
        })
    out.sort(key=lambda x: (-(x["capacity_mw"] or 0), x["duid"]))
    return {"stations": out, "count": len(out)}


@router.get("/{duid}/summary")
def station_summary(duid: str) -> dict:
    duid = duid.upper()
    meta = _meta_for(duid)
    if meta is None:
        raise HTTPException(404, f"unknown DUID {duid}")

    nem_now = _nem_now()
    day_start = nem_now.strftime("%Y-%m-%d 00:00:00")

    with locked_conn() as con:
        latest = con.execute(
            "SELECT settlementdate, mw FROM nem_unit_dispatch "
            "WHERE duid = ? ORDER BY settlementdate DESC LIMIT 1",
            (duid,),
        ).fetchone()

        # Today's per-interval MW × price for the energy/revenue estimate.
        rows = con.execute(
            """
            SELECT u.mw, p.rrp
            FROM nem_unit_dispatch u
            JOIN nem_dispatch_price p
              ON p.settlementdate = u.settlementdate AND p.regionid = ?
            WHERE u.duid = ? AND u.settlementdate >= ?
            """,
            (meta["region"], duid, day_start),
        ).fetchall()

        mlf_row = con.execute(
            "SELECT mlf, financial_year FROM nem_mlf WHERE duid = ? "
            "ORDER BY financial_year DESC LIMIT 1",
            (duid,),
        ).fetchone()
        reg = con.execute(
            "SELECT schedule_type, co2e_source, emissions_factor, tlf "
            "FROM nem_facility_registry WHERE duid = ?",
            (duid,),
        ).fetchone()

    mlf = (mlf_row[0] if mlf_row else None) or (reg[3] if reg else None) or 1.0
    gen_mwh = sum(max(r[0], 0.0) * 5 / 60 for r in rows if r[0] is not None)
    load_mwh = sum(-min(r[0], 0.0) * 5 / 60 for r in rows if r[0] is not None)
    revenue = sum(max(r[0], 0.0) * 5 / 60 * (r[1] or 0.0) * mlf
                  for r in rows if r[0] is not None)
    charge_cost = sum(-min(r[0], 0.0) * 5 / 60 * (r[1] or 0.0) / mlf
                      for r in rows if r[0] is not None)

    return {
        "duid": duid,
        "station": meta["station"],
        "region": meta["region"],
        "fuel": meta["fuel"],
        "capacity_mw": meta["capacity_mw"],
        "dispatch_type": meta["dispatch_type"],
        "schedule_type": reg[0] if reg else None,
        "co2e_source": reg[1] if reg else None,
        "emissions_factor": reg[2] if reg else None,
        "mlf": mlf,
        "mlf_fy": mlf_row[1] if mlf_row else None,
        "latest_mw": latest[1] if latest else None,
        "latest_interval": _iso(latest[0]) if latest else None,
        "today": {
            "generated_mwh": round(gen_mwh, 1),
            "consumed_mwh": round(load_mwh, 1),
            "spot_revenue_aud": round(revenue, 0),
            "charge_cost_aud": round(charge_cost, 0),
            "net_aud": round(revenue - charge_cost, 0),
            "intervals": len(rows),
        },
    }


@router.get("/{duid}/history")
def station_history(
    duid: str,
    hours: int = Query(24, ge=1, le=168),
) -> dict:
    """5-min MW + regional RRP series for the output/price chart."""
    duid = duid.upper()
    meta = _meta_for(duid)
    if meta is None:
        raise HTTPException(404, f"unknown DUID {duid}")

    cutoff = (_nem_now() - timedelta(hours=hours)).strftime("%Y-%m-%d %H:%M:%S")
    with locked_conn() as con:
        rows = con.execute(
            """
            SELECT u.settlementdate, u.mw, p.rrp
            FROM nem_unit_dispatch u
            LEFT JOIN nem_dispatch_price p
                   ON p.settlementdate = u.settlementdate AND p.regionid = ?
            WHERE u.duid = ? AND u.settlementdate >= ?
            ORDER BY u.settlementdate
            """,
            (meta["region"], duid, cutoff),
        ).fetchall()

    return {
        "duid": duid,
        "region": meta["region"],
        "capacity_mw": meta["capacity_mw"],
        "hours": hours,
        "series": [
            {"t": _iso(r[0]), "mw": r[1], "rrp": r[2]} for r in rows
        ],
    }


@router.get("/{duid}/bids")
def station_bids(
    duid: str,
    date: str | None = Query(None, description="Trading date YYYY-MM-DD; default today"),
    bidtype: str = Query("ENERGY"),
    direction: str = Query("GEN", description="GEN = sell/discharge offers, "
                                              "LOAD = buy/charge bids (storage only)"),
) -> dict:
    """Actual AEMO bid bands: BIDDAYOFFER prices + per-interval BIDPEROFFER
    availabilities. The classic 'bid ladder' view.

    GEN and LOAD are separate ladders for bidirectional (storage) units —
    a battery simultaneously offers to sell at high prices and bids to buy
    at low prices. Plain generators only ever have meaningful GEN rows.
    Legacy bidper rows ingested before the direction column existed carry
    NULL and match either filter (they age out of the 14-day window).

    `date` is the NEM TRADING day: intervals D 04:05 → D+1 04:00 (288 ×
    5 min). AEMO discloses bid volumes D+1 (~04:00), so the default is the
    latest trading day with data — usually yesterday's complete day."""
    duid = duid.upper()
    direction = direction.upper()
    nem_now = _nem_now()
    day = date or nem_now.strftime("%Y-%m-%d")

    with locked_conn() as con:
        # Default to the most recent trading day that actually has rows —
        # AEMO's bid disclosure is D+1, so "today" is never available.
        # trading_day(interval) = date(interval − 4h − 1s): 04:05 belongs
        # to its own date, 04:00 to the previous trading day.
        if date is None:
            latest_day = con.execute(
                "SELECT MAX(date(interval_datetime, '-4 hours', '-1 second')) "
                "FROM nem_bidper_offer WHERE duid = ? AND bidtype = ?",
                (duid, bidtype.upper()),
            ).fetchone()
            if latest_day and latest_day[0]:
                day = min(day, latest_day[0])

        # Trading-day window: D 04:00 < interval ≤ D+1 04:00.
        win_start = f"{day} 04:00:00"
        win_end_dt = datetime.strptime(day, "%Y-%m-%d") + timedelta(days=1, hours=4)
        win_end = win_end_dt.strftime("%Y-%m-%d %H:%M:%S")

        day_row = con.execute(
            """
            SELECT priceband1, priceband2, priceband3, priceband4, priceband5,
                   priceband6, priceband7, priceband8, priceband9, priceband10,
                   direction, submitted_at
            FROM nem_bidday_offer
            WHERE duid = ? AND bidtype = ? AND date(settlementdate) <= ?
              AND (direction = ? OR direction IS NULL)
            ORDER BY settlementdate DESC, submitted_at DESC LIMIT 1
            """,
            (duid, bidtype.upper(), day, direction),
        ).fetchone()

        per_rows = con.execute(
            """
            SELECT interval_datetime,
                   bandavail1, bandavail2, bandavail3, bandavail4, bandavail5,
                   bandavail6, bandavail7, bandavail8, bandavail9, bandavail10,
                   maxavail
            FROM nem_bidper_offer
            WHERE duid = ? AND bidtype = ?
              AND interval_datetime > ? AND interval_datetime <= ?
              AND (direction = ? OR direction IS NULL)
            ORDER BY interval_datetime, version
            """,
            (duid, bidtype.upper(), win_start, win_end, direction),
        ).fetchall()

    if day_row is None and not per_rows:
        return {"duid": duid, "date": day, "bidtype": bidtype.upper(),
                "prices": None, "intervals": []}

    # Later versions overwrite earlier ones per interval (rebids).
    by_interval: dict[str, tuple] = {}
    for r in per_rows:
        by_interval[_iso(r[0])] = r

    intervals = [
        {
            "t": t,
            "avail": [r[i] for i in range(1, 11)],
            "maxavail": r[11],
        }
        for t, r in sorted(by_interval.items())
    ]

    return {
        "duid": duid,
        "date": day,
        "bidtype": bidtype.upper(),
        "direction": direction,
        "submitted_at": _iso(day_row[11]) if day_row else None,
        "prices": [day_row[i] for i in range(10)] if day_row else None,
        "intervals": intervals,
    }
