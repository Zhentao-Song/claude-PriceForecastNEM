import { useEffect, useMemo, useState } from 'react'
import {
  fetchPaperIntervals, submitPaperBid,
} from '../api'
import type { BidBand, Direction, Market } from '../types'
import { useT } from '../i18n'

const MPC = 23200

// 11 markets, presented in 3 logical groups so the user picks intent first
// (sell energy / buy energy / FCAS), not market keys. Labels are dictionary
// keys — they get resolved through `t(...)` at render time so the toggle is
// instant.
const MARKET_GROUPS: {
  key: string
  labelKey: string
  markets: { id: Market; labelKey: string; direction: Direction }[]
}[] = [
  {
    key: 'energy',
    labelKey: 'bid.group.energy',
    markets: [
      { id: 'ENERGY', labelKey: 'bid.opt.discharge', direction: 'GEN' },
      { id: 'ENERGY', labelKey: 'bid.opt.charge',    direction: 'LOAD' },
    ],
  },
  {
    key: 'raise',
    labelKey: 'bid.group.raise',
    markets: [
      { id: 'RAISEREG',   labelKey: 'bid.opt.raiseReg',   direction: 'GEN' },
      { id: 'RAISE5MIN',  labelKey: 'bid.opt.raise5min',  direction: 'GEN' },
      { id: 'RAISE60SEC', labelKey: 'bid.opt.raise60sec', direction: 'GEN' },
      { id: 'RAISE6SEC',  labelKey: 'bid.opt.raise6sec',  direction: 'GEN' },
      { id: 'RAISE1SEC',  labelKey: 'bid.opt.raise1sec',  direction: 'GEN' },
    ],
  },
  {
    key: 'lower',
    labelKey: 'bid.group.lower',
    markets: [
      { id: 'LOWERREG',   labelKey: 'bid.opt.lowerReg',   direction: 'LOAD' },
      { id: 'LOWER5MIN',  labelKey: 'bid.opt.lower5min',  direction: 'LOAD' },
      { id: 'LOWER60SEC', labelKey: 'bid.opt.lower60sec', direction: 'LOAD' },
      { id: 'LOWER6SEC',  labelKey: 'bid.opt.lower6sec',  direction: 'LOAD' },
      { id: 'LOWER1SEC',  labelKey: 'bid.opt.lower1sec',  direction: 'LOAD' },
    ],
  },
]

// Default 10-band template that mirrors AEMO's typical bid shape: a heavy
// floor band (must-run / SRMC), a few mid-priced bands, and a few high-priced
// bands as headroom. Two presets: "discharge" (sell high) and "charge"
// (buy low).
const TEMPLATE_DISCHARGE: BidBand[] = [
  { price: -1000, mw: 0 }, { price: 0,    mw: 0 }, { price: 30,  mw: 10 },
  { price: 60,    mw: 20 }, { price: 100, mw: 20 }, { price: 200, mw: 20 },
  { price: 500,   mw: 15 }, { price: 1000, mw: 10 }, { price: 5000, mw: 5 },
  { price: MPC, mw: 0 },
]
const TEMPLATE_CHARGE: BidBand[] = [
  { price: MPC, mw: 0 }, { price: 1000, mw: 0 }, { price: 200, mw: 5 },
  { price: 100,   mw: 10 }, { price: 60,  mw: 15 }, { price: 40, mw: 20 },
  { price: 20,    mw: 20 }, { price: 0,   mw: 15 }, { price: -100, mw: 10 },
  { price: -1000, mw: 0 },
]
const TEMPLATE_FCAS: BidBand[] = [
  { price: 0, mw: 10 }, { price: 5, mw: 0 }, { price: 10, mw: 0 },
  { price: 20, mw: 0 }, { price: 50, mw: 0 }, { price: 100, mw: 0 },
  { price: 200, mw: 0 }, { price: 500, mw: 0 }, { price: 1000, mw: 0 },
  { price: MPC, mw: 0 },
]

function templateFor(market: Market, direction: Direction): BidBand[] {
  if (market !== 'ENERGY') return TEMPLATE_FCAS
  return direction === 'GEN' ? TEMPLATE_DISCHARGE : TEMPLATE_CHARGE
}

type Props = {
  duid: string
  powerMw: number
  onSubmitted: () => void
  onClose: () => void
}

