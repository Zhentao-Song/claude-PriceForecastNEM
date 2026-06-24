import { useEffect, useMemo, useState } from 'react'
import {
  cancelVPPBid, fetchVPPBids, fetchVPPCustomerDemandCharge, fetchVPPEnvelope,
  fetchVPPIntervals, fetchVPPMarkets, fetchVPPResourceHistory,
  fetchVPPResourcesPnl, fetchVPPRevenue, fetchVPPState, fetchVPPSuggestions,
  submitVPPBid, submitVPPTradingDay, toggleVPPResource,
} from '../api'
import { BidLifecycleTimeline } from './BidLifecycleTimeline'
import { ComplianceScorecard } from './ComplianceScorecard'
import { VPPCompetitorBids } from './VPPCompetitorBids'
import type {
  VPPBid, VPPChannel, VPPClassification, VPPCustomerDemandCharge,
  VPPDispatchType, VPPEnvelope, VPPFcasTrapezium, VPPMarketCatalog,
  VPPResource, VPPResourceHistory, VPPResourceKind, VPPResourcePnl,
  VPPRevenue, VPPRetailPlan, VPPState, VPPSuggestion,
} from '../types'
import { useT } from '../i18n'

// Default FCAS trapezium response-time presets per market.
// T1 = response delay, T2 = ramp-to-full, T3 = hold, T4 = release.
// Sum T1+T2 must fit within the market's mandated response window.
const FCAS_DEFAULTS: Record<string, { t1: number; t2: number; t3: number; t4: number }> = {
  RAISE1SEC:  { t1: 0.0, t2: 1.0, t3: 10, t4: 5 },
  LOWER1SEC:  { t1: 0.0, t2: 1.0, t3: 10, t4: 5 },
  RAISE6SEC:  { t1: 0.5, t2: 5.5, t3: 60, t4: 30 },
  LOWER6SEC:  { t1: 0.5, t2: 5.5, t3: 60, t4: 30 },
  RAISE60SEC: { t1: 1.0, t2: 59,  t3: 300, t4: 60 },
  LOWER60SEC: { t1: 1.0, t2: 59,  t3: 300, t4: 60 },
  RAISE5MIN:  { t1: 5,   t2: 295, t3: 600, t4: 60 },
  LOWER5MIN:  { t1: 5,   t2: 295, t3: 600, t4: 60 },
  RAISEREG:   { t1: 0.5, t2: 3.5, t3: 300, t4: 5 },
  LOWERREG:   { t1: 0.5, t2: 3.5, t3: 300, t4: 5 },
}

/**
 * Sensible default price ladder per (market, direction). Anchors picked
 * from typical NSW1 2024-2026 clearing ranges, so band 1 nearly always
 * clears, band 2 clears in normal market, band 3 captures spikes.
 *   ENERGY GEN  ($/MWh):  low ladder so you discharge into anything bullish.
 *   ENERGY LOAD ($/MWh):  bid HIGH so you charge only when cheap (NEMDE
 *                          clears LOAD bands at price ≥ RRP; band 1 is
 *                          the "always charge" floor, band 3 is "willing
 *                          to pay this much").
 *   RAISE FCAS ($/MW/h):  $1/$5/$30 covers calm/normal/contingency.
 *   LOWER FCAS:           cheaper than raise; $0.5/$3/$15.
 *   REG FCAS:             $5/$20/$80 — regulation runs hotter than
 *                          contingency in modern NSW.
 */
function defaultPriceLadder(market: string, direction: string): number[] {
  if (market === 'ENERGY') {
    return direction === 'GEN' ? [50, 150, 500] : [10, 30, 80]
  }
  if (market === 'RAISEREG') return [5, 20, 80]
  if (market === 'LOWERREG') return [2, 10, 40]
  if (market.startsWith('RAISE')) return [1, 5, 30]
  if (market.startsWith('LOWER')) return [0.5, 3, 15]
  return [1, 5, 30]
}

/**
 * Distribute MW across 3 bands totalling ≤ 90% of envelope, front-loaded
 * 40 / 35 / 25 so the cheapest band carries the most MW — matches how
 * real participants size ladders to maximise expected fill at low risk.
 * Rounded to 0.1 MW so the inputs read cleanly.
 */
function defaultBandMw(envelopeMw: number): number[] {
  if (!Number.isFinite(envelopeMw) || envelopeMw <= 0) return [0.1, 0.1, 0.1]
  const usable = envelopeMw * 0.9
  return [usable * 0.40, usable * 0.35, usable * 0.25]
    .map(x => Math.max(0.1, Math.round(x * 10) / 10))
}

const PORTFOLIO_ID = 'NSW_CI_VPP'

const KIND_LABEL: Record<VPPResourceKind, string> = {
  bess: 'BESS',
  evcharger: 'EV charger',
}
const KIND_COLOR: Record<VPPResourceKind, string> = {
  bess: '#0a84ff',
  evcharger: '#34c759',
}

/**
 * VPP trading console — C&I aggregator view.
 *
 * Three panels:
 *  1. Portfolio summary (top): nameplate, available now, BESS SoC, P&L
 *  2. Resource roster (left): per-site capability, opt-in toggle
 *  3. Bid composer (right): 10-band ladder + market/direction/reason
 *  4. Bid ledger (bottom): live PENDING / SETTLED / CANCELLED list
 *
 * Each interaction round-trips to `/api/vpp/*` which enforces AEMO rules
 * server-side (monotonic bands, gate closure, capability check, envelope
 * limit). UI mirrors those checks for instant feedback but server is
 * authoritative.
 */
