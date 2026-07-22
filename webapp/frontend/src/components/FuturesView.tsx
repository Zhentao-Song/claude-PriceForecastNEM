import { useEffect, useMemo, useState } from 'react'
import {
  Bar, CartesianGrid, ComposedChart, Customized, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { fetchAsxFutures } from '../api'
import type { AsxFuturesContract, AsxFuturesResponse } from '../types'
import { useT } from '../i18n'

const REGION_ORDER = ['NSW', 'QLD', 'VIC', 'SA'] as const
const GRID = '#e8e8ed'
const MUTED = '#86868b'
const ACCENT = '#ff9500'
const BULL = '#34c759'
const BEAR = '#ff3b30'

type FuturesChartRow = {
  expiry: string
  label: string
  open: number | null
  high: number | null
  low: number | null
  settlement: number | null
}

type FuturesCandleLayerProps = {
  xAxisMap?: Record<string, { scale: ((v: string) => number) & { bandwidth?: () => number } }>
  yAxisMap?: Record<string, { scale: (v: number) => number }>
  data?: FuturesChartRow[]
}

const WORDS = {
  en: {
    delayed: 'Official EOD settlement', asOf: 'Trading date', source: 'ASX source',
    curve: 'Quarterly base-load forward curve', curveSub: 'Cash-settled against the regional reference price average',
    candleSub: 'Open, high, low and settlement for every listed contract quarter',
    viewCurve: 'Curve', viewCandles: 'Candles', quarters: 'quarters', through: 'through',
    candleUp: 'Settlement ≥ open', candleDown: 'Settlement < open', candleNoRange: 'Settlement only · no traded range',
    front: 'Front quarter', strip: 'Next 4Q weighted avg', peak: 'Highest quarter', liquidity: 'Curve open interest',
    hedge: 'Hedge lens', hedgeSub: 'Translate one futures position into physical exposure',
    position: 'Hedge volume', selected: 'Selected contract', hours: 'base-load hours',
    energy: 'Energy exposure', notional: 'Fixed-price notional', contract: 'contracts',
    note: 'Financial reference only. Final cash settlement is based on the arithmetic average of the region’s NEM spot price over the contract quarter.',
    ladder: 'Contract ladder', ladderSub: 'Click a quarter to inspect its hedge exposure',
    code: 'Contract', settle: 'Settlement', change: 'Daily change', volume: 'Volume', oi: 'Open interest',
    empty: 'No settlement', retry: 'Try again', loadError: 'ASX Energy data is temporarily unavailable.',
    mechanics: 'Market structure', cash: 'Cash-settled CFD', cashSub: 'No physical delivery requirement',
    unit: '1 MW base-load profile', unitSub: 'Every hour in the contract quarter',
    venue: 'ASX 24', venueSub: 'NSW · QLD · VIC · SA',
    curveUp: 'upward sloping', curveDown: 'downward sloping', curveFlat: 'broadly flat',
  },
  zh: {
    delayed: '官方日终结算价', asOf: '交易日期', source: 'ASX 数据源',
    curve: '季度基荷期货曲线', curveSub: '以对应区域参考电价的季度均值进行现金结算',
    candleSub: '展示全部季度合约的开盘、最高、最低与结算价',
    viewCurve: '曲线', viewCandles: '蜡烛图', quarters: '个季度', through: '最远',
    candleUp: '结算价 ≥ 开盘价', candleDown: '结算价 < 开盘价', candleNoRange: '仅结算价 · 当日无成交区间',
    front: '近月季度', strip: '未来 4 季度加权均价', peak: '最高价格季度', liquidity: '曲线未平仓量',
    hedge: '对冲视角', hedgeSub: '把一笔期货头寸换算成实际电量敞口',
    position: '对冲规模', selected: '已选合约', hours: '个基荷小时',
    energy: '覆盖电量', notional: '锁价名义金额', contract: '手',
    note: '仅作金融测算参考。最终现金结算以合约季度内该区域 NEM 现货电价的算术平均值为准。',
    ladder: '合约阶梯', ladderSub: '点击季度查看对应的对冲敞口',
    code: '合约', settle: '结算价', change: '日变动', volume: '成交量', oi: '未平仓量',
    empty: '暂无结算价', retry: '重试', loadError: 'ASX Energy 数据暂时不可用。',
    mechanics: '市场结构', cash: '现金结算 CFD', cashSub: '无需持有或交付实物电力',
    unit: '1 MW 基荷曲线', unitSub: '覆盖整个合约季度的每个小时',
    venue: 'ASX 24', venueSub: 'NSW · QLD · VIC · SA',
    curveUp: '远端升水', curveDown: '远端贴水', curveFlat: '整体平坦',
  },
}

const money = (value: number | null | undefined, digits = 2) =>
  value == null ? '—' : `$${value.toLocaleString('en-AU', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
const integer = (value: number | null | undefined) =>
  value == null ? '—' : value.toLocaleString('en-AU', { maximumFractionDigits: 0 })

function quarterLabel(expiry: string) {
  const [month, year] = expiry.split(' ')
  const q = month === 'Mar' ? 'Q1' : month === 'Jun' ? 'Q2' : month === 'Sep' ? 'Q3' : 'Q4'
  return `${q} '${year.slice(2)}`
}

