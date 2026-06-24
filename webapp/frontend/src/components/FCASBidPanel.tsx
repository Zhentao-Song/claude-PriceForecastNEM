/**
 * FCASBidPanel — Submit an FCAS bid with a co-optimisation trapezium.
 *
 * Flow:
 *   1. User selects FCAS market (RAISE / LOWER tabs + specific market chip)
 *   2. Picks a target 5-min interval from the next available windows
 *   3. Enters MW capacity offered and price ($/MW/h)
 *   4. Adjusts trapezium in the embedded builder (market-linked → updates
 *      the response window validation automatically)
 *   5. Hits "Submit FCAS Bid" → POST /api/paper/bids with fcas_trapezium
 *   6. Success card shows bid_id and links to the bid tracker
 */
import { useEffect, useState } from 'react'
import { fetchPaperIntervals, fetchPaperMarkets, submitPaperBid } from '../api'
import type { Market, MarketCatalog, NextIntervals, VPPFcasTrapezium } from '../types'
import { FCASTrapeziuBuilder } from './FCASTrapeziuBuilder'
import { useT } from '../i18n'

// ---- helpers ---------------------------------------------------------------

function fmtNem(iso: string): string {
  // "2026-05-28 14:30:00" → "14:30"
  return iso.slice(11, 16)
}

/** RAISE markets dispatch direction is always GEN, LOWER → LOAD. */
function directionFor(market: string): 'GEN' | 'LOAD' {
  return market.startsWith('LOWER') ? 'LOAD' : 'GEN'
}

/** i18n key suffix per market — resolves via t('fcasBid.mkt.RAISE6SEC') etc. */
const MARKET_KEY_PREFIX = 'fcasBid.mkt.'

// Preferred display order within each tab
const RAISE_ORDER: Market[] = ['RAISE1SEC', 'RAISE6SEC', 'RAISE60SEC', 'RAISE5MIN', 'RAISEREG']
const LOWER_ORDER: Market[] = ['LOWER1SEC', 'LOWER6SEC', 'LOWER60SEC', 'LOWER5MIN', 'LOWERREG']

// ---- component -------------------------------------------------------------

interface Props {
  duid?: string
  powerMw?: number
}

type Tab = 'raise' | 'lower'

