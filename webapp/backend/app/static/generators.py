"""Curated metadata for major NEM generators.

Source: AEMO Generation Information (publicly published), cross-referenced
with NEM Registration. Covers ~85% of NEM installed capacity.

Schema per entry:
    duid          — AEMO Dispatchable Unit ID (matches DISPATCH_UNIT_SCADA)
    station       — Human-readable station name
    region        — NEM region id (NSW1, QLD1, VIC1, SA1, TAS1)
    fuel          — coal_black | coal_brown | gas | hydro | wind | solar | battery | bioenergy
    capacity_mw   — Registered/nameplate capacity for that unit, MW
    lat, lon      — Approximate station coordinates (degrees)

Notes:
- Multi-unit stations (Eraring, Bayswater etc.) are one entry per DUID,
  same lat/lon — the map can cluster them visually.
- Battery DUIDs come in pairs (G = generating / discharge, L = load / charge);
  we only include the discharge DUID for simplicity.
- Some recently-built farms may not appear in older Dispatch_SCADA dumps;
  the map simply shows them as "offline" (no MW).
"""
from __future__ import annotations

# fmt: off
GENERATORS: list[dict] = [
    # ============================ NSW1 ===================================
    # — Coal —
    {"duid": "ER01",   "station": "Eraring",          "region": "NSW1", "fuel": "coal_black", "capacity_mw": 720, "lat": -33.06, "lon": 151.51},
    {"duid": "ER02",   "station": "Eraring",          "region": "NSW1", "fuel": "coal_black", "capacity_mw": 720, "lat": -33.06, "lon": 151.51},
    {"duid": "ER03",   "station": "Eraring",          "region": "NSW1", "fuel": "coal_black", "capacity_mw": 720, "lat": -33.06, "lon": 151.51},
    {"duid": "ER04",   "station": "Eraring",          "region": "NSW1", "fuel": "coal_black", "capacity_mw": 720, "lat": -33.06, "lon": 151.51},
    {"duid": "BW01",   "station": "Bayswater",        "region": "NSW1", "fuel": "coal_black", "capacity_mw": 660, "lat": -32.40, "lon": 150.95},
    {"duid": "BW02",   "station": "Bayswater",        "region": "NSW1", "fuel": "coal_black", "capacity_mw": 660, "lat": -32.40, "lon": 150.95},
    {"duid": "BW03",   "station": "Bayswater",        "region": "NSW1", "fuel": "coal_black", "capacity_mw": 660, "lat": -32.40, "lon": 150.95},
    {"duid": "BW04",   "station": "Bayswater",        "region": "NSW1", "fuel": "coal_black", "capacity_mw": 660, "lat": -32.40, "lon": 150.95},
    {"duid": "VP5",    "station": "Vales Point",      "region": "NSW1", "fuel": "coal_black", "capacity_mw": 660, "lat": -33.16, "lon": 151.53},
    {"duid": "VP6",    "station": "Vales Point",      "region": "NSW1", "fuel": "coal_black", "capacity_mw": 660, "lat": -33.16, "lon": 151.53},
    {"duid": "MP1",    "station": "Mt Piper",         "region": "NSW1", "fuel": "coal_black", "capacity_mw": 700, "lat": -33.49, "lon": 150.07},
    {"duid": "MP2",    "station": "Mt Piper",         "region": "NSW1", "fuel": "coal_black", "capacity_mw": 700, "lat": -33.49, "lon": 150.07},
    # — Gas / liquid —
    {"duid": "TALWA1", "station": "Tallawarra",       "region": "NSW1", "fuel": "gas",        "capacity_mw": 440, "lat": -34.52, "lon": 150.85},
    {"duid": "URANQ11","station": "Uranquinty",       "region": "NSW1", "fuel": "gas",        "capacity_mw": 166, "lat": -35.21, "lon": 147.20},
    # — Hydro (Snowy) —
    {"duid": "TUMUT3", "station": "Tumut 3",          "region": "NSW1", "fuel": "hydro",      "capacity_mw": 1800,"lat": -35.81, "lon": 148.21},
    {"duid": "UPPTUMUT","station": "Upper Tumut",     "region": "NSW1", "fuel": "hydro",      "capacity_mw": 616, "lat": -35.79, "lon": 148.34},
    {"duid": "MURRAY", "station": "Murray (1+2)",     "region": "NSW1", "fuel": "hydro",      "capacity_mw": 1500,"lat": -36.32, "lon": 148.13},
    {"duid": "GUTHEGA","station": "Guthega",          "region": "NSW1", "fuel": "hydro",      "capacity_mw": 60,  "lat": -36.39, "lon": 148.40},
    {"duid": "SHGEN",  "station": "Shoalhaven (PHES)","region": "NSW1", "fuel": "hydro",      "capacity_mw": 240, "lat": -34.78, "lon": 150.43},
    # — Wind —
    {"duid": "BANGOWF1","station": "Bango Wind",      "region": "NSW1", "fuel": "wind",       "capacity_mw": 244, "lat": -34.78, "lon": 148.78},
    {"duid": "COLLWF1", "station": "Collector Wind",  "region": "NSW1", "fuel": "wind",       "capacity_mw": 226, "lat": -34.94, "lon": 149.46},
    {"duid": "CRWASF1", "station": "Crudine Ridge",   "region": "NSW1", "fuel": "wind",       "capacity_mw": 138, "lat": -33.06, "lon": 149.43},
    {"duid": "SAPHWF1", "station": "Sapphire Wind",   "region": "NSW1", "fuel": "wind",       "capacity_mw": 270, "lat": -29.79, "lon": 151.39},
    # — Solar —
    {"duid": "LIMOSF11","station": "Limondale 1 SF",  "region": "NSW1", "fuel": "solar",      "capacity_mw": 220, "lat": -34.71, "lon": 143.20},
    {"duid": "SUNRSF1", "station": "Sunraysia SF",    "region": "NSW1", "fuel": "solar",      "capacity_mw": 200, "lat": -34.35, "lon": 142.39},
    {"duid": "DARLSF1", "station": "Darlington Point","region": "NSW1", "fuel": "solar",      "capacity_mw": 275, "lat": -34.57, "lon": 145.97},
    # — Battery —
    # NOTE: RYAN1 added per user request as the default BESS for the NSW deep-dive
    # view. If AEMO doesn't yet publish SCADA for this DUID it will render with
    # nameplate capacity but no live MW; harmless for the demo. Sited near the
    # Hunter Valley as a plausible NSW BESS location.
    {"duid": "RYAN1",   "station": "Ryan BESS",       "region": "NSW1", "fuel": "battery",    "capacity_mw": 100, "lat": -32.55, "lon": 151.50},
    {"duid": "WALGRVG1","station": "Wallgrove BESS",  "region": "NSW1", "fuel": "battery",    "capacity_mw": 50,  "lat": -33.81, "lon": 150.83},
    {"duid": "WGWF1",   "station": "Waratah Super B", "region": "NSW1", "fuel": "battery",    "capacity_mw": 350, "lat": -33.06, "lon": 151.51},

    # ============================ QLD1 ===================================
    # — Coal —
    {"duid": "GSTONE1","station": "Gladstone",        "region": "QLD1", "fuel": "coal_black", "capacity_mw": 280, "lat": -23.84, "lon": 151.25},
    {"duid": "GSTONE2","station": "Gladstone",        "region": "QLD1", "fuel": "coal_black", "capacity_mw": 280, "lat": -23.84, "lon": 151.25},
    {"duid": "GSTONE3","station": "Gladstone",        "region": "QLD1", "fuel": "coal_black", "capacity_mw": 280, "lat": -23.84, "lon": 151.25},
    {"duid": "GSTONE4","station": "Gladstone",        "region": "QLD1", "fuel": "coal_black", "capacity_mw": 280, "lat": -23.84, "lon": 151.25},
    {"duid": "GSTONE5","station": "Gladstone",        "region": "QLD1", "fuel": "coal_black", "capacity_mw": 280, "lat": -23.84, "lon": 151.25},
    {"duid": "GSTONE6","station": "Gladstone",        "region": "QLD1", "fuel": "coal_black", "capacity_mw": 280, "lat": -23.84, "lon": 151.25},
    {"duid": "STAN-1", "station": "Stanwell",         "region": "QLD1", "fuel": "coal_black", "capacity_mw": 365, "lat": -23.50, "lon": 150.33},
    {"duid": "STAN-2", "station": "Stanwell",         "region": "QLD1", "fuel": "coal_black", "capacity_mw": 365, "lat": -23.50, "lon": 150.33},
    {"duid": "STAN-3", "station": "Stanwell",         "region": "QLD1", "fuel": "coal_black", "capacity_mw": 365, "lat": -23.50, "lon": 150.33},
    {"duid": "STAN-4", "station": "Stanwell",         "region": "QLD1", "fuel": "coal_black", "capacity_mw": 365, "lat": -23.50, "lon": 150.33},
    {"duid": "CPP_3",  "station": "Callide C",        "region": "QLD1", "fuel": "coal_black", "capacity_mw": 420, "lat": -24.30, "lon": 150.62},
    {"duid": "CPP_4",  "station": "Callide C",        "region": "QLD1", "fuel": "coal_black", "capacity_mw": 420, "lat": -24.30, "lon": 150.62},
    {"duid": "CALL_B_1","station":"Callide B",        "region": "QLD1", "fuel": "coal_black", "capacity_mw": 350, "lat": -24.30, "lon": 150.62},
    {"duid": "CALL_B_2","station":"Callide B",        "region": "QLD1", "fuel": "coal_black", "capacity_mw": 350, "lat": -24.30, "lon": 150.62},
    {"duid": "KPP_1",  "station": "Kogan Creek",      "region": "QLD1", "fuel": "coal_black", "capacity_mw": 750, "lat": -27.07, "lon": 150.69},
    {"duid": "TARONG#1","station":"Tarong",           "region": "QLD1", "fuel": "coal_black", "capacity_mw": 350, "lat": -26.78, "lon": 151.92},
    {"duid": "TARONG#2","station":"Tarong",           "region": "QLD1", "fuel": "coal_black", "capacity_mw": 350, "lat": -26.78, "lon": 151.92},
    {"duid": "TARONG#3","station":"Tarong",           "region": "QLD1", "fuel": "coal_black", "capacity_mw": 350, "lat": -26.78, "lon": 151.92},
    {"duid": "TARONG#4","station":"Tarong",           "region": "QLD1", "fuel": "coal_black", "capacity_mw": 350, "lat": -26.78, "lon": 151.92},
    {"duid": "TNPS1",  "station": "Tarong North",     "region": "QLD1", "fuel": "coal_black", "capacity_mw": 443, "lat": -26.78, "lon": 151.92},
    {"duid": "MPP_1",  "station": "Millmerran",       "region": "QLD1", "fuel": "coal_black", "capacity_mw": 426, "lat": -27.92, "lon": 151.31},
    {"duid": "MPP_2",  "station": "Millmerran",       "region": "QLD1", "fuel": "coal_black", "capacity_mw": 426, "lat": -27.92, "lon": 151.31},
    # — Gas —
    {"duid": "DDPS1",  "station": "Darling Downs",    "region": "QLD1", "fuel": "gas",        "capacity_mw": 644, "lat": -27.56, "lon": 151.05},
    {"duid": "CONDAM1","station": "Condamine",        "region": "QLD1", "fuel": "gas",        "capacity_mw": 144, "lat": -27.06, "lon": 150.78},
    {"duid": "SWAN_E", "station": "Swanbank E",       "region": "QLD1", "fuel": "gas",        "capacity_mw": 385, "lat": -27.66, "lon": 152.71},
    # — Wind / solar —
    {"duid": "COOPGWF1","station":"Coopers Gap Wind", "region": "QLD1", "fuel": "wind",       "capacity_mw": 453, "lat": -26.49, "lon": 151.34},
    {"duid": "MTEMERWF","station":"Mt Emerald Wind",  "region": "QLD1", "fuel": "wind",       "capacity_mw": 180, "lat": -17.18, "lon": 145.43},
    {"duid": "CLERMSF1","station":"Clermont SF",      "region": "QLD1", "fuel": "solar",      "capacity_mw": 75,  "lat": -22.84, "lon": 147.65},
    {"duid": "DAYDSF1", "station":"Daydream SF",      "region": "QLD1", "fuel": "solar",      "capacity_mw": 150, "lat": -20.43, "lon": 148.13},
    {"duid": "HAYMSF1", "station":"Hayman SF",        "region": "QLD1", "fuel": "solar",      "capacity_mw": 50,  "lat": -20.40, "lon": 148.14},
    # — Battery —
    {"duid": "BLDCBG1", "station":"Bouldercombe BESS","region": "QLD1", "fuel": "battery",    "capacity_mw": 50,  "lat": -23.55, "lon": 150.46},
    {"duid": "WANDBG1", "station":"Wandoan South B",  "region": "QLD1", "fuel": "battery",    "capacity_mw": 100, "lat": -26.13, "lon": 149.96},

    # ============================ VIC1 ===================================
    # — Brown coal —
    {"duid": "LYA1",   "station": "Loy Yang A",       "region": "VIC1", "fuel": "coal_brown", "capacity_mw": 560, "lat": -38.26, "lon": 146.59},
    {"duid": "LYA2",   "station": "Loy Yang A",       "region": "VIC1", "fuel": "coal_brown", "capacity_mw": 560, "lat": -38.26, "lon": 146.59},
    {"duid": "LYA3",   "station": "Loy Yang A",       "region": "VIC1", "fuel": "coal_brown", "capacity_mw": 560, "lat": -38.26, "lon": 146.59},
    {"duid": "LYA4",   "station": "Loy Yang A",       "region": "VIC1", "fuel": "coal_brown", "capacity_mw": 560, "lat": -38.26, "lon": 146.59},
    {"duid": "LOYYB1", "station": "Loy Yang B",       "region": "VIC1", "fuel": "coal_brown", "capacity_mw": 540, "lat": -38.26, "lon": 146.59},
    {"duid": "LOYYB2", "station": "Loy Yang B",       "region": "VIC1", "fuel": "coal_brown", "capacity_mw": 540, "lat": -38.26, "lon": 146.59},
    {"duid": "YWPS1",  "station": "Yallourn",         "region": "VIC1", "fuel": "coal_brown", "capacity_mw": 360, "lat": -38.17, "lon": 146.36},
    {"duid": "YWPS2",  "station": "Yallourn",         "region": "VIC1", "fuel": "coal_brown", "capacity_mw": 360, "lat": -38.17, "lon": 146.36},
    {"duid": "YWPS3",  "station": "Yallourn",         "region": "VIC1", "fuel": "coal_brown", "capacity_mw": 360, "lat": -38.17, "lon": 146.36},
    {"duid": "YWPS4",  "station": "Yallourn",         "region": "VIC1", "fuel": "coal_brown", "capacity_mw": 360, "lat": -38.17, "lon": 146.36},
    # — Gas —
    {"duid": "NPS",    "station": "Newport",          "region": "VIC1", "fuel": "gas",        "capacity_mw": 510, "lat": -37.84, "lon": 144.89},
    {"duid": "MORTLK11","station":"Mortlake",         "region": "VIC1", "fuel": "gas",        "capacity_mw": 283, "lat": -38.08, "lon": 142.81},
    {"duid": "JLA01",  "station": "Jeeralang A",      "region": "VIC1", "fuel": "gas",        "capacity_mw": 51,  "lat": -38.31, "lon": 146.42},
    {"duid": "VPGS1",  "station": "Valley Power",     "region": "VIC1", "fuel": "gas",        "capacity_mw": 50,  "lat": -38.31, "lon": 146.42},
    # — Hydro —
    {"duid": "DARTM1", "station": "Dartmouth",        "region": "VIC1", "fuel": "hydro",      "capacity_mw": 185, "lat": -36.55, "lon": 147.51},
    {"duid": "EILDON1","station": "Eildon",          "region": "VIC1", "fuel": "hydro",      "capacity_mw": 60,  "lat": -37.23, "lon": 145.91},
    {"duid": "MCKAY1", "station": "McKay",            "region": "VIC1", "fuel": "hydro",      "capacity_mw": 150, "lat": -37.06, "lon": 147.30},
    # — Wind —
    {"duid": "MACARTH1","station":"Macarthur Wind",   "region": "VIC1", "fuel": "wind",       "capacity_mw": 420, "lat": -38.04, "lon": 142.04},
    {"duid": "STOCKYDWF1","station":"Stockyard Hill", "region": "VIC1", "fuel": "wind",       "capacity_mw": 530, "lat": -37.61, "lon": 143.27},
    {"duid": "BERWHAWF","station": "Berrybank Wind",  "region": "VIC1", "fuel": "wind",       "capacity_mw": 180, "lat": -37.95, "lon": 143.39},
    {"duid": "OAKLAND1","station": "Oaklands Hill",   "region": "VIC1", "fuel": "wind",       "capacity_mw": 67,  "lat": -37.79, "lon": 142.30},
    # — Solar —
    {"duid": "KIAMSF1","station": "Kiamal SF",        "region": "VIC1", "fuel": "solar",      "capacity_mw": 200, "lat": -34.56, "lon": 142.18},
    {"duid": "BANNSF1","station": "Bannerton SF",     "region": "VIC1", "fuel": "solar",      "capacity_mw": 88,  "lat": -34.74, "lon": 142.86},
    # — Battery —
    {"duid": "VBBG1",  "station": "Victorian Big Bat","region": "VIC1", "fuel": "battery",    "capacity_mw": 300, "lat": -38.07, "lon": 144.36},
    {"duid": "GANNBG1","station": "Gannawarra BESS",  "region": "VIC1", "fuel": "battery",    "capacity_mw": 25,  "lat": -35.61, "lon": 143.79},

    # ============================ SA1 ====================================
    # — Gas —
    {"duid": "TORRA1", "station": "Torrens Island A", "region": "SA1",  "fuel": "gas",        "capacity_mw": 120, "lat": -34.81, "lon": 138.54},
    {"duid": "TORRA2", "station": "Torrens Island A", "region": "SA1",  "fuel": "gas",        "capacity_mw": 120, "lat": -34.81, "lon": 138.54},
    {"duid": "TORRB1", "station": "Torrens Island B", "region": "SA1",  "fuel": "gas",        "capacity_mw": 200, "lat": -34.81, "lon": 138.54},
    {"duid": "TORRB2", "station": "Torrens Island B", "region": "SA1",  "fuel": "gas",        "capacity_mw": 200, "lat": -34.81, "lon": 138.54},
    {"duid": "TORRB3", "station": "Torrens Island B", "region": "SA1",  "fuel": "gas",        "capacity_mw": 200, "lat": -34.81, "lon": 138.54},
    {"duid": "TORRB4", "station": "Torrens Island B", "region": "SA1",  "fuel": "gas",        "capacity_mw": 200, "lat": -34.81, "lon": 138.54},
    {"duid": "PPCCGT", "station": "Pelican Point",    "region": "SA1",  "fuel": "gas",        "capacity_mw": 478, "lat": -34.78, "lon": 138.46},
    {"duid": "OSB-AG", "station": "Osborne",          "region": "SA1",  "fuel": "gas",        "capacity_mw": 180, "lat": -34.79, "lon": 138.50},
    # — Wind —
    {"duid": "HDWF1",  "station": "Hornsdale Wind",   "region": "SA1",  "fuel": "wind",       "capacity_mw": 102, "lat": -33.10, "lon": 138.30},
    {"duid": "HDWF2",  "station": "Hornsdale Wind",   "region": "SA1",  "fuel": "wind",       "capacity_mw": 102, "lat": -33.10, "lon": 138.30},
    {"duid": "HDWF3",  "station": "Hornsdale Wind",   "region": "SA1",  "fuel": "wind",       "capacity_mw": 109, "lat": -33.10, "lon": 138.30},
    {"duid": "SNOWNTH1","station":"Snowtown North",   "region": "SA1",  "fuel": "wind",       "capacity_mw": 144, "lat": -33.78, "lon": 138.21},
    {"duid": "SNOWSTH1","station":"Snowtown South",   "region": "SA1",  "fuel": "wind",       "capacity_mw": 126, "lat": -33.78, "lon": 138.21},
    {"duid": "LKBONNY2","station":"Lake Bonney 2",    "region": "SA1",  "fuel": "wind",       "capacity_mw": 159, "lat": -37.83, "lon": 140.39},
    {"duid": "WPWF",    "station":"Waterloo Wind",    "region": "SA1",  "fuel": "wind",       "capacity_mw": 111, "lat": -33.99, "lon": 138.85},
    # — Solar —
    {"duid": "BNGSF1", "station": "Bungala 1 SF",     "region": "SA1",  "fuel": "solar",      "capacity_mw": 110, "lat": -32.51, "lon": 137.79},
    {"duid": "BNGSF2", "station": "Bungala 2 SF",     "region": "SA1",  "fuel": "solar",      "capacity_mw": 110, "lat": -32.51, "lon": 137.79},
    {"duid": "TB2SF1", "station": "Tailem Bend 1",    "region": "SA1",  "fuel": "solar",      "capacity_mw": 95,  "lat": -35.27, "lon": 139.45},
    # — Battery —
    {"duid": "HPRG1",  "station": "Hornsdale Power Reserve","region":"SA1","fuel":"battery", "capacity_mw":150, "lat": -33.10, "lon": 138.30},
    {"duid": "DALNTHB1","station":"Dalrymple BESS",   "region": "SA1",  "fuel": "battery",    "capacity_mw": 30,  "lat": -34.83, "lon": 137.60},
    {"duid": "LBBG1",  "station": "Lake Bonney BESS", "region": "SA1",  "fuel": "battery",    "capacity_mw": 25,  "lat": -37.83, "lon": 140.39},
    {"duid": "TB2G1",  "station": "Torrens Island B BESS","region":"SA1","fuel":"battery",  "capacity_mw":250, "lat": -34.81, "lon": 138.54},

    # ============================ TAS1 ===================================
    # — Hydro (TAS is overwhelmingly hydro) —
    {"duid": "GORDON", "station": "Gordon",           "region": "TAS1", "fuel": "hydro",      "capacity_mw": 432, "lat": -42.74, "lon": 145.99},
    {"duid": "POAT110","station": "Poatina",          "region": "TAS1", "fuel": "hydro",      "capacity_mw": 300, "lat": -41.79, "lon": 146.92},
    {"duid": "JBUTTERS","station":"John Butters",     "region": "TAS1", "fuel": "hydro",      "capacity_mw": 144, "lat": -42.13, "lon": 145.61},
    {"duid": "LI_WY_CA","station":"Liapootah/Wayatinah","region":"TAS1","fuel": "hydro",      "capacity_mw": 178, "lat": -42.40, "lon": 146.46},
    {"duid": "TUNGATIN","station":"Tungatinah",       "region": "TAS1", "fuel": "hydro",      "capacity_mw": 125, "lat": -42.13, "lon": 146.47},
    {"duid": "MEADOWBK","station":"Meadowbank",       "region": "TAS1", "fuel": "hydro",      "capacity_mw": 40,  "lat": -42.65, "lon": 146.81},
    {"duid": "TREVALLN","station":"Trevallyn",        "region": "TAS1", "fuel": "hydro",      "capacity_mw": 80,  "lat": -41.45, "lon": 147.10},
    # — Wind —
    {"duid": "MUSSELR1","station":"Musselroe Wind",   "region": "TAS1", "fuel": "wind",       "capacity_mw": 168, "lat": -40.91, "lon": 148.04},
    {"duid": "CATHROCK","station":"Cattle Hill Wind", "region": "TAS1", "fuel": "wind",       "capacity_mw": 144, "lat": -42.04, "lon": 147.09},
    {"duid": "WOOLNTH1","station":"Woolnorth Wind",   "region": "TAS1", "fuel": "wind",       "capacity_mw": 140, "lat": -40.66, "lon": 144.71},
    # — Gas (small) —
    {"duid": "TVPP104","station": "Tamar Valley CCGT","region": "TAS1", "fuel": "gas",        "capacity_mw": 208, "lat": -41.16, "lon": 146.94},
]
# fmt: on

# Fast lookup by DUID.
GENERATORS_BY_DUID: dict[str, dict] = {g["duid"]: g for g in GENERATORS}

# Fuel-type colours (Apple system colours + earth tones).
FUEL_COLORS: dict[str, str] = {
    "coal_black": "#1d1d1f",   # deep ink
    "coal_brown": "#8b5a2b",   # brown
    "gas":        "#af52de",   # purple
    "hydro":      "#0a84ff",   # blue
    "wind":       "#34c759",   # green
    "solar":      "#ff9500",   # orange
    "battery":    "#ff2d92",   # pink
    "bioenergy":  "#a85a00",   # amber-brown
}
