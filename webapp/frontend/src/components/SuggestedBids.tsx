/**
 * Suggested bid sheet — turns AEMO's forecast curve into a concrete list of
 * actionable 10-band bids for the user's BESS.
 *
 *   - Fetch P5MIN + PREDISPATCH forecast for NSW1 (next ~40h, 30-min grain).
 *   - Compute p10 / p25 / p50 / p75 / p90 of forecast prices over the window
 *     — p25/p75 are the "cheap" / "expensive" gates that flag an interval as
 *     a charge or discharge candidate; the wider percentile set then shapes
 *     the price ladder.
 *   - Above p75 → discharge candidate. Build a 10-band ascending ladder
 *     anchored at floor(p25) (the "must clear" safety threshold), with mass
 *     concentrated around the per-interval forecast price and a long upside
 *     tail at $1000 / $5000 to capture spikes.
 *   - Below p25 → charge candidate. Build a 10-band ascending ladder anchored
 *     at ceil(p75) (max we'd pay), mass around the per-interval forecast,
 *     and an upper tail at $500 / $1000 so we still charge if the trough
 *     doesn't materialise.
 *   - Expected clear MW = MW that clears at the per-interval forecast price.
 *     Estimated P&L = Σ over clearing bands of (RRP − band.price) × band.mw
 *     × intervalHrs, signed by direction. Captures the partial-clear
 *     behaviour of a ladder, unlike the old single-band binary model.
 *
 * SoC and existing-bid filtering: skip discharge below 5% SoC, charge above
 * 95% SoC, and any interval where a PENDING bid already exists (the engine
 * would reject a second co-optimised bid anyway).
 *
 * The header always exposes the thresholds + raw candidate counts so the
 * heuristic isn't a black box — and each row can be expanded to reveal the
 * full 10-band ladder we'd submit.
 */
import { Fragment, useEffect, useMemo, useState } from 'react'
import { fetchForecast, submitPaperBid } from '../api'
import type { Bid, BessState, FCAS, Forecast, Market } from '../types'
import { useT } from '../i18n'

// 5-min interval expressed as a fraction of an hour — settlement uses this
// to convert MW → MWh.
const INTERVAL_HRS = 5 / 60
const INTERVAL_MIN = 5

// AEMO gate closure: bids for a dispatch interval starting at T are locked
// at T − GATE_LEAD_MIN. After the gate, no submit or cancel. We use the
// canonical 5-min lead time (NEMDE locks ~5 min before each 5-min interval
// starts, modulo data feeds; close enough for a paper-trading dashboard).
const GATE_LEAD_MIN = 5
// "Closing soon" threshold — warn in amber when within this many seconds
// of close so the user can rush a submit before lock-out.
const GATE_WARN_SEC = 60

// Forecast region. Hard-coded to NSW since this lives on the NSW view —
// when we add other deep-dives we'll lift this to a prop.
const REGION = 'NSW1'

// AEMO Market Price Floor / Cap (FY2026-27). Bands must lie inside [-1000, 23200].
const MPF = -1000
const MPC = 23200

// MW weights (% of nameplate power) across the 10-band ladder — mass in the
// middle (where the per-interval forecast tends to sit), thin tails for
// safety bands and spike capture. Sums to 100.
const LADDER_WEIGHTS = [3, 7, 15, 20, 20, 15, 10, 5, 3, 2]

// FCAS co-optimisation — see "FCAS leg" note below. RAISE_FCAS and energy
// GEN both commit upward capacity; LOWER_FCAS and energy LOAD both commit
// downward. So on a GEN interval (full power discharging) we still have all
// of the downward capacity free → offer LOWER FCAS; on a LOAD interval
// (full power charging) we still have all of the upward capacity free →
// offer RAISE FCAS. Pick the highest-paying market above a small threshold.
const FCAS_MIN_THRESHOLD = 0.5   // $/MW/h — skip FCAS if forecast too low to bother
const RAISE_FCAS_MARKETS: { market: Market; key: keyof FCAS; labelKey: string }[] = [
  { market: 'RAISEREG',   key: 'raisereg',   labelKey: 'bid.opt.raiseReg' },
  { market: 'RAISE5MIN',  key: 'raise5min',  labelKey: 'bid.opt.raise5min' },
  { market: 'RAISE60SEC', key: 'raise60sec', labelKey: 'bid.opt.raise60sec' },
  { market: 'RAISE6SEC',  key: 'raise6sec',  labelKey: 'bid.opt.raise6sec' },
  { market: 'RAISE1SEC',  key: 'raise1sec',  labelKey: 'bid.opt.raise1sec' },
]
const LOWER_FCAS_MARKETS: { market: Market; key: keyof FCAS; labelKey: string }[] = [
  { market: 'LOWERREG',   key: 'lowerreg',   labelKey: 'bid.opt.lowerReg' },
  { market: 'LOWER5MIN',  key: 'lower5min',  labelKey: 'bid.opt.lower5min' },
  { market: 'LOWER60SEC', key: 'lower60sec', labelKey: 'bid.opt.lower60sec' },
  { market: 'LOWER6SEC',  key: 'lower6sec',  labelKey: 'bid.opt.lower6sec' },
  { market: 'LOWER1SEC',  key: 'lower1sec',  labelKey: 'bid.opt.lower1sec' },
]

type Band = { price: number; mw: number }

/**
 * AEMO standard rebid reason categories (per NER 3.8.22A — every bid, and
 * especially every rebid, must declare why it was submitted). We carry the
 * selected code as a "[CODE] detail · …" prefix on the bid notes field so
 * it shows up in the ledger as an auditable trail. INITIAL is the safe
 * default for first-time submits in a session; subsequent submits intended
 * as rebids should be re-categorised before clicking Submit.
 */
const REBID_REASON_CODES = [
  'INITIAL',       // first bid for this interval — not a rebid
  'PRICE',         // price-driven response to RRP movement
  'FORECAST',      // AEMO forecast revision
  'DEMAND',        // demand revision
  'OUTAGE',        // plant outage / availability change
  'RAMP',          // ramp-rate change
  'ENERGY_LIMIT',  // SoC / fuel cap binding
  'TEMPERATURE',   // ambient temperature change
  'STRATEGY',      // bidding strategy adjustment
  'OTHER',         // catch-all — relies on the free-text note for detail
] as const
type RebidReasonCode = typeof REBID_REASON_CODES[number]
// Cap on the free-text note. AEMO's own field accepts a short comment; we
// keep the same spirit so the audit string stays scannable in the ledger.
const REBID_NOTE_MAX = 128


/** FCAS leg side relative to the energy direction.
 *  'opposite' — bid in the bucket the energy leg doesn't occupy (always fits, full P available).
 *  'same'     — bid in the SAME bucket as energy (only fits when energy ladder was shrunk;
 *               sized by trapezium reserve = power × fcasReservePct).
 *  See "Trapezium" note in `buildFcasLegs()`. */
type FcasLegSide = 'opposite' | 'same'

type FcasSuggestion = {
  side: FcasLegSide
  market: Market               // e.g. 'LOWERREG'
  labelKey: string             // i18n key for the market label
  fcasDir: 'GEN' | 'LOAD'      // bid direction submitted to backend
  forecastRrp: number          // $/MW/h forecast for this market at this interval
  bidPrice: number             // our bid price ($/MW/h) — price-taker: 0
  mw: number                   // trapezium-capped capacity (MW)
  estPnl: number               // mw × forecastRrp × INTERVAL_HRS (always ≥ 0)
}

type Suggestion = {
  target: string                // ISO interval datetime (NEM)
  direction: 'GEN' | 'LOAD'     // GEN = discharge, LOAD = charge
  forecastRrp: number           // forecast clearing price
  anchorPrice: number           // primary safety threshold — what shows in the table
  bands: Band[]                 // 10-band ladder we'd actually submit
  expectedClearMw: number       // MW that clears if RRP = forecast
  maxAvailMw: number            // declared MaxAvail — sum of all band MW (AEMO capacity envelope)
  estPnl: number                // expected $ flow if RRP = forecast (signed) — ENERGY ONLY, pre-MLF
  source: 'P5MIN' | 'PREDISPATCH'
  fcasOpp?: FcasSuggestion      // optional FCAS leg in the OPPOSITE bucket (always fits)
  fcasSame?: FcasSuggestion     // optional FCAS leg in the SAME bucket (needs energy headroom)
  coverage: 'active' | 'default' // 'active' = peak/trough trade · 'default' = compliance-only blanket cover
  /** Co-opt fit diagnostics. Present when the interval already had PENDING
   *  bids in any market and the suggestion was sized down to fit AEMO's
   *  bucket constraints (energy + RAISE_FCAS ≤ power; energy + LOWER_FCAS
   *  ≤ power). Surfaced in the row as a small "已占用 / 缩减" badge so the
   *  user understands why MW look smaller than expected. */
  fit?: FitInfo
}

type FitInfo = {
  existingUp: number       // pre-existing upward-bucket MW (RAISE_FCAS + ENERGY-GEN PENDING)
  existingDn: number       // pre-existing downward-bucket MW (LOWER_FCAS + ENERGY-LOAD PENDING)
  energyShrunk: boolean    // energy ladder was scaled below the intended energyShare
  oppCapped: boolean       // opp FCAS leg was capped (or dropped) to fit opp bucket
  sameCapped: boolean      // same FCAS leg was capped (or dropped) to fit same bucket
}

type RampInfo = {
  required: number    // MW/min needed to swing from previous interval to this one
  feasible: boolean   // required ≤ effectiveRamp
  fromIdle: boolean   // true when previous interval has no bid (start = 0)
}

type GateInfo = {
  closeMs: number     // epoch ms when the gate locks (= target − GATE_LEAD_MIN)
  remainingSec: number // negative if already past close
  state: 'open' | 'closing' | 'closed'
}

type Stats = {
  forecastPts: number
  p25: number | null
  p75: number | null
  dischargeBid: number | null
  chargeBid: number | null
  rawDischarge: number    // before pending / SoC filters
  rawCharge: number
  rawDefault: number      // total in-between intervals (compliance coverage candidates)
  filteredPending: number // intervals dropped because already PENDING
  socBlock: 'none' | 'no-discharge' | 'no-charge'
}

type Props = {
  paperState: BessState | null
  existingBids: Bid[]
  /** Bumps on every snapshot tick so we refetch the forecast in step with
   *  the rest of the dashboard. */
  refreshKey: string | null | undefined
  /** Called after a successful submission so the parent can refresh the
   *  bid ledger and position card. */
  onSubmitted: () => void
}

