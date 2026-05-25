"""Telemetry simulator for VPP resources.

In a real platform, `vpp_resource.availability_now` and `soc_kwh` would be
populated by live SCADA / OCPP / Modbus polling against each site. We don't
have those feeds; without simulation the rows stay frozen and the UI
quickly looks fake.

This module runs every NEM tick and advances each resource's state
deterministically based on the wall clock:

  * EV charger groups: `availability_now` follows a diurnal occupancy
    curve. A weekday office hub (window 7-19) peaks at ~0.9 mid-morning
    and drops to ~0.2 outside office hours. Fleet depots (window 18-6)
    do the opposite. We also add a tiny random walk so the value drifts
    between refreshes rather than snapping to a curve point.

  * BESS sites: SoC drifts toward the "ideal preconditioned" level the
    operator would target for the coming peak — e.g. ramps up to ~75%
    by 16:00 NEM ahead of the evening peak, then drops as it
    "discharges" (in real life this would be the settled fill flow,
    which our settle worker already handles; here we only fill the gap
    when no fills have moved SoC for a while so an idle DB doesn't look
    visibly dead).

Idempotent — uses the `updated_at` column to skip resources updated
within the last minute.
"""
from __future__ import annotations

import logging
import math
import random
from datetime import datetime, timedelta

from .db import locked_conn

log = logging.getLogger("vpp.telemetry")


def _nem_now() -> datetime:
    return datetime.utcnow() + timedelta(hours=10)


def _ev_diurnal_factor(h_local: float, window_start: int, window_end: int) -> float:
    """Smooth diurnal occupancy for an EV charger group. Returns 0-1.

    Office-hour window (start < end): bell-shaped curve peaking at
    midpoint of the window, low at edges, 0 outside.

    Overnight window (start > end, e.g. 18→6): inverted curve, peaks at
    01:00, low at the boundaries.
    """
    # In-window check (with wrap)
    if window_start < window_end:
        in_window = window_start <= h_local < window_end
        if not in_window: return 0.05    # tiny residual idle plug-ins
        mid = (window_start + window_end) / 2
        half_width = (window_end - window_start) / 2
        # Cosine bell: peaks at midpoint
        rel = (h_local - mid) / max(half_width, 1)
        return 0.25 + 0.65 * max(0.0, math.cos(rel * math.pi / 2)) ** 2
    else:
        # Overnight: shift hour so we can use same formula
        # Treat 24:00 → 0:00 boundary
        in_window = h_local >= window_start or h_local < window_end
        if not in_window: return 0.05
        # Re-centre around midnight: e.g. window 18→6 → midpoint = 0
        if h_local >= window_start:
            adj = h_local - window_start
        else:
            adj = (24 - window_start) + h_local
        width = (24 - window_start) + window_end
        mid = width / 2
        rel = (adj - mid) / max(mid, 1)
        return 0.30 + 0.60 * max(0.0, math.cos(rel * math.pi / 2)) ** 2


def _bess_target_soc_fraction(h_local: float) -> float:
    """Operator-style target SoC by time of day:
       * Charge up overnight (target 75% by 06:00)
       * Hold through morning
       * Top up to 85-90% by 16:00 (ahead of evening peak)
       * Drift down 17:00-21:00 as evening dispatch occurs
       * Settle to ~40-50% overnight to be ready to absorb cheap energy

    This is a SOFT TARGET — used only to nudge SoC when no real settled
    fill has moved it recently. Real fills (from settle worker) take
    precedence.
    """
    # Two cosine-blended peaks: morning hold at ~75% and evening peak
    # prep at ~85%.
    # Simplified: piecewise linear key points then linear interp.
    keys = [
        ( 0, 0.55), ( 4, 0.70), ( 6, 0.75),
        (10, 0.75), (14, 0.80), (16, 0.85),
        (18, 0.75), (20, 0.55), (22, 0.50),
        (24, 0.55),
    ]
    for i in range(len(keys) - 1):
        h0, v0 = keys[i]; h1, v1 = keys[i + 1]
        if h0 <= h_local <= h1:
            t = (h_local - h0) / max(h1 - h0, 1e-6)
            return v0 + t * (v1 - v0)
    return 0.55


def tick() -> dict:
    """Advance availability + SoC for all resources whose row hasn't been
    touched in the last 60 s. Run from the NEM scheduler tick."""
    now = _nem_now()
    now_str = now.strftime("%Y-%m-%d %H:%M:%S")
    stale_cutoff = (now - timedelta(seconds=60)).strftime("%Y-%m-%d %H:%M:%S")
    h_local = now.hour + now.minute / 60.0

    out = {"ev_updated": 0, "bess_updated": 0}
    with locked_conn() as con:
        rows = con.execute(
            """
            SELECT resource_id, kind, nameplate_kw, capacity_kwh, soc_kwh,
                   availability_now, window_start_hr, window_end_hr, opted_in
            FROM vpp_resource
            WHERE updated_at < ?
            """,
            (stale_cutoff,),
        ).fetchall()

        for r in rows:
            (rid, kind, nameplate_kw, capacity_kwh, soc_kwh,
             avail_now, ws, we, opted_in) = r

            if kind == "evcharger":
                target = _ev_diurnal_factor(h_local, int(ws), int(we))
                # Random walk towards target (15% blend) + small noise.
                new_avail = max(0.0, min(1.0,
                    float(avail_now) * 0.85 + target * 0.15 + (random.random() - 0.5) * 0.04))
                con.execute(
                    "UPDATE vpp_resource SET availability_now = ?, updated_at = ? "
                    "WHERE resource_id = ?",
                    (new_avail, now_str, rid),
                )
                out["ev_updated"] += 1

            elif kind == "bess":
                target_soc = float(capacity_kwh) * _bess_target_soc_fraction(h_local)
                # Slow blend (3% per tick) toward target — represents what
                # the asset management system would do absent live market
                # dispatch. Real fills from settle worker have already
                # updated SoC; this drift only nudges when nothing else has.
                new_soc = float(soc_kwh) * 0.97 + target_soc * 0.03
                new_soc = max(0.0, min(float(capacity_kwh), new_soc))
                # Availability for BESS stays close to 1.0 (no outage
                # modelling for now); small jitter to feel alive.
                new_avail = max(0.92, min(1.0, float(avail_now) + (random.random() - 0.5) * 0.02))
                con.execute(
                    "UPDATE vpp_resource SET soc_kwh = ?, availability_now = ?, "
                    "       updated_at = ? WHERE resource_id = ?",
                    (new_soc, new_avail, now_str, rid),
                )
                out["bess_updated"] += 1

    if out["ev_updated"] or out["bess_updated"]:
        log.info("vpp telemetry: EV=%d BESS=%d", out["ev_updated"], out["bess_updated"])
    return out
