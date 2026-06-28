"""SQLite store. Chosen over DuckDB because the Alpine+musl base image we
inherit doesn't have prebuilt duckdb wheels. SQLite ships with Python."""
from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager

from .config import DB_PATH

# Per-thread SQLite connections. The previous design shared ONE connection
# behind a global lock, which serialised *reads* behind *writes*: a long writer
# (the bids ingest) would hold the lock and stall every page read. With WAL +
# one connection per thread, readers run lock-free and concurrently with a
# single writer; writers from different threads serialise via SQLite's own
# write lock, and busy_timeout makes them wait politely instead of erroring.
# Crucially no Python-level lock is held across a DB call, so a slow write can
# never block a read.
_local = threading.local()
_DB_FILE = str(DB_PATH).replace(".duckdb", ".sqlite3")
_schema_lock = threading.Lock()
_schema_ready = False


def _configure(conn: sqlite3.Connection) -> None:
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA busy_timeout=30000;")
    conn.execute("PRAGMA foreign_keys=ON;")


def _ensure_schema() -> None:
    global _schema_ready
    if _schema_ready:
        return
    with _schema_lock:
        if _schema_ready:
            return
        conn = sqlite3.connect(_DB_FILE, check_same_thread=False,
                               detect_types=sqlite3.PARSE_DECLTYPES,
                               isolation_level=None)
        _configure(conn)
        _init_schema(conn)
        conn.close()
        _schema_ready = True


def get_conn() -> sqlite3.Connection:
    """A SQLite connection bound to the calling thread (WAL, autocommit)."""
    _ensure_schema()
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = sqlite3.connect(_DB_FILE, check_same_thread=False,
                               detect_types=sqlite3.PARSE_DECLTYPES,
                               isolation_level=None)
        _configure(conn)
        _local.conn = conn
    return conn


def new_connection() -> sqlite3.Connection:
    """A fresh standalone connection (e.g. for a dedicated background writer
    such as the bids ingest), configured like the per-thread ones."""
    conn = sqlite3.connect(_DB_FILE, check_same_thread=False,
                           detect_types=sqlite3.PARSE_DECLTYPES,
                           isolation_level=None)
    _configure(conn)
    return conn


@contextmanager
def locked_conn():
    """READ path: a per-thread connection, lock-free. WAL lets these run
    concurrently with the single writer and with each other. Use for queries;
    writes should go through write_conn() so there is only ever one writer."""
    yield get_conn()


_write_rlock = threading.RLock()
_writer_conn: sqlite3.Connection | None = None


@contextmanager
def write_conn():
    """WRITE path: the ONE serialised writer connection. Every write goes
    through here, so SQLite only ever sees a single writer — no WAL write-lock
    collisions, no busy_timeout stalls, and checkpoints stay clean. Reads
    (locked_conn) are on separate per-thread connections and never block on it.
    RLock allows safe re-entry when one write helper calls another."""
    global _writer_conn
    with _write_rlock:
        if _writer_conn is None:
            _writer_conn = new_connection()
        yield _writer_conn


