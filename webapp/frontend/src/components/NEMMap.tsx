import { useMemo, useState } from 'react'
import { ComposableMap, Geographies, Geography } from 'react-simple-maps'
import { geoMercator } from 'd3-geo'
import type { Fuel, GeneratorsSnapshot, GridSnapshot, Interconnector, RegionSnapshot, Station } from '../types'
import { useT } from '../i18n'

// ---- Geometry & projection ----------------------------------------------

// NEM region id ↔ geojson STATE_NAME (only the 5 NEM mainland/island states).
// WA, NT, ACT are dropped at render time.
const STATE_FOR_REGION: Record<string, string> = {
  NSW1: 'New South Wales',
  QLD1: 'Queensland',
  VIC1: 'Victoria',
  SA1: 'South Australia',
  TAS1: 'Tasmania',
}
const REGION_FOR_STATE: Record<string, string> = Object.fromEntries(
  Object.entries(STATE_FOR_REGION).map(([k, v]) => [v, k]),
)

// Where to anchor each state's wide-tracking title label. Sits inland on
// empty land away from generator clusters / coastline. Each entry is a
// (lon, lat) tuple — d3-mercator handles the projection.
const LABEL_ANCHOR: Record<string, [number, number]> = {
  QLD1: [144.5, -23.0],
  NSW1: [146.0, -32.0],
  VIC1: [144.0, -36.6],
  SA1:  [135.5, -31.0],
  TAS1: [146.6, -42.2],
}
// Two-line title for each state (mirrors NSW-BESS "NEW SOUTH WALES" treatment).
const STATE_TITLE: Record<string, [string, string]> = {
  QLD1: ['QUEEN', 'SLAND'],
  NSW1: ['NEW SOUTH', 'WALES'],
  VIC1: ['VICTO', 'RIA'],
  SA1:  ['SOUTH', 'AUSTRALIA'],
  TAS1: ['TAS', 'MANIA'],
}

// Portrait viewBox matched to the NEM bounding box (NEM is taller than wide
// once WA/NT are removed).
const VIEW_W = 600
const VIEW_H = 760

// d3-mercator centred at lat −28° fits the 5 NEM states without clipping
// Cape York or southern Tasmania.
const projection = geoMercator()
  .center([142, -28])
  .scale(1100)
  .translate([VIEW_W / 2, VIEW_H / 2])

// ---- Generator shape encoding (matches NSW-BESS map) --------------------
// Different fuels get distinct geometric shapes so the eye can scan
// "where are the batteries / where is solar" without decoding colour first.
type ShapeFn = (r: number) => string
function circlePath(r: number): string {
  return `M ${-r} 0 A ${r} ${r} 0 1 0 ${r} 0 A ${r} ${r} 0 1 0 ${-r} 0 Z`
}
function squarePath(r: number): string {
  const s = r * 0.92
  return `M ${-s} ${-s} L ${s} ${-s} L ${s} ${s} L ${-s} ${s} Z`
}
function diamondPath(r: number): string {
  const s = r * 1.12
  return `M 0 ${-s} L ${s} 0 L 0 ${s} L ${-s} 0 Z`
}
function triangleDown(r: number): string {
  const s = r * 1.18
  return `M ${-s} ${-s * 0.7} L ${s} ${-s * 0.7} L 0 ${s * 0.9} Z`
}
const FUEL_SHAPE: Record<Fuel, ShapeFn> = {
  coal_black:  circlePath,   // ● thermal
  coal_brown:  circlePath,
  gas:         circlePath,
  bioenergy:   circlePath,
  hydro:       triangleDown, // ▽ reservoir release
  wind:        circlePath,   // ● rotor
  solar:       diamondPath,  // ◆ panel tilt
  battery:     squarePath,   // ■ cell rack
}

