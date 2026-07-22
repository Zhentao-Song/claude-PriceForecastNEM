import type {
  ActiveConstraints,
  AsxFuturesResponse,
  BessBacktestRequest, BessBacktestResponse, BessBenchmarkResponse,
  BessDefaultsResponse, BessModelResponse, BessRegion,
  Bid, BidIn, BessState, BidStack, Constraints, DispatchPlan, FCASForecast, FCASMatrix, Fill, Forecast,
  ForecastAccuracy, ForecastSeries,
  GeneratorsSnapshot, GridSnapshot, Heatmap, History, MarketCatalog, OHLCData,
  MLFResponse, MLFRegionsResponse,
  NemWeather, NextIntervals, PaperAnalytics, PaperBidBatchResult, PriceForecast, Snapshot, STPASAResponse, STPASASummary, Timeline,
  VPPBid, VPPBidIn, VPPCompliance, VPPCustomerDemandCharge, VPPEnvelope,
  VPPFill, VPPMarketCatalog, VPPResourceHistory, VPPResourcePnlResponse,
  VPPRevenue, VPPState, VPPSuggestionsResponse, VPPTradingDayIn,
  VPPTradingDayResponse,
} from './types'

const BASE = '/api'

export async function fetchAsxFutures(): Promise<AsxFuturesResponse> {
  const r = await fetch(`${BASE}/asx-energy/futures`)
  if (!r.ok) throw new Error(`ASX Energy futures ${r.status}`)
  return r.json()
}

export async function fetchSnapshot(): Promise<Snapshot> {
  const r = await fetch(`${BASE}/snapshot`)
  if (!r.ok) throw new Error(`snapshot ${r.status}`)
  return r.json()
}

export async function fetchHistory(region: string, hours = 24): Promise<History> {
  const r = await fetch(`${BASE}/history?region=${encodeURIComponent(region)}&hours=${hours}`)
  if (!r.ok) throw new Error(`history ${r.status}`)
  return r.json()
}

export async function fetchOHLC(region: string, hours = 24): Promise<OHLCData> {
  // Scale bucket width to keep candle count legible (~40–80 candles per view)
  const bm = hours <= 24 ? 30 : hours <= 72 ? 60 : 120
  const r = await fetch(
    `${BASE}/prices/ohlc?region=${encodeURIComponent(region)}&hours=${hours}&bucket_minutes=${bm}`,
  )
  if (!r.ok) throw new Error(`ohlc ${r.status}`)
  return r.json()
}

export async function fetchForecast(
  region: string,
  pastHours = 24,
  futureHours = 8,
): Promise<Forecast> {
  const q = `region=${encodeURIComponent(region)}&past_hours=${pastHours}&future_hours=${futureHours}`
  const r = await fetch(`${BASE}/forecast?${q}`)
  if (!r.ok) throw new Error(`forecast ${r.status}`)
  return r.json()
}

// ---- Bid lifecycle timeline + bid stack ---------------------------------

export async function fetchTimeline(
  interval?: string,
  duid?: string,
): Promise<Timeline> {
  const q = new URLSearchParams()
  if (interval) q.set('interval', interval)
  if (duid) q.set('duid', duid)
  const qs = q.toString()
  const r = await fetch(`${BASE}/bids/timeline${qs ? `?${qs}` : ''}`)
  if (!r.ok) throw new Error(`timeline ${r.status}`)
  return r.json()
}

export async function fetchBidStack(
  interval?: string,
  bidtype = 'ENERGY',
  direction = 'GEN',
  limit = 40,
): Promise<BidStack> {
  const q = new URLSearchParams({ bidtype, direction, limit_duids: String(limit) })
  if (interval) q.set('interval', interval)
  const r = await fetch(`${BASE}/bids/stack?${q}`)
  if (!r.ok) throw new Error(`stack ${r.status}`)
  return r.json()
}

export async function fetchConstraints(
  region: string,
  hours = 6,
  limit = 500,
): Promise<Constraints> {
  const q = `region=${encodeURIComponent(region)}&hours=${hours}&limit=${limit}`
  const r = await fetch(`${BASE}/constraints?${q}`)
  if (!r.ok) throw new Error(`constraints ${r.status}`)
  return r.json()
}

