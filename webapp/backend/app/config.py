from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BACKEND_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)

DB_PATH = DATA_DIR / "market.duckdb"

NEM_REGIONS = ["NSW1", "QLD1", "VIC1", "SA1", "TAS1"]

NEMWEB_BASE = "https://nemweb.com.au"
NEM_DISPATCHIS_DIR = f"{NEMWEB_BASE}/Reports/Current/DispatchIS_Reports/"
NEM_DISPATCHSCADA_DIR = f"{NEMWEB_BASE}/Reports/Current/Dispatch_SCADA/"
NEM_P5MIN_DIR = f"{NEMWEB_BASE}/Reports/Current/P5_Reports/"
NEM_PREDISPATCHIS_DIR = f"{NEMWEB_BASE}/Reports/Current/PredispatchIS_Reports/"
# BIDDAYOFFER / BIDPEROFFER. AEMO migrated the live day-ahead bid feeds to
# the *_SPARSE variants in 2025 — the legacy Next_Day_Offer_Energy /
# Next_Day_Offer_FCAS dirs and Bidmove_Summary are no longer updated. The
# SPARSE files are deltas-only and ship daily ~05:00; Bidmove_Complete is
# the D+1 full snapshot of every rebid across the trading day.
NEM_NEXT_DAY_OFFER_ENERGY_DIR = f"{NEMWEB_BASE}/Reports/Current/Next_Day_Offer_Energy_SPARSE/"
NEM_NEXT_DAY_OFFER_FCAS_DIR   = f"{NEMWEB_BASE}/Reports/Current/Next_Day_Offer_FCAS_SPARSE/"
NEM_BIDMOVE_COMPLETE_DIR      = f"{NEMWEB_BASE}/Reports/Current/Bidmove_Complete/"

WEMDE_BASE = "https://data.wa.aemo.com.au/public/market-data/wemde"
WEMDE_REFTRADINGPRICE_DIR = f"{WEMDE_BASE}/referenceTradingPrice/current/"

NEM_ST_PASA_DIR = f"{NEMWEB_BASE}/Reports/Current/Short_Term_PASA_Reports/"

# AEMO Rooftop PV — satellite-derived 30-min actual generation per region.
# Published ~20 min after each 30-min interval, covers all NEM regions.
NEM_ROOFTOP_PV_DIR = f"{NEMWEB_BASE}/Reports/CURRENT/ROOFTOP_PV/ACTUAL/"

POLL_INTERVAL_SECONDS = 60
HTTP_TIMEOUT = 30.0
USER_AGENT = "claude-nem-dashboard/0.1 (research)"

# ── NER reliability settings, FY2025-26 (effective 1 July 2025) ─────────────
# AEMC reliability settings: MPC $17,500/MWh · CPT $1,576,800 · APC $600/MWh.
# The Cumulative Price Threshold is compared against the rolling sum of the
# last 2,016 dispatch prices (7 days × 288 five-min intervals) per region;
# once breached, AEMO caps that region's spot price at the APC ($600) until
# the cumulative price falls back below the threshold. Indexed each 1 July —
# update here (or via env) when AEMC publishes the next FY's settings.
CPT_THRESHOLD_AUD = 1_576_800.0
CPT_INTERVALS = 2_016        # 7 days × 288
APC_PRICE_AUD = 600.0

FCAS_COLS = [
    "RAISE6SECRRP", "RAISE60SECRRP", "RAISE5MINRRP", "RAISEREGRRP", "RAISE1SECRRP",
    "LOWER6SECRRP", "LOWER60SECRRP", "LOWER5MINRRP", "LOWERREGRRP", "LOWER1SECRRP",
]
