/**
 * CandlestickChart — OHLC candle chart for NEM dispatch prices.
 *
 * Built on Recharts ComposedChart with a Customized SVG layer for the candles
 * because Recharts has no built-in candlestick primitive. The Customized
 * component receives the chart's internal axis maps (d3 scales) so we can
 * convert prices → pixel coordinates ourselves.
 *
 * Color convention (standard financial):
 *   Green  (close ≥ open)  — price rose during the bucket
 *   Red    (close < open)  — price fell during the bucket
 */

import { useMemo, useCallback } from 'react'
import {
  ComposedChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Customized,
} from 'recharts'
import type { OHLCData, OHLCPoint } from '../types'
import { useT } from '../i18n'

// ── Colour tokens ──────────────────────────────────────────────────────────
const BULL   = '#34c759'  // Apple green — close ≥ open
const BEAR   = '#ff3b30'  // Apple red   — close < open
const GRID   = 'rgba(0,0,0,0.06)'
const ZERO   = '#ff9500'  // orange reference line at $0

// ── Custom candle SVG layer ────────────────────────────────────────────────

interface CandlesLayerProps {
  xAxisMap?: Record<string, { scale: ((v: string) => number) & { bandwidth?: () => number } }>
  yAxisMap?: Record<string, { scale: (v: number) => number }>
  data?: OHLCPoint[]
}

function CandlesLayer({ xAxisMap, yAxisMap, data }: CandlesLayerProps) {
  if (!xAxisMap || !yAxisMap || !data?.length) return null

  const xAxis = Object.values(xAxisMap)[0]
  const yAxis = Object.values(yAxisMap)[0]
  if (!xAxis?.scale || !yAxis?.scale) return null

  const xScale = xAxis.scale
  const yScale = yAxis.scale
  const bw     = xScale.bandwidth?.() ?? 8

  return (
    <g>
      {data.map((d) => {
        const cx  = (xScale(d.t) ?? 0) + bw / 2
        const yH  = yScale(d.high)
        const yL  = yScale(d.low)
        const yO  = yScale(d.open)
        const yC  = yScale(d.close)

        const bullish  = d.close >= d.open
        const fill     = bullish ? BULL : BEAR
        const bodyTop  = Math.min(yO, yC)
        const bodyBot  = Math.max(yO, yC)
        const bodyH    = Math.max(bodyBot - bodyTop, 1.5)
        const candleW  = Math.max(bw * 0.65, 3)

        return (
          <g key={d.t}>
            {/* Upper wick — from high to body top */}
            <line x1={cx} y1={yH} x2={cx} y2={bodyTop}
                  stroke={fill} strokeWidth={1.5} />
            {/* Lower wick — from body bottom to low */}
            <line x1={cx} y1={bodyBot} x2={cx} y2={yL}
                  stroke={fill} strokeWidth={1.5} />
            {/* Body rectangle */}
            <rect
              x={cx - candleW / 2} y={bodyTop}
              width={candleW} height={bodyH}
              fill={fill} stroke={fill}
              strokeWidth={0.5}
              fillOpacity={bullish ? 0.80 : 1}
            />
          </g>
        )
      })}
    </g>
  )
}

// ── Custom tooltip ─────────────────────────────────────────────────────────

function CandleTooltip({ active, payload, bucketMin }: {
  active?: boolean
  payload?: Array<{ payload: OHLCPoint }>
  bucketMin: number
}) {
  const { t } = useT()
  if (!active || !payload?.length) return null
  const d = payload[0].payload as OHLCPoint
  if (d?.open == null) return null

  const change  = d.close - d.open
  const pct     = d.open !== 0 ? (change / Math.abs(d.open)) * 100 : 0
  const bullish = change >= 0
  const color   = bullish ? BULL : BEAR
  const arrow   = bullish ? '▲' : '▼'

  // Parse NEM timestamp "2026-06-03T14:30" → readable label
  const label = d.t.replace('T', '  ').slice(0, 16)

  return (
    <div className="rounded-lg shadow-lg border border-hairlineSoft bg-surface px-3 py-2.5 text-[12px] min-w-[160px]">
      <div className="font-semibold text-ink mb-2">{label}</div>
      <div className="text-muted text-[10px] mb-2">{bucketMin} {t('kline.bucketMin')}</div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <span className="text-muted">{t('kline.open')}</span>
        <span className="tabular-nums text-ink text-right">${d.open.toFixed(2)}</span>
        <span className="text-muted">{t('kline.high')}</span>
        <span className="tabular-nums font-medium text-right" style={{ color: BULL }}>${d.high.toFixed(2)}</span>
        <span className="text-muted">{t('kline.low')}</span>
        <span className="tabular-nums font-medium text-right" style={{ color: BEAR }}>${d.low.toFixed(2)}</span>
        <span className="text-muted">{t('kline.close')}</span>
        <span className="tabular-nums text-ink text-right">${d.close.toFixed(2)}</span>
      </div>
      <div className="mt-2 pt-2 border-t border-hairlineSoft flex items-center justify-between">
        <span className="text-muted">{t('kline.change')}</span>
        <span className="tabular-nums font-semibold" style={{ color }}>
          {arrow} ${Math.abs(change).toFixed(2)} ({pct > 0 ? '+' : ''}{pct.toFixed(1)}%)
        </span>
      </div>
    </div>
  )
}

