from __future__ import annotations

from collections import defaultdict
from typing import Any, Iterable


MAX_FCAS_FORECAST_HOURS = 168

MARKETS: list[dict[str, str | int]] = [
    {"market": "raise1sec", "code": "R1", "name": "Very Fast Raise", "side": "raise", "response": "1s"},
    {"market": "raise6sec", "code": "R6", "name": "Fast Raise", "side": "raise", "response": "6s"},
    {"market": "raise60sec", "code": "R60", "name": "Slow Raise", "side": "raise", "response": "60s"},
    {"market": "raise5min", "code": "R5", "name": "Delayed Raise", "side": "raise", "response": "5min"},
    {"market": "raisereg", "code": "RREG", "name": "Raise Regulation", "side": "raise", "response": "regulation"},
    {"market": "lower1sec", "code": "L1", "name": "Very Fast Lower", "side": "lower", "response": "1s"},
    {"market": "lower6sec", "code": "L6", "name": "Fast Lower", "side": "lower", "response": "6s"},
    {"market": "lower60sec", "code": "L60", "name": "Slow Lower", "side": "lower", "response": "60s"},
    {"market": "lower5min", "code": "L5", "name": "Delayed Lower", "side": "lower", "response": "5min"},
    {"market": "lowerreg", "code": "LREG", "name": "Lower Regulation", "side": "lower", "response": "regulation"},
]

MARKET_KEYS = [str(m["market"]) for m in MARKETS]
_MARKET_META = {str(m["market"]): m for m in MARKETS}


def build_fcas_forecast(
    rows: Iterable[dict[str, Any]],
    *,
    focus_region: str,
    power_mw: float = 10.0,
    availability_pct: float = 100.0,
    interval_minutes: int = 5,
) -> dict[str, Any]:
    """Aggregate AEMO P5MIN/PREDISPATCH FCAS rows for the predictor panel."""
    region = focus_region.upper()
    enabled_mw = max(0.0, float(power_mw)) * max(0.0, min(100.0, float(availability_pct))) / 100.0
    deduped = _dedupe_rows(rows)
    focus_rows = [r for r in deduped if str(r.get("regionid", "")).upper() == region]
    focus_rows.sort(key=lambda r: str(r.get("interval_datetime") or ""))

    intervals = []
    for row in focus_rows:
        prices = {m: _num(row.get(m)) for m in MARKET_KEYS}
        best_market, best_price = _best_market(prices)
        intervals.append({
            "t": _iso(row.get("interval_datetime")),
            "source": row.get("source"),
            "run_datetime": _iso(row.get("run_datetime")),
            "prices": prices,
            "best_market": best_market,
            "best_code": _code(best_market),
            "best_price": best_price,
        })

    products = [
        _product_stats(market, focus_rows, enabled_mw, interval_minutes)
        for market in MARKET_KEYS
    ]
    products.sort(key=lambda p: (p["avg_price"] is None, -(p["avg_price"] or 0.0)))

    regions = _region_summaries(deduped, enabled_mw, interval_minutes)
    recommendation = _recommend(products)

    runs = [
        _iso(r.get("run_datetime"))
        for r in focus_rows
        if r.get("run_datetime") is not None
    ]
    sources = sorted({str(r.get("source")) for r in focus_rows if r.get("source")})

    return {
        "region": region,
        "markets": MARKETS,
        "interval_minutes": interval_minutes,
        "interval_count": len(focus_rows),
        "power_mw": power_mw,
        "availability_pct": availability_pct,
        "run_datetime": max(runs) if runs else None,
        "sources": sources,
        "intervals": intervals,
        "products": products,
        "regions": regions,
        "recommendation": recommendation,
    }


