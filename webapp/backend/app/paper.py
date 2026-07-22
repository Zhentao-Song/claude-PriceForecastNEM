"""Paper-trading engine for the NSW BESS demo.

We model AEMO bidding as a price-taker: a bid is a list of (price, MW) bands
targeting one dispatch interval. When the real RRP for that interval arrives
in `nem_dispatch_price`, we compare each band against the cleared price and
dispatch matching MW. Energy fills move SoC and produce revenue at RRP × MWh;
FCAS fills are capacity payments at FCAS_RRP × MW × (5/60), no SoC impact.

Key simplifications vs the real NEMDE:
  * Price-taker: a 100 MW bid never moves the clearing price.
  * Co-optimisation is enforced at submit time by summing pending MW for the
    same DUID + interval and rejecting if the total breaches power_mw.
  * Round-trip efficiency is split evenly: sqrt(rte) is applied on both the
    charge and discharge SoC accounting, so a full round-trip yields rte%.
  * FCAS reservations don't physically deplete SoC in this model (we ignore
    contingency activation events). They only earn capacity payment.
"""
from __future__ import annotations

import json
import logging
import math
import sqlite3
from datetime import datetime, timedelta
from typing import Iterable

from .config import NEM_REGIONS
from .db import write_conn
from .static.generators import GENERATORS_BY_DUID

log = logging.getLogger("paper")

MPF = -1000.0
MPC = 23_200.0

# 11 markets we settle. Order matters only for display.
ENERGY = "ENERGY"
FCAS_MARKETS = [
    "RAISEREG", "RAISE5MIN", "RAISE60SEC", "RAISE6SEC", "RAISE1SEC",
    "LOWERREG", "LOWER5MIN", "LOWER60SEC", "LOWER6SEC", "LOWER1SEC",
]
RAISE_FCAS = {m for m in FCAS_MARKETS if m.startswith("RAISE")}
LOWER_FCAS = {m for m in FCAS_MARKETS if m.startswith("LOWER")}
ALL_MARKETS = [ENERGY] + FCAS_MARKETS

# Map our market keys to the column names in nem_dispatch_price.
_FCAS_COL = {
    "RAISEREG": "raisereg_rrp",  "RAISE5MIN": "raise5min_rrp",
    "RAISE60SEC": "raise60sec_rrp", "RAISE6SEC": "raise6sec_rrp",
    "RAISE1SEC": "raise1sec_rrp",
    "LOWERREG": "lowerreg_rrp",  "LOWER5MIN": "lower5min_rrp",
    "LOWER60SEC": "lower60sec_rrp", "LOWER6SEC": "lower6sec_rrp",
    "LOWER1SEC": "lower1sec_rrp",
}

INTERVAL_MIN = 5
INTERVAL_HRS = INTERVAL_MIN / 60.0  # = 0.0833... — the MWh-per-MW factor

# AEMO publishes all dispatch timestamps in "NEM time" (AEST = UTC+10, no
# DST) — see AEMO Market Operations Handbook. Our scrapers store these
# verbatim (naive). To pick the *next* interval correctly we need to do all
# math in NEM time, then store/compare naive in the same frame.
NEM_TZ_OFFSET = timedelta(hours=10)


def now_nem() -> datetime:
    """Naive datetime in NEM time (UTC+10), matching what scrapers store."""
    return datetime.utcnow() + NEM_TZ_OFFSET


# ---------- Helpers --------------------------------------------------------

