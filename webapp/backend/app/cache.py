"""Tiny in-process TTL cache for hot read endpoints.

SQLite is fast, but the heatmap (90-day × 5-region aggregation), OHLC
bucketing and leaderboard joins are recomputed on every page load while
the underlying data only changes every 5 minutes. A short TTL keeps
results fresh enough and cuts repeat query cost to ~zero.

Single-process only (uvicorn --workers 1) — which is exactly how this
app deploys. Not safe across multiple workers; don't add workers
without swapping this for Redis or similar.
"""
from __future__ import annotations

import functools
import time
from typing import Any, Callable, TypeVar

F = TypeVar("F", bound=Callable[..., Any])

_stats = {"hits": 0, "misses": 0}


def ttl_cache(seconds: float, maxsize: int = 256) -> Callable[[F], F]:
    """Memoise a sync function for `seconds`, keyed by its arguments."""
    def deco(fn: F) -> F:
        store: dict[tuple, tuple[float, Any]] = {}

        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            key = (args, tuple(sorted(kwargs.items())))
            now = time.monotonic()
            hit = store.get(key)
            if hit is not None and now - hit[0] < seconds:
                _stats["hits"] += 1
                return hit[1]
            _stats["misses"] += 1
            val = fn(*args, **kwargs)
            if len(store) >= maxsize:
                # Drop the stalest entry — cheap approximation of LRU.
                oldest = min(store, key=lambda k: store[k][0])
                store.pop(oldest, None)
            store[key] = (now, val)
            return val

        wrapper.cache_store = store  # type: ignore[attr-defined]
        return wrapper  # type: ignore[return-value]
    return deco


def cache_stats() -> dict:
    return dict(_stats)