export async function fetchHeatmap(days = 90): Promise<Heatmap> {
  const r = await fetch(`${BASE}/heatmap?days=${days}`)
  if (!r.ok) throw new Error(`heatmap ${r.status}`)
  return r.json()
}

export async function fetchFCAS(): Promise<FCASMatrix> {
  const r = await fetch(`${BASE}/fcas/matrix`)
  if (!r.ok) throw new Error(`fcas ${r.status}`)
  return r.json()
}

export async function fetchFCASForecast(
  region: string,
  futureHours = 1,
  powerMw = 10,
  availabilityPct = 100,
): Promise<FCASForecast> {
  const q = new URLSearchParams({
    region,
    future_hours: String(futureHours),
    power_mw: String(powerMw),
    availability_pct: String(availabilityPct),
  })
  const r = await fetch(`${BASE}/fcas/forecast?${q}`)
  if (!r.ok) throw new Error(`fcas forecast ${r.status}`)
  return r.json()
}

export async function fetchGrid(): Promise<GridSnapshot> {
  const r = await fetch(`${BASE}/grid/interconnectors/snapshot`)
  if (!r.ok) throw new Error(`grid ${r.status}`)
  return r.json()
}

export async function fetchGenerators(): Promise<GeneratorsSnapshot> {
  const r = await fetch(`${BASE}/grid/generators/snapshot`)
  if (!r.ok) throw new Error(`generators ${r.status}`)
  return r.json()
}

// ---- Paper trading -------------------------------------------------------

export async function fetchPaperState(duid = 'WTAHB1'): Promise<BessState> {
  const r = await fetch(`${BASE}/paper/state?duid=${encodeURIComponent(duid)}`)
  if (!r.ok) throw new Error(`paper state ${r.status}`)
  return r.json()
}

export async function fetchPaperIntervals(n = 6): Promise<NextIntervals> {
  const r = await fetch(`${BASE}/paper/intervals?n=${n}`)
  if (!r.ok) throw new Error(`paper intervals ${r.status}`)
  return r.json()
}

export async function fetchPaperMarkets(): Promise<MarketCatalog> {
  const r = await fetch(`${BASE}/paper/markets`)
  if (!r.ok) throw new Error(`paper markets ${r.status}`)
  return r.json()
}

export async function fetchPaperBids(duid?: string, limit = 50): Promise<{ bids: Bid[] }> {
  const q = new URLSearchParams({ limit: String(limit) })
  if (duid) q.set('duid', duid)
  const r = await fetch(`${BASE}/paper/bids?${q}`)
  if (!r.ok) throw new Error(`paper bids ${r.status}`)
  return r.json()
}

export async function fetchPaperFills(duid?: string, limit = 50): Promise<{ fills: Fill[] }> {
  const q = new URLSearchParams({ limit: String(limit) })
  if (duid) q.set('duid', duid)
  const r = await fetch(`${BASE}/paper/fills?${q}`)
  if (!r.ok) throw new Error(`paper fills ${r.status}`)
  return r.json()
}

export async function submitPaperBid(bid: BidIn): Promise<{ bid_id: number; status: string }> {
  const r = await fetch(`${BASE}/paper/bids`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bid),
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data?.detail || `paper submit ${r.status}`)
  return data
}

export async function cancelPaperBid(bid_id: number): Promise<void> {
  const r = await fetch(`${BASE}/paper/bids/${bid_id}`, { method: 'DELETE' })
  if (!r.ok) {
    const data = await r.json().catch(() => ({}))
    throw new Error(data?.detail || `cancel ${r.status}`)
  }
}

export async function resetPaperState(duid = 'WTAHB1'): Promise<void> {
  const r = await fetch(`${BASE}/paper/reset?duid=${encodeURIComponent(duid)}`, { method: 'POST' })
  if (!r.ok) throw new Error(`reset ${r.status}`)
}

export interface PaperBatchBidItem {
  target_settlementdate: string
  market?: string
  direction?: string
  bands: { price: number; mw: number }[]
}