def next_intervals(n: int = 6, now: datetime | None = None) -> list[datetime]:
    """The next `n` 5-minute interval boundaries in **NEM time** (AEST).

    AEMO's settlement timestamp is the *end* of the interval (e.g. 02:05
    covers 02:00–02:05). We only return intervals you can still bid into:
    AEMO closes the gate INTERVAL_MIN before the interval ends, so the
    first returned interval is the earliest one whose gate hasn't yet
    closed (with a 30 s safety buffer matching `_check_gate_closure`).
    """
    now = now or now_nem()
    base = now.replace(second=0, microsecond=0)
    minute = (base.minute // INTERVAL_MIN) * INTERVAL_MIN
    base = base.replace(minute=minute)
    # Candidate first interval: the one ending one tick from now.
    first = base + timedelta(minutes=INTERVAL_MIN)
    # Skip intervals whose gate has already closed (matches the check in
    # `_check_gate_closure`: gate = target − INTERVAL_MIN − 30 s).
    gate_buffer = timedelta(minutes=INTERVAL_MIN, seconds=30)
    while first - gate_buffer <= now:
        first += timedelta(minutes=INTERVAL_MIN)
    return [first + timedelta(minutes=INTERVAL_MIN * i) for i in range(n)]


def region_for_duid(duid: str) -> str | None:
    g = GENERATORS_BY_DUID.get(duid)
    return g["region"] if g else None


def _require_region(duid: str) -> str:
    """Resolve the NEM region for a DUID or raise.

    The legacy `region_for_duid(duid) or "NSW1"` fallback silently routed
    unknown DUIDs to NSW1 — that breaks settlement (bids cleared against
    the wrong region's RRP) and prevents the user from noticing typos.
    """
    r = region_for_duid(duid)
    if not r:
        raise ValueError(
            f"unknown DUID '{duid}': not in the modelled generator list; "
            "cannot resolve NEM region"
        )
    return r


def _check_gate_closure(target_iso: str, *, action: str = "submit") -> None:
    """Enforce AEMO's T−5 minute gate closure on a target interval.

    Real-world dispatch rebids must be lodged before AEMO closes the gate,
    which is the start of the target interval. With AEMO settlement
    timestamps being interval-end (NEM time), the gate for interval ending
    at T is roughly T − INTERVAL_MIN. We add a 30-second safety buffer to
    avoid letting bids slip in during the cut-over.
    """
    # Parse the naive NEM-time target into a datetime.
    try:
        if "T" in target_iso:
            target_dt = datetime.fromisoformat(target_iso)
        else:
            target_dt = datetime.strptime(target_iso, "%Y-%m-%d %H:%M:%S")
    except ValueError as e:
        raise ValueError(f"invalid target interval '{target_iso}': {e}")
    # Gate closes when the interval starts: target_end − 5 min.
    gate = target_dt - timedelta(minutes=INTERVAL_MIN, seconds=30)
    now = now_nem()
    if now >= gate:
        raise ValueError(
            f"gate closed for interval ending {target_iso} "
            f"(gate was {gate.strftime('%H:%M:%S')} NEM, now {now.strftime('%H:%M:%S')} NEM); "
            f"cannot {action} bid"
        )


def _bess_state(con: sqlite3.Connection, duid: str) -> dict | None:
    row = con.execute(
        """
        SELECT duid, capacity_mwh, power_mw, rte_pct, soc_mwh,
               cumulative_pnl_aud, last_settled_interval, updated_at, mlf
        FROM paper_bess_state WHERE duid = ?
        """,
        (duid,),
    ).fetchone()
    if not row:
        return None
    return {
        "duid": row[0], "capacity_mwh": row[1], "power_mw": row[2],
        "rte_pct": row[3], "soc_mwh": row[4],
        "cumulative_pnl_aud": row[5], "last_settled_interval": row[6],
        "updated_at": row[7],
        # Older DBs missing the column would read NULL; treat as 1.0 (no
        # loss adjustment) to preserve historical behavior.
        "mlf": row[8] if row[8] is not None else 1.0,
    }


def _validate_bands(bands: list[dict]) -> list[dict]:
    """Normalize and check a bid's bands. Raises ValueError on bad input.

    Enforces the AEMO ladder shape:
      * 1–10 bands (NER 3.8.6A.1)
      * price within MPF/MPC (−$1,000 to $23,200)
      * non-negative MW per band
      * **strictly ascending** prices band-by-band (AEMO monotonic rule —
        each next band must be priced higher than the previous one so the
        merit order is unambiguous).
    """
    if not bands:
        raise ValueError("bid must include at least one price band")
    if len(bands) > 10:
        raise ValueError("max 10 price bands per bid (AEMO limit)")
    cleaned = []
    for i, b in enumerate(bands):
        if "price" not in b or "mw" not in b:
            raise ValueError(f"band {i+1}: must have 'price' and 'mw'")
        try:
            price = float(b["price"])
            mw = float(b["mw"])
        except (TypeError, ValueError):
            raise ValueError(f"band {i+1}: price and mw must be numeric")
        if mw < 0:
            raise ValueError(f"band {i+1}: mw must be non-negative")
        # AEMO floor/ceiling for FY2026-27. We enforce the current bounds.
        if price < MPF or price > MPC:
            raise ValueError(f"band {i+1}: price must be in [{MPF:.0f}, {MPC:.0f}]")
        cleaned.append({"price": price, "mw": mw})
    # AEMO requires a strictly-ascending price ladder. Reject ties and
    # inversions: NEMDE stacks bands in price order, so duplicates create
    # ambiguity and inversions are not accepted.
    for i in range(1, len(cleaned)):
        prev = cleaned[i - 1]["price"]
        curr = cleaned[i]["price"]
        if curr <= prev:
            raise ValueError(
                f"band {i+1}: price ${curr:.2f} must be strictly greater "
                f"than band {i} price ${prev:.2f} (AEMO requires "
                f"monotonic ascending bands)"
            )
    return cleaned


def bid_max_mw(bands: list[dict]) -> float:
    """Worst-case dispatched MW for this bid (all bands clear)."""
    return sum(b["mw"] for b in bands)


# ---------- Submit-time co-optimisation -----------------------------------

def _sum_pending_mw(
    con: sqlite3.Connection,
    duid: str,
    interval: datetime | str,
    market_filter: Iterable[str],
) -> float:
    """Sum max-MW across all PENDING bids for a DUID + interval restricted to
    the given markets. Used to enforce power constraints at submit time."""
    placeholders = ",".join("?" * len(list(market_filter)))
    markets = list(market_filter)
    if not markets:
        return 0.0
    rows = con.execute(
        f"""
        SELECT bands_json FROM paper_bid
        WHERE duid = ? AND target_settlementdate = ?
              AND status = 'PENDING' AND market IN ({placeholders})
        """,
        (duid, interval, *markets),
    ).fetchall()
    return sum(bid_max_mw(json.loads(r[0])) for r in rows)


def _check_co_optimisation(
    con: sqlite3.Connection,
    duid: str,
    interval: datetime | str,
    market: str,
    direction: str,
    bands: list[dict],
    *,
    exclude_bid_id: int | None = None,
) -> None:
    """Reject bids that would breach the BESS power envelope.

    Simplification: we treat all RAISE FCAS reservations + energy GEN as
    competing for the same upward power; LOWER FCAS + energy LOAD compete for
    downward power. This is more conservative than NEMDE's true co-opt.

    `exclude_bid_id`: when a rebid supersedes a PENDING bid, its MW must be
    excluded from the headroom check (the old bid is about to be cancelled
    in the same transaction).
    """
    state = _bess_state(con, duid)
    if not state:
        return  # not a BESS we model; skip the check
    new_mw = bid_max_mw(bands)
    upward = {ENERGY: True if direction == "GEN" else False, **{m: True for m in RAISE_FCAS}}
    downward = {ENERGY: True if direction == "LOAD" else False, **{m: True for m in LOWER_FCAS}}

    exclude_clause = " AND bid_id != ?" if exclude_bid_id is not None else ""
    exclude_args: tuple = (exclude_bid_id,) if exclude_bid_id is not None else ()

    def _sum_filtered(markets: Iterable[str]) -> float:
        mlist = list(markets)
        if not mlist:
            return 0.0
        placeholders = ",".join("?" * len(mlist))
        rows = con.execute(
            f"""
            SELECT bands_json FROM paper_bid
            WHERE duid = ? AND target_settlementdate = ?
                  AND status = 'PENDING' AND market IN ({placeholders})
                  {exclude_clause}
            """,
            (duid, interval, *mlist, *exclude_args),
        ).fetchall()
        return sum(bid_max_mw(json.loads(r[0])) for r in rows)

    def _sum_energy(direction_filter: str) -> float:
        rows = con.execute(
            f"""
            SELECT bands_json FROM paper_bid
            WHERE duid = ? AND target_settlementdate = ?
                  AND status = 'PENDING' AND market = 'ENERGY' AND direction = ?
                  {exclude_clause}
            """,
            (duid, interval, direction_filter, *exclude_args),
        ).fetchall()
        return sum(bid_max_mw(json.loads(r[0])) for r in rows)

    if upward.get(market):
        existing = _sum_filtered(RAISE_FCAS) + _sum_energy("GEN")
        if existing + new_mw > state["power_mw"] + 1e-6:
            raise ValueError(
                f"co-opt: upward commitments would total "
                f"{existing + new_mw:.1f} MW > {state['power_mw']} MW power"
            )
    if downward.get(market):
        existing = _sum_filtered(LOWER_FCAS) + _sum_energy("LOAD")
        if existing + new_mw > state["power_mw"] + 1e-6:
            raise ValueError(
                f"co-opt: downward commitments would total "
                f"{existing + new_mw:.1f} MW > {state['power_mw']} MW power"
            )


# ---------- Public: submit / list / cancel --------------------------------

def submit_bid(
    duid: str,
    target_settlementdate: datetime | str,
    market: str,
    direction: str,
    bands: list[dict],
    notes: str | None = None,
    *,
    replaces_bid_id: int | None = None,
    fcas_trapezium: dict | None = None,
) -> dict:
    """Submit a new bid (price-taker).

    `replaces_bid_id`: when supplied, the new bid supersedes that one. The
    old bid must be PENDING and must match the same (DUID, target_interval,
    market, direction) — that mirrors AEMO BIDDAYOFFER semantics where a
    rebid for the same scope replaces the prior offer. The old bid is set
    to CANCELLED in the same transaction and the new bid's
    `previous_bid_id` is linked to it.
    """
    duid = duid.upper()
    market = market.upper()
    direction = direction.upper()
    if market not in ALL_MARKETS:
        raise ValueError(f"unknown market: {market}")
    if direction not in ("GEN", "LOAD"):
        raise ValueError("direction must be 'GEN' or 'LOAD'")
    if market in RAISE_FCAS and direction != "GEN":
        raise ValueError("RAISE FCAS bids must be direction=GEN")
    if market in LOWER_FCAS and direction != "LOAD":
        raise ValueError("LOWER FCAS bids must be direction=LOAD")
    bands = _validate_bands(bands)

    target_iso = _normalise_ts(target_settlementdate)
    # B4: fail loudly on unknown DUID rather than silently routing to NSW1.
    region = _require_region(duid)
    # B2: AEMO gate closure (T − 5 min) — refuse bids for intervals we can
    # no longer rebid into in real markets.
    _check_gate_closure(target_iso, action="submit")

    with write_conn() as con:
        # Reject targets in the past or already-settled.
        existing = con.execute(
            "SELECT 1 FROM nem_dispatch_price WHERE settlementdate = ? AND regionid = ? LIMIT 1",
            (target_iso, region),
        ).fetchone()
        if existing:
            raise ValueError(f"target interval {target_iso} has already cleared")

        # Validate the rebid scope, if any: same DUID/target/market/direction,
        # still PENDING. We hold the lock across cancel + insert so a parallel
        # settle can't sneak in and clear the old bid mid-flight.
        if replaces_bid_id is not None:
            old = con.execute(
                """
                SELECT duid, target_settlementdate, market, direction, status
                FROM paper_bid WHERE bid_id = ?
                """,
                (replaces_bid_id,),
            ).fetchone()
            if not old:
                raise ValueError(f"replaces_bid_id={replaces_bid_id} not found")
            old_duid, old_target, old_market, old_direction, old_status = old
            if old_status != "PENDING":
                raise ValueError(
                    f"replaces_bid_id={replaces_bid_id} is {old_status}, only "
                    "PENDING bids can be superseded"
                )
            if (old_duid != duid or _normalise_ts(old_target) != target_iso
                    or old_market != market or old_direction != direction):
                raise ValueError(
                    f"replaces_bid_id={replaces_bid_id} scope mismatch: "
                    f"old=({old_duid}, {old_target}, {old_market}, {old_direction}); "
                    f"new=({duid}, {target_iso}, {market}, {direction})"
                )

        # Exclude the bid being replaced from headroom so a like-for-like
        # rebid doesn't double-count.
        _check_co_optimisation(
            con, duid, target_iso, market, direction, bands,
            exclude_bid_id=replaces_bid_id,
        )

        if replaces_bid_id is not None:
            con.execute(
                "UPDATE paper_bid SET status = 'CANCELLED' "
                "WHERE bid_id = ? AND status = 'PENDING'",
                (replaces_bid_id,),
            )

        trap_json = json.dumps(fcas_trapezium) if fcas_trapezium else None
        cur = con.execute(
            """
            INSERT INTO paper_bid
                (duid, target_settlementdate, market, direction, submitted_at,
                 status, bands_json, notes, previous_bid_id, fcas_trapezium_json)
            VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)
            """,
            (
                duid, target_iso, market, direction,
                now_nem().strftime("%Y-%m-%d %H:%M:%S"),
                json.dumps(bands), notes, replaces_bid_id, trap_json,
            ),
        )
        return {
            "bid_id": cur.lastrowid,
            "status": "PENDING",
            "previous_bid_id": replaces_bid_id,
        }


def list_bids(duid: str | None = None, limit: int = 100) -> list[dict]:
    sql = """
        SELECT bid_id, duid, target_settlementdate, market, direction,
               submitted_at, status, bands_json, notes, previous_bid_id,
               fcas_trapezium_json
        FROM paper_bid
    """
    args: list = []
    if duid:
        sql += " WHERE duid = ?"
        args.append(duid.upper())
    sql += " ORDER BY bid_id DESC LIMIT ?"
    args.append(limit)
    with write_conn() as con:
        rows = con.execute(sql, args).fetchall()
    return [{
        "bid_id": r[0], "duid": r[1], "target_settlementdate": _iso(r[2]),
        "market": r[3], "direction": r[4], "submitted_at": _iso(r[5]),
        "status": r[6], "bands": json.loads(r[7]), "notes": r[8],
        "previous_bid_id": r[9],
        "fcas_trapezium": json.loads(r[10]) if r[10] else None,
    } for r in rows]


def list_fills(duid: str | None = None, limit: int = 100) -> list[dict]:
    sql = """
        SELECT fill_id, bid_id, duid, settlementdate, market,
               cleared_price, enabled_mw, energy_mwh, revenue_aud, created_at
        FROM paper_fill
    """
    args: list = []
    if duid:
        sql += " WHERE duid = ?"
        args.append(duid.upper())
    sql += " ORDER BY fill_id DESC LIMIT ?"
    args.append(limit)
    with write_conn() as con:
        rows = con.execute(sql, args).fetchall()
    return [{
        "fill_id": r[0], "bid_id": r[1], "duid": r[2],
        "settlementdate": _iso(r[3]), "market": r[4],
        "cleared_price": r[5], "enabled_mw": r[6], "energy_mwh": r[7],
        "revenue_aud": r[8], "created_at": _iso(r[9]),
    } for r in rows]


def cancel_bid(bid_id: int) -> dict:
    with write_conn() as con:
        row = con.execute(
            "SELECT target_settlementdate, status FROM paper_bid WHERE bid_id = ?",
            (bid_id,),
        ).fetchone()
        if not row:
            raise ValueError("bid not found")
        target_iso, status = row[0], row[1]
        if status != "PENDING":
            raise ValueError(f"bid {bid_id} is {status}, only PENDING bids can be cancelled")
        # B2: cancelling after gate closure is also a real-market rebid action
        # — AEMO doesn't let you pull a bid once the gate has closed.
        _check_gate_closure(_normalise_ts(target_iso), action="cancel")
        cur = con.execute(
            "UPDATE paper_bid SET status = 'CANCELLED' "
            "WHERE bid_id = ? AND status = 'PENDING'",
            (bid_id,),
        )
        if cur.rowcount == 0:
            raise ValueError("bid was settled before cancellation could complete")
    return {"bid_id": bid_id, "status": "CANCELLED"}


def get_state(duid: str) -> dict | None:
    with write_conn() as con:
        s = _bess_state(con, duid.upper())
        if not s:
            return None
        # Today's P&L from fills.
        today_iso = now_nem().strftime("%Y-%m-%d")
        row = con.execute(
            """
            SELECT
                COALESCE(SUM(CASE WHEN market = 'ENERGY' THEN revenue_aud ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN market != 'ENERGY' THEN revenue_aud ELSE 0 END), 0),
                COALESCE(SUM(revenue_aud), 0)
            FROM paper_fill
            WHERE duid = ? AND settlementdate >= ?
            """,
            (duid.upper(), today_iso),
        ).fetchone()
        s["today_energy_pnl"] = row[0]
        s["today_fcas_pnl"] = row[1]
        s["today_total_pnl"] = row[2]
    s["soc_pct"] = (s["soc_mwh"] / s["capacity_mwh"]) * 100 if s["capacity_mwh"] else 0.0
    return s


def analytics(duid: str) -> dict:
    """Aggregate paper-trading performance: daily P&L, cumulative curve, summary stats.

    Returns
    -------
    {
      "daily": [{"day", "energy_pnl", "fcas_pnl", "total_pnl", "cumulative",
                 "n_fills", "win_rate"}, ...],
      "stats": {"total_pnl", "pnl_7d", "pnl_30d", "annualized_aud",
                "n_fills", "win_rate", "first_fill", "last_fill", "trading_days"}
    }
    """
    duid_up = duid.upper()
    with write_conn() as con:
        daily_rows = con.execute(
            """
            SELECT
                DATE(settlementdate)                                              AS day,
                COALESCE(SUM(CASE WHEN market='ENERGY' THEN revenue_aud ELSE 0 END), 0) AS energy_pnl,
                COALESCE(SUM(CASE WHEN market!='ENERGY' THEN revenue_aud ELSE 0 END), 0) AS fcas_pnl,
                COALESCE(SUM(revenue_aud), 0)                                    AS total_pnl,
                COUNT(*)                                                          AS n_fills,
                COALESCE(SUM(CASE WHEN revenue_aud > 0 THEN 1 ELSE 0 END), 0)   AS n_wins
            FROM paper_fill
            WHERE duid = ?
            GROUP BY DATE(settlementdate)
            ORDER BY day
            """,
            (duid_up,),
        ).fetchall()

        all_row = con.execute(
            """
            SELECT
                COALESCE(SUM(revenue_aud), 0),
                COUNT(*),
                COALESCE(SUM(CASE WHEN revenue_aud > 0 THEN 1 ELSE 0 END), 0),
                MIN(settlementdate),
                MAX(settlementdate)
            FROM paper_fill WHERE duid = ?
            """,
            (duid_up,),
        ).fetchone()

        cutoff_7d  = (now_nem() - timedelta(days=7) ).strftime("%Y-%m-%d")
        cutoff_30d = (now_nem() - timedelta(days=30)).strftime("%Y-%m-%d")

        pnl_7d  = con.execute(
            "SELECT COALESCE(SUM(revenue_aud),0) FROM paper_fill WHERE duid=? AND settlementdate>=?",
            (duid_up, cutoff_7d),
        ).fetchone()[0]

        pnl_30d = con.execute(
            "SELECT COALESCE(SUM(revenue_aud),0) FROM paper_fill WHERE duid=? AND settlementdate>=?",
            (duid_up, cutoff_30d),
        ).fetchone()[0]

    # Build daily list with running cumulative
    daily: list[dict] = []
    cum = 0.0
    for day, e_pnl, f_pnl, total, n_fills, n_wins in daily_rows:
        cum += total
        daily.append({
            "day":        day,
            "energy_pnl": round(e_pnl, 2),
            "fcas_pnl":   round(f_pnl, 2),
            "total_pnl":  round(total, 2),
            "cumulative": round(cum, 2),
            "n_fills":    n_fills,
            "win_rate":   round(n_wins / n_fills * 100, 1) if n_fills else 0.0,
        })

    total_pnl, n_fills, n_wins, first_fill, last_fill = all_row
    total_pnl = round(float(total_pnl), 2)

    # Annualised: project total over elapsed trading days
    trading_days = 1
    if first_fill and last_fill and first_fill != last_fill:
        try:
            d0 = datetime.fromisoformat(first_fill[:10])
            d1 = datetime.fromisoformat(last_fill[:10])
            trading_days = max(1, (d1 - d0).days)
        except Exception:
            pass

    annualized = round(total_pnl / trading_days * 365, 2) if trading_days else 0.0

    return {
        "daily": daily,
        "stats": {
            "total_pnl":      total_pnl,
            "pnl_7d":         round(float(pnl_7d),  2),
            "pnl_30d":        round(float(pnl_30d), 2),
            "annualized_aud": annualized,
            "n_fills":        n_fills,
            "win_rate":       round(n_wins / n_fills * 100, 1) if n_fills else 0.0,
            "first_fill":     first_fill,
            "last_fill":      last_fill,
            "trading_days":   trading_days,
        },
    }


def reset_state(duid: str = "WTAHB1") -> dict:
    """Wipe bids/fills, reset SoC to 50%. Demo convenience."""
    with write_conn() as con:
        con.execute("DELETE FROM paper_fill WHERE duid = ?", (duid,))
        con.execute("DELETE FROM paper_bid WHERE duid = ?", (duid,))
        con.execute(
            """
            UPDATE paper_bess_state
            SET soc_mwh = capacity_mwh / 2,
                cumulative_pnl_aud = 0,
                last_settled_interval = NULL,
                updated_at = ?
            WHERE duid = ?
            """,
            (now_nem().strftime("%Y-%m-%d %H:%M:%S"), duid),
        )
    return {"duid": duid, "status": "reset"}


# ---------- Settlement -----------------------------------------------------

def _cleared_price(row: tuple, market: str) -> float | None:
    """Pick the right RRP column from a fetched nem_dispatch_price row."""
    # row order matches the SELECT in _settle_for_interval below.
    cols = {
        "ENERGY": 2,
        "RAISE6SEC": 3, "RAISE60SEC": 4, "RAISE5MIN": 5,
        "RAISEREG": 6, "RAISE1SEC": 7,
        "LOWER6SEC": 8, "LOWER60SEC": 9, "LOWER5MIN": 10,
        "LOWERREG": 11, "LOWER1SEC": 12,
    }
    idx = cols.get(market)
    return row[idx] if idx is not None else None


def _settle_one_bid(
    con: sqlite3.Connection,
    bid: dict,
    cleared_price: float,
    state: dict,
) -> tuple[float, float, float, float]:
    """Compute (enabled_mw, energy_mwh, revenue, new_soc) for a single bid.

    Returns the values to write to paper_fill plus the updated SoC.
    Bid dict keys: bid_id, duid, market, direction, bands.
    """
    market = bid["market"]
    direction = bid["direction"]
    bands = bid["bands"]
    soc = state["soc_mwh"]
    cap = state["capacity_mwh"]
    power = state["power_mw"]
    # MLF applies to ENERGY only (AEMO doesn't loss-adjust FCAS capacity
    # payments). 1.0 = no losses; <1.0 means the local node is "downstream"
    # of the RRN — generators get paid less, loads pay more for the same
    # delivered MWh at their point of connection.
    mlf = state.get("mlf", 1.0) or 1.0
    # sqrt(rte) per direction so a full round-trip yields rte%.
    eff_one_way = math.sqrt(state["rte_pct"] / 100.0)

    if market == ENERGY:
        if direction == "GEN":
            # Discharge: bands offered to *sell*; clear band if its price ≤ RRP.
            mw = sum(b["mw"] for b in bands if b["price"] <= cleared_price)
            mw = min(mw, power)
            # To deliver `mw * 5/60` MWh to the grid, we drain
            # `delivered / eff_one_way` from the battery (inverter losses).
            delivered = mw * INTERVAL_HRS
            drained = delivered / max(eff_one_way, 1e-9)
            if drained > soc:
                drained = soc
                delivered = drained * eff_one_way
                mw = delivered / INTERVAL_HRS
            new_soc = soc - drained
            energy_mwh = delivered           # MWh actually injected to grid
            # AEMO: gen revenue = RRP × MLF × MWh. Network losses lower the
            # effective payment at the local node.
            revenue = delivered * cleared_price * mlf
            enabled_mw = mw
            return enabled_mw, energy_mwh, revenue, new_soc
        else:  # LOAD = charge
            # Charge bands offered to *buy*; clear if its price ≥ RRP (we're
            # willing to pay up to band price; if RRP is lower, we charge).
            mw = sum(b["mw"] for b in bands if b["price"] >= cleared_price)
            mw = min(mw, power)
            # Cap by remaining headroom: incoming grid energy * eff_one_way fits.
            headroom_mwh = cap - soc
            grid_energy = mw * INTERVAL_HRS
            stored_energy = grid_energy * eff_one_way
            if stored_energy > headroom_mwh:
                stored_energy = headroom_mwh
                grid_energy = stored_energy / max(eff_one_way, 1e-9)
                mw = grid_energy / INTERVAL_HRS
            new_soc = soc + stored_energy
            energy_mwh = -grid_energy  # signed: negative = bought
            # AEMO: load cost = RRP × MWh / MLF. Losses borne by the
            # consumer mean you draw more upstream MW to get the same
            # delivered MWh, so the cost (negative revenue) grows.
            revenue = -grid_energy * cleared_price / max(mlf, 1e-9)
            enabled_mw = -mw  # signed
            return enabled_mw, energy_mwh, revenue, new_soc
    else:
        # FCAS: capacity payment, no SoC impact in this MVP.
        # Clearing rule for capacity bids: enabled if band price ≤ FCAS RRP
        # (you offered to be available at ≤ that $/MW/hr).
        # NOTE: FCAS settlement is NOT loss-adjusted — AEMO pays at the
        # cleared FCAS price per enabled MW regardless of MLF.
        mw = sum(b["mw"] for b in bands if b["price"] <= cleared_price)
        mw = min(mw, power)
        # Capacity payment: MW × $/MW/hr × hours
        revenue = mw * cleared_price * INTERVAL_HRS
        enabled_mw = mw if direction == "GEN" else -mw
        return enabled_mw, 0.0, revenue, soc


def _settle_for_interval(
    con: sqlite3.Connection,
    duid: str,
    interval_iso: str,
) -> int:
    """Settle every PENDING bid for (duid, interval_iso). Returns count."""
    # B4: fail loudly rather than silently clearing against NSW1 RRP — a
    # quiet fallback here would book bogus revenue.
    region = _require_region(duid)
    price_row = con.execute(
        """
        SELECT settlementdate, regionid, rrp,
               raise6sec_rrp, raise60sec_rrp, raise5min_rrp, raisereg_rrp, raise1sec_rrp,
               lower6sec_rrp, lower60sec_rrp, lower5min_rrp, lowerreg_rrp, lower1sec_rrp
        FROM nem_dispatch_price
        WHERE settlementdate = ? AND regionid = ?
        """,
        (interval_iso, region),
    ).fetchone()
    if not price_row:
        return 0  # not yet cleared

    state = _bess_state(con, duid)
    if not state:
        return 0  # untracked DUID

    bid_rows = con.execute(
        """
        SELECT bid_id, duid, market, direction, bands_json
        FROM paper_bid
        WHERE duid = ? AND target_settlementdate = ? AND status = 'PENDING'
        ORDER BY bid_id
        """,
        (duid, interval_iso),
    ).fetchall()
    if not bid_rows:
        return 0

    settled = 0
    for r in bid_rows:
        bid = {"bid_id": r[0], "duid": r[1], "market": r[2],
               "direction": r[3], "bands": json.loads(r[4])}
        clear = _cleared_price(price_row, bid["market"])
        if clear is None:
            continue  # FCAS price missing for this market — skip this bid
        enabled, energy_mwh, revenue, new_soc = _settle_one_bid(
            con, bid, clear, state,
        )
        con.execute(
            """
            INSERT INTO paper_fill
                (bid_id, duid, settlementdate, market, cleared_price,
                 enabled_mw, energy_mwh, revenue_aud, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (bid["bid_id"], bid["duid"], interval_iso, bid["market"], clear,
             enabled, energy_mwh, revenue, now_nem().strftime("%Y-%m-%d %H:%M:%S")),
        )
        con.execute(
            "UPDATE paper_bid SET status = 'SETTLED' WHERE bid_id = ?",
            (bid["bid_id"],),
        )
        # Apply SoC update + cumulative P&L.
        con.execute(
            """
            UPDATE paper_bess_state
            SET soc_mwh = ?, cumulative_pnl_aud = cumulative_pnl_aud + ?,
                last_settled_interval = ?, updated_at = ?
            WHERE duid = ?
            """,
            (new_soc, revenue, interval_iso,
             now_nem().strftime("%Y-%m-%d %H:%M:%S"), bid["duid"]),
        )
        # Refresh state snapshot for the next bid in this loop.
        state["soc_mwh"] = new_soc
        settled += 1
    return settled


def settle_pending() -> dict:
    """Sweep all DUIDs with bess_state, settle every interval that has a price.

    Called after each NEM tick by the scheduler. Idempotent: a bid that's
    already SETTLED is skipped, so re-running is a no-op.
    """
    counts: dict[str, int] = {}
    with write_conn() as con:
        duids = [r[0] for r in con.execute(
            "SELECT duid FROM paper_bess_state"
        ).fetchall()]
        for duid in duids:
            # Find every distinct interval that has a pending bid AND has
            # a settled price now.
            region = region_for_duid(duid)
            if region is None:
                # B4: don't silently settle against NSW1 when the DUID
                # isn't in the modelled generator list. Warn and skip so
                # the rest of the sweep still settles correctly.
                log.warning(
                    "settle_pending: skipping DUID %s — no region in "
                    "GENERATORS_BY_DUID; bids will stay PENDING",
                    duid,
                )
                continue
            rows = con.execute(
                """
                SELECT DISTINCT b.target_settlementdate
                FROM paper_bid b
                JOIN nem_dispatch_price p
                  ON p.settlementdate = b.target_settlementdate
                 AND p.regionid = ?
                WHERE b.duid = ? AND b.status = 'PENDING'
                ORDER BY b.target_settlementdate
                """,
                (region, duid),
            ).fetchall()
            n = 0
            for r in rows:
                n += _settle_for_interval(con, duid, r[0])
            if n:
                counts[duid] = n
    if counts:
        log.info("settled bids: %s", counts)
    return counts


# ---------- Misc -----------------------------------------------------------

def _iso(v) -> str | None:
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.isoformat()
    return str(v)


def _normalise_ts(v: datetime | str) -> str:
    """Coerce a timestamp into the 'YYYY-MM-DD HH:MM:SS' form SQLite's
    PARSE_DECLTYPES converter expects on read-back. Accepts datetime or any
    ISO-ish string (T-separator, microseconds, trailing 'Z'/offset)."""
    if isinstance(v, datetime):
        dt = v
    else:
        s = str(v).strip().replace("Z", "+00:00")
        try:
            dt = datetime.fromisoformat(s)
        except ValueError:
            # Try without timezone info; bid form sends naive UTC.
            dt = datetime.fromisoformat(s[:19])
    if dt.tzinfo is not None:
        dt = dt.replace(tzinfo=None)
    dt = dt.replace(second=0, microsecond=0)
    return dt.strftime("%Y-%m-%d %H:%M:%S")