// ── X-axis tick formatter ──────────────────────────────────────────────────

function makeTickFormatter(_bucketMin: number, hours: number) {
  return (val: string) => {
    // val is "2026-06-03T14:00"
    const datePart = val.slice(0, 10)   // "2026-06-03"
    const timePart = val.slice(11, 16)  // "14:00"

    if (hours <= 24) {
      // Show time only, e.g. "14:00"
      return timePart
    }
    if (hours <= 72) {
      // Show "06-03 14:00" for 3-day view
      return `${datePart.slice(5)} ${timePart}`
    }
    // 7-day: show date only for midnight candles, else blank
    return timePart === '00:00' || timePart === '00:30'
      ? datePart.slice(5)
      : ''
  }
}

// ── Main component ─────────────────────────────────────────────────────────

export function CandlestickChart({
  data,
  loading,
}: {
  data: OHLCData | null
  loading?: boolean
}) {
  const { t } = useT()

  const series = data?.series ?? []
  const bucketMin = data?.bucket_minutes ?? 30
  const hours = data?.hours ?? 24

  // Y-axis domain: include 0, add 5% padding top/bottom
  const { yMin, yMax } = useMemo(() => {
    if (!series.length) return { yMin: 0, yMax: 100 }
    const allLow  = Math.min(...series.map(d => d.low))
    const allHigh = Math.max(...series.map(d => d.high))
    const pad = (allHigh - allLow) * 0.06
    return {
      yMin: Math.floor(Math.min(allLow  - pad, allLow  * 0.98)),
      yMax: Math.ceil( Math.max(allHigh + pad, allHigh * 1.02)),
    }
  }, [series])

  // Decide how many x ticks to show
  const xTickInterval = useMemo(() => {
    const n = series.length
    if (n <= 24)  return 0           // every candle
    if (n <= 48)  return 3           // every 4th
    if (n <= 96)  return 5           // every 6th
    return Math.floor(n / 14)        // ~14 ticks max
  }, [series.length])

  const tickFormatter = useCallback(
    makeTickFormatter(bucketMin, hours),
    [bucketMin, hours],
  )

  const tooltipContent = useCallback(
    (props: any) => <CandleTooltip {...props} bucketMin={bucketMin} />,
    [bucketMin],
  )

  if (loading) {
    return (
      <div className="h-80 flex items-center justify-center text-muted text-sm">
        {t('chart.loading')}
      </div>
    )
  }
  if (!series.length) {
    return (
      <div className="h-80 flex items-center justify-center text-muted text-sm">
        {t('kline.noData')}
      </div>
    )
  }

  return (
    <div>
      {/* Legend */}
      <div className="flex items-center gap-4 mb-3 text-[11px] text-muted">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-sm" style={{ background: BULL }} />
          {t('kline.close')} ≥ {t('kline.open')}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-sm" style={{ background: BEAR }} />
          {t('kline.close')} &lt; {t('kline.open')}
        </span>
        <span className="ml-auto">{bucketMin}-{t('kline.bucketMin')} · {series.length} candles</span>
      </div>

      <ResponsiveContainer width="100%" height={320}>
        <ComposedChart
          data={series}
          margin={{ top: 10, right: 16, bottom: 0, left: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />

          <XAxis
            dataKey="t"
            type="category"
            tickFormatter={tickFormatter}
            interval={xTickInterval}
            tick={{ fontSize: 11, fill: '#86868b' }}
            axisLine={false}
            tickLine={false}
          />

          <YAxis
            domain={[yMin, yMax]}
            tickFormatter={(v) => `$${v}`}
            tick={{ fontSize: 11, fill: '#86868b' }}
            axisLine={false}
            tickLine={false}
            width={54}
          />

          {/*
            * Invisible Bar — Recharts Tooltip only activates when a registered
            * data series detects a hover. The Customized layer draws pure SVG
            * but is invisible to the tooltip system. Adding a zero-opacity Bar
            * on "close" registers the data points so the cursor+tooltip fire
            * correctly. The Customized layer then draws the real candles on top.
            */}
          <Bar dataKey="close" fill="transparent" stroke="none"
               opacity={0} isAnimationActive={false} />

          <Tooltip
            content={tooltipContent}
            cursor={{ stroke: 'rgba(0,0,0,0.15)', strokeWidth: 1, strokeDasharray: '4 2' }}
          />

          {/* Reference line at $0 — visible when prices go negative */}
          {yMin < 0 && (
            <ReferenceLine y={0} stroke={ZERO} strokeWidth={1.5}
                           strokeDasharray="4 3" label={{ value: '$0', fill: ZERO, fontSize: 10, position: 'insideTopRight' }} />
          )}

          {/* Actual candles drawn as a custom SVG layer on top of the invisible bar */}
          <Customized component={CandlesLayer} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