export function SuggestedBids({ paperState, existingBids, refreshKey, onSubmitted }: Props) {
  const { t } = useT()
  const [forecast, setForecast] = useState<Forecast | null>(null)
  const [forecastLoading, setForecastLoading] = useState(true)
  const [forecastErr, setForecastErr] = useState<string | null>(null)
  const [pendingSubmits, setPendingSubmits] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // Per-row user overrides — keyed by `${target}:${direction}`. When a row
  // is overridden, we use the user's bands instead of the auto-computed
  // ladder. Overrides persist across forecast refreshes (the user's choice
  // sticks until they hit "Reset").
  const [overrides, setOverrides] = useState<Record<string, Band[]>>({})
  // Rows whose FCAS leg the user opted out of. Sticky across refreshes —
  // if the user explicitly excluded a row's FCAS leg we honour that even
  // when a fresh forecast lands.
  const [excludeFcas, setExcludeFcas] = useState<Set<string>>(new Set())
  // Whether to surface "default coverage" rows for in-between intervals
  // (RRP between p25 and p75). AEMO scheduled units must have a bid for
  // every dispatch interval; surfacing these defaults closes that gap.
  // Default off to keep the table compact — the diagnostic strip still
  // shows the count so the gap is visible.
  const [showDefaults, setShowDefaults] = useState<boolean>(false)
  // Ramp rate (MW/min). AEMO rejects bids whose target dispatch level
  // can't be reached from the previous interval within the unit's
  // registered ramp budget. Modern Li-ion BESS are typically registered
  // at ≥ power_mw MW/min (full swing in ≤ 1 min); older units may be
  // lower. `null` means "use default = power_mw". Sticky so the user can
  // stress-test what-if scenarios without resetting on refresh.
  const [rampRate, setRampRate] = useState<number | null>(null)
  const effectiveRamp = rampRate ?? paperState?.power_mw ?? 0
  // % of nameplate reserved for SAME-direction FCAS (the trapezium dual
  // leg). 0 = pure energy ladder + opposite-direction FCAS (default,
  // safest — fits the backend's bucket check without competing). Raising
  // this shrinks the energy ladder by the same %, and offers a second
  // FCAS leg sized at power_mw × pct/100 in the same bucket — capturing
  // additional FCAS revenue at the cost of energy throughput. Capped at
  // 50 so the energy leg always retains the majority of nameplate.
  const [fcasReservePct, setFcasReservePct] = useState<number>(0)
  const energyShare = Math.max(0, Math.min(1, 1 - fcasReservePct / 100))
  const sameDirCap = (paperState?.power_mw ?? 0) * (fcasReservePct / 100)
  // Marginal Loss Factor (AEMO TLF/MLF). Scales settlement revenue/cost
  // because the connection point and the RRN are physically distinct;
  // generators "far" from the RRN get paid less, loads "far" pay more.
  //   GEN: settled_$ = RRP × MWh × MLF       (less revenue if MLF < 1)
  //   LOAD: settled_$ = RRP × MWh / MLF      (more cost if MLF < 1)
  // Default 1.00 = neutral. Real DUIDs publish their MLF in AEMO's MLF
  // list (annual). Sticky across refreshes — the user typically dials it
  // once and forgets, but can what-if different sites here.
  const [mlf, setMlf] = useState<number>(1.0)
  const mlfActive = Math.abs(mlf - 1.0) > 1e-6
  // AEMO rebid reason (NER 3.8.22A). Code lives in a dropdown; freeform
  // detail in a small text input. Both are sticky for the session so the
  // user dials it once per "what changed" event (e.g. switch to PRICE +
  // "AEMO P5MIN revised peak +$120" after a forecast bump). The pair is
  // baked into every submit's notes prefix so the bid ledger carries an
  // auditable trail.
  const [reasonCode, setReasonCode] = useState<RebidReasonCode>('INITIAL')
  const [reasonNote, setReasonNote] = useState<string>('')
  const reasonActive = reasonCode !== 'INITIAL' || reasonNote.trim().length > 0
  // Wall-clock heartbeat for AEMO gate-closure countdown. Ticking at 1 Hz
  // gives a precise countdown for the last minute (when it matters most)
  // and is cheap — only the gateInfo memo + 5-row gate cells rerender.
  // Initial value uses Date.now() so SSR / first paint reflects "now".
  const [nowMs, setNowMs] = useState<number>(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  // Pull the full PREDISPATCH horizon — past_hours=0 trims the chart's
  // backwards context, future_hours=40 covers AEMO's max look-ahead.
  useEffect(() => {
    let cancelled = false
    setForecastLoading(true)
    fetchForecast(REGION, 0, 40)
      .then((f) => {
        if (cancelled) return
        setForecast(f)
        setForecastErr(null)
      })
      .catch((e) => { if (!cancelled) setForecastErr(String(e?.message || e)) })
      .finally(() => { if (!cancelled) setForecastLoading(false) })
    return () => { cancelled = true }
  }, [refreshKey])

  // Build a set of interval timestamps that already have a PENDING energy
  // bid — used to skip duplicate-co-optimisation suggestions.
  const pendingTargets = useMemo(() => {
    const s = new Set<string>()
    for (const b of existingBids) {
      if (b.status === 'PENDING' && b.market === 'ENERGY') {
        s.add(b.target_settlementdate)
      }
    }
    return s
  }, [existingBids])

  // Per-interval PRE-EXISTING bucket commitments (MW). Mirrors the backend's
  // _check_co_optimisation grouping:
  //   upward bucket   = ENERGY-GEN  + RAISE_FCAS (PENDING)
  //   downward bucket = ENERGY-LOAD + LOWER_FCAS (PENDING)
  // Used by the fitting step below to shrink suggestion legs so submission
  // doesn't trip the "downward/upward commitments would total X > Y" error.
  // Critically, this catches the case where the interval has a PENDING FCAS
  // bid but no energy bid — pendingTargets above (energy-only) would have
  // let the suggestion through, and the backend would reject at submit.
  const intervalCommitments = useMemo<Map<string, { up: number; dn: number }>>(() => {
    const m = new Map<string, { up: number; dn: number }>()
    for (const b of existingBids) {
      if (b.status !== 'PENDING') continue
      const mw = b.bands.reduce(
        (acc, x) => acc + (Number.isFinite(x.mw) ? x.mw : 0), 0,
      )
      const key = b.target_settlementdate
      const entry = m.get(key) ?? { up: 0, dn: 0 }
      if (b.market === 'ENERGY') {
        if (b.direction === 'GEN') entry.up += mw
        else                       entry.dn += mw
      } else if (b.market.startsWith('RAISE')) {
        entry.up += mw
      } else if (b.market.startsWith('LOWER')) {
        entry.dn += mw
      }
      m.set(key, entry)
    }
    return m
  }, [existingBids])

  // Compute the *auto* suggestion baseline + diagnostics. Effective
  // suggestions (with user overrides applied) are derived below.
  const { autoSuggestions, stats } = useMemo<{ autoSuggestions: Suggestion[]; stats: Stats }>(() => {
    const empty: Stats = {
      forecastPts: 0, p25: null, p75: null,
      dischargeBid: null, chargeBid: null,
      rawDischarge: 0, rawCharge: 0, rawDefault: 0,
      filteredPending: 0, socBlock: 'none',
    }
    if (!forecast || !paperState) return { autoSuggestions: [], stats: empty }
    const power = paperState.power_mw
    const energyPower = power * energyShare      // scaled nameplate for the energy ladder
    const sameLegMw = power - energyPower        // freed headroom for SAME-direction FCAS leg
    const socPct = paperState.soc_pct
    const allowDischarge = socPct > 5
    const allowCharge = socPct < 95
    const socBlock: Stats['socBlock'] =
      !allowDischarge ? 'no-discharge' : !allowCharge ? 'no-charge' : 'none'

    const pts = forecast.series
      .filter((p) => p.rrp !== null && Number.isFinite(p.rrp as number))
      .map((p) => ({ ...p, rrp: p.rrp as number }))

    if (pts.length < 4) {
      return { autoSuggestions: [], stats: { ...empty, forecastPts: pts.length, socBlock } }
    }

    const sortedVals = [...pts].map((p) => p.rrp).sort((a, b) => a - b)
    const p10 = pctile(sortedVals, 0.10)
    const p25 = pctile(sortedVals, 0.25)
    const p50 = pctile(sortedVals, 0.50)
    const p75 = pctile(sortedVals, 0.75)
    const p90 = pctile(sortedVals, 0.90)
    const dischargeBid = Math.max(MPF, Math.floor(p25))
    const chargeBid = Math.min(MPC, Math.ceil(p75))

    let rawDischarge = 0, rawCharge = 0, rawDefault = 0, filteredPending = 0
    const cands: Suggestion[] = []
    for (const p of pts) {
      const isPeak = p.rrp >= p75
      const isTrough = p.rrp <= p25
      const isDefault = !isPeak && !isTrough
      if (isPeak) rawDischarge += 1
      if (isTrough) rawCharge += 1
      if (isDefault) rawDefault += 1
      if (pendingTargets.has(p.t)) { filteredPending += 1; continue }
      if (isPeak && allowDischarge) {
        const bands = buildDischargeLadder(p.rrp, p10, dischargeBid, p50, energyPower)
        const clearMw = expectedClearMw('GEN', bands, p.rrp)
        const pnl = estPnl('GEN', bands, p.rrp)
        // GEN commits upward → opposite-direction (downward) free = LOWER FCAS (full P).
        // Trapezium reserve, if set, freed an upward slice = RAISE FCAS same-bucket.
        const { opp, same } = buildFcasLegs(p.fcas, 'GEN', power, sameLegMw)
        cands.push({
          target: p.t,
          direction: 'GEN',
          forecastRrp: p.rrp,
          anchorPrice: dischargeBid,
          bands,
          expectedClearMw: clearMw,
          maxAvailMw: sumBandMw(bands),
          estPnl: pnl,
          source: p.source,
          fcasOpp: opp,
          fcasSame: same,
          coverage: 'active',
        })
      } else if (isTrough && allowCharge) {
        const bands = buildChargeLadder(p.rrp, p50, chargeBid, p90, energyPower)
        const clearMw = expectedClearMw('LOAD', bands, p.rrp)
        const pnl = estPnl('LOAD', bands, p.rrp)
        // LOAD commits downward → opposite-direction (upward) free = RAISE FCAS (full P).
        // Trapezium reserve, if set, freed a downward slice = LOWER FCAS same-bucket.
        const { opp, same } = buildFcasLegs(p.fcas, 'LOAD', power, sameLegMw)
        cands.push({
          target: p.t,
          direction: 'LOAD',
          forecastRrp: p.rrp,
          anchorPrice: chargeBid,
          bands,
          expectedClearMw: clearMw,
          maxAvailMw: sumBandMw(bands),
          estPnl: pnl,
          source: p.source,
          fcasOpp: opp,
          fcasSame: same,
          coverage: 'active',
        })
      } else if (isDefault) {
        // Compliance coverage — every dispatch interval gets a bid. Direction
        // is the "side of the median" RRP sits on: above p50 → conservative
        // discharge (only clears at extreme highs); below → conservative
        // charge (only clears at extreme lows). SoC still gates: we never
        // emit a discharge default at low SoC, nor a charge default at high.
        const aboveMedian = p.rrp >= p50
        const wantDir: 'GEN' | 'LOAD' = aboveMedian ? 'GEN' : 'LOAD'
        if (wantDir === 'GEN' && !allowDischarge) continue
        if (wantDir === 'LOAD' && !allowCharge) continue
        if (wantDir === 'GEN') {
          const bands = buildDefaultDischargeLadder(p75, p90, energyPower)
          // No FCAS on default rows — we want zero exposure when not actively trading.
          cands.push({
            target: p.t,
            direction: 'GEN',
            forecastRrp: p.rrp,
            anchorPrice: bands[0].price,
            bands,
            expectedClearMw: expectedClearMw('GEN', bands, p.rrp),
            maxAvailMw: sumBandMw(bands),
            estPnl: estPnl('GEN', bands, p.rrp),
            source: p.source,
            coverage: 'default',
          })
        } else {
          const bands = buildDefaultChargeLadder(p25, p10, energyPower)
          cands.push({
            target: p.t,
            direction: 'LOAD',
            forecastRrp: p.rrp,
            anchorPrice: bands[bands.length - 1].price,
            bands,
            expectedClearMw: expectedClearMw('LOAD', bands, p.rrp),
            maxAvailMw: sumBandMw(bands),
            estPnl: estPnl('LOAD', bands, p.rrp),
            source: p.source,
            coverage: 'default',
          })
        }
      }
    }
    // Show every qualifying interval, sorted chronologically — the desk
    // walks the day top-down. No edge-based truncation: if it cleared the
    // p25/p75 thresholds + SoC + pending filters, it earns a row.
    cands.sort((a, b) => a.target.localeCompare(b.target))
    return {
      autoSuggestions: cands,
      stats: {
        forecastPts: pts.length, p25, p75, dischargeBid, chargeBid,
        rawDischarge, rawCharge, rawDefault, filteredPending, socBlock,
      },
    }
  }, [forecast, paperState, pendingTargets, energyShare])

  // Fit the auto baseline against pre-existing bucket commitments so the
  // backend co-opt check won't reject at submit. Shrinks the energy ladder
  // proportionally, caps each FCAS leg, drops legs that can't fit at all,
  // and drops the entire row when the energy bucket has no remaining room.
  //   For a GEN suggestion:
  //     energy bucket = upward → shrunk by max(0, power − existing.up) / sumBands
  //     opp leg (LOWER) → capped at max(0, power − existing.dn)
  //     same leg (RAISE) → capped at max(0, power − existing.up − newEnergy)
  //   For a LOAD suggestion: mirror — bucket roles swap.
  // The post-shrink Suggestion carries `fit` diagnostics so the row can show
  // a "已占用 X MW · 缩减 Y MW" badge — the user sees exactly why the bid
  // looks smaller than the nameplate would suggest.
  const fittedSuggestions = useMemo<Suggestion[]>(() => {
    if (!paperState) return autoSuggestions
    const power = paperState.power_mw
    if (power <= 0) return autoSuggestions
    const out: Suggestion[] = []
    for (const s of autoSuggestions) {
      const used = intervalCommitments.get(s.target) ?? { up: 0, dn: 0 }
      // No prior commitments → suggestion passes through untouched; keep
      // `fit` undefined so the row doesn't surface a no-op badge.
      if (used.up <= 1e-6 && used.dn <= 1e-6) { out.push(s); continue }
      const isGen = s.direction === 'GEN'
      // Same-direction FCAS leg shares the energy bucket, so we derive the
      // same-leg headroom from (energyAvail − newEnergySum) below — no need
      // to track sameBucketUsed separately.
      const energyBucketUsed = isGen ? used.up : used.dn
      const oppBucketUsed    = isGen ? used.dn : used.up
      const energyAvail = Math.max(0, power - energyBucketUsed)
      const oppAvail    = Math.max(0, power - oppBucketUsed)

      // Energy ladder: scale proportionally so sum(bands) ≤ energyAvail.
      // If energyAvail is effectively 0, the bucket is full — skip the row
      // (no point suggesting a bid that can't seat any energy MW at all).
      const origEnergySum = sumBandMw(s.bands)
      let newBands = s.bands
      let energyShrunk = false
      if (energyAvail < 0.1) {
        // Bucket fully committed by existing bids — drop the suggestion.
        // The user can still cancel the existing bid manually to free it.
        continue
      }
      if (origEnergySum > energyAvail + 1e-6) {
        const factor = energyAvail / origEnergySum
        newBands = s.bands.map((b) => ({ ...b, mw: round1(b.mw * factor) }))
        energyShrunk = true
      }
      const newEnergySum = sumBandMw(newBands)

      // Opposite FCAS leg: independent bucket — cap at oppAvail.
      let newOpp = s.fcasOpp
      let oppCapped = false
      if (newOpp) {
        if (newOpp.mw > oppAvail + 1e-6) {
          const capped = Math.max(0, round1(oppAvail))
          if (capped < 0.1) {
            newOpp = undefined
            oppCapped = true
          } else {
            newOpp = {
              ...newOpp,
              mw: capped,
              estPnl: newOpp.forecastRrp * capped * INTERVAL_HRS,
            }
            oppCapped = true
          }
        }
      }

      // Same-direction FCAS leg: shares the energy bucket. Remaining
      // headroom = energyAvail − newEnergySum. If the original intent was
      // larger than the headroom, cap or drop.
      let newSame = s.fcasSame
      let sameCapped = false
      if (newSame) {
        const sameRoom = Math.max(0, energyAvail - newEnergySum)
        if (newSame.mw > sameRoom + 1e-6) {
          const capped = Math.max(0, round1(sameRoom))
          if (capped < 0.1) {
            newSame = undefined
            sameCapped = true
          } else {
            newSame = {
              ...newSame,
              mw: capped,
              estPnl: newSame.forecastRrp * capped * INTERVAL_HRS,
            }
            sameCapped = true
          }
        }
      }

      out.push({
        ...s,
        bands: newBands,
        expectedClearMw: expectedClearMw(s.direction, newBands, s.forecastRrp),
        maxAvailMw: sumBandMw(newBands),
        estPnl: estPnl(s.direction, newBands, s.forecastRrp),
        fcasOpp: newOpp,
        fcasSame: newSame,
        fit: {
          existingUp: used.up,
          existingDn: used.dn,
          energyShrunk,
          oppCapped,
          sameCapped,
        },
      })
    }
    return out
  }, [autoSuggestions, intervalCommitments, paperState])

  // Apply user overrides on top of the FITTED baseline (not the raw auto
  // baseline — overrides should respect already-resolved bucket constraints,
  // otherwise the user's edit could re-introduce the conflict). When a row
  // is overridden, recompute the cleared-MW and P&L using the edited bands
  // so the summary numbers stay in sync.
  const suggestions = useMemo<Suggestion[]>(() => {
    return fittedSuggestions.map((s) => {
      const k = rowKey(s)
      const ov = overrides[k]
      if (!ov) return s
      return {
        ...s,
        bands: ov,
        expectedClearMw: expectedClearMw(s.direction, ov, s.forecastRrp),
        maxAvailMw: sumBandMw(ov),
        estPnl: estPnl(s.direction, ov, s.forecastRrp),
      }
    })
  }, [fittedSuggestions, overrides])

  // Validate each effective ladder. Used to disable Submit on broken rows.
  const validations = useMemo<Map<string, LadderValidation>>(() => {
    const m = new Map<string, LadderValidation>()
    for (const s of suggestions) m.set(rowKey(s), validateLadder(s.bands))
    return m
  }, [suggestions])

  // Per-row ramp feasibility. Walk suggestions chronologically: starting
  // dispatch for interval T is the cleared dispatch of T-5 if we have a
  // bid there, otherwise 0 (idle assumption — without a bid the unit
  // doesn't dispatch). Required ramp = |target − start| / 5 (MW/min).
  // A row is infeasible if required > spec; AEMO would reject such a bid.
  const rampInfo = useMemo<Map<string, RampInfo>>(() => {
    const m = new Map<string, RampInfo>()
    if (effectiveRamp <= 0) return m
    const sorted = [...suggestions].sort((a, b) => a.target.localeCompare(b.target))
    let prevTs: number | null = null
    let prevDispatch = 0   // signed: + GEN / − LOAD
    for (const s of sorted) {
      const ts = Date.parse(s.target + 'Z')
      const target = s.direction === 'GEN' ? s.expectedClearMw : -s.expectedClearMw
      const gapMin = prevTs !== null ? (ts - prevTs) / 60000 : Infinity
      const start = gapMin <= INTERVAL_MIN + 0.5 ? prevDispatch : 0
      const required = Math.abs(target - start) / INTERVAL_MIN
      const feasible = required <= effectiveRamp + 1e-6
      m.set(rowKey(s), { required, feasible, fromIdle: gapMin > INTERVAL_MIN + 0.5 })
      prevTs = ts
      prevDispatch = target
    }
    return m
  }, [suggestions, effectiveRamp])

  // Per-row gate-closure status. AEMO locks bids GATE_LEAD_MIN before the
  // dispatch interval starts; after lockout, submit/cancel calls are
  // rejected. We compare in NEM-time frame: target ISO is naive NEM
  // (UTC+10, no DST) parsed as UTC, vs wall-clock now shifted +10h so
  // both sides are in the same frame (same trick as PriceKPIs.minutesAgo).
  const gateInfo = useMemo<Map<string, GateInfo>>(() => {
    const m = new Map<string, GateInfo>()
    const nowNemMs = nowMs + 10 * 3600_000
    for (const s of suggestions) {
      const targetNemMs = Date.parse(s.target + 'Z')
      const closeMs = targetNemMs - GATE_LEAD_MIN * 60_000
      const remainingSec = Math.floor((closeMs - nowNemMs) / 1000)
      const state: GateInfo['state'] =
        remainingSec <= 0 ? 'closed'
        : remainingSec <= GATE_WARN_SEC ? 'closing'
        : 'open'
      m.set(rowKey(s), { closeMs, remainingSec, state })
    }
    return m
  }, [suggestions, nowMs])

  const updateBand = (key: string, idx: number, patch: Partial<Band>) => {
    setOverrides((prev) => {
      // Source bands from the FITTED baseline (post bucket-fit shrink) so the
      // user starts editing what they actually see — not the raw auto ladder
      // that would have re-triggered the co-opt conflict at submit.
      const base = prev[key]
        ?? fittedSuggestions.find((s) => rowKey(s) === key)?.bands
      if (!base) return prev
      const next = base.map((b, i) => (i === idx ? { ...b, ...patch } : b))
      return { ...prev, [key]: next }
    })
  }
  const resetOverride = (key: string) => {
    setOverrides((prev) => {
      if (!(key in prev)) return prev
      const { [key]: _drop, ...rest } = prev
      return rest
    })
  }
  // Toggle one specific FCAS leg ('opp' or 'same'). The combined key
  // `${rowKey}:${legId}` keeps the existing Set<string> shape — older
  // single-leg overrides keyed by bare rowKey are silently ignored after
  // refactor (sticky-state regression on legacy keys is acceptable here,
  // since FCAS exclusions are transient session UI).
  const fcasLegKey = (rowK: string, legId: 'opp' | 'same') => `${rowK}:${legId}`
  const toggleFcasLeg = (rowK: string, legId: 'opp' | 'same') => {
    const k = fcasLegKey(rowK, legId)
    setExcludeFcas((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k); else next.add(k)
      return next
    })
  }
  const isLegIncluded = (rowK: string, legId: 'opp' | 'same') => !excludeFcas.has(fcasLegKey(rowK, legId))

  // What the table actually renders. Default-coverage rows are hidden
  // behind the toggle to keep the active-trade view focused.
  const visibleSuggestions = useMemo<Suggestion[]>(() => {
    return showDefaults ? suggestions : suggestions.filter((s) => s.coverage === 'active')
  }, [suggestions, showDefaults])

  const totalEst = useMemo(
    () => visibleSuggestions.reduce((acc, s) => {
      const k = rowKey(s)
      // FCAS is paid at the FCAS RRP at the regional reference node, not
      // adjusted by the unit's MLF (capacity payment, not energy
      // settlement). So only the energy leg is scaled by MLF.
      const energy = applyMlf(s.direction, s.estPnl, mlf)
      const opp = s.fcasOpp && isLegIncluded(k, 'opp') ? s.fcasOpp.estPnl : 0
      const same = s.fcasSame && isLegIncluded(k, 'same') ? s.fcasSame.estPnl : 0
      return acc + energy + opp + same
    }, 0),
    [visibleSuggestions, excludeFcas, mlf],
  )
  // Aggregate MaxAvail across visible rows — in MWh terms it's just sum ×
  // 5/60. Used in the header strip so the user sees how much capacity
  // they're declaring to AEMO over the whole horizon.
  const totalMaxAvailMwh = useMemo(
    () => visibleSuggestions.reduce((acc, s) => acc + s.maxAvailMw * INTERVAL_HRS, 0),
    [visibleSuggestions],
  )
  // Counts are split between "active" (peak/trough trades) and "default"
  // (compliance coverage). Both contribute to the table when the toggle
  // is on, but the user usually wants to see them separately in summary.
  const nDischarge = visibleSuggestions.filter((s) => s.direction === 'GEN' && s.coverage === 'active').length
  const nCharge = visibleSuggestions.filter((s) => s.direction === 'LOAD' && s.coverage === 'active').length
  // Count FCAS legs (not rows) so a row with both opp+same contributes 2.
  const nFcas = visibleSuggestions.reduce((acc, s) => {
    const k = rowKey(s)
    return acc
      + (s.fcasOpp && isLegIncluded(k, 'opp') ? 1 : 0)
      + (s.fcasSame && isLegIncluded(k, 'same') ? 1 : 0)
  }, 0)
  const nDefaultVisible = visibleSuggestions.filter((s) => s.coverage === 'default').length
  const nDefaultTotal = suggestions.filter((s) => s.coverage === 'default').length
  const nGateClosed = visibleSuggestions.filter((s) => gateInfo.get(rowKey(s))?.state === 'closed').length
  const nGateClosing = visibleSuggestions.filter((s) => gateInfo.get(rowKey(s))?.state === 'closing').length
  // Rows that hit pre-existing bucket commitments and were shrunk/capped.
  // Surfaced as a header chip so the user notices even before opening a row.
  const nFit = visibleSuggestions.filter((s) => !!s.fit).length
  // Rows that were entirely dropped because the energy bucket was 100%
  // pre-committed by existing PENDING bids. (autoSuggestions count − fitted
  // count, since the fit step is the only place rows are removed.)
  const nBlocked = Math.max(0, autoSuggestions.length - fittedSuggestions.length)

  const toggleExpand = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  // Submit the energy leg first, then each non-excluded FCAS leg in turn.
  // Submission order matters because the backend's co-opt check accumulates
  // pending MW: energy goes in first so the same-bucket FCAS leg (if any)
  // sees the trapezium-reserved headroom rather than the full nameplate.
  // A leg failure is reported but does NOT roll back prior legs — the
  // backend has no transactional API. The opposite-direction leg should
  // never fail co-opt; the same-direction leg may if the user dialled the
  // reserve too low for the actual energy clearing volume.
  const submitSuggestion = async (s: Suggestion) => {
    if (!paperState) return
    const duid = paperState.duid
    // AEMO rebid reason prefix (NER 3.8.22A). Format: "[CODE] free-text · …"
    // — the auto-suggestion body that follows describes WHAT was bid; the
    // prefix describes WHY it was submitted, so the ledger entry carries
    // both halves of the audit story.
    const reasonPrefix = buildReasonPrefix(reasonCode, reasonNote)
    // P3-1 auto-rebid: if a PENDING bid already exists for the same
    // (DUID, target, market, direction) we supersede it instead of failing
    // co-opt. AEMO BIDDAYOFFER semantics: a new offer for the same scope
    // replaces the earlier one. We find the *latest* PENDING in the chain
    // by picking max bid_id (chain head).
    const findReplaces = (market: Market, direction: 'GEN' | 'LOAD'): number | null => {
      let best: Bid | null = null
      for (const b of existingBids) {
        if (b.status !== 'PENDING') continue
        if (b.duid !== duid) continue
        if (b.target_settlementdate !== s.target) continue
        if (b.market !== market) continue
        if (b.direction !== direction) continue
        if (!best || b.bid_id > best.bid_id) best = b
      }
      return best ? best.bid_id : null
    }
    const energyNotes =
      `${reasonPrefix}auto-suggested · 10-band ladder · forecast $${s.forecastRrp.toFixed(0)} (${s.source})`
    await submitPaperBid({
      duid,
      target_settlementdate: s.target,
      market: 'ENERGY',
      direction: s.direction,
      bands: s.bands,
      notes: energyNotes,
      replaces_bid_id: findReplaces('ENERGY', s.direction),
    })
    const key = rowKey(s)
    const legs: Array<{ leg: FcasSuggestion; tag: 'opposite' | 'same' }> = []
    if (s.fcasOpp && isLegIncluded(key, 'opp')) legs.push({ leg: s.fcasOpp, tag: 'opposite' })
    if (s.fcasSame && isLegIncluded(key, 'same')) legs.push({ leg: s.fcasSame, tag: 'same' })
    for (const { leg, tag } of legs) {
      await submitPaperBid({
        duid,
        target_settlementdate: s.target,
        market: leg.market,
        direction: leg.fcasDir,
        bands: [{ price: leg.bidPrice, mw: leg.mw }],
        notes: `${reasonPrefix}auto-suggested · FCAS ${tag}-leg · ${leg.market} · forecast $${leg.forecastRrp.toFixed(2)}`,
        replaces_bid_id: findReplaces(leg.market, leg.fcasDir),
      })
    }
  }

  const submitOne = async (s: Suggestion) => {
    if (!paperState) return
    const key = rowKey(s)
    const g = gateInfo.get(key)
    if (g && g.state === 'closed') {
      setError(t('sug.gate.closedTitle', fmtRel(-g.remainingSec)))
      return
    }
    if (!(validations.get(key)?.ok ?? true)) {
      setError(t('sug.ladder.invalid'))
      return
    }
    const r = rampInfo.get(key)
    if (r && !r.feasible) {
      setError(t('sug.ramp.exceedTitle', r.required.toFixed(0), effectiveRamp.toFixed(0)))
      return
    }
    setPendingSubmits((prev) => new Set(prev).add(key))
    setError(null)
    try {
      await submitSuggestion(s)
      onSubmitted()
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setPendingSubmits((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  const submitAll = async () => {
    if (!paperState) return
    setError(null)
    // Iterate VISIBLE rows only — default-coverage rows are submitted only
    // when the user has toggled them on, so "Submit all" matches what they
    // actually see in the table.
    for (const s of visibleSuggestions) {
      const key = rowKey(s)
      if (pendingSubmits.has(key)) continue
      if (!(validations.get(key)?.ok ?? true)) continue   // skip broken rows
      if (!(rampInfo.get(key)?.feasible ?? true)) continue // skip ramp-infeasible rows
      if (gateInfo.get(key)?.state === 'closed') continue  // skip past-gate rows
      try {
        setPendingSubmits((prev) => new Set(prev).add(key))
        await submitSuggestion(s)
      } catch (e: any) {
        setError(e?.message || String(e))
        break
      } finally {
        setPendingSubmits((prev) => {
          const next = new Set(prev)
          next.delete(key)
          return next
        })
      }
    }
    onSubmitted()
  }

  const isLoading = forecastLoading || !paperState

  return (
    <div className="bg-surface rounded-xl2 shadow-card p-6 border-l-4 border-accent">
      {/* Header row 1: Title + DEMO badge | Show-defaults toggle + Submit all */}
      <div className="flex items-center justify-between gap-4 mb-3 flex-wrap">
        <div className="flex items-baseline gap-2">
          <div className="text-[16px] font-semibold text-ink">{t('sug.title')}</div>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-accent/10 text-accent uppercase tracking-wider font-medium">
            {t('sug.badge')}
          </span>
        </div>
        {suggestions.length > 0 && (
          <div className="flex items-center gap-3">
            {nDefaultTotal > 0 && (
              <label className="flex items-center gap-1.5 text-[11px] text-muted cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showDefaults}
                  onChange={(e) => setShowDefaults(e.target.checked)}
                  className="accent-accent"
                />
                {t('sug.toggle.showDefaults', nDefaultTotal)}
              </label>
            )}
            <button
              onClick={submitAll}
              disabled={pendingSubmits.size > 0}
              className="text-[12px] px-4 py-1.5 rounded-md bg-accent text-white font-medium disabled:opacity-50 hover:brightness-105 transition shadow-sm"
            >
              {t('sug.submitAll', visibleSuggestions.length)}
            </button>
          </div>
        )}
      </div>

      {/* Header row 2: scannable stat pills. Each metric becomes its own
          visual chip so the eye can pick out PnL, FCAS legs, warnings, etc.
          without parsing a run-on " · "-separated line. */}
      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3 tabular-nums">
          <StatPill label={t('sug.pill.discharge')} value={String(nDischarge)} accent="discharge" />
          <StatPill label={t('sug.pill.charge')}    value={String(nCharge)}    accent="charge" />
          <StatPill
            label={t('sug.pill.estPnl')}
            value={`${totalEst >= 0 ? '+' : '−'}$${Math.abs(totalEst).toLocaleString('en-AU', { maximumFractionDigits: 0 })}`}
            accent={totalEst >= 0 ? 'positive' : 'negative'}
          />
          {nFcas > 0 && (
            <StatPill label={t('sug.pill.fcas')} value={`+${nFcas}`} accent="positive" />
          )}
          {totalMaxAvailMwh > 0 && (
            <StatPill
              label={t('sug.pill.maxAvail')}
              value={`${totalMaxAvailMwh.toLocaleString('en-AU', { maximumFractionDigits: 0 })} MWh`}
              accent="muted"
              tooltip={t('sug.summary.maxAvailTitle')}
            />
          )}
          {nDefaultVisible > 0 && (
            <StatPill label={t('sug.pill.default')} value={String(nDefaultVisible)} accent="muted" />
          )}
          {nGateClosing > 0 && (
            <StatPill
              label={t('sug.pill.closing')}
              value={String(nGateClosing)}
              accent="warn"
              tooltip={t('sug.gate.closingSummaryTitle')}
            />
          )}
          {nGateClosed > 0 && (
            <StatPill
              label={t('sug.pill.closed')}
              value={String(nGateClosed)}
              accent="negative"
              tooltip={t('sug.gate.closedSummaryTitle')}
            />
          )}
          {nFit > 0 && (
            <StatPill
              label={t('sug.pill.fit')}
              value={String(nFit)}
              accent="warn"
              tooltip={t('sug.fit.summaryTitle')}
            />
          )}
          {nBlocked > 0 && (
            <StatPill
              label={t('sug.pill.blocked')}
              value={String(nBlocked)}
              accent="negative"
              tooltip={t('sug.fit.blockedTitle')}
            />
          )}
        </div>
      )}

      {/* Header row 3: settings tray. Inline form controls grouped on
          their own row so they don't fight with the stats for attention. */}
      {suggestions.length > 0 && paperState && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-3 px-3 py-2 bg-surfaceAlt/50 rounded-md border border-hairlineSoft">
          <label
            className="flex items-center gap-1 text-[11px] text-ink2 tabular-nums"
            title={t('sug.mlf.inputTitle')}
          >
            <span className="text-muted">{t('sug.mlf.label')}</span>
            <input
              type="number"
              value={mlf}
              step={0.01}
              min={0.5}
              max={1.5}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (Number.isFinite(v)) setMlf(Math.max(0.5, Math.min(1.5, v)))
              }}
              className="w-14 text-right tabular-nums bg-surface border border-hairlineSoft rounded px-1 py-0.5 focus:outline-none focus:border-accent"
            />
            {mlfActive && (
              <button
                onClick={() => setMlf(1.0)}
                className="ml-1 text-[9px] underline hover:text-ink2"
                title={t('sug.mlf.resetTitle')}
              >
                {t('sug.ramp.reset')}
              </button>
            )}
          </label>
          <span className="w-px h-4 bg-hairlineSoft" />
          <label
            className="flex items-center gap-1 text-[11px] text-ink2 tabular-nums"
            title={t('sug.coopt.inputTitle', sameDirCap.toFixed(0))}
          >
            <span className="text-muted">{t('sug.coopt.label')}</span>
            <input
              type="number"
              value={fcasReservePct}
              step={5}
              min={0}
              max={50}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (Number.isFinite(v)) setFcasReservePct(Math.max(0, Math.min(50, v)))
              }}
              className="w-12 text-right tabular-nums bg-surface border border-hairlineSoft rounded px-1 py-0.5 focus:outline-none focus:border-accent"
            />
            <span className="text-muted">{t('sug.coopt.unit')}</span>
          </label>
          <span className="w-px h-4 bg-hairlineSoft" />
          <label
            className="flex items-center gap-1 text-[11px] text-ink2 tabular-nums"
            title={t('sug.ramp.inputTitle', paperState.power_mw.toFixed(0))}
          >
            <span className="text-muted">{t('sug.ramp.label')}</span>
            <input
              type="number"
              value={Number.isFinite(effectiveRamp) ? effectiveRamp : ''}
              step={1}
              min={0}
              onChange={(e) => {
                const raw = e.target.value
                setRampRate(raw === '' ? null : Number(raw))
              }}
              className="w-14 text-right tabular-nums bg-surface border border-hairlineSoft rounded px-1 py-0.5 focus:outline-none focus:border-accent"
            />
            <span className="text-muted">{t('sug.ramp.unit')}</span>
            {rampRate !== null && (
              <button
                onClick={() => setRampRate(null)}
                className="ml-1 text-[9px] underline hover:text-ink2"
                title={t('sug.ramp.resetTitle', paperState.power_mw.toFixed(0))}
              >
                {t('sug.ramp.reset')}
              </button>
            )}
          </label>
          <span className="w-px h-4 bg-hairlineSoft" />
          <label
            className="flex items-center gap-1 text-[11px] text-ink2 flex-1 min-w-[180px]"
            title={t('sug.reason.inputTitle')}
          >
            <span className="text-muted">{t('sug.reason.label')}</span>
            <select
              value={reasonCode}
              onChange={(e) => setReasonCode(e.target.value as RebidReasonCode)}
              className="text-[11px] bg-surface border border-hairlineSoft rounded px-1 py-0.5 focus:outline-none focus:border-accent"
            >
              {REBID_REASON_CODES.map((code) => (
                <option key={code} value={code}>{t(`sug.reason.${code}`)}</option>
              ))}
            </select>
            <input
              type="text"
              value={reasonNote}
              maxLength={REBID_NOTE_MAX}
              placeholder={t('sug.reason.notePh')}
              title={t('sug.reason.noteTitle')}
              onChange={(e) => setReasonNote(e.target.value)}
              className="flex-1 text-[11px] bg-surface border border-hairlineSoft rounded px-1.5 py-0.5 focus:outline-none focus:border-accent"
            />
          </label>
          {/* Compact active-flag badges so the user knows when MLF or Reason
              is non-default and therefore affecting every submitted bid. */}
          {mlfActive && (
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded ${mlf < 1 ? 'bg-negative/10 text-negative' : 'bg-positive/10 text-positive'}`}
              title={t('sug.mlf.summaryTitle', mlf.toFixed(3))}
            >
              MLF {mlf.toFixed(2)}
            </span>
          )}
          {reasonActive && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent"
              title={t('sug.reason.summaryTitle', reasonCode)}
            >
              {reasonCode}
            </span>
          )}
        </div>
      )}

      <div className="text-[12px] text-muted mb-2">{t('sug.subtitle')}</div>

      {/* Diagnostic strip — always visible so the heuristic is transparent. */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink2 mb-3 tabular-nums">
        <span className="text-muted">
          {t('sug.diag.pts', stats.forecastPts)}
        </span>
        {stats.p25 !== null && stats.p75 !== null && (
          <>
            <span>
              <span className="text-muted">{t('sug.diag.thresh')}</span>{' '}
              <span className="text-positive">${stats.p25.toFixed(0)}</span>
              <span className="text-muted"> / </span>
              <span className="text-accent">${stats.p75.toFixed(0)}</span>
            </span>
            <span>
              <span className="text-muted">{t('sug.diag.bidPrices')}</span>{' '}
              <span className="text-accent">≥${stats.dischargeBid}</span>
              <span className="text-muted"> / </span>
              <span className="text-positive">≤${stats.chargeBid}</span>
            </span>
            <span className="text-muted">
              {t('sug.diag.raw', stats.rawDischarge, stats.rawCharge)}
            </span>
            {stats.rawDefault > 0 && (
              <span className="text-muted">
                {t('sug.diag.defaults', stats.rawDefault)}
              </span>
            )}
            {stats.filteredPending > 0 && (
              <span className="text-muted">
                {t('sug.diag.skipped', stats.filteredPending)}
              </span>
            )}
            {stats.socBlock === 'no-discharge' && (
              <span className="text-negative">{t('sug.diag.lowSoc')}</span>
            )}
            {stats.socBlock === 'no-charge' && (
              <span className="text-negative">{t('sug.diag.highSoc')}</span>
            )}
          </>
        )}
      </div>

      {error && (
        <div className="mb-3 text-[12px] text-negative bg-red-50 rounded-md px-3 py-2">{error}</div>
      )}
      {forecastErr && (
        <div className="mb-3 text-[12px] text-negative bg-red-50 rounded-md px-3 py-2">
          {t('sug.err.forecast')}: {forecastErr}
        </div>
      )}

      {/* Body */}
      {isLoading && !forecast && (
        <div className="text-[12px] text-muted py-8 text-center">{t('chart.loading')}</div>
      )}

      {!isLoading && suggestions.length === 0 && (
        <div className="text-[12px] text-muted py-8 text-center">
          {emptyReason(stats, t)}
        </div>
      )}

      {!isLoading && suggestions.length > 0 && visibleSuggestions.length === 0 && (
        <div className="text-[12px] text-muted py-8 text-center">
          {t('sug.empty.activeOnly', nDefaultTotal)}
        </div>
      )}

      {visibleSuggestions.length > 0 && (
        <div className="overflow-x-auto overflow-y-auto -mx-2 max-h-[520px]">
          <table className="w-full text-[12px]">
            <thead className="text-muted text-[10px] uppercase tracking-wide sticky top-0 bg-surface z-10">
              <tr>
                <th className="text-left  px-2 py-2 font-medium">{t('sug.col.target')}</th>
                <th className="text-left  px-2 py-2 font-medium">{t('sug.col.action')}</th>
                <th className="text-right px-2 py-2 font-medium">{t('sug.col.forecast')}</th>
                <th className="text-right px-2 py-2 font-medium">{t('sug.col.bid')}</th>
                <th className="text-right px-2 py-2 font-medium">{t('sug.col.mw')}</th>
                <th className="text-right px-2 py-2 font-medium">{t('sug.col.est')}</th>
                <th className="px-2 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {visibleSuggestions.map((s) => {
                const key = rowKey(s)
                const submitting = pendingSubmits.has(key)
                const isGen = s.direction === 'GEN'
                const isDefault = s.coverage === 'default'
                const arrow = isGen ? '↑' : '↓'
                // Defaults are de-emphasised — muted colour + small "DEF" tag —
                // so the active-trade rows still draw the eye when both visible.
                const colorClass = isDefault
                  ? 'text-muted'
                  : (isGen ? 'text-accent' : 'text-positive')
                const actionLabel = isGen ? t('sug.actDischarge') : t('sug.actCharge')
                const op = isGen ? '≥' : '≤'
                const isExpanded = expanded.has(key)
                const power = paperState?.power_mw ?? 0
                const modified = key in overrides
                const validation = validations.get(key)
                const valid = validation?.ok ?? true
                const oppOn  = !!s.fcasOpp  && isLegIncluded(key, 'opp')
                const sameOn = !!s.fcasSame && isLegIncluded(key, 'same')
                const fcasIncluded = oppOn || sameOn
                const fcasTotalPnl = (oppOn ? s.fcasOpp!.estPnl : 0) + (sameOn ? s.fcasSame!.estPnl : 0)
                // MLF only adjusts the energy leg — FCAS is paid at FCAS RRP
                // (capacity payment, not transmission-loss-adjusted).
                const energyPnlAdj = applyMlf(s.direction, s.estPnl, mlf)
                const rowPnl = energyPnlAdj + fcasTotalPnl
                const ramp = rampInfo.get(key)
                const rampOk = ramp?.feasible ?? true
                const gate = gateInfo.get(key)
                const gateClosed = gate?.state === 'closed'
                const gateClosing = gate?.state === 'closing'
                // Row background: closed gate > modified > default > active.
                // Closed rows get a stronger grayscale wash so the eye skips
                // past them to the actionable rows.
                const rowBg = gateClosed
                  ? 'bg-surfaceAlt/60 opacity-60'
                  : modified ? 'bg-accent/[0.03]'
                  : (isDefault ? 'bg-surfaceAlt/20' : '')
                return (
                  <Fragment key={key}>
                    <tr className={`border-t border-hairlineSoft tabular-nums hover:bg-surfaceAlt/40 ${rowBg}`}>
                      <td className={`px-2 py-2 ${isDefault ? 'text-muted' : 'text-ink'}`}>
                        {fmtTs(s.target)}
                        {gate && (
                          <span
                            className={`block text-[9px] font-normal ${
                              gateClosed ? 'text-negative font-medium'
                              : gateClosing ? 'text-warn font-medium'
                              : 'text-muted'
                            }`}
                            title={
                              gateClosed
                                ? t('sug.gate.closedTitle', fmtRel(-gate.remainingSec))
                                : t('sug.gate.openTitle', GATE_LEAD_MIN, fmtRel(gate.remainingSec))
                            }
                          >
                            {gateClosed
                              ? `⚠ ${t('sug.gate.closed')}`
                              : gateClosing
                                ? `⏱ ${gate.remainingSec}s`
                                : `⏳ ${fmtCountdown(gate.remainingSec)}`}
                          </span>
                        )}
                      </td>
                      <td className={`px-2 py-2 font-medium ${colorClass}`}>
                        <span className="mr-1">{arrow}</span>
                        {actionLabel}
                        {isDefault && (
                          <span
                            className="ml-2 text-[9px] px-1 py-0.5 rounded bg-muted/10 text-muted uppercase tracking-wider font-medium"
                            title={t('sug.coverage.defaultTitle')}
                          >
                            {t('sug.coverage.default')}
                          </span>
                        )}
                        <span className="ml-2 text-[10px] text-muted uppercase tracking-wider">
                          {s.source === 'P5MIN' ? 'P5' : 'PD'}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-right text-ink2">
                        ${s.forecastRrp.toFixed(0)}
                      </td>
                      <td className="px-2 py-2 text-right text-ink2">
                        <button
                          onClick={() => toggleExpand(key)}
                          className="hover:text-accent transition"
                          title={t('sug.ladder.toggle')}
                        >
                          <span className="text-muted text-[10px]">{op} </span>${s.anchorPrice}
                          <span className="ml-1 text-[10px] text-muted">
                            · {t('sug.ladder.bands', s.bands.length)}
                            {modified && (
                              <span className="text-accent ml-1" title={t('sug.ladder.modified')}>●</span>
                            )}
                            {!valid && (
                              <span className="text-negative ml-1" title={t('sug.ladder.invalid')}>⚠</span>
                            )}
                            {fcasIncluded && (
                              <span
                                className="ml-1 px-1 rounded bg-positive/10 text-positive"
                                title={fcasBadgeTitle(s, oppOn, sameOn, t)}
                              >
                                {t('sug.fcas.badge')}
                                {oppOn && sameOn && <span className="ml-0.5">×2</span>}
                              </span>
                            )}
                            {' '}{isExpanded ? '▾' : '▸'}
                          </span>
                        </button>
                      </td>
                      <td className="px-2 py-2 text-right text-ink2">
                        {s.expectedClearMw.toFixed(0)}<span className="text-muted text-[10px]">/{power.toFixed(0)}</span>
                        <span
                          className="block text-[9px] text-muted font-normal"
                          title={t('sug.maxAvail.title', s.maxAvailMw.toFixed(0))}
                        >
                          {t('sug.maxAvail.badge', s.maxAvailMw.toFixed(0))}
                        </span>
                        {s.fit && (
                          <span
                            className="block text-[9px] text-warn font-medium"
                            title={t('sug.fit.title',
                                      s.fit.existingUp.toFixed(0),
                                      s.fit.existingDn.toFixed(0),
                                      s.fit.energyShrunk ? t('sug.fit.yes') : t('sug.fit.no'),
                                      s.fit.oppCapped    ? t('sug.fit.yes') : t('sug.fit.no'),
                                      s.fit.sameCapped   ? t('sug.fit.yes') : t('sug.fit.no'))}
                          >
                            {t('sug.fit.badge',
                               (s.direction === 'GEN' ? s.fit.existingUp : s.fit.existingDn).toFixed(0))}
                            {(s.fit.energyShrunk || s.fit.oppCapped || s.fit.sameCapped) && (
                              <span className="ml-0.5">·{t('sug.fit.shrunk')}</span>
                            )}
                          </span>
                        )}
                        {ramp && (
                          <span
                            className={`block text-[9px] font-normal ${rampOk ? 'text-muted' : 'text-negative font-medium'}`}
                            title={t(rampOk ? 'sug.ramp.okTitle' : 'sug.ramp.exceedTitle',
                                     ramp.required.toFixed(0), effectiveRamp.toFixed(0))}
                          >
                            {rampOk ? '⚡' : '⚠ '}{ramp.required.toFixed(0)} MW/min
                            {ramp.fromIdle && <span className="text-muted/70 ml-0.5">·idle</span>}
                          </span>
                        )}
                      </td>
                      <td
                        className="px-2 py-2 text-right font-medium"
                        style={{ color: rowPnl >= 0 ? '#34c759' : '#ff3b30' }}
                      >
                        {fmtAud(rowPnl)}
                        {fcasIncluded && (
                          <span className="block text-[9px] text-muted font-normal">
                            {t('sug.fcas.split',
                               fmtAud(energyPnlAdj), fmtAud(fcasTotalPnl))}
                          </span>
                        )}
                        {mlfActive && (
                          <span
                            className="block text-[9px] text-muted font-normal"
                            title={t('sug.mlf.rowTitle', fmtAud(s.estPnl), mlf.toFixed(3), fmtAud(energyPnlAdj))}
                          >
                            {t('sug.mlf.rowBadge', mlf.toFixed(2))}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-right">
                        <button
                          onClick={() => submitOne(s)}
                          disabled={submitting || !valid || !rampOk || gateClosed}
                          title={
                            gateClosed ? t('sug.gate.closedTitle', fmtRel(-(gate?.remainingSec ?? 0)))
                            : !valid ? t('sug.ladder.invalid')
                            : !rampOk ? t('sug.ramp.exceedTitle',
                                          (ramp?.required ?? 0).toFixed(0), effectiveRamp.toFixed(0))
                            : undefined
                          }
                          className="text-[11px] px-2.5 py-1 rounded-md bg-surfaceAlt text-ink hover:bg-hairlineSoft disabled:opacity-50 disabled:cursor-not-allowed transition"
                        >
                          {submitting ? '…' : t('sug.submit')}
                        </button>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="bg-surfaceAlt/30">
                        <td colSpan={7} className="px-3 py-3 space-y-3">
                          <LadderTable
                            bands={s.bands}
                            forecastRrp={s.forecastRrp}
                            direction={s.direction}
                            modified={modified}
                            validation={validation ?? { ok: true, issues: new Map() }}
                            onChange={(idx, patch) => updateBand(key, idx, patch)}
                            onReset={() => resetOverride(key)}
                            t={t}
                          />
                          <FcasLegPanel
                            opp={s.fcasOpp ?? null}
                            same={s.fcasSame ?? null}
                            oppIncluded={oppOn}
                            sameIncluded={sameOn}
                            onToggleOpp={() => toggleFcasLeg(key, 'opp')}
                            onToggleSame={() => toggleFcasLeg(key, 'same')}
                            t={t}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {suggestions.length > 0 && (
        <details className="mt-3 group">
          <summary className="cursor-pointer text-[11px] text-muted hover:text-ink2 inline-flex items-center gap-1.5 select-none">
            <span className="inline-block transition-transform group-open:rotate-90">▸</span>
            {t('sug.help.toggle')}
          </summary>
          <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 text-[11px] text-ink2 leading-relaxed border-t border-hairlineSoft pt-3">
            <HelpItem icon="📈" titleKey="sug.help.ladder.title" bodyKey="sug.help.ladder.body" t={t} />
            <HelpItem icon="🛡️" titleKey="sug.help.default.title" bodyKey="sug.help.default.body" t={t} />
            <HelpItem icon="⚖️" titleKey="sug.help.fcas.title"    bodyKey="sug.help.fcas.body"    t={t} />
            <HelpItem icon="⚠️" titleKey="sug.help.ramp.title"    bodyKey="sug.help.ramp.body"    t={t} />
            <HelpItem icon="⏱️" titleKey="sug.help.gate.title"    bodyKey="sug.help.gate.body"    t={t} />
            <HelpItem icon="📝" titleKey="sug.help.reason.title"  bodyKey="sug.help.reason.body"  t={t} />
          </div>
        </details>
      )}
    </div>
  )
}

// ---- Ladder builders ------------------------------------------------------

/**
 * Build a 10-band discharge ladder. Bands are in strictly ascending price.
 * Mass concentrated around the per-interval forecast price; thin safety
 * tail at the cheap end (so we still clear some MW if RRP drops below our
 * threshold) and thin spike-capture tail at the expensive end.
 */
function buildDischargeLadder(
  forecast: number,
  p10: number,
  anchor: number,    // floor(p25)
  p50: number,
  power: number,
): Band[] {
  const f = Math.round(forecast)
  const prices = [
    Math.round(Math.max(MPF, p10 - 50)),       // 1: deep safety
    Math.round(Math.max(MPF, anchor - 50)),     // 2: below anchor
    Math.round(anchor),                          // 3: anchor (floor(p25))
    Math.round((anchor + p50) / 2),              // 4: anchor → median
    Math.round(p50),                             // 5: median
    Math.round(f * 0.85),                        // 6: just below forecast
    f,                                            // 7: at forecast
    Math.round(f * 1.25),                        // 8: forecast upside
    1000,                                         // 9: spike
    5000,                                         // 10: extreme spike
  ]
  return packLadder(prices, power)
}

/**
 * Build a 10-band charge ladder. Bands are in strictly ascending price.
 * Mass concentrated around the per-interval forecast price; thin bottom
 * tail (only clears at deep troughs) and thin upper tail (so we still
 * charge if the forecast trough doesn't materialise).
 */
function buildChargeLadder(
  forecast: number,
  p50: number,
  anchor: number,    // ceil(p75)
  p90: number,
  power: number,
): Band[] {
  const f = Math.round(forecast)
  const prices = [
    Math.round(Math.max(MPF, f * 0.5)),          // 1: deep trough only
    Math.round(Math.max(MPF, f * 0.75)),         // 2
    f,                                            // 3: at forecast
    Math.round(f * 1.15),                        // 4: just above forecast
    Math.round(p50),                             // 5: median
    Math.round((p50 + anchor) / 2),              // 6: median → anchor
    Math.round(anchor),                          // 7: anchor (ceil(p75))
    Math.round(p90),                             // 8: p90
    500,                                          // 9: hedge — pay up if trough vanishes
    1000,                                         // 10: must-charge fallback
  ]
  return packLadder(prices, power)
}

/**
 * Build a conservative 10-band "default coverage" discharge ladder. Used
 * for in-between intervals (p25 < RRP < p75) where we want a bid on file
 * for AEMO compliance but do NOT want to clear unless prices spike to the
 * top of the distribution. Anchor at p75 (lowest band — only clears above
 * the active-trade trigger) and ramp up through p90 to MPC, so virtually
 * no MW clears at the per-interval forecast — but if reality blows past
 * the forecast we still capture some spike.
 */
function buildDefaultDischargeLadder(p75: number, p90: number, power: number): Band[] {
  const a = Math.ceil(p75)
  const b = Math.ceil(Math.max(a + 1, p90))
  const prices = [
    a,                              // 1: lowest = at p75 (won't clear unless RRP ≥ p75)
    Math.round((a + b) / 2),         // 2
    b,                              // 3: at p90
    Math.round(b * 1.5),             // 4
    Math.round(b * 2.0),             // 5
    500,                             // 6
    1000,                            // 7
    2500,                            // 8
    5000,                            // 9
    MPC,                             // 10: market price cap (extreme spike capture)
  ]
  return packLadder(prices, power)
}

/**
 * Build a conservative 10-band "default coverage" charge ladder. Mirror of
 * the discharge default: anchor at p25 (highest band — only clears below
 * the active-trade trigger) and step down through p10 to MPF, so virtually
 * no MW clears at the per-interval forecast — but if reality plunges past
 * the forecast we still capture some of the negative-price trough.
 */
function buildDefaultChargeLadder(p25: number, p10: number, power: number): Band[] {
  const top = Math.floor(p25)
  const mid = Math.floor(Math.min(top - 1, p10))
  // Build descending → reverse to ascending so packLadder's invariant holds.
  const prices = [
    MPF,                             // 1: market price floor — capture deepest negative
    -500,                            // 2
    -200,                            // 3
    -50,                             // 4
    0,                               // 5: clears if RRP ≤ 0
    Math.round(mid * 0.5),           // 6
    mid,                             // 7: at p10
    Math.round((mid + top) / 2),     // 8
    Math.round((mid + top * 2) / 3), // 9: leans closer to p25
    top,                             // 10: at p25 (lower threshold of "default" band)
  ]
  return packLadder(prices, power)
}

/**
 * Clamp prices to [MPF, MPC], enforce strict ascending order, and attach
 * MW weights summing to `power`. Returns exactly LADDER_WEIGHTS.length bands.
 */
function packLadder(rawPrices: number[], power: number): Band[] {
  const prices = enforceAscending(rawPrices)
  return prices.map((price, i) => ({
    price,
    mw: round1(power * (LADDER_WEIGHTS[i] / 100)),
  }))
}

/**
 * Clamp to [MPF, MPC] then walk left-to-right, bumping each successor by
 * +1 if needed to keep prices strictly ascending. If we'd run off the
 * MPC end, walk back right-to-left and compress predecessors downward.
 */
function enforceAscending(prices: number[]): number[] {
  const out: number[] = []
  for (const p of prices) {
    const clamped = Math.max(MPF, Math.min(MPC, p))
    if (out.length === 0) out.push(clamped)
    else out.push(Math.max(clamped, out[out.length - 1] + 1))
  }
  // If the forward pass exceeded MPC, compress back down.
  for (let i = out.length - 1; i > 0; i--) {
    if (out[i] > MPC) out[i] = MPC
    if (out[i - 1] >= out[i]) out[i - 1] = Math.max(MPF, out[i] - 1)
  }
  return out
}

// ---- Math helpers ---------------------------------------------------------

function pctile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))
  return sorted[idx]
}

/** Sum of band MW that clears against `rrp`, using AEMO clearing rules. */
function expectedClearMw(direction: 'GEN' | 'LOAD', bands: Band[], rrp: number): number {
  if (direction === 'GEN') return bands.reduce((s, b) => s + (b.price <= rrp ? b.mw : 0), 0)
  return bands.reduce((s, b) => s + (b.price >= rrp ? b.mw : 0), 0)
}

/**
 * Expected P&L if RRP = forecast at this interval. Per cleared band, edge
 * = (RRP − band.price) for GEN, (band.price − RRP) for LOAD — both
 * positive for a clearing band. Discharge edge is shown +, charge is shown
 * − (a cash outflow) so the column read top-down matches signed cash flow.
 */
function estPnl(direction: 'GEN' | 'LOAD', bands: Band[], rrp: number): number {
  if (direction === 'GEN') {
    const edge = bands.reduce((s, b) => s + (b.price <= rrp ? (rrp - b.price) * b.mw : 0), 0)
    return edge * INTERVAL_HRS
  }
  const edge = bands.reduce((s, b) => s + (b.price >= rrp ? (b.price - rrp) * b.mw : 0), 0)
  return -edge * INTERVAL_HRS
}

function round1(v: number): number {
  return Math.round(v * 10) / 10
}

/** AEMO MaxAvail = the worst-case dispatched MW if every band cleared. */
function sumBandMw(bands: Band[]): number {
  return bands.reduce((acc, b) => acc + (Number.isFinite(b.mw) ? b.mw : 0), 0)
}

/**
 * Apply AEMO MLF to a raw energy P&L estimate.
 *   GEN  revenue scales by × MLF (less revenue when MLF < 1)
 *   LOAD cost   scales by ÷ MLF (more cost   when MLF < 1)
 * `rawPnl` is signed (+ revenue / − cost) so we apply the direction-specific
 * multiplier to the magnitude and re-attach the sign.
 */
function applyMlf(direction: 'GEN' | 'LOAD', rawPnl: number, mlf: number): number {
  if (!Number.isFinite(mlf) || mlf <= 0) return rawPnl
  return direction === 'GEN' ? rawPnl * mlf : rawPnl / mlf
}

// ---- FCAS leg builder ----------------------------------------------------

/**
 * Build BOTH FCAS legs for an interval, AEMO trapezium-style:
 *
 *   Bucket constraint (paper backend, see `_check_co_optimisation`):
 *     upward   bucket = ENERGY-GEN  + Σ RAISE_FCAS  ≤ power_mw
 *     downward bucket = ENERGY-LOAD + Σ LOWER_FCAS  ≤ power_mw
 *
 *   For a GEN-direction energy bid with bid_max = energyPower:
 *     - Opposite bucket (downward) is empty → LOWER FCAS leg sized at full power.
 *     - Same bucket (upward) has energy already occupying energyPower → RAISE
 *       FCAS leg sized at (power − energyPower) = `sameLegMw`. Skipped if 0.
 *   For a LOAD-direction energy bid, mirror sides.
 *
 *   Each leg is a single-band price-taker (band price = 0 → clears at any
 *   positive FCAS RRP), backed by the highest-paying market on that side
 *   above the floor threshold.
 */
function buildFcasLegs(
  fcas: FCAS | undefined,
  energyDir: 'GEN' | 'LOAD',
  power: number,
  sameLegMw: number,
): { opp?: FcasSuggestion; same?: FcasSuggestion } {
  if (!fcas) return {}
  // Opposite bucket: opposite of the energy direction.
  // GEN energy → opposite is downward → LOWER FCAS.
  // LOAD energy → opposite is upward   → RAISE FCAS.
  const oppSide: 'raise' | 'lower' = energyDir === 'GEN' ? 'lower' : 'raise'
  const sameSide: 'raise' | 'lower' = energyDir === 'GEN' ? 'raise' : 'lower'
  // FCAS bid direction follows the FCAS bucket itself: raise → GEN, lower → LOAD.
  const oppDir: 'GEN' | 'LOAD' = oppSide === 'raise' ? 'GEN' : 'LOAD'
  const sameDir: 'GEN' | 'LOAD' = sameSide === 'raise' ? 'GEN' : 'LOAD'
  const opp = pickBestFcas(fcas, oppSide, power, 'opposite', oppDir)
  const same = sameLegMw > 0
    ? pickBestFcas(fcas, sameSide, sameLegMw, 'same', sameDir)
    : undefined
  return { opp, same }
}

/** Pick the highest-paying FCAS market for one side and frame as a leg. */
function pickBestFcas(
  fcas: FCAS,
  side: 'raise' | 'lower',
  mw: number,
  legSide: FcasLegSide,
  fcasDir: 'GEN' | 'LOAD',
): FcasSuggestion | undefined {
  if (mw <= 0) return undefined
  const candidates = side === 'raise' ? RAISE_FCAS_MARKETS : LOWER_FCAS_MARKETS
  let best: { market: Market; labelKey: string; price: number } | null = null
  for (const c of candidates) {
    const v = fcas[c.key]
    if (v === null || v === undefined || !Number.isFinite(v) || (v as number) < FCAS_MIN_THRESHOLD) continue
    if (!best || (v as number) > best.price) {
      best = { market: c.market, labelKey: c.labelKey, price: v as number }
    }
  }
  if (!best) return undefined
  return {
    side: legSide,
    market: best.market,
    labelKey: best.labelKey,
    fcasDir,
    forecastRrp: best.price,
    bidPrice: 0,                              // price-taker: clears whenever FCAS RRP > 0
    mw,
    estPnl: best.price * mw * INTERVAL_HRS,
  }
}

// ---- Expandable ladder table (editable) ----------------------------------

type LadderIssue = 'price-range' | 'mw-negative' | 'mw-nan' | 'non-monotonic'
type LadderValidation = { ok: boolean; issues: Map<number, LadderIssue> }

function rowKey(s: Pick<Suggestion, 'target' | 'direction'>): string {
  return `${s.target}:${s.direction}`
}

function validateLadder(bands: Band[]): LadderValidation {
  const issues = new Map<number, LadderIssue>()
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i]
    if (!Number.isFinite(b.price) || b.price < MPF || b.price > MPC) {
      issues.set(i, 'price-range')
      continue
    }
    if (!Number.isFinite(b.mw)) { issues.set(i, 'mw-nan'); continue }
    if (b.mw < 0) { issues.set(i, 'mw-negative'); continue }
    if (i > 0 && b.price <= bands[i - 1].price) {
      issues.set(i, 'non-monotonic')
    }
  }
  return { ok: issues.size === 0, issues }
}

function LadderTable({
  bands, forecastRrp, direction, modified, validation, onChange, onReset, t,
}: {
  bands: Band[]
  forecastRrp: number
  direction: 'GEN' | 'LOAD'
  modified: boolean
  validation: LadderValidation
  onChange: (idx: number, patch: Partial<Band>) => void
  onReset: () => void
  t: (k: string, ...args: (string | number)[]) => string
}) {
  const totalMw = bands.reduce((acc, b) => acc + (Number.isFinite(b.mw) ? b.mw : 0), 0)
  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] text-muted uppercase tracking-wider">
          {t('sug.ladder.title')}
        </div>
        <div className="flex items-center gap-3">
          <div className="text-[10px] text-muted tabular-nums">
            {t('sug.ladder.totalMw', totalMw.toFixed(1))}
          </div>
          {modified && (
            <button
              onClick={onReset}
              className="text-[10px] px-2 py-0.5 rounded bg-surfaceAlt hover:bg-hairlineSoft text-ink2 transition"
            >
              {t('sug.ladder.reset')}
            </button>
          )}
        </div>
      </div>
      <table className="w-full text-[11px] tabular-nums">
        <thead className="text-muted text-[10px]">
          <tr>
            <th className="text-left  px-2 py-1 font-medium w-8">#</th>
            <th className="text-right px-2 py-1 font-medium">{t('sug.col.bid')}</th>
            <th className="text-right px-2 py-1 font-medium">{t('sug.col.mw')}</th>
            <th className="text-right px-2 py-1 font-medium">{t('sug.ladder.clears')}</th>
            <th className="text-left  px-2 py-1 font-medium">{t('sug.ladder.issueCol')}</th>
          </tr>
        </thead>
        <tbody>
          {bands.map((b, i) => {
            const clears = direction === 'GEN' ? b.price <= forecastRrp : b.price >= forecastRrp
            const issue = validation.issues.get(i)
            const priceBad = issue === 'price-range' || issue === 'non-monotonic'
            const mwBad = issue === 'mw-negative' || issue === 'mw-nan'
            return (
              <tr key={i} className={clears ? 'text-ink' : 'text-muted/70'}>
                <td className="px-2 py-1">{i + 1}</td>
                <td className="px-2 py-1 text-right">
                  <NumInput
                    value={b.price}
                    step={1}
                    min={MPF}
                    max={MPC}
                    invalid={priceBad}
                    onChange={(v) => onChange(i, { price: v })}
                  />
                </td>
                <td className="px-2 py-1 text-right">
                  <NumInput
                    value={b.mw}
                    step={0.1}
                    min={0}
                    invalid={mwBad}
                    onChange={(v) => onChange(i, { mw: v })}
                  />
                </td>
                <td className="px-2 py-1 text-right">
                  {clears ? <span className="text-positive">●</span> : <span>○</span>}
                </td>
                <td className="px-2 py-1 text-left text-[10px]">
                  {issue && <span className="text-negative">{issueLabel(issue, i, bands, t)}</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function NumInput({
  value, step, min, max, invalid, onChange,
}: {
  value: number
  step: number
  min?: number
  max?: number
  invalid: boolean
  onChange: (v: number) => void
}) {
  // Controlled input keyed off the parent value. We parse the raw string on
  // every change so the parent re-validates immediately; empty / NaN inputs
  // flow through as NaN so validateLadder catches them.
  const displayValue = Number.isFinite(value) ? String(value) : ''
  const borderClass = invalid
    ? 'border-negative focus:border-negative'
    : 'border-hairlineSoft focus:border-accent'
  return (
    <input
      type="number"
      value={displayValue}
      step={step}
      min={min}
      max={max}
      onChange={(e) => {
        const raw = e.target.value
        onChange(raw === '' ? NaN : Number(raw))
      }}
      className={`w-24 text-right tabular-nums bg-transparent border ${borderClass} rounded px-1.5 py-0.5 focus:outline-none transition`}
    />
  )
}

/**
 * Tooltip text for the FCAS row badge — summarises whichever legs are
 * active. Used by the main table row, not the expanded panel.
 */
function fcasBadgeTitle(
  s: Suggestion,
  oppOn: boolean,
  sameOn: boolean,
  t: (k: string, ...args: (string | number)[]) => string,
): string {
  const parts: string[] = []
  if (oppOn && s.fcasOpp) {
    parts.push(t('sug.fcas.badgeTitleLeg',
      t('sug.fcas.legOpposite'),
      t(s.fcasOpp.labelKey),
      s.fcasOpp.forecastRrp.toFixed(2),
      s.fcasOpp.mw.toFixed(0)))
  }
  if (sameOn && s.fcasSame) {
    parts.push(t('sug.fcas.badgeTitleLeg',
      t('sug.fcas.legSame'),
      t(s.fcasSame.labelKey),
      s.fcasSame.forecastRrp.toFixed(2),
      s.fcasSame.mw.toFixed(0)))
  }
  return parts.join(' · ')
}

/**
 * Compact panel shown below the ladder table inside the expanded row.
 * Renders BOTH FCAS legs (AEMO trapezium dual-leg) with separate
 * toggles. Opposite-direction always fits (independent bucket); same-
 * direction only appears when the trapezium reserve % is > 0 and the
 * energy ladder was shrunk to free headroom in the same bucket.
 */
function FcasLegPanel({
  opp, same, oppIncluded, sameIncluded, onToggleOpp, onToggleSame, t,
}: {
  opp: FcasSuggestion | null
  same: FcasSuggestion | null
  oppIncluded: boolean
  sameIncluded: boolean
  onToggleOpp: () => void
  onToggleSame: () => void
  t: (k: string, ...args: (string | number)[]) => string
}) {
  if (!opp && !same) {
    return (
      <div className="text-[10px] text-muted italic">
        {t('sug.fcas.none')}
      </div>
    )
  }
  return (
    <div className="border-t border-hairlineSoft pt-2 space-y-1.5">
      <div className="text-[10px] text-muted uppercase tracking-wider">
        {t('sug.fcas.title')}
      </div>
      {opp && (
        <FcasLegRow
          leg={opp}
          included={oppIncluded}
          onToggle={onToggleOpp}
          legLabel={t('sug.fcas.legOpposite')}
          legHint={t('sug.fcas.legOppositeHint')}
          t={t}
        />
      )}
      {same && (
        <FcasLegRow
          leg={same}
          included={sameIncluded}
          onToggle={onToggleSame}
          legLabel={t('sug.fcas.legSame')}
          legHint={t('sug.fcas.legSameHint')}
          t={t}
        />
      )}
    </div>
  )
}

function FcasLegRow({
  leg, included, onToggle, legLabel, legHint, t,
}: {
  leg: FcasSuggestion
  included: boolean
  onToggle: () => void
  legLabel: string
  legHint: string
  t: (k: string, ...args: (string | number)[]) => string
}) {
  return (
    <div className="flex items-center gap-3 text-[11px] tabular-nums">
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={included}
          onChange={onToggle}
          className="accent-positive"
        />
        <span
          className="text-[10px] px-1 py-0.5 rounded bg-surfaceAlt text-ink2 uppercase tracking-wider"
          title={legHint}
        >
          {legLabel}
        </span>
      </label>
      <span className={included ? 'text-ink' : 'text-muted/70 line-through'}>
        {t(leg.labelKey)}
      </span>
      <span className={included ? 'text-ink2' : 'text-muted/70'}>
        {t('sug.fcas.detail', leg.mw.toFixed(0), leg.bidPrice.toFixed(2), leg.forecastRrp.toFixed(2))}
      </span>
      <span
        className="ml-auto font-medium"
        style={{ color: included ? '#34c759' : '#9aa0a6' }}
      >
        {fmtAud(included ? leg.estPnl : 0)}
      </span>
    </div>
  )
}

function issueLabel(
  issue: LadderIssue,
  idx: number,
  bands: Band[],
  t: (k: string, ...args: (string | number)[]) => string,
): string {
  switch (issue) {
    case 'price-range': return t('sug.ladder.issue.range', MPF, MPC)
    case 'mw-negative': return t('sug.ladder.issue.mw')
    case 'mw-nan':      return t('sug.ladder.issue.mwNaN')
    case 'non-monotonic':
      return t('sug.ladder.issue.monotonic', idx, bands[idx - 1]?.price ?? 0)
  }
}

// ---- Display helpers ------------------------------------------------------

/** Pick the most informative line to show when the table is empty. */
function emptyReason(
  stats: Stats,
  t: (k: string, ...args: (string | number)[]) => string,
): string {
  if (stats.forecastPts === 0) return t('sug.empty.noForecast')
  if (stats.socBlock === 'no-discharge' && stats.rawCharge === 0) return t('sug.empty.socLow')
  if (stats.socBlock === 'no-charge' && stats.rawDischarge === 0) return t('sug.empty.socHigh')
  if (stats.rawDischarge + stats.rawCharge === 0) return t('sug.empty.flat')
  if (stats.filteredPending >= stats.rawDischarge + stats.rawCharge) return t('sug.empty.allPending')
  return t('sug.empty')
}

function fmtTs(iso: string): string {
  const d = iso.slice(8, 10)
  const m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(iso.slice(5,7)) - 1] || ''
  return `${d} ${m} · ${iso.slice(11, 16)}`
}

/**
 * Compact countdown formatter for the gate-open state — chooses the
 * coarsest unit that still fits. >1h shows hours+min, >1min shows
 * minutes, otherwise seconds. Used in the row cell where space is tight.
 */
function fmtCountdown(sec: number): string {
  if (sec >= 3600) {
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    return m > 0 ? `${h}h ${m}m` : `${h}h`
  }
  if (sec >= 60) return `${Math.floor(sec / 60)}m`
  return `${sec}s`
}

/**
 * Relative duration formatter (used in tooltips) — always includes the
 * largest unit + one subordinate unit for legibility. `sec` is positive.
 */
function fmtRel(sec: number): string {
  if (sec < 0) return fmtRel(-sec)
  if (sec < 60) return `${sec}s`
  if (sec < 3600) {
    const m = Math.floor(sec / 60)
    const s = sec % 60
    return s > 0 ? `${m}m ${s}s` : `${m}m`
  }
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

function fmtAud(v: number): string {
  const sign = v >= 0 ? '+' : '−'
  return `${sign}$${Math.abs(v).toLocaleString('en-AU', { maximumFractionDigits: 0 })}`
}

/**
 * Build the AEMO rebid-reason prefix that gets prepended to every submitted
 * bid's notes field. Format examples:
 *   "[INITIAL] · "
 *   "[PRICE] · "
 *   "[FORECAST] AEMO P5MIN revised peak +$120 · "
 * Empty note → "[CODE] · "; non-empty note → "[CODE] <note> · ". The
 * trailing " · " is the separator before the auto-suggestion descriptor
 * that follows in submitSuggestion(). Note is trimmed and length-capped
 * defensively (the input already enforces maxLength, but cheap to belt-
 * and-braces here too).
 */
function buildReasonPrefix(code: RebidReasonCode, rawNote: string): string {
  const note = rawNote.trim().slice(0, REBID_NOTE_MAX)
  if (note.length === 0) return `[${code}] · `
  return `[${code}] ${note} · `
}

/** Header summary stat as a small visual pill. Each metric (discharge count,
 *  charge count, est. PnL, FCAS legs, warnings…) gets its own pill so the
 *  user can scan them at a glance instead of parsing a run-on " · "-line. */
function StatPill({ label, value, accent = 'muted', tooltip }: {
  label: string
  value: string
  accent?: 'muted' | 'positive' | 'negative' | 'warn' | 'discharge' | 'charge'
  tooltip?: string
}) {
  // Subtle background tint + matched text color, no border — keeps the
  // header airy. Discharge = accent orange (selling); charge = brand blue.
  const palette: Record<string, { bg: string; text: string }> = {
    muted:     { bg: 'bg-surfaceAlt',          text: 'text-ink2' },
    positive:  { bg: 'bg-positive/10',         text: 'text-positive' },
    negative:  { bg: 'bg-negative/10',         text: 'text-negative' },
    warn:      { bg: 'bg-warn/10',             text: 'text-warn' },
    discharge: { bg: 'bg-accent/10',           text: 'text-accent' },
    charge:    { bg: 'bg-[#0a84ff]/10',        text: 'text-[#0a84ff]' },
  }
  const c = palette[accent] ?? palette.muted
  return (
    <span
      className={`inline-flex items-baseline gap-1 px-2.5 py-1 rounded-md text-[11px] ${c.bg} ${c.text}`}
      title={tooltip}
    >
      <span className="opacity-70 uppercase tracking-wide text-[9px]">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </span>
  )
}

/** One row inside the collapsible "How this works" help panel. Replaces
 *  the previous wall-of-text paragraph with 6 themed cards — each ~2 lines,
 *  scannable, and grouped by what the user is actually looking at on screen. */
function HelpItem({ icon, titleKey, bodyKey, t }: {
  icon: string
  titleKey: string
  bodyKey: string
  t: (k: string, ...args: any[]) => string
}) {
  return (
    <div className="flex gap-2">
      <span className="text-[14px] leading-tight shrink-0" aria-hidden>{icon}</span>
      <div>
        <div className="text-ink font-medium">{t(titleKey)}</div>
        <div className="text-muted">{t(bodyKey)}</div>
      </div>
    </div>
  )
}