def _dedupe_rows(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    picked: dict[tuple[str, str], dict[str, Any]] = {}
    for row in rows:
        rid = str(row.get("regionid", "")).upper()
        interval = str(row.get("interval_datetime") or "")
        if not rid or not interval:
            continue
        key = (rid, interval)
        current = picked.get(key)
        if current is None or _prefer_row(row, current):
            picked[key] = row
    return sorted(picked.values(), key=lambda r: (str(r.get("regionid")), str(r.get("interval_datetime"))))


def _prefer_row(candidate: dict[str, Any], current: dict[str, Any]) -> bool:
    cand_source = str(candidate.get("source") or "")
    curr_source = str(current.get("source") or "")
    cand_rank = 0 if cand_source == "P5MIN" else 1
    curr_rank = 0 if curr_source == "P5MIN" else 1
    if cand_rank != curr_rank:
        return cand_rank < curr_rank
    return str(candidate.get("run_datetime") or "") > str(current.get("run_datetime") or "")


def _product_stats(
    market: str,
    rows: list[dict[str, Any]],
    enabled_mw: float,
    interval_minutes: int,
) -> dict[str, Any]:
    values = [_num(r.get(market)) for r in rows]
    prices = [v for v in values if v is not None]
    meta = _MARKET_META[market]
    avg_price = (sum(prices) / len(prices)) if prices else None
    peak_price = max(prices) if prices else None
    first_price = prices[0] if prices else None
    last_price = prices[-1] if prices else None
    revenue = None
    if avg_price is not None:
        revenue = avg_price * enabled_mw * len(prices) * interval_minutes / 60.0
    return {
        "market": market,
        "code": meta["code"],
        "name": meta["name"],
        "side": meta["side"],
        "response": meta["response"],
        "avg_price": _round(avg_price),
        "peak_price": _round(peak_price),
        "first_price": _round(first_price),
        "last_price": _round(last_price),
        "revenue_aud": _round(revenue),
        "intervals": len(prices),
        "trend": _trend(prices),
        "suitability": _suitability(avg_price, peak_price),
    }


def _region_summaries(
    rows: list[dict[str, Any]],
    enabled_mw: float,
    interval_minutes: int,
) -> list[dict[str, Any]]:
    by_region: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        by_region[str(row.get("regionid", "")).upper()].append(row)

    summaries = []
    for rid, region_rows in sorted(by_region.items()):
        market_avgs = {}
        market_peaks = {}
        for market in MARKET_KEYS:
            prices = [_num(r.get(market)) for r in region_rows]
            prices = [p for p in prices if p is not None]
            if prices:
                market_avgs[market] = sum(prices) / len(prices)
                market_peaks[market] = max(prices)
        best_market = max(market_avgs, key=market_avgs.get) if market_avgs else None
        avg_best = market_avgs.get(best_market) if best_market else None
        peak_best = market_peaks.get(best_market) if best_market else None
        revenue = None
        if avg_best is not None:
            revenue = avg_best * enabled_mw * len(region_rows) * interval_minutes / 60.0
        summaries.append({
            "regionid": rid,
            "intervals": len(region_rows),
            "best_market": best_market,
            "best_code": _code(best_market),
            "avg_best_price": _round(avg_best),
            "peak_best_price": _round(peak_best),
            "revenue_aud": _round(revenue),
        })
    return summaries


def _recommend(products: list[dict[str, Any]]) -> dict[str, Any]:
    viable = [p for p in products if p["avg_price"] is not None]
    if not viable:
        return {
            "market": None,
            "code": None,
            "message": "No FCAS forecast rows are available yet.",
            "confidence": "low",
        }
    best = max(viable, key=lambda p: (p["revenue_aud"] or 0.0, p["peak_price"] or 0.0))
    avg = best["avg_price"] or 0.0
    confidence = "high" if avg >= 20 else "medium" if avg >= 5 else "low"
    side = "raise" if best["side"] == "raise" else "lower"
    return {
        "market": best["market"],
        "code": best["code"],
        "message": f"Prioritise {best['code']} {side} availability in the next forecast window.",
        "confidence": confidence,
    }


def _best_market(prices: dict[str, float | None]) -> tuple[str | None, float | None]:
    available = {k: v for k, v in prices.items() if v is not None}
    if not available:
        return None, None
    market = max(available, key=available.get)
    return market, available[market]


def _trend(prices: list[float]) -> str:
    if len(prices) < 2:
        return "flat"
    first, last = prices[0], prices[-1]
    delta = last - first
    pct = delta / max(abs(first), 1.0)
    if delta >= 1.0 and pct >= 0.10:
        return "up"
    if delta <= -1.0 and pct <= -0.10:
        return "down"
    return "flat"


def _suitability(avg_price: float | None, peak_price: float | None) -> str:
    if avg_price is None:
        return "No forecast"
    if avg_price >= 20 or (peak_price is not None and peak_price >= 50):
        return "High"
    if avg_price >= 5 or (peak_price is not None and peak_price >= 10):
        return "Watch"
    return "Low"


def _num(v: Any) -> float | None:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _round(v: float | None) -> float | None:
    if v is None:
        return None
    return round(v, 2)


def _code(market: str | None) -> str | None:
    if not market:
        return None
    meta = _MARKET_META.get(market)
    return str(meta["code"]) if meta else None


def _iso(v: Any) -> str | None:
    if v is None:
        return None
    return str(v).replace(" ", "T")
