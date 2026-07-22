#!/usr/bin/env python3
"""
Download high-voltage transmission line and substation GeoJSON
for QLD, VIC, SA, TAS from OpenStreetMap Overpass API.

Output files (written to webapp/frontend/public/):
  qld-transmission.geojson    vic-transmission.geojson
  sa-transmission.geojson     tas-transmission.geojson
  qld-substations.geojson     vic-substations.geojson
  sa-substations.geojson      tas-substations.geojson

Format matches existing nsw-transmission.geojson / nsw-substations.geojson:
  lines:      {"v": <kV int>, "op": "<operator>"}  + LineString
  substations:{"v": <kV int>, "name": "<name>"}   + Point

Usage:
  cd /path/to/claude-PriceForecastNEM
  python3 fetch_transmission.py
"""

import json
import math
import time
import urllib.request
import urllib.parse
from pathlib import Path

# ── Output directory ──────────────────────────────────────────────────────────
OUT_DIR = Path(__file__).parent / "webapp" / "frontend" / "public"

# ── State bounding boxes: (south, west, north, east) ─────────────────────────
STATES = {
    "qld": (-29.2,  137.9, -9.9,  153.6),
    "vic": (-39.2,  140.9, -33.9, 149.9),
    "sa":  (-38.1,  129.0, -25.9, 141.0),
    "tas": (-43.7,  143.8, -39.5, 148.6),
}

# Voltages to keep (kV). Matches NSW file (132, 220, 275, 330, 500).
KEEP_KV = {132, 220, 275, 330, 500}

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
TIMEOUT = 120   # seconds per request


# ── Helpers ───────────────────────────────────────────────────────────────────

def _parse_voltage(raw: str) -> int | None:
    """Return voltage in kV, or None if unparseable / below threshold."""
    if not raw:
        return None
    # OSM stores volts: "330000", or "330000;220000" (multi-voltage)
    for part in raw.split(";"):
        part = part.strip()
        if not part:
            continue
        try:
            v = int(part)
        except ValueError:
            continue
        kv = v // 1000 if v >= 1000 else v   # handle kV input too
        if kv in KEEP_KV:
            return kv
    return None


def _round4(x: float) -> float:
    return round(x, 4)


def _overpass_query(query: str) -> dict:
    data = urllib.parse.urlencode({"data": query}).encode()
    req = urllib.request.Request(
        OVERPASS_URL, data=data,
        headers={"User-Agent": "nem-price-forecast/1.0 (fetch_transmission.py)"},
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


# ── Transmission lines ────────────────────────────────────────────────────────

def fetch_lines(state: str, bbox: tuple) -> dict:
    s, w, n, e = bbox
    q = f"""
[out:json][timeout:{TIMEOUT}];
(
  way["power"="line"]["voltage"~"132000|220000|275000|330000|500000"]({s},{w},{n},{e});
  way["power"="cable"]["voltage"~"132000|220000|275000|330000|500000"]({s},{w},{n},{e});
);
(._;>;);
out body;
"""
    print(f"  Querying {state.upper()} lines …", end="", flush=True)
    raw = _overpass_query(q)

    # Build node-id → [lon, lat] lookup
    nodes: dict[int, list[float]] = {}
    for el in raw.get("elements", []):
        if el["type"] == "node":
            nodes[el["id"]] = [_round4(el["lon"]), _round4(el["lat"])]

    features = []
    for el in raw.get("elements", []):
        if el["type"] != "way":
            continue
        tags = el.get("tags", {})
        kv = _parse_voltage(tags.get("voltage", ""))
        if kv is None:
            continue
        coords = [nodes[nid] for nid in el.get("nodes", []) if nid in nodes]
        if len(coords) < 2:
            continue
        features.append({
            "type": "Feature",
            "properties": {"v": kv, "op": tags.get("operator", "")},
            "geometry": {"type": "LineString", "coordinates": coords},
        })

    print(f" {len(features)} features")
    return {"type": "FeatureCollection", "features": features}


# ── Substations ───────────────────────────────────────────────────────────────

def fetch_substations(state: str, bbox: tuple) -> dict:
    s, w, n, e = bbox
    q = f"""
[out:json][timeout:{TIMEOUT}];
(
  node["power"="substation"]["voltage"~"132000|220000|275000|330000|500000"]({s},{w},{n},{e});
  node["power"="sub_station"]["voltage"~"132000|220000|275000|330000|500000"]({s},{w},{n},{e});
  way["power"="substation"]["voltage"~"132000|220000|275000|330000|500000"]({s},{w},{n},{e});
);
out center;
"""
    print(f"  Querying {state.upper()} substations …", end="", flush=True)
    raw = _overpass_query(q)

    features = []
    for el in raw.get("elements", []):
        tags = el.get("tags", {})
        kv = _parse_voltage(tags.get("voltage", ""))
        if kv is None:
            continue
        # Ways return a "center" key; nodes use lat/lon directly
        if el["type"] == "node":
            lon, lat = _round4(el["lon"]), _round4(el["lat"])
        elif el["type"] == "way" and "center" in el:
            lon, lat = _round4(el["center"]["lon"]), _round4(el["center"]["lat"])
        else:
            continue
        features.append({
            "type": "Feature",
            "properties": {"v": kv, "name": tags.get("name", "")},
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
        })

    print(f" {len(features)} features")
    return {"type": "FeatureCollection", "features": features}


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for state, bbox in STATES.items():
        print(f"\n── {state.upper()} ──")

        try:
            lines = fetch_lines(state, bbox)
            out = OUT_DIR / f"{state}-transmission.geojson"
            out.write_text(json.dumps(lines, separators=(",", ":")), encoding="utf-8")
            print(f"  Saved → {out}")
        except Exception as e:
            print(f"  ERROR (lines): {e}")

        time.sleep(2)   # be polite to Overpass

        try:
            subs = fetch_substations(state, bbox)
            out = OUT_DIR / f"{state}-substations.geojson"
            out.write_text(json.dumps(subs, separators=(",", ":")), encoding="utf-8")
            print(f"  Saved → {out}")
        except Exception as e:
            print(f"  ERROR (substations): {e}")

        time.sleep(2)

    print("\nDone. Files written to webapp/frontend/public/")


if __name__ == "__main__":
    main()
