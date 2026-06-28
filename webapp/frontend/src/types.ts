export type FCAS = {
  raise6sec: number | null
  raise60sec: number | null
  raise5min: number | null
  raisereg: number | null
  raise1sec: number | null
  lower6sec: number | null
  lower60sec: number | null
  lower5min: number | null
  lowerreg: number | null
  lower1sec: number | null
}

export type NextForecast = {
  interval_datetime: string
  rrp: number | null
  source: 'P5MIN' | 'PREDISPATCH'
  run_datetime: string | null
  demand: number | null
}

export type RegionSnapshot = {
  regionid: string
  settlementdate: string | null
  rrp: number | null
  rrp_1h_ago: number | null
  next_forecast: NextForecast | null
  fcas: FCAS
  totaldemand: number | null
  availablegeneration: number | null
  netinterchange: number | null
  /** NER cumulative-price mechanism: rolling 2,016-interval RRP sum. */
  cumulative_price?: number | null
  cpt_threshold?: number | null
  cpt_pct?: number | null
  cpt_intervals?: number | null
  apc_active?: boolean | null
  apc_price?: number | null
}

export type WemSnapshot = {
  interval_start: string | null
  reference_trading_price: number | null
  mcap_price: number | null
}

export type Snapshot = {
  nem: RegionSnapshot[]
  wem: WemSnapshot | null
  generated_at: string
}

export type HistoryPoint = {
  t: string
  rrp: number | null
  demand?: number | null
  raisereg?: number | null
  raise5min?: number | null
  raise60sec?: number | null
  raise6sec?: number | null
  raise1sec?: number | null
  lowerreg?: number | null
  lower5min?: number | null
  lower60sec?: number | null
  lower6sec?: number | null
  lower1sec?: number | null
}

export type History = {
  region: string
  series: HistoryPoint[]
  bucket_minutes?: number
}

export type OHLCPoint = {
  t: string      // bucket start NEM time, e.g. "2026-06-03T14:00"
  open: number
  high: number
  low: number
  close: number
  count: number  // number of 5-min dispatch intervals in this candle
}

export type OHLCData = {
  region: string
  bucket_minutes: number
  hours: number
  series: OHLCPoint[]
}

export type ForecastPoint = {
  t: string
  rrp: number | null
  demand: number | null
  source: 'P5MIN' | 'PREDISPATCH'
  /** AEMO co-optimisation FCAS forecasts ($/MW/h). Same keys as the FCAS
   *  type but optional — some backfilled rows may have nulls. */
  fcas?: FCAS
}

export type Forecast = {
  region: string
  series: ForecastPoint[]
  p5min_run: string | null         // ISO timestamp of latest P5MIN run
  predispatch_run: string | null   // ISO timestamp of latest PREDISPATCH run
}

// ---- Heatmap -------------------------------------------------------------

export type HeatmapCell = {
  day: string                  // YYYY-MM-DD
  rrp_max: number | null
  raisereg_max: number | null
}

export type HeatmapRegion = {
  regionid: string
  cells: HeatmapCell[]
  rrp_mean: number | null
  raisereg_mean: number | null
}

export type Heatmap = {
  days: number
  regions: HeatmapRegion[]
}

export type FCASMatrix = {
  markets: string[]
  regions: ({ regionid: string; settlementdate: string | null } & Record<string, number | null | string>)[]
}

export type Interconnector = {
  id: string
  name: string
  long_name: string
  region_from: string
  region_to: string
  from: [number, number]   // [lon, lat]
  to: [number, number]
  nominal_limit_mw: number
  mnsp: boolean
  settlementdate: string | null
  flow_mw: number | null
  export_limit_mw: number | null
  import_limit_mw: number | null
  utilisation: number | null   // 0.0 – 1.0+
}

export type GridSnapshot = {
  interconnectors: Interconnector[]
  region_centroids: Record<string, [number, number]>
  generated_at: string
}

export type Fuel =
  | 'coal_black' | 'coal_brown' | 'gas' | 'hydro'
  | 'wind' | 'solar' | 'rooftop_solar' | 'battery' | 'bioenergy'

export type Station = {
  station: string
  region: string
  fuel: Fuel
  lat: number
  lon: number
  capacity_mw: number
  mw: number             // Sum of latest MW across units (0 if none reported)
  online_units: number   // How many of the station's units have a recent value
  settlementdate: string | null
  units: { duid: string; capacity_mw: number; mw: number | null }[]
}

