"""SQLite store. Chosen over DuckDB because the Alpine+musl base image we
inherit doesn't have prebuilt duckdb wheels. SQLite ships with Python."""
from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager

from .config import DB_PATH

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None


def get_conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(
            str(DB_PATH).replace(".duckdb", ".sqlite3"),
            check_same_thread=False,
            detect_types=sqlite3.PARSE_DECLTYPES,
            isolation_level=None,  # autocommit; we manage txns explicitly
        )
        _conn.execute("PRAGMA journal_mode=WAL;")
        _conn.execute("PRAGMA synchronous=NORMAL;")
        _conn.execute("PRAGMA foreign_keys=ON;")
        _init_schema(_conn)
    return _conn


@contextmanager
def locked_conn():
    """SQLite connections aren't safe for concurrent writes — serialise."""
    with _lock:
        yield get_conn()


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

        CREATE TABLE IF NOT EXISTS scraper_state (
            source TEXT PRIMARY KEY,
            last_file TEXT,
            last_run TIMESTAMP,
            last_error TEXT
        );

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
    ):
        try:
            con.execute(ddl)
        except sqlite3.OperationalError as e:
            if "duplicate column" not in str(e).lower():
                raise

    # Seed RYAN1 BESS state (100 MW × 2h, start 50% SoC, 85% RTE, MLF 0.97).
    # The MLF figure is representative of a NSW1 transmission-connected BESS;
    # AEMO publishes the actual per-DUID MLF in its annual loss factors paper.
    # Timestamp written in NEM time (UTC+10) so it matches dispatch rows.
    from datetime import datetime, timedelta
    nem_now = (datetime.utcnow() + timedelta(hours=10)).strftime("%Y-%m-%d %H:%M:%S")
    con.execute(
        """
        INSERT OR IGNORE INTO paper_bess_state
            (duid, capacity_mwh, power_mw, rte_pct, soc_mwh,
             cumulative_pnl_aud, last_settled_interval, updated_at, mlf)
        VALUES ('RYAN1', 200.0, 100.0, 85.0, 100.0, 0.0, NULL, ?, 0.97)
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