export function VPPConsole() {
  const { t } = useT()
  const [state, setState] = useState<VPPState | null>(null)
  const [markets, setMarkets] = useState<VPPMarketCatalog | null>(null)
  const [intervals, setIntervals] = useState<string[]>([])
  const [bids, setBids] = useState<VPPBid[]>([])
  const [envelope, setEnvelope] = useState<VPPEnvelope | null>(null)
  const [revenue, setRevenue] = useState<VPPRevenue | null>(null)
  const [resourcePnl, setResourcePnl] = useState<VPPResourcePnl[]>([])
  const [suggestions, setSuggestions] = useState<VPPSuggestion[]>([])
  const [demandCharge, setDemandCharge] = useState<VPPCustomerDemandCharge | null>(null)
  const [expandedResource, setExpandedResource] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Bid form state
  /** 'single' = traditional per-interval BIDPEROFFER. 'trading_day' =
   *  BIDDAYOFFER-style bulk submit across every open interval in the day. */
  const [bidMode, setBidMode] = useState<'single' | 'trading_day'>('single')
  const [targetInterval, setTargetInterval] = useState<string>('')
  const [tradingDate, setTradingDate] = useState<string>(() => {
    // Default to current NEM trading day (UTC+10). Note: NEM trading day
    // boundary is 04:00 — we approximate by taking the NEM-local date.
    const nem = new Date(Date.now() + 10 * 3600 * 1000)
    return nem.toISOString().slice(0, 10)
  })
  const [market, setMarket] = useState<string>('RAISE6SEC')
  const [direction, setDirection] = useState<'GEN' | 'LOAD'>('GEN')
  const [reasonCode, setReasonCode] = useState<string>('INITIAL')
  const [reasonNote, setReasonNote] = useState<string>('')
  // Bands are smart-defaulted from (market, direction, envelope) and
  // re-derived whenever those change — UNTIL the user manually edits a
  // band, at which point we lock the values (`bandsTouched=true`). This
  // mirrors how the AEMO web bidding form behaves: sensible starting
  // point, but never silently overwrites operator intent.
  const [bands, setBands] = useState<{ price: string; mw: string }[]>(() => {
    const prices = defaultPriceLadder('RAISE6SEC', 'GEN')
    return prices.map(p => ({ price: String(p), mw: '0.1' }))
  })
  const [bandsTouched, setBandsTouched] = useState(false)
  // Advanced operational params (all empty = use server defaults).
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [maxAvailMw, setMaxAvailMw] = useState<string>('')
  const [dailyEnergyMwh, setDailyEnergyMwh] = useState<string>('')
  const [rampUp, setRampUp] = useState<string>('')
  const [rampDown, setRampDown] = useState<string>('')
  // FCAS trapezium fields (only used when market is FCAS).
  const [trapEnMin, setTrapEnMin] = useState<string>('0')
  const [trapLowBp, setTrapLowBp] = useState<string>('0')
  const [trapHighBp, setTrapHighBp] = useState<string>('')   // auto-default from MaxAvail
  const [trapEnMax, setTrapEnMax] = useState<string>('')     // auto-default from MaxAvail
  const [trapT1, setTrapT1] = useState<string>('0.5')
  const [trapT2, setTrapT2] = useState<string>('5.5')
  const [trapT3, setTrapT3] = useState<string>('60')
  const [trapT4, setTrapT4] = useState<string>('30')
  const [includeTrapezium, setIncludeTrapezium] = useState(true)

  const [submitting, setSubmitting] = useState(false)
  const [submitMsg, setSubmitMsg] = useState<string | null>(null)

  // Compliance scorecard is hidden by default — operators don't want to
  // lead with "audit yourself" view. Surfaced as a small footer chip at
  // the very bottom of the page; clicking expands inline above the chip.
  // Lazy mounted (component only renders when toggled true) so the
  // /api/vpp/compliance fetch doesn't fire until needed.
  const [showCompliance, setShowCompliance] = useState(false)

  // When market changes to an FCAS one, load sensible response-time defaults.
  const isFcas = market !== 'ENERGY'
  useEffect(() => {
    const d = FCAS_DEFAULTS[market]
    if (d) {
      setTrapT1(String(d.t1)); setTrapT2(String(d.t2))
      setTrapT3(String(d.t3)); setTrapT4(String(d.t4))
    }
  }, [market])

  // ---- Refresh loop ------------------------------------------------------

  const refresh = async () => {
    try {
      const [s, m, ivs, b, rev, pnl, sug, dc] = await Promise.all([
        fetchVPPState(PORTFOLIO_ID),
        fetchVPPMarkets(),
        fetchVPPIntervals(8),
        fetchVPPBids(PORTFOLIO_ID, 50),
        fetchVPPRevenue(PORTFOLIO_ID, 24),
        fetchVPPResourcesPnl(PORTFOLIO_ID, 24),
        fetchVPPSuggestions(PORTFOLIO_ID, 6),
        fetchVPPCustomerDemandCharge(PORTFOLIO_ID),
      ])
      setState(s); setMarkets(m); setIntervals(ivs.intervals)
      setBids(b.bids); setRevenue(rev); setResourcePnl(pnl.resources)
      setSuggestions(sug.suggestions); setDemandCharge(dc)
      if (!targetInterval && ivs.intervals.length > 0) setTargetInterval(ivs.intervals[0])
    } catch (e) {
      setError(String((e as Error).message ?? e))
    }
  }

  // One-click submit a suggested bid
  const acceptSuggestion = async (s: VPPSuggestion) => {
    try {
      await submitVPPBid({
        portfolio_id: PORTFOLIO_ID,
        target_settlementdate: s.target_settlementdate,
        market: s.market, direction: s.direction,
        bands: s.bands,
        rebid_reason: 'FORECAST',
        notes: 'algorithmic suggestion · ' + s.rationale,
      })
      await refresh()
    } catch (e) {
      setError(String((e as Error).message ?? e))
    }
  }
  useEffect(() => {
    refresh()
    const id = window.setInterval(refresh, 60_000)
    return () => window.clearInterval(id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-compute envelope when (market/direction/interval) change.
  useEffect(() => {
    if (!targetInterval) return
    let cancel = false
    fetchVPPEnvelope(market, direction, targetInterval, PORTFOLIO_ID)
      .then((env) => { if (!cancel) setEnvelope(env) })
      .catch((e) => { if (!cancel) setError(String((e as Error).message ?? e)) })
    return () => { cancel = true }
  }, [market, direction, targetInterval])

  // ---- Resource roster actions ------------------------------------------

  const toggle = async (rid: string, currentlyIn: boolean) => {
    try {
      await toggleVPPResource(rid, !currentlyIn)
      await refresh()
    } catch (e) {
      setError(String((e as Error).message ?? e))
    }
  }

  // ---- Bid form actions -------------------------------------------------

  const addBand = () => {
    if (bands.length >= 10) return
    const last = bands[bands.length - 1]
    const nextPrice = Math.round((Number(last.price) || 0) + 5)
    setBandsTouched(true)
    setBands([...bands, { price: String(nextPrice), mw: last.mw }])
  }
  const removeBand = (i: number) => {
    setBandsTouched(true)
    setBands(bands.filter((_, j) => j !== i))
  }
  const updateBand = (i: number, k: 'price' | 'mw', v: string) => {
    setBandsTouched(true)
    setBands(bands.map((b, j) => j === i ? { ...b, [k]: v } : b))
  }

  /** Hard reset back to the smart defaults for the current market/envelope.
   *  Bound to the "Reset" button next to the band ladder. */
  const resetBandsToDefaults = () => {
    const prices = defaultPriceLadder(market, direction)
    const mws = defaultBandMw(envelope?.envelope_mw ?? 0)
    setBands(prices.map((p, i) => ({ price: String(p), mw: String(mws[i] ?? 0.1) })))
    setBandsTouched(false)
  }

  // Auto-regenerate the ladder whenever (market, direction, envelope.envelope_mw)
  // change — but ONLY if the user hasn't manually edited. Once they type
  // in any band, we respect their values until they hit "Reset".
  useEffect(() => {
    if (bandsTouched) return
    const prices = defaultPriceLadder(market, direction)
    const mws = defaultBandMw(envelope?.envelope_mw ?? 0)
    setBands(prices.map((p, i) => ({ price: String(p), mw: String(mws[i] ?? 0.1) })))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market, direction, envelope?.envelope_mw, bandsTouched])

  // Local validation mirror — shows red text inline before submit.
  const localErrors = useMemo(() => {
    const errs: string[] = []
    const numeric = bands.map((b) => ({ price: Number(b.price), mw: Number(b.mw) }))
    if (numeric.some((b) => !Number.isFinite(b.price) || !Number.isFinite(b.mw))) {
      errs.push('All band prices and MW must be numbers')
    }
    if (numeric.some((b) => b.mw < 0)) errs.push('MW cannot be negative')
    if (markets) {
      if (numeric.some((b) => b.price < markets.mpf || b.price > markets.mpc)) {
        errs.push(`Prices must be within [${markets.mpf}, ${markets.mpc}]`)
      }
    }
    for (let i = 1; i < numeric.length; i++) {
      if (numeric[i].price <= numeric[i - 1].price) {
        errs.push(`Band ${i + 1} price must be > band ${i} (monotonic ascending)`)
        break
      }
    }
    // ----- BIDPEROFFER cumulative-vs-envelope check -----
    const cumMw = numeric.reduce((s, b) => s + (Number.isFinite(b.mw) ? b.mw : 0), 0)
    const maxAvail = maxAvailMw.trim() === '' ? null : Number(maxAvailMw)
    // Effective commitment = min(sum_of_bands, MaxAvail) — what NEMDE caps you to.
    const effectiveMw = maxAvail != null && Number.isFinite(maxAvail) ? Math.min(cumMw, maxAvail) : cumMw
    if (envelope && bidMode === 'single' && effectiveMw > envelope.envelope_mw + 1e-6) {
      errs.push(
        `Effective commit ${effectiveMw.toFixed(2)} MW exceeds envelope ` +
        `${envelope.envelope_mw.toFixed(2)} MW (NEMDE clears cheapest band first, ` +
        `caps at MaxAvail). Reduce band MW or raise MaxAvail.`
      )
    }
    if (maxAvail != null) {
      if (maxAvail < 0) errs.push('MaxAvail cannot be negative')
      if (maxAvail > cumMw + 1e-6) {
        // Not an error per se — but a logically useless setting.
        // Show as info rather than hard block (skip pushing to errs).
      }
    }
    // ----- FCAS trapezium consistency -----
    if (isFcas && includeTrapezium) {
      const enMin = Number(trapEnMin)
      const low = Number(trapLowBp)
      const high = trapHighBp.trim() === '' ? (maxAvail ?? cumMw) : Number(trapHighBp)
      const enMax = trapEnMax.trim() === '' ? high : Number(trapEnMax)
      if (!(enMin <= low + 1e-9 && low <= high + 1e-9 && high <= enMax + 1e-9)) {
        errs.push(`Trapezium: enablement_min (${enMin}) ≤ low_bp (${low}) ≤ high_bp (${high.toFixed(2)}) ≤ enablement_max (${enMax.toFixed(2)}) violated`)
      }
      const t1 = Number(trapT1), t2 = Number(trapT2)
      const responseSec = t1 + t2
      const requiredSec: Record<string, number> = {
        RAISE1SEC: 1, LOWER1SEC: 1, RAISE6SEC: 6, LOWER6SEC: 6,
        RAISE60SEC: 60, LOWER60SEC: 60, RAISE5MIN: 300, LOWER5MIN: 300,
        RAISEREG: 4, LOWERREG: 4,
      }
      const required = requiredSec[market]
      if (required != null && responseSec > required + 0.01) {
        errs.push(`${market} requires response within ${required}s (MASS) — T1+T2 = ${responseSec}s exceeds`)
      }
      if (Number(trapT3) <= 0) errs.push('T3 (hold duration) must be > 0s')
    }
    return errs
  }, [bands, markets, envelope, bidMode, maxAvailMw, isFcas, includeTrapezium,
       trapEnMin, trapLowBp, trapHighBp, trapEnMax, trapT1, trapT2, trapT3, market])

  /** Helper — collect the optional advanced params into a payload chunk. */
  const buildAdvancedPayload = () => {
    const n = (s: string) => (s.trim() === '' ? null : Number(s))
    const maxAvail = n(maxAvailMw)
    // Trapezium: include only when market is FCAS AND user enabled it.
    let trapezium: VPPFcasTrapezium | null = null
    if (isFcas && includeTrapezium) {
      const highBp = n(trapHighBp) ?? (maxAvail ?? bands.reduce((s,b)=>s+Number(b.mw),0))
      const enMax = n(trapEnMax) ?? highBp
      trapezium = {
        enablement_min_mw: n(trapEnMin) ?? 0,
        low_breakpoint_mw: n(trapLowBp) ?? 0,
        high_breakpoint_mw: highBp,
        enablement_max_mw: enMax,
        t1_sec: n(trapT1) ?? 0,
        t2_sec: n(trapT2) ?? 0,
        t3_sec: n(trapT3) ?? 0,
        t4_sec: n(trapT4) ?? 0,
      }
    }
    return {
      max_avail_mw: maxAvail,
      daily_energy_constraint_mwh: n(dailyEnergyMwh),
      ramp_up_mw_per_min: n(rampUp),
      ramp_down_mw_per_min: n(rampDown),
      fcas_trapezium: trapezium,
    }
  }

  const submit = async () => {
    setSubmitMsg(null); setError(null)
    if (localErrors.length > 0) { setError(localErrors[0]); return }
    setSubmitting(true)
    const numericBands = bands.map((b) => ({ price: Number(b.price), mw: Number(b.mw) }))
    const adv = buildAdvancedPayload()
    try {
      if (bidMode === 'single') {
        if (!targetInterval) { setError('Choose a target interval first'); return }
        const result = await submitVPPBid({
          portfolio_id: PORTFOLIO_ID,
          target_settlementdate: targetInterval,
          market, direction,
          bands: numericBands,
          rebid_reason: reasonCode,
          notes: reasonNote || null,
          ...adv,
        })
        setSubmitMsg(
          `Bid #${result.bid_id} submitted · ${result.allocation.length} resources allocated` +
          (result.effective_commit_mw != null
            ? ` · ${result.effective_commit_mw.toFixed(2)} MW effective`
            : '')
        )
      } else {
        if (!tradingDate) { setError('Choose a trading date first'); return }
        const result = await submitVPPTradingDay({
          portfolio_id: PORTFOLIO_ID,
          trading_date: tradingDate,
          market, direction,
          bands: numericBands,
          rebid_reason: reasonCode,
          notes: reasonNote || null,
          ...adv,
        })
        setSubmitMsg(
          `Batch #${result.batch_id} · ${result.created_count}/${result.open_intervals} intervals submitted` +
          (result.skipped_count ? ` · ${result.skipped_count} skipped (envelope tight)` : '')
        )
      }
      await refresh()
    } catch (e) {
      setError(String((e as Error).message ?? e))
    } finally {
      setSubmitting(false)
    }
  }

  const cancel = async (id: number) => {
    if (!confirm(`Cancel VPP bid #${id}?`)) return
    try {
      await cancelVPPBid(id)
      await refresh()
    } catch (e) {
      setError(String((e as Error).message ?? e))
    }
  }

  // ---- Render -----------------------------------------------------------

  if (!state || !markets) {
    return (
      <div className="h-64 flex items-center justify-center text-muted text-sm">
        {t('chart.loading')}
      </div>
    )
  }

  const { portfolio, resources, aggregate } = state

  return (
    <div className="space-y-6">
      {/* ============================ AEMO BID LIFECYCLE =================== */}
      {/* Educational walkthrough — sits at the top so team members + visitors
          can map our UI back to AEMO's actual workflow before drilling into
          specific bids. Click any stage node to expand the detail panel. */}
      <BidLifecycleTimeline />

      {/* ============================ PORTFOLIO HEADER =================== */}
      <section className="bg-surface rounded-xl2 p-6 shadow-card">
        <div className="flex items-baseline justify-between flex-wrap gap-3">
          <div>
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-muted">
              {t('vpp.kicker')}
              <ClassificationBadge cls={portfolio.classification} />
            </div>
            <div className="text-[22px] font-semibold tracking-tight text-ink mt-1">
              {portfolio.display_name}
            </div>
            <div className="text-[12px] text-muted mt-0.5 tabular-nums">
              {portfolio.registered_duid} · {portfolio.region} · baseline {portfolio.baseline_method} · {t('vpp.customerShare', portfolio.customer_share_pct.toFixed(0))}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[11px] uppercase tracking-[0.22em] text-muted">
              {t('vpp.cumPnl')}
            </div>
            <div className={`text-[28px] font-semibold tabular-nums ${
              portfolio.cumulative_pnl_aud >= 0 ? 'text-positive' : 'text-negative'
            }`}>
              {portfolio.cumulative_pnl_aud >= 0 ? '+' : '−'}${Math.abs(portfolio.cumulative_pnl_aud).toLocaleString('en-AU', { maximumFractionDigits: 0 })}
            </div>
          </div>
        </div>

        {/* Aggregate metric strip */}
        <div className="mt-5 grid grid-cols-2 md:grid-cols-5 gap-3">
          <MetricCard
            label={t('vpp.nameplate')}
            value={`${(aggregate.total_nameplate_kw / 1000).toFixed(2)} MW`}
            sub={
              aggregate.scheduled_kw !== undefined
                ? `${(aggregate.scheduled_kw / 1000).toFixed(1)} MW NEMDE · ${(aggregate.non_scheduled_kw / 1000).toFixed(1)} MW BTM`
                : `${aggregate.opted_in_count}/${aggregate.resource_count} ${t('vpp.optedIn')}`
            }
          />
          <MetricCard
            label={t('vpp.availableNow')}
            value={`${(aggregate.total_available_now_kw / 1000).toFixed(2)} MW`}
            sub={`${(aggregate.total_available_now_kw / aggregate.total_nameplate_kw * 100).toFixed(0)}% ${t('vpp.ofNameplate')}`}
            accent="positive"
          />
          <MetricCard
            label={t('vpp.bessFleet')}
            value={`${aggregate.bess_count} ${t('vpp.sites')}`}
            sub={`${(aggregate.bess_capacity_kwh / 1000).toFixed(1)} MWh capacity`}
          />
          <MetricCard
            label={t('vpp.bessSoc')}
            value={`${aggregate.bess_soc_pct.toFixed(0)}%`}
            sub={`${(aggregate.bess_soc_kwh / 1000).toFixed(1)} / ${(aggregate.bess_capacity_kwh / 1000).toFixed(1)} MWh`}
            accent={aggregate.bess_soc_pct >= 80 ? 'positive' : aggregate.bess_soc_pct <= 20 ? 'warn' : 'muted'}
          />
          <MetricCard
            label={t('vpp.evFleet')}
            value={`${aggregate.ev_charger_count} ${t('vpp.sites')}`}
            sub={`${Math.round(resources.filter(r => r.kind === 'evcharger').reduce((s, r) => s + r.nameplate_kw, 0) / 1000 * 10) / 10} MW curtail`}
            accent="charge"
          />
        </div>
      </section>

      {/* ============================ REVENUE BREAKDOWN ===================== */}
      {/* Answers the "Energy vs FCAS, which is bigger?" question. Wholesale
          buckets come from settled vpp_fill rows; the customer demand-charge
          slice is an estimate from BESS resources × an assumed network
          demand charge × the configured VPP share. Bar widths are %, so the
          visual conveys mix even when the absolute revenue is small. */}
      {revenue && (
        <RevenueBreakdown rev={revenue} t={t} />
      )}

      {/* ============================ ALGO SUGGESTED BIDS =================== */}
      {/* AEMO forecast → 10-band ladder per (interval, market). One-click
          submit pushes to /api/vpp/bids with reason=FORECAST. */}
      {suggestions.length > 0 && (
        <SuggestionsSection suggestions={suggestions} onAccept={acceptSuggestion} t={t} />
      )}

      {/* ============================ CUSTOMER DEMAND-CHARGE ================ */}
      {demandCharge && (demandCharge.active_sites.length > 0 || demandCharge.idle_sites.length > 0) && (
        <CustomerDemandChargeCard d={demandCharge} t={t} />
      )}

      {/* ============================ ROSTER + BID FORM ===================== */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-5">
        {/* ---------- Roster ---------- */}
        <section className="bg-surface rounded-xl2 p-6 shadow-card">
          <div className="flex items-baseline justify-between mb-3">
            <div>
              <div className="text-[15px] font-semibold tracking-tight text-ink">
                {t('vpp.roster.title')}
              </div>
              <div className="text-[12px] text-muted mt-0.5">{t('vpp.roster.hint')}</div>
            </div>
          </div>
          <div className="overflow-x-auto -mx-2">
            <table className="w-full text-[12px] border-separate border-spacing-0">
              <thead className="text-muted text-[10px] uppercase tracking-wide">
                <tr>
                  <th className="text-left  px-3 py-2 font-medium whitespace-nowrap">{t('vpp.col.site')}</th>
                  <th className="text-left  px-3 py-2 font-medium whitespace-nowrap">{t('vpp.col.kind')}</th>
                  <th className="text-right px-3 py-2 font-medium whitespace-nowrap">{t('vpp.col.kw')}</th>
                  <th className="text-left  px-3 py-2 font-medium whitespace-nowrap">{t('vpp.col.soc')}</th>
                  <th className="text-right px-3 py-2 font-medium whitespace-nowrap">{t('vpp.col.pnl24h')}</th>
                  <th className="text-center px-3 py-2 font-medium whitespace-nowrap">{t('vpp.col.events')}</th>
                  <th className="text-left  px-3 py-2 font-medium whitespace-nowrap">{t('vpp.col.window')}</th>
                  <th className="text-left  px-3 py-2 font-medium whitespace-nowrap">{t('vpp.col.caps')}</th>
                  <th className="text-center px-3 py-2 font-medium whitespace-nowrap">{t('vpp.col.optIn')}</th>
                </tr>
              </thead>
              <tbody>
                {resources.map((r) => (
                  <ResourceRow
                    key={r.resource_id} r={r}
                    pnl={resourcePnl.find((p) => p.resource_id === r.resource_id) ?? null}
                    expanded={expandedResource === r.resource_id}
                    onToggle={() => toggle(r.resource_id, !!r.opted_in)}
                    onExpand={() => setExpandedResource(
                      expandedResource === r.resource_id ? null : r.resource_id
                    )}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* ---------- Bid form ---------- */}
        <section className="bg-surface rounded-xl2 p-6 shadow-card">
          <div className="flex items-baseline justify-between mb-1">
            <div className="text-[15px] font-semibold tracking-tight text-ink">
              {t('vpp.bid.title')}
            </div>
            {/* Mode toggle — single interval (BIDPEROFFER) vs trading day (BIDDAYOFFER). */}
            <div className="inline-flex rounded-md bg-surfaceAlt p-0.5 text-[11px]">
              <button
                onClick={() => setBidMode('single')}
                className={`px-2.5 py-1 rounded font-medium transition-colors ${
                  bidMode === 'single' ? 'bg-surface shadow-sm text-ink' : 'text-muted hover:text-ink'
                }`}
              >
                {t('vpp.bid.modeSingle')}
              </button>
              <button
                onClick={() => setBidMode('trading_day')}
                className={`px-2.5 py-1 rounded font-medium transition-colors ${
                  bidMode === 'trading_day' ? 'bg-surface shadow-sm text-ink' : 'text-muted hover:text-ink'
                }`}
              >
                {t('vpp.bid.modeDay')}
              </button>
            </div>
          </div>
          <div className="text-[12px] text-muted mt-0.5 mb-4">
            {bidMode === 'single' ? t('vpp.bid.hint') : t('vpp.bid.hintDay')}
          </div>

          {/* Target interval / trading day + market + direction */}
          <div className="grid grid-cols-3 gap-3 mb-3">
            <Field label={bidMode === 'single' ? t('vpp.bid.target') : t('vpp.bid.targetDay')}>
              {bidMode === 'single' ? (
                <select
                  value={targetInterval}
                  onChange={(e) => setTargetInterval(e.target.value)}
                  className="w-full text-[12px] border border-hairlineSoft rounded px-2 py-1.5 bg-surface focus:outline-none focus:border-accent"
                >
                  {intervals.map((iv) => (
                    <option key={iv} value={iv}>{fmtInterval(iv)}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="date"
                  value={tradingDate}
                  onChange={(e) => setTradingDate(e.target.value)}
                  className="w-full text-[12px] border border-hairlineSoft rounded px-2 py-1.5 bg-surface focus:outline-none focus:border-accent tabular-nums"
                />
              )}
            </Field>
            <Field label={t('vpp.bid.market')}>
              <select
                value={market}
                onChange={(e) => {
                  const m = e.target.value
                  setMarket(m)
                  // Auto-set direction by market category
                  if (markets.lower_fcas.includes(m)) setDirection('LOAD')
                  else if (markets.raise_fcas.includes(m)) setDirection('GEN')
                }}
                className="w-full text-[12px] border border-hairlineSoft rounded px-2 py-1.5 bg-surface focus:outline-none focus:border-accent"
              >
                <optgroup label="Energy">
                  {markets.energy.map((m) => <option key={m} value={m}>{m}</option>)}
                </optgroup>
                {/* DRSP-only portfolios are not registered for FCAS — hide
                    those market options to prevent submission of bids that
                    the server would reject anyway. */}
                {portfolio.classification !== 'DRSP_ONLY' && (
                  <>
                    <optgroup label="FCAS Raise">
                      {markets.raise_fcas.map((m) => <option key={m} value={m}>{m}</option>)}
                    </optgroup>
                    <optgroup label="FCAS Lower">
                      {markets.lower_fcas.map((m) => <option key={m} value={m}>{m}</option>)}
                    </optgroup>
                  </>
                )}
              </select>
            </Field>
            <Field label={t('vpp.bid.direction')}>
              <select
                value={direction}
                onChange={(e) => setDirection(e.target.value as any)}
                disabled={market !== 'ENERGY'}
                className="w-full text-[12px] border border-hairlineSoft rounded px-2 py-1.5 bg-surface disabled:opacity-50 focus:outline-none focus:border-accent"
              >
                <option value="GEN">GEN (inject / raise)</option>
                <option value="LOAD">LOAD (curtail / lower)</option>
              </select>
            </Field>
          </div>

          {/* Envelope hint */}
          {envelope && (
            <div className="mb-3 text-[11px] bg-surfaceAlt rounded-md px-3 py-2">
              <div className="flex items-baseline justify-between">
                <span className="text-muted">{t('vpp.bid.envelope')}</span>
                <span className="font-semibold tabular-nums text-ink">
                  {envelope.envelope_mw.toFixed(2)} MW
                  <span className="ml-2 text-muted font-normal">
                    ({envelope.eligible_resources.length} {t('vpp.bid.eligibleSites')})
                  </span>
                </span>
              </div>
              {/* Channel-aware hint: which AEMO money path this bid is
                  going to use. For FCAS we additionally call out that only
                  scheduled resources can participate, since BTM sites are
                  silently dropped from the envelope. */}
              {envelope.channel && (
                <div className="mt-1 text-[10px] text-muted">
                  {envelope.channel === 'wholesale_full' && (
                    <>via <span className="text-positive font-medium">wholesale (FCAS)</span> · scheduled assets only</>
                  )}
                  {envelope.channel === 'wholesale_or_embedded_generation' && (
                    <>via <span className="text-positive font-medium">wholesale</span> + <span className="text-accent font-medium">embedded generation</span> (NER 2.2.5)</>
                  )}
                  {envelope.channel === 'wholesale_or_wdr' && (
                    <>via <span className="text-positive font-medium">wholesale LOAD</span> + <span className="text-[#a78bfa] font-medium">WDR baseline</span> (NER 3.8.2A)</>
                  )}
                </div>
              )}
              {envelope.envelope_mw < 0.001 && envelope.channel === 'wholesale_full' && (
                <div className="mt-1 text-[10px] text-negative">
                  No scheduled assets opted-in — FCAS requires scheduled/semi-scheduled registration.
                </div>
              )}
            </div>
          )}

          {/* 10-band ladder */}
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between mb-0.5 px-1">
              <span className="text-[10px] uppercase tracking-wider text-muted">
                {t('vpp.bid.ladder')}
              </span>
              {/* Auto-derived defaults indicator + reset. When the user
                  manually edits ANY band the auto-regen stops touching
                  their values; "Reset" lets them snap back to the smart
                  defaults for the current (market, direction, envelope). */}
              <span className="inline-flex items-center gap-2 text-[10px]">
                {bandsTouched ? (
                  <span className="text-muted">{t('vpp.bid.edited')}</span>
                ) : (
                  <span className="text-positive" title={t('vpp.bid.autoTip')}>
                    {t('vpp.bid.autoLadder')}
                  </span>
                )}
                <button
                  type="button"
                  onClick={resetBandsToDefaults}
                  className="text-accent hover:underline"
                  title={`market=${market}, direction=${direction}, envelope=${(envelope?.envelope_mw ?? 0).toFixed(2)} MW`}
                >
                  {t('vpp.bid.reset')}
                </button>
              </span>
            </div>
            <div className="grid grid-cols-[40px_1fr_1fr_30px] gap-2 text-[10px] uppercase tracking-wider text-muted px-1">
              <span>#</span>
              <span>{t('vpp.bid.bandPrice')}</span>
              <span>{t('vpp.bid.bandMw')}</span>
              <span></span>
            </div>
            {bands.map((b, i) => (
              <div key={i} className="grid grid-cols-[40px_1fr_1fr_30px] gap-2 items-center">
                <span className="text-[11px] tabular-nums text-muted text-center">{i + 1}</span>
                <input
                  type="number" value={b.price}
                  onChange={(e) => updateBand(i, 'price', e.target.value)}
                  step={0.5}
                  className="text-[12px] tabular-nums border border-hairlineSoft rounded px-2 py-1 bg-surface focus:outline-none focus:border-accent"
                />
                <input
                  type="number" value={b.mw}
                  onChange={(e) => updateBand(i, 'mw', e.target.value)}
                  step={0.1} min={0}
                  className="text-[12px] tabular-nums border border-hairlineSoft rounded px-2 py-1 bg-surface focus:outline-none focus:border-accent"
                />
                <button
                  onClick={() => removeBand(i)}
                  disabled={bands.length <= 1}
                  className="text-[14px] text-muted hover:text-negative disabled:opacity-30"
                  title="Remove band"
                >
                  ×
                </button>
              </div>
            ))}
            {bands.length < 10 && (
              <button
                onClick={addBand}
                className="text-[11px] text-accent hover:underline mt-1"
              >
                + {t('vpp.bid.addBand')}  ({bands.length}/10)
              </button>
            )}
          </div>

          {/* Rebid reason */}
          <div className="mt-4 grid grid-cols-[140px_1fr] gap-2 items-center">
            <Field label={t('vpp.bid.reason')}>
              <select
                value={reasonCode}
                onChange={(e) => setReasonCode(e.target.value)}
                className="w-full text-[12px] border border-hairlineSoft rounded px-2 py-1.5 bg-surface focus:outline-none focus:border-accent"
              >
                {markets.rebid_reasons.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </Field>
            <Field label={t('vpp.bid.note')}>
              <input
                type="text" value={reasonNote}
                onChange={(e) => setReasonNote(e.target.value)}
                placeholder={t('vpp.bid.notePh')}
                className="w-full text-[12px] border border-hairlineSoft rounded px-2 py-1.5 bg-surface focus:outline-none focus:border-accent"
              />
            </Field>
          </div>

          {/* ===== ADVANCED OPERATIONAL PARAMETERS ====================
              BIDPEROFFER MaxAvail, DailyEnergyConstraint, ramp rates +
              FCAS trapezium (when relevant). Collapsed by default so the
              form stays approachable; real participants almost always
              populate at least MaxAvail + ramp rates. */}
          <div className="mt-4 border-t border-hairlineSoft pt-3">
            <button
              type="button"
              onClick={() => setShowAdvanced(s => !s)}
              className="text-[11px] font-medium text-muted hover:text-ink inline-flex items-center gap-1.5"
            >
              <span className={`inline-block transition-transform ${showAdvanced ? 'rotate-90' : ''}`}>▸</span>
              {t('vpp.bid.advanced')}
              <span className="text-muted/60 font-normal">
                · MaxAvail · DailyEnergyConstraint · Ramp{isFcas ? ' · FCAS trapezium' : ''}
              </span>
            </button>

            {showAdvanced && (
              <div className="mt-3 space-y-3">
                {/* MaxAvail + DailyEnergy */}
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t('vpp.bid.maxAvail')}>
                    <div className="relative">
                      <input
                        type="number" value={maxAvailMw} step={0.1} min={0}
                        onChange={(e) => setMaxAvailMw(e.target.value)}
                        placeholder={`default: sum(bands) = ${bands.reduce((s,b)=>s+(Number(b.mw)||0),0).toFixed(2)}`}
                        className="w-full text-[12px] tabular-nums border border-hairlineSoft rounded px-2 py-1.5 pr-10 bg-surface focus:outline-none focus:border-accent"
                      />
                      <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted pointer-events-none">MW</span>
                    </div>
                    <div className="text-[10px] text-muted mt-1">BIDPEROFFER.MaxAvail — hard cap on total dispatch.</div>
                  </Field>
                  <Field label={t('vpp.bid.dailyEnergy')}>
                    <div className="relative">
                      <input
                        type="number" value={dailyEnergyMwh} step={0.5} min={0}
                        onChange={(e) => setDailyEnergyMwh(e.target.value)}
                        placeholder="optional"
                        className="w-full text-[12px] tabular-nums border border-hairlineSoft rounded px-2 py-1.5 pr-12 bg-surface focus:outline-none focus:border-accent"
                      />
                      <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted pointer-events-none">MWh</span>
                    </div>
                    <div className="text-[10px] text-muted mt-1">BIDDAYOFFER.DailyEnergyConstraint — MWh cap for this DUID across all intervals of the trading day.</div>
                  </Field>
                </div>
                {/* Ramp rates */}
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t('vpp.bid.rampUp')}>
                    <div className="relative">
                      <input
                        type="number" value={rampUp} step={1} min={0}
                        onChange={(e) => setRampUp(e.target.value)}
                        placeholder="MW/min"
                        className="w-full text-[12px] tabular-nums border border-hairlineSoft rounded px-2 py-1.5 pr-14 bg-surface focus:outline-none focus:border-accent"
                      />
                      <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted pointer-events-none">MW/min</span>
                    </div>
                  </Field>
                  <Field label={t('vpp.bid.rampDown')}>
                    <div className="relative">
                      <input
                        type="number" value={rampDown} step={1} min={0}
                        onChange={(e) => setRampDown(e.target.value)}
                        placeholder="MW/min"
                        className="w-full text-[12px] tabular-nums border border-hairlineSoft rounded px-2 py-1.5 pr-14 bg-surface focus:outline-none focus:border-accent"
                      />
                      <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted pointer-events-none">MW/min</span>
                    </div>
                  </Field>
                </div>

                {/* FCAS trapezium (conditional) */}
                {isFcas && (
                  <div className="rounded-md border border-hairlineSoft bg-surfaceAlt/40 p-3">
                    <label className="flex items-baseline gap-2 mb-2 text-[11px] text-ink2 font-medium">
                      <input
                        type="checkbox" checked={includeTrapezium}
                        onChange={(e) => setIncludeTrapezium(e.target.checked)}
                        className="accent-accent w-3.5 h-3.5"
                      />
                      {t('vpp.bid.trapTitle')}
                      <span className="text-muted text-[10px] font-normal ml-1">
                        — NER 3.8.7A · NEMDE 协同优化 ENERGY + FCAS
                      </span>
                    </label>

                    {includeTrapezium && (
                      <>
                        {/* Trapezium SVG preview */}
                        <TrapeziumPreview
                          enMin={Number(trapEnMin)}
                          lowBp={Number(trapLowBp)}
                          highBp={trapHighBp.trim()==='' ? (Number(maxAvailMw)||bands.reduce((s,b)=>s+Number(b.mw),0)) : Number(trapHighBp)}
                          enMax={trapEnMax.trim()==='' ? (trapHighBp.trim()===''?(Number(maxAvailMw)||bands.reduce((s,b)=>s+Number(b.mw),0)):Number(trapHighBp)) : Number(trapEnMax)}
                          fcasCapacity={Number(maxAvailMw)||bands.reduce((s,b)=>s+Number(b.mw),0)}
                        />
                        <div className="grid grid-cols-4 gap-2 mt-3">
                          <Field label="EnMin (MW)">
                            <input type="number" value={trapEnMin} step={0.1}
                                   onChange={(e) => setTrapEnMin(e.target.value)}
                                   className="w-full text-[11px] tabular-nums border border-hairlineSoft rounded px-2 py-1 bg-surface focus:outline-none focus:border-accent"/>
                          </Field>
                          <Field label="LowBP (MW)">
                            <input type="number" value={trapLowBp} step={0.1}
                                   onChange={(e) => setTrapLowBp(e.target.value)}
                                   className="w-full text-[11px] tabular-nums border border-hairlineSoft rounded px-2 py-1 bg-surface focus:outline-none focus:border-accent"/>
                          </Field>
                          <Field label="HighBP (MW)">
                            <input type="number" value={trapHighBp} step={0.1}
                                   onChange={(e) => setTrapHighBp(e.target.value)}
                                   placeholder="= MaxAvail"
                                   className="w-full text-[11px] tabular-nums border border-hairlineSoft rounded px-2 py-1 bg-surface focus:outline-none focus:border-accent"/>
                          </Field>
                          <Field label="EnMax (MW)">
                            <input type="number" value={trapEnMax} step={0.1}
                                   onChange={(e) => setTrapEnMax(e.target.value)}
                                   placeholder="= HighBP"
                                   className="w-full text-[11px] tabular-nums border border-hairlineSoft rounded px-2 py-1 bg-surface focus:outline-none focus:border-accent"/>
                          </Field>
                        </div>
                        <div className="grid grid-cols-4 gap-2 mt-2">
                          {(['T1','T2','T3','T4'] as const).map((key, i) => {
                            const val = [trapT1, trapT2, trapT3, trapT4][i]
                            const setter = [setTrapT1, setTrapT2, setTrapT3, setTrapT4][i]
                            return (
                              <Field key={key} label={`${key} (s)`}>
                                <input type="number" value={val} step={0.1} min={0}
                                       onChange={(e) => setter(e.target.value)}
                                       className="w-full text-[11px] tabular-nums border border-hairlineSoft rounded px-2 py-1 bg-surface focus:outline-none focus:border-accent"/>
                              </Field>
                            )
                          })}
                        </div>
                        <div className="text-[10px] text-muted mt-2 leading-relaxed">
                          T1=响应延迟 · T2=爬到满档 · T3=持续时长 · T4=释放.
                          <span className="ml-1">T1+T2 ≤ {market.includes('1SEC')?1:market.includes('6SEC')?6:market.includes('60SEC')?60:market.includes('5MIN')?300:market.includes('REG')?4:'?'}s (MASS)</span>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Validation feedback */}
          {localErrors.length > 0 && (
            <div className="mt-3 text-[11px] text-negative bg-red-50 rounded-md px-3 py-2">
              {localErrors[0]}
            </div>
          )}
          {error && (
            <div className="mt-3 text-[11px] text-negative bg-red-50 rounded-md px-3 py-2">
              {error}
            </div>
          )}
          {submitMsg && (
            <div className="mt-3 text-[11px] text-positive bg-emerald-50 rounded-md px-3 py-2">
              {submitMsg}
            </div>
          )}

          <button
            onClick={submit}
            disabled={submitting || localErrors.length > 0}
            className="mt-4 w-full text-[13px] py-2.5 rounded-md bg-accent text-white font-medium hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? t('vpp.bid.submitting') : t('vpp.bid.submit')}
          </button>
        </section>
      </div>

      {/* ============================ BID LEDGER =========================== */}
      <section className="bg-surface rounded-xl2 p-6 shadow-card">
        <div className="flex items-baseline justify-between mb-3">
          <div>
            <div className="text-[15px] font-semibold tracking-tight text-ink">
              {t('vpp.ledger.title')}
            </div>
            <div className="text-[12px] text-muted mt-0.5">{t('vpp.ledger.hint')}</div>
          </div>
          <div className="text-[11px] text-muted tabular-nums">
            {bids.length} {t('vpp.ledger.bids')}
          </div>
        </div>
        {bids.length === 0 ? (
          <div className="py-10 text-center text-muted text-[12px]">{t('vpp.ledger.empty')}</div>
        ) : (
          <div className="overflow-x-auto -mx-2">
            <table className="w-full text-[12px]">
              <thead className="text-muted text-[10px] uppercase tracking-wide">
                <tr>
                  <th className="text-left px-2 py-1.5 font-medium">#</th>
                  <th className="text-left px-2 py-1.5 font-medium">{t('vpp.ledger.target')}</th>
                  <th className="text-left px-2 py-1.5 font-medium">{t('vpp.ledger.market')}</th>
                  <th className="text-left px-2 py-1.5 font-medium">{t('vpp.ledger.dir')}</th>
                  <th className="text-right px-2 py-1.5 font-medium">{t('vpp.ledger.maxMw')}</th>
                  <th className="text-left px-2 py-1.5 font-medium">{t('vpp.ledger.alloc')}</th>
                  <th className="text-left px-2 py-1.5 font-medium">{t('vpp.ledger.reason')}</th>
                  <th className="text-left px-2 py-1.5 font-medium">{t('vpp.ledger.status')}</th>
                  <th className="text-right px-2 py-1.5 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {bids.map((b) => {
                  const maxMw = Math.max(...b.bands.map((bd) => bd.mw))
                  return (
                    <tr key={b.bid_id} className="border-t border-hairlineSoft hover:bg-surfaceAlt/40">
                      <td className="px-2 py-1.5 tabular-nums text-muted">{b.bid_id}</td>
                      <td className="px-2 py-1.5 tabular-nums">{fmtInterval(b.target_settlementdate)}</td>
                      <td className="px-2 py-1.5">{b.market}</td>
                      <td className="px-2 py-1.5">
                        <span className={b.direction === 'GEN' ? 'text-accent' : 'text-[#0a84ff]'}>
                          {b.direction}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{maxMw.toFixed(2)}</td>
                      <td className="px-2 py-1.5 text-[10px] text-muted">
                        {b.allocation.length > 0
                          ? `${b.allocation.length} sites`
                          : '—'}
                      </td>
                      <td className="px-2 py-1.5 text-[11px]">
                        <span className="px-1.5 py-0.5 rounded bg-surfaceAlt text-ink2 text-[10px] font-medium">
                          {b.rebid_reason || 'INITIAL'}
                        </span>
                      </td>
                      <td className="px-2 py-1.5">
                        <StatusBadge status={b.status} />
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        {b.status === 'PENDING' && (
                          <button
                            onClick={() => cancel(b.bid_id)}
                            className="text-[11px] text-muted hover:text-negative"
                          >
                            {t('vpp.ledger.cancel')}
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ============================ COMPLIANCE FOOTER ==================== */}
      {/* Compliance scorecard lives down here as an opt-in drawer rather
          than a top-of-page panel. Operators don't want to lead with an
          "audit yourself" view; this gives anyone curious a one-click
          path without polluting the main workspace. Lazy-mounted: the
          /api/vpp/compliance fetch only fires after the user expands it. */}
      <div>
        {showCompliance && (
          <div id="compliance-drawer" className="mb-3">
            <ComplianceScorecard portfolioId={PORTFOLIO_ID} />
          </div>
        )}
        <button
          type="button"
          onClick={() => {
            setShowCompliance((v) => !v)
            // When opening, scroll the drawer into view so the user sees
            // what just appeared without having to hunt for it.
            if (!showCompliance) {
              setTimeout(() => {
                document.getElementById('compliance-drawer')
                  ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }, 50)
            }
          }}
          className="w-full text-[11px] text-muted hover:text-ink py-2.5 px-4 rounded-md border border-hairlineSoft hover:border-hairline transition-colors inline-flex items-center justify-center gap-2 bg-surface"
          aria-expanded={showCompliance}
          aria-controls="compliance-drawer"
        >
          <span className={`inline-block transition-transform ${showCompliance ? 'rotate-90' : ''}`}>▸</span>
          {t('vpp.complianceLink')}
          <span className="text-muted/60">·</span>
          <span className="text-[10px] text-muted/70">{t('vpp.complianceLinkHint')}</span>
        </button>
      </div>

      {/* ============================ COMPETITOR VPP BIDS =================== */}
      {/* Benchmark block: what AGL / ShineHub / EnelX & co actually bid into
          FCAS, straight from AEMO's D+1 disclosure. Gives the paper VPP
          above a real-market yardstick. */}
      <section className="bg-surface rounded-xl2 p-6 shadow-card">
        <VPPCompetitorBids />
      </section>
    </div>
  )
}

// =========================================================================
// Sub-components
// =========================================================================

function MetricCard({ label, value, sub, accent }: {
  label: string; value: string; sub?: string;
  accent?: 'positive' | 'negative' | 'warn' | 'muted' | 'charge'
}) {
  const accentColor = accent === 'positive' ? 'text-positive'
    : accent === 'negative' ? 'text-negative'
    : accent === 'warn' ? 'text-warn'
    : accent === 'charge' ? 'text-[#0a84ff]'
    : 'text-ink'
  return (
    <div className="bg-surfaceAlt rounded-md px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`text-[18px] font-semibold tabular-nums mt-0.5 ${accentColor}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted mt-0.5">{sub}</div>}
    </div>
  )
}

function ResourceRow({ r, pnl, expanded, onToggle, onExpand }: {
  r: VPPResource
  pnl: VPPResourcePnl | null
  expanded: boolean
  onToggle: () => void
  onExpand: () => void
}) {

  // SoC visualisation — only meaningful for BESS. We surface BOTH the
  // raw number AND a progress bar; the bar fills with the SoC fraction
  // and turns warn-colour at the extremes (<20%, >90%) where the asset
  // is constrained in one direction.
  const socPct = r.kind === 'bess' && r.capacity_kwh > 0
    ? (r.soc_kwh / r.capacity_kwh) * 100
    : null
  const socColor = socPct === null ? '#86868b'
    : socPct >= 90 ? '#0a84ff'
    : socPct <= 20 ? '#ff9500'
    : '#34c759'

  // 24h revenue + event count from the per-resource P&L feed.
  const rev = pnl?.revenue_aud ?? 0
  const events = pnl?.energy_fill_count ?? 0
  const eventCap = r.max_events_per_day
  const eventColor = events >= eventCap ? '#ff3b30'
    : events >= eventCap * 0.7 ? '#ff9500'
    : '#86868b'

  // Availability now — useful for EV chargers to show "60% of plugs in use"
  const availPct = (r.availability_now * 100)

  // With `border-separate` on the table we attach the row divider to the
  // cells themselves (not the <tr>) — that way the rule sits below the
  // padded cell area and survives the hover background change cleanly.
  const rowCell = `px-3 py-2 align-middle border-t border-hairlineSoft/70 first:border-l-0`
  return (
    <>
    <tr className={`group hover:bg-surfaceAlt/30 cursor-pointer transition-colors ${!r.opted_in ? 'opacity-50' : ''} ${expanded ? 'bg-surfaceAlt/40' : ''}`}
        onClick={(e) => {
          // Don't trigger expand when clicking the opt-in checkbox.
          if ((e.target as HTMLElement).tagName === 'INPUT') return
          onExpand()
        }}>
      {/* SITE — name + DUID + chevron, all on a controlled 2-line block. */}
      <td className={rowCell}>
        <div className="flex items-center gap-2">
          <span className={`text-[10px] text-muted transition-transform ${expanded ? 'rotate-90' : ''}`}>▸</span>
          <div className="min-w-0">
            <div className="font-medium text-ink leading-tight truncate max-w-[180px]" title={r.site_name}>
              {r.site_name}
            </div>
            <div className="text-[10px] text-muted leading-tight tabular-nums truncate max-w-[180px]" title={r.resource_id}>
              {r.resource_id}
            </div>
          </div>
        </div>
      </td>
      {/* TYPE — kind + dispatch badge inline, single line. */}
      <td className={`${rowCell} whitespace-nowrap`}>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-2 h-2 rounded-sm"
                style={{ background: KIND_COLOR[r.kind] }} />
          <span className="text-ink">{KIND_LABEL[r.kind]}</span>
          <DispatchTypeBadge dt={r.dispatch_type} retail={r.retail_plan} />
        </span>
      </td>
      {/* NAMEPLATE */}
      <td className={`${rowCell} text-right tabular-nums whitespace-nowrap`}>
        <div className="text-ink leading-tight">{r.nameplate_kw.toFixed(0)} kW</div>
        <div className="text-[10px] text-muted leading-tight">
          {r.kind === 'bess'
            ? `${r.capacity_kwh.toFixed(0)} kWh`
            : `avail ${availPct.toFixed(0)}%`}
        </div>
      </td>
      {/* SoC — bar for BESS, dash for EV */}
      <td className={rowCell}>
        {socPct !== null ? (
          <div className="flex items-center gap-2 min-w-[110px]">
            <div className="flex-1 h-1.5 bg-surfaceAlt rounded-full overflow-hidden">
              <div className="h-full rounded-full transition-all"
                   style={{ width: `${Math.min(100, socPct)}%`, background: socColor }} />
            </div>
            <span className="text-[10px] tabular-nums font-medium"
                  style={{ color: socColor }}>
              {socPct.toFixed(0)}%
            </span>
          </div>
        ) : (
          <span className="text-[10px] text-muted">—</span>
        )}
      </td>
      {/* 24h revenue */}
      <td className={`${rowCell} text-right tabular-nums whitespace-nowrap`}>
        {rev !== 0 ? (
          <span className={`font-medium ${rev > 0 ? 'text-positive' : 'text-negative'}`}>
            {rev > 0 ? '+' : '−'}${Math.abs(rev).toFixed(0)}
          </span>
        ) : (
          <span className="text-[10px] text-muted">—</span>
        )}
      </td>
      {/* Today's events vs cap */}
      <td className={`${rowCell} text-center whitespace-nowrap`}>
        <span className="text-[11px] tabular-nums font-medium" style={{ color: eventColor }}>
          {events}<span className="text-muted/70 font-normal">/{eventCap}</span>
        </span>
      </td>
      {/* WINDOW */}
      <td className={`${rowCell} tabular-nums text-[11px] text-muted whitespace-nowrap`}>
        {String(r.window_start_hr).padStart(2, '0')}–{String(r.window_end_hr).padStart(2, '0')}
      </td>
      {/* CAPABILITY — compact mono-letter caps + channel chips on one line. */}
      <td className={rowCell}>
        <div className="flex items-center gap-2 flex-wrap">
          <CapsAbbr r={r} />
          {(r.channels ?? []).filter(c => c !== 'customer_tou').map((c) => (
            <ChannelChip key={c} channel={c} />
          ))}
        </div>
      </td>
      {/* IN — opt-in toggle */}
      <td className={`${rowCell} text-center`}>
        <input
          type="checkbox"
          checked={!!r.opted_in}
          onChange={onToggle}
          onClick={(e) => e.stopPropagation()}
          className="accent-accent cursor-pointer w-3.5 h-3.5"
        />
      </td>
    </tr>
    {expanded && (
      <tr className="bg-surfaceAlt/25">
        <td colSpan={9} className="px-3 py-3 border-t border-hairlineSoft/70">
          <ResourceHistoryPanel resourceId={r.resource_id} />
        </td>
      </tr>
    )}
    </>
  )
}

function StatusBadge({ status }: { status: string }) {
  const style: Record<string, string> = {
    PENDING:   'bg-warn/10 text-warn',
    SETTLED:   'bg-positive/10 text-positive',
    CANCELLED: 'bg-surfaceAlt text-muted',
    EXPIRED:   'bg-surfaceAlt text-muted',
  }
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${style[status] || 'bg-surfaceAlt text-muted'}`}>
      {status}
    </span>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wider text-muted block mb-1">{label}</span>
      {children}
    </label>
  )
}

// =========================================================================
// SuggestionsSection — algo bids with one-click submit
// =========================================================================

function SuggestionsSection({ suggestions, onAccept, t }: {
  suggestions: VPPSuggestion[]
  onAccept: (s: VPPSuggestion) => void
  t: (k: string, ...a: any[]) => string
}) {
  return (
    <section className="bg-surface rounded-xl2 p-6 shadow-card">
      <div className="flex items-baseline justify-between mb-3 flex-wrap gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-muted">
            {t('vpp.sug.kicker')}
          </div>
          <div className="text-[15px] font-semibold tracking-tight text-ink mt-0.5">
            {t('vpp.sug.title')}
          </div>
          <div className="text-[12px] text-muted mt-0.5">{t('vpp.sug.hint')}</div>
        </div>
        <div className="text-[11px] text-muted tabular-nums">
          {suggestions.length} {t('vpp.sug.items')}
        </div>
      </div>
      <div className="overflow-x-auto -mx-2">
        <table className="w-full text-[12px]">
          <thead className="text-muted text-[10px] uppercase tracking-wide">
            <tr>
              <th className="text-left  px-2 py-1.5 font-medium">{t('vpp.sug.col.when')}</th>
              <th className="text-left  px-2 py-1.5 font-medium">{t('vpp.sug.col.market')}</th>
              <th className="text-right px-2 py-1.5 font-medium">{t('vpp.sug.col.bands')}</th>
              <th className="text-right px-2 py-1.5 font-medium">{t('vpp.sug.col.envelope')}</th>
              <th className="text-right px-2 py-1.5 font-medium">{t('vpp.sug.col.estRev')}</th>
              <th className="text-left  px-2 py-1.5 font-medium">{t('vpp.sug.col.rationale')}</th>
              <th className="text-right px-2 py-1.5 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {suggestions.map((s, i) => (
              <tr key={i} className="border-t border-hairlineSoft hover:bg-surfaceAlt/40">
                <td className="px-2 py-1.5 tabular-nums">{fmtInterval(s.target_settlementdate)}</td>
                <td className="px-2 py-1.5">
                  <span className="font-medium">{s.market}</span>
                  <span className={`ml-1.5 text-[10px] ${s.direction === 'GEN' ? 'text-accent' : 'text-[#0a84ff]'}`}>
                    {s.direction}
                  </span>
                </td>
                <td className="px-2 py-1.5 text-right text-[10px] text-muted tabular-nums">
                  {s.bands.map((b) => `$${b.price}@${b.mw}`).join(' · ')}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums text-ink2">
                  {s.envelope_mw.toFixed(2)} MW
                </td>
                <td className={`px-2 py-1.5 text-right tabular-nums font-medium ${
                  s.estimated_revenue_aud >= 0 ? 'text-positive' : 'text-negative'
                }`}>
                  {s.estimated_revenue_aud >= 0 ? '+' : '−'}${Math.abs(s.estimated_revenue_aud).toFixed(2)}
                </td>
                <td className="px-2 py-1.5 text-[10px] text-muted max-w-[280px] truncate" title={s.rationale}>
                  {s.rationale}
                </td>
                <td className="px-2 py-1.5 text-right">
                  <button
                    onClick={() => onAccept(s)}
                    className="text-[11px] px-2.5 py-1 rounded-md bg-accent text-white font-medium hover:opacity-90"
                  >
                    {t('vpp.sug.accept')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

// =========================================================================
// CustomerDemandChargeCard — per-site BTM peak shaving → $ saved
// =========================================================================

function CustomerDemandChargeCard({ d, t }: {
  d: VPPCustomerDemandCharge
  t: (k: string, ...a: any[]) => string
}) {
  return (
    <section className="bg-surface rounded-xl2 p-6 shadow-card">
      <div className="flex items-baseline justify-between mb-3 flex-wrap gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-muted">
            {t('vpp.dc.kicker')}
          </div>
          <div className="text-[15px] font-semibold tracking-tight text-ink mt-0.5">
            {t('vpp.dc.title')}
          </div>
          <div className="text-[12px] text-muted mt-0.5">
            {t('vpp.dc.params', d.peak_window, d.rate_aud_per_kva_month.toFixed(0), d.share_pct.toFixed(0))}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-muted">{t('vpp.dc.vppShare')}</div>
          <div className="text-[26px] font-semibold tabular-nums leading-none mt-1 text-positive">
            +${d.totals.vpp_monthly_share_aud.toLocaleString('en-AU', { maximumFractionDigits: 0 })}
            <span className="text-[12px] text-muted ml-1 font-normal">/月</span>
          </div>
          <div className="text-[11px] text-muted mt-1 tabular-nums">
            {t('vpp.dc.customerSaves', d.totals.customer_monthly_savings_aud.toLocaleString('en-AU', { maximumFractionDigits: 0 }))}
          </div>
        </div>
      </div>

      {/* Per-site table */}
      <div className="overflow-x-auto -mx-2">
        <table className="w-full text-[12px]">
          <thead className="text-muted text-[10px] uppercase tracking-wide">
            <tr>
              <th className="text-left px-2 py-1.5 font-medium">{t('vpp.dc.col.site')}</th>
              <th className="text-right px-2 py-1.5 font-medium">{t('vpp.dc.col.peakDown')}</th>
              <th className="text-right px-2 py-1.5 font-medium">{t('vpp.dc.col.events')}</th>
              <th className="text-right px-2 py-1.5 font-medium">{t('vpp.dc.col.monthly')}</th>
              <th className="text-right px-2 py-1.5 font-medium">{t('vpp.dc.col.vppCut')}</th>
              <th className="text-right px-2 py-1.5 font-medium">{t('vpp.dc.col.cusKeep')}</th>
            </tr>
          </thead>
          <tbody>
            {d.active_sites.map((s) => (
              <tr key={s.resource_id} className="border-t border-hairlineSoft hover:bg-surfaceAlt/40">
                <td className="px-2 py-1.5 font-medium">{s.site_name}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-accent">
                  {s.peak_reduction_kw.toFixed(0)} kW
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums text-muted">{s.peak_events_last_30d}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  ${s.monthly_savings_aud.toLocaleString('en-AU', { maximumFractionDigits: 0 })}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums text-positive">
                  +${s.vpp_share_aud.toLocaleString('en-AU', { maximumFractionDigits: 0 })}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums text-ink2">
                  ${s.customer_keeps_aud.toLocaleString('en-AU', { maximumFractionDigits: 0 })}
                </td>
              </tr>
            ))}
            {d.idle_sites.length > 0 && d.idle_sites.map((s) => (
              <tr key={s.resource_id} className="border-t border-hairlineSoft opacity-50">
                <td className="px-2 py-1.5 font-medium">{s.site_name}</td>
                <td colSpan={3} className="px-2 py-1.5 text-[11px] text-muted italic">
                  {t('vpp.dc.idle', s.potential_kw?.toFixed(0) ?? '0',
                                    s.potential_monthly_aud?.toFixed(0) ?? '0')}
                </td>
                <td colSpan={2}></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="text-[10px] text-muted mt-3">
        {t('vpp.dc.note')}
      </div>
    </section>
  )
}

// =========================================================================
// ResourceHistoryPanel — expandable per-row 24h trajectory
// =========================================================================

function ResourceHistoryPanel({ resourceId }: { resourceId: string }) {
  const [data, setData] = useState<VPPResourceHistory | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    fetchVPPResourceHistory(resourceId, 24)
      .then((d) => { if (!cancelled) setData(d) })
      .catch((e) => { if (!cancelled) setError(String((e as Error).message ?? e)) })
    return () => { cancelled = true }
  }, [resourceId])

  if (error) return <div className="text-[11px] text-negative">history unavailable: {error}</div>
  if (!data) return <div className="text-[11px] text-muted">loading…</div>
  if (data.events.length === 0) {
    return (
      <div className="text-[11px] text-muted py-3">
        No events for this resource in the last {data.hours} h.
        {data.resource.kind === 'bess' && data.resource.soc_now_kwh > 0 && (
          <span className="ml-2">SoC now: {data.resource.soc_now_kwh.toFixed(0)} / {data.resource.capacity_kwh.toFixed(0)} kWh</span>
        )}
      </div>
    )
  }

  const isBess = data.resource.kind === 'bess'
  // Build SVG: cumulative revenue (line) + SoC (line if BESS) + event markers
  const W = 720, H = 120, padL = 40, padR = 60, padT = 8, padB = 22
  const N = data.events.length
  if (N === 0) return null
  const revs = data.events.map((e) => e.revenue_cum_aud)
  const socs = data.events.map((e) => e.soc_after_kwh)
  const revMax = Math.max(...revs, 1)
  const revMin = Math.min(...revs, 0)
  const socMax = data.resource.capacity_kwh || Math.max(...socs)
  const xAt = (i: number) => padL + ((W - padL - padR) * i) / Math.max(N - 1, 1)
  const yRev = (v: number) => padT + (H - padT - padB) * (1 - (v - revMin) / (revMax - revMin || 1))
  const ySoc = (v: number) => padT + (H - padT - padB) * (1 - v / socMax)

  const revPath = revs.map((v, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i)} ${yRev(v)}`).join(' ')
  const socPath = socs.map((v, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i)} ${ySoc(v)}`).join(' ')

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between text-[10px] uppercase tracking-wider text-muted">
        <span>24h trajectory · {data.summary.total_events} events</span>
        <span className="tabular-nums">
          revenue ${data.summary.total_revenue_aud.toFixed(2)}
          {isBess && data.resource.soc_now_kwh > 0 && (
            <span className="ml-3">SoC {data.resource.soc_now_kwh.toFixed(0)}/{data.resource.capacity_kwh.toFixed(0)} kWh</span>
          )}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 140 }}>
        {/* Y-axis labels */}
        <text x={5} y={padT + 10} fontSize={9} fill="#86868b">${revMax.toFixed(0)}</text>
        <text x={5} y={H - padB + 10} fontSize={9} fill="#86868b">${revMin.toFixed(0)}</text>
        {isBess && (
          <>
            <text x={W - 5} y={padT + 10} fontSize={9} fill="#86868b" textAnchor="end">{socMax.toFixed(0)} kWh</text>
            <text x={W - 5} y={H - padB + 10} fontSize={9} fill="#86868b" textAnchor="end">0</text>
          </>
        )}
        {/* Grid */}
        {[0.25, 0.5, 0.75].map((p) => (
          <line key={p} x1={padL} y1={padT + (H - padT - padB) * p}
                x2={W - padR} y2={padT + (H - padT - padB) * p}
                stroke="#ececef" strokeWidth={0.5} />
        ))}
        {/* SoC line (BESS only) */}
        {isBess && (
          <path d={socPath} fill="none" stroke="#0a84ff" strokeWidth={1.5}
                strokeLinecap="round" strokeLinejoin="round" opacity={0.85} />
        )}
        {/* Revenue line */}
        <path d={revPath} fill="none" stroke="#ff9500" strokeWidth={2}
              strokeLinecap="round" strokeLinejoin="round" />
        {/* Event markers */}
        {data.events.map((e, i) => (
          <circle key={i} cx={xAt(i)} cy={yRev(e.revenue_cum_aud)} r={2.5}
                  fill={e.market === 'ENERGY' ? '#ff9500' : '#34c759'} />
        ))}
        {/* X-axis time labels (first/last) */}
        <text x={padL} y={H - 5} fontSize={9} fill="#86868b">{data.events[0].t.slice(11, 16)}</text>
        <text x={W - padR} y={H - 5} fontSize={9} fill="#86868b" textAnchor="end">
          {data.events[data.events.length - 1].t.slice(11, 16)}
        </text>
      </svg>
      {/* Compact event log */}
      <div className="max-h-32 overflow-y-auto text-[10px] tabular-nums">
        {data.events.slice().reverse().slice(0, 10).map((e, i) => (
          <div key={i} className="flex items-baseline justify-between border-b border-hairlineSoft/50 py-0.5">
            <span className="text-muted">{e.t.slice(11, 16)}</span>
            <span className="text-ink2">{e.market}/{e.direction}</span>
            <span className="tabular-nums">{e.alloc_mw >= 0 ? '+' : '−'}{Math.abs(e.alloc_mw).toFixed(3)} MW</span>
            {isBess && <span className="text-muted">SoC {e.soc_after_kwh.toFixed(0)} kWh</span>}
            <span className={`tabular-nums ${e.revenue_aud >= 0 ? 'text-positive' : 'text-negative'}`}>
              {e.revenue_aud >= 0 ? '+' : '−'}${Math.abs(e.revenue_aud).toFixed(2)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function fmtInterval(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('en-AU', {
    month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

// =========================================================================
// ClassificationBadge — small pill showing the portfolio's AEMO class
// =========================================================================

// =========================================================================
// DispatchTypeBadge — small pill on each resource row showing scheduled
// vs non_scheduled. Hover shows the retail_plan that decides whether a
// non_scheduled BESS can monetise via embedded generation.
// =========================================================================

function DispatchTypeBadge({ dt, retail }: {
  dt: VPPDispatchType | undefined | null
  retail: VPPRetailPlan | undefined | null
}) {
  if (!dt) return null
  const style: Record<VPPDispatchType, { bg: string; fg: string; ring: string; label: string }> = {
    scheduled:      { bg: 'bg-positive/12', fg: 'text-positive', ring: 'ring-positive/25', label: 'SCH' },
    semi_scheduled: { bg: 'bg-accent/12',   fg: 'text-accent',   ring: 'ring-accent/25',   label: 'SEMI' },
    non_scheduled:  { bg: 'bg-ink/[0.04]',  fg: 'text-muted',    ring: 'ring-ink/10',      label: 'BTM' },
  }
  const s = style[dt] ?? style.non_scheduled
  // Tooltip explains exactly which channel pays out for this combination.
  const tip = dt === 'scheduled' || dt === 'semi_scheduled'
    ? `${dt.toUpperCase()} · NEMDE-dispatched. Full ENERGY + FCAS access.`
    : retail === 'wholesale_passthrough'
      ? 'NON_SCHEDULED · wholesale_passthrough → earns RRP × MWh × MLF as embedded generation (NER 2.2.5). No FCAS.'
      : `NON_SCHEDULED · retail_plan=${retail}. No spot pass-through; WDR + customer-side only.`
  return (
    <span title={tip}
          className={`inline-flex items-center px-1.5 py-px rounded-full text-[9px] font-semibold tracking-wide leading-none ring-1 ${s.bg} ${s.fg} ${s.ring} whitespace-nowrap`}>
      {s.label}
    </span>
  )
}

// =========================================================================
// CapsAbbr — compact 5-letter capability indicator (I·C·R·L·G).
// Active flag = ink colour, inactive = faded. Replaces the old chip pile
// which used to stack 5 pills vertically and blew the row height up.
// =========================================================================

function CapsAbbr({ r }: { r: VPPResource }) {
  const flags: { letter: string; on: boolean; name: string }[] = [
    { letter: 'I', on: !!r.can_inject,     name: 'Inject (discharge to grid)' },
    { letter: 'C', on: !!r.can_curtail,    name: 'Curtail (reduce load)' },
    { letter: 'R', on: !!r.can_raise_fcas, name: 'Raise FCAS' },
    { letter: 'L', on: !!r.can_lower_fcas, name: 'Lower FCAS' },
    { letter: 'G', on: !!r.can_reg_fcas,   name: 'Regulation FCAS' },
  ]
  const active = flags.filter(f => f.on).map(f => f.name).join(' · ') || 'no capabilities'
  return (
    <span
      title={`Capability flags — active: ${active}`}
      className="inline-flex items-center gap-px font-mono text-[10px] tabular-nums leading-none px-1.5 py-0.5 rounded bg-ink/[0.03] ring-1 ring-ink/10 whitespace-nowrap"
    >
      {flags.map((f, i) => (
        <span key={i} className={f.on ? 'text-ink2 font-semibold' : 'text-muted/30'}>
          {f.letter}
        </span>
      ))}
    </span>
  )
}

// =========================================================================
// ChannelChip — what AEMO/customer money taps are connected to a site.
// =========================================================================

// =========================================================================
// TrapeziumPreview — small SVG showing the FCAS co-optimisation trapezium.
// X-axis = ENERGY dispatch (MW), Y-axis = FCAS available (MW).
// Shape: 0 at enMin → ramps to fcasCapacity at lowBp → flat to highBp →
// ramps back down to 0 at enMax.
// =========================================================================

function TrapeziumPreview({ enMin, lowBp, highBp, enMax, fcasCapacity }: {
  enMin: number; lowBp: number; highBp: number; enMax: number; fcasCapacity: number
}) {
  const W = 360, H = 90, padL = 30, padR = 12, padT = 8, padB = 18
  // Guard against degenerate input
  const xMax = Math.max(enMax, highBp, lowBp, enMin, 1)
  const fcasY = Math.max(fcasCapacity, 0.001)
  const xAt = (mw: number) => padL + ((W - padL - padR) * mw) / xMax
  const yAt = (mw: number) => padT + (H - padT - padB) * (1 - mw / fcasY)
  const pts = [
    [enMin, 0], [lowBp, fcasCapacity], [highBp, fcasCapacity], [enMax, 0],
  ] as [number, number][]
  const polyPoints = pts.map(([x, y]) => `${xAt(x)},${yAt(y)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 100 }}>
      {/* Axes */}
      <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} stroke="#ddd" strokeWidth={0.6} />
      <line x1={padL} y1={padT} x2={padL} y2={H - padB} stroke="#ddd" strokeWidth={0.6} />
      {/* Trapezium fill */}
      <polygon points={polyPoints}
               fill="rgba(52, 199, 89, 0.18)" stroke="#34c759" strokeWidth={1.5}
               strokeLinejoin="round" />
      {/* Anchor dots */}
      {pts.map(([x, y], i) => (
        <circle key={i} cx={xAt(x)} cy={yAt(y)} r={2.5} fill="#34c759" />
      ))}
      {/* Y-axis label */}
      <text x={padL - 4} y={padT + 8} fontSize={9} fill="#86868b" textAnchor="end">{fcasCapacity.toFixed(1)}</text>
      <text x={padL - 4} y={H - padB} fontSize={9} fill="#86868b" textAnchor="end">0</text>
      {/* X-axis labels at the 4 anchor points */}
      {pts.map(([x], i) => (
        <text key={i} x={xAt(x)} y={H - 4} fontSize={8} fill="#86868b" textAnchor="middle">
          {x.toFixed(1)}
        </text>
      ))}
      {/* Axis titles */}
      <text x={W - padR} y={H - padB - 4} fontSize={9} fill="#86868b" textAnchor="end">ENERGY MW →</text>
      <text x={padL + 4} y={padT + 8} fontSize={9} fill="#86868b">FCAS MW ↑</text>
    </svg>
  )
}

function ChannelChip({ channel }: { channel: VPPChannel }) {
  const style: Record<VPPChannel, { dot: string; fg: string; bg: string; ring: string; label: string; tip: string }> = {
    wholesale_full: {
      dot: 'bg-positive', fg: 'text-positive', bg: 'bg-positive/10', ring: 'ring-positive/25',
      label: 'Wholesale',
      tip: 'Wholesale: NEMDE-dispatched ENERGY + FCAS access.',
    },
    embedded_generation: {
      dot: 'bg-accent', fg: 'text-accent', bg: 'bg-accent/10', ring: 'ring-accent/25',
      label: 'Embedded gen',
      tip: 'Embedded generation: non-scheduled BESS earns RRP × MWh × MLF via the wholesale_passthrough retailer (NER 2.2.5). No FCAS.',
    },
    wdr: {
      dot: 'bg-[#a78bfa]', fg: 'text-[#7c5cf6]', bg: 'bg-[#a78bfa]/12', ring: 'ring-[#a78bfa]/30',
      label: 'WDR',
      tip: 'Wholesale Demand Response: load curtailment paid against a verifiable baseline (NER 3.8.2A).',
    },
    customer_tou: {
      dot: 'bg-muted', fg: 'text-muted', bg: 'bg-ink/[0.04]', ring: 'ring-ink/10',
      label: 'TOU',
      tip: 'Customer-side TOU / peak shaving optimisation.',
    },
  }
  const s = style[channel] ?? style.customer_tou
  return (
    <span title={s.tip}
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium leading-none ring-1 ${s.bg} ${s.fg} ${s.ring} whitespace-nowrap`}>
      <span className={`inline-block w-1 h-1 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  )
}

function ClassificationBadge({ cls }: { cls: VPPClassification }) {
  const style: Record<VPPClassification, { bg: string; fg: string; label: string }> = {
    ARU:        { bg: 'bg-accent/10',   fg: 'text-accent',   label: 'ARU' },
    SCHEDULED:  { bg: 'bg-positive/10', fg: 'text-positive', label: 'SCHEDULED' },
    DRSP_ONLY:  { bg: 'bg-[#0a84ff]/10', fg: 'text-[#0a84ff]', label: 'DRSP-ONLY' },
  }
  const s = style[cls] ?? style.ARU
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold tracking-normal normal-case ${s.bg} ${s.fg}`}>
      {s.label}
    </span>
  )
}

// =========================================================================
// RevenueBreakdown — answers "Energy vs FCAS vs Customer-side, which is
// bigger right now?" for the active portfolio over the last 24h.
// =========================================================================

function RevenueBreakdown({ rev, t }: { rev: VPPRevenue; t: (k: string, ...a: any[]) => string }) {
  const tot = rev.totals
  const slices = [
    { key: 'ENERGY',     label: t('vpp.rev.energy'),    value: tot.energy_aud,             color: '#ff9500' },
    { key: 'RAISE',      label: t('vpp.rev.fcasRaise'), value: tot.fcas_raise_aud,         color: '#34c759' },
    { key: 'LOWER',      label: t('vpp.rev.fcasLower'), value: tot.fcas_lower_aud,         color: '#5cc8ff' },
    { key: 'DEMAND',     label: t('vpp.rev.demand'),    value: tot.customer_demand_charge_aud, color: '#a78bfa' },
  ]
  // Use absolute values for the bar widths — negative revenue (e.g. paying
  // for ENERGY LOAD/charge) still shows scale-wise but with a "−" prefix.
  const totalAbs = slices.reduce((s, x) => s + Math.abs(x.value), 0)
  return (
    <section className="bg-surface rounded-xl2 p-6 shadow-card">
      <div className="flex items-baseline justify-between flex-wrap gap-3 mb-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-muted">
            {t('vpp.rev.title')}
          </div>
          <div className="text-[15px] font-semibold tracking-tight text-ink mt-0.5">
            {t('vpp.rev.subtitle', String(rev.hours))}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-muted">
            {t('vpp.rev.totalAll')}
          </div>
          <div className={`text-[26px] font-semibold tabular-nums leading-none mt-1 ${
            tot.all_revenue_aud >= 0 ? 'text-positive' : 'text-negative'
          }`}>
            {tot.all_revenue_aud >= 0 ? '+' : '−'}${Math.abs(tot.all_revenue_aud).toLocaleString('en-AU', { maximumFractionDigits: 0 })}
          </div>
        </div>
      </div>

      {/* Stacked bar — proportional widths of |revenue| per category. Empty
          when nothing has settled yet (just shows the customer-side slice). */}
      {totalAbs > 0 ? (
        <div className="h-8 w-full rounded-md overflow-hidden flex shadow-inner bg-surfaceAlt">
          {slices.map((s) => {
            const w = (Math.abs(s.value) / totalAbs) * 100
            if (w <= 0) return null
            return (
              <div
                key={s.key}
                className="h-full relative"
                style={{ width: `${w}%`, background: s.color,
                         transition: 'width 700ms ease' }}
                title={`${s.label} · $${s.value.toFixed(0)} · ${w.toFixed(1)}%`}
              >
                {w > 12 && (
                  <span className="absolute inset-0 flex items-center justify-center text-[11px] text-white/95 font-medium tabular-nums">
                    {w.toFixed(0)}%
                  </span>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <div className="h-8 rounded-md bg-surfaceAlt flex items-center justify-center text-[11px] text-muted">
          {t('vpp.rev.noFills')}
        </div>
      )}

      {/* Per-category chips */}
      <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-2.5">
        {slices.map((s) => (
          <div key={s.key} className="bg-surfaceAlt rounded-md px-3 py-2">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
              <span className="inline-block w-2 h-2 rounded-sm" style={{ background: s.color }} />
              {s.label}
            </div>
            <div className={`text-[16px] font-semibold tabular-nums mt-0.5 ${
              s.value >= 0 ? 'text-ink' : 'text-negative'
            }`}>
              {s.value >= 0 ? '+' : '−'}${Math.abs(s.value).toLocaleString('en-AU', { maximumFractionDigits: 0 })}
            </div>
            <div className="text-[10px] text-muted mt-0.5 tabular-nums">
              {totalAbs > 0 ? `${(Math.abs(s.value) / totalAbs * 100).toFixed(1)}%` : '—'}
            </div>
          </div>
        ))}
      </div>

      {/* Footnote */}
      <div className="text-[10px] text-muted mt-3 leading-relaxed">
        {t('vpp.rev.note', tot.wholesale_fills.toString(),
                          tot.customer_total_savings_aud.toFixed(0),
                          rev.classification)}
      </div>
    </section>
  )
}
