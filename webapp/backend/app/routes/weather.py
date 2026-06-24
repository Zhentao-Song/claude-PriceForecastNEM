"""
weather.py — Regional weather (past 6 days + today) for NEM + WEM regions.
Source: Open-Meteo (free, no API key).

Hourly series: 7 × 24 = 168 points of temperature, solar radiation,
wind speed and wind direction — enough for a 7-day temperature heatmap
and daily wind/solar trend charts.

Cache TTL: 30 minutes (weather doesn't change on a 5-min NEM tick).
"""
from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx
from fastapi import APIRouter

router = APIRouter()

_LOCATIONS: dict[str, dict[str, Any]] = {
    "NSW1": {"lat": -33.8688, "lon": 151.2093, "city": "Sydney",    "tz": "Australia/Sydney"},
    "QLD1": {"lat": -27.4698, "lon": 153.0251, "city": "Brisbane",  "tz": "Australia/Brisbane"},
    "VIC1": {"lat": -37.8136, "lon": 144.9631, "city": "Melbourne", "tz": "Australia/Melbourne"},
    "SA1":  {"lat": -34.9285, "lon": 138.6007, "city": "Adelaide",  "tz": "Australia/Adelaide"},
    "TAS1": {"lat": -42.8821, "lon": 147.3272, "city": "Hobart",    "tz": "Australia/Hobart"},
    "WEM":  {"lat": -31.9505, "lon": 115.8605, "city": "Perth",     "tz": "Australia/Perth"},
}

_OPEN_METEO = "https://api.open-meteo.com/v1/forecast"
_CACHE_TTL  = 1800  # 30 minutes
_cache: dict[str, dict[str, Any]] = {}


async def _fetch_one(
    client: httpx.AsyncClient, region: str, loc: dict[str, Any]
) -> dict[str, Any]:
    params = {
        "latitude":    loc["lat"],
        "longitude":   loc["lon"],
        # Current conditions
        "current": (
            "temperature_2m,apparent_temperature,"
            "wind_speed_10m,wind_direction_10m,"
            "shortwave_radiation,precipitation,weather_code"
        ),
        # 7-day hourly series: past 6 days + today = 168 h
        "hourly": (
            "temperature_2m,shortwave_radiation,"
            "wind_speed_10m,wind_direction_10m"
        ),
        "past_days":     6,
        "forecast_days": 1,
        "timezone":      loc["tz"],
    }
    resp = await client.get(_OPEN_METEO, params=params, timeout=12.0)
    resp.raise_for_status()
    j = resp.json()

    cur    = j.get("current", {})
    hourly = j.get("hourly",  {})

    # 7 × 24 = 168 hourly points (past 6 days + today)
    times     = hourly.get("time", [])
    h_temp    = hourly.get("temperature_2m", [])
    h_solar   = hourly.get("shortwave_radiation", [])
    h_wspeed  = hourly.get("wind_speed_10m", [])
    h_wdir    = hourly.get("wind_direction_10m", [])

    return {
        "region":               region,
        "city":                 loc["city"],
        # Current snapshot
        "temperature":          cur.get("temperature_2m"),
        "apparent_temperature": cur.get("apparent_temperature"),
        "wind_speed_kmh":       cur.get("wind_speed_10m"),
        "wind_direction_deg":   cur.get("wind_direction_10m"),
        "solar_radiation_wm2":  cur.get("shortwave_radiation"),
        "precipitation_mm":     cur.get("precipitation"),
        "weather_code":         cur.get("weather_code"),
        # 7-day hourly series (168 items each)
        "hourly_times":         times,
        "hourly_temp":          h_temp,
        "hourly_solar":         h_solar,
        "hourly_wind_speed":    h_wspeed,
        "hourly_wind_dir":      h_wdir,
    }


@router.get("/api/weather/nem")
async def weather_nem() -> dict[str, Any]:
    """Current weather + 7-day hourly series for all NEM regions + Perth (WEM)."""
    now = time.time()

    if all(
        r in _cache and now - _cache[r]["ts"] < _CACHE_TTL
        for r in _LOCATIONS
    ):
        return {
            "regions":     [_cache[r]["data"] for r in _LOCATIONS],
            "cache_age_s": int(now - min(_cache[r]["ts"] for r in _LOCATIONS)),
        }

    async with httpx.AsyncClient() as client:
        tasks   = [_fetch_one(client, r, loc) for r, loc in _LOCATIONS.items()]
        results = await asyncio.gather(*tasks, return_exceptions=True)

    out: list[dict[str, Any]] = []
    for region, result in zip(_LOCATIONS.keys(), results):
        if isinstance(result, Exception):
            out.append(
                _cache[region]["data"] if region in _cache
                else {"region": region, "city": _LOCATIONS[region]["city"], "error": str(result)}
            )
        else:
            _cache[region] = {"data": result, "ts": now}
            out.append(result)

    return {"regions": out, "cache_age_s": 0}
