"""Static metadata for the 6 NEM interconnectors.

Coordinates are approximate (the connecting substations on each side).
"Nominal direction" matches AEMO's interconnectorid naming: A_to_B means
positive flow goes A -> B. Limits are indicative reference values; the
actual binding limit per dispatch interval comes from EXPORTLIMIT /
IMPORTLIMIT in DISPATCH_INTERCONNECTORRES (which we store).
"""
from __future__ import annotations

# interconnectorid -> metadata
INTERCONNECTORS: dict[str, dict] = {
    # Queensland <-> NSW Interconnector (QNI). 765kV overhead line.
    "NSW1-QLD1": {
        "name": "QNI",
        "long_name": "Queensland–NSW Interconnector",
        "region_from": "NSW1",   # positive flow = NSW -> QLD
        "region_to":   "QLD1",
        "from": [151.78, -32.92],   # Liddell / Hunter Valley NSW
        "to":   [152.20, -27.55],   # near Greenbank substation, SE QLD
        "nominal_limit_mw": 1100,
        "mnsp": False,
    },
    # Victoria <-> NSW (Vic-NSW Interconnector + part of QNI). 330kV.
    "VIC1-NSW1": {
        "name": "VNI",
        "long_name": "Victoria–NSW Interconnector",
        "region_from": "VIC1",   # positive flow = VIC -> NSW
        "region_to":   "NSW1",
        "from": [145.97, -36.36],   # Dederang / Murray VIC
        "to":   [148.09, -35.31],   # Snowy / Upper Tumut NSW
        "nominal_limit_mw": 1900,
        "mnsp": False,
    },
    # Heywood Interconnector (V-SA, 500kV). Largest SA link.
    "V-SA": {
        "name": "Heywood",
        "long_name": "Heywood Interconnector (VIC–SA)",
        "region_from": "VIC1",   # positive flow = VIC -> SA
        "region_to":   "SA1",
        "from": [141.62, -37.98],   # Heywood VIC
        "to":   [140.78, -37.55],   # South East SA / Tailem Bend
        "nominal_limit_mw": 650,
        "mnsp": False,
    },
    # Murraylink (HVDC, 220MW MNSP between Red Cliffs VIC and Berri SA).
    "V-S-MNSP1": {
        "name": "Murraylink",
        "long_name": "Murraylink HVDC (VIC–SA)",
        "region_from": "VIC1",   # positive flow = VIC -> SA
        "region_to":   "SA1",
        "from": [142.20, -34.30],   # Red Cliffs VIC
        "to":   [140.60, -34.28],   # Berri SA
        "nominal_limit_mw": 220,
        "mnsp": True,
    },
    # Basslink (HVDC, ~500MW MNSP between Loy Yang VIC and George Town TAS).
    "T-V-MNSP1": {
        "name": "Basslink",
        "long_name": "Basslink HVDC (TAS–VIC)",
        "region_from": "TAS1",   # positive flow = TAS -> VIC
        "region_to":   "VIC1",
        "from": [146.83, -41.09],   # George Town TAS
        "to":   [146.59, -38.25],   # Loy Yang VIC
        "nominal_limit_mw": 500,
        "mnsp": True,
    },
    # NSW1-QLD1 also exists as a separate "Terranora" historical link?
    # Not in current DispatchIS — the modern QNI is single id NSW1-QLD1.
    # Project EnergyConnect (SA-NSW) is partially in service:
    "N-Q-MNSP1": {
        "name": "Terranora",
        "long_name": "Terranora Interconnector (NSW–QLD MNSP)",
        "region_from": "NSW1",   # positive flow = NSW -> QLD
        "region_to":   "QLD1",
        "from": [153.49, -28.40],   # Terranora NSW (just south of Tweed)
        "to":   [153.45, -28.18],   # Mudgeeraba QLD (Gold Coast)
        "nominal_limit_mw": 210,
        "mnsp": True,
    },
}

# Region centroids for state labels & generator clustering (approximate
# capital-city locations for NEM regions).
REGION_CENTROIDS: dict[str, list[float]] = {
    "NSW1": [147.0, -33.0],
    "QLD1": [146.0, -23.0],
    "VIC1": [144.5, -37.0],
    "SA1":  [136.0, -32.0],
    "TAS1": [146.6, -42.0],
}
