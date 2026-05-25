import { useMemo, useState, type CSSProperties, type MouseEvent } from 'react'
import type { Heatmap, HeatmapRegion } from '../types'
import { useT } from '../i18n'

const REGION_LABEL: Record<string, string> = {
  NSW1: 'NSW', QLD1: 'QLD', VIC1: 'VIC', SA1: 'SA', TAS1: 'TAS',
}

type Metric = 'energy' | 'fcas'

type Bounds = { lo: number; hi: number }

type TooltipState = {
  x: number              // viewport-relative cursor X
  y: number
  day: string            // 'YYYY-MM-DD'
  region: string         // 'NSW' (already labelled)
  metric: Metric
  value: number | null
  mean: number | null
} | null

// Endpoints of the sequential colormap.
//   low end  → muted grey  (close to the canvas tone so cheap days fade out)
//   high end → saturated orange (the app accent colour, fully opaque)
const RAMP_LOW = [200, 200, 205] as const   // light grey
const RAMP_HIGH = [255, 149, 0] as const    // accent orange

/** Log-scale position of `v` within [lo, hi], clamped to [0,1].
 *  Electricity prices span 3+ orders of magnitude — a $14,900 APC day next to
 *  a $50 quiet day would crush the dynamic range under linear scaling, leaving
 *  almost every cell looking identical. log10 makes the gradient legible. */
function logRatio(v: number, lo: number, hi: number): number {
  if (hi <= lo) return 0.5
  const lv = Math.log10(Math.max(v, 1))
  const llo = Math.log10(Math.max(lo, 1))
  const lhi = Math.log10(Math.max(hi, 1))
  return Math.max(0, Math.min(1, (lv - llo) / (lhi - llo)))
}

/** Blend grey → orange and ramp opacity together so the brightest cells also
 *  feel more solid. Pure RGB lerp; no gamma correction (good enough at this
 *  cell size — the eye can't tell). */