export type GeneratorsSnapshot = {
  stations: Station[]
  fuel_colors: Record<Fuel, string>
  by_region_fuel_mw: Record<string, Partial<Record<Fuel, number>>>
  duid_count_total: number
  duid_count_with_data: number
  generated_at: string
}

// ---- Paper trading -------------------------------------------------------

export type Market =
  | 'ENERGY'
  | 'RAISEREG' | 'RAISE5MIN' | 'RAISE60SEC' | 'RAISE6SEC' | 'RAISE1SEC'
  | 'LOWERREG' | 'LOWER5MIN' | 'LOWER60SEC' | 'LOWER6SEC' | 'LOWER1SEC'

export type Direction = 'GEN' | 'LOAD'

export type BidStatus = 'PENDING' | 'SETTLED' | 'CANCELLED' | 'EXPIRED'

export type BidBand = { price: number; mw: number }

export type BidIn = {
  duid?: string
  target_settlementdate: string
  market: Market
  direction: Direction
  bands: BidBand[]
  notes?: string | null
  /** Optional bid_id of an existing PENDING bid to supersede. Must match
   *  the same (DUID, target, market, direction). Old bid is auto-cancelled. */
  replaces_bid_id?: number | null
  /** FCAS co-optimisation trapezium (NER 3.8.7A). Optional — only sent for
   *  FCAS market bids submitted via the FCAS bid panel. */
  fcas_trapezium?: VPPFcasTrapezium | null
}

export type Bid = {
  bid_id: number
  duid: string
  target_settlementdate: string
  market: Market
  direction: Direction
  submitted_at: string
  status: BidStatus
  bands: BidBand[]
  notes: string | null
  /** Set when this bid was submitted as a rebid superseding an earlier
   *  PENDING bid (same DUID/target/market/direction). The chain root has
   *  previous_bid_id = null. */
  previous_bid_id: number | null
  /** FCAS co-optimisation trapezium. Present only on FCAS bids submitted
   *  via the FCAS bid panel; null for ENERGY bids and legacy bids. */
  fcas_trapezium: VPPFcasTrapezium | null
}

export type Fill = {
  fill_id: number
  bid_id: number
  duid: string
  settlementdate: string
  market: Market
  cleared_price: number
  enabled_mw: number      // signed: +ve sold, -ve bought (energy); +ve raise, -ve lower (FCAS)
  energy_mwh: number      // signed; 0 for FCAS
  revenue_aud: number
  created_at: string
}

export type BessState = {
  duid: string
  capacity_mwh: number
  power_mw: number
  rte_pct: number
  /** Marginal Loss Factor. 1.0 = no losses. Applied to ENERGY settlements
   *  only: GEN revenue × MLF, LOAD cost ÷ MLF. FCAS unaffected. */
  mlf: number
  soc_mwh: number
  soc_pct: number
  cumulative_pnl_aud: number
  last_settled_interval: string | null
  updated_at: string
  today_energy_pnl: number
  today_fcas_pnl: number
  today_total_pnl: number
}

export type NextIntervals = {
  intervals: string[]    // NEM time, naive ISO
  interval_minutes: number
}

// ---- Paper batch bid -------------------------------------------------------

export type PaperBidBatchResultItem = {
  ok: boolean
  target: string
  market: string
  direction: string
  bid_id?: number
  error?: string
}

export type PaperBidBatchResult = {
  submitted: number
  failed: number
  results: PaperBidBatchResultItem[]
}

export type MarketCatalog = {
  energy: Market[]
  raise_fcas: Market[]
  lower_fcas: Market[]
}

// ---- Network constraints -------------------------------------------------

/** One AEMO DISPATCHCONSTRAINT row. Only binding rows (marginalvalue != 0)
 *  reach the client — non-binding constraints are filtered server-side. */
export type ConstraintRow = {
  settlementdate: string
  constraintid: string
  rhs: number | null
  /** Shadow price ($/MW). Sign indicates whether tightening helps/hurts. */
  marginalvalue: number | null
  /** Degree of violation (MW). >0 means the constraint was violated. */
  violationdegree: number | null
}

export type Constraints = {
  region: string
  hours: number
  constraints: ConstraintRow[]
  /** Sorted unique settlementdates that had at least one binding constraint. */
  binding_intervals: string[]
}

// ---- Market timeline (BIDDAYOFFER → DISPATCH lifecycle) -----------------

export type TimelineStatus = 'complete' | 'in_progress' | 'upcoming'