def _init_schema(con: sqlite3.Connection) -> None:
    con.executescript("""
        CREATE TABLE IF NOT EXISTS nem_dispatch_price (
            settlementdate TIMESTAMP NOT NULL,
            regionid TEXT NOT NULL,
            rrp REAL,
            raise6sec_rrp REAL,
            raise60sec_rrp REAL,
            raise5min_rrp REAL,
            raisereg_rrp REAL,
            raise1sec_rrp REAL,
            lower6sec_rrp REAL,
            lower60sec_rrp REAL,
            lower5min_rrp REAL,
            lowerreg_rrp REAL,
            lower1sec_rrp REAL,
            PRIMARY KEY (settlementdate, regionid)
        );

        CREATE TABLE IF NOT EXISTS nem_region_summary (
            settlementdate TIMESTAMP NOT NULL,
            regionid TEXT NOT NULL,
            totaldemand REAL,
            availablegeneration REAL,
            netinterchange REAL,
            PRIMARY KEY (settlementdate, regionid)
        );

        CREATE TABLE IF NOT EXISTS nem_unit_dispatch (
            settlementdate TIMESTAMP NOT NULL,
            duid TEXT NOT NULL,
            -- Most recent SCADA reading, MW. Positive = generating;
            -- batteries can be negative (charging).
            mw REAL,
            PRIMARY KEY (settlementdate, duid)
        );

        -- AEMO DISPATCHCONSTRAINT: per-interval binding network/security
        -- constraints. We keep only rows with a non-zero marginalvalue
        -- (i.e. *binding* constraints — non-binding ones generate ~300k
        -- rows/day and aren't useful for explaining price spikes).
        CREATE TABLE IF NOT EXISTS nem_dispatch_constraint (
            settlementdate TIMESTAMP NOT NULL,
            constraintid TEXT NOT NULL,
            rhs REAL,
            marginalvalue REAL,            -- shadow price ($/MW); != 0 = binding
            violationdegree REAL,          -- >0 = constraint violated
            PRIMARY KEY (settlementdate, constraintid)
        );

        CREATE INDEX IF NOT EXISTS idx_constraint_time
            ON nem_dispatch_constraint(settlementdate DESC);
        CREATE INDEX IF NOT EXISTS idx_constraint_id_time
            ON nem_dispatch_constraint(constraintid, settlementdate DESC);

        CREATE TABLE IF NOT EXISTS nem_interconnector_flow (
            settlementdate TIMESTAMP NOT NULL,
            interconnectorid TEXT NOT NULL,
            -- Metered MW flow, signed: positive = flow in nominal direction (regionfrom -> regionto).
            metered_mw_flow REAL,
            mw_flow REAL,             -- NEMDE-target flow (cleared)
            mw_losses REAL,
            export_limit REAL,        -- Max in nominal direction
            import_limit REAL,        -- Max against nominal direction
            mnsp REAL,                -- 1 if Market Network Service Provider (Basslink, Murraylink)
            PRIMARY KEY (settlementdate, interconnectorid)
        );

        CREATE TABLE IF NOT EXISTS wem_price (
            interval_start TIMESTAMP PRIMARY KEY,
            reference_trading_price REAL,
            mcap_price REAL
        );

        -- AEMO predispatch forecast prices. Both P5MIN (next ~55 min at 5-min
        -- resolution) and PREDISPATCHIS (next ~24-40 hr at 30-min resolution)
        -- land here; `source` distinguishes them. Each (interval, region,
        -- source) row is replaced when a fresher run_datetime arrives — we
        -- only keep the latest forecast for each target interval per source.
        CREATE TABLE IF NOT EXISTS nem_predispatch_price (
            interval_datetime TIMESTAMP NOT NULL,
            regionid TEXT NOT NULL,
            source TEXT NOT NULL,             -- 'P5MIN' or 'PREDISPATCH'
            run_datetime TIMESTAMP NOT NULL,  -- when AEMO ran the forecast
            rrp REAL,
            total_demand REAL,                -- forecast TOTALDEMAND (MW)
            raise6sec_rrp REAL,
            raise60sec_rrp REAL,
            raise5min_rrp REAL,
            raisereg_rrp REAL,
            raise1sec_rrp REAL,
            lower6sec_rrp REAL,
            lower60sec_rrp REAL,
            lower5min_rrp REAL,
            lowerreg_rrp REAL,
            lower1sec_rrp REAL,
            PRIMARY KEY (interval_datetime, regionid, source)
        );

        CREATE INDEX IF NOT EXISTS idx_predispatch_region_time
            ON nem_predispatch_price(regionid, interval_datetime);
        CREATE INDEX IF NOT EXISTS idx_predispatch_run
            ON nem_predispatch_price(source, run_datetime DESC);

        -- ===== Forecast evaluation (Forecast page) ========================
        -- One row per (target half-hour, region, model) holding that model's
        -- LOCKED day-ahead vintage prediction ($/MWh). Written by the forecast
        -- subsystem (app/forecast): INSERT OR IGNORE so the first vintage seen
        -- (~24h ahead) is frozen and never overwritten — accuracy stays
        -- genuinely out-of-sample. Actuals are joined from nem_dispatch_price
        -- at read time. `model` ∈ {aemo, ours, naive, amber, ...}.
        CREATE TABLE IF NOT EXISTS forecast_eval (
            target_datetime TIMESTAMP NOT NULL,   -- half-hour END, NEM time
            regionid TEXT NOT NULL,
            model TEXT NOT NULL,
            predicted_rrp REAL,
            made_at TIMESTAMP NOT NULL,           -- when this vintage was logged
            PRIMARY KEY (target_datetime, regionid, model)
        );
        CREATE INDEX IF NOT EXISTS idx_forecast_eval_lookup
            ON forecast_eval(regionid, model, target_datetime);

        -- ===== AEMO ST PASA — Short-Term Projected Assessment of System Adequacy
        -- Published hourly on NEMWeb (Short_Term_PASA_Reports). Covers the next
        -- 14 days at 30-min interval resolution. Keyed by (interval, region);
        -- replaced on each fresh run so we always hold the latest published values.
        CREATE TABLE IF NOT EXISTS nem_st_pasa (
            interval_datetime TEXT NOT NULL,     -- NEM time, end of 30-min interval
            regionid          TEXT NOT NULL,
            demand10          REAL,              -- 10th percentile demand forecast (MW)
            demand50          REAL,              -- 50th percentile (median)
            demand90          REAL,              -- 90th percentile
            available_generation REAL,           -- total available generation (MW)
            lrc               REAL,              -- Load Reliability Criteria (MW)
            reservecondition  INTEGER,           -- 0=OK 1=LOR1 2=LOR2 3=LOR3
            run_datetime      TEXT,              -- when AEMO produced this run
            PRIMARY KEY (interval_datetime, regionid)
        );
        CREATE INDEX IF NOT EXISTS idx_st_pasa_region
            ON nem_st_pasa(regionid, interval_datetime);

        -- ===== AEMO BIDDAYOFFER (per NER 3.8.6) ============================
        -- The 10 price bands a participant submits for ONE (DUID, trading day,
        -- bid type) tuple. Prices LOCK at 12:30 day before — they cannot be
        -- changed once the trading day starts. AEMO requires bands monotonically
        -- ascending (NER 3.8.6A.1) and the floor/cap are market-wide ($-1000 /
        -- MPC, currently $17,500 from 2024-25). bidtype is one of:
        --   ENERGY, RAISEREG, RAISE5MIN, RAISE60SEC, RAISE6SEC, RAISE1SEC,
        --   LOWERREG, LOWER5MIN, LOWER60SEC, LOWER6SEC, LOWER1SEC.
        -- direction is GEN/LOAD derived from the BIDTYPE column — for energy
        -- the same DUID can submit both as a separate bid; FCAS is direction
        -- by name (RAISE = up, LOWER = down).
        CREATE TABLE IF NOT EXISTS nem_bidday_offer (
            settlementdate TIMESTAMP NOT NULL,    -- trading day midnight (LOCAL NEM time)
            duid TEXT NOT NULL,
            bidtype TEXT NOT NULL,
            direction TEXT,                       -- GEN / LOAD (NULL for FCAS)
            entrytype TEXT,                       -- FAST / SLOW (start-up classification)
            priceband1 REAL, priceband2 REAL, priceband3 REAL, priceband4 REAL,
            priceband5 REAL, priceband6 REAL, priceband7 REAL, priceband8 REAL,
            priceband9 REAL, priceband10 REAL,
            daily_energy_constraint REAL,         -- daily MWh cap (fuel/water/SoC)
            t1 REAL, t2 REAL, t3 REAL, t4 REAL,   -- FCAS response time parameters
            minimumload REAL,
            submitted_at TIMESTAMP NOT NULL,      -- LASTCHANGED on the day-ahead file
            PRIMARY KEY (settlementdate, duid, bidtype)
        );
        CREATE INDEX IF NOT EXISTS idx_bidday_duid_date
            ON nem_bidday_offer(duid, settlementdate DESC);
        CREATE INDEX IF NOT EXISTS idx_bidday_date_bidtype
            ON nem_bidday_offer(settlementdate, bidtype);

        -- ===== AEMO BIDPEROFFER ==========================================
        -- Per-interval MaxAvail / ramp / band availability. THIS is what
        -- traders rebid all day long up to gate closure (T-5min). Prices are
        -- frozen (BIDDAYOFFER), but the MW you make available at each band
        -- can move every dispatch interval. We key on submitted_at so the
        -- full rebid history is queryable (`ORDER BY submitted_at DESC LIMIT 1`
        -- gives the binding version).
        CREATE TABLE IF NOT EXISTS nem_bidper_offer (
            interval_datetime TIMESTAMP NOT NULL, -- target dispatch interval (NEM time)
            duid TEXT NOT NULL,
            bidtype TEXT NOT NULL,
            -- per-band availability (MW). Indices match the BIDDAYOFFER bands.
            bandavail1 REAL, bandavail2 REAL, bandavail3 REAL, bandavail4 REAL,
            bandavail5 REAL, bandavail6 REAL, bandavail7 REAL, bandavail8 REAL,
            bandavail9 REAL, bandavail10 REAL,
            maxavail REAL,                        -- overall cap (sum of bands or stricter)
            fixedload REAL,                       -- forced MW (e.g. transformer constraints)
            rampuprate REAL,                      -- MW/min
            rampdownrate REAL,                    -- MW/min
            submitted_at TIMESTAMP NOT NULL,      -- LASTCHANGED of this version
            rebid_reason TEXT,                    -- AEMO reason code (WX, SCADA, DEMAND...)
            rebid_explanation TEXT,               -- free-text justification (NER 3.8.22A)
            version INTEGER DEFAULT 1,            -- 1=day-ahead initial, 2+=rebid count
            PRIMARY KEY (interval_datetime, duid, bidtype, submitted_at)
        );
        CREATE INDEX IF NOT EXISTS idx_bidper_interval
            ON nem_bidper_offer(interval_datetime);
        CREATE INDEX IF NOT EXISTS idx_bidper_duid_interval
            ON nem_bidper_offer(duid, interval_datetime, submitted_at DESC);
        CREATE INDEX IF NOT EXISTS idx_bidper_reason
            ON nem_bidper_offer(rebid_reason, interval_datetime DESC);

        -- ===== AEMO Rooftop PV (satellite actual) ===========================
        -- Published ~20 min after each 30-min interval. Each file covers one
        -- 30-min slot with one row per NEM region. Keyed by (interval, region);
        -- upserted so that corrected estimates replace earlier estimates.
        CREATE TABLE IF NOT EXISTS nem_rooftop_pv (
            settlementdate TIMESTAMP NOT NULL,  -- NEM time, end of 30-min interval
            regionid TEXT NOT NULL,
            power_mw REAL,                      -- aggregate rooftop PV output (MW)
            PRIMARY KEY (settlementdate, regionid)
        );
        CREATE INDEX IF NOT EXISTS idx_rooftop_pv_region_time
            ON nem_rooftop_pv(regionid, settlementdate DESC);

        CREATE TABLE IF NOT EXISTS scraper_state (
            source TEXT PRIMARY KEY,
            last_file TEXT,
            last_run TIMESTAMP,
            last_error TEXT
        );

        -- ===== AEMO Market Notices ========================================
        -- LOR warnings, CPT/APC events, interventions, reclassifications.
        -- Rolling window (pruned to ~500 rows by the scraper).
        CREATE TABLE IF NOT EXISTS nem_market_notice (
            notice_id INTEGER PRIMARY KEY,
            notice_type TEXT,
            type_description TEXT,
            creation_date TEXT,      -- 'YYYY-MM-DD HH:MM:SS' NEM time
            external_ref TEXT,
            reason TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_market_notice_created
            ON nem_market_notice(creation_date DESC);

        -- ===== Australian energy-market news (RSS aggregation) ============
        -- Pulled from public RSS feeds (RenewEconomy, pv-magazine, Energy
        -- Magazine, The Driven). Keyed by article URL; pruned to a rolling
        -- window by the scraper. Always links back to the original source.
        CREATE TABLE IF NOT EXISTS nem_news (
            url TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            source TEXT NOT NULL,        -- feed display name
            author TEXT,
            published_at TEXT,           -- ISO8601
            summary TEXT,                -- plain-text excerpt
            image_url TEXT,
            categories TEXT,             -- JSON array of tag strings
            fetched_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_news_published
            ON nem_news(published_at DESC);

        -- ===== AEMO facility registry (MMSDM PARTICIPANT_REGISTRATION) ====
        -- Authoritative per-DUID metadata joined from DUDETAILSUMMARY /
        -- DUDETAIL / DUALLOC / GENUNITS / STATION archive tables. Refreshed
        -- weekly by scrapers/facilities.py. Complements the curated
        -- static/generators.py list (which carries lat/lon for the map).
        CREATE TABLE IF NOT EXISTS nem_facility_registry (
            duid TEXT PRIMARY KEY,
            station TEXT,
            region TEXT NOT NULL,
            fuel TEXT,               -- mapped to our Fuel enum; NULL = unmapped
            capacity_mw REAL,
            dispatch_type TEXT,      -- GENERATOR | LOAD
            schedule_type TEXT,      -- SCHEDULED | SEMI-SCHEDULED | NON-SCHEDULED
            tlf REAL,                -- transmission loss factor (= FY MLF)
            co2e_source TEXT,        -- raw AEMO CO2E_ENERGY_SOURCE string
            emissions_factor REAL,   -- tCO2e/MWh
            source_month TEXT,       -- archive month, e.g. '2026-04'
            updated_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_facility_region
            ON nem_facility_registry(region, fuel);

        -- ===== AEMO Marginal Loss Factors (MLF) ===========================
        -- Per-DUID MLF values from AEMO's annual Loss Factor Report.
        -- Used in NEM settlement: GEN revenue = RRP × MWh × MLF;
        -- LOAD cost = RRP × MWh / MLF; FCAS is unaffected by MLF.
        -- financial_year e.g. '2025-26'. Updated once per year (Feb/Mar).
        CREATE TABLE IF NOT EXISTS nem_mlf (
            duid TEXT NOT NULL,
            financial_year TEXT NOT NULL,
            station_name TEXT,
            region TEXT NOT NULL,
            fuel_type TEXT,      -- 'coal', 'gas', 'hydro', 'wind', 'solar', 'battery'
            capacity_mw REAL,
            mlf REAL NOT NULL,   -- marginal loss factor (1.0 = no losses)
            lat REAL,            -- approximate location for heatmap
            lon REAL,
            PRIMARY KEY (duid, financial_year)
        );
        CREATE INDEX IF NOT EXISTS idx_mlf_region
            ON nem_mlf(region, mlf DESC);
        CREATE INDEX IF NOT EXISTS idx_mlf_fy
            ON nem_mlf(financial_year);

        CREATE INDEX IF NOT EXISTS idx_price_region_time
            ON nem_dispatch_price(regionid, settlementdate DESC);
        CREATE INDEX IF NOT EXISTS idx_price_time
            ON nem_dispatch_price(settlementdate DESC);
        CREATE INDEX IF NOT EXISTS idx_wem_time
            ON wem_price(interval_start DESC);
        CREATE INDEX IF NOT EXISTS idx_ic_time
            ON nem_interconnector_flow(settlementdate DESC);
        CREATE INDEX IF NOT EXISTS idx_ic_id_time
            ON nem_interconnector_flow(interconnectorid, settlementdate DESC);
        CREATE INDEX IF NOT EXISTS idx_unit_time
            ON nem_unit_dispatch(settlementdate DESC);
        CREATE INDEX IF NOT EXISTS idx_unit_duid_time
            ON nem_unit_dispatch(duid, settlementdate DESC);

        -- ----------- Paper trading (simulated bidding) ---------------------
        -- Modelled on AEMO's BIDDAYOFFER / BIDPEROFFER. A single bid is a
        -- collection of up to 10 price bands for one (DUID, market, target
        -- dispatch interval). Settlement is price-taker: when the real RRP
        -- for that interval arrives, we compare each band's price against
        -- the cleared price and dispatch matching MW.
        CREATE TABLE IF NOT EXISTS paper_bid (
            bid_id INTEGER PRIMARY KEY AUTOINCREMENT,
            duid TEXT NOT NULL,
            -- 5-min interval the bid targets; settlement happens when
            -- nem_dispatch_price has a row for this (regionid, time).
            target_settlementdate TIMESTAMP NOT NULL,
            -- 'ENERGY' (signed by direction below) or one of the 10 FCAS
            -- market keys: RAISEREG, RAISE5MIN, RAISE60SEC, RAISE6SEC,
            -- RAISE1SEC, LOWERREG, LOWER5MIN, LOWER60SEC, LOWER6SEC, LOWER1SEC.
            market TEXT NOT NULL,
            -- 'GEN' = sell into the market (discharge / raise availability).
            -- 'LOAD' = buy from the market (charge / lower availability).
            -- For FCAS, GEN ↔ raise, LOAD ↔ lower (redundant w/ market name
            -- but kept for symmetry).
            direction TEXT NOT NULL,
            submitted_at TIMESTAMP NOT NULL,
            -- 'PENDING' awaiting settlement; 'SETTLED' once a fill row exists;
            -- 'CANCELLED' user withdrew before settlement; 'EXPIRED' if the
            -- target interval came and went without a price (shouldn't happen).
            status TEXT NOT NULL DEFAULT 'PENDING',
            -- JSON array, max length 10: [{"price": 50, "mw": 10}, ...]
            -- price in $/MWh, mw is the available capacity at that price.
            bands_json TEXT NOT NULL,
            notes TEXT,
            -- AEMO BIDDAYOFFER allows rebidding: a new offer supersedes an
            -- earlier one for the same (DUID, target, market, direction).
            -- We model this by tagging the new bid with the bid_id it
            -- replaces; the old bid is marked CANCELLED at the same time.
            -- NULL = original (not a rebid).
            previous_bid_id INTEGER REFERENCES paper_bid(bid_id)
        );

        CREATE INDEX IF NOT EXISTS idx_paper_bid_pending
            ON paper_bid(status, target_settlementdate);
        CREATE INDEX IF NOT EXISTS idx_paper_bid_duid_time
            ON paper_bid(duid, target_settlementdate DESC);

        CREATE TABLE IF NOT EXISTS paper_fill (
            fill_id INTEGER PRIMARY KEY AUTOINCREMENT,
            bid_id INTEGER NOT NULL REFERENCES paper_bid(bid_id),
            duid TEXT NOT NULL,
            settlementdate TIMESTAMP NOT NULL,
            market TEXT NOT NULL,
            cleared_price REAL NOT NULL,
            -- Signed: +ve = sold into market (discharge / raise), -ve = bought
            -- from market (charge / lower). For FCAS this is reserved capacity.
            enabled_mw REAL NOT NULL,
            -- enabled_mw * (5/60) for ENERGY; 0 for FCAS (capacity payment).
            energy_mwh REAL NOT NULL,
            -- enabled_mw * cleared_price * (5/60). +ve = earned, -ve = paid.
            revenue_aud REAL NOT NULL,
            created_at TIMESTAMP NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_paper_fill_duid_time
            ON paper_fill(duid, settlementdate DESC);

        CREATE TABLE IF NOT EXISTS paper_bess_state (
            duid TEXT PRIMARY KEY,
            capacity_mwh REAL NOT NULL,        -- e.g. 200 (100 MW × 2h)
            power_mw REAL NOT NULL,            -- e.g. 100
            rte_pct REAL NOT NULL,             -- round-trip efficiency, e.g. 85
            soc_mwh REAL NOT NULL,             -- current state of charge
            cumulative_pnl_aud REAL NOT NULL DEFAULT 0,
            -- Latest interval we've already settled; gate against double-settle.
            last_settled_interval TIMESTAMP,
            updated_at TIMESTAMP NOT NULL,
            -- Marginal Loss Factor. AEMO settles generators at RRP × MLF for
            -- discharge and RRP / MLF for charge (losses borne both ways).
            -- 1.0 = no losses; typical NSW1 transmission BESS sits ~0.96–0.99.
            mlf REAL NOT NULL DEFAULT 1.0
        );

        -- ===== VPP (Virtual Power Plant) — C&I aggregator =================
        -- A VPP is a SINGLE AEMO-registered DUID that fronts a FLEET of
        -- behind-the-meter resources (BESS + EV chargers in our C&I focus).
        -- Trading rules are similar to a scheduled BESS — same 10-band
        -- BIDDAYOFFER mechanics, same gate closure at T-5min, same FCAS
        -- markets — but capability and settlement differ:
        --   1. Available capacity changes minute-to-minute as sites come
        --      online / offline / SoC changes / EVs plug/unplug.
        --   2. Some sub-resources can only do load-side response (EV
        --      chargers can curtail charging but cannot inject — no V2G
        --      assumed).
        --   3. FCAS qualifications differ per technology.

        CREATE TABLE IF NOT EXISTS vpp_portfolio (
            -- Each portfolio is an aggregator account. One paper user can
            -- run multiple portfolios (e.g. NSW vs VIC fleets).
            portfolio_id TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            registered_duid TEXT NOT NULL,            -- The AEMO DRSP/ASP DUID
            region TEXT NOT NULL,                     -- 'NSW1' / 'VIC1' / ...
            cumulative_pnl_aud REAL NOT NULL DEFAULT 0,
            updated_at TIMESTAMP NOT NULL,
            -- Baseline method for DRSP settlement on load-side dispatches.
            -- 'LBL_N10' = average of N=10 prior similar non-event days
            -- 'HIGH_4OF5' = highest 4 of last 5 days (typical PJM convention,
            --   sometimes adapted by AEMO trial frameworks)
            -- 'WEATHER_REG' = regression-adjusted baseline
            baseline_method TEXT NOT NULL DEFAULT 'LBL_N10',
            -- AEMO registration class. Drives which markets the bid form
            -- exposes + which settlement formula applies:
            --   'ARU'        — Aggregated Resource Unit (IESS 2024+),
            --                  fleet treated as one DUID, can do all 11
            --                  markets if resources have the capability.
            --   'SCHEDULED'  — traditional scheduled VPP (≥30 MW), same
            --                  market access as ARU, must follow dispatch.
            --   'DRSP_ONLY'  — DRSP-only (load-side WDR), can only bid
            --                  ENERGY/LOAD via WDR mechanism, NO FCAS.
            classification TEXT NOT NULL DEFAULT 'ARU'
                CHECK (classification IN ('ARU', 'SCHEDULED', 'DRSP_ONLY')),
            -- VPP's revenue share on customer-side demand-charge savings.
            -- C&I customers pay $30-50/kVA/month in network demand charges;
            -- BESS that flattens their peak directly saves them money,
            -- typically split 70/30 customer/VPP via service agreement.
            customer_share_pct REAL NOT NULL DEFAULT 30.0
        );

        -- ----- VPP settlement fills ---------------------------------------
        -- One row per (bid, interval, market) once the cleared RRP is
        -- known. Mirrors paper_fill but with extra columns for the VPP-
        -- specific bookkeeping (which market category, MLF applied).
        CREATE TABLE IF NOT EXISTS vpp_fill (
            fill_id INTEGER PRIMARY KEY AUTOINCREMENT,
            bid_id INTEGER NOT NULL REFERENCES vpp_bid(bid_id),
            portfolio_id TEXT NOT NULL REFERENCES vpp_portfolio(portfolio_id),
            settlementdate TIMESTAMP NOT NULL,
            market TEXT NOT NULL,
            direction TEXT NOT NULL,
            -- Cleared RRP from AEMO. For ENERGY this is the regional RRP
            -- (nem_dispatch_price.rrp); for FCAS this is the relevant
            -- *_RRP column in the same table.
            cleared_price REAL NOT NULL,
            -- enabled_mw is signed by direction: +ve for GEN/RAISE,
            -- -ve for LOAD/LOWER. For FCAS the sign convention is the
            -- same as the market name implies.
            enabled_mw REAL NOT NULL,
            -- For ENERGY: enabled_mw × 5/60 (signed). For FCAS: 0
            -- because FCAS is paid for capacity availability, not energy.
            energy_mwh REAL NOT NULL,
            -- Settlement revenue in AUD, signed: +ve = earned, -ve = paid.
            -- ENERGY GEN: + enabled_mw × RRP × 5/60 × MLF
            -- ENERGY LOAD: − enabled_mw × RRP × 5/60 ÷ MLF
            -- FCAS: enabled_mw × FCAS_RRP × 5/60   (no MLF, capacity-paid)
            revenue_aud REAL NOT NULL,
            -- MLF used in the calculation (averaged across allocated
            -- resources). 1.0 for FCAS since FCAS is not loss-adjusted.
            mlf_applied REAL NOT NULL DEFAULT 1.0,
            created_at TIMESTAMP NOT NULL,
            UNIQUE (bid_id, settlementdate, market)
        );
        CREATE INDEX IF NOT EXISTS idx_vpp_fill_portfolio_time
            ON vpp_fill(portfolio_id, settlementdate DESC);
        CREATE INDEX IF NOT EXISTS idx_vpp_fill_market
            ON vpp_fill(market, settlementdate DESC);

        -- Per-resource breakdown of every fill — the audit trail real
        -- platforms expose to customers ("site X earned $Y from event Z").
        -- We also use this table at envelope-computation time to derive
        -- each resource's daily event count + remaining duration budget.
        CREATE TABLE IF NOT EXISTS vpp_fill_alloc (
            fill_alloc_id INTEGER PRIMARY KEY AUTOINCREMENT,
            fill_id INTEGER NOT NULL REFERENCES vpp_fill(fill_id),
            portfolio_id TEXT NOT NULL,
            resource_id TEXT NOT NULL,
            settlementdate TIMESTAMP NOT NULL,
            market TEXT NOT NULL,
            direction TEXT NOT NULL,
            -- The slice of the fill's enabled_mw allocated to this resource.
            -- Signed same as parent fill (GEN/RAISE +ve, LOAD/LOWER -ve).
            alloc_mw REAL NOT NULL,
            -- Energy in MWh delivered/absorbed by this resource over the
            -- 5-min interval. 0 for FCAS (capacity-only payment).
            alloc_mwh REAL NOT NULL,
            -- Revenue allocated to this resource (proportional to alloc_mw).
            revenue_aud REAL NOT NULL,
            -- For BESS: actual change in SoC after applying the appropriate
            -- charge/discharge efficiency. 0 for EV chargers (no SoC).
            soc_delta_kwh REAL NOT NULL DEFAULT 0,
            created_at TIMESTAMP NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_fill_alloc_resource_time
            ON vpp_fill_alloc(resource_id, settlementdate DESC);
        CREATE INDEX IF NOT EXISTS idx_fill_alloc_portfolio_time
            ON vpp_fill_alloc(portfolio_id, settlementdate DESC);

        CREATE TABLE IF NOT EXISTS vpp_resource (
            -- Sub-resource of a portfolio (one BESS site or one EV charger
            -- group, typically at a single C&I site).
            resource_id TEXT PRIMARY KEY,
            portfolio_id TEXT NOT NULL REFERENCES vpp_portfolio(portfolio_id),
            -- 'bess' = behind-the-meter battery; 'evcharger' = AC/DC EV
            -- charger group at the same connection point. We deliberately
            -- keep 'evcharger' as a group, not per-plug, so the
            -- aggregator can swap individual chargers in/out without
            -- changing the bid template.
            kind TEXT NOT NULL CHECK (kind IN ('bess', 'evcharger')),
            site_name TEXT NOT NULL,
            -- Coordinates for the optional map view (degrees).
            lat REAL, lon REAL,

            -- Nameplate capability (positive = "max towards grid").
            nameplate_kw REAL NOT NULL,
            -- BESS: usable kWh; EV: irrelevant (set to 0).
            capacity_kwh REAL NOT NULL DEFAULT 0,
            -- BESS: round-trip efficiency 0..1; EV: 1.0 (charging losses
            -- borne by vehicle, not the aggregator).
            rte_pct REAL NOT NULL DEFAULT 0.92,

            -- LIVE telemetry — refreshed by background poll / sim. Used to
            -- compute "available now" for the bid stack envelope.
            -- BESS: SoC in kWh; EV: 0 (no SoC at aggregator level).
            soc_kwh REAL NOT NULL DEFAULT 0,
            -- Fraction of nameplate physically online right now (0..1).
            -- e.g. EV charger group with 8 of 10 plugs occupied → 0.8.
            availability_now REAL NOT NULL DEFAULT 1.0,

            -- AVAILABILITY WINDOW (NEM-time hour 0..23). Outside this
            -- window the resource is excluded from bid envelope. EV
            -- chargers at an office: 8-18 typically. BESS: always on
            -- (0-24). Encoded as inclusive start, EXCLUSIVE end.
            window_start_hr INTEGER NOT NULL DEFAULT 0,
            window_end_hr INTEGER NOT NULL DEFAULT 24,

            -- Capability flags — what markets this resource can bid into.
            -- BESS: typically can_inject + can_curtail + most FCAS.
            -- EV charger: can_curtail + RAISE FCAS only (stop charging
            -- is a quick load drop = effectively raising frequency).
            can_inject INTEGER NOT NULL DEFAULT 0,           -- discharge into grid
            can_curtail INTEGER NOT NULL DEFAULT 1,          -- reduce load
            can_raise_fcas INTEGER NOT NULL DEFAULT 1,       -- contingency raise
            can_lower_fcas INTEGER NOT NULL DEFAULT 0,       -- contingency lower
            can_reg_fcas INTEGER NOT NULL DEFAULT 0,         -- regulation (4s SCADA-like)

            -- Operational limits. C&I customers tolerate limited disruption.
            max_events_per_day INTEGER NOT NULL DEFAULT 4,
            max_duration_min INTEGER NOT NULL DEFAULT 30,
            recovery_min INTEGER NOT NULL DEFAULT 15,        -- cool-down after event

            -- Per-resource MLF (connection point dependent).
            mlf REAL NOT NULL DEFAULT 1.0,

            -- AEMO dispatch classification at the connection-point level.
            -- A portfolio's `classification` (ARU/SCHEDULED/DRSP_ONLY) is
            -- the *registration* class; this column is the *physical*
            -- class AEMO recognises per asset:
            --   'scheduled'      — follows NEMDE dispatch instructions in
            --                      real time, full ENERGY + FCAS access.
            --                      Typically ≥30 MW or operator-elected.
            --   'semi_scheduled' — wind/solar style — gives availability
            --                      forecasts but is curtailable by AEMO.
            --                      For BESS this maps to scheduled-equivalent
            --                      most of the time.
            --   'non_scheduled'  — BTM resource; not dispatched by NEMDE.
            --                      Can still earn money via:
            --                       (a) embedded generation passive RRP
            --                           (NER 2.2.5) if it can_inject AND
            --                           retail_plan = wholesale_passthrough
            --                       (b) WDR load curtailment (NER 3.8.2A)
            --                       (c) customer-side TOU optimisation
            --                      NO FCAS access (would require scheduled
            --                      registration of the asset/aggregator).
            dispatch_type TEXT NOT NULL DEFAULT 'non_scheduled'
                CHECK (dispatch_type IN ('scheduled', 'semi_scheduled', 'non_scheduled')),

            -- Retail contract the C&I customer holds for this site.
            -- Drives whether non_scheduled resources can earn wholesale
            -- spot revenue via embedded generation:
            --   'wholesale_passthrough' — Flow Power / Amber style.
            --                              Customer pays/receives RRP
            --                              ± markup. BESS export earns
            --                              RRP × MWh × MLF (embedded gen).
            --                              ★ DEFAULT for new sites.
            --   'standard_TOU'          — fixed peak/shoulder/off-peak
            --                              tariffs. BESS export only
            --                              earns the FiT (typically 4-8
            --                              c/kWh), not spot.
            --   'FiT_only'              — solar feed-in style; charges
            --                              cannot be passed through to RRP.
            retail_plan TEXT NOT NULL DEFAULT 'wholesale_passthrough'
                CHECK (retail_plan IN ('wholesale_passthrough', 'standard_TOU', 'FiT_only')),

            -- User opt-in flag — when 0, this resource is excluded from all
            -- bid envelopes even if otherwise capable.
            opted_in INTEGER NOT NULL DEFAULT 1,

            created_at TIMESTAMP NOT NULL,
            updated_at TIMESTAMP NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_vpp_resource_portfolio
            ON vpp_resource(portfolio_id);

        CREATE TABLE IF NOT EXISTS vpp_bid (
            bid_id INTEGER PRIMARY KEY AUTOINCREMENT,
            portfolio_id TEXT NOT NULL REFERENCES vpp_portfolio(portfolio_id),
            target_settlementdate TIMESTAMP NOT NULL,
            -- Same market enum as paper_bid:
            -- ENERGY / RAISEREG / RAISE5MIN / RAISE60SEC / RAISE6SEC /
            -- RAISE1SEC / LOWERREG / LOWER5MIN / LOWER60SEC / LOWER6SEC /
            -- LOWER1SEC.
            market TEXT NOT NULL,
            -- 'GEN' or 'LOAD'. For VPP:
            --   GEN  = inject (only BESS w/ can_inject)
            --   LOAD = curtail load (BESS charge reduction OR EV stop)
            direction TEXT NOT NULL,
            submitted_at TIMESTAMP NOT NULL,
            status TEXT NOT NULL DEFAULT 'PENDING',
            -- 10-band ladder, same shape as paper_bid.
            bands_json TEXT NOT NULL,
            -- JSON array of {resource_id, alloc_kw} — the aggregator's
            -- internal allocation of how the bid envelope is sourced from
            -- sub-resources. Recorded at submit time so we can audit which
            -- sites were committed for this bid.
            allocation_json TEXT NOT NULL DEFAULT '[]',
            notes TEXT,
            rebid_reason TEXT,
            previous_bid_id INTEGER REFERENCES vpp_bid(bid_id),

            -- ===== Full AEMO BIDPEROFFER + BIDDAYOFFER parity ============
            -- MaxAvail (MW). Independent hard cap on total dispatch for
            -- this interval — NEMDE will not enable more MW than this
            -- regardless of how many bands clear. If NULL we assume
            -- max_avail = sum(bands.mw). Real participants typically set
            -- max_avail < sum(bands) when they're price-indifferent (e.g.
            -- a fast-start unit bids 100 MW at each of 3 prices with
            -- max_avail=100 to say "I have 100 MW, you choose the price").
            max_avail_mw REAL,

            -- DailyEnergyConstraint (MWh per trading day). BESS-critical:
            -- caps the total MWh exported (GEN) or imported (LOAD) for
            -- this DUID across ALL intervals of the trading day. AEMO
            -- enforces this in NEMDE's day-ahead optimisation.
            daily_energy_constraint_mwh REAL,

            -- Ramp rates (MW/min). NEMDE uses these to bound the change
            -- in dispatch between consecutive intervals; a BESS switching
            -- from full charge to full discharge in 5min needs rampdown
            -- + rampup to cover the swing. Required field on real
            -- BIDPEROFFER.
            ramp_up_mw_per_min REAL,
            ramp_down_mw_per_min REAL,

            -- ----- FCAS trapezium parameters (NULL unless FCAS) --------
            -- AEMO co-optimises ENERGY and FCAS using a trapezium that
            -- defines how much FCAS the unit can deliver at each ENERGY
            -- dispatch level. Trapezium shape (sweeping ENERGY left to
            -- right): from enablement_min, FCAS-MW ramps up linearly to
            -- max_avail at low_breakpoint, holds flat until high_breakpoint,
            -- then ramps back down to 0 at enablement_max.
            -- Required for FCAS bids; without it NEMDE treats the bid as
            -- "available at any ENERGY level" which over-promises capacity.
            -- T1..T4 are the response-time profile (seconds): delay,
            -- ramp-up, hold, release. Sum must fit the market's required
            -- response window (6s, 60s, 5min for the eponymous markets).
            t1_sec REAL,
            t2_sec REAL,
            t3_sec REAL,
            t4_sec REAL,
            enablement_min_mw REAL,
            enablement_max_mw REAL,
            low_breakpoint_mw REAL,
            high_breakpoint_mw REAL,

            -- Marks bids submitted as part of a trading-day batch (one
            -- BIDDAYOFFER-style submission that fans out across N open
            -- 5-min intervals of the trading day). NULL = standalone
            -- per-interval bid. Same batch_id = same price ladder +
            -- params, different target_settlementdate.
            trading_day_batch_id INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_vpp_bid_pending
            ON vpp_bid(status, target_settlementdate);
        CREATE INDEX IF NOT EXISTS idx_vpp_bid_portfolio_time
            ON vpp_bid(portfolio_id, target_settlementdate DESC);
    """)
    # ---- Idempotent column adds for older DBs ---------------------------
    # SQLite lacks "ADD COLUMN IF NOT EXISTS"; the try/except keeps fresh
    # installs and upgrades on the same path.
    for col, ddl in (
        ("total_demand", "ALTER TABLE nem_predispatch_price ADD COLUMN total_demand REAL"),
        ("mlf", "ALTER TABLE paper_bess_state ADD COLUMN mlf REAL NOT NULL DEFAULT 1.0"),
        ("previous_bid_id", "ALTER TABLE paper_bid ADD COLUMN previous_bid_id INTEGER REFERENCES paper_bid(bid_id)"),
        # Pre-existing portfolios get the default 'ARU' classification + 30%
        # customer-share. SQLite's ALTER TABLE drops the CHECK constraint
        # text from the new column, but the route layer re-validates the
        # value at write time, so this is functionally identical.
        ("classification", "ALTER TABLE vpp_portfolio ADD COLUMN classification TEXT NOT NULL DEFAULT 'ARU'"),
        ("customer_share_pct", "ALTER TABLE vpp_portfolio ADD COLUMN customer_share_pct REAL NOT NULL DEFAULT 30.0"),
        # Per-resource dispatch + retail-plan tagging. Older VPP DBs (pre
        # this change) get the safe defaults: dispatch_type='non_scheduled'
        # (the conservative assumption — BTM unless flipped) and
        # retail_plan='wholesale_passthrough' (the user requirement that
        # every site defaults to spot-passthrough so embedded-generation
        # arbitrage is on by default).
        ("dispatch_type",   "ALTER TABLE vpp_resource ADD COLUMN dispatch_type TEXT NOT NULL DEFAULT 'non_scheduled'"),
        ("retail_plan",     "ALTER TABLE vpp_resource ADD COLUMN retail_plan TEXT NOT NULL DEFAULT 'wholesale_passthrough'"),
        # AEMO BIDPEROFFER + BIDDAYOFFER parity columns. All nullable —
        # legacy bids without these submitted before this change get
        # NULL and the settlement falls back to "no cap / no ramp".
        ("max_avail_mw",                "ALTER TABLE vpp_bid ADD COLUMN max_avail_mw REAL"),
        ("daily_energy_constraint_mwh", "ALTER TABLE vpp_bid ADD COLUMN daily_energy_constraint_mwh REAL"),
        ("ramp_up_mw_per_min",          "ALTER TABLE vpp_bid ADD COLUMN ramp_up_mw_per_min REAL"),
        ("ramp_down_mw_per_min",        "ALTER TABLE vpp_bid ADD COLUMN ramp_down_mw_per_min REAL"),
        ("t1_sec",                       "ALTER TABLE vpp_bid ADD COLUMN t1_sec REAL"),
        ("t2_sec",                       "ALTER TABLE vpp_bid ADD COLUMN t2_sec REAL"),
        ("t3_sec",                       "ALTER TABLE vpp_bid ADD COLUMN t3_sec REAL"),
        ("t4_sec",                       "ALTER TABLE vpp_bid ADD COLUMN t4_sec REAL"),
        ("enablement_min_mw",           "ALTER TABLE vpp_bid ADD COLUMN enablement_min_mw REAL"),
        ("enablement_max_mw",           "ALTER TABLE vpp_bid ADD COLUMN enablement_max_mw REAL"),
        ("low_breakpoint_mw",           "ALTER TABLE vpp_bid ADD COLUMN low_breakpoint_mw REAL"),
        ("high_breakpoint_mw",          "ALTER TABLE vpp_bid ADD COLUMN high_breakpoint_mw REAL"),
        ("trading_day_batch_id",        "ALTER TABLE vpp_bid ADD COLUMN trading_day_batch_id INTEGER"),
        # FCAS co-optimisation trapezium stored as JSON on paper_bid rows
        # submitted via the FCAS bid panel. NULL for ENERGY bids and legacy
        # FCAS bids submitted before this column existed.
        ("fcas_trapezium_json",         "ALTER TABLE paper_bid ADD COLUMN fcas_trapezium_json TEXT"),
    ):
        try:
            con.execute(ddl)
        except sqlite3.OperationalError as e:
            if "duplicate column" not in str(e).lower():
                raise

    # ── nem_bidday_offer: include DIRECTION in the primary key ───────────
    # Same IESS problem as bidper below: PK (settlementdate, duid, bidtype)
    # made a battery's ENERGY sell (GEN) and buy (LOAD) price ladders
    # overwrite each other — last file processed won. Rebuild with
    # direction in the PK; rows repopulate from the next Next_Day_Offer /
    # BIDMOVE files (14-day rolling window self-heals within a day).
    bidday_sql_row = con.execute(
        "SELECT sql FROM sqlite_master WHERE name='nem_bidday_offer'"
    ).fetchone()
    if bidday_sql_row and "bidtype, direction" not in bidday_sql_row[0]:
        con.executescript(
            """
            ALTER TABLE nem_bidday_offer RENAME TO nem_bidday_offer_old;
            CREATE TABLE nem_bidday_offer (
                settlementdate TIMESTAMP NOT NULL,
                duid TEXT NOT NULL,
                bidtype TEXT NOT NULL,
                direction TEXT,              -- GEN | LOAD | NULL (legacy)
                entrytype TEXT,
                priceband1 REAL, priceband2 REAL, priceband3 REAL,
                priceband4 REAL, priceband5 REAL, priceband6 REAL,
                priceband7 REAL, priceband8 REAL, priceband9 REAL,
                priceband10 REAL,
                daily_energy_constraint REAL,
                t1 REAL, t2 REAL, t3 REAL, t4 REAL,
                minimumload REAL,
                submitted_at TIMESTAMP,
                PRIMARY KEY (settlementdate, duid, bidtype, direction)
            );
            INSERT INTO nem_bidday_offer
            SELECT settlementdate, duid, bidtype, direction, entrytype,
                   priceband1, priceband2, priceband3, priceband4, priceband5,
                   priceband6, priceband7, priceband8, priceband9, priceband10,
                   daily_energy_constraint, t1, t2, t3, t4, minimumload,
                   submitted_at
            FROM nem_bidday_offer_old;
            DROP TABLE nem_bidday_offer_old;
            CREATE INDEX IF NOT EXISTS idx_bidday_duid_time
                ON nem_bidday_offer(duid, settlementdate DESC);
            """
        )

    # ── nem_bidper_offer: add DIRECTION to schema + primary key ──────────
    # IESS bidirectional units (batteries) submit separate GEN (sell/
    # discharge) and LOAD (buy/charge) ENERGY availabilities. The original
    # table had no direction column AND its PK (interval, duid, bidtype,
    # submitted_at) made the two directions collide — INSERT OR IGNORE
    # silently dropped one side. SQLite can't alter a PK, so rebuild once:
    # legacy rows keep direction=NULL (direction unknown; readers treat
    # NULL as wildcard) and age out of the 14-day window naturally.
    cols = [r[1] for r in con.execute("PRAGMA table_info(nem_bidper_offer)").fetchall()]
    if cols and "direction" not in cols:
        con.executescript(
            """
            ALTER TABLE nem_bidper_offer RENAME TO nem_bidper_offer_old;
            CREATE TABLE nem_bidper_offer (
                interval_datetime TIMESTAMP NOT NULL,
                duid TEXT NOT NULL,
                bidtype TEXT NOT NULL,
                direction TEXT,              -- GEN | LOAD | NULL (pre-migration)
                bandavail1 REAL, bandavail2 REAL, bandavail3 REAL,
                bandavail4 REAL, bandavail5 REAL, bandavail6 REAL,
                bandavail7 REAL, bandavail8 REAL, bandavail9 REAL,
                bandavail10 REAL,
                maxavail REAL, fixedload REAL,
                rampuprate REAL, rampdownrate REAL,
                submitted_at TIMESTAMP,
                rebid_reason TEXT, rebid_explanation TEXT,
                version INTEGER DEFAULT 1,
                PRIMARY KEY (interval_datetime, duid, bidtype, direction, submitted_at)
            );
            INSERT INTO nem_bidper_offer
                (interval_datetime, duid, bidtype, direction,
                 bandavail1, bandavail2, bandavail3, bandavail4, bandavail5,
                 bandavail6, bandavail7, bandavail8, bandavail9, bandavail10,
                 maxavail, fixedload, rampuprate, rampdownrate,
                 submitted_at, rebid_reason, rebid_explanation, version)
            SELECT interval_datetime, duid, bidtype, NULL,
                   bandavail1, bandavail2, bandavail3, bandavail4, bandavail5,
                   bandavail6, bandavail7, bandavail8, bandavail9, bandavail10,
                   maxavail, fixedload, rampuprate, rampdownrate,
                   submitted_at, rebid_reason, rebid_explanation, version
            FROM nem_bidper_offer_old;
            DROP TABLE nem_bidper_offer_old;
            CREATE INDEX IF NOT EXISTS idx_bidper_duid_time
                ON nem_bidper_offer(duid, interval_datetime DESC);
            """
        )

    # ── Migrate the legacy fictional RYAN1 paper account → WTAHB1 ─────────
    # WTAHB1 is the real Waratah Super Battery DUID (850 MW / 1,680 MWh,
    # FY25-26 MLF 0.9923). Idempotent: after the first boot the WHERE
    # clause matches nothing. Trading history carries over unchanged.
    for tbl in ("paper_bid", "paper_fill"):
        try:
            con.execute(f"UPDATE {tbl} SET duid='WTAHB1' WHERE duid='RYAN1'")
        except sqlite3.OperationalError:
            pass
    con.execute(
        """
        UPDATE OR IGNORE paper_bess_state
        SET duid='WTAHB1', capacity_mwh=1680.0, power_mw=850.0, mlf=0.9923
        WHERE duid='RYAN1'
        """
    )

    # Seed the WTAHB1 paper account (real Waratah Super Battery specs:
    # 850 MW × ~2h, start 50% SoC, 88% RTE, FY25-26 MLF 0.9923).
    # Timestamp written in NEM time (UTC+10) so it matches dispatch rows.
    from datetime import datetime, timedelta
    nem_now = (datetime.utcnow() + timedelta(hours=10)).strftime("%Y-%m-%d %H:%M:%S")
    con.execute(
        """
        INSERT OR IGNORE INTO paper_bess_state
            (duid, capacity_mwh, power_mw, rte_pct, soc_mwh,
             cumulative_pnl_aud, last_settled_interval, updated_at, mlf)
        VALUES ('WTAHB1', 1680.0, 850.0, 88.0, 840.0, 0.0, NULL, ?, 0.9923)
        """,
        (nem_now,),
    )

    # Seed a C&I VPP portfolio + 3 BESS sites + 5 EV charger groups in
    # NSW1. Sites are realistic for a Sydney-area commercial aggregator —
    # mid-size BESS at warehouses + EV charging hubs at office parks /
    # shopping centres / fleet depots. Capacity sums to ~7.5 MW which is
    # typical for an early-stage C&I VPP entering AEMO's WDR mechanism.
    con.execute(
        """
        INSERT OR IGNORE INTO vpp_portfolio
            (portfolio_id, display_name, registered_duid, region,
             cumulative_pnl_aud, updated_at, baseline_method)
        VALUES ('NSW_CI_VPP', 'NSW C&I VPP · demo', 'VPPNSW1', 'NSW1',
                0.0, ?, 'LBL_N10')
        """,
        (nem_now,),
    )

    # (resource_id, kind, site_name, lat, lon,
    #  nameplate_kw, capacity_kwh, rte_pct, soc_kwh, availability_now,
    #  window_start, window_end,
    #  can_inject, can_curtail, can_raise, can_lower, can_reg,
    #  max_events_per_day, max_duration_min, recovery_min, mlf,
    #  dispatch_type, retail_plan)
    #
    # Classification rationale (per user direction):
    #   - Lidcombe DC (1500 kW) is large enough to register scheduled and
    #     get full ENERGY + FCAS access — modelled as 'scheduled'.
    #   - Macquarie Park HQ (800 kW) sits at the typical scheduled/non
    #     border; we register it as scheduled to demo the dual-channel
    #     setup (some big BESS in scheduled, others not).
    #   - Port Botany cold-store (500 kW) stays 'non_scheduled' — runs
    #     embedded generation against RRP via wholesale_passthrough.
    #   - All EV chargers are 'non_scheduled' — they only do WDR / customer
    #     TOU; can_inject=0 so the embedded-gen path doesn't apply.
    #
    # Every site gets retail_plan='wholesale_passthrough' per user instruction:
    # "默认资源都是做wholesale-passthrough 零售合同的".
    vpp_seed = [
        # ----- BESS sites ----------------------------------------------
        ('VPP_BESS_LIDC1', 'bess',  'Lidcombe DC battery',     -33.860, 151.045,
         1500, 3000, 0.92,  1500, 1.0,  0, 24,
         1, 1, 1, 1, 1,
         12, 60, 5, 0.985,
         'scheduled', 'wholesale_passthrough'),
        ('VPP_BESS_MAC1',  'bess',  'Macquarie Park HQ BESS',  -33.776, 151.118,
         800, 1600, 0.91,   650, 1.0,  0, 24,
         1, 1, 1, 1, 0,
         10, 60, 10, 0.982,
         'scheduled', 'wholesale_passthrough'),
        ('VPP_BESS_PORTB', 'bess',  'Port Botany cold-store',  -33.974, 151.221,
         500, 750,  0.90,   320, 1.0,  0, 24,
         1, 1, 1, 0, 0,
         8, 45, 10, 0.978,
         'non_scheduled', 'wholesale_passthrough'),
        # ----- EV charger groups ---------------------------------------
        ('VPP_EVC_OLY1',   'evcharger', 'Olympic Park EV hub',     -33.846, 151.069,
         1200, 0, 1.00,  0, 0.7,  6, 22,
         0, 1, 1, 0, 0,
         6, 30, 15, 0.992,
         'non_scheduled', 'wholesale_passthrough'),
        ('VPP_EVC_RHO1',   'evcharger', 'Rhodes office park EVs',  -33.831, 151.090,
         600, 0, 1.00,  0, 0.85, 7, 19,
         0, 1, 1, 0, 0,
         6, 30, 15, 0.991,
         'non_scheduled', 'wholesale_passthrough'),
        ('VPP_EVC_PARR1',  'evcharger', 'Parramatta mall chargers', -33.815, 151.000,
         900, 0, 1.00,  0, 0.6,  6, 23,
         0, 1, 1, 0, 0,
         4, 20, 20, 0.990,
         'non_scheduled', 'wholesale_passthrough'),
        ('VPP_EVC_FLEET1', 'evcharger', 'Smithfield fleet depot',  -33.853, 150.948,
         750, 0, 1.00,  0, 0.95, 18, 6,   # overnight charging window
         0, 1, 1, 0, 0,
         6, 30, 15, 0.985,
         'non_scheduled', 'wholesale_passthrough'),
        ('VPP_EVC_SYDA1',  'evcharger', 'Sydney Airport DC bank',  -33.943, 151.176,
         1400, 0, 1.00,  0, 0.5,  0, 24,
         0, 1, 1, 0, 0,
         8, 30, 10, 0.988,
         'non_scheduled', 'wholesale_passthrough'),
    ]
    for row in vpp_seed:
        con.execute(
            """
            INSERT OR IGNORE INTO vpp_resource
                (resource_id, portfolio_id, kind, site_name, lat, lon,
                 nameplate_kw, capacity_kwh, rte_pct, soc_kwh, availability_now,
                 window_start_hr, window_end_hr,
                 can_inject, can_curtail, can_raise_fcas, can_lower_fcas, can_reg_fcas,
                 max_events_per_day, max_duration_min, recovery_min,
                 mlf, dispatch_type, retail_plan,
                 opted_in, created_at, updated_at)
            VALUES (?, 'NSW_CI_VPP', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
            """,
            (*row, nem_now, nem_now),
        )

    # ------------------------------------------------------------------
    # Back-fill: ensure pre-existing rows from older DBs get the
    # operator-intended dispatch_type. The ALTER above defaulted ALL
    # rows to 'non_scheduled', so we explicitly upgrade the two BESS
    # sites that should be scheduled. Idempotent — re-running is a no-op
    # because we only flip rows that still hold the default.
    con.execute(
        "UPDATE vpp_resource SET dispatch_type = 'scheduled' "
        "WHERE resource_id IN ('VPP_BESS_LIDC1', 'VPP_BESS_MAC1') "
        "  AND dispatch_type = 'non_scheduled'"
    )

    # ------------------------------------------------------------------
    # Seed AEMO MLF data — 2025-26 Financial Year.
    # Values sourced from AEMO published Loss Factor Report (annual release,
    # Feb–Mar). Coordinates are approximate grid connection point locations.
    # Only inserted once via INSERT OR IGNORE — a future scraper can upsert
    # newer FY values without disrupting existing rows.
    # Columns: duid, financial_year, station_name, region,
    #          fuel_type, capacity_mw, mlf, lat, lon
    _mlf_seed = [
        # ===== NSW1 =====================================================
        # Coal
        ("BAYSW1",     "2025-26", "Bayswater U1",          "NSW1", "coal",    660, 0.9907, -32.339, 150.430),
        ("BAYSW2",     "2025-26", "Bayswater U2",          "NSW1", "coal",    660, 0.9907, -32.339, 150.430),
        ("BAYSW3",     "2025-26", "Bayswater U3",          "NSW1", "coal",    660, 0.9903, -32.339, 150.430),
        ("BAYSW4",     "2025-26", "Bayswater U4",          "NSW1", "coal",    660, 0.9903, -32.339, 150.430),
        ("ERARING1",   "2025-26", "Eraring U1",            "NSW1", "coal",    720, 0.9944, -33.062, 151.519),
        ("ERARING2",   "2025-26", "Eraring U2",            "NSW1", "coal",    720, 0.9944, -33.062, 151.519),
        ("ERARING3",   "2025-26", "Eraring U3",            "NSW1", "coal",    720, 0.9941, -33.062, 151.519),
        ("ERARING4",   "2025-26", "Eraring U4",            "NSW1", "coal",    720, 0.9941, -33.062, 151.519),
        ("VALES1",     "2025-26", "Mount Piper U1",        "NSW1", "coal",    700, 0.9872, -33.383, 150.102),
        ("VALES2",     "2025-26", "Mount Piper U2",        "NSW1", "coal",    700, 0.9872, -33.383, 150.102),
        # Gas
        ("TALLAWDG1",  "2025-26", "Tallawarra B",          "NSW1", "gas",     316, 0.9952, -34.460, 150.872),
        ("HUNTER",     "2025-26", "Hunter Power (peaker)", "NSW1", "gas",     750, 0.9886, -32.758, 151.562),
        ("COLONGRA1",  "2025-26", "Colongra OCGT 1",       "NSW1", "gas",     171, 0.9921, -33.316, 151.520),
        # Hydro / Pumped Hydro
        ("TUMUT3",     "2025-26", "Tumut 3",               "NSW1", "hydro",  1500, 0.9741, -35.707, 148.332),
        ("GUTHEGA1",   "2025-26", "Guthega",               "NSW1", "hydro",   60, 0.9719, -36.373, 148.372),
        ("SHOALHVN1",  "2025-26", "Shoalhaven PS",         "NSW1", "hydro",   240, 0.9881, -34.970, 150.430),
        # Wind
        ("TARALGA1",   "2025-26", "Taralga Wind",          "NSW1", "wind",    107, 0.9843, -34.400, 149.530),
        ("BODANGL1",   "2025-26", "Bodangora Wind",        "NSW1", "wind",    113, 0.9682, -32.036, 148.823),
        ("BUNGABAN1",  "2025-26", "Bungaban Wind",         "NSW1", "wind",    220, 0.9744, -30.051, 148.623),
        ("CROOKWL2",   "2025-26", "Crookwell 2 Wind",      "NSW1", "wind",     91, 0.9868, -34.491, 149.372),
        ("SAPPHIRE1",  "2025-26", "Sapphire Wind",         "NSW1", "wind",    270, 0.9661, -29.835, 151.846),
        # Solar
        ("NSWSOL1",    "2025-26", "Darlington Point Solar","NSW1", "solar",   275, 0.9872, -34.553, 145.988),
        ("CRUDINE1",   "2025-26", "Crudine Ridge Wind",    "NSW1", "wind",     79, 0.9864, -33.160, 149.480),
        # BESS
        ("WDWF1",      "2025-26", "Wallgrove BESS",        "NSW1", "battery",  50, 0.9894, -33.720, 150.870),
        ("LISBERG1",   "2025-26", "Lake Cowal BESS",       "NSW1", "battery", 200, 0.9836, -33.395, 147.402),
        ("CRWN_BESS",  "2025-26", "Crown Energy BESS NSW", "NSW1", "battery", 100, 0.9882, -33.897, 151.122),
        # ===== QLD1 =====================================================
        ("CALL_B_1",   "2025-26", "Callide B U1",          "QLD1", "coal",    350, 0.9822, -24.390, 150.480),
        ("CALL_B_2",   "2025-26", "Callide B U2",          "QLD1", "coal",    350, 0.9822, -24.390, 150.480),
        ("CALL_C_1",   "2025-26", "Callide C U1",          "QLD1", "coal",    420, 0.9814, -24.395, 150.482),
        ("TARONG1",    "2025-26", "Tarong U1",              "QLD1", "coal",    350, 0.9851, -26.790, 151.910),
        ("TARONG2",    "2025-26", "Tarong U2",              "QLD1", "coal",    350, 0.9851, -26.790, 151.910),
        ("KOGAN1",     "2025-26", "Kogan Creek",           "QLD1", "coal",    744, 0.9796, -26.788, 150.783),
        # Gas
        ("BRAEMAR2",   "2025-26", "Braemar 2 OCGT",        "QLD1", "gas",     519, 0.9743, -26.895, 148.855),
        ("URANQ11",    "2025-26", "Uranquinty OCGT",       "QLD1", "gas",     639, 0.9736, -35.177, 147.248),
        # Wind
        ("MILLMRWF1",  "2025-26", "Millmerran Wind",       "QLD1", "wind",    452, 0.9755, -27.143, 151.861),
        ("COOROW1",    "2025-26", "Cooroora Solar",        "QLD1", "solar",   220, 0.9714, -26.432, 152.878),
        # Solar
        ("DKPSOLN1",   "2025-26", "Darling Downs Solar",   "QLD1", "solar",   180, 0.9741, -27.554, 151.261),
        # BESS
        ("WDGSF1",     "2025-26", "Western Downs Grid Storage","QLD1","battery",270,0.9764,-27.120, 150.820),
        ("BALBNYB1",   "2025-26", "Bouldercombe BESS",     "QLD1", "battery", 100, 0.9748, -23.620, 150.520),
        # ===== VIC1 =====================================================
        ("LYA_P1",     "2025-26", "Loy Yang A U1",         "VIC1", "coal",    560, 0.9781, -38.220, 146.553),
        ("LYA_P2",     "2025-26", "Loy Yang A U2",         "VIC1", "coal",    560, 0.9781, -38.220, 146.553),
        ("LYA_P3",     "2025-26", "Loy Yang A U3",         "VIC1", "coal",    560, 0.9779, -38.220, 146.553),
        ("LYA_P4",     "2025-26", "Loy Yang A U4",         "VIC1", "coal",    560, 0.9779, -38.220, 146.553),
        ("LOYYB1",     "2025-26", "Loy Yang B U1",         "VIC1", "coal",    500, 0.9783, -38.226, 146.560),
        ("LOYYB2",     "2025-26", "Loy Yang B U2",         "VIC1", "coal",    500, 0.9783, -38.226, 146.560),
        # Gas
        ("MORTLK11",   "2025-26", "Mortlake GT11",         "VIC1", "gas",     282, 0.9643, -38.127, 142.814),
        ("LAVAPWR1",   "2025-26", "Laverton North",        "VIC1", "gas",     312, 0.9727, -37.852, 144.776),
        # Wind
        ("BANN1",      "2025-26", "Bannerton/Waubra Wind", "VIC1", "wind",    184, 0.9684, -37.407, 143.473),
        ("LKBONNY1",   "2025-26", "Lake Bonney Stage 1",   "VIC1", "wind",    240, 0.9689, -37.621, 140.823),
        ("MTGELION1",  "2025-26", "Mt Gellibrand Wind",    "VIC1", "wind",    132, 0.9641, -38.482, 143.643),
        # Solar
        ("LIMONDALE",  "2025-26", "Limondale Solar",       "VIC1", "solar",   248, 0.9793, -34.638, 146.222),
        # BESS
        ("BULGN",      "2025-26", "Bulgana Green Power",   "VIC1", "battery",  20, 0.9672, -37.123, 143.103),
        ("GANNBG1",    "2025-26", "Gannawarra BESS",       "VIC1", "battery",  25, 0.9658, -35.616, 144.086),
        ("KEPCOGHLD",  "2025-26", "Kepcor Glenrowan BESS", "VIC1", "battery",  50, 0.9731, -36.461, 146.134),
        # ===== SA1 ======================================================
        ("TORRNS11",   "2025-26", "Torrens Island A1",     "SA1",  "gas",     220, 0.9718, -34.773, 138.534),
        ("OSBORNE1",   "2025-26", "Osborne",               "SA1",  "gas",     180, 0.9734, -34.832, 138.542),
        ("PELICAN1",   "2025-26", "Pelican Point",         "SA1",  "gas",     480, 0.9703, -34.792, 138.550),
        ("PPCCGT",     "2025-26", "Barker Inlet OCGT",     "SA1",  "gas",     211, 0.9721, -34.791, 138.553),
        # Wind
        ("WTGY1",      "2025-26", "Waterloo Wind",         "SA1",  "wind",    111, 0.9589, -33.981, 138.899),
        ("CNUNDAWF1",  "2025-26", "Canunda Wind",          "SA1",  "wind",     46, 0.9541, -37.485, 140.552),
        ("HDWF1",      "2025-26", "Hallett Wind",          "SA1",  "wind",     94, 0.9567, -33.394, 138.956),
        # Solar
        ("WAKOOL1",    "2025-26", "Robertstown Solar",     "SA1",  "solar",   200, 0.9602, -34.320, 139.230),
        # BESS
        ("HPRG1",      "2025-26", "Hornsdale Power Reserve","SA1", "battery", 150, 0.9632, -33.540, 138.219),
        ("DALRYMPLE",  "2025-26", "Dalrymple North BESS",  "SA1",  "battery",  30, 0.9567, -33.900, 137.980),
        ("NEOEN_SA1",  "2025-26", "Neoen SA BESS (Hulistat)","SA1","battery", 100, 0.9588, -33.534, 138.226),
        # ===== TAS1 =====================================================
        ("GORDON1",    "2025-26", "Gordon",                "TAS1", "hydro",   432, 0.9541, -42.535, 145.933),
        ("POATINA1",   "2025-26", "Poatina",               "TAS1", "hydro",   300, 0.9583, -41.818, 146.828),
        ("REECE1",     "2025-26", "Reece",                 "TAS1", "hydro",   231, 0.9619, -41.870, 145.100),
        ("REECE2",     "2025-26", "Reece 2",               "TAS1", "hydro",   231, 0.9617, -41.872, 145.102),
        ("CATTLE_H1",  "2025-26", "Cattle Hill Wind",      "TAS1", "wind",     84, 0.9671, -41.380, 147.540),
        ("MUSSELROE1", "2025-26", "Musselroe Wind",        "TAS1", "wind",    168, 0.9443, -40.882, 148.113),
        ("GRANVW1",    "2025-26", "Granville Harbour Wind","TAS1", "wind",    112, 0.9527, -41.789, 144.867),
        ("WOOLNTH1",   "2025-26", "Woolnorth Wind",        "TAS1", "wind",     65, 0.9498, -40.710, 144.741),
    ]
    for row in _mlf_seed:
        (duid, fy, station_name, region, fuel_type, capacity_mw,
         mlf, lat, lon) = row
        con.execute(
            """
            INSERT OR IGNORE INTO nem_mlf
                (duid, financial_year, station_name, region,
                 fuel_type, capacity_mw, mlf, lat, lon)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (duid, fy, station_name, region, fuel_type, capacity_mw,
             mlf, lat, lon),
        )