function contractCode(code: string, expiry: string) {
  const [month, year] = expiry.split(' ')
  const monthCode = month === 'Mar' ? 'H' : month === 'Jun' ? 'M' : month === 'Sep' ? 'U' : 'Z'
  return `${code}${monthCode}${year.slice(-1)}`
}

function weightedAverage(contracts: AsxFuturesContract[]) {
  const eligible = contracts.slice(0, 4).filter((c) => c.settlement != null && c.contract_hours != null)
  const hours = eligible.reduce((sum, c) => sum + (c.contract_hours ?? 0), 0)
  if (!hours) return null
  return eligible.reduce((sum, c) => sum + (c.settlement ?? 0) * (c.contract_hours ?? 0), 0) / hours
}

function FuturesCandleLayer({ xAxisMap, yAxisMap, data }: FuturesCandleLayerProps) {
  if (!xAxisMap || !yAxisMap || !data?.length) return null
  const xAxis = Object.values(xAxisMap)[0]
  const yAxis = Object.values(yAxisMap)[0]
  if (!xAxis?.scale || !yAxis?.scale) return null
  const bandwidth = xAxis.scale.bandwidth?.() ?? 12
  const candleWidth = Math.max(5, Math.min(18, bandwidth * 0.56))

  return (
    <g>
      {data.map((row) => {
        if (row.settlement == null) return null
        const cx = (xAxis.scale(row.label) ?? 0) + bandwidth / 2
        const hasRange = row.open != null && row.high != null && row.low != null
        if (!hasRange) {
          const y = yAxis.scale(row.settlement)
          return (
            <g key={row.expiry}>
              <line x1={cx - candleWidth / 2} y1={y} x2={cx + candleWidth / 2} y2={y}
                stroke={ACCENT} strokeWidth={2} strokeLinecap="round" />
              <circle cx={cx} cy={y} r={3} fill="white" stroke={ACCENT} strokeWidth={1.5} />
            </g>
          )
        }
        const open = row.open as number
        const high = row.high as number
        const low = row.low as number
        const rising = row.settlement >= open
        const tone = rising ? BULL : BEAR
        const yOpen = yAxis.scale(open)
        const yClose = yAxis.scale(row.settlement)
        const bodyTop = Math.min(yOpen, yClose)
        const bodyHeight = Math.max(2, Math.abs(yClose - yOpen))
        return (
          <g key={row.expiry}>
            <line x1={cx} y1={yAxis.scale(high)} x2={cx} y2={yAxis.scale(low)}
              stroke={tone} strokeWidth={1.4} />
            <rect x={cx - candleWidth / 2} y={bodyTop} width={candleWidth} height={bodyHeight}
              rx={1} fill={rising ? 'white' : tone} stroke={tone} strokeWidth={1.4} />
          </g>
        )
      })}
    </g>
  )
}