// BESS state classification — drives pulse colour for live charge/discharge.
type BessClass = 'charging' | 'discharging' | 'idle' | 'unknown'
function classifyBess(mw: number | null | undefined, capacity: number): BessClass {
  if (mw === null || mw === undefined || Number.isNaN(mw)) return 'unknown'
  const threshold = Math.max(0.5, capacity * 0.02)
  if (mw > threshold) return 'discharging'
  if (mw < -threshold) return 'charging'
  return 'idle'
}
const BESS_STATE_COLOR: Record<BessClass, string> = {
  charging:    '#34c759',
  discharging: '#ff9500',
  idle:        '#86868b',
  unknown:     '#c7c7cc',
}

// ---- Visual scale helpers -----------------------------------------------

type Props = {
  grid: GridSnapshot | null
  generators: GeneratorsSnapshot | null
  nem: RegionSnapshot[]
  selected: string
  onSelect: (region: string) => void
  fuelFilter?: Set<string> | null
}

// Marker radius from station nameplate capacity. Hand-tuned at NEM scale so
// 100 MW ≈ 2.5 px, 700 MW ≈ 7 px, 3000 MW ≈ 14 px — large enough that the
// big stations dominate but small enough that 5 MW farms still register.
function radiusFromCapacity(mw: number): number {
  return Math.max(2.2, Math.sqrt(mw) * 0.26)
}

function fmtMW(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  return `${v >= 0 ? '+' : ''}${v.toFixed(0)} MW`
}

// Restrained colour ramp for IC utilisation. Hot reds reserved for ≥85%
// (the binding threshold) so colour spend matches operational severity.
function utilisationStyle(u: number | null): { color: string; width: number; opacity: number } {
  if (u === null || Number.isNaN(u)) return { color: '#c7c7cc', width: 1.5, opacity: 0.55 }
  if (u >= 0.85) return { color: '#ff3b30', width: 4.2, opacity: 0.95 }
  if (u >= 0.55) return { color: '#ff9500', width: 3.2, opacity: 0.9 }
  if (u >= 0.25) return { color: '#ffb340', width: 2.4, opacity: 0.85 }
  return                  { color: '#86868b', width: 1.4, opacity: 0.5 }
}

// State fill — white default, warm orange tint only when selected. We
// deliberately don't tint by price (price is already shown by label).
function regionFill(_rrp: number | null | undefined, selected: boolean): string {
  return selected ? '#ffe8c2' : '#ffffff'
}

// ---- Component ----------------------------------------------------------

