/**
 * BESSDispatchPanel — Real-time dispatch recommendation + paper bid execution
 *
 * Shows a colour-coded timeline of charge / discharge / idle actions for the
 * next 2 hours (24 × 5-min intervals) derived from AEMO P5MIN forecast prices
 * and the current BESS state of charge.
 *
 * Layout
 * ------
 *  ┌─ Summary bar (SoC, expected revenue, n-charge, n-discharge) ──────────┐
 *  │ Interval timeline — coloured action bars stacked horizontally          │
 *  │ Price sparkline below (same time axis)                                 │
 *  │ "Bid this plan" button → confirmation → result + bid tracker          │
 *  └────────────────────────────────────────────────────────────────────────┘
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ActiveConstraints, Bid, DispatchInterval, DispatchPlan, PaperBidBatchResult } from '../types'
import { fetchActiveConstraints, fetchDispatchPlan, fetchPaperBids, submitPaperBidBatch } from '../api'
import type { PaperBatchBidItem } from '../api'
import { useT } from '../i18n'
import { FCASBidPanel } from './FCASBidPanel'

// Action colour palette
const ACTION_COLOR: Record<string, string> = {
  discharge: '#ff9500',   // amber — selling energy
  charge:    '#34c759',   // green — buying cheap
  idle:      '#e5e5ea',   // light grey
}

const ACTION_LABEL_EN: Record<string, string> = {
  discharge: 'Discharge',
  charge:    'Charge',
  idle:      'Idle',
}
const ACTION_LABEL_ZH: Record<string, string> = {
  discharge: '放电',
  charge:    '充电',
  idle:      '待机',
}

function fmtTime(iso: string): string {
  return iso.slice(11, 16)
}

function fmtAUD(v: number): string {
  if (Math.abs(v) >= 1000) return `$${(v / 1000).toFixed(1)}k`
  return `$${v.toFixed(0)}`
}

function fmtAUDFull(v: number): string {
  const sign = v < 0 ? '−' : '+'
  return `${sign}$${Math.abs(v).toFixed(2)}`
}

function priceBarHeight(price: number, minP: number, maxP: number, maxH = 40): number {
  if (maxP === minP) return maxH / 2
  return Math.max(2, ((price - minP) / (maxP - minP)) * maxH)
}

function socColor(pct: number): string {
  if (pct < 15) return '#ff3b30'
  if (pct < 40) return '#ff9500'
  return '#30d158'
}

/** Gate close time for an interval: NEM interval end − 5 min 30 s.
 *  NEM time = UTC+10, stored as naive "YYYY-MM-DD HH:MM:SS". */
function gateSecondsLeft(intervalNem: string): number {
  const ivUtc = new Date(intervalNem.replace(' ', 'T') + '+10:00').getTime()
  const gateUtc = ivUtc - 5.5 * 60 * 1000
  return Math.floor((gateUtc - Date.now()) / 1000)
}