function rampCss(t: number): string {
  const r = Math.round(RAMP_LOW[0] + (RAMP_HIGH[0] - RAMP_LOW[0]) * t)
  const g = Math.round(RAMP_LOW[1] + (RAMP_HIGH[1] - RAMP_LOW[1]) * t)
  const b = Math.round(RAMP_LOW[2] + (RAMP_HIGH[2] - RAMP_LOW[2]) * t)
  // Cheap days stay washed-out (alpha 0.25), expensive days reach full opacity.
  const alpha = 0.25 + t * 0.75
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(2)})`
}

/** Per-cell colour. No data = empty hairline. Otherwise: log-scaled position
 *  on the grey→orange ramp. Higher price = darker / more saturated. */
function cellStyle(v: number | null, bounds: Bounds): CSSProperties {
  if (v === null) return { background: '#f5f5f7' }
  const t = logRatio(v, bounds.lo, bounds.hi)
  return { background: rampCss(t) }
}

function fmtDay(s: string): string {
  // 'YYYY-MM-DD' → 'D MMM'
  const d = new Date(s + 'T00:00:00')
  if (Number.isNaN(d.getTime())) return s
  return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short' })
}

function fmtDayLong(s: string, lang: string): string {
  // 'YYYY-MM-DD' → 'Tue, 17 Mar 2026' (en) / '2026年3月17日 周二' (zh)
  const d = new Date(s + 'T00:00:00')
  if (Number.isNaN(d.getTime())) return s
  const locale = lang === 'zh' ? 'zh-CN' : 'en-AU'
  return d.toLocaleDateString(locale, {
    weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
  })
}

/** Compact dollar formatter for legend ticks: $48, $1.2k, $14k. */
function fmtPrice(v: number): string {
  if (v >= 1000) return `$${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`
  return `$${Math.round(v)}`
}

function meanFor(r: HeatmapRegion, metric: Metric): number | null {
  return metric === 'energy' ? r.rrp_mean : r.raisereg_mean
}

/** Global min/max across all regions/days for a metric. Used as bounds for
 *  the colour ramp so all five region rows share the same scale — that's
 *  what lets the user compare regions visually ("SA went orange the same
 *  day NSW did"). */
function globalBounds(data: Heatmap, metric: Metric): Bounds {
  let lo = Infinity
  let hi = -Infinity
  for (const r of data.regions) {
    for (const c of r.cells) {
      const v = metric === 'energy' ? c.rrp_max : c.raisereg_max
      if (v == null) continue
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { lo: 0, hi: 1 }
  return { lo, hi }
}

/** Render one grid (either energy or FCAS). Regions are rows, days are
 *  columns; we align all regions to the longest day list so columns line up. */
function Grid({
  data, metric, bounds, t, onCellEnter, onCellMove,
}: {
  data: Heatmap
  metric: Metric
  bounds: Bounds
  t: (k: string, ...args: (string | number)[]) => string
  onCellEnter: (e: MouseEvent, day: string, region: string, value: number | null, mean: number | null) => void
  onCellMove: (e: MouseEvent) => void
}) {
  // Day axis is the union of all regions' days, sorted ascending; this keeps
  // columns aligned even when one region's first day differs.
  const allDays = new Set<string>()
  data.regions.forEach((r) => r.cells.forEach((c) => allDays.add(c.day)))
  const days = Array.from(allDays).sort()
  // Build a quick lookup: regionid → (day → value).
  const lookup = new Map<string, Map<string, number | null>>()
  data.regions.forEach((r) => {
    const m = new Map<string, number | null>()
    r.cells.forEach((c) => m.set(c.day, metric === 'energy' ? c.rrp_max : c.raisereg_max))
    lookup.set(r.regionid, m)
  })

  return (
    <div className="overflow-x-auto">
      <table className="border-separate" style={{ borderSpacing: 2 }}>
        <tbody>
          {data.regions.map((r) => {
            const label = REGION_LABEL[r.regionid] ?? r.regionid
            const mean = meanFor(r, metric)
            return (
              <tr key={r.regionid}>
                <td className="pr-3 text-[11px] text-ink2 font-medium align-middle">
                  {label}
                </td>
                {days.map((day) => {
                  const v = lookup.get(r.regionid)?.get(day) ?? null
                  return (
                    <td
                      key={day}
                      className="rounded-[2px] cursor-pointer"
                      style={{
                        width: 10, height: 18, minWidth: 10,
                        ...cellStyle(v, bounds),
                      }}
                      onMouseEnter={(e) => onCellEnter(e, day, label, v, mean)}
                      onMouseMove={onCellMove}
                    />
                  )
                })}
                <td className="pl-2 text-[10px] text-muted tabular-nums whitespace-nowrap">
                  {t('heatmap.mean')} {mean?.toFixed(0) ?? '—'}
                </td>
              </tr>
            )
          })}
          {/* Day-axis labels: aim for ~8 labels regardless of total span,
              so 90-day and 14-day views both look clean. Each label cell
              keeps its 10px column slot, then `whitespace-nowrap` lets the
              text overflow to the right into adjacent empty label cells. */}
          <tr>
            <td />
            {(() => {
              const stride = Math.max(1, Math.floor(days.length / 8))
              return days.map((day, i) => (
                <td key={day} className="text-[9px] text-muted align-top pt-1 whitespace-nowrap"
                    style={{ width: 10 }}>
                  {i % stride === 0 ? fmtDay(day) : ''}
                </td>
              ))
            })()}
            <td />
          </tr>
        </tbody>
      </table>
    </div>
  )
}

/** Continuous gradient legend. CSS linear-gradient walks the same RGB lerp
 *  the cells use (just sampled at 11 stops to match the log perception),
 *  with min/max tick labels under each end. */
function RampLegend({ bounds, label }: { bounds: Bounds; label: string }) {
  // 11 stops at evenly spaced t = 0.0, 0.1, … 1.0 gives a smooth ramp even
  // though the underlying scale is log — the gradient is drawn in
  // ramp-position space, not value space.
  const stops = Array.from({ length: 11 }, (_, i) => rampCss(i / 10)).join(', ')
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-muted whitespace-nowrap">{label}</span>
      <span className="text-[10px] text-muted tabular-nums">{fmtPrice(bounds.lo)}</span>
      <span
        className="inline-block rounded-[2px]"
        style={{ width: 120, height: 10, background: `linear-gradient(to right, ${stops})` }}
      />
      <span className="text-[10px] text-muted tabular-nums">{fmtPrice(bounds.hi)}</span>
    </div>
  )
}

/** Floating tooltip rendered at viewport coordinates. Kept lightweight —
 *  no portal, just `position: fixed`. Flips to the left of cursor when it
 *  would otherwise overflow the right edge of the viewport. */
function CellTooltip({
  tt, t, lang,
}: {
  tt: NonNullable<TooltipState>
  t: (k: string, ...args: (string | number)[]) => string
  lang: string
}) {
  const PAD = 14         // offset from cursor so it doesn't sit under the pointer
  const W = 220          // approx max width; used only for edge flip math
  const flipLeft = typeof window !== 'undefined' && tt.x + PAD + W > window.innerWidth
  const left = flipLeft ? tt.x - PAD - W : tt.x + PAD
  const top = tt.y + PAD

  const metricLabel = tt.metric === 'energy'
    ? t('heatmap.tip.energyPeak')
    : t('heatmap.tip.fcasPeak')
  const unit = tt.metric === 'energy' ? '/MWh' : '/MW/h'
  const valueText = tt.value === null ? t('heatmap.tip.noData') : `$${tt.value.toFixed(2)} ${unit}`
  const delta = tt.value !== null && tt.mean !== null ? tt.value - tt.mean : null
  return (
    <div
      className="fixed pointer-events-none z-50"
      style={{
        left, top,
        width: W,
        background: '#ffffff',
        border: '1px solid #e8e8ed',
        borderRadius: 10,
        boxShadow: '0 4px 16px rgba(0,0,0,0.10)',
        padding: '8px 10px',
      }}
    >
      <div className="text-[11px] text-muted">{fmtDayLong(tt.day, lang)}</div>
      <div className="text-[12px] text-ink mt-0.5">
        <span className="font-medium">{tt.region}</span>
        <span className="text-muted"> · {metricLabel}</span>
      </div>
      <div className="text-[14px] text-ink tabular-nums font-semibold mt-1">
        {valueText}
      </div>
      {delta !== null && (
        <div className={`text-[11px] tabular-nums mt-0.5 ${delta >= 0 ? 'text-negative' : 'text-positive'}`}>
          {delta >= 0 ? '↑' : '↓'} ${Math.abs(delta).toFixed(0)} {t('heatmap.tip.vsMean')}
        </div>
      )}
    </div>
  )
}

export function HeatMap({ data }: { data: Heatmap | null }) {
  const { t, lang } = useT()
  const [tt, setTt] = useState<TooltipState>(null)
  // Compute global bounds once per data refresh — these drive both the cell
  // colours and the legend ticks for each metric.
  const energyBounds = useMemo(
    () => (data ? globalBounds(data, 'energy') : { lo: 0, hi: 1 }),
    [data],
  )
  const fcasBounds = useMemo(
    () => (data ? globalBounds(data, 'fcas') : { lo: 0, hi: 1 }),
    [data],
  )

  // Backend always pads to `days` cells per region — "no data" means none of
  // those cells has a value.
  const hasAny = !!data && data.regions.some((r) =>
    r.cells.some((c) => c.rrp_max !== null || c.raisereg_max !== null),
  )
  if (!data || !hasAny) {
    return <div className="text-muted text-sm">{t('heatmap.noData')}</div>
  }

  // Single shared tooltip — both grids feed the same state. Per-grid enter
  // handlers bind the metric in closure so the tooltip knows which axis the
  // cell belongs to. We clear on the outer wrapper's mouseleave (not per
  // cell) so dragging across adjacent cells doesn't flicker.
  const handleEnterFor = (metric: Metric) =>
    (e: MouseEvent, day: string, region: string, value: number | null, mean: number | null) => {
      setTt({ x: e.clientX, y: e.clientY, day, region, metric, value, mean })
    }
  const handleMove = (e: MouseEvent) => {
    setTt((prev) => (prev ? { ...prev, x: e.clientX, y: e.clientY } : prev))
  }

  return (
    <div className="space-y-6" onMouseLeave={() => setTt(null)}>
      {/* Energy peaks */}
      <div>
        <div className="text-[12px] text-ink2 font-medium mb-2">
          {t('heatmap.energy')}
        </div>
        <Grid data={data} metric="energy" bounds={energyBounds} t={t}
              onCellEnter={handleEnterFor('energy')} onCellMove={handleMove} />
      </div>
      {/* FCAS RaiseReg peaks */}
      <div>
        <div className="text-[12px] text-ink2 font-medium mb-2">
          {t('heatmap.fcas')}
        </div>
        <Grid data={data} metric="fcas" bounds={fcasBounds} t={t}
              onCellEnter={handleEnterFor('fcas')} onCellMove={handleMove} />
      </div>
      {/* Legend: one continuous ramp per metric, plus the no-data swatch. */}
      <div className="flex items-center gap-5 flex-wrap">
        <RampLegend bounds={energyBounds} label={t('heatmap.legend.energyRamp')} />
        <RampLegend bounds={fcasBounds} label={t('heatmap.legend.fcasRamp')} />
        <div className="flex items-center gap-1 text-[11px] text-muted">
          <span className="inline-block rounded-[2px] border border-hairlineSoft" style={{ width: 12, height: 12, background: '#f5f5f7' }} />
          {t('heatmap.legend.nodata')}
        </div>
      </div>
      {tt && <CellTooltip tt={tt} t={t} lang={lang} />}
    </div>
  )
}
