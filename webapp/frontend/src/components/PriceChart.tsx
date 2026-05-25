import { useMemo } from 'react'
import {
  Area, CartesianGrid, ComposedChart, Legend, Line, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import type { Constraints, ConstraintRow, Forecast, History } from '../types'
import { useT } from '../i18n'

type Props = {
  history: History | null
  loading: boolean
  forecast?: Forecast | null
  /** ISO timestamp of the latest cleared interval — drives the "now" line. */
  nowTs?: string | null
  /** Binding network/security constraints over the chart window. Drawn as
   *  small purple markers below the x-axis at each interval that had a
   *  binding constraint — hover for the constraint IDs + marginal values. */
  constraints?: Constraints | null
}

function fmtTick(t: string) {
  return new Date(t).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })
}

type Row = {
  t: string
  rrp: number | null
  demand: number | null
  forecast_rrp: number | null
  forecast_demand: number | null
  /** Sentinel y-value for the "binding constraint" series — sits just under
   *  the x-axis so the markers form a strip below the price line. */
  binding_marker: number | null
}

const CONSTRAINT_COLOR = '#8e3acc'   // purple — distinct from price (orange) & demand (blue)

/** Merge actuals + forecast onto one x-axis. Forecast spans the full window
 *  (past + short future tail) so the dashed line overlays the solid line
 *  throughout — that's how the user reads AEMO's prediction error. */
function buildRows(history: History, forecast: Forecast | null | undefined): Row[] {
  const map = new Map<string, Row>()
  for (const p of history.series) {
    map.set(p.t, {
      t: p.t,
      rrp: p.rrp,
      demand: p.demand ?? null,
      forecast_rrp: null,
      forecast_demand: null,
      binding_marker: null,
    })
  }
  if (forecast) {
    for (const p of forecast.series) {
      const existing = map.get(p.t)
      if (existing) {
        existing.forecast_rrp = p.rrp
        existing.forecast_demand = p.demand
      } else {
        map.set(p.t, {
          t: p.t,
          rrp: null,
          demand: null,
          forecast_rrp: p.rrp,
          forecast_demand: p.demand,
          binding_marker: null,
        })
      }
    }
  }
  return Array.from(map.values()).sort((a, b) => a.t.localeCompare(b.t))
}

/** Bucket constraints by settlement interval so the tooltip can show every
 *  constraint that was binding at the marker's timestamp. */
function indexConstraintsByInterval(
  constraints: Constraints | null | undefined,
): Map<string, ConstraintRow[]> {
  const m = new Map<string, ConstraintRow[]>()
  if (!constraints) return m
  for (const c of constraints.constraints) {
    if (!c.settlementdate) continue
    const arr = m.get(c.settlementdate) ?? []
    arr.push(c)
    m.set(c.settlementdate, arr)
  }
  return m
}

/** AEMO administered price cap. Static reference; we don't compute the
 *  rolling cumulative-price threshold that *triggers* the cap (yet) — but
 *  the line itself is informative because actual prices touching it
 *  signal a stress event. */
const APC_USD_PER_MWH = 600

const PRICE_COLOR = '#ff9500'
const DEMAND_COLOR = '#0a84ff'