export type TimelineStage = {
  key: 'bidday_deadline' | 'predispatch' | 'p5min' | 'gate_closure' | 'dispatch' | 'settlement'
  name: string
  ts?: string
  ts_start?: string
  ts_end?: string
  interval_end?: string
  frequency_minutes?: number
  status: TimelineStatus
  rule: string
  detail: Record<string, unknown>
}

export type Timeline = {
  now: string
  target_interval: string
  trading_date: string
  interval_minutes: number
  duid: string | null
  duid_state: {
    day_ahead_submitted: string | null
    versions_for_interval: number
    latest_version_submitted: string | null
  } | null
  stages: TimelineStage[]
}

// ---- Bid stack ----------------------------------------------------------

export type BidStackBand = { i: number; price: number | null; mw: number }

export type BidStackEntry = {
  duid: string
  direction: string | null
  entrytype: string | null
  bands: BidStackBand[]
  daily_energy_constraint: number | null
  maxavail: number | null
  fixedload: number | null
  rampuprate: number | null
  rampdownrate: number | null
  rebid_reason: string | null
  submitted_at: string | null
  version: number
}

export type BidStack = {
  interval: string
  trading_date: string
  bidtype: string
  direction: string | null
  stack: BidStackEntry[]
  count: number
}

// ---- VPP (C&I Virtual Power Plant) -------------------------------------

export type VPPResourceKind = 'bess' | 'evcharger'

/** AEMO dispatch class of a single resource (NOT the portfolio-level
 *  registration). 'scheduled' = follows NEMDE 5-min dispatch + can do
 *  FCAS. 'non_scheduled' = BTM, earns via embedded generation /
 *  WDR / customer-side only. */
export type VPPDispatchType = 'scheduled' | 'semi_scheduled' | 'non_scheduled'

/** Retail contract held by the C&I customer for this connection point.
 *  Drives whether a non_scheduled inject-capable BESS can earn the spot
 *  RRP via embedded generation. */
export type VPPRetailPlan = 'wholesale_passthrough' | 'standard_TOU' | 'FiT_only'

/** Money-tap channels a resource has access to, derived from
 *  dispatch_type + retail_plan + capability flags. Shown as badges in
 *  the roster so the operator can see which AEMO/customer paths each
 *  site can monetise. */
export type VPPChannel =
  | 'wholesale_full'        // scheduled with can_inject: full NEMDE + FCAS
  | 'embedded_generation'   // non_scheduled BTM, wholesale_passthrough, can_inject
  | 'wdr'                   // any can_curtail (load reduction vs baseline)
  | 'customer_tou'          // every site can do customer-side optimisation

export type VPPResource = {
  resource_id: string
  kind: VPPResourceKind
  site_name: string
  lat: number | null
  lon: number | null
  nameplate_kw: number
  capacity_kwh: number
  rte_pct: number
  soc_kwh: number
  availability_now: number
  window_start_hr: number
  window_end_hr: number
  can_inject: number
  can_curtail: number
  can_raise_fcas: number
  can_lower_fcas: number
  can_reg_fcas: number
  max_events_per_day: number
  max_duration_min: number
  recovery_min: number
  mlf: number
  opted_in: number
  /** AEMO dispatch class at the asset level. */
  dispatch_type: VPPDispatchType
  /** C&I customer's retail contract. Default `wholesale_passthrough` —
   *  every BTM BESS can earn RRP via embedded generation unless flipped. */
  retail_plan: VPPRetailPlan
  /** Derived list of channels this resource can monetise into.
   *  Populated by the `/api/vpp/state` endpoint. */
  channels?: VPPChannel[]
}

export type VPPClassification = 'ARU' | 'SCHEDULED' | 'DRSP_ONLY'

export type VPPPortfolio = {
  portfolio_id: string
  display_name: string
  registered_duid: string
  region: string
  cumulative_pnl_aud: number
  updated_at: string
  baseline_method: string
  classification: VPPClassification
  customer_share_pct: number
}

export type VPPRevenue = {
  portfolio_id: string
  classification: VPPClassification
  hours: number
  totals: {
    wholesale_revenue_aud: number
    wholesale_fills: number
    energy_aud: number
    fcas_raise_aud: number
    fcas_lower_aud: number
    customer_demand_charge_aud: number
    customer_total_savings_aud: number
    all_revenue_aud: number
  }
  by_market: {
    market: string
    direction: string
    revenue_aud: number
    energy_mwh: number
    fills: number
  }[]
}

export type VPPFill = {
  fill_id: number
  bid_id: number
  portfolio_id: string
  settlementdate: string
  market: string
  direction: string
  cleared_price: number
  enabled_mw: number
  energy_mwh: number
  revenue_aud: number
  mlf_applied: number
  created_at: string
}

