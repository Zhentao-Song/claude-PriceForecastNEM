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

// ── Mean-relative divergent colour scale ─────────────────────────────────────
//  · value within ±5 % of row mean  →  white  (neutral / "average day")
//  · value above neutral zone       →  white → deep orange-red  (#c2410c)
//  · value below neutral zone       →  white → dark slate grey  (#334155)
//
// Above-mean uses log₁₀ scale (electricity prices span 3+ orders of magnitude;
// log keeps the gradient legible for a $200 day vs a $14,900 spike day).
// Below-mean uses a linear scale anchored at $0 (negative prices → full grey).

/** white → deep orange-red rgb(194, 65, 12) = #c2410c */
function aboveMeanCss(t: number): string {
  return `rgb(${Math.round(255 - t * 61)},${Math.round(255 - t * 190)},${Math.round(255 - t * 243)})`
}

/** white → dark slate rgb(51, 65, 85) = #334155 */
function belowMeanCss(t: number): string {
  return `rgb(${Math.round(255 - t * 204)},${Math.round(255 - t * 190)},${Math.round(255 - t * 170)})`
}

/** Per-cell colour.
 *  No data → empty hairline.
 *  Has data → divergent scale centred on the row mean (±5 % neutral band). */
function cellStyle(v: number | null, bounds: Bounds, mean: number | null): CSSProperties {
  if (v === null) return { background: '#f5f5f7' }

  // If mean is unavailable fall back to a simple mid-point reference.
  const m = (mean != null && mean > 0) ? mean : Math.sqrt(Math.max(bounds.lo, 1) * Math.max(bounds.hi, 1))
  const lo = m * 0.95
  const hi = m * 1.05

  // Neutral band → white
  if (v >= lo && v <= hi) return { background: '#ffffff' }

  if (v > hi) {
    // Log-scale distance above the neutral ceiling, relative to global max.
    const logAbove = Math.log10(Math.max(v, hi + 0.01)) - Math.log10(Math.max(hi, 1))
    const logMax   = Math.max(Math.log10(Math.max(bounds.hi, hi + 0.01)) - Math.log10(Math.max(hi, 1)), 0.001)
    return { background: aboveMeanCss(Math.min(1, logAbove / logMax)) }
  }

  // Below neutral: linear scale from lo down to $0 (negative prices → full grey).
  if (v <= 0) return { background: belowMeanCss(1) }
  const frac = Math.min(1, Math.max(0, (lo - v) / Math.max(lo, 0.01)))
  return { background: belowMeanCss(frac) }
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
                        ...cellStyle(v, bounds, mean),
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

/** Divergent legend: dark-slate → white → deep-orange, matching cellStyle. */
function DivergentLegend({ label, lang }: { label: string; lang: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-muted whitespace-nowrap">{label}</span>
      {/* Below-mean half: dark slate → white */}
      <div style={{
        width: 52, height: 8, borderRadius: '3px 0 0 3px',
        background: 'linear-gradient(to right, #334155, #ffffff)',
      }} />
      {/* Above-mean half: white → deep orange-red */}
      <div style={{
        width: 52, height: 8, borderRadius: '0 3px 3px 0',
        background: 'linear-gradient(to right, #ffffff, #c2410c)',
      }} />
      <span className="text-[10px] text-muted">
        {lang === 'zh' ? '白色 = 均值 ±5%' : 'white = avg ±5%'}
      </span>
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
      {/* Legend: divergent ramp per metric (mean-relative) + no-data swatch */}
      <div className="flex items-center gap-5 flex-wrap">
        <DivergentLegend label={t('heatmap.legend.energyRamp')} lang={lang} />
        <DivergentLegend label={t('heatmap.legend.fcasRamp')} lang={lang} />
        <div className="flex items-center gap-1 text-[11px] text-muted">
          <span className="inline-block rounded-[2px] border border-hairlineSoft" style={{ width: 12, height: 12, background: '#f5f5f7' }} />
          {t('heatmap.legend.nodata')}
        </div>
      </div>
      {tt && <CellTooltip tt={tt} t={t} lang={lang} />}
    </div>
  )
}