export function PriceChart({ history, loading, forecast, nowTs, constraints }: Props) {
  const { t, lang } = useT()
  const constraintIndex = useMemo(
    () => indexConstraintsByInterval(constraints),
    [constraints],
  )

  if (loading && !history) {
    return <div className="h-80 flex items-center justify-center text-muted text-sm">{t('chart.loading')}</div>
  }
  if (!history || history.series.length === 0) {
    return (
      <div className="h-80 flex items-center justify-center text-muted text-sm">
        {t('chart.noData')}
      </div>
    )
  }
  const rows = buildRows(history, forecast)
  const hasForecast = !!forecast && forecast.series.length > 0
  const hasDemand = rows.some((r) => r.demand != null || r.forecast_demand != null)
  // Only render the APC line if its scale is within sight — otherwise it
  // crushes the y-axis when prices are flat at $80.
  const maxPrice = Math.max(
    ...rows.map((r) => Math.max(r.rrp ?? 0, r.forecast_rrp ?? 0)),
  )
  const showApc = maxPrice > 200    // arbitrary: only meaningful near stress

  // Stitch binding-constraint markers onto the row stream. We anchor the
  // marker just below the floor of the price axis so the chip sits in the
  // gutter between the chart and the x-axis ticks — no overlap with the
  // price line, but still pinned to the right timestamp.
  const minPrice = Math.min(
    0,
    ...rows.map((r) => Math.min(r.rrp ?? 0, r.forecast_rrp ?? 0)),
  )
  // Place markers ~5% of the price span below the chart floor.
  const priceSpan = Math.max(50, maxPrice - minPrice)
  const markerY = minPrice - priceSpan * 0.04
  let hasBinding = false
  for (const r of rows) {
    if (constraintIndex.has(r.t)) {
      r.binding_marker = markerY
      hasBinding = true
    }
  }
  return (
    <ResponsiveContainer width="100%" height={340}>
      <ComposedChart data={rows} margin={{ top: 10, right: 8, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="orangeFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={PRICE_COLOR} stopOpacity={0.18} />
            <stop offset="100%" stopColor={PRICE_COLOR} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="#e8e8ed" vertical={false} />
        <XAxis
          dataKey="t"
          tickFormatter={fmtTick}
          stroke="#86868b"
          tick={{ fontSize: 11, fill: '#86868b' }}
          tickLine={false}
          axisLine={{ stroke: '#e8e8ed' }}
        />
        {/* Left axis = price. */}
        <YAxis
          yAxisId="price"
          stroke="#86868b"
          tick={{ fontSize: 11, fill: PRICE_COLOR }}
          tickLine={false}
          axisLine={false}
          width={56}
          tickFormatter={(v) => `$${v}`}
        />
        {/* Right axis = demand. Hidden when nothing to plot, so we don't
            waste a band of whitespace on the FCAS/WEM sub-chart. */}
        {hasDemand && (
          <YAxis
            yAxisId="demand"
            orientation="right"
            stroke="#86868b"
            tick={{ fontSize: 11, fill: DEMAND_COLOR }}
            tickLine={false}
            axisLine={false}
            width={56}
            tickFormatter={(v) => `${(v / 1000).toFixed(1)}G`}
          />
        )}
        <Tooltip
          contentStyle={{
            background: '#ffffff',
            border: '1px solid #e8e8ed',
            borderRadius: 10,
            boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
            fontSize: 12,
            color: '#1d1d1f',
          }}
          labelStyle={{ color: '#86868b', marginBottom: 4 }}
          labelFormatter={(ts) => new Date(ts).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-AU')}
          formatter={(v: number, name: string, item: any) => {
            if (name === 'binding_marker') {
              // Pull the per-interval constraint list and render up to 3
              // ID/marginal-value lines inline so the user can read what was
              // binding without leaving the chart.
              const ts = item?.payload?.t as string | undefined
              const list = ts ? constraintIndex.get(ts) ?? [] : []
              if (list.length === 0) return ['—', t('chart.binding')]
              const top = list
                .slice()
                .sort((a, b) => Math.abs(b.marginalvalue ?? 0) - Math.abs(a.marginalvalue ?? 0))
                .slice(0, 3)
                .map((c) => `${c.constraintid} (${(c.marginalvalue ?? 0).toFixed(1)})`)
                .join(', ')
              const extra = list.length > 3 ? ` +${list.length - 3}` : ''
              return [`${top}${extra}`, t('chart.binding')]
            }
            if (v == null) return ['—', name]
            if (name === 'demand') return [`${v.toFixed(0)} MW`, t('chart.demand')]
            if (name === 'forecast_demand') return [`${v.toFixed(0)} MW`, t('chart.forecastDemand')]
            if (name === 'forecast_rrp') return [`$${v.toFixed(2)} /MWh`, t('chart.forecast')]
            return [`$${v.toFixed(2)} /MWh`, t('chart.rrp')]
          }}
        />
        <Legend
          wrapperStyle={{ fontSize: 11, paddingTop: 6 }}
          iconType="plainline"
          iconSize={14}
          formatter={(value: string) => {
            const key = value === 'forecast_rrp' ? 'chart.forecast'
              : value === 'demand' ? 'chart.demand'
              : value === 'forecast_demand' ? 'chart.forecastDemand'
              : value === 'binding_marker' ? 'chart.binding'
              : 'chart.rrp'
            return <span style={{ color: '#86868b' }}>{t(key)}</span>
          }}
        />
        {/* APC reference at $600 — dashed, gray, only when prices reach
            high enough that the line is on-screen. */}
        {showApc && (
          <ReferenceLine
            yAxisId="price"
            y={APC_USD_PER_MWH}
            stroke="#86868b"
            strokeDasharray="3 3"
            strokeWidth={1}
            label={{
              value: `APC $${APC_USD_PER_MWH}`,
              position: 'right',
              fill: '#86868b',
              fontSize: 10,
            }}
          />
        )}
        {/* "Now" vertical line, marking the actual → forecast transition. */}
        {nowTs && (
          <ReferenceLine
            yAxisId="price"
            x={nowTs}
            stroke="#86868b"
            strokeDasharray="2 4"
            strokeWidth={1}
            label={{
              value: t('chart.now'),
              position: 'top',
              fill: '#86868b',
              fontSize: 10,
            }}
          />
        )}
        {/* --- Demand (drawn behind price so the orange Area stays
            visually dominant) --- */}
        {hasDemand && (
          <Line
            yAxisId="demand"
            type="monotone"
            dataKey="demand"
            name="demand"
            stroke={DEMAND_COLOR}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
            connectNulls={false}
          />
        )}
        {hasForecast && hasDemand && (
          <Line
            yAxisId="demand"
            type="monotone"
            dataKey="forecast_demand"
            name="forecast_demand"
            stroke={DEMAND_COLOR}
            strokeWidth={1.25}
            strokeDasharray="5 4"
            dot={false}
            isAnimationActive={false}
            connectNulls={false}
          />
        )}
        {/* --- Price (foreground) --- */}
        <Area
          yAxisId="price"
          type="monotone"
          dataKey="rrp"
          name="rrp"
          stroke={PRICE_COLOR}
          strokeWidth={1.75}
          fill="url(#orangeFill)"
          isAnimationActive={false}
          connectNulls={false}
        />
        {hasForecast && (
          <Line
            yAxisId="price"
            type="monotone"
            dataKey="forecast_rrp"
            name="forecast_rrp"
            stroke={PRICE_COLOR}
            strokeWidth={1.5}
            strokeDasharray="5 4"
            dot={false}
            isAnimationActive={false}
            connectNulls={false}
          />
        )}
        {/* Binding-constraint markers: small purple diamonds in the gutter
            below the chart. The line itself is invisible (transparent stroke);
            only the dots render. Hovering surfaces the AEMO constraint IDs
            that were binding at that interval — the "why" behind a spike. */}
        {hasBinding && (
          <Line
            yAxisId="price"
            type="monotone"
            dataKey="binding_marker"
            name="binding_marker"
            stroke="transparent"
            isAnimationActive={false}
            connectNulls={false}
            dot={(props: any) => {
              const { cx, cy, payload, index } = props
              if (cx == null || cy == null || payload?.binding_marker == null) {
                // Recharts requires every dot renderer to return an SVG node;
                // an empty <g> is the cleanest no-op.
                return <g key={`bk-${index}`} />
              }
              const size = 5
              return (
                <polygon
                  key={`bm-${index}`}
                  points={`${cx},${cy - size} ${cx + size},${cy} ${cx},${cy + size} ${cx - size},${cy}`}
                  fill={CONSTRAINT_COLOR}
                  stroke="#ffffff"
                  strokeWidth={1}
                />
              )
            }}
            activeDot={{ r: 6, fill: CONSTRAINT_COLOR, stroke: '#ffffff', strokeWidth: 1.5 }}
          />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  )
}
