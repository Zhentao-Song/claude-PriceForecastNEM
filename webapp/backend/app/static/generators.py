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
    {"duid": "TALWB1", "station": "Tallawarra B",     "region": "NSW1", "fuel": "gas",        "capacity_mw": 320, "lat": -34.52, "lon": 150.85},
    {"duid": "URANQ11","station": "Uranquinty",       "region": "NSW1", "fuel": "gas",        "capacity_mw": 166, "lat": -35.21, "lon": 147.20},
    # — Hydro (Snowy) —
    {"duid": "TUMUT3", "station": "Tumut 3",          "region": "NSW1", "fuel": "hydro",      "capacity_mw": 1800,"lat": -35.81, "lon": 148.21},
    {"duid": "UPPTUMUT","station": "Upper Tumut",     "region": "NSW1", "fuel": "hydro",      "capacity_mw": 616, "lat": -35.79, "lon": 148.34},
    {"duid": "MURRAY", "station": "Murray (1+2)",     "region": "NSW1", "fuel": "hydro",      "capacity_mw": 1500,"lat": -36.32, "lon": 148.13},
    {"duid": "GUTHEGA","station": "Guthega",          "region": "NSW1", "fuel": "hydro",      "capacity_mw": 60,  "lat": -36.39, "lon": 148.40},
    {"duid": "SHGEN",  "station": "Shoalhaven (PHES)","region": "NSW1", "fuel": "hydro",      "capacity_mw": 240, "lat": -34.78, "lon": 150.43},
    # — Wind —
    {"duid": "BANGOWF1","station": "Bango Wind",      "region": "NSW1", "fuel": "wind",       "capacity_mw": 244, "lat": -34.78, "lon": 148.78},
    {"duid": "COLWF01", "station": "Collector Wind",  "region": "NSW1", "fuel": "wind",       "capacity_mw": 190, "lat": -34.94, "lon": 149.46},
    {"duid": "CRURWF1", "station": "Crudine Ridge",   "region": "NSW1", "fuel": "wind",       "capacity_mw": 114, "lat": -33.06, "lon": 149.43},
    {"duid": "SAPHWF1", "station": "Sapphire Wind",   "region": "NSW1", "fuel": "wind",       "capacity_mw": 270, "lat": -29.79, "lon": 151.39},
    {"duid": "BODWF1",  "station": "Bodangora Wind",  "region": "NSW1", "fuel": "wind",       "capacity_mw": 113, "lat": -32.88, "lon": 149.09},
    {"duid": "RYEPARK1","station": "Rye Park Wind",   "region": "NSW1", "fuel": "wind",       "capacity_mw": 206, "lat": -34.80, "lon": 149.15},
    {"duid": "WRWF1",   "station": "White Rock Wind", "region": "NSW1", "fuel": "wind",       "capacity_mw": 138, "lat": -30.10, "lon": 151.18},
    {"duid": "CAPTL_WF","station": "Capital Wind",    "region": "NSW1", "fuel": "wind",       "capacity_mw": 119, "lat": -35.38, "lon": 149.25},
    {"duid": "GULLRWF1","station": "Gullen Range WF", "region": "NSW1", "fuel": "wind",       "capacity_mw": 83,  "lat": -34.61, "lon": 149.40},
    {"duid": "GULLRWF2","station": "Gullen Range WF", "region": "NSW1", "fuel": "wind",       "capacity_mw": 82,  "lat": -34.61, "lon": 149.40},
    {"duid": "BOCORWF1","station": "Boco Rock Wind",  "region": "NSW1", "fuel": "wind",       "capacity_mw": 79,  "lat": -36.57, "lon": 148.98},
    # — Solar —
    {"duid": "LIMOSF11","station": "Limondale 1 SF",  "region": "NSW1", "fuel": "solar",      "capacity_mw": 220, "lat": -34.71, "lon": 143.20},
    {"duid": "SUNRSF1", "station": "Sunraysia SF",    "region": "NSW1", "fuel": "solar",      "capacity_mw": 200, "lat": -34.35, "lon": 142.39},
    {"duid": "DARLSF1", "station": "Darlington Point","region": "NSW1", "fuel": "solar",      "capacity_mw": 275, "lat": -34.57, "lon": 145.97},
    {"duid": "NEWENSF1","station": "New England Solar","region":"NSW1", "fuel": "solar",      "capacity_mw": 235, "lat": -30.60, "lon": 151.42},
    {"duid": "NEWENSF2","station": "New England Solar","region":"NSW1", "fuel": "solar",      "capacity_mw": 235, "lat": -30.60, "lon": 151.42},
    {"duid": "GRIFSF1", "station": "Griffith Solar",  "region": "NSW1", "fuel": "solar",      "capacity_mw": 27,  "lat": -34.32, "lon": 145.83},
    {"duid": "BROKENH1","station": "Broken Hill Solar","region":"NSW1", "fuel": "solar",      "capacity_mw": 53,  "lat": -31.96, "lon": 141.45},
    {"duid": "WOLARSF1","station": "Wollar Solar Farm","region":"NSW1", "fuel": "solar",      "capacity_mw": 324, "lat": -32.35, "lon": 149.92},
    {"duid": "CUSF1",   "station": "Coonari SF",       "region": "NSW1", "fuel": "solar",      "capacity_mw": 191, "lat": -30.55, "lon": 149.82},
    {"duid": "AVLSF1",  "station": "Avonlie SF",        "region": "NSW1", "fuel": "solar",      "capacity_mw": 107, "lat": -34.74, "lon": 146.42},
    {"duid": "GNNDHSF1","station": "Gunnedah SF",      "region": "NSW1", "fuel": "solar",      "capacity_mw": 87,  "lat": -30.98, "lon": 150.25},
    # — Battery — (all real AEMO DUIDs, verified against live Dispatch_SCADA)
    {"duid": "WTAHB1",  "station": "Waratah Super Battery","region":"NSW1","fuel": "battery", "capacity_mw": 850, "lat": -33.20, "lon": 151.54},
    {"duid": "ERB01",   "station": "Eraring BESS",     "region": "NSW1", "fuel": "battery",    "capacity_mw": 614, "lat": -33.06, "lon": 151.51},
    {"duid": "ORABESS1","station": "Orana BESS",       "region": "NSW1", "fuel": "battery",    "capacity_mw": 439, "lat": -32.56, "lon": 148.95},
    {"duid": "CAPBES1", "station": "Capital Battery",  "region": "NSW1", "fuel": "battery",    "capacity_mw": 125, "lat": -35.34, "lon": 149.23},
    {"duid": "WALGRV1", "station": "Wallgrove BESS",   "region": "NSW1", "fuel": "battery",    "capacity_mw": 50,  "lat": -33.81, "lon": 150.83},

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
    {"duid": "CPSA",   "station": "Condamine A",      "region": "QLD1", "fuel": "gas",        "capacity_mw": 144, "lat": -27.06, "lon": 150.78},
    {"duid": "SWAN_E", "station": "Swanbank E",       "region": "QLD1", "fuel": "gas",        "capacity_mw": 385, "lat": -27.66, "lon": 152.71},
    {"duid": "YARWUN_1","station": "Yarwun Gas",      "region": "QLD1", "fuel": "gas",        "capacity_mw": 93,  "lat": -23.87, "lon": 151.19},
    # — Wind / solar —
    {"duid": "COOPGWF1","station":"Coopers Gap Wind", "region": "QLD1", "fuel": "wind",       "capacity_mw": 453, "lat": -26.49, "lon": 151.34},
    {"duid": "MEWF1",   "station":"Mt Emerald Wind",  "region": "QLD1", "fuel": "wind",       "capacity_mw": 180, "lat": -17.18, "lon": 145.43},
    {"duid": "DULAWF1", "station":"Dulacca Wind",     "region": "QLD1", "fuel": "wind",       "capacity_mw": 180, "lat": -26.64, "lon": 148.31},
    {"duid": "CLRKCWF1","station":"Clarke Creek Wind","region": "QLD1", "fuel": "wind",       "capacity_mw": 346, "lat": -24.17, "lon": 148.91},
    {"duid": "CLRKCWF2","station":"Clarke Creek Wind","region": "QLD1", "fuel": "wind",       "capacity_mw": 103, "lat": -24.17, "lon": 148.91},
    {"duid": "MCINTYR1","station":"MacIntyre Wind",   "region": "QLD1", "fuel": "wind",       "capacity_mw": 923, "lat": -28.60, "lon": 151.58},
    {"duid": "WAMBOWF1","station":"Wambo Wind",       "region": "QLD1", "fuel": "wind",       "capacity_mw": 201, "lat": -27.72, "lon": 151.13},
    {"duid": "CLERMSF1","station":"Clermont SF",      "region": "QLD1", "fuel": "solar",      "capacity_mw": 75,  "lat": -22.84, "lon": 147.65},
    {"duid": "DAYDSF1", "station":"Daydream SF",      "region": "QLD1", "fuel": "solar",      "capacity_mw": 150, "lat": -20.43, "lon": 148.13},
    {"duid": "HAYMSF1", "station":"Hayman SF",        "region": "QLD1", "fuel": "solar",      "capacity_mw": 50,  "lat": -20.40, "lon": 148.14},
    {"duid": "WDGPH1",  "station":"W. Downs Solar",  "region": "QLD1", "fuel": "solar",      "capacity_mw": 400, "lat": -27.03, "lon": 150.25},
    {"duid": "KSP1",    "station":"Kidston Solar",    "region": "QLD1", "fuel": "solar",      "capacity_mw": 50,  "lat": -18.86, "lon": 144.22},
    {"duid": "RUGBYR1", "station":"Rugby Run Solar",  "region": "QLD1", "fuel": "solar",      "capacity_mw": 83,  "lat": -21.90, "lon": 148.05},
    {"duid": "ALDGASF1","station":"Aldoga Solar",     "region": "QLD1", "fuel": "solar",      "capacity_mw": 233, "lat": -23.84, "lon": 151.24},
    {"duid": "EDENVSF1","station":"Edenvale Solar",   "region": "QLD1", "fuel": "solar",      "capacity_mw": 133, "lat": -25.28, "lon": 152.40},
    {"duid": "MUCRKSF1","station":"Mt Carmel Solar",  "region": "QLD1", "fuel": "solar",      "capacity_mw": 94,  "lat": -22.25, "lon": 149.29},
    {"duid": "DDSF1",   "station":"Darling Downs SF", "region": "QLD1", "fuel": "solar",      "capacity_mw": 94,  "lat": -27.03, "lon": 150.27},
    # — Battery —
    {"duid": "BBATTERY1","station":"Bouldercombe BESS","region":"QLD1", "fuel": "battery",    "capacity_mw": 67,  "lat": -23.55, "lon": 150.46},
    {"duid": "WANDB1",  "station":"Wandoan BESS",     "region": "QLD1", "fuel": "battery",    "capacity_mw": 123, "lat": -26.13, "lon": 149.96},

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
    {"duid": "STOCKYD1", "station":"Stockyard Hill",  "region": "VIC1", "fuel": "wind",       "capacity_mw": 416, "lat": -37.61, "lon": 143.27},
    {"duid": "OAKLAND1","station": "Oaklands Hill",   "region": "VIC1", "fuel": "wind",       "capacity_mw": 67,  "lat": -37.79, "lon": 142.30},
    {"duid": "MUWAWF1", "station":"Murra Warra Wind", "region": "VIC1", "fuel": "wind",       "capacity_mw": 428, "lat": -36.82, "lon": 142.48},
    {"duid": "MOORAWF1","station":"Moorabool Wind",    "region": "VIC1", "fuel": "wind",       "capacity_mw": 266, "lat": -37.66, "lon": 144.05},
    {"duid": "YAMBUKWF","station": "Yambuk Wind",     "region": "VIC1", "fuel": "wind",       "capacity_mw": 30,  "lat": -38.29, "lon": 141.86},
    {"duid": "CHALLHWF","station": "Challicum Hills", "region": "VIC1", "fuel": "wind",       "capacity_mw": 52,  "lat": -37.36, "lon": 143.21},
    {"duid": "BULGANA1","station": "Bulgana Green Power Hub","region":"VIC1","fuel": "wind",  "capacity_mw": 204, "lat": -36.97, "lon": 143.28},
    {"duid": "GPWFEST3","station": "Golden Plains West","region":"VIC1", "fuel": "wind",      "capacity_mw": 232, "lat": -37.82, "lon": 143.70},
    {"duid": "BRYB1WF1","station": "Berrybank 1",     "region": "VIC1", "fuel": "wind",       "capacity_mw": 180, "lat": -37.93, "lon": 143.52},
    {"duid": "BRYB2WF2","station": "Berrybank 2",     "region": "VIC1", "fuel": "wind",       "capacity_mw": 109, "lat": -37.93, "lon": 143.52},
    {"duid": "RYANCWF1","station": "Ryan Corner Wind","region": "VIC1", "fuel": "wind",       "capacity_mw": 148, "lat": -37.72, "lon": 141.73},
    {"duid": "WAUBRAWF","station": "Waubra Wind",     "region": "VIC1", "fuel": "wind",       "capacity_mw": 99,  "lat": -37.38, "lon": 143.58},
    {"duid": "MTGELWF1","station": "Mt Gellibrand",   "region": "VIC1", "fuel": "wind",       "capacity_mw": 98,  "lat": -38.28, "lon": 143.97},
    {"duid": "YENDWF1", "station": "Yendon Wind",     "region": "VIC1", "fuel": "wind",       "capacity_mw": 93,  "lat": -37.68, "lon": 143.93},
    {"duid": "MERCER01","station": "Mt Mercer Wind",  "region": "VIC1", "fuel": "wind",       "capacity_mw": 89,  "lat": -37.92, "lon": 143.96},
    {"duid": "DUNDWF1", "station": "Dundonnell Wind", "region": "VIC1", "fuel": "wind",       "capacity_mw": 82,  "lat": -37.91, "lon": 142.92},
    # — Solar —
    {"duid": "KIAMSF1","station": "Kiamal SF",        "region": "VIC1", "fuel": "solar",      "capacity_mw": 200, "lat": -34.56, "lon": 142.18},
    {"duid": "BANN1",  "station": "Bannerton SF",     "region": "VIC1", "fuel": "solar",      "capacity_mw": 100, "lat": -34.74, "lon": 142.86},
    # — Battery —
    {"duid": "VBB1",   "station": "Victorian Big Battery","region":"VIC1","fuel": "battery",  "capacity_mw": 360, "lat": -38.07, "lon": 144.36},
    {"duid": "GANNB1", "station": "Gannawarra BESS",  "region": "VIC1", "fuel": "battery",    "capacity_mw": 30,  "lat": -35.61, "lon": 143.79},
    {"duid": "BULBES1","station": "Bulgana Battery",  "region": "VIC1", "fuel": "battery",    "capacity_mw": 24,  "lat": -36.97, "lon": 143.28},

    # ============================ SA1 ====================================
    # — Gas —
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
    {"duid": "LGAPWF1", "station":"Lincoln Gap Wind", "region": "SA1",  "fuel": "wind",       "capacity_mw": 126, "lat": -33.55, "lon": 136.00},
    {"duid": "LGAPWF2", "station":"Lincoln Gap Wind", "region": "SA1",  "fuel": "wind",       "capacity_mw": 86,  "lat": -33.55, "lon": 136.00},
    {"duid": "PAREPW1", "station":"Port Augusta REP Wind","region":"SA1","fuel": "wind",      "capacity_mw": 210, "lat": -32.48, "lon": 137.77},
    # — Solar —
    {"duid": "BNGSF1", "station": "Bungala 1 SF",     "region": "SA1",  "fuel": "solar",      "capacity_mw": 110, "lat": -32.51, "lon": 137.79},
    {"duid": "BNGSF2", "station": "Bungala 2 SF",     "region": "SA1",  "fuel": "solar",      "capacity_mw": 110, "lat": -32.51, "lon": 137.79},
    {"duid": "TB2SF1", "station": "Tailem Bend 2",    "region": "SA1",  "fuel": "solar",      "capacity_mw": 95,  "lat": -35.27, "lon": 139.45},
    {"duid": "TBSF1",  "station": "Tailem Bend SF",   "region": "SA1",  "fuel": "solar",      "capacity_mw": 88,  "lat": -35.26, "lon": 139.46},
    {"duid": "PAREPS1","station": "Port Augusta REP Solar","region":"SA1","fuel": "solar",    "capacity_mw": 99,  "lat": -32.48, "lon": 137.77},
    # — Battery —
    {"duid": "HPR1",   "station": "Hornsdale Power Reserve","region":"SA1","fuel":"battery", "capacity_mw":150, "lat": -33.10, "lon": 138.30},
    {"duid": "DALNTH1","station": "Dalrymple North BESS","region":"SA1", "fuel": "battery",   "capacity_mw": 30,  "lat": -34.83, "lon": 137.60},
    {"duid": "LBB1",   "station": "Lake Bonney BESS", "region": "SA1",  "fuel": "battery",    "capacity_mw": 25,  "lat": -37.83, "lon": 140.39},
    {"duid": "TIB1",   "station": "Torrens Island BESS","region":"SA1", "fuel": "battery",    "capacity_mw": 250, "lat": -34.81, "lon": 138.54},

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
    {"duid": "CTHLWF1", "station":"Cattle Hill Wind", "region": "TAS1", "fuel": "wind",       "capacity_mw": 96,  "lat": -42.04, "lon": 147.09},
    {"duid": "WOOLNTH1","station":"Woolnorth Wind",   "region": "TAS1", "fuel": "wind",       "capacity_mw": 140, "lat": -40.66, "lon": 144.71},
    {"duid": "GRANWF1", "station":"Granville Harbour","region": "TAS1", "fuel": "wind",       "capacity_mw": 106, "lat": -41.67, "lon": 145.01},
    # — Gas (small) —
    {"duid": "TVPP104","station": "Tamar Valley CCGT","region": "TAS1", "fuel": "gas",        "capacity_mw": 208, "lat": -41.16, "lon": 146.94},
]
# fmt: on

# Fast lookup by DUID.
GENERATORS_BY_DUID: dict[str, dict] = {g["duid"]: g for g in GENERATORS}

# Fuel-type colours (Apple system colours + earth tones).
FUEL_COLORS: dict[str, str] = {
    "coal_black":    "#1d1d1f",   # deep ink
    "coal_brown":    "#8b5a2b",   # brown
    "gas":           "#af52de",   # purple
    "hydro":         "#0a84ff",   # blue
    "wind":          "#34c759",   # green
    "solar":         "#ff9500",   # orange (utility-scale)
    "rooftop_solar": "#ffcc00",   # golden yellow — behind-the-meter residential/commercial
    "battery":       "#ff2d92",   # pink
    "bioenergy":     "#a85a00",   # amber-brown
}