export function FuturesView() {
  const { lang } = useT()
  const w = WORDS[lang]
  const [data, setData] = useState<AsxFuturesResponse | null>(null)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(true)
  const [selectedRegion, setSelectedRegion] = useState<(typeof REGION_ORDER)[number]>('NSW')
  const [selectedExpiry, setSelectedExpiry] = useState<string | null>(null)
  const [hedgeMw, setHedgeMw] = useState(10)
  const [chartMode, setChartMode] = useState<'curve' | 'candles'>('curve')
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let alive = true
    setLoading(true)
    fetchAsxFutures()
      .then((payload) => { if (alive) { setData(payload); setError(false) } })
      .catch(() => { if (alive) setError(true) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [reloadKey])

  const region = useMemo(
    () => data?.regions.find((item) => item.region === selectedRegion) ?? null,
    [data, selectedRegion],
  )
  // The ASX report already returns the full listed quarterly curve. Do not
  // truncate it: the far end is particularly important for long-dated hedges.
  const visibleContracts = region?.contracts ?? []
  const selectedContract = visibleContracts.find((c) => c.expiry === selectedExpiry) ?? visibleContracts[0] ?? null
  const chartRows = visibleContracts.map((c) => ({
    expiry: c.expiry,
    label: quarterLabel(c.expiry),
    open: c.open,
    high: c.high,
    low: c.low,
    settlement: c.settlement,
  }))
  const priced = visibleContracts.filter((c) => c.settlement != null)
  const peakContract = priced.reduce<AsxFuturesContract | null>(
    (best, c) => !best || (c.settlement ?? -Infinity) > (best.settlement ?? -Infinity) ? c : best,
    null,
  )
  const openInterest = visibleContracts.reduce((sum, c) => sum + (c.open_interest ?? 0), 0)
  const fourQuarter = weightedAverage(visibleContracts)
  const curveDelta = priced.length > 1
    ? (priced.at(-1)?.settlement ?? 0) - (priced[0]?.settlement ?? 0) : 0
  const curveShape = Math.abs(curveDelta) < 3 ? w.curveFlat : curveDelta > 0 ? w.curveUp : w.curveDown
  const energyMwh = (selectedContract?.contract_hours ?? 0) * hedgeMw
  const fixedNotional = energyMwh * (selectedContract?.settlement ?? 0)
  const farContract = visibleContracts.at(-1)

  if (loading) return <FuturesSkeleton />
  if (error || !data || !region) {
    return (
      <div className="rounded-xl2 bg-surface p-8 shadow-card text-center">
        <p className="text-sm text-ink2">{w.loadError}</p>
        <button onClick={() => setReloadKey((v) => v + 1)}
          className="mt-4 rounded-md bg-ink px-4 py-2 text-[12px] font-medium text-white hover:bg-ink2 focus:outline-none focus:ring-2 focus:ring-accent/40">
          {w.retry}
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <section className="flex flex-col gap-3 rounded-xl2 bg-surfaceAlt px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-ink text-[10px] font-bold tracking-[0.14em] text-white">ASX</div>
          <div>
            <div className="text-[13px] font-semibold text-ink">ASX Energy · Australian Electricity</div>
            <div className="mt-0.5 text-[11px] text-muted">{w.delayed} · {data.product}</div>
          </div>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-muted">
          <span>{w.asOf} <strong className="font-medium text-ink2">{new Date(`${data.trading_date}T12:00:00`).toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-AU', { day: '2-digit', month: 'short', year: 'numeric' })}</strong></span>
          <a href={data.source_url} target="_blank" rel="noreferrer"
            className="rounded-md border border-hairlineSoft bg-white px-2.5 py-1.5 font-medium text-ink2 transition hover:border-hairline hover:text-ink focus:outline-none focus:ring-2 focus:ring-accent/30">
            {w.source} ↗
          </a>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {REGION_ORDER.map((regionCode) => {
          const item = data.regions.find((r) => r.region === regionCode)
          const front = item?.contracts[0]
          const active = regionCode === selectedRegion
          return (
            <button key={regionCode} onClick={() => { setSelectedRegion(regionCode); setSelectedExpiry(null) }}
              className={`card-hover rounded-xl2 p-4 text-left focus:outline-none focus:ring-2 focus:ring-accent/30 ${active ? 'bg-white shadow-cardActive' : 'bg-surface shadow-card hover:shadow-cardHover'}`}>
              <div className="flex items-center justify-between">
                <span className={`text-[12px] font-semibold tracking-wide ${active ? 'text-accentInk' : 'text-ink2'}`}>{regionCode}</span>
                <span className="font-mono text-[10px] text-muted">{item?.commodity_code ?? '—'}</span>
              </div>
              <div className="mt-4 flex items-end justify-between gap-2">
                <div>
                  <div className="text-[23px] font-semibold tracking-tight text-ink tabular-nums">{money(front?.settlement)}</div>
                  <div className="mt-1 text-[10px] text-muted">{front ? quarterLabel(front.expiry) : w.empty} · /MWh</div>
                </div>
                <Change value={front?.change} />
              </div>
            </button>
          )
        })}
      </section>

      <section className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1.8fr)_minmax(300px,0.8fr)]">
        <div className="min-w-0 rounded-xl2 bg-surface p-5 shadow-card">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-accentInk">{selectedRegion} · {region.commodity_code}</div>
              <h2 className="mt-1 text-[17px] font-semibold tracking-tight text-ink">{w.curve}</h2>
              <p className="mt-1 text-[12px] text-muted">{chartMode === 'curve' ? w.curveSub : w.candleSub}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex gap-1 rounded-lg bg-surfaceAlt p-0.5" aria-label="Futures chart type">
                {(['curve', 'candles'] as const).map((mode) => (
                  <button key={mode} onClick={() => setChartMode(mode)}
                    className={`rounded-md px-2.5 py-1.5 text-[11px] font-medium transition focus:outline-none focus:ring-2 focus:ring-accent/30 ${chartMode === mode ? 'bg-white text-ink shadow-sm' : 'text-muted hover:text-ink'}`}>
                    {mode === 'curve' ? w.viewCurve : w.viewCandles}
                  </button>
                ))}
              </div>
              {chartMode === 'curve' && (
                <span className="w-fit rounded-full bg-surfaceAlt px-2.5 py-1 text-[10px] font-medium text-ink2">{curveShape}</span>
              )}
              <span className="w-fit rounded-full bg-accentSoft px-2.5 py-1 text-[10px] font-medium text-accentInk">
                {visibleContracts.length} {w.quarters} · {w.through} {farContract ? quarterLabel(farContract.expiry) : '—'}
              </span>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-hairlineSoft sm:grid-cols-4">
            <Metric label={w.front} value={money(visibleContracts[0]?.settlement)} sub={visibleContracts[0] ? quarterLabel(visibleContracts[0].expiry) : '—'} />
            <Metric label={w.strip} value={money(fourQuarter)} sub="4Q · MWh weighted" />
            <Metric label={w.peak} value={money(peakContract?.settlement)} sub={peakContract ? quarterLabel(peakContract.expiry) : '—'} />
            <Metric label={w.liquidity} value={integer(openInterest)} sub="contracts" />
          </div>

          {chartMode === 'candles' && (
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-muted">
              <LegendMark tone={BULL} hollow label={w.candleUp} />
              <LegendMark tone={BEAR} label={w.candleDown} />
              <LegendMark tone={ACCENT} dash label={w.candleNoRange} />
            </div>
          )}

          <div className={`${chartMode === 'candles' ? 'mt-2' : 'mt-5'} w-full max-w-full overflow-x-auto pb-1`}>
            <div className="h-[300px] min-w-[760px]">
              <ResponsiveContainer width="100%" height="100%">
                {chartMode === 'curve' ? (
                  <LineChart data={chartRows} margin={{ top: 12, right: 12, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke={GRID} vertical={false} />
                    <XAxis dataKey="label" axisLine={{ stroke: GRID }} tickLine={false}
                      tick={{ fill: MUTED, fontSize: 10 }} interval={0} minTickGap={8} />
                    <YAxis axisLine={false} tickLine={false} width={50}
                      tick={{ fill: MUTED, fontSize: 10 }} tickFormatter={(v) => `$${v}`} domain={['auto', 'auto']} />
                    <Tooltip cursor={{ stroke: GRID }} content={<CurveTooltip />} />
                    <Line type="monotone" dataKey="settlement" stroke={ACCENT} strokeWidth={2.5}
                      dot={{ r: 3.5, fill: '#fff', stroke: ACCENT, strokeWidth: 2 }}
                      activeDot={{ r: 5, fill: ACCENT, stroke: '#fff', strokeWidth: 2 }}
                      connectNulls isAnimationActive={false} />
                  </LineChart>
                ) : (
                  <ComposedChart data={chartRows} margin={{ top: 12, right: 12, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke={GRID} vertical={false} />
                    <XAxis dataKey="label" axisLine={{ stroke: GRID }} tickLine={false}
                      tick={{ fill: MUTED, fontSize: 10 }} interval={0} minTickGap={8} />
                    <YAxis axisLine={false} tickLine={false} width={50}
                      tick={{ fill: MUTED, fontSize: 10 }} tickFormatter={(v) => `$${v}`} domain={['auto', 'auto']} />
                    <Bar dataKey="settlement" fill="transparent" stroke="none" opacity={0} isAnimationActive={false} />
                    <Tooltip cursor={{ stroke: GRID }} content={<FuturesCandleTooltip />} />
                    <Customized component={FuturesCandleLayer} />
                  </ComposedChart>
                )}
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        <aside className="rounded-xl2 bg-ink p-5 text-white shadow-card">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/55">{w.hedge}</div>
          <h2 className="mt-1 text-[17px] font-semibold tracking-tight">{w.hedgeSub}</h2>

          <div className="mt-6 border-b border-white/10 pb-5">
            <div className="text-[11px] text-white/55">{w.position}</div>
            <div className="mt-2 flex items-center justify-between rounded-lg bg-white/[0.08] p-1">
              <button onClick={() => setHedgeMw((v) => Math.max(1, v - 1))} aria-label="Decrease hedge volume"
                className="h-8 w-8 rounded-md text-lg text-white/70 transition hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-accent/60">−</button>
              <div className="text-center"><span className="text-[21px] font-semibold tabular-nums">{hedgeMw}</span><span className="ml-1 text-[11px] text-white/55">MW</span></div>
              <button onClick={() => setHedgeMw((v) => Math.min(500, v + 1))} aria-label="Increase hedge volume"
                className="h-8 w-8 rounded-md text-lg text-white/70 transition hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-accent/60">+</button>
            </div>
          </div>

          <div className="space-y-4 py-5">
            <DarkMetric label={w.selected} value={selectedContract ? `${selectedRegion} · ${quarterLabel(selectedContract.expiry)}` : '—'} sub={selectedContract ? `${contractCode(region.commodity_code, selectedContract.expiry)} · ${money(selectedContract.settlement)}/MWh` : undefined} />
            <DarkMetric label={w.energy} value={`${integer(energyMwh)} MWh`} sub={selectedContract ? `${integer(selectedContract.contract_hours)} ${w.hours} × ${hedgeMw} MW` : undefined} />
            <DarkMetric label={w.notional} value={money(fixedNotional, 0)} sub={`${hedgeMw} ${w.contract}`} accent />
          </div>
          <p className="border-t border-white/10 pt-4 text-[10px] leading-relaxed text-white/45">{w.note}</p>
        </aside>
      </section>

      <section className="overflow-hidden rounded-xl2 bg-surface shadow-card">
        <div className="flex items-center justify-between border-b border-hairlineSoft px-5 py-4">
          <div><h2 className="text-[15px] font-semibold text-ink">{w.ladder}</h2><p className="mt-0.5 text-[11px] text-muted">{w.ladderSub}</p></div>
          <span className="font-mono text-[10px] text-muted">ASX 24 · {region.commodity_code}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[700px] border-collapse text-[12px]">
            <thead><tr className="border-b border-hairlineSoft text-left text-[10px] uppercase tracking-[0.1em] text-muted">
              <th className="px-5 py-3 font-medium">{w.code}</th><th className="px-3 py-3 text-right font-medium">{w.settle}</th>
              <th className="px-3 py-3 text-right font-medium">{w.change}</th><th className="px-3 py-3 text-right font-medium">{w.volume}</th>
              <th className="px-5 py-3 text-right font-medium">{w.oi}</th>
            </tr></thead>
            <tbody>{visibleContracts.map((c) => {
              const active = selectedContract?.expiry === c.expiry
              return <tr key={c.expiry} onClick={() => setSelectedExpiry(c.expiry)}
                className={`cursor-pointer border-b border-hairlineSoft/70 transition last:border-0 ${active ? 'bg-accentSoft/70' : 'hover:bg-surfaceAlt'}`}>
                <td className="px-5 py-3"><div className="font-medium text-ink">{quarterLabel(c.expiry)} <span className="ml-2 font-mono text-[10px] text-muted">{contractCode(region.commodity_code, c.expiry)}</span></div><div className="mt-0.5 text-[10px] text-muted">{c.expiry} · {integer(c.contract_hours)} MWh / MW</div></td>
                <td className="px-3 py-3 text-right font-medium tabular-nums text-ink">{money(c.settlement)}</td>
                <td className="px-3 py-3 text-right"><Change value={c.change} /></td>
                <td className="px-3 py-3 text-right tabular-nums text-ink2">{integer(c.volume)}</td>
                <td className="px-5 py-3 text-right tabular-nums text-ink2">{integer(c.open_interest)}</td>
              </tr>
            })}</tbody>
          </table>
        </div>
      </section>

      <section className="rounded-xl2 bg-surfaceAlt p-5">
        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">{w.mechanics}</div>
        <div className="mt-4 grid gap-5 sm:grid-cols-3">
          <Mechanic index="01" title={w.cash} detail={w.cashSub} />
          <Mechanic index="02" title={w.unit} detail={w.unitSub} />
          <Mechanic index="03" title={w.venue} detail={w.venueSub} />
        </div>
      </section>
    </div>
  )
}

function Change({ value }: { value: number | null | undefined }) {
  if (value == null) return <span className="text-[11px] text-muted">—</span>
  const positive = value > 0
  return <span className={`text-[11px] font-medium tabular-nums ${positive ? 'text-negative' : value < 0 ? 'text-positive' : 'text-muted'}`}>
    {positive ? '+' : ''}{value.toFixed(2)}
  </span>
}

function Metric({ label, value, sub }: { label: string; value: string; sub: string }) {
  return <div className="bg-surfaceAlt px-3 py-3"><div className="text-[9px] uppercase tracking-[0.09em] text-muted">{label}</div><div className="mt-1 text-[16px] font-semibold text-ink tabular-nums">{value}</div><div className="mt-0.5 text-[9px] text-muted">{sub}</div></div>
}

function DarkMetric({ label, value, sub, accent = false }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return <div><div className="text-[10px] text-white/45">{label}</div><div className={`mt-1 text-[20px] font-semibold tracking-tight tabular-nums ${accent ? 'text-[#ffb340]' : 'text-white'}`}>{value}</div>{sub && <div className="mt-1 text-[10px] text-white/45">{sub}</div>}</div>
}

function Mechanic({ index, title, detail }: { index: string; title: string; detail: string }) {
  return <div className="flex gap-3"><span className="font-mono text-[10px] text-accentInk">{index}</span><div><div className="text-[13px] font-medium text-ink">{title}</div><div className="mt-1 text-[11px] text-muted">{detail}</div></div></div>
}

function LegendMark({ tone, label, hollow = false, dash = false }: { tone: string; label: string; hollow?: boolean; dash?: boolean }) {
  return <span className="flex items-center gap-1.5"><span className={`${dash ? 'h-0.5 w-3 rounded-full' : 'h-2.5 w-2.5 rounded-[2px]'}`}
    style={{ background: hollow ? 'white' : tone, border: dash ? undefined : `1.5px solid ${tone}` }} />{label}</span>
}

function CurveTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: { expiry: string; settlement: number | null } }> }) {
  if (!active || !payload?.[0]) return null
  const row = payload[0].payload
  return <div className="rounded-lg border border-hairlineSoft bg-white px-3 py-2 shadow-card"><div className="text-[10px] text-muted">{row.expiry}</div><div className="mt-1 text-[13px] font-semibold text-ink tabular-nums">{money(row.settlement)}<span className="ml-1 text-[9px] font-normal text-muted">/MWh</span></div></div>
}

function FuturesCandleTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: FuturesChartRow }> }) {
  if (!active || !payload?.[0]) return null
  const row = payload[0].payload
  const hasRange = row.open != null && row.high != null && row.low != null
  return (
    <div className="min-w-[156px] rounded-lg border border-hairlineSoft bg-white px-3 py-2.5 shadow-card">
      <div className="text-[11px] font-semibold text-ink">{row.expiry}</div>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
        <span className="text-muted">Open</span><span className="text-right tabular-nums text-ink">{money(row.open)}</span>
        <span className="text-muted">High</span><span className="text-right tabular-nums text-ink">{money(row.high)}</span>
        <span className="text-muted">Low</span><span className="text-right tabular-nums text-ink">{money(row.low)}</span>
        <span className="font-medium text-ink2">Settlement</span><span className="text-right font-semibold tabular-nums text-ink">{money(row.settlement)}</span>
      </div>
      {!hasRange && <div className="mt-2 border-t border-hairlineSoft pt-2 text-[9px] text-muted">No traded OHLC range reported</div>}
    </div>
  )
}

function FuturesSkeleton() {
  return <div className="space-y-5 animate-pulse"><div className="h-16 rounded-xl2 bg-surfaceAlt" /><div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <div key={i} className="h-28 rounded-xl2 bg-surfaceAlt" />)}</div><div className="grid gap-5 lg:grid-cols-[1.8fr_0.8fr]"><div className="h-[470px] rounded-xl2 bg-surfaceAlt" /><div className="h-[470px] rounded-xl2 bg-[#f0f0f2]" /></div></div>
}
