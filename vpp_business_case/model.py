"""
VPP Business Case Model — NEM NSW1, real AEMO 5-min dispatch data (Q1 2025).

Compares, for two customer segments (C&I and Residential):
  Plan A (baseline): retail TOU plan, NO VPP, battery only does retail peak/off-peak arbitrage.
  Plan B (VPP):      wholesale plan + VPP -> wholesale arbitrage + (C&I) non-work-hours arbitrage + FCAS.

We only count VPP revenue (arbitrage + FCAS). PV self-consumption is excluded.
Operator keeps 30% of VPP revenue.

Data: data/cache/dispatch_prices.parquet  (real AEMO DISPATCHPRICE, NSW1, 2025-01-01..2025-03-31,
      5-min RRP + 8 FCAS service prices).
"""
import pandas as pd, numpy as np, json, os

ROOT = "/sessions/funny-upbeat-darwin/mnt/claude-PriceForecastNEM"
OUT  = os.path.join(ROOT, "vpp_business_case")
os.makedirs(OUT, exist_ok=True)

# ----------------------------------------------------------------------------
# GLOBAL ASSUMPTIONS  (all adjustable)
# ----------------------------------------------------------------------------
RT_EFF          = 0.90      # battery round-trip efficiency
DEGR_COST       = 50.0      # $/MWh discharged throughput (battery wear) — shown separately
ARB_SEASONAL    = 0.80      # full-year arb spread ≈ 80% of summer(Q1) — conservative de-rate
FORESIGHT       = 0.85      # imperfect-foresight haircut (real dispatch can't perfectly time spikes)
FCAS_SEASONAL   = 0.90      # full-year FCAS ≈ 90% of Q1
FCAS_AVAIL      = 0.50      # fraction of power realistically enabled in FCAS (SoC/co-opt headroom)
OPERATOR_SHARE  = 0.30      # operator keeps 30% of VPP revenue
DAYS_YEAR       = 365
MAX_CYCLES      = 1         # cycles/day for arbitrage (1 = conservative, warranty-friendly)

FCAS_COLS = ["RAISE6SECRRP","RAISE60SECRRP","RAISE5MINRRP","RAISEREGRRP",
             "LOWER6SECRRP","LOWER60SECRRP","LOWER5MINRRP","LOWERREGRRP"]

# Segment configs --------------------------------------------------------------
SEGMENTS = {
    "Residential": dict(
        annual_load_kwh = 5500,
        pv_kw           = 6.6,
        batt_kwh        = 13.5,    # usable
        batt_kw         = 5.0,
        retail_peak     = 0.50,    # $/kWh  (NSW TOU peak, indicative)
        retail_offpeak  = 0.28,    # $/kWh  (NSW TOU off-peak)
        work_hours_only = False,   # residential: battery available all hours
    ),
    "C&I": dict(
        annual_load_kwh = 300_000,
        pv_kw           = 100.0,
        batt_kwh        = 215.0,   # usable
        batt_kw         = 100.0,
        retail_peak     = 0.35,    # $/kWh  business TOU peak (indicative)
        retail_offpeak  = 0.22,    # $/kWh  business TOU off-peak
        work_hours_only = True,    # arbitrage restricted to NON-work hours
    ),
}
# C&I work hours that BLOCK arbitrage: weekdays 08:00-17:00 (battery serving facility)
WORK_START, WORK_END = 8, 17

# ----------------------------------------------------------------------------
def load_prices():
    df = pd.read_parquet(os.path.join(ROOT, "data/cache/dispatch_prices.parquet"))
    df = df[(df.REGIONID == "NSW1") & (df.INTERVENTION == 0)].copy()
    df["SETTLEMENTDATE"] = pd.to_datetime(df.SETTLEMENTDATE)
    df = df.sort_values("SETTLEMENTDATE").reset_index(drop=True)
    df["date"]    = df.SETTLEMENTDATE.dt.date
    df["hour"]    = df.SETTLEMENTDATE.dt.hour
    df["weekday"] = df.SETTLEMENTDATE.dt.weekday  # 0=Mon
    return df

