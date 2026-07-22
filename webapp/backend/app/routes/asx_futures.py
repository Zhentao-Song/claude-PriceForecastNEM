"""ASX Energy electricity futures API route."""
from __future__ import annotations

import threading
import time

from fastapi import APIRouter, HTTPException

from ..asx_energy import latest_report

router = APIRouter(prefix="/api/asx-energy", tags=["asx-energy"])

_CACHE_TTL_SECONDS = 15 * 60
_cache: tuple[float, dict] | None = None
_cache_lock = threading.Lock()


@router.get("/futures")
def electricity_futures() -> dict:
    global _cache
    now = time.monotonic()
    if _cache and now - _cache[0] < _CACHE_TTL_SECONDS:
        return _cache[1]
    with _cache_lock:
        now = time.monotonic()
        if _cache and now - _cache[0] < _CACHE_TTL_SECONDS:
            return _cache[1]
        try:
            payload = latest_report()
        except RuntimeError as exc:
            if _cache:
                stale = dict(_cache[1])
                stale["stale"] = True
                stale["warning"] = "Latest ASX report could not be refreshed; showing cached settlement data."
                return stale
            raise HTTPException(status_code=503, detail=f"ASX Energy data unavailable: {exc}") from exc
        _cache = (time.monotonic(), payload)
        return payload
