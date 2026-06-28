"""Open-Meteo weather features for the forecast models.

Weather is the #1 exogenous driver of NEM prices after price history itself:
solar radiation suppresses daytime prices (rooftop + utility PV), temperature
drives heating/cooling demand. Open-Meteo is free and needs no API key.

We cache hourly values per (region, hour) in `weather_cache`:
- history  → archive API   (https://archive-api.open-meteo.com/v1/archive)
- recent + future → forecast API (https://api.open-meteo.com/v1/forecast)

All timestamps are NEM time (UTC+10, no DST) via timezone=Australia/Brisbane,
so they line up with dispatch/predispatch.
"""
from __future__ import annotations

import logging
import sqlite3
from datetime import datetime, timedelta

import httpx

from ..db import locked_conn, write_conn
from . import data

log = logging.getLogger("forecast.weather")

# Representative load-centre coordinates per NEM region.
_COORDS = {
    "NSW1": (-33.87, 151.21),   # Sydney
    "QLD1": (-27.47, 153.03),   # Brisbane
    "VIC1": (-37.81, 144.96),   # Melbourne
    "SA1":  (-34.93, 138.60),   # Adelaide
    "TAS1": (-42.88, 147.33),   # Hobart
}
_VARS = "temperature_2m,shortwave_radiation,wind_speed_10m"
_TZ = "Australia/Brisbane"   # UTC+10, no DST = NEM market clock
_ARCHIVE = "https://archive-api.open-meteo.com/v1/archive"
_FORECAST = "https://api.open-meteo.com/v1/forecast"


def _coords(region: str) -> tuple[float, float]:
    return _COORDS.get(region, _COORDS["NSW1"])


def _weather_hour(half_hour_end: datetime) -> datetime:
    """The hour bucket [H, H+1) covering a half-hour interval. Both half-hours
    ending 14:30 and 15:00 map to hour 14:00."""
    e = half_hour_end - timedelta(minutes=15)
    return e.replace(minute=0, second=0, microsecond=0)


def _read_cache(con: sqlite3.Connection, region: str,
                h0: datetime, h1: datetime) -> dict[datetime, tuple]:
    rows = con.execute(
        """SELECT datetime, temp_c, ghi, wind_kmh FROM weather_cache
           WHERE regionid=? AND datetime>=? AND datetime<=?""",
        (region, data.fmt(h0), data.fmt(h1)),
    ).fetchall()
    return {data._as_dt(r[0]): (r[1], r[2], r[3]) for r in rows}


def _store(region: str, hourly: dict[datetime, tuple]) -> None:
    if not hourly:
        return
    rows = [(region, data.fmt(t), v[0], v[1], v[2]) for t, v in hourly.items()]
    with write_conn() as con:
        con.executemany(
            """INSERT OR REPLACE INTO weather_cache
               (regionid, datetime, temp_c, ghi, wind_kmh) VALUES (?,?,?,?,?)""",
            rows,
        )


def _parse_hourly(j: dict) -> dict[datetime, tuple]:
    h = j.get("hourly") or {}
    times = h.get("time") or []
    temp = h.get("temperature_2m") or []
    ghi = h.get("shortwave_radiation") or []
    wind = h.get("wind_speed_10m") or []
    out: dict[datetime, tuple] = {}
    for i, ts in enumerate(times):
        t = data._as_dt(str(ts).replace("T", " ")[:19] + (":00" if len(str(ts)) == 16 else ""))
        out[t.replace(minute=0, second=0)] = (
            temp[i] if i < len(temp) else None,
            ghi[i] if i < len(ghi) else None,
            wind[i] if i < len(wind) else None,
        )
    return out


def _fetch_archive(region: str, d0, d1) -> dict[datetime, tuple]:
    lat, lon = _coords(region)
    r = httpx.get(_ARCHIVE, params={
        "latitude": lat, "longitude": lon, "hourly": _VARS, "timezone": _TZ,
        "start_date": d0.strftime("%Y-%m-%d"), "end_date": d1.strftime("%Y-%m-%d"),
    }, timeout=30.0)
    r.raise_for_status()
    return _parse_hourly(r.json())


def _fetch_forecast(region: str, past_days: int = 7) -> dict[datetime, tuple]:
    lat, lon = _coords(region)
    r = httpx.get(_FORECAST, params={
        "latitude": lat, "longitude": lon, "hourly": _VARS, "timezone": _TZ,
        "past_days": min(92, max(1, past_days)), "forecast_days": 16,
    }, timeout=30.0)
    r.raise_for_status()
    return _parse_hourly(r.json())


def fetch_weather_hh(con: sqlite3.Connection, region: str,
                     start: datetime, end: datetime) -> dict[datetime, tuple]:
    """{half_hour_end: (temp_c, ghi, wind)} for half-hours in (start, end].
    Cache-first; fetches any missing hours from Open-Meteo (archive for old
    dates, forecast for recent/future). Best-effort: returns whatever it has."""
    targets = data.half_hour_targets(start, int((end - start).total_seconds() // 1800) + 2)
    targets = [t for t in targets if start < t <= end]
    need_hours = sorted({_weather_hour(t) for t in targets})
    if not need_hours:
        return {}
    h0, h1 = need_hours[0], need_hours[-1]

    cache = _read_cache(con, region, h0, h1)
    missing = [h for h in need_hours if h not in cache]
    if missing:
        now = data.nem_now()
        try:
            fetched: dict[datetime, tuple] = {}
            # Old history → archive (archive lags ~5 days).
            if missing[0] < now - timedelta(days=5):
                d1 = min(missing[-1], now - timedelta(days=5))
                fetched.update(_fetch_archive(region, missing[0], d1))
            # Recent + future → forecast (covers past_days back + 16 ahead).
            if missing[-1] >= now - timedelta(days=6):
                span_days = (now.date() - missing[0].date()).days + 1
                fetched.update(_fetch_forecast(region, past_days=span_days))
            if fetched:
                _store(region, fetched)
                cache.update(fetched)
        except Exception as e:  # pragma: no cover - network dependent
            log.warning("weather fetch failed (%s): %s", region, e)

    out: dict[datetime, tuple] = {}
    for t in targets:
        v = cache.get(_weather_hour(t))
        if v is not None:
            out[t] = v
    return out