def daily_arbitrage(prices_mwh, batt_kwh, batt_kw, eff, degr, max_cycles=1):
    """Greedy single/double-cycle arbitrage on a day's 5-min price vector ($/MWh).
       Returns (gross_profit$, discharge_MWh)."""
    e_int = batt_kw * (5/60)            # kWh deliverable per 5-min interval
    n_dis = int(np.ceil(batt_kwh / e_int))        # intervals to discharge full
    n_ch  = int(np.ceil((batt_kwh/eff) / e_int))  # intervals to charge full (incl losses)
    p = np.sort(np.asarray(prices_mwh))           # ascending
    if len(p) < n_dis + n_ch:
        return 0.0, 0.0
    gross, disch_mwh = 0.0, 0.0
    lo, hi = 0, len(p)                              # pointers into cheapest / dearest
    for _ in range(max_cycles):
        charge_p   = p[lo:lo+n_ch]                  # cheapest remaining
        discharge_p= p[hi-n_dis:hi]                 # dearest remaining
        e_per = e_int/1000.0                         # MWh per interval
        rev   = discharge_p.sum() * e_per            # sell n_dis intervals (~batt_kwh out)
        cost  = charge_p.sum()   * e_per             # buy  n_ch  intervals (~batt_kwh/eff in)
        dmwh  = n_dis * e_per
        cycle_profit = rev - cost                    # RT loss already in n_ch>n_dis sizing
        if cycle_profit - degr*dmwh > 0:
            gross   += cycle_profit
            disch_mwh += dmwh
            lo += n_ch; hi -= n_dis
            if hi - lo < n_dis + n_ch:
                break
        else:
            break
    return gross, disch_mwh

def run_segment(name, cfg, df):
    eff = RT_EFF
    bk, bp = cfg["batt_kwh"], cfg["batt_kw"]

    # ---- Plan A: retail TOU arbitrage (fixed spread, 1 cycle/day, every day) ----
    spread_A = cfg["retail_peak"] - cfg["retail_offpeak"]     # $/kWh
    # sell batt_kwh at peak, buy batt_kwh/eff at off-peak
    daily_A  = bk*cfg["retail_peak"] - (bk/eff)*cfg["retail_offpeak"]
    arbA_year = daily_A * DAYS_YEAR
    vppA = arbA_year                                         # VPP revenue = arbitrage only

    # ---- Plan B: wholesale arbitrage (base = 1 cycle/day; upside = 2 cycles/day) ----
    def arb_for_cycles(maxc):
        pday, dday = [], []
        for d, g in df.groupby("date"):
            gg = g
            if cfg["work_hours_only"]:
                block = (gg.weekday < 5) & (gg.hour >= WORK_START) & (gg.hour < WORK_END)
                gg = gg[~block]
            pr, dm = daily_arbitrage(gg.RRP.values, bk, bp, eff, DEGR_COST, maxc)
            pday.append(pr); dday.append(dm)
        return np.mean(pday), np.mean(dday)
    arbB_daily, dmwh_daily   = arb_for_cycles(1)
    arbB2_daily, dmwh2_daily = arb_for_cycles(2)
    arbB_year   = arbB_daily  * DAYS_YEAR * ARB_SEASONAL * FORESIGHT
    arbB2_year  = arbB2_daily * DAYS_YEAR * ARB_SEASONAL * FORESIGHT
    degrB_arb_year = dmwh_daily * DAYS_YEAR * ARB_SEASONAL * DEGR_COST

    # ---- Plan B: FCAS (only on intervals NOT used for arbitrage) ----
    # available power for FCAS during non-arbitrage hours; use real stacked FCAS prices
    fcas_stack = df[FCAS_COLS].sum(axis=1).values            # $/MW/h summed across 8 services
    # battery occupied by arbitrage ~ (n_ch+n_dis) intervals/day; rest available
    e_int = bp*(5/60); occ = int(np.ceil(bk/e_int))+int(np.ceil((bk/eff)/e_int))
    avail_frac = max(0.0, 1 - occ/ (len(df)/df.date.nunique()))
    mw = bp/1000.0
    # $/interval = MW * stack($/MW/h) * (5/60)h * availability(SoC) * avail_frac(time)
    fcas_per_int = mw * fcas_stack * (5/60) * FCAS_AVAIL * avail_frac
    fcas_daily = fcas_per_int.sum()/df.date.nunique()
    fcasB_year = fcas_daily * DAYS_YEAR * FCAS_SEASONAL

    vppB  = arbB_year  + fcasB_year                 # base (1 cycle/day)
    vppB2 = arbB2_year + fcasB_year                 # upside (2 cycles/day)

    return dict(
        segment=name, batt_kwh=bk, batt_kw=bp,
        # Plan A
        A_retail_spread_ckwh = round(spread_A,3),
        A_vpp_year = round(vppA),
        A_operator_year = round(vppA*OPERATOR_SHARE),
        # Plan B base
        B_arb_year  = round(arbB_year),
        B_fcas_year = round(fcasB_year),
        B_vpp_year  = round(vppB),
        B_operator_year = round(vppB*OPERATOR_SHARE),
        # Plan B upside (2 cycles)
        B_arb_year_2cyc = round(arbB2_year),
        B_vpp_year_2cyc = round(vppB2),
        B_operator_year_2cyc = round(vppB2*OPERATOR_SHARE),
        # uplift (base)
        uplift_vpp_year = round(vppB - vppA),
        uplift_x = round(vppB/max(vppA,1),2),
        uplift_operator_year = round((vppB-vppA)*OPERATOR_SHARE),
        # context
        degr_B_arb_year = round(degrB_arb_year),
        fcas_avail_frac = round(avail_frac,2),
    )