export type VPPResourcePnl = {
  resource_id: string
  site_name: string
  kind: VPPResourceKind
  nameplate_kw: number
  soc_kwh: number
  capacity_kwh: number
  fill_count: number
  energy_fill_count: number
  revenue_aud: number
  energy_mwh: number
  soc_delta_kwh: number
}

export type VPPResourcePnlResponse = {
  portfolio_id: string
  hours: number
  resources: VPPResourcePnl[]
}

// Algorithmic suggested bids
export type VPPSuggestion = {
  target_settlementdate: string
  market: string
  direction: string
  bands: { price: number; mw: number }[]
  rationale: string
  envelope_mw: number
  eligible_resources: number
  estimated_revenue_aud: number
  expected_clear: boolean
}

export type VPPSuggestionsResponse = {
  portfolio_id: string
  generated_at: string
  suggestions: VPPSuggestion[]
}

// Customer demand-charge per site
export type VPPCustomerSite = {
  resource_id: string
  site_name: string
  kind: string
  nameplate_kw: number
  peak_reduction_kw: number
  peak_events_last_30d: number
  monthly_savings_aud: number
  vpp_share_aud: number
  customer_keeps_aud: number
  potential_kw?: number
  potential_monthly_aud?: number
}

export type VPPCustomerDemandCharge = {
  portfolio_id: string
  rate_aud_per_kva_month: number
  peak_window: string
  share_pct: number
  totals: {
    customer_monthly_savings_aud: number
    vpp_monthly_share_aud: number
    active_sites: number
    idle_sites: number
  }
  active_sites: VPPCustomerSite[]
  idle_sites: VPPCustomerSite[]
}

// Per-resource history
export type VPPResourceHistoryEvent = {
  t: string
  market: string
  direction: string
  alloc_mw: number
  alloc_mwh: number
  revenue_aud: number
  revenue_cum_aud: number
  soc_delta_kwh: number
  soc_after_kwh: number
}

export type VPPResourceHistory = {
  resource: {
    resource_id: string
    site_name: string
    kind: VPPResourceKind
    nameplate_kw: number
    capacity_kwh: number
    soc_now_kwh: number
  }
  hours: number
  starting_soc_kwh: number
  events: VPPResourceHistoryEvent[]
  summary: {
    total_events: number
    energy_events: number
    fcas_events: number
    total_revenue_aud: number
    total_mwh: number
  }
}

export type VPPAggregate = {
  total_nameplate_kw: number
  total_available_now_kw: number
  resource_count: number
  opted_in_count: number
  bess_count: number
  ev_charger_count: number
  bess_capacity_kwh: number
  bess_soc_kwh: number
  bess_soc_pct: number
  /** Sum of nameplate (kW) for opted-in resources with dispatch_type =
   *  scheduled/semi_scheduled. NEMDE-dispatched portion of the fleet. */
  scheduled_kw: number
  /** Sum of nameplate (kW) for opted-in non_scheduled resources. The
   *  BTM portion that earns via embedded gen + WDR + customer-side. */
  non_scheduled_kw: number
}

export type VPPState = {
  portfolio: VPPPortfolio
  resources: VPPResource[]
  aggregate: VPPAggregate
}

export type VPPEnvelope = {
  interval: string
  market: string
  direction: string
  envelope_kw: number
  envelope_mw: number
  /** AEMO channel this envelope corresponds to — drives UI labelling
   *  ("FCAS — wholesale only" vs "ENERGY GEN — wholesale + embedded gen"). */
  channel?: 'wholesale_full' | 'wholesale_or_embedded_generation' | 'wholesale_or_wdr' | 'unknown'
  eligible_resources: {
    resource_id: string
    site_name: string
    kind: VPPResourceKind
    /** Asset's AEMO dispatch class — lets the UI show "via wholesale"
     *  vs "via embedded gen" next to each eligible site. */
    dispatch_type?: VPPDispatchType | null
    retail_plan?: VPPRetailPlan | null
    channels?: VPPChannel[]
    max_kw_now: number
  }[]
}

export type VPPBidBand = { price: number; mw: number }

export type VPPBidAllocation = { resource_id: string; alloc_kw: number }

/** FCAS co-optimisation trapezium (NER 3.8.7A + MASS). Required for FCAS
 *  bids if you want NEMDE to jointly optimise ENERGY + FCAS rather than
 *  treat your bid as a flat rectangle. */