export function FCASBidPanel({ duid = 'WTAHB1', powerMw = 100 }: Props) {
  // Market / interval selection
  const [tab, setTab] = useState<Tab>('raise')
  const [market, setMarket] = useState<Market>('RAISE6SEC')
  const [targetInterval, setTargetInterval] = useState<string>('')
  const [mw, setMw] = useState(powerMw * 0.5)
  const [price, setPrice] = useState(15)     // $/MW/h — typical FCAS clearing price range

  // Trapezium state (owned here, passed down to builder)
  const [trapezium, setTrapezium] = useState<VPPFcasTrapezium>({
    enablement_min_mw: 0,
    low_breakpoint_mw: powerMw * 0.2,
    high_breakpoint_mw: powerMw * 0.8,
    enablement_max_mw: powerMw,
    t1_sec: 0,
    t2_sec: 4,
    t3_sec: 60,
    t4_sec: 60,
  })

  const { t } = useT()

  // Remote data
  const [intervals, setIntervals] = useState<NextIntervals | null>(null)
  const [markets, setMarkets] = useState<MarketCatalog | null>(null)

  // Submission state
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<{ bid_id: number; status: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchPaperIntervals(12).then(setIntervals).catch(() => {})
    fetchPaperMarkets().then(setMarkets).catch(() => {})
  }, [])

  // Auto-select first interval when intervals load
  useEffect(() => {
    if (intervals && intervals.intervals.length > 0 && !targetInterval) {
      setTargetInterval(intervals.intervals[0].slice(0, 19).replace('T', ' '))
    }
  }, [intervals, targetInterval])

  // Switch market when tab changes
  function switchTab(t: Tab) {
    setTab(t)
    setMarket(t === 'raise' ? 'RAISE6SEC' : 'LOWER6SEC')
    setResult(null)
    setError(null)
  }

  // Determine sorted list of raise/lower markets from catalog (or fallback)
  const raiseMarkets = markets
    ? RAISE_ORDER.filter(m => markets.raise_fcas.includes(m))
    : RAISE_ORDER
  const lowerMarkets = markets
    ? LOWER_ORDER.filter(m => markets.lower_fcas.includes(m))
    : LOWER_ORDER
  const currentList = tab === 'raise' ? raiseMarkets : lowerMarkets

  async function handleSubmit() {
    if (!targetInterval) return
    setSubmitting(true)
    setError(null)
    setResult(null)
    try {
      const res = await submitPaperBid({
        duid,
        target_settlementdate: targetInterval,
        market,
        direction: directionFor(market),
        bands: [{ price, mw }],
        notes: `FCAS bid via panel — ${market}`,
        fcas_trapezium: trapezium,
      })
      setResult(res)
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ''))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div style={{ fontFamily: 'system-ui,sans-serif' }}>
      {/* Raise / Lower tab row */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 12, borderBottom: '1px solid #e5e7eb' }}>
        {(['raise', 'lower'] as Tab[]).map(tabKey => (
          <button
            key={tabKey}
            onClick={() => switchTab(tabKey)}
            style={{
              padding: '6px 20px',
              fontSize: 13,
              fontWeight: tab === tabKey ? 700 : 400,
              color: tab === tabKey ? '#3b82f6' : '#6b7280',
              borderBottom: tab === tabKey ? '2px solid #3b82f6' : '2px solid transparent',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              transition: 'color 0.15s',
            }}
          >
            {tabKey === 'raise' ? t('fcasBid.raiseTab') : t('fcasBid.lowerTab')}
          </button>
        ))}
      </div>

      {/* Market chip row */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
        {currentList.map(m => (
          <button
            key={m}
            onClick={() => { setMarket(m); setResult(null); setError(null) }}
            style={{
              padding: '3px 10px',
              fontSize: 12,
              borderRadius: 20,
              cursor: 'pointer',
              fontWeight: market === m ? 700 : 400,
              background: market === m ? '#3b82f6' : '#f3f4f6',
              color: market === m ? '#fff' : '#374151',
              border: `1px solid ${market === m ? '#2563eb' : '#e5e7eb'}`,
              transition: 'all 0.15s',
            }}
          >
            {t(MARKET_KEY_PREFIX + m)}
          </button>
        ))}
      </div>

      {/* Bid parameters row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 14 }}>
        {/* Target interval */}
        <div>
          <label style={{ fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 3 }}>
            {t('fcasBid.intervalLabel')}
          </label>
          <select
            value={targetInterval}
            onChange={e => setTargetInterval(e.target.value)}
            style={{
              width: '100%', padding: '5px 8px', borderRadius: 6,
              border: '1px solid #d1d5db', fontSize: 12,
            }}
          >
            {intervals?.intervals.map(iv => {
              const nem = iv.slice(0, 19).replace('T', ' ')
              return (
                <option key={iv} value={nem}>
                  {fmtNem(nem)}
                </option>
              )
            }) ?? <option value="">{t('fcasBid.loading')}</option>}
          </select>
        </div>

        {/* MW offered */}
        <div>
          <label style={{ fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 3 }}>
            {t('fcasBid.mwLabel')}
          </label>
          <input
            type="number"
            value={mw}
            min={0.1}
            max={powerMw}
            step={0.5}
            onChange={e => setMw(Math.min(powerMw, Math.max(0.1, Number(e.target.value))))}
            style={{
              width: '100%', padding: '5px 8px', borderRadius: 6,
              border: '1px solid #d1d5db', fontSize: 12, boxSizing: 'border-box',
            }}
          />
        </div>

        {/* Price */}
        <div>
          <label style={{ fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 3 }}>
            {t('fcasBid.priceLabel')}
          </label>
          <input
            type="number"
            value={price}
            min={0}
            max={15000}
            step={1}
            onChange={e => setPrice(Number(e.target.value))}
            style={{
              width: '100%', padding: '5px 8px', borderRadius: 6,
              border: '1px solid #d1d5db', fontSize: 12, boxSizing: 'border-box',
            }}
          />
        </div>
      </div>

      {/* Bid summary pill */}
      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: 8, padding: '4px 12px',
        background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 20,
        fontSize: 12, color: '#1e40af', marginBottom: 14,
      }}>
        <span style={{ fontWeight: 700 }}>{t(MARKET_KEY_PREFIX + market)}</span>
        <span>·</span>
        <span>{directionFor(market) === 'GEN' ? '↑ RAISE' : '↓ LOWER'}</span>
        <span>·</span>
        <span>{mw.toFixed(1)} MW @ ${price}/MW/h</span>
        {targetInterval && (
          <>
            <span>·</span>
            <span>{fmtNem(targetInterval)}</span>
          </>
        )}
      </div>

      {/* Trapezium builder */}
      <div style={{
        background: '#f9fafb', border: '1px solid #e5e7eb',
        borderRadius: 10, padding: '14px 16px', marginBottom: 14,
      }}>
        <p style={{ fontSize: 12, fontWeight: 700, color: '#374151', margin: '0 0 10px' }}>
          {t('fcasBid.trapSection')}
          <span style={{ fontSize: 11, fontWeight: 400, color: '#6b7280', marginLeft: 6 }}>
            {t('fcasBid.trapHint', t(MARKET_KEY_PREFIX + market))}
          </span>
        </p>
        <FCASTrapeziuBuilder
          market={market}
          powerMw={powerMw}
          initial={trapezium}
          onChange={setTrapezium}
        />
      </div>

      {/* Submit */}
      <button
        onClick={handleSubmit}
        disabled={submitting || !targetInterval}
        style={{
          width: '100%',
          padding: '9px 0',
          borderRadius: 8,
          fontSize: 13,
          fontWeight: 700,
          cursor: submitting || !targetInterval ? 'not-allowed' : 'pointer',
          background: submitting ? '#93c5fd' : '#3b82f6',
          color: '#fff',
          border: 'none',
          transition: 'background 0.15s',
        }}
      >
        {submitting ? t('fcasBid.submitting') : t('fcasBid.submit', t(MARKET_KEY_PREFIX + market))}
      </button>

      {/* Result */}
      {result && (
        <div style={{
          marginTop: 10,
          background: '#f0fdf4', border: '1px solid #bbf7d0',
          borderRadius: 8, padding: '10px 14px',
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#166534' }}>
            {t('fcasBid.ok', result.bid_id)}
          </div>
          <div style={{ fontSize: 11, color: '#16a34a', marginTop: 3 }}>
            {t('fcasBid.okDetail', t(MARKET_KEY_PREFIX + market), mw.toFixed(1), price, fmtNem(targetInterval))}
          </div>
          <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
            {t('fcasBid.okStatus', result.status, market)}
          </div>
        </div>
      )}

      {error && (
        <div style={{
          marginTop: 10,
          background: '#fef2f2', border: '1px solid #fca5a5',
          borderRadius: 8, padding: '8px 12px',
          fontSize: 12, color: '#dc2626',
        }}>
          ⚠ {error}
        </div>
      )}
    </div>
  )
}