def main():
    df = load_prices()
    # data sanity
    meta = dict(
        region="NSW1", source="AEMO DISPATCHPRICE (real 5-min)",
        period=f"{df.SETTLEMENTDATE.min()} .. {df.SETTLEMENTDATE.max()}",
        days=int(df.date.nunique()), intervals=int(len(df)),
        rrp_mean=round(df.RRP.mean(),1), rrp_neg_pct=round((df.RRP<0).mean()*100,1),
        assumptions=dict(RT_EFF=RT_EFF, DEGR_COST=DEGR_COST, ARB_SEASONAL=ARB_SEASONAL,
                         FORESIGHT=FORESIGHT, FCAS_SEASONAL=FCAS_SEASONAL, FCAS_AVAIL=FCAS_AVAIL,
                         OPERATOR_SHARE=OPERATOR_SHARE, MAX_CYCLES=MAX_CYCLES,
                         work_hours="Mon-Fri 08-17 blocked for C&I"),
    )
    rows = [run_segment(n, c, df) for n, c in SEGMENTS.items()]
    res = pd.DataFrame(rows)
    res.to_csv(os.path.join(OUT, "results.csv"), index=False)

    # ---- Fleet roll-up (operator view) ----
    FLEET = {"Residential": 1000, "C&I": 100}   # example portfolio
    fleet = []
    for r in rows:
        n = FLEET[r["segment"]]
        fleet.append(dict(segment=r["segment"], sites=n,
            operator_A_year = round(r["A_operator_year"]*n),
            operator_B_year = round(r["B_operator_year"]*n),
            operator_uplift_year = round(r["uplift_operator_year"]*n)))
    fleet_df = pd.DataFrame(fleet)
    tot = dict(segment="TOTAL", sites=fleet_df.sites.sum(),
               operator_A_year=fleet_df.operator_A_year.sum(),
               operator_B_year=fleet_df.operator_B_year.sum(),
               operator_uplift_year=fleet_df.operator_uplift_year.sum())
    fleet_df = pd.concat([fleet_df, pd.DataFrame([tot])], ignore_index=True)
    fleet_df.to_csv(os.path.join(OUT, "fleet.csv"), index=False)

    with open(os.path.join(OUT, "meta.json"), "w") as f:
        json.dump(meta, f, indent=2, default=str)
    pd.set_option("display.width", 200, "display.max_columns", 50)
    print(json.dumps(meta, indent=2, default=str))
    print("\n=== RESULTS (annual A$) ===")
    print(res.T.to_string())
    print("\n=== FLEET ROLL-UP (operator 30% share, A$/yr) ===")
    print(fleet_df.to_string(index=False))
    return res, meta

if __name__ == "__main__":
    main()