export type VPPFcasTrapezium = {
  enablement_min_mw: number
  low_breakpoint_mw: number
  high_breakpoint_mw: number
  enablement_max_mw: number
  /** Seconds. T1=delay, T2=ramp-to-full, T3=hold, T4=release.
   *  T1+T2 must fit the market's required response window. */
  t1_sec: number
  t2_sec: number
  t3_sec: number
  t4_sec: number
}

export type VPPBidIn = {
  portfolio_id?: string
  target_settlementdate: string
  market: string
  direction: string
  bands: VPPBidBand[]
  notes?: string | null
  rebid_reason?: string | null
  allocation?: VPPBidAllocation[] | null
  replaces_bid_id?: number | null
  /** BIDPEROFFER.MaxAvail — independent hard cap on total dispatch. */
  max_avail_mw?: number | null
  /** BIDDAYOFFER.DailyEnergyConstraint — MWh cap for the trading day. */
  daily_energy_constraint_mwh?: number | null
  ramp_up_mw_per_min?: number | null
  ramp_down_mw_per_min?: number | null
  fcas_trapezium?: VPPFcasTrapezium | null
}

export type VPPBid = {
  bid_id: number
  portfolio_id: string
  target_settlementdate: string
  market: string
  direction: string
  submitted_at: string
  status: 'PENDING' | 'SETTLED' | 'CANCELLED' | 'EXPIRED'
  bands: VPPBidBand[]
  allocation: VPPBidAllocation[]
  notes: string | null
  rebid_reason: string | null
  previous_bid_id: number | null
  max_avail_mw: number | null
  daily_energy_constraint_mwh: number | null
  ramp_up_mw_per_min: number | null
  ramp_down_mw_per_min: number | null
  fcas_trapezium: VPPFcasTrapezium | null
  trading_day_batch_id: number | null
}

/** Trading-day BIDDAYOFFER-style batch submit payload. Applies one price
 *  ladder + ops params to every open dispatch interval in the day. */
export type VPPTradingDayIn = {
  portfolio_id?: string
  trading_date: string                // YYYY-MM-DD
  market: string
  direction: string
  bands: VPPBidBand[]
  max_avail_mw?: number | null
  daily_energy_constraint_mwh?: number | null
  ramp_up_mw_per_min?: number | null
  ramp_down_mw_per_min?: number | null
  fcas_trapezium?: VPPFcasTrapezium | null
  per_interval_overrides?: { interval: string; max_avail_mw: number }[] | null
  notes?: string | null
  rebid_reason?: string | null
}

// ---- BESS-Calc (project finance model) ---------------------------------

export type BessRegion = 'NSW1' | 'QLD1' | 'VIC1' | 'SA1' | 'TAS1'

/** Rich calibration statistics surfaced alongside historical defaults.
 *  Lets the UI show "median 148 · IQR 95–205 · last 7d 165" instead of
 *  one opaque number. Shape varies by metric — common keys are `value`,
 *  `unit`, `label`, plus per-metric distribution fields. */
export type BessCalibrationStats = {
  value: number                 // the point estimate fed into the model
  unit: string                  // "$/MWh", "$/MW/yr", ...
  label: string                 // short human-readable description
  // Daily distribution (arb spread)
  mean?: number
  median?: number
  p25?: number
  p75?: number
  min?: number
  max?: number
  last_7d_mean?: number | null
  // FCAS-specific
  raw_per_mw_year?: number
  utilisation?: number
  daily_mean?: number
  daily_median?: number
  daily_p25?: number
  daily_p75?: number
  last_7d_daily_mean?: number | null
  by_market?: Record<string, number>
  // Window metadata
  n_days?: number
  lookback_days?: number
}

export type BessProvenance = {
  source: 'historical' | 'fallback' | 'industry' | 'regulatory' | 'regional_baseline'
  note?: string
  /** Populated for `source === 'historical'` — rich stats for UI display. */
  stats?: BessCalibrationStats | null
}

export type BessInputs = {
  region: BessRegion
  power_mw: number
  duration_h: number
  capex_aud: number
  debt_pct: number
  interest_rate_pct: number
  loan_tenor_years: number
  rte_pct: number
  cycles_per_day: number
  degradation_pct_year: number
  aux_load_pct: number
  mlf: number
  project_life_years: number
  augmentation_capex_pct: number
  augmentation_year: number
  opex_per_kw_year: number
  insurance_per_mwh_year: number
  land_rent_aud_year: number
  nuos_per_mw_year: number
  arb_spread_per_mwh: number
  fcas_revenue_per_mw_year: number
  fcas_decline_pct_year: number
  cis_floor_revenue_per_mw_year: number
  discount_rate_pct: number
  tax_rate_pct: number
  depreciation_life_years: number
  inflation_pct: number
}

