import { useEffect, useMemo, useRef, useState } from 'react'
import type { Fuel } from '../types'
import { useT } from '../i18n'

// Per-fuel "personality" knobs for the wave + bubble animation. Coal sits
// still (baseload); solar bursts on/off; wind ripples gustily; battery
// pulses unpredictably. These don't drive any real physics — they're
// chosen so each tank LOOKS like its source without needing extra data.
const FUEL_VIBE: Record<Fuel, { waveAmp: number; waveSpeed: number;
                                bubbleRate: number; bubbleSpeed: number }> = {
  coal_black:  { waveAmp: 0.6, waveSpeed: 0.25, bubbleRate: 0.02, bubbleSpeed: 0.4 },
  coal_brown:  { waveAmp: 0.6, waveSpeed: 0.25, bubbleRate: 0.02, bubbleSpeed: 0.4 },
  gas:         { waveAmp: 1.2, waveSpeed: 0.45, bubbleRate: 0.06, bubbleSpeed: 0.7 },
  hydro:       { waveAmp: 1.8, waveSpeed: 0.65, bubbleRate: 0.10, bubbleSpeed: 0.9 },
  bioenergy:   { waveAmp: 1.0, waveSpeed: 0.40, bubbleRate: 0.05, bubbleSpeed: 0.6 },
  wind:        { waveAmp: 3.2, waveSpeed: 0.90, bubbleRate: 0.14, bubbleSpeed: 1.1 },
  solar:       { waveAmp: 2.4, waveSpeed: 1.10, bubbleRate: 0.18, bubbleSpeed: 1.3 },
  battery:     { waveAmp: 4.5, waveSpeed: 1.30, bubbleRate: 0.22, bubbleSpeed: 1.6 },
}

type Props = {
  /** NEM region. Defaults to NSW1. */
  region?: string
  /** Lookback window in hours. */
  hours?: number
  /** Refresh cadence in ms. Default 60s — matches the NEM tick rate. */
  refreshMs?: number
}

type HistRow = { t: string } & Record<string, number | string>
type HistResponse = {
  region: string
  hours: number
  bucket_minutes: number
  fuels: Fuel[]
  fuel_colors: Record<string, string>
  series: HistRow[]
}

// Fuel order — heavy/baseload at the bottom of the stack, intermittent on
// top. Matches the existing FuelMixCard convention so the user gets a
// consistent reading order everywhere.
const STACK_ORDER: Fuel[] = [
  'coal_black', 'coal_brown', 'gas', 'hydro',
  'bioenergy', 'wind', 'solar', 'battery',
]

const FUEL_LABEL_KEY = (f: Fuel) => `fuel.${f}`

/**
 * Live, dynamic fuel-mix visualisation for one region.
 *
 * Two stacked layers:
 *   1. **Stacked area** of the last `hours` hours — shows how generation
 *      sources rose and fell against each other (此消彼长). New samples
 *      slide in from the right every refresh, with CSS transitions on the
 *      polygon paths so the band heights breathe rather than snap.
 *   2. **Live snapshot bar** above the area — single horizontal bar split
 *      by fuel, widths animated. Reads "right now" at a glance.
 *
 * Data: pulls /api/grid/generators/history every `refreshMs`, which joins
 * NEMWEB SCADA against the curated DUID→fuel registry server-side.
 */
