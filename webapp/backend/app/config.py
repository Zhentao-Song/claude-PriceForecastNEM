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

POLL_INTERVAL_SECONDS = 60
HTTP_TIMEOUT = 30.0
USER_AGENT = "claude-nem-dashboard/0.1 (research)"

FCAS_COLS = [
    "RAISE6SECRRP", "RAISE60SECRRP", "RAISE5MINRRP", "RAISEREGRRP", "RAISE1SECRRP",
    "LOWER6SECRRP", "LOWER60SECRRP", "LOWER5MINRRP", "LOWERREGRRP", "LOWER1SECRRP",
]