export type BessDefaultsResponse = {
  region: BessRegion
  lookback_days: number
  inputs: BessInputs
  provenance: Record<string, BessProvenance>
}

export type BessYearlyRow = {
  year: number
  energy_revenue: number
  fcas_revenue: number
  cis_revenue: number
  total_revenue: number
  opex: number
  ebitda: number
  depreciation: number
  interest: number
  ebt: number
  tax: number
  principal_repayment: number
  capex: number
  cashflow_unlevered: number
  cashflow_equity: number
  cumulative_cf_unlevered: number
  cumulative_cf_equity: number
  dscr: number | null
  discharge_mwh: number
  capacity_factor_pct: number
}

export type BessAmortRow = {
  opening: number
  interest: number
  principal: number
  closing: number
  payment: number
}

export type BessSummary = {
  energy_mwh: number
  debt_amount: number
  equity_amount: number
  annual_debt_service: number
  npv_aud: number
  project_irr_pct: number | null
  equity_irr_pct: number | null
  payback_simple_years: number | null
  payback_discounted_years: number | null
  lcos_per_mwh: number | null
  total_revenue_lifetime: number
  total_opex_lifetime: number
  total_discharge_mwh: number
  min_dscr: number | null
  avg_dscr: number | null
}

export type BessSensitivityRow = {
  driver: string
  base_irr_pct: number
  up_irr_pct: number | null
  down_irr_pct: number | null
  swing_pct: number | null
}

// ---- BESS Backtest ------------------------------------------------------

export type BessBacktestRequest = {
  region: BessRegion
  power_mw: number
  duration_h: number
  rte_pct?: number
  mlf?: number
  aux_load_pct?: number
  lookback_days?: number
  capture_efficiency?: number
  fcas_utilisation?: number
  /** Marginal degradation cost in $/MWh discharged (default 35). */
  deg_cost_per_mwh?: number
  /** Hard cap on cycles/day from thermal/warranty limit (default 2.0). */
  max_cycles_per_day?: number
}

export type BessBacktestEnergyMonth = {
  month: string
  energy_revenue_aud: number
  discharge_mwh: number
  charge_cost_aud: number
  n_days: number
  best_spread: number
}

export type BessBacktestFcasMonth = {
  month: string
  fcas_revenue_aud: number
  per_mw_window: number
}

export type BessBacktestHaircuts = {
  /** Raw top4h-vs-bottom4h $/MWh, no efficiency haircuts. The "market
   *  headline spread" you'd read in AEMO QED reports. */
  gross_market_spread_per_mwh: number
  /** After accounting for round-trip-loss charging (need more MWh in
   *  than out). */
  after_rte_per_mwh: number
  /** After applying MLF + aux load. */
  after_mlf_aux_per_mwh: number
  /** After applying capture efficiency — what the BESS actually pockets
   *  per MWh discharged. Same as `implied_spread_per_mwh`. */
  after_capture_per_mwh: number
  mean_daily_top_minus_bottom: number
  rte_loss_pct: number
  mlf_aux_loss_pct: number
  capture_loss_pct: number
}

export type BessBacktestEnergy = {
  annual_revenue_aud: number
  annual_fcas_revenue_aud: number
  annual_combined_revenue_aud: number
  mean_fcas_per_mwh_yr?: number
  mean_idle_intervals_per_day?: number
  implied_spread_per_mwh: number
  annual_discharge_mwh: number
  capture_efficiency: number
  fcas_capture?: number
  /** Economically-optimal mean cycles/day across the backtest window. */
  mean_cycles_per_day: number
  max_cycles_per_day: number
  deg_cost_per_mwh: number
  n_days_backtested: number
  n_days_positive: number
  /** Days where spread < degradation cost → BESS didn't dispatch. */
  n_days_idle: number
  /** How many days fell in each 0.5-cycle bucket, e.g. {"0.5":9,"1.0":23,"2.0":312} */
  cycle_histogram: Record<string, number>
  best_day: { date: string | null; revenue: number }
  worst_day: { date: string | null; revenue: number }
  monthly: BessBacktestEnergyMonth[]
  mlf_applied: number
  haircuts: BessBacktestHaircuts
}

export type PriceForecastPoint = {
  interval_datetime: string
  p10: number
  p25: number
  p50: number
  p75: number
  p90: number
  source?: string
}