function fmtCountdown(s: number): string {
  if (s <= 0) return '0:00'
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}:${String(sec).padStart(2, '0')}`
}

type Props = {
  duid?: string
  region?: string
}

export function BESSDispatchPanel({ duid = 'WTAHB1', region = 'NSW1' }: Props) {
  const { t, lang } = useT()
  const [plan, setPlan] = useState<DispatchPlan | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hovered, setHovered] = useState<DispatchInterval | null>(null)
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)

  // Bid-plan state
  const [bidConfirm, setBidConfirm] = useState(false)
  const [bidding, setBidding] = useState(false)
  const [bidResult, setBidResult] = useState<PaperBidBatchResult | null>(null)
  const [trackedBidIds, setTrackedBidIds] = useState<number[]>([])
  const [trackedBids, setTrackedBids] = useState<Bid[]>([])

  // Gate countdown (seconds to first interval's gate close)
  const [countdown, setCountdown] = useState<number | null>(null)
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Constraint alerts
  const [activeConstraints, setActiveConstraints] = useState<ActiveConstraints | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    fetchDispatchPlan(duid, region, 24)
      .then(setPlan)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false))
  }, [duid, region])

  useEffect(() => { load() }, [load])

  // Auto-refresh every 5 minutes
  useEffect(() => {
    const id = setInterval(load, 5 * 60 * 1000)
    return () => clearInterval(id)
  }, [load])

  // Gate countdown — ticks every second off the first interval
  useEffect(() => {
    if (countdownRef.current) clearInterval(countdownRef.current)
    if (!plan || plan.plan.length === 0) { setCountdown(null); return }
    const first = plan.plan[0].interval
    const update = () => setCountdown(gateSecondsLeft(first))
    update()
    countdownRef.current = setInterval(update, 1000)
    return () => { if (countdownRef.current) clearInterval(countdownRef.current) }
  }, [plan])

  // Poll active constraints every 5 min (matches dispatch plan refresh)
  useEffect(() => {
    const poll = () => fetchActiveConstraints(region).then(setActiveConstraints).catch(() => {})
    poll()
    const id = setInterval(poll, 5 * 60 * 1000)
    return () => clearInterval(id)
  }, [region])

  // Poll paper bids every 30 s while tracking submitted bids
  useEffect(() => {
    if (trackedBidIds.length === 0) return
    const poll = () => {
      fetchPaperBids(duid, 100)
        .then(({ bids }) => {
          const relevant = bids.filter((b) => trackedBidIds.includes(b.bid_id))
          setTrackedBids(relevant)
        })
        .catch(() => {})
    }
    poll()
    const id = setInterval(poll, 30_000)
    return () => clearInterval(id)
  }, [trackedBidIds, duid])

  const actionLabel = (a: string) =>
    lang === 'zh' ? ACTION_LABEL_ZH[a] ?? a : ACTION_LABEL_EN[a] ?? a

  // ---- Bid plan helpers ----------------------------------------------------

  function planBids(): PaperBatchBidItem[] {
    if (!plan) return []
    return plan.plan
      .filter((iv) => iv.action !== 'idle')
      .map((iv) => {
        const direction = iv.action === 'discharge' ? 'GEN' : 'LOAD'
        // Discharge: offer at 80% of forecast (floor $30) — clears when actual RRP >= band price
        // Charge: willing to pay up to 120% of forecast — clears when RRP <= band price
        const bandPrice = iv.action === 'discharge'
          ? Math.max(30, iv.price_forecast_aud * 0.8)
          : Math.min(17500, iv.price_forecast_aud * 1.2)
        return {
          target_settlementdate: iv.interval.replace('T', ' ').slice(0, 19),
          market: 'ENERGY',
          direction,
          bands: [{ price: Math.round(bandPrice * 100) / 100, mw: plan.power_mw }],
        }
      })
  }

  async function handleBidPlan() {
    const bids = planBids()
    if (bids.length === 0) return
    setBidding(true)
    try {
      const result = await submitPaperBidBatch(duid, bids)
      setBidResult(result)
      setBidConfirm(false)
      const ids = result.results.filter((r) => r.ok && r.bid_id != null).map((r) => r.bid_id!)
      setTrackedBidIds(ids)
    } catch (e) {
      setBidResult({
        submitted: 0, failed: bids.length,
        results: [{ ok: false, target: '', market: 'ENERGY', direction: 'GEN', error: String(e) }],
      })
      setBidConfirm(false)
    } finally {
      setBidding(false)
    }
  }

  // ---- Render guards -------------------------------------------------------

  if (loading && !plan) {
    return (
      <div className="rounded-2xl border border-border bg-surface p-5">
        <p className="text-sm text-ink2 animate-pulse">{t('dp.loading')}</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-border bg-surface p-5">
        <p className="text-sm text-red-500">{t('dp.error')}: {error}</p>
        <button onClick={load} className="mt-2 text-xs text-accent underline">{t('dp.retry')}</button>
      </div>
    )
  }

  if (!plan) return null

  const intervals = plan.plan
  const prices = intervals.map((iv) => iv.price_forecast_aud)
  const minP = Math.min(...prices)
  const maxP = Math.max(...prices)
  const MAX_BAR_H = 36

  const bidsToPlace = planBids()
  const nDischarge = bidsToPlace.filter((b) => b.direction === 'GEN').length
  const nCharge    = bidsToPlace.filter((b) => b.direction === 'LOAD').length

  const gateOk = countdown !== null && countdown > 0
  const countdownColor = countdown !== null && countdown < 60
    ? '#ff3b30'
    : countdown !== null && countdown < 180
      ? '#ff9500'
      : '#30d158'

  return (
    <div className="rounded-2xl border border-border bg-surface p-5 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-[13px] font-semibold text-ink tracking-tight">
            {t('dp.title')}
          </h3>
          <p className="text-[11px] text-ink3 mt-0.5">
            {t('dp.subtitle')} · {plan.horizon_minutes} {t('dp.mins')}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Gate countdown */}
          {countdown !== null && (
            <div className="text-[10px] font-mono flex items-center gap-1">
              <span className="text-ink3">{gateOk ? t('dp.bidGateIn') : t('dp.bidGateClosed')}</span>
              {gateOk && (
                <span
                  className="font-semibold px-1.5 py-0.5 rounded"
                  style={{ color: countdownColor, backgroundColor: countdownColor + '18' }}
                >
                  {fmtCountdown(countdown)}
                </span>
              )}
            </div>
          )}
          <button
            onClick={load}
            disabled={loading}
            className="text-[11px] text-accent hover:opacity-70 transition-opacity disabled:opacity-40"
          >
            ↻ {t('dp.refresh')}
          </button>
        </div>
      </div>

      {/* Constraint alert banner */}
      {activeConstraints && activeConstraints.severity > 0 && activeConstraints.active.length > 0 && (
        <div
          className="rounded-lg px-3 py-2 text-[11px] flex items-start gap-2"
          style={{
            background: activeConstraints.severity === 2 ? '#fef2f2' : '#fffbeb',
            border: `1px solid ${activeConstraints.severity === 2 ? '#fca5a5' : '#fde68a'}`,
            color: activeConstraints.severity === 2 ? '#b91c1c' : '#92400e',
          }}
        >
          <span style={{ fontSize: 13 }}>{activeConstraints.severity === 2 ? '🔴' : '🟡'}</span>
          <div>
            <span className="font-semibold">
              {activeConstraints.severity === 2 ? t('dp.constraintViolated') : t('dp.constraintBinding')}
            </span>
            {' — '}
            {activeConstraints.active.slice(0, 3).map((c, i) => (
              <span key={i}>
                <code style={{ fontSize: 10, background: activeConstraints.severity === 2 ? '#fee2e2' : '#fef3c7', borderRadius: 2, padding: '0 3px' }}>
                  {c.constraintid}
                </code>
                {' '}
                {c.marginalvalue != null && (
                  <span style={{ color: '#6b7280' }}>${c.marginalvalue.toFixed(0)}/MW</span>
                )}
                {i < Math.min(2, activeConstraints.active.length - 1) && ', '}
              </span>
            ))}
            {activeConstraints.active.length > 3 && (
              <span style={{ color: '#6b7280' }}> {t('dp.constraintMore', activeConstraints.active.length - 3)}</span>
            )}
            {activeConstraints.as_at && (
              <span style={{ color: '#9ca3af', marginLeft: 6 }}>@ {activeConstraints.as_at.slice(11, 16)}</span>
            )}
          </div>
        </div>
      )}

      {/* KPI row */}
      <div className="grid grid-cols-4 gap-3">
        <div className="bg-surfaceAlt rounded-xl p-3">
          <p className="text-[10px] text-ink3 uppercase tracking-wide">{t('dp.socNow')}</p>
          <p className="text-[18px] font-semibold mt-0.5" style={{ color: socColor(plan.current_soc_pct) }}>
            {plan.current_soc_pct.toFixed(0)}<span className="text-[12px] font-normal text-ink3">%</span>
          </p>
          <p className="text-[10px] text-ink3">{plan.current_soc_mwh.toFixed(1)} / {plan.capacity_mwh} MWh</p>
        </div>

        <div className="bg-surfaceAlt rounded-xl p-3">
          <p className="text-[10px] text-ink3 uppercase tracking-wide">{t('dp.expRev')}</p>
          <p className={`text-[18px] font-semibold mt-0.5 ${plan.expected_total_revenue_aud >= 0 ? 'text-green-500' : 'text-red-500'}`}>
            {fmtAUD(plan.expected_total_revenue_aud)}
          </p>
          <p className="text-[10px] text-ink3">{t('dp.next2h')}</p>
        </div>

        <div className="bg-surfaceAlt rounded-xl p-3">
          <p className="text-[10px] text-ink3 uppercase tracking-wide">{t('dp.discharge')}</p>
          <p className="text-[18px] font-semibold mt-0.5" style={{ color: ACTION_COLOR.discharge }}>
            {plan.n_discharge}
            <span className="text-[12px] font-normal text-ink3"> {t('dp.slots')}</span>
          </p>
          {plan.avg_discharge_price !== null && (
            <p className="text-[10px] text-ink3">∅ ${plan.avg_discharge_price.toFixed(0)}/MWh</p>
          )}
        </div>

        <div className="bg-surfaceAlt rounded-xl p-3">
          <p className="text-[10px] text-ink3 uppercase tracking-wide">{t('dp.charge')}</p>
          <p className="text-[18px] font-semibold mt-0.5" style={{ color: ACTION_COLOR.charge }}>
            {plan.n_charge}
            <span className="text-[12px] font-normal text-ink3"> {t('dp.slots')}</span>
          </p>
          {plan.avg_charge_price !== null && (
            <p className="text-[10px] text-ink3">∅ ${plan.avg_charge_price.toFixed(0)}/MWh</p>
          )}
        </div>
      </div>

      {/* Interval timeline */}
      <div className="space-y-1">
        <p className="text-[10px] text-ink3 uppercase tracking-wide">{t('dp.plan')}</p>
        <div className="flex gap-[2px] w-full h-8 items-end">
          {intervals.map((iv, i) => (
            <div
              key={iv.interval}
              className="rounded-sm cursor-pointer transition-opacity"
              style={{
                flex: iv.interval_minutes === 5 ? 1 : 6,
                backgroundColor: ACTION_COLOR[iv.action] ?? '#c7c7cc',
                height: '100%',
                opacity: hoveredIdx === i ? 1 : hoveredIdx !== null ? 0.6 : 0.85,
                borderLeft: iv.source === 'PREDISPATCH' ? '1px solid rgba(255,255,255,0.3)' : undefined,
              }}
              onMouseEnter={() => { setHovered(iv); setHoveredIdx(i) }}
              onMouseLeave={() => { setHovered(null); setHoveredIdx(null) }}
            />
          ))}
        </div>
        <div className="flex gap-[2px] w-full items-end">
          {intervals.map((iv, i) => (
            <div
              key={iv.interval}
              className="rounded-t-sm"
              style={{
                flex: iv.interval_minutes === 5 ? 1 : 6,
                backgroundColor: '#c5b9f5',
                height: `${priceBarHeight(iv.price_forecast_aud, minP, maxP, MAX_BAR_H)}px`,
                opacity: hoveredIdx === i ? 1 : 0.55,
              }}
              onMouseEnter={() => { setHovered(iv); setHoveredIdx(i) }}
              onMouseLeave={() => { setHovered(null); setHoveredIdx(null) }}
            />
          ))}
        </div>
        <div className="flex w-full">
          {intervals.map((iv, i) => (
            <div key={iv.interval} style={{ flex: iv.interval_minutes === 5 ? 1 : 6 }} className="overflow-hidden">
              {(i === 0 || iv.source === 'PREDISPATCH' || i % 6 === 0) && (
                <span className="text-[9px] text-ink3 whitespace-nowrap">{fmtTime(iv.interval)}</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Interval tooltip */}
      {hovered && (
        <div className="rounded-xl bg-surfaceAlt border border-border p-3 text-[11px] space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-ink">
              {fmtTime(hovered.interval)}
              <span className="ml-1 text-[10px] font-normal text-ink3">{hovered.interval_minutes} min</span>
            </span>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-ink3">{hovered.source}</span>
              <span
                className="px-1.5 py-0.5 rounded text-[10px] font-medium"
                style={{
                  backgroundColor: ACTION_COLOR[hovered.action] + '33',
                  color: ACTION_COLOR[hovered.action],
                }}
              >
                {actionLabel(hovered.action)}
              </span>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-ink2">
            <span>{t('dp.price')}</span>
            <span className="text-right font-medium">${hovered.price_forecast_aud.toFixed(2)}/MWh</span>
            {hovered.action !== 'idle' && (
              <>
                <span>{t('dp.power')}</span>
                <span className="text-right font-medium">{hovered.power_mw.toFixed(0)} MW</span>
                <span>{t('dp.revenue')}</span>
                <span className={`text-right font-medium ${hovered.expected_revenue_aud >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                  {fmtAUDFull(hovered.expected_revenue_aud)}
                </span>
              </>
            )}
            <span>{t('dp.socAfter')}</span>
            <span className="text-right font-medium" style={{ color: socColor(hovered.soc_after_pct) }}>
              {hovered.soc_after_pct.toFixed(1)}% ({hovered.soc_after_mwh.toFixed(1)} MWh)
            </span>
          </div>
        </div>
      )}

      {/* Legend */}
      <div className="flex gap-4 flex-wrap">
        {(['discharge', 'charge', 'idle'] as const).map((a) => (
          <div key={a} className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ backgroundColor: ACTION_COLOR[a] }} />
            <span className="text-[10px] text-ink3">{actionLabel(a)}</span>
          </div>
        ))}
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm inline-block bg-[#c5b9f5]" />
          <span className="text-[10px] text-ink3">{t('dp.priceLegend')}</span>
        </div>
      </div>

      {/* ===== BID PLAN SECTION ===== */}

      {/* Submission result card */}
      {bidResult && (
        <div className={`rounded-xl border p-3 text-[11px] space-y-2 ${
          bidResult.failed === 0 ? 'bg-green-50 border-green-200' :
          bidResult.submitted === 0 ? 'bg-red-50 border-red-200' :
          'bg-amber-50 border-amber-200'
        }`}>
          <div className="flex items-center justify-between">
            <span className="font-semibold text-ink">
              {bidResult.submitted} {t('dp.bidOk')}
              {bidResult.failed > 0 && (
                <span className="ml-2 text-red-500">{bidResult.failed} {t('dp.bidFail')}</span>
              )}
            </span>
            <button
              onClick={() => setBidResult(null)}
              className="text-[10px] text-ink3 hover:text-ink underline"
            >
              {t('dp.bidDismiss')}
            </button>
          </div>
          <div className="space-y-0.5">
            {bidResult.results.map((r, i) => (
              <div key={i} className="flex items-center gap-2 text-[10px]">
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${r.ok ? 'bg-green-500' : 'bg-red-500'}`} />
                <span className="text-ink2 font-mono">{r.target.slice(11, 16)}</span>
                <span className="text-ink3">{r.direction === 'GEN' ? '↑ Discharge' : '↓ Charge'}</span>
                {r.ok
                  ? <span className="text-green-600 ml-auto">bid #{r.bid_id}</span>
                  : <span className="text-red-500 ml-auto truncate max-w-[180px]">{r.error}</span>
                }
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Live bid tracker */}
      {trackedBids.length > 0 && (
        <div className="rounded-xl bg-surfaceAlt border border-border p-3 text-[11px] space-y-1.5">
          <p className="text-[10px] text-ink3 uppercase tracking-wide font-semibold">{t('dp.bidStatusTitle')}</p>
          <div className="space-y-1">
            {trackedBids.map((b) => (
              <div key={b.bid_id} className="flex items-center gap-2">
                <span
                  className="px-1.5 py-0.5 rounded text-[9px] font-semibold flex-shrink-0"
                  style={{
                    backgroundColor: b.status === 'SETTLED' ? '#30d15820' : b.status === 'PENDING' ? '#ff950020' : '#c7c7cc40',
                    color:           b.status === 'SETTLED' ? '#30d158'   : b.status === 'PENDING' ? '#ff9500'   : '#8e8e93',
                  }}
                >
                  {t(b.status === 'SETTLED' ? 'dp.bidSettled' : b.status === 'PENDING' ? 'dp.bidPending' : 'dp.bidCancelled')}
                </span>
                <span className="font-mono text-ink2">{b.target_settlementdate.slice(11, 16)}</span>
                <span className="text-ink3">{b.direction === 'GEN' ? '↑ Discharge' : '↓ Charge'}</span>
                <span className="text-ink3 ml-auto text-[9px] font-mono">#{b.bid_id}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Confirmation panel */}
      {bidConfirm && (
        <div className="rounded-xl border border-accent/30 bg-accent/5 p-3 text-[11px] space-y-2">
          <p className="font-semibold text-ink">{t('dp.bidConfirmTitle')}</p>
          <p className="text-ink3 text-[10px] leading-relaxed">{t('dp.bidConfirmHint')}</p>
          {bidsToPlace.length === 0 ? (
            <p className="text-amber-500">{t('dp.bidNone')}</p>
          ) : (
            <div className="space-y-0.5 max-h-40 overflow-y-auto">
              {bidsToPlace.map((b, i) => (
                <div key={i} className="flex items-center gap-2 text-[10px] text-ink2">
                  <span
                    className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                    style={{ backgroundColor: b.direction === 'GEN' ? ACTION_COLOR.discharge : ACTION_COLOR.charge }}
                  />
                  <span className="font-mono">{b.target_settlementdate.slice(11, 16)}</span>
                  <span>{b.direction === 'GEN' ? '↑ Discharge' : '↓ Charge'}</span>
                  <span className="text-ink3">${b.bands[0].price.toFixed(0)}/MWh · {b.bands[0].mw} MW</span>
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-2 pt-1">
            <button
              onClick={handleBidPlan}
              disabled={bidding || bidsToPlace.length === 0}
              className="flex-1 text-[11px] py-1.5 rounded-md bg-accent text-white font-medium hover:opacity-90 disabled:opacity-40 transition-opacity"
            >
              {bidding ? t('dp.bidSubmitting') : `${t('dp.bidConfirmBtn')} (${bidsToPlace.length})`}
            </button>
            <button
              onClick={() => setBidConfirm(false)}
              disabled={bidding}
              className="text-[11px] px-3 py-1.5 rounded-md border border-border text-ink2 hover:text-ink transition-colors disabled:opacity-40"
            >
              {t('dp.bidCancel')}
            </button>
          </div>
        </div>
      )}

      {/* "Bid this plan" trigger */}
      {!bidConfirm && !bidResult && (
        <button
          onClick={() => setBidConfirm(true)}
          disabled={bidsToPlace.length === 0}
          className={`w-full text-[11px] py-2 rounded-md font-medium transition-colors ${
            bidsToPlace.length > 0
              ? 'bg-accent text-white hover:opacity-90'
              : 'border border-hairlineSoft text-muted cursor-default'
          }`}
        >
          {bidsToPlace.length > 0
            ? `📋 ${t('dp.bidPlan')} — ${nDischarge > 0 ? `${nDischarge} ↑` : ''}${nDischarge > 0 && nCharge > 0 ? '  ·  ' : ''}${nCharge > 0 ? `${nCharge} ↓` : ''}`
            : t('dp.bidNone')}
        </button>
      )}

      {/* Footer */}
      <p className="text-[10px] text-ink3">
        {t('dp.mlf')} {plan.mlf.toFixed(4)} · {t('dp.rte')} {plan.rte_pct.toFixed(0)}% · {hovered ? '' : t('dp.hoverHint')}
      </p>

      {/* FCAS bid panel — collapsible */}
      <FCASCollapsible powerMw={plan.power_mw} duid={duid} region={region} />
    </div>
  )
}

/** Collapsible FCAS bid section at the bottom of the dispatch panel. */
function FCASCollapsible({ powerMw, duid }: { powerMw: number; duid: string; region: string }) {
  const [open, setOpen] = useState(false)
  const { t } = useT()
  return (
    <div style={{ borderTop: '1px solid #f3f4f6', paddingTop: 8, marginTop: 4 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: 'none', border: 'none', cursor: 'pointer',
          padding: '2px 0', fontSize: 11, color: '#6b7280',
        }}
      >
        <span style={{ fontWeight: 600, color: open ? '#3b82f6' : '#374151' }}>
          {t('dp.fcasSection')}
        </span>
        <span style={{ fontSize: 10, color: '#9ca3af' }}>
          {open ? t('dp.collapse') : t('dp.expand')}
        </span>
      </button>
      {open && (
        <div style={{ marginTop: 10 }}>
          <FCASBidPanel duid={duid} powerMw={powerMw} />
        </div>
      )}
    </div>
  )
}
