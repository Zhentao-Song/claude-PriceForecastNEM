import { Fragment, useEffect, useMemo, useState } from 'react'
import {
  CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { fetchFCASForecast, fetchHistory } from '../api'
import type { FCASForecast, FCASForecastProduct, History } from '../types'
import { useT } from '../i18n'

const GRID = '#d9e4f5'
const MUTED = '#6b7890'

const ORDER = [
  'raise1sec', 'raise6sec', 'raise60sec', 'raise5min', 'raisereg',
  'lower1sec', 'lower6sec', 'lower60sec', 'lower5min', 'lowerreg',
]

const WINDOW_OPTIONS = [
  { hours: 24, label: '1D' },
  { hours: 72, label: '3D' },
  { hours: 168, label: '7D' },
] as const

type ChartWindowHours = typeof WINDOW_OPTIONS[number]['hours']
type SeriesKind = 'actual' | 'forecast'

const LABEL: Record<string, string> = {
  raise1sec: 'R1', raise6sec: 'R6', raise60sec: 'R60', raise5min: 'R5', raisereg: 'RREG',
  lower1sec: 'L1', lower6sec: 'L6', lower60sec: 'L60', lower5min: 'L5', lowerreg: 'LREG',
}

const CHART_ORDER = [
  'raisereg', 'lowerreg', 'raise1sec', 'lower1sec', 'raise6sec',
  'lower6sec', 'raise60sec', 'lower60sec', 'raise5min', 'lower5min',
]

const CHART_LABEL: Record<string, string> = {
  raisereg: 'VFR',
  lowerreg: 'VFL',
  raise1sec: 'R1',
  lower1sec: 'L1',
  raise6sec: 'R6',
  lower6sec: 'L6',
  raise60sec: 'R60',
  lower60sec: 'L60',
  raise5min: 'R5',
  lower5min: 'L5',
}

const TOOLTIP_LABEL: Record<string, string> = {
  raisereg: 'VF RAISE',
  lowerreg: 'VF LOWER',
  raise1sec: '1SEC RAISE',
  lower1sec: '1SEC LOWER',
  raise6sec: 'FAST RAISE',
  lower6sec: 'FAST LOWER',
  raise60sec: 'SLOW RAISE',
  lower60sec: 'SLOW LOWER',
  raise5min: 'DELAYED RAISE',
  lower5min: 'DELAYED LOWER',
}

const REGION_LABEL: Record<string, string> = {
  NSW1: 'NSW', QLD1: 'QLD', VIC1: 'VIC', SA1: 'SA', TAS1: 'TAS',
}

const LINE_COLOR: Record<string, string> = {
  raisereg: '#00c853',
  lowerreg: '#0ea5e9',
  raise1sec: '#64748b',
  lower1sec: '#a855f7',
  raise6sec: '#43a047',
  lower6sec: '#1e88e5',
  raise60sec: '#7cb342',
  lower60sec: '#0284c7',
  raise5min: '#c8b900',
  lower5min: '#06b6d4',
}

function money(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  return `$${v.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`
}

function fmtTick(t: string | null | undefined): string {
  if (!t) return ''
  if (t.startsWith('#')) return t
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return String(t).slice(11, 16)
  return d.toLocaleTimeString('en-AU', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function fmtAxisTick(t: string | null | undefined, windowHours: ChartWindowHours): string {
  if (!t) return ''
  if (windowHours <= 24) return fmtTick(t)
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return String(t).slice(5, 10)
  return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short' })
}

function fmtTime(t: string | null | undefined): string {
  if (!t) return '—'
  if (t.startsWith('#')) return t
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return String(t).slice(11, 16)
  return d.toLocaleString('en-AU', {
    day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit',
  })
}

function productTone(p: FCASForecastProduct): string {
  const avg = p.avg_price ?? 0
  if (avg >= 20) return 'border-accent bg-accentSoft'
  if (avg >= 5) return 'border-hairline bg-white'
  return 'border-hairlineSoft bg-surfaceAlt/60'
}

function trendText(trend: string): string {
  if (trend === 'up') return 'up'
  if (trend === 'down') return 'down'
  return 'flat'
}

function baseMarket(seriesKey: string): string {
  return seriesKey.replace(/Actual$|Forecast$/, '')
}

function seriesKind(seriesKey: string): SeriesKind {
  return seriesKey.endsWith('Forecast') ? 'forecast' : 'actual'
}

function FCASChartTooltip({
  active,
  label,
  payload,
  actualLabel,
  forecastLabel,
}: {
  active?: boolean
  label?: string
  payload?: Array<{ color?: string; dataKey?: string | number; name?: string | number; value?: number | null }>
  actualLabel: string
  forecastLabel: string
}) {
  if (!active || !payload?.length) return null
  const rows = payload.filter((p) => typeof p.value === 'number' && !Number.isNaN(p.value))

  return (
    <div className="rounded-md border border-black/60 bg-black/90 px-2.5 py-2 text-[11px] text-white shadow-xl">
      <div className="mb-1 font-semibold tabular-nums">{fmtTime(label)}</div>
      <div className="space-y-0.5">
        {rows.map((p) => {
          const seriesKey = String(p.dataKey ?? p.name ?? '')
          const key = baseMarket(seriesKey)
          const kind = seriesKind(seriesKey)
          return (
            <div key={seriesKey} className="flex items-center gap-1.5 whitespace-nowrap">
              <span
                className="h-2.5 w-2.5 rounded-[2px] border border-white/70"
                style={{ backgroundColor: p.color ?? LINE_COLOR[key] }}
              />
              <span className="font-semibold">
                {TOOLTIP_LABEL[key] ?? p.name}
                <span className="font-normal text-white/70"> · {kind === 'forecast' ? forecastLabel : actualLabel}</span>
                : {money(p.value, 2)} AUD/MW
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function FCASForecastPanel({
  region,
  refreshKey,
}: {
  region: string
  refreshKey?: string | null
}) {
  const { t } = useT()
  const [windowHours, setWindowHours] = useState<ChartWindowHours>(24)
  const [powerMw, setPowerMw] = useState(10)
  const [availabilityPct, setAvailabilityPct] = useState(100)
  const [data, setData] = useState<FCASForecast | null>(null)
  const [history, setHistory] = useState<History | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (region === 'WEM') return
    let alive = true
    setLoading(true)
    Promise.all([
      fetchFCASForecast(region, windowHours, powerMw, availabilityPct),
      fetchHistory(region, windowHours),
    ])
      .then(([forecast, historyRows]) => {
        if (alive) {
          setData(forecast)
          setHistory(historyRows)
          setError(null)
        }
      })
      .catch((e) => { if (alive) setError(String(e)) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [region, windowHours, powerMw, availabilityPct, refreshKey])

  const topProducts = useMemo(() => data?.products ?? [], [data])
  const recommendation = data?.recommendation
  const bestProduct = topProducts.find((p) => p.market === recommendation?.market) ?? topProducts[0]
  const chartRows = useMemo(() => {
    const rows: Array<Record<string, number | string | null>> = []
    for (const point of history?.series ?? []) {
      const row: Record<string, number | string | null> = {
        t: point.t,
        source: 'DISPATCH',
        segment: 'actual',
      }
      for (const market of CHART_ORDER) {
        row[`${market}Actual`] = (point as any)[market] ?? null
        row[`${market}Forecast`] = null
      }
      rows.push(row)
    }
    for (const point of data?.intervals ?? []) {
      const row: Record<string, number | string | null> = {
        t: point.t ?? '',
        source: point.source,
        segment: 'forecast',
      }
      for (const market of CHART_ORDER) {
        row[`${market}Actual`] = null
        row[`${market}Forecast`] = (point.prices as any)[market] ?? null
      }
      rows.push(row)
    }
    return rows.filter((r) => r.t).sort((a, b) => String(a.t).localeCompare(String(b.t)))
  }, [data, history])
  const chartTickInterval = Math.max(0, Math.ceil(chartRows.length / 7) - 1)
  const forecastStart = data?.intervals.find((it) => it.t)?.t ?? null
  const actualCount = history?.series.length ?? 0

  if (region === 'WEM') return null

  return (
    <div className="rounded-xl border border-hairlineSoft bg-white p-4 shadow-sm">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="text-[13px] font-semibold tracking-tight text-ink">
            {t('fcasFc.title', region.replace(/1$/, ''))}
          </div>
          <div className="mt-1 text-[11px] text-muted">
            {t('fcasFc.hint')}
            {data?.run_datetime ? ` · ${t('fcasFc.issued')} ${fmtTime(data.run_datetime)}` : ''}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11px] text-muted">
            {t('fcasFc.power')}
            <input
              value={powerMw}
              onChange={(e) => setPowerMw(Math.max(0, Number(e.target.value) || 0))}
              type="number"
              min={0}
              className="h-7 w-16 rounded-md border border-hairlineSoft bg-white px-2 text-right text-[12px] text-ink outline-none focus:border-accent"
            />
            MW
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-muted">
            {t('fcasFc.availability')}
            <input
              value={availabilityPct}
              onChange={(e) => setAvailabilityPct(Math.min(100, Math.max(0, Number(e.target.value) || 0)))}
              type="number"
              min={0}
              max={100}
              className="h-7 w-14 rounded-md border border-hairlineSoft bg-white px-2 text-right text-[12px] text-ink outline-none focus:border-accent"
            />
            %
          </label>
        </div>
      </div>

      {loading && !data ? (
        <div className="py-8 text-center text-sm text-muted">{t('fcasFc.loading')}</div>
      ) : error ? (
        <div className="mt-4 rounded-lg border border-hairlineSoft bg-surfaceAlt p-3 text-[12px] text-muted">
          {t('fcasFc.error')} {error}
        </div>
      ) : !data || data.interval_count === 0 ? (
        <div className="mt-4 rounded-lg border border-hairlineSoft bg-surfaceAlt p-4 text-[12px] text-muted">
          {t('fcasFc.empty')}
        </div>
      ) : (
        <>
          <div className="mt-4 grid gap-3 lg:grid-cols-[1.05fr_1fr]">
            <div className="rounded-lg border border-accent/35 bg-accentSoft p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[11px] font-medium uppercase text-accentInk">{t('fcasFc.recommendation')}</div>
                  <div className="mt-1 text-[22px] font-semibold leading-none text-ink tabular-nums">
                    {recommendation?.code ?? '—'}
                  </div>
                  <div className="mt-2 text-[12px] leading-relaxed text-ink2">
                    {recommendation?.code ? t('fcasFc.recMsg', recommendation.code) : t('fcasFc.noRecommendation')}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[11px] text-accentInk">{t('fcasFc.windowRevenue')}</div>
                  <div className="mt-1 text-[20px] font-semibold text-ink tabular-nums">
                    {money(bestProduct?.revenue_aud, 2)}
                  </div>
                  <div className="mt-1 text-[11px] text-muted">
                    {data.interval_count} × {data.interval_minutes}min
                  </div>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <Metric label={t('fcasFc.avg')} value={money(bestProduct?.avg_price, 2)} />
              <Metric label={t('fcasFc.peak')} value={money(bestProduct?.peak_price, 2)} />
              <Metric label={t('fcasFc.source')} value={data.sources.join(' / ') || '—'} />
            </div>
          </div>

          <div className="mt-4 rounded-xl border border-[#d8e3f4] bg-[#f7fbff] p-5 shadow-[0_14px_36px_rgba(20,49,85,0.08)]">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="text-[18px] font-semibold tracking-tight text-[#162033]">
                  {t('fcasFc.curveTitle')}
                </div>
                <div className="mt-1 text-[11px] text-[#6b7890] tabular-nums">
                  {actualCount} {t('fcasFc.actual')} · {data.interval_count} {t('fcasFc.forecast')} · AUD/MW
                </div>
              </div>
              <div className="flex gap-1 rounded-lg border border-[#d8e3f4] bg-white/75 p-0.5 shadow-sm">
                {WINDOW_OPTIONS.map((option) => (
                  <button
                    key={option.hours}
                    onClick={() => setWindowHours(option.hours)}
                    className={`rounded-md px-3 py-1.5 text-[11px] font-semibold transition ${
                      windowHours === option.hours
                        ? 'bg-emerald-500 text-white shadow-sm'
                        : 'text-[#526078] hover:bg-[#edf4ff] hover:text-[#172033]'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-5 overflow-x-auto">
              <div className="h-[360px] min-w-[760px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartRows} margin={{ top: 8, right: 12, bottom: 22, left: 4 }}>
                    <CartesianGrid stroke={GRID} strokeOpacity={0.72} vertical={false} />
                    <XAxis
                      dataKey="t"
                      tickFormatter={(value) => fmtAxisTick(String(value), windowHours)}
                      interval={chartTickInterval}
                      stroke={MUTED}
                      tick={{ fontSize: 11, fill: MUTED }}
                      axisLine={{ stroke: GRID }}
                      tickLine={false}
                    />
                    <YAxis
                      stroke={MUTED}
                      tick={{ fontSize: 11, fill: MUTED }}
                      axisLine={false}
                      tickLine={false}
                      width={66}
                      tickFormatter={(v) => `$${v}`}
                      label={{
                        value: 'AUD/MW',
                        angle: -90,
                        position: 'insideLeft',
                        fill: MUTED,
                        fontSize: 11,
                      }}
                    />
                    <Tooltip
                      cursor={{ stroke: '#9fb1cc', strokeDasharray: '3 3' }}
                      content={(props: any) => (
                        <FCASChartTooltip
                          {...props}
                          actualLabel={t('fcasFc.actual')}
                          forecastLabel={t('fcasFc.forecast')}
                        />
                      )}
                    />
                    {forecastStart && (
                      <ReferenceLine
                        x={forecastStart}
                        stroke="#9fb1cc"
                        strokeDasharray="4 4"
                        label={{
                          value: t('fcasFc.forecast'),
                          position: 'top',
                          fill: MUTED,
                          fontSize: 11,
                        }}
                      />
                    )}
                    {CHART_ORDER.map((market) => {
                      const isRecommended = market === recommendation?.market
                      const width = isRecommended ? 3 : 2.2
                      return (
                        <Fragment key={market}>
                          <Line
                            type="monotone"
                            dataKey={`${market}Actual`}
                            name={CHART_LABEL[market]}
                            stroke={LINE_COLOR[market]}
                            strokeWidth={width}
                            strokeOpacity={isRecommended ? 1 : 0.92}
                            dot={false}
                            activeDot={{ r: 4, strokeWidth: 2, stroke: '#ffffff', fill: LINE_COLOR[market] }}
                            connectNulls
                            isAnimationActive={false}
                          />
                          <Line
                            type="monotone"
                            dataKey={`${market}Forecast`}
                            name={CHART_LABEL[market]}
                            stroke={LINE_COLOR[market]}
                            strokeWidth={width}
                            strokeOpacity={isRecommended ? 0.92 : 0.7}
                            strokeDasharray="7 5"
                            dot={false}
                            activeDot={{ r: 4, strokeWidth: 2, stroke: '#ffffff', fill: LINE_COLOR[market] }}
                            connectNulls
                            isAnimationActive={false}
                            legendType="none"
                          />
                        </Fragment>
                      )
                    })}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-[12px] text-[#53627a]">
              <span className="flex items-center gap-2">
                <span className="inline-block h-0.5 w-5 rounded-full bg-[#53627a]" />
                {t('fcasFc.actual')}
                <span className="ml-1 inline-block h-0.5 w-5 rounded-full border-t-2 border-dashed border-[#53627a]" />
                {t('fcasFc.forecast')}
              </span>
              {CHART_ORDER.map((market) => (
                <span key={market} className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-0.5 w-5 rounded-full"
                    style={{ backgroundColor: LINE_COLOR[market] }}
                  />
                  {CHART_LABEL[market]}
                </span>
              ))}
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-5">
            {topProducts.map((p) => (
              <div key={p.market} className={`rounded-lg border p-3 ${productTone(p)}`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[13px] font-semibold text-ink">{p.code}</div>
                  <div className="rounded-full bg-white/70 px-2 py-0.5 text-[10px] text-muted">
                    {trendText(p.trend)}
                  </div>
                </div>
                <div className="mt-1 min-h-[28px] text-[11px] leading-tight text-muted">{p.name}</div>
                <div className="mt-3 flex items-end justify-between gap-2">
                  <div>
                    <div className="text-[10px] text-muted">{t('fcasFc.avg')}</div>
                    <div className="text-[15px] font-semibold text-ink tabular-nums">{money(p.avg_price, 2)}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] text-muted">{t('fcasFc.rev')}</div>
                    <div className="text-[12px] font-medium text-ink2 tabular-nums">{money(p.revenue_aud, 2)}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
            <div className="overflow-x-auto rounded-lg border border-hairlineSoft">
              <table className="w-full text-[12px] tabular-nums">
                <thead>
                  <tr className="bg-surfaceAlt text-[10px] uppercase text-muted">
                    <th className="px-3 py-2 text-left font-medium">{t('fcas.region')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('fcasFc.best')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('fcasFc.avg')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('fcasFc.rev')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.regions.map((r) => (
                    <tr key={r.regionid} className="border-t border-hairlineSoft">
                      <td className="px-3 py-2 font-medium text-ink">{REGION_LABEL[r.regionid] ?? r.regionid}</td>
                      <td className="px-3 py-2 text-right text-ink2">{r.best_code ?? '—'}</td>
                      <td className="px-3 py-2 text-right text-ink2">{money(r.avg_best_price, 2)}</td>
                      <td className="px-3 py-2 text-right text-ink2">{money(r.revenue_aud, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="overflow-x-auto rounded-lg border border-hairlineSoft">
              <table className="w-full min-w-[720px] text-[12px] tabular-nums">
                <thead>
                  <tr className="bg-surfaceAlt text-[10px] uppercase text-muted">
                    <th className="px-3 py-2 text-left font-medium">{t('fcasFc.interval')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('fcasFc.best')}</th>
                    {ORDER.map((m) => (
                      <th key={m} className="px-2 py-2 text-right font-medium">{LABEL[m]}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.intervals.slice(0, 12).map((it, idx) => (
                    <tr key={it.t ?? idx} className="border-t border-hairlineSoft">
                      <td className="px-3 py-2 text-ink2">
                        <div>{fmtTime(it.t)}</div>
                        <div className="text-[10px] text-muted">{it.source}</div>
                      </td>
                      <td className="px-3 py-2 text-right font-medium text-ink">
                        {it.best_code ?? '—'} {money(it.best_price, 2)}
                      </td>
                      {ORDER.map((m) => {
                        const v = (it.prices as any)[m] as number | null | undefined
                        return <td key={m} className="px-2 py-2 text-right text-ink2">{money(v, 2)}</td>
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-hairlineSoft bg-surfaceAlt p-3">
      <div className="text-[10px] uppercase text-muted">{label}</div>
      <div className="mt-1 truncate text-[14px] font-semibold text-ink tabular-nums">{value}</div>
    </div>
  )
}