export type PriceForecast = {
  region: string
  generated_at: string
  forecast: PriceForecastPoint[]
  error_std: number
  mean_bias?: number
  n_historical_errors: number
}

// ── Forecast page (multi-model NSW day-ahead comparison) ───────────────────
export type ForecastSeriesPoint = {
  t: string
  rrp: number
  // Uncertainty band — present only on the AEMO benchmark model.
  p10?: number; p25?: number; p75?: number; p90?: number
}
export type ForecastModelSeries = {
  name: string
  label: string
  color: string
  is_benchmark: boolean
  points: ForecastSeriesPoint[]
}
export type ForecastActual = { t: string; rrp: number }
export type ForecastSeries = {
  region: string
  now: string
  actuals: ForecastActual[]
  models: ForecastModelSeries[]
  aemo_error_std: number
  aemo_bias: number
}
export type ForecastModelAccuracy = {
  name: string; label: string; color: string; is_benchmark: boolean
  n: number            // common intervals scored (equal across models)
  n_total: number      // this model's own coverage in the window
  mae: number | null
  rmse: number | null
  smape: number | null
  bias: number | null
  skill: number | null            // 1 − rmse/benchmark_rmse (null for benchmark)
  by_hour: (number | null)[]       // 24 buckets of MAE
}
export type ForecastAccuracy = {
  region: string
  window_days: number
  benchmark: string
  winner: string | null
  n_common: number                 // intervals all models share (fair-compare set)
  models: ForecastModelAccuracy[]
  generated_at: string
  evening_peak: [number, number]   // [startHour, endHour] high-volatility band
}

export type BessBacktestFcas = {
  annual_revenue_aud: number
  per_mw_year_after_util: number
  raw_per_mw_year: number
  utilisation: number
  n_days_backtested: number
  by_market_per_mw_year: Record<string, number>
  monthly: BessBacktestFcasMonth[]
}

export type BessBacktestResponse = {
  region: BessRegion
  spec: {
    power_mw: number; duration_h: number; rte_pct: number;
    deg_cost_per_mwh: number; max_cycles_per_day: number; mlf: number
  }
  lookback_days: number
  capture_efficiency: number
  fcas_utilisation: number
  energy: BessBacktestEnergy | null
  fcas: BessBacktestFcas | null
  annual_total_revenue_aud: number
}

export type BessModelResponse = {
  inputs: BessInputs
  summary: BessSummary
  yearly: BessYearlyRow[]
  amortisation: BessAmortRow[]
  sensitivity: BessSensitivityRow[]
  provenance: Record<string, BessProvenance>
}

// ---- Compliance scorecard ----------------------------------------------

export type VPPComplianceStatus = 'PRUDENT' | 'ACCEPTABLE' | 'NEEDS REVIEW' | 'AT RISK'
export type VPPComplianceItemStatus = 'ok' | 'warn' | 'breach' | 'info'

export type VPPComplianceRuleItem = {
  ner: string
  rule: string
  enforced: boolean
  where?: string
  note?: string
}

export type VPPComplianceConductItem = {
  metric: string
  value: string
  threshold?: string
  status: VPPComplianceItemStatus
}

export type VPPComplianceContractItem = {
  resource_id: string
  site_name: string
  events_today: number
  max_events_per_day: number
  util_pct: number
  status: VPPComplianceItemStatus
}

export type VPPComplianceDataItem = {
  label: string
  ner: string
  latest: string | null
  staleness_sec: number | null
  target_sec: number | null
  status: VPPComplianceItemStatus
}

export type VPPComplianceCategory = {
  id: 'rules' | 'conduct' | 'contracts' | 'data'
  title: string
  score: number | null
  deductions?: string[]
  reason_distribution?: { reason: string; count: number }[]
  summary?: { ok: number; warn: number; breach: number }
  items: (VPPComplianceRuleItem | VPPComplianceConductItem | VPPComplianceContractItem | VPPComplianceDataItem)[]
}

export type VPPCompliance = {
  portfolio_id: string
  window_days: number
  generated_at: string
  overall_score: number
  overall_status: VPPComplianceStatus
  summary: {
    total_bids: number
    rebids: number
    settled: number
    pending: number
    cancelled: number
    rule_coverage_pct: number
    rules_enforced: number
    rules_total: number
  }
  categories: VPPComplianceCategory[]
}

export type VPPTradingDayResponse = {
  batch_id: number
  trading_date: string
  market: string
  direction: string
  max_avail_mw: number
  open_intervals: number
  created_count: number
  skipped_count: number
  created: { bid_id: number; interval: string }[]
  skipped: { interval: string; reason: string }[]
}