export function BidForm({ duid, powerMw, onSubmitted, onClose }: Props) {
  const { t } = useT()
  const [intervals, setIntervals] = useState<string[]>([])
  const [target, setTarget] = useState<string>('')
  const [marketKey, setMarketKey] = useState<string>('ENERGY:GEN')
  const [bands, setBands] = useState<BidBand[]>(TEMPLATE_DISCHARGE)
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    fetchPaperIntervals(8).then((d) => {
      setIntervals(d.intervals)
      if (d.intervals[0]) setTarget(d.intervals[0])
    }).catch((e) => setErr(String(e)))
  }, [])

  const [marketStr, dirStr] = marketKey.split(':')
  const market = marketStr as Market
  const direction = dirStr as Direction

  // When the market/direction changes, reset bands to the relevant template.
  useEffect(() => {
    setBands(templateFor(market, direction))
  }, [marketKey])

  const totalMw = useMemo(() => bands.reduce((a, b) => a + (b.mw || 0), 0), [bands])
  const overPower = totalMw > powerMw + 1e-6

  const updateBand = (i: number, patch: Partial<BidBand>) => {
    setBands((prev) => prev.map((b, idx) => (idx === i ? { ...b, ...patch } : b)))
  }

  const submit = async () => {
    setErr(null)
    if (!target) { setErr(t('bid.err.pickInterval')); return }
    if (overPower) { setErr(t('bid.err.exceedsPower', totalMw.toFixed(1), powerMw)); return }
    const nonZero = bands.filter((b) => b.mw > 0)
    if (nonZero.length === 0) { setErr(t('bid.err.atLeastOne')); return }
    setSubmitting(true)
    try {
      await submitPaperBid({
        duid, target_settlementdate: target, market, direction,
        bands: nonZero,
      })
      onSubmitted()
      onClose()
    } catch (e: any) {
      setErr(e.message || String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-xl2 shadow-cardHover w-full max-w-[640px] max-h-[90vh] overflow-y-auto"
      >
        <header className="px-6 py-4 border-b border-hairlineSoft flex items-baseline justify-between">
          <div>
            <div className="text-[15px] font-semibold text-ink">{t('bid.titleFor', duid)}</div>
            <div className="text-[11px] text-muted mt-0.5">{t('bid.subtitle')}</div>
          </div>
          <button onClick={onClose} className="text-muted hover:text-ink text-[20px] leading-none">×</button>
        </header>

        <div className="px-6 py-4 space-y-4">
          {/* Target interval */}
          <div>
            <label className="text-[11px] text-muted uppercase tracking-wide">{t('bid.target')}</label>
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="mt-1 w-full text-[13px] bg-surfaceAlt rounded-md px-3 py-2 outline-none focus:ring-2 focus:ring-accent/40"
            >
              {intervals.map((iv, i) => (
                <option key={iv} value={iv}>
                  {iv.slice(11, 16)} {i === 0 ? `· ${t('bid.next')}` : `· ${t('bid.intervalSuffix', i * 5)}`}
                </option>
              ))}
            </select>
          </div>

          {/* Market */}
          <div>
            <label className="text-[11px] text-muted uppercase tracking-wide">{t('bid.market')}</label>
            <select
              value={marketKey}
              onChange={(e) => setMarketKey(e.target.value)}
              className="mt-1 w-full text-[13px] bg-surfaceAlt rounded-md px-3 py-2 outline-none focus:ring-2 focus:ring-accent/40"
            >
              {MARKET_GROUPS.map((g) => (
                <optgroup key={g.key} label={t(g.labelKey)}>
                  {g.markets.map((m) => (
                    <option key={`${m.id}:${m.direction}`} value={`${m.id}:${m.direction}`}>{t(m.labelKey)}</option>
                  ))}
                </optgroup>
              ))}
            </select>
            <div className="text-[10px] text-muted mt-1">
              {market === 'ENERGY' && direction === 'GEN'  && t('bid.hint.gen')}
              {market === 'ENERGY' && direction === 'LOAD' && t('bid.hint.load')}
              {market !== 'ENERGY' && t('bid.hint.fcas')}
            </div>
          </div>

          {/* Bands table */}
          <div>
            <div className="flex items-baseline justify-between mb-1">
              <label className="text-[11px] text-muted uppercase tracking-wide">{t('bid.bands')}</label>
              <span className={`text-[11px] tabular-nums ${overPower ? 'text-negative' : 'text-muted'}`}>
                {t('bid.totalLabel', totalMw.toFixed(1), powerMw.toFixed(0))}
              </span>
            </div>
            <div className="rounded-md border border-hairlineSoft overflow-hidden">
              <div className="grid grid-cols-[28px_1fr_1fr] text-[10px] text-muted bg-surfaceAlt px-3 py-1.5 uppercase tracking-wide">
                <span>{t('bid.col.no')}</span>
                <span>{t('bid.col.price')}</span>
                <span className="text-right">{t('bid.col.mw')}</span>
              </div>
              {bands.map((b, i) => (
                <div key={i} className="grid grid-cols-[28px_1fr_1fr] items-center px-3 py-1.5 border-t border-hairlineSoft text-[12px] tabular-nums">
                  <span className="text-muted">{i + 1}</span>
                  <input
                    type="number"
                    value={b.price}
                    onChange={(e) => updateBand(i, { price: Number(e.target.value) })}
                    className="bg-transparent outline-none text-ink w-full"
                    step="any"
                  />
                  <input
                    type="number"
                    value={b.mw}
                    onChange={(e) => updateBand(i, { mw: Math.max(0, Number(e.target.value)) })}
                    className="bg-transparent outline-none text-ink w-full text-right"
                    step="any"
                    min={0}
                  />
                </div>
              ))}
            </div>
          </div>

          {err && (
            <div className="text-[12px] text-negative bg-red-50 rounded-md px-3 py-2">{err}</div>
          )}
        </div>

        <footer className="px-6 py-4 border-t border-hairlineSoft flex items-center justify-between gap-2">
          <button
            onClick={() => setBands(templateFor(market, direction))}
            className="text-[12px] text-muted hover:text-ink"
          >
            {t('bid.resetBands')}
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="text-[13px] px-4 py-2 rounded-md text-ink2 hover:bg-surfaceAlt">{t('bid.cancel')}</button>
            <button
              onClick={submit}
              disabled={submitting || overPower}
              className="text-[13px] px-4 py-2 rounded-md bg-accent text-white font-medium disabled:opacity-50"
            >
              {submitting ? t('bid.submitting') : t('bid.submit')}
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