export function NEMMap({ grid, generators, nem, selected, onSelect, fuelFilter }: Props) {
  const { t } = useT()
  const [hoverIC, setHoverIC] = useState<{ ic: Interconnector; x: number; y: number } | null>(null)
  const [hoverStation, setHoverStation] = useState<{ s: Station; x: number; y: number } | null>(null)

  // Map regionid → latest snapshot for tinting + labels.
  const nemMap = useMemo(() => {
    const m = new Map<string, RegionSnapshot>()
    nem.forEach((r) => m.set(r.regionid, r))
    return m
  }, [nem])

  // Projected station dots. Sort by capacity desc so big plants render below
  // small ones (small ones stay clickable on top).
  const stationDots = useMemo(() => {
    if (!generators) return []
    return generators.stations
      .filter((s) => !fuelFilter || fuelFilter.has(s.fuel))
      .map((s) => {
        const p = projection([s.lon, s.lat])
        if (!p) return null
        const r = radiusFromCapacity(s.capacity_mw)
        const cap = s.capacity_mw || 1
        const util = Math.max(0, Math.min(1.2, (s.mw || 0) / cap))
        return { s, x: p[0], y: p[1], r, util }
      })
      .filter(Boolean) as Array<{ s: Station; x: number; y: number; r: number; util: number }>
  }, [generators, fuelFilter])
  const stationDotsSorted = useMemo(
    () => [...stationDots].sort((a, b) => b.r - a.r),
    [stationDots],
  )

  // Fuel counts for the legend — only show legend rows for fuels that
  // actually have stations (so the legend matches what's on the map).
  const fuelCounts = useMemo(() => {
    const m = new Map<Fuel, number>()
    if (!generators) return m
    for (const s of generators.stations) {
      m.set(s.fuel, (m.get(s.fuel) ?? 0) + 1)
    }
    return m
  }, [generators])

  // Project IC lines as quadratic Bézier curves with alternating bow.
  const lines = useMemo(() => {
    if (!grid) return []
    return grid.interconnectors.map((ic, idx) => {
      const a = projection(ic.from)
      const b = projection(ic.to)
      if (!a || !b) return null
      const flow = ic.flow_mw ?? 0
      const reverse = flow < 0
      const start = reverse ? b : a
      const end = reverse ? a : b
      const stroke = utilisationStyle(ic.utilisation)
      const dx = end[0] - start[0]
      const dy = end[1] - start[1]
      const len = Math.hypot(dx, dy) || 1
      const ux = dx / len, uy = dy / len
      const nx = -uy, ny = ux
      const sign = idx % 2 === 0 ? 1 : -1
      const bow = Math.min(30, len * 0.10) * sign
      const cx = (start[0] + end[0]) / 2 + nx * bow
      const cy = (start[1] + end[1]) / 2 + ny * bow
      const path = `M ${start[0]} ${start[1]} Q ${cx} ${cy} ${end[0]} ${end[1]}`
      // Arrow at curve midpoint.
      const mx = 0.25 * start[0] + 0.5 * cx + 0.25 * end[0]
      const my = 0.25 * start[1] + 0.5 * cy + 0.25 * end[1]
      const tx = (cx - start[0]) + ((end[0] - cx) - (cx - start[0])) * 0.5
      const ty = (cy - start[1]) + ((end[1] - cy) - (cy - start[1])) * 0.5
      const tlen = Math.hypot(tx, ty) || 1
      const tux = tx / tlen, tuy = ty / tlen
      const tnx = -tuy, tny = tux
      const arrowSize = 5.5
      const tip = [mx + tux * arrowSize, my + tuy * arrowSize]
      const baseL = [mx - tux * arrowSize * 0.6 + tnx * arrowSize * 0.7, my - tuy * arrowSize * 0.6 + tny * arrowSize * 0.7]
      const baseR = [mx - tux * arrowSize * 0.6 - tnx * arrowSize * 0.7, my - tuy * arrowSize * 0.6 - tny * arrowSize * 0.7]
      return {
        ic, path, stroke,
        startX: start[0], startY: start[1],
        endX: end[0], endY: end[1],
        arrow: `${tip[0]},${tip[1]} ${baseL[0]},${baseL[1]} ${baseR[0]},${baseR[1]}`,
      }
    }).filter(Boolean) as Array<{
      ic: Interconnector
      path: string
      stroke: { color: string; width: number; opacity: number }
      startX: number; startY: number
      endX: number; endY: number
      arrow: string
    }>
  }, [grid])

  return (
    <div className="relative w-full mx-auto" style={{ maxWidth: 720 }}>
      <ComposableMap
        projection={projection as any}
        width={VIEW_W}
        height={VIEW_H}
        style={{ width: '100%', height: 'auto', display: 'block' }}
      >
        <defs>
          {/* Subtle drop shadow for state polygons — gives depth without weight. */}
          <filter id="nem-soft-shadow" x="-10%" y="-10%" width="120%" height="120%">
            <feGaussianBlur in="SourceAlpha" stdDeviation="1.2" />
            <feOffset dx="0" dy="1" result="offsetblur" />
            <feComponentTransfer><feFuncA type="linear" slope="0.18" /></feComponentTransfer>
            <feMerge>
              <feMergeNode />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          {/* Warm halo around selected state. */}
          <filter id="nem-selected-glow" x="-15%" y="-15%" width="130%" height="130%">
            <feGaussianBlur in="SourceAlpha" stdDeviation="3" result="blur" />
            <feFlood floodColor="#ff9500" floodOpacity="0.55" />
            <feComposite in2="blur" operator="in" result="glow" />
            <feMerge>
              <feMergeNode in="glow" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          {/* Major-station glow (≥500 MW). Same idea as NSW-BESS map: the
              big movers get a soft halo so they're scannable at a glance
              without needing to compare radii precisely. */}
          <filter id="nem-major-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="2.2" result="blur" />
            <feFlood floodColor="#ffffff" floodOpacity="0.85" />
            <feComposite in2="blur" operator="in" result="glow" />
            <feMerge>
              <feMergeNode in="glow" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          {/* BESS pulse halo — soft white expansion for active charge/discharge. */}
          <filter id="nem-pulse" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="1.5" />
          </filter>
          {/* Ocean gradient behind everything. */}
          <linearGradient id="nem-ocean" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f5f7fa" />
            <stop offset="100%" stopColor="#eef2f7" />
          </linearGradient>
        </defs>

        <rect x={0} y={0} width={VIEW_W} height={VIEW_H} fill="url(#nem-ocean)" />

        {/* States — only 5 NEM regions render; selected gets orange glow. */}
        <Geographies geography="/aus-states.geojson">
          {({ geographies }) =>
            geographies.map((geo) => {
              const name = geo.properties.STATE_NAME as string
              const region = REGION_FOR_STATE[name]
              if (!region) return null
              const isSelected = region === selected
              const rrp = nemMap.get(region)?.rrp
              const fill = regionFill(rrp, isSelected)
              const stroke = isSelected ? '#ff9500' : '#5e5e63'
              const strokeW = isSelected ? 2.4 : 1.1
              return (
                <g key={geo.rsmKey}
                   filter={isSelected ? 'url(#nem-selected-glow)' : 'url(#nem-soft-shadow)'}>
                  <Geography
                    geography={geo}
                    onClick={() => onSelect(region)}
                    style={{
                      default: { fill, stroke, strokeWidth: strokeW,
                        strokeLinejoin: 'round', outline: 'none',
                        cursor: 'pointer', transition: 'fill 220ms ease, stroke 220ms ease' },
                      hover:   { fill: isSelected ? '#ffe8c2' : '#f7f7f9',
                        stroke, strokeWidth: strokeW,
                        strokeLinejoin: 'round', outline: 'none' },
                      pressed: { fill, stroke, strokeWidth: strokeW,
                        strokeLinejoin: 'round', outline: 'none' },
                    }}
                  />
                </g>
              )
            })
          }
        </Geographies>

        {/* State titles (under generators so dots draw on top) — wide-tracking
            two-line label + tabular price below. Sits inland on empty land. */}
        <g pointerEvents="none" textAnchor="middle">
          {Object.entries(LABEL_ANCHOR).map(([rid, lonlat]) => {
            const p = projection(lonlat)
            if (!p) return null
            const isSelected = selected === rid
            const titleFill = isSelected ? '#a85a00' : '#1d1d1f'
            const titleOpacity = isSelected ? 0.85 : 0.42
            const [l1, l2] = STATE_TITLE[rid] ?? [rid.replace(/1$/, ''), '']
            return (
              <g key={`title-${rid}`}>
                <text x={p[0]} y={p[1]} fontSize={11}
                      fontWeight={700} fill={titleFill} fillOpacity={titleOpacity}
                      style={{ letterSpacing: '0.32em' }}>
                  {l1}
                </text>
                <text x={p[0]} y={p[1] + 14} fontSize={11}
                      fontWeight={700} fill={titleFill} fillOpacity={titleOpacity}
                      style={{ letterSpacing: '0.32em' }}>
                  {l2}
                </text>
              </g>
            )
          })}
        </g>

        {/* Interconnector lines + flow arrows. */}
        <g>
          {lines.map((l) => (
            <g key={l.ic.id}
               onMouseMove={(e) => setHoverIC({ ic: l.ic, x: e.clientX, y: e.clientY })}
               onMouseLeave={() => setHoverIC(null)}
               style={{ cursor: 'help' }}>
              {l.stroke.color === '#ff3b30' && (
                <path d={l.path} fill="none"
                      stroke={l.stroke.color}
                      strokeWidth={l.stroke.width + 6}
                      strokeOpacity={0.18}
                      strokeLinecap="round" />
              )}
              <path d={l.path} fill="none"
                    stroke={l.stroke.color}
                    strokeWidth={l.stroke.width}
                    strokeOpacity={l.stroke.opacity}
                    strokeLinecap="round"
                    strokeDasharray={l.ic.mnsp ? '5 4' : undefined} />
              <circle cx={l.startX} cy={l.startY} r={2.2}
                      fill={l.stroke.color} fillOpacity={l.stroke.opacity} />
              <circle cx={l.endX} cy={l.endY} r={2.2}
                      fill={l.stroke.color} fillOpacity={l.stroke.opacity} />
              <polygon points={l.arrow}
                       fill={l.stroke.color}
                       fillOpacity={Math.max(0.7, l.stroke.opacity)} />
              <path d={l.path} fill="none" stroke="transparent" strokeWidth={16} />
            </g>
          ))}
        </g>

        {/* Generator markers — shape-encoded by fuel, output-filled by
            current MW, with halo on ≥500 MW majors so the big movers pop. */}
        <g>
          {generators && stationDotsSorted.map((d) => {
            const isBess = d.s.fuel === 'battery'
            const baseColor = generators.fuel_colors[d.s.fuel] ?? '#86868b'
            const shape = FUEL_SHAPE[d.s.fuel] ?? circlePath
            const isMajor = d.s.capacity_mw >= 500
            const onMove = (e: any) =>
              setHoverStation({ s: d.s, x: e.clientX, y: e.clientY })
            const onLeave = () => setHoverStation(null)

            if (isBess) {
              const state = classifyBess(d.s.mw, d.s.capacity_mw)
              const stateCol = BESS_STATE_COLOR[state]
              const haloR = Math.max(d.r + 1.5, d.r * (1 + Math.min(1, d.util)))
              return (
                <g key={`${d.s.station}-${d.s.region}`}
                   transform={`translate(${d.x},${d.y})`}
                   onMouseMove={onMove} onMouseLeave={onLeave}
                   style={{ cursor: 'help' }}>
                  {(state === 'charging' || state === 'discharging') && (
                    <circle r={haloR + 3}
                            fill={stateCol} fillOpacity={0.12}
                            filter="url(#nem-pulse)">
                      <animate attributeName="r"
                               values={`${haloR + 1};${haloR + 7};${haloR + 1}`}
                               dur="2.4s" repeatCount="indefinite" />
                      <animate attributeName="fill-opacity"
                               values="0.22;0.04;0.22"
                               dur="2.4s" repeatCount="indefinite" />
                    </circle>
                  )}
                  {/* Outer square frame */}
                  <path d={squarePath(d.r + 1.2)}
                        fill="#ffffff" stroke={stateCol}
                        strokeWidth={1.4} strokeOpacity={0.95}
                        vectorEffect="non-scaling-stroke" />
                  {/* Inner fill scaled by output */}
                  <path d={squarePath(Math.max(1, d.r * Math.sqrt(d.util)))}
                        fill={stateCol} fillOpacity={0.92} />
                </g>
              )
            }

            // Non-BESS: shape by fuel, glow only for ≥500 MW majors.
            const haloR = Math.max(1, d.r * Math.sqrt(d.util))
            return (
              <g key={`${d.s.station}-${d.s.region}`}
                 transform={`translate(${d.x},${d.y})`}
                 onMouseMove={onMove} onMouseLeave={onLeave}
                 style={{ cursor: 'help' }}
                 filter={isMajor ? 'url(#nem-major-glow)' : undefined}>
                <path d={shape(d.r)}
                      fill="#ffffff" fillOpacity={0.96}
                      stroke={baseColor} strokeOpacity={0.88}
                      strokeWidth={isMajor ? 1.4 : 1}
                      vectorEffect="non-scaling-stroke" />
                <path d={shape(haloR)}
                      fill={baseColor} fillOpacity={0.9} />
              </g>
            )
          })}
        </g>

        {/* Price overlays — small price chip per state, anchored at the
            label position with a 28px vertical offset so it sits below the
            two-line title without colliding with generator clusters. */}
        <g pointerEvents="none">
          {Object.entries(LABEL_ANCHOR).map(([rid, lonlat]) => {
            const p = projection(lonlat)
            if (!p) return null
            const snap = nemMap.get(rid)
            if (!snap?.rrp && snap?.rrp !== 0) return null
            const isSelected = selected === rid
            const fill = isSelected ? '#a85a00' : '#1d1d1f'
            // Price chip y depends on which state — small/island states
            // need their chip a bit further from the title to clear the dots.
            const yOffset = rid === 'TAS1' ? 34 : rid === 'SA1' ? 34 : 34
            return (
              <g key={`price-${rid}`}>
                <text x={p[0]} y={p[1] + yOffset} textAnchor="middle"
                      fontSize={isSelected ? 13 : 12}
                      fontWeight={600}
                      fill={fill}
                      style={{ paintOrder: 'stroke', stroke: '#ffffff', strokeWidth: 4,
                               fontVariantNumeric: 'tabular-nums' }}>
                  ${snap.rrp.toFixed(0)}
                  <tspan fontSize={9} fill="#86868b" dx={2} fontWeight={500}>/MWh</tspan>
                </text>
              </g>
            )
          })}
        </g>
      </ComposableMap>

      {/* IC tooltip */}
      {hoverIC && (
        <div
          className="fixed z-50 pointer-events-none rounded-xl bg-white shadow-cardHover border border-hairlineSoft px-3.5 py-2.5 text-[12px]"
          style={{ left: hoverIC.x + 14, top: hoverIC.y + 14, minWidth: 220 }}
        >
          <div className="font-semibold text-ink leading-tight">{hoverIC.ic.long_name}</div>
          <div className="text-muted text-[11px] mt-0.5">
            {hoverIC.ic.region_from.replace(/1$/, '')} ↔ {hoverIC.ic.region_to.replace(/1$/, '')}
            {hoverIC.ic.mnsp && (
              <span className="ml-2 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-surfaceAlt text-ink2">HVDC</span>
            )}
          </div>
          <div className="mt-2.5 grid grid-cols-3 gap-3">
            <div>
              <div className="text-[10px] text-muted uppercase tracking-wider">{t('map.flow')}</div>
              <div className="tabular-nums text-ink font-medium">{fmtMW(hoverIC.ic.flow_mw)}</div>
            </div>
            <div>
              <div className="text-[10px] text-muted uppercase tracking-wider">{t('map.limit')}</div>
              <div className="tabular-nums text-ink font-medium">
                {(hoverIC.ic.flow_mw ?? 0) >= 0
                  ? fmtMW(hoverIC.ic.export_limit_mw)
                  : fmtMW(Math.abs(hoverIC.ic.import_limit_mw ?? 0))}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-muted uppercase tracking-wider">{t('map.util')}</div>
              <div className="tabular-nums text-ink font-medium">
                {hoverIC.ic.utilisation === null ? '—' : `${(hoverIC.ic.utilisation * 100).toFixed(0)}%`}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Station tooltip */}
      {hoverStation && !hoverIC && (
        <div
          className="fixed z-50 pointer-events-none rounded-xl bg-white shadow-cardHover border border-hairlineSoft px-3.5 py-2.5 text-[12px]"
          style={{ left: hoverStation.x + 14, top: hoverStation.y + 14, minWidth: 220 }}
        >
          <div className="font-semibold text-ink leading-tight">{hoverStation.s.station}</div>
          <div className="text-muted text-[11px] mt-0.5">
            {hoverStation.s.region.replace(/1$/, '')} · {t(`fuel.${hoverStation.s.fuel}`)}
            {hoverStation.s.online_units < hoverStation.s.units.length && (
              <span className="ml-2 text-[10px] uppercase tracking-wider text-muted">
                {hoverStation.s.online_units}/{hoverStation.s.units.length} {t('map.online')}
              </span>
            )}
          </div>
          <div className="mt-2.5 grid grid-cols-3 gap-3">
            <div>
              <div className="text-[10px] text-muted uppercase tracking-wider">{t('map.now')}</div>
              <div className="tabular-nums text-ink font-medium">{fmtMW(hoverStation.s.mw)}</div>
            </div>
            <div>
              <div className="text-[10px] text-muted uppercase tracking-wider">{t('map.capacity')}</div>
              <div className="tabular-nums text-ink font-medium">{hoverStation.s.capacity_mw.toFixed(0)} MW</div>
            </div>
            <div>
              <div className="text-[10px] text-muted uppercase tracking-wider">{t('map.util')}</div>
              <div className="tabular-nums text-ink font-medium">
                {hoverStation.s.capacity_mw > 0
                  ? `${((hoverStation.s.mw / hoverStation.s.capacity_mw) * 100).toFixed(0)}%`
                  : '—'}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Compact legend — same treatment as NSW-BESS map. Shape-icon
          chips with per-fuel counts so the legend doubles as a "how
          much of each is on screen" summary. Only fuels present in
          current snapshot show a row. */}
      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] text-muted">
        {generators && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-ink2 font-semibold mr-1">{t('map.fuel')}</span>
            {(['coal_black','coal_brown','gas','hydro','wind','solar','battery','bioenergy'] as Fuel[])
              .filter((fuel) => (fuelCounts.get(fuel) ?? 0) > 0)
              .map((fuel) => {
                const color = generators.fuel_colors[fuel] ?? '#86868b'
                const shape = FUEL_SHAPE[fuel]
                const count = fuelCounts.get(fuel) ?? 0
                return (
                  <span key={fuel} className="flex items-center gap-1.5">
                    <svg width={12} height={12} viewBox="-6 -6 12 12">
                      <path d={shape(4.5)} fill={color} fillOpacity={0.9} />
                    </svg>
                    <span className="text-ink2">{t(`fuel.${fuel}`)}</span>
                    <span className="tabular-nums text-muted text-[10px]">{count}</span>
                  </span>
                )
              })}
          </div>
        )}
        {/* BESS live-state mini legend — only if any battery is on the map */}
        {generators && (fuelCounts.get('battery') ?? 0) > 0 && (
          <>
            <span className="h-3 w-px bg-hairlineSoft" />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-ink2 font-semibold mr-1">BESS</span>
              <span className="flex items-center gap-1.5">
                <svg width={12} height={12} viewBox="-6 -6 12 12">
                  <path d={squarePath(4.5)} fill={BESS_STATE_COLOR.discharging} fillOpacity={0.9} />
                </svg>
                {t('bess.discharging')}
              </span>
              <span className="flex items-center gap-1.5">
                <svg width={12} height={12} viewBox="-6 -6 12 12">
                  <path d={squarePath(4.5)} fill={BESS_STATE_COLOR.charging} fillOpacity={0.9} />
                </svg>
                {t('bess.charging')}
              </span>
              <span className="flex items-center gap-1.5">
                <svg width={12} height={12} viewBox="-6 -6 12 12">
                  <path d={squarePath(4.5)} fill="#ffffff" stroke="#86868b" strokeWidth={1} />
                </svg>
                {t('bess.idle')}
              </span>
            </div>
          </>
        )}
        <span className="h-3 w-px bg-hairlineSoft" />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-ink2 font-semibold mr-1">{t('map.interconnector')}</span>
          <span className="flex items-center gap-1.5"><span className="inline-block w-5 h-[1.5px] bg-[#86868b]" /> &lt; 25%</span>
          <span className="flex items-center gap-1.5"><span className="inline-block w-5 h-[2.5px] bg-[#ffb340]" /> 25–55%</span>
          <span className="flex items-center gap-1.5"><span className="inline-block w-5 h-[3.5px] bg-accent" /> 55–85%</span>
          <span className="flex items-center gap-1.5"><span className="inline-block w-5 h-[4.5px] bg-negative" /> &gt; 85%</span>
          <span className="flex items-center gap-1.5"><span className="inline-block w-5 border-t border-dashed border-[#86868b]" /> HVDC</span>
        </div>
        <span className="ml-auto text-muted">{t('map.clickHint')}</span>
      </div>
    </div>
  )
}