export function FuelMixLive({ region = 'NSW1', hours = 6, refreshMs = 60000 }: Props) {
  const { t, lang } = useT()
  const [data, setData] = useState<HistResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setError(null)
      try {
        const r = await fetch(`/api/grid/generators/history?region=${region}&hours=${hours}`)
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const json: HistResponse = await r.json()
        if (!cancelled) setData(json)
      } catch (e) {
        if (!cancelled) setError(String((e as Error).message ?? e))
      }
    }
    load()
    const id = window.setInterval(load, refreshMs)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [region, hours, refreshMs])

  // Sort fuels by the stack order so the visual order is stable across
  // refreshes (otherwise React would reorder colours mid-animation if the
  // backend returned the fuel keys in a different sequence).
  const fuels = useMemo(() => {
    if (!data) return [] as Fuel[]
    const present = new Set(data.fuels)
    return STACK_ORDER.filter((f) => present.has(f))
  }, [data])

  // Latest snapshot (right edge of the time series) for the top bar.
  const latest = useMemo(() => {
    if (!data || data.series.length === 0) return null
    const row = data.series[data.series.length - 1]
    const mw: Record<Fuel, number> = {} as any
    let total = 0
    for (const f of fuels) {
      const v = Number(row[f]) || 0
      mw[f] = v
      total += v
    }
    return { ts: String(row.t), mw, total }
  }, [data, fuels])

  // Per-fuel rolling stats: current MW, recent max (used as the tank's
  // "full mark"), recent min (for the trend tick). Window-relative so
  // tanks don't all sit at 5% just because coal dwarfs everything else.
  const fuelStats = useMemo(() => {
    if (!data) return {} as Record<Fuel, { now: number; max: number; min: number; samples: number[] }>
    const out: any = {}
    for (const f of fuels) {
      const samples = data.series.map((r) => Number(r[f]) || 0)
      const last = samples[samples.length - 1] ?? 0
      const max = Math.max(1, ...samples)
      const min = Math.min(...samples)
      out[f] = { now: last, max, min, samples }
    }
    return out as Record<Fuel, { now: number; max: number; min: number; samples: number[] }>
  }, [data, fuels])

  if (error) {
    return (
      <div className="text-[12px] text-negative px-3 py-2">
        {t('fuelmix.err')} {error}
      </div>
    )
  }
  // While we don't yet have data, ALWAYS show "loading" — never the
  // "no data" message. The "no data" message is only correct when we
  // have a response from the server but it had zero rows. Showing it
  // during the initial mount/fetch race was misleading users into
  // thinking the backend was down when really the fetch was in-flight.
  if (!data) {
    return (
      <div className="h-[240px] flex items-center justify-center text-muted text-sm">
        {t('chart.loading')}
      </div>
    )
  }
  if (!latest) {
    return (
      <div className="h-[240px] flex items-center justify-center text-muted text-sm">
        {t('fuelmix.noData')}
      </div>
    )
  }

  const colors = data.fuel_colors
  const windowStart = data.series[0]?.t as string | undefined
  const windowEnd = data.series[data.series.length - 1]?.t as string | undefined

  return (
    <div className="space-y-3">
      {/* Header — totals + most recent timestamp */}
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-muted">
            {t('fuelmix.kicker', region.replace(/1$/, ''))}
          </div>
          <div className="text-[20px] font-semibold tracking-tight text-ink leading-tight tabular-nums">
            {(latest.total / 1000).toFixed(2)}{' '}
            <span className="text-[14px] text-muted font-normal">GW</span>
            <span className="text-[12px] text-muted font-normal ml-2">
              {t('fuelmix.now')}
            </span>
          </div>
        </div>
        <div className="text-[11px] text-muted tabular-nums">
          {fmtRange(windowStart, windowEnd, lang)}
        </div>
      </div>

      {/* Live snapshot bar — single 100% stacked bar showing right-now mix.
          Widths transition smoothly when values change. */}
      <div className="relative">
        <div className="h-7 w-full rounded-md overflow-hidden flex shadow-inner bg-surfaceAlt">
          {fuels.map((f) => {
            const w = (latest.mw[f] / latest.total) * 100
            if (w <= 0) return null
            const color = colors[f] ?? '#86868b'
            return (
              <div
                key={f}
                className="h-full relative group"
                style={{
                  width: `${w}%`,
                  background: color,
                  transition: 'width 900ms cubic-bezier(0.4,0,0.2,1)',
                }}
                title={`${t(FUEL_LABEL_KEY(f))} · ${latest.mw[f].toFixed(0)} MW · ${w.toFixed(1)}%`}
              >
                {w > 6 && (
                  <span className="absolute inset-0 flex items-center justify-center text-[10px] text-white/90 font-medium tabular-nums whitespace-nowrap pointer-events-none">
                    {t(FUEL_LABEL_KEY(f))} {w.toFixed(0)}%
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Liquid-tanks row — one tank per fuel. Each fills to its current
          MW relative to its OWN 6-hour max (window-relative), with a
          wavy surface + rising bubbles whose character matches the
          fuel's personality (coal calm, solar bursty, etc.). */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-3 pt-1">
        {fuels.map((f) => (
          <LiquidTank
            key={f}
            fuel={f}
            color={colors[f] ?? '#86868b'}
            label={t(FUEL_LABEL_KEY(f))}
            stats={fuelStats[f]}
          />
        ))}
      </div>

      {/* Per-fuel 6-hour trend strip — one tiny sparkline row per fuel
          showing the MW trajectory across the window. Complements the
          "now" tanks above with "how we got here". Fills the visual
          space below the tanks so the left column doesn't end short. */}
      <div className="pt-4 mt-3 border-t border-hairlineSoft">
        <div className="text-[10px] uppercase tracking-[0.22em] text-muted mb-2.5">
          {t('fuelmix.trends')}
        </div>
        <div className="space-y-1.5">
          {fuels.map((f) => (
            <FuelTrendRow
              key={f}
              color={colors[f] ?? '#86868b'}
              label={t(FUEL_LABEL_KEY(f))}
              stats={fuelStats[f]}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

// =========================================================================
// FuelTrendRow — one fuel's 6-hour sparkline + current value + delta
// =========================================================================

function FuelTrendRow({ color, label, stats }: {
  color: string
  label: string
  stats: { now: number; max: number; min: number; samples: number[] } | undefined
}) {
  if (!stats || stats.samples.length === 0) {
    return null
  }
  const { now, max, samples } = stats
  const first = samples[0] ?? 0
  const delta = now - first
  const deltaPct = first > 0 ? (delta / first) * 100 : null

  // Build sparkline path. Normalise to the fuel's window max so a flat
  // coal trace doesn't disappear vs a spiky wind trace.
  const W = 100, H = 20
  const N = samples.length
  const top = 2, bottom = H - 2
  const path = samples.map((v, i) => {
    const x = (i / (N - 1)) * W
    const y = bottom - (v / max) * (bottom - top)
    return `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
  }).join(' ')
  const areaPath = `${path} L ${W} ${bottom} L 0 ${bottom} Z`

  const fmtMW = (v: number) => v >= 1000 ? `${(v / 1000).toFixed(2)} GW` : `${v.toFixed(0)} MW`

  // Delta colour — for fuels you want UP (renewables/battery) green-up is
  // good; for fossils it's ambiguous. Keep neutral: just show direction.
  const deltaColor = delta > 0 ? '#ff9500' : delta < 0 ? '#34c759' : '#86868b'

  return (
    <div className="grid items-center gap-3 text-[11px]"
         style={{ gridTemplateColumns: '90px 1fr 70px 60px' }}>
      <div className="flex items-center gap-1.5 text-ink2 truncate">
        <span className="inline-block w-2 h-2 rounded-sm shrink-0"
              style={{ background: color }} />
        <span className="truncate">{label}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
           className="w-full h-5">
        <path d={areaPath} fill={color} fillOpacity={0.16} />
        <path d={path} fill="none" stroke={color}
              strokeWidth={1.2} strokeOpacity={0.85}
              strokeLinejoin="round" strokeLinecap="round"
              vectorEffect="non-scaling-stroke" />
        {/* Endpoint dot — emphasises "now" */}
        {samples.length > 1 && (() => {
          const lastY = bottom - (samples[samples.length - 1] / max) * (bottom - top)
          return <circle cx={W} cy={lastY} r={1.5}
                         fill={color} stroke="#fff" strokeWidth={0.6} />
        })()}
      </svg>
      <div className="text-right tabular-nums font-medium text-ink">
        {fmtMW(now)}
      </div>
      <div className="text-right tabular-nums" style={{ color: deltaColor }}>
        {delta === 0 ? '—'
         : `${delta > 0 ? '↑' : '↓'} ${deltaPct !== null
             ? `${Math.abs(deltaPct).toFixed(0)}%`
             : fmtMW(Math.abs(delta))}`}
      </div>
    </div>
  )
}

// =========================================================================
// LiquidTank — single fuel's animated "aquarium column"
// =========================================================================

function LiquidTank({ fuel, color, label, stats }: {
  fuel: Fuel
  color: string
  label: string
  stats: { now: number; max: number; min: number; samples: number[] } | undefined
}) {
  const vibe = FUEL_VIBE[fuel]
  // Tank viewbox — the MW number is rendered ABOVE the SVG in the parent
  // grid row, so the SVG itself can be a clean tank shape without internal
  // text padding. Slight top inset gives the wave a tiny bit of headroom
  // so it never clips at peak.
  const W = 100, H = 140
  const padX = 6, padTop = 6, padBottom = 6
  const innerW = W - padX * 2
  const innerH = H - padTop - padBottom

  // Fill level: current MW as % of THIS fuel's recent max (so coal doesn't
  // always look "full" and solar doesn't always look "empty"). Floor at 4%
  // so even zero output shows a sliver of liquid (otherwise the tank looks
  // broken).
  const now = stats?.now ?? 0
  const max = stats?.max ?? 1
  const targetPct = Math.max(0.04, Math.min(1, now / max))

  // Animated fill — interpolate towards targetPct on every render via a
  // local ref, so when new data comes in the liquid "sloshes" up/down
  // rather than snapping.
  const [pct, setPct] = useState(targetPct)
  useEffect(() => {
    let raf = 0
    const tick = () => {
      setPct((p) => {
        const delta = targetPct - p
        if (Math.abs(delta) < 0.001) return targetPct
        return p + delta * 0.08   // ease towards target ~12 frames
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [targetPct])

  // Wave + bubble physics — recompute path each animation frame using a
  // monotonic time. The wave is just sin() with per-fuel amplitude/speed.
  const surfaceY = padTop + innerH * (1 - pct)
  const [tNow, setTNow] = useState(0)
  useEffect(() => {
    let raf = 0
    const start = performance.now()
    const loop = () => {
      setTNow((performance.now() - start) / 1000)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  // Wave path: smooth sine across the surface, with a secondary higher-
  // frequency ripple summed in. Returns a polyline path string.
  const wavePath = useMemo(() => {
    const points: [number, number][] = []
    const steps = 18
    for (let i = 0; i <= steps; i++) {
      const x = padX + (i / steps) * innerW
      const xN = i / steps
      const y = surfaceY
        + Math.sin(xN * Math.PI * 2.2 + tNow * vibe.waveSpeed * 2.5) * vibe.waveAmp
        + Math.sin(xN * Math.PI * 5.1 + tNow * vibe.waveSpeed * 3.7) * vibe.waveAmp * 0.4
      points.push([x, y])
    }
    // Close path into liquid body
    const pts = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L ')
    return `M ${pts} L ${padX + innerW} ${padTop + innerH} L ${padX} ${padTop + innerH} Z`
  }, [tNow, surfaceY, vibe.waveAmp, vibe.waveSpeed, padX, innerW, innerH, padTop])

  // Bubble pool — store as ref to persist across renders, regenerate
  // periodically based on bubbleRate.
  const bubblesRef = useRef<{ x: number; y: number; r: number; v: number; life: number }[]>([])
  useEffect(() => {
    // Spawn opportunity each render call (proportional to vibe.bubbleRate)
    if (Math.random() < vibe.bubbleRate) {
      bubblesRef.current.push({
        x: padX + 3 + Math.random() * (innerW - 6),
        y: padTop + innerH - 2,
        r: 0.8 + Math.random() * 1.6,
        v: vibe.bubbleSpeed * (0.6 + Math.random() * 0.8),
        life: 0,
      })
    }
    // Cap memory
    if (bubblesRef.current.length > 30) bubblesRef.current.shift()
  }, [tNow, vibe.bubbleRate, vibe.bubbleSpeed, padX, innerW, padTop, innerH])

  const bubbles = bubblesRef.current
    .map((b) => {
      b.life += 1
      b.y -= b.v * 0.3
      b.x += Math.sin(b.life * 0.18) * 0.18
      return b
    })
    .filter((b) => b.y > surfaceY + 1)

  // Format the headline number — pick units that fit
  const fmtNow = now >= 1000
    ? `${(now / 1000).toFixed(2)} GW`
    : now >= 1 ? `${now.toFixed(0)} MW`
    : '—'

  // Light + dark shades of the fuel color for the gradient fill
  const lightCol = hexA(color, 0.55)
  const darkCol = hexA(color, 0.95)
  const gradId = `liquid-${fuel}`

  return (
    // Rigid 3-row grid: MW label · tank SVG · fuel label. Fixed row heights
    // mean every column lines up pixel-perfect at top AND bottom regardless
    // of label length / SVG aspect-ratio whitespace.
    <div className="grid items-center justify-items-center"
         style={{ gridTemplateRows: '18px 140px 22px' }}>
      <div className="text-[11px] font-semibold text-ink tabular-nums leading-none self-end">
        {fmtNow}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet"
           className="w-full h-full block"
           style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.06))' }}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={lightCol} />
            <stop offset="100%" stopColor={darkCol} />
          </linearGradient>
          {/* Inner highlight for glass look */}
          <linearGradient id={`glass-${fuel}`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="rgba(255,255,255,0.35)" />
            <stop offset="20%" stopColor="rgba(255,255,255,0)" />
          </linearGradient>
        </defs>

        {/* Tank back (subtle inner shadow) */}
        <rect x={padX} y={padTop} width={innerW} height={innerH} rx={6}
              fill="#f7f8fa" stroke="rgba(0,0,0,0.08)" strokeWidth={0.6} />

        {/* Liquid body — clipped to the tank interior so the wave never
            overflows the rounded corners. */}
        <clipPath id={`clip-${fuel}`}>
          <rect x={padX} y={padTop} width={innerW} height={innerH} rx={6} />
        </clipPath>
        <g clipPath={`url(#clip-${fuel})`}>
          <path d={wavePath} fill={`url(#${gradId})`} />
          {/* Wave highlight on top edge */}
          <path d={wavePath.split(' L ').slice(0, 19).join(' L ')}
                fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth={0.7}
                strokeLinecap="round" />
          {/* Bubbles */}
          {bubbles.map((b, i) => (
            <circle key={i} cx={b.x} cy={b.y} r={b.r}
                    fill="rgba(255,255,255,0.65)" />
          ))}
        </g>

        {/* Glass shine left edge */}
        <rect x={padX} y={padTop} width={innerW} height={innerH} rx={6}
              fill={`url(#glass-${fuel})`} pointerEvents="none" />
      </svg>
      <div className="flex items-center gap-1.5 text-[11px] text-ink2 leading-none">
        <span className="inline-block w-2 h-2 rounded-sm"
              style={{ background: color }} />
        {label}
      </div>
    </div>
  )
}

// ---- formatters ----------------------------------------------------------

function fmtRange(t0?: string, t1?: string, lang: 'en' | 'zh' = 'en') {
  if (!t0 || !t1) return ''
  const opts: Intl.DateTimeFormatOptions = {
    month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }
  const fmt = (s: string) => new Date(s).toLocaleString(
    lang === 'zh' ? 'zh-CN' : 'en-AU', opts)
  return `${fmt(t0)} → ${fmt(t1)}`
}

function hexA(hex: string, a: number): string {
  const m = hex.match(/^#([0-9a-f]{6})$/i)
  if (!m) return `rgba(134,134,139,${a})`
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
  return `rgba(${r},${g},${b},${a})`
}