export async function submitPaperBidBatch(
  duid: string,
  bids: PaperBatchBidItem[],
): Promise<PaperBidBatchResult> {
  const r = await fetch(`${BASE}/paper/bids/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ duid, bids }),
  })
  if (!r.ok) {
    const data = await r.json().catch(() => null)
    throw new Error(data?.detail || `batch bid ${r.status}`)
  }
  return r.json()
}

// ---- SSE -----------------------------------------------------------------

export function openSnapshotStream(onSnapshot: (s: Snapshot) => void): () => void {
  const es = new EventSource(`${BASE}/stream`)
  es.addEventListener('snapshot', (ev) => {
    try {
      onSnapshot(JSON.parse((ev as MessageEvent).data))
    } catch (e) {
      console.warn('bad snapshot', e)
    }
  })
  es.onerror = () => {
    // EventSource auto-reconnects; just log.
    console.warn('SSE error, browser will retry')
  }
  return () => es.close()
}

// ---- VPP -----------------------------------------------------------------

export async function fetchVPPState(portfolioId = 'NSW_CI_VPP'): Promise<VPPState> {
  const r = await fetch(`${BASE}/vpp/state?portfolio_id=${portfolioId}`)
  if (!r.ok) throw new Error(`vpp state ${r.status}`)
  return r.json()
}

export async function fetchVPPEnvelope(
  market: string, direction: string,
  interval?: string, portfolioId = 'NSW_CI_VPP',
): Promise<VPPEnvelope> {
  const q = new URLSearchParams({ portfolio_id: portfolioId, market, direction })
  if (interval) q.set('interval', interval)
  const r = await fetch(`${BASE}/vpp/envelope?${q}`)
  if (!r.ok) throw new Error(`vpp envelope ${r.status}`)
  return r.json()
}

export async function fetchVPPMarkets(): Promise<VPPMarketCatalog> {
  const r = await fetch(`${BASE}/vpp/markets`)
  if (!r.ok) throw new Error(`vpp markets ${r.status}`)
  return r.json()
}

export async function fetchVPPIntervals(n = 8): Promise<{ intervals: string[]; interval_minutes: number }> {
  const r = await fetch(`${BASE}/vpp/intervals?n=${n}`)
  if (!r.ok) throw new Error(`vpp intervals ${r.status}`)
  return r.json()
}

export async function fetchVPPBids(portfolioId = 'NSW_CI_VPP', limit = 50): Promise<{ bids: VPPBid[]; count: number }> {
  const r = await fetch(`${BASE}/vpp/bids?portfolio_id=${portfolioId}&limit=${limit}`)
  if (!r.ok) throw new Error(`vpp bids ${r.status}`)
  return r.json()
}

export async function submitVPPBid(bid: VPPBidIn): Promise<{ bid_id: number; status: string; envelope_mw: number; effective_commit_mw?: number; max_avail_mw?: number; allocation: { resource_id: string; alloc_kw: number }[]; trading_date: string; gate_closure: string; previous_bid_id: number | null }> {
  const r = await fetch(`${BASE}/vpp/bids`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bid),
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data?.detail || `vpp submit ${r.status}`)
  return data
}

export async function fetchVPPCompliance(portfolioId = 'NSW_CI_VPP', days = 7): Promise<VPPCompliance> {
  const r = await fetch(`${BASE}/vpp/compliance?portfolio_id=${portfolioId}&days=${days}`)
  if (!r.ok) throw new Error(`vpp compliance ${r.status}`)
  return r.json()
}

export async function submitVPPTradingDay(req: VPPTradingDayIn): Promise<VPPTradingDayResponse> {
  const r = await fetch(`${BASE}/vpp/bids/trading_day`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data?.detail || `vpp trading_day ${r.status}`)
  return data
}

export async function cancelVPPTradingDay(batchId: number): Promise<{ batch_id: number; cancelled: number[]; locked_out: number[] }> {
  const r = await fetch(`${BASE}/vpp/bids/trading_day/${batchId}`, { method: 'DELETE' })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data?.detail || `vpp trading_day cancel ${r.status}`)
  return data
}

export async function cancelVPPBid(bidId: number): Promise<void> {
  const r = await fetch(`${BASE}/vpp/bids/${bidId}`, { method: 'DELETE' })
  if (!r.ok) {
    const data = await r.json().catch(() => ({}))
    throw new Error(data?.detail || `vpp cancel ${r.status}`)
  }
}

export async function fetchVPPRevenue(portfolioId = 'NSW_CI_VPP', hours = 24): Promise<VPPRevenue> {
  const r = await fetch(`${BASE}/vpp/revenue?portfolio_id=${portfolioId}&hours=${hours}`)
  if (!r.ok) throw new Error(`vpp revenue ${r.status}`)
  return r.json()
}

export async function fetchVPPSuggestions(portfolioId = 'NSW_CI_VPP', n = 6): Promise<VPPSuggestionsResponse> {
  const r = await fetch(`${BASE}/vpp/suggestions?portfolio_id=${portfolioId}&n_intervals=${n}`)
  if (!r.ok) throw new Error(`vpp suggestions ${r.status}`)
  return r.json()
}

export async function fetchVPPCustomerDemandCharge(portfolioId = 'NSW_CI_VPP'): Promise<VPPCustomerDemandCharge> {
  const r = await fetch(`${BASE}/vpp/customer/demand-charge?portfolio_id=${portfolioId}`)
  if (!r.ok) throw new Error(`vpp customer demand-charge ${r.status}`)
  return r.json()
}

export async function fetchVPPResourceHistory(resourceId: string, hours = 24): Promise<VPPResourceHistory> {
  const r = await fetch(`${BASE}/vpp/resources/${resourceId}/history?hours=${hours}`)
  if (!r.ok) throw new Error(`vpp resource history ${r.status}`)
  return r.json()
}

export async function fetchVPPResourcesPnl(portfolioId = 'NSW_CI_VPP', hours = 24): Promise<VPPResourcePnlResponse> {
  const r = await fetch(`${BASE}/vpp/resources/pnl?portfolio_id=${portfolioId}&hours=${hours}`)
  if (!r.ok) throw new Error(`vpp resources pnl ${r.status}`)
  return r.json()
}

export async function fetchVPPFills(portfolioId = 'NSW_CI_VPP', limit = 50): Promise<{ fills: VPPFill[]; count: number }> {
  const r = await fetch(`${BASE}/vpp/fills?portfolio_id=${portfolioId}&limit=${limit}`)
  if (!r.ok) throw new Error(`vpp fills ${r.status}`)
  return r.json()
}

export async function toggleVPPResource(resourceId: string, optedIn: boolean): Promise<void> {
  const r = await fetch(`${BASE}/vpp/resources/${resourceId}/opt?opted_in=${optedIn}`, {
    method: 'POST',
  })
  if (!r.ok) {
    const data = await r.json().catch(() => ({}))
    throw new Error(data?.detail || `vpp toggle ${r.status}`)
  }
}

// ---- BESS-Calc -----------------------------------------------------------

export async function fetchBessDefaults(region: BessRegion = 'NSW1', lookbackDays = 90): Promise<BessDefaultsResponse> {
  const r = await fetch(`${BASE}/bess/defaults?region=${region}&lookback_days=${lookbackDays}`)
  if (!r.ok) throw new Error(`bess defaults ${r.status}`)
  return r.json()
}

export async function modelBess(payload: Record<string, unknown>, withSensitivity = true): Promise<BessModelResponse> {
  const r = await fetch(`${BASE}/bess/model?with_sensitivity=${withSensitivity}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((data as any)?.detail || `bess model ${r.status}`)
  return data
}

export async function backtestBess(req: BessBacktestRequest): Promise<BessBacktestResponse> {
  const r = await fetch(`${BASE}/bess/backtest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((data as any)?.detail || `bess backtest ${r.status}`)
  return data
}

export async function fetchBessBenchmarks(params: {
  region: BessRegion
  power_mw: number
  duration_h: number
  rte_pct: number
  mlf: number
  aux_load_pct: number
  deg_cost_per_mwh: number
  max_cycles_per_day: number
}): Promise<BessBenchmarkResponse> {
  const query = new URLSearchParams(
    Object.entries(params).map(([key, value]) => [key, String(value)]),
  )
  const r = await fetch(`${BASE}/bess/benchmarks?${query}`)
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((data as any)?.detail || `bess benchmarks ${r.status}`)
  return data as BessBenchmarkResponse
}

export async function startBessBackfill(lookbackDays = 400): Promise<{
  started: boolean; already_running: boolean; months_total: number
  running: boolean; done: boolean; db_days_nsw1?: number
}> {
  const r = await fetch(`${BASE}/bess/backfill?lookback_days=${lookbackDays}`, { method: 'POST' })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((data as any)?.detail || `bess backfill ${r.status}`)
  return data
}

export async function fetchPriceForecast(region: string): Promise<PriceForecast> {
  const r = await fetch(`${BASE}/price-forecast?region=${encodeURIComponent(region)}`)
  if (!r.ok) throw new Error(`price-forecast ${r.status}`)
  return r.json()
}

export async function fetchForecastSeries(
  region: string, pastHours = 12,
): Promise<ForecastSeries> {
  const r = await fetch(
    `${BASE}/forecast/series?region=${encodeURIComponent(region)}&past_hours=${pastHours}`)
  if (!r.ok) throw new Error(`forecast-series ${r.status}`)
  return r.json()
}

export async function fetchForecastAccuracy(
  region: string, windowDays = 30,
): Promise<ForecastAccuracy> {
  const r = await fetch(
    `${BASE}/forecast/accuracy?region=${encodeURIComponent(region)}&window_days=${windowDays}`)
  if (!r.ok) throw new Error(`forecast-accuracy ${r.status}`)
  return r.json()
}

export async function fetchBessBackfillStatus(): Promise<{
  running: boolean; done: boolean; months_total: number; months_done: number
  current_month: string | null; db_days_nsw1: number
  progress: { month: string; status: string; rows: number; detail?: string }[]
}> {
  const r = await fetch(`${BASE}/bess/backfill/status`)
  if (!r.ok) throw new Error(`bess backfill status ${r.status}`)
  return r.json()
}

// ---- MLF (Marginal Loss Factor) -----------------------------------------

export async function fetchMLF(
  region?: string,
  fuelType?: string,
): Promise<MLFResponse> {
  const q = new URLSearchParams()
  if (region) q.set('region', region)
  if (fuelType) q.set('fuel_type', fuelType)
  const qs = q.toString()
  const r = await fetch(`${BASE}/mlf${qs ? `?${qs}` : ''}`)
  if (!r.ok) throw new Error(`mlf ${r.status}`)
  return r.json()
}

export async function fetchMLFRegions(): Promise<MLFRegionsResponse> {
  const r = await fetch(`${BASE}/mlf/regions`)
  if (!r.ok) throw new Error(`mlf/regions ${r.status}`)
  return r.json()
}

// ---- Real-time BESS Dispatch Plan ----------------------------------------

export async function fetchDispatchPlan(
  duid = 'WTAHB1',
  region = 'NSW1',
  nIntervals = 24,
): Promise<DispatchPlan> {
  const q = new URLSearchParams({
    duid,
    region,
    n_intervals: String(nIntervals),
  })
  const r = await fetch(`${BASE}/bess/dispatch-plan?${q}`)
  if (!r.ok) throw new Error(`dispatch-plan ${r.status}`)
  return r.json()
}

// ---- ST PASA --------------------------------------------------------------

export async function fetchSTPASA(region: string, days = 14): Promise<STPASAResponse> {
  const q = new URLSearchParams({ region, days: String(days) })
  const r = await fetch(`${BASE}/pasa/st?${q}`)
  if (!r.ok) throw new Error(`pasa/st ${r.status}`)
  return r.json()
}

export async function fetchSTPASASummary(): Promise<STPASASummary> {
  const r = await fetch(`${BASE}/pasa/st/summary`)
  if (!r.ok) throw new Error(`pasa/st/summary ${r.status}`)
  return r.json()
}

// ---- Constraint alerts ---------------------------------------------------

export async function fetchActiveConstraints(region: string): Promise<ActiveConstraints> {
  const q = new URLSearchParams({ region })
  const r = await fetch(`${BASE}/constraints/active?${q}`)
  if (!r.ok) throw new Error(`constraints/active ${r.status}`)
  return r.json()
}

// ---- Paper trading analytics ---------------------------------------------

export async function fetchPaperAnalytics(duid: string): Promise<PaperAnalytics> {
  const r = await fetch(`${BASE}/paper/analytics?duid=${encodeURIComponent(duid)}`)
  if (!r.ok) throw new Error(`paper analytics ${r.status}`)
  return r.json()
}


export async function fetchNemWeather(): Promise<NemWeather> {
  const r = await fetch(`${BASE}/weather/nem`)
  if (!r.ok) throw new Error(`weather ${r.status}`)
  return r.json()
}