// ---- MLF (Marginal Loss Factor) -----------------------------------------

export type MLFEntry = {
  duid: string
  station_name: string | null
  region: string
  fuel_type: string | null
  capacity_mw: number | null
  mlf: number
  lat: number | null
  lon: number | null
  financial_year: string
}

export type MLFResponse = {
  financial_year: string
  source: string
  regional_averages: Record<string, number>
  entries: MLFEntry[]
  count: number
}

export type MLFRegionsResponse = {
  financial_year: string
  source: string
  averages: Record<string, number>  // region → capacity-weighted avg MLF
}

// ---- BESS Real-time Dispatch Plan ----------------------------------------

export type DispatchInterval = {
  interval: string                // NEM-time ISO string
  source: 'P5MIN' | 'PREDISPATCH'
  /** 5 for P5MIN dispatch intervals; 30 for PREDISPATCH trading periods */
  interval_minutes: number
  action: 'charge' | 'discharge' | 'idle'
  power_mw: number
  price_forecast_aud: number
  expected_revenue_aud: number
  soc_after_mwh: number
  soc_after_pct: number
}

export type DispatchPlan = {
  duid: string
  region: string
  generated_at: string
  current_soc_mwh: number
  current_soc_pct: number
  capacity_mwh: number
  power_mw: number
  mlf: number
  rte_pct: number
  n_intervals: number
  horizon_minutes: number
  expected_total_revenue_aud: number
  n_discharge: number
  n_charge: number
  n_idle: number
  avg_discharge_price: number | null
  avg_charge_price: number | null
  plan: DispatchInterval[]
}

export type VPPMarketCatalog = {
  energy: string[]
  raise_fcas: string[]
  lower_fcas: string[]
  rebid_reasons: string[]
  mpf: number
  mpc: number
  interval_minutes: number
  max_bands: number
}

// ---- ST PASA (Short-Term Projected Assessment of System Adequacy) ---------

export type STPASAPoint = {
  interval_datetime: string
  demand10: number | null
  demand50: number | null
  demand90: number | null
  available_generation: number | null
  lrc: number | null
  /** 0=OK, 1=LOR1, 2=LOR2, 3=LOR3 */
  reservecondition: number | null
  run_datetime: string | null
}

export type STPASAResponse = {
  region: string
  days: number
  latest_run: string | null
  series: STPASAPoint[]
  count: number
  /** { "0": N, "1": N, "2": N, "3": N } */
  lor_counts: Record<string, number>
  available_regions: string[]
}

export type STPASASummaryRegion = {
  regionid: string
  worst_lor: number | null
  lor_intervals: number
  latest_run: string | null
}

export type STPASASummary = {
  regions: Record<string, STPASASummaryRegion>
  horizon_days: number
}

// ---- Constraint alerts ---------------------------------------------------

export type ActiveConstraint = {
  settlementdate: string
  constraintid: string
  rhs: number | null
  marginalvalue: number | null
  violationdegree: number | null
}

export type ActiveConstraints = {
  region: string
  active: ActiveConstraint[]
  as_at: string | null
  /** 0 = none, 1 = binding (shadow price only), 2 = violated */
  severity: number
}

// ---- Paper trading analytics ---------------------------------------------

export type PaperDailyPnL = {
  day: string          // "YYYY-MM-DD"
  energy_pnl: number
  fcas_pnl: number
  total_pnl: number
  cumulative: number   // running sum to this day
  n_fills: number
  win_rate: number     // % of fills with revenue > 0
}

export type PaperAnalyticsStats = {
  total_pnl: number
  pnl_7d: number
  pnl_30d: number
  annualized_aud: number
  n_fills: number
  win_rate: number
  first_fill: string | null
  last_fill: string | null
  trading_days: number
}

export type PaperAnalytics = {
  daily: PaperDailyPnL[]
  stats: PaperAnalyticsStats
}

// ---- Weather -----------------------------------------------------------------

export type WeatherRegion = {
  region: string
  city: string
  temperature: number | null
  apparent_temperature: number | null
  wind_speed_kmh: number | null
  wind_direction_deg: number | null
  solar_radiation_wm2: number | null
  precipitation_mm: number | null
  weather_code: number | null
  /** 7-day hourly series (168 items each: past 6 days + today) */
  hourly_times: string[]
  hourly_temp: number[]
  hourly_solar: number[]
  hourly_wind_speed: number[]
  hourly_wind_dir: number[]
  error?: string
}

export type NemWeather = {
  regions: WeatherRegion[]
  cache_age_s: number
}
