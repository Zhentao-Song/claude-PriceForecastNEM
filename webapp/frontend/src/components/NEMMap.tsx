import { useEffect, useMemo, useRef, useState } from 'react'
import { ComposableMap, Geographies, Geography, ZoomableGroup } from 'react-simple-maps'
import { geoMercator } from 'd3-geo'
import type { Fuel, GeneratorsSnapshot, GridSnapshot, Interconnector, MLFEntry, RegionSnapshot, Station } from '../types'
import { useT } from '../i18n'

// ---- MLF colour scale -------------------------------------------------------
function mlfColor(mlf: number): string {
  if (mlf < 0.940) return '#ff3b30'
  if (mlf < 0.960) return '#ff6340'
  if (mlf < 0.975) return '#ff9500'
  if (mlf < 0.990) return '#ffd60a'
  if (mlf < 1.000) return '#a8e063'
  if (mlf < 1.010) return '#30d158'
  return '#00c7be'
}

// ---- Geometry & projection --------------------------------------------------

const STATE_FOR_REGION: Record<string, string> = {
  NSW1: 'New South Wales',
  QLD1: 'Queensland',
  VIC1: 'Victoria',
  SA1:  'South Australia',
  TAS1: 'Tasmania',
}
const REGION_FOR_STATE: Record<string, string> = Object.fromEntries(
  Object.entries(STATE_FOR_REGION).map(([k, v]) => [v, k]),
)

const LABEL_ANCHOR: Record<string, [number, number]> = {
  QLD1: [144.5, -23.0],
  NSW1: [146.0, -32.0],
  VIC1: [144.0, -36.6],
  SA1:  [135.5, -31.0],
  TAS1: [146.6, -42.2],
}
const STATE_TITLE: Record<string, [string, string]> = {
  QLD1: ['QUEEN', 'SLAND'],
  NSW1: ['NEW SOUTH', 'WALES'],
  VIC1: ['VICTO', 'RIA'],
  SA1:  ['SOUTH', 'AUSTRALIA'],
  TAS1: ['TAS', 'MANIA'],
}

const VIEW_W = 680
const VIEW_H = 780

const projection = geoMercator()
  .center([143, -29])
  .scale(1150)
  .translate([VIEW_W / 2, VIEW_H / 2])

// Zoom constants
const MIN_ZOOM = 1
const MAX_ZOOM = 10
const DEFAULT_CENTER: [number, number] = [144, -29]
const DEFAULT_ZOOM = 1

// Per-state zoom targets — geographic center + zoom level that fills the map
const STATE_VIEW: Record<string, { center: [number, number]; zoom: number }> = {
  QLD1: { center: [147.5, -22.0], zoom: 2.0 },
  NSW1: { center: [148.5, -33.0], zoom: 2.0 },
  VIC1: { center: [145.0, -37.2], zoom: 2.0 },
  SA1:  { center: [137.5, -33.5], zoom: 2.0 },
  TAS1: { center: [146.8, -42.2], zoom: 2.0 },
}

// ---- City landmarks — spatial orientation anchors --------------------------
// Capital cities + major regional centres per NEM state. Pure landmarks (no
// data) — small grey dots with labels so users have spatial reference after
// zooming in. Non-major cities only appear at zoom ≥ 2 to keep the base
// view uncluttered.
type CityAnchor = { name: string; coord: [number, number]; major?: boolean }
const NEM_CITIES: CityAnchor[] = [
  // NSW
  { name: 'Sydney',     coord: [151.21, -33.87], major: true },
  { name: 'Newcastle',  coord: [151.78, -32.93] },
  { name: 'Wollongong', coord: [150.89, -34.43] },
  { name: 'Canberra',   coord: [149.13, -35.28] },
  // QLD
  { name: 'Brisbane',   coord: [153.02, -27.47], major: true },
  { name: 'Townsville', coord: [146.82, -19.26] },
  { name: 'Cairns',     coord: [145.77, -16.92] },
  // VIC
  { name: 'Melbourne',  coord: [144.96, -37.81], major: true },
  { name: 'Geelong',    coord: [144.36, -38.14] },
  // SA
  { name: 'Adelaide',   coord: [138.60, -34.93], major: true },
  { name: 'Whyalla',    coord: [137.59, -33.03] },
  // TAS
  { name: 'Hobart',     coord: [147.33, -42.88], major: true },
  { name: 'Launceston', coord: [147.14, -41.44] },
]

// ---- Generator shape encoding -----------------------------------------------
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
  coal_black:   circlePath,
  coal_brown:   circlePath,
  gas:          circlePath,
  bioenergy:    circlePath,
  hydro:        triangleDown,
  wind:         circlePath,
  solar:        diamondPath,
  rooftop_solar: diamondPath,  // same shape as utility solar — both PV panel silhouette
  battery:      squarePath,
}

// ---- BESS state classification ----------------------------------------------
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

// ---- Visual helpers ---------------------------------------------------------

type Props = {
  grid: GridSnapshot | null
  generators: GeneratorsSnapshot | null
  nem: RegionSnapshot[]
  selected: string
  onSelect: (region: string) => void
  fuelFilter?: Set<string> | null
  mlfData?: MLFEntry[] | null
}

function radiusFromCapacity(mw: number): number {
  return Math.max(2.2, Math.sqrt(mw) * 0.26)
}
function fmtMW(v: number | null | undefined, signed = false): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  const s = signed && v >= 0 ? '+' : ''
  return `${s}${v.toFixed(0)} MW`
}
function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  return `${(v * 100).toFixed(0)}%`
}
function utilisationStyle(u: number | null): { color: string; width: number; opacity: number } {
  if (u === null || Number.isNaN(u)) return { color: '#c7c7cc', width: 1.5, opacity: 0.55 }
  if (u >= 0.85) return { color: '#ff3b30', width: 4.2, opacity: 0.95 }
  if (u >= 0.55) return { color: '#ff9500', width: 3.2, opacity: 0.9 }
  if (u >= 0.25) return { color: '#ffb340', width: 2.4, opacity: 0.85 }
  return                  { color: '#86868b', width: 1.4, opacity: 0.5 }
}
// All states share the same neutral fill — selection is indicated by a blue
// border + auto-zoom, not a fill colour change.
function regionFill(_rrp: number | null | undefined, _selected: boolean): string {
  return '#f0f0f3'
}

// ---- Component --------------------------------------------------------------

export function NEMMap({ grid, generators, nem, selected, onSelect, fuelFilter, mlfData }: Props) {
  const { t } = useT()
  const [hoverIC, setHoverIC] = useState<{ ic: Interconnector; x: number; y: number } | null>(null)
  const [hoverStation, setHoverStation] = useState<{ s: Station; x: number; y: number } | null>(null)
  const [hoverMLF, setHoverMLF] = useState<{ e: MLFEntry; x: number; y: number } | null>(null)
  const [showMLF] = useState(true)   // always on — toggle removed
  const [showTx]  = useState(true)   // always on — toggle removed

  // ---- Pan + zoom state ---------------------------------------------------
  const [mapPos, setMapPos] = useState<{ coordinates: [number, number]; zoom: number }>({
    coordinates: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
  })
  const [isDragging, setIsDragging] = useState(false)

  // √zoom inverse scale: markers grow somewhat when zooming in but not 1:1,
  // keeping the map readable at both 1× overview and 6× station-level zoom.
  const visualScale = 1 / Math.sqrt(mapPos.zoom)
  const setZoom = (z: number) =>
    setMapPos((p) => ({ ...p, zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z)) }))
  const resetView = () => setMapPos({ coordinates: DEFAULT_CENTER, zoom: DEFAULT_ZOOM })

  // Geographic pan limits — keep Australia always in view.
  // Longitude 108–158°, Latitude -46° to -8°.
  const clampCoords = (lon: number, lat: number): [number, number] => [
    Math.max(108, Math.min(158, lon)),
    Math.max(-46, Math.min(-8, lat)),
  ]

  // Auto-zoom to the selected region whenever it changes from outside
  // (e.g. a region tile card click in the sidebar).  Skip the initial mount
  // so the map starts at the default full-NEM overview.
  const isMounted = useRef(false)
  useEffect(() => {
    if (!isMounted.current) { isMounted.current = true; return }
    const view = STATE_VIEW[selected]
    if (view) setMapPos({ coordinates: view.center, zoom: view.zoom })
  }, [selected])

  const nemMap = useMemo(() => {
    const m = new Map<string, RegionSnapshot>()
    nem.forEach((r) => m.set(r.regionid, r))
    return m
  }, [nem])

  const stationDots = useMemo(() => {
    if (!generators) return []
    return generators.stations
      .filter((s) => !fuelFilter || fuelFilter.has(s.fuel))
      .map((s) => {
        const p = projection([s.lon, s.lat])
        if (!p) return null
        const r    = radiusFromCapacity(s.capacity_mw)
        const cap  = s.capacity_mw || 1
        const util = Math.max(0, Math.min(1.2, Math.abs(s.mw || 0) / cap))
        return { s, x: p[0], y: p[1], r, util }
      })
      .filter(Boolean) as Array<{ s: Station; x: number; y: number; r: number; util: number }>
  }, [generators, fuelFilter])
  const stationDotsSorted = useMemo(
    () => [...stationDots].sort((a, b) => b.r - a.r),
    [stationDots],
  )

  const mlfDots = useMemo(() => {
    if (!mlfData) return []
    return mlfData
      .filter((e) => e.lat !== null && e.lon !== null)
      .map((e) => {
        const p = projection([e.lon!, e.lat!])
        if (!p) return null
        const r = Math.max(3.5, Math.sqrt(e.capacity_mw ?? 50) * 0.22)
        return { e, x: p[0], y: p[1], r }
      })
      .filter(Boolean) as Array<{ e: MLFEntry; x: number; y: number; r: number }>
  }, [mlfData])

  const fuelCounts = useMemo(() => {
    const m = new Map<Fuel, number>()
    if (!generators) return m
    for (const s of generators.stations) m.set(s.fuel, (m.get(s.fuel) ?? 0) + 1)
    return m
  }, [generators])

  const lines = useMemo(() => {
    if (!grid) return []
    return grid.interconnectors.map((ic, idx) => {
      const a = projection(ic.from)
      const b = projection(ic.to)
      if (!a || !b) return null
      const flow    = ic.flow_mw ?? 0
      const reverse = flow < 0
      const start   = reverse ? b : a
      const end     = reverse ? a : b
      const stroke  = utilisationStyle(ic.utilisation)
      const dx = end[0] - start[0], dy = end[1] - start[1]
      const len = Math.hypot(dx, dy) || 1
      const ux = dx / len, uy = dy / len
      const nx = -uy, ny = ux
      const sign = idx % 2 === 0 ? 1 : -1
      const bow  = Math.min(30, len * 0.10) * sign
      const cx   = (start[0] + end[0]) / 2 + nx * bow
      const cy   = (start[1] + end[1]) / 2 + ny * bow
      const path = `M ${start[0]} ${start[1]} Q ${cx} ${cy} ${end[0]} ${end[1]}`
      const mx   = 0.25 * start[0] + 0.5 * cx + 0.25 * end[0]
      const my   = 0.25 * start[1] + 0.5 * cy + 0.25 * end[1]
      const tx   = (cx - start[0]) + ((end[0] - cx) - (cx - start[0])) * 0.5
      const ty   = (cy - start[1]) + ((end[1] - cy) - (cy - start[1])) * 0.5
      const tlen = Math.hypot(tx, ty) || 1
      const tux  = tx / tlen, tuy = ty / tlen
      const tnx  = -tuy,     tny = tux
      const sz   = 5.5
      const tip   = [mx + tux * sz, my + tuy * sz]
      const baseL = [mx - tux * sz * 0.6 + tnx * sz * 0.7, my - tuy * sz * 0.6 + tny * sz * 0.7]
      const baseR = [mx - tux * sz * 0.6 - tnx * sz * 0.7, my - tuy * sz * 0.6 - tny * sz * 0.7]
      return {
        ic, path, stroke,
        startX: start[0], startY: start[1],
        endX:   end[0],   endY:   end[1],
        arrow: `${tip[0]},${tip[1]} ${baseL[0]},${baseL[1]} ${baseR[0]},${baseR[1]}`,
      }
    }).filter(Boolean) as Array<{
      ic: Interconnector; path: string
      stroke: { color: string; width: number; opacity: number }
      startX: number; startY: number; endX: number; endY: number
      arrow: string
    }>
  }, [grid])

  return (
    <div className="relative w-full">

      {/*
        * Sticky zoom controls — height-0 row so they don't push content down,
        * but overflow-visible so the panel floats over the map below.
        * sticky + top means they stay in the corner even when the page scrolls
        * past the top of the map section.
        */}
      <div className="sticky top-2 z-20 h-0 overflow-visible flex justify-end pointer-events-none">
        <div className="mt-3 mr-3 pointer-events-auto flex flex-col bg-white/95 backdrop-blur rounded-md shadow-card border border-hairlineSoft overflow-hidden text-[14px] select-none">
        <button
          onClick={() => setZoom(mapPos.zoom * 1.6)}
          disabled={mapPos.zoom >= MAX_ZOOM}
          title={t('map.zoom.in')}
          className="w-8 h-8 flex items-center justify-center hover:bg-surfaceAlt disabled:opacity-40 disabled:cursor-not-allowed transition"
        >+</button>
        <button
          onClick={() => setZoom(mapPos.zoom / 1.6)}
          disabled={mapPos.zoom <= MIN_ZOOM}
          title={t('map.zoom.out')}
          className="w-8 h-8 flex items-center justify-center hover:bg-surfaceAlt disabled:opacity-40 disabled:cursor-not-allowed transition border-t border-hairlineSoft"
        >−</button>
        <button
          onClick={resetView}
          title={t('map.zoom.reset')}
          className="w-8 h-8 flex items-center justify-center hover:bg-surfaceAlt transition border-t border-hairlineSoft text-[11px]"
        >⤾</button>
        </div>  {/* inner panel */}
      </div>    {/* sticky wrapper */}

      {/* Zoom level readout — bottom-left, only when zoomed in */}
      {mapPos.zoom > 1.05 && (
        <div className="absolute bottom-16 left-2 z-10 px-2 py-1 rounded bg-white/95 border border-hairlineSoft text-[10px] text-muted tabular-nums shadow-sm">
          {mapPos.zoom.toFixed(1)}×
        </div>
      )}

      <ComposableMap
        projection={projection as any}
        width={VIEW_W}
        height={VIEW_H}
        style={{
          width: '100%', height: 'auto', display: 'block',
          background: '#f5f6fa',
          borderRadius: 12,
          cursor: isDragging ? 'grabbing' : 'grab',
        }}
      >
        <defs>
          <filter id="nem-soft-shadow" x="-10%" y="-10%" width="120%" height="120%">
            <feGaussianBlur in="SourceAlpha" stdDeviation="1.2" />
            <feOffset dx="0" dy="1" result="offsetblur" />
            <feComponentTransfer><feFuncA type="linear" slope="0.18" /></feComponentTransfer>
            <feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <filter id="nem-selected-glow" x="-15%" y="-15%" width="130%" height="130%">
            <feGaussianBlur in="SourceAlpha" stdDeviation="3" result="blur" />
            <feFlood floodColor="#ff9500" floodOpacity="0.55" />
            <feComposite in2="blur" operator="in" result="glow" />
            <feMerge><feMergeNode in="glow" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <filter id="nem-major-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="2.2" result="blur" />
            <feFlood floodColor="#ffffff" floodOpacity="0.85" />
            <feComposite in2="blur" operator="in" result="glow" />
            <feMerge><feMergeNode in="glow" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <filter id="nem-pulse" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="1.5" />
          </filter>
        </defs>

        <ZoomableGroup
          center={mapPos.coordinates}
          zoom={mapPos.zoom}
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          onMoveStart={() => setIsDragging(true)}
          onMoveEnd={({ coordinates, zoom }) => {
            setIsDragging(false)
            const [lon, lat] = coordinates as [number, number]
            setMapPos({ coordinates: clampCoords(lon, lat), zoom })
          }}
        >
          {/* States */}
          <Geographies geography="/aus-states.geojson">
            {({ geographies }) =>
              geographies.map((geo) => {
                const name   = geo.properties.STATE_NAME as string
                const region = REGION_FOR_STATE[name]
                if (!region) return null
                const isSelected = region === selected
                const rrp    = nemMap.get(region)?.rrp
                const fill   = regionFill(rrp, isSelected)
                // Selected: crisp blue border; unselected: visible gray line
                const stroke  = isSelected ? '#2563eb' : '#6b7280'
                const strokeW = isSelected ? 2.5 : 1.4
                return (
                  <g key={geo.rsmKey}
                     filter="url(#nem-soft-shadow)">
                    <Geography
                      geography={geo}
                      onClick={() => onSelect(region)}
                      style={{
                        default: { fill, stroke, strokeWidth: strokeW,
                          strokeLinejoin: 'round', outline: 'none', cursor: 'pointer',
                          vectorEffect: 'non-scaling-stroke' },
                        hover:   { fill: '#e8edf6',
                          stroke, strokeWidth: strokeW, strokeLinejoin: 'round',
                          outline: 'none', vectorEffect: 'non-scaling-stroke' },
                        pressed: { fill, stroke, strokeWidth: strokeW,
                          strokeLinejoin: 'round', outline: 'none',
                          vectorEffect: 'non-scaling-stroke' },
                      }}
                    />
                  </g>
                )
              })
            }
          </Geographies>

          {/* Transmission network — NEM-wide OSM data, 132–500 kV.
              500/330 kV backbone visible at all zoom levels.
              220 kV subtransmission only from zoom 2×.
              132 kV distribution texture only from zoom 3×. */}
          {showTx && (
            <Geographies geography="/nem-transmission.geojson">
              {({ geographies }) =>
                geographies
                  .filter((g) => {
                    const v = (g.properties.v as number) || 132
                    if (v < 220 && mapPos.zoom < 3) return false
                    if (v < 330 && mapPos.zoom < 2) return false
                    return true
                  })
                  .map((geo) => {
                    const v = (geo.properties.v as number) || 132
                    const { sw, col, op } =
                      v >= 500 ? { sw: 1.6, col: '#1d4ed8', op: 0.85 }
                      : v >= 330 ? { sw: 1.2, col: '#2563eb', op: 0.75 }
                      : v >= 220 ? { sw: 0.85, col: '#3b82f6', op: 0.6 }
                      :            { sw: 0.55, col: '#60a5fa', op: 0.42 }
                    return (
                      <Geography
                        key={geo.rsmKey} geography={geo}
                        style={{
                          default: { fill: 'none', stroke: col, strokeWidth: sw,
                            strokeOpacity: op, pointerEvents: 'none', outline: 'none',
                            vectorEffect: 'non-scaling-stroke' },
                          hover:   { fill: 'none', stroke: col, strokeWidth: sw,
                            strokeOpacity: op, outline: 'none',
                            vectorEffect: 'non-scaling-stroke' },
                          pressed: { fill: 'none', stroke: col, strokeWidth: sw,
                            strokeOpacity: op, outline: 'none',
                            vectorEffect: 'non-scaling-stroke' },
                        }}
                      />
                    )
                  })
              }
            </Geographies>
          )}

          {/* State title labels + price chips */}
          <g pointerEvents="none" textAnchor="middle">
            {Object.entries(LABEL_ANCHOR).map(([rid, lonlat]) => {
              const p = projection(lonlat)
              if (!p) return null
              const isSelected   = selected === rid
              const titleFill    = isSelected ? '#1d4ed8' : '#3a3a45'
              const titleOpacity = isSelected ? 0.9 : 0.5
              const [l1, l2] = STATE_TITLE[rid] ?? [rid.replace(/1$/, ''), '']
              const snap = nemMap.get(rid)
              return (
                <g key={`title-${rid}`}>
                  <text x={p[0]} y={p[1]} fontSize={11 * visualScale}
                        fontWeight={700} fill={titleFill} fillOpacity={titleOpacity}
                        style={{ letterSpacing: '0.32em' }}>
                    {l1}
                  </text>
                  <text x={p[0]} y={p[1] + 14 * visualScale} fontSize={11 * visualScale}
                        fontWeight={700} fill={titleFill} fillOpacity={titleOpacity}
                        style={{ letterSpacing: '0.32em' }}>
                    {l2}
                  </text>
                  {snap?.rrp !== undefined && snap?.rrp !== null && (
                    <text x={p[0]} y={p[1] + 36 * visualScale} textAnchor="middle"
                          fontSize={(isSelected ? 14 : 12) * visualScale}
                          fontWeight={isSelected ? 700 : 600}
                          fill={isSelected ? '#1d4ed8' : '#3a3a45'}
                          style={{ paintOrder: 'stroke', stroke: '#f5f6fa',
                                   strokeWidth: 4 * visualScale,
                                   fontVariantNumeric: 'tabular-nums' }}>
                      ${snap.rrp.toFixed(0)}
                      <tspan fontSize={9 * visualScale} fill="#86868b" dx={2} fontWeight={500}>/MWh</tspan>
                    </text>
                  )}
                </g>
              )
            })}
          </g>

          {/* City landmarks — spatial reference dots + labels */}
          <g pointerEvents="none">
            {NEM_CITIES.map((c) => {
              if (!c.major && mapPos.zoom < 2) return null
              const p = projection(c.coord)
              if (!p) return null
              const r = (c.major ? 3.2 : 2.0) * visualScale
              return (
                <g key={c.name}>
                  <circle cx={p[0]} cy={p[1]} r={r * 2.2}
                          fill="#1d1d1f" fillOpacity={0.04} />
                  <circle cx={p[0]} cy={p[1]} r={r}
                          fill="#5a5a62" fillOpacity={0.5} />
                  <text x={p[0] + r + 3 * visualScale} y={p[1] + 1}
                        fontSize={(c.major ? 10 : 8.5) * visualScale}
                        fontWeight={c.major ? 600 : 500}
                        fill="#5a5a62"
                        style={{ paintOrder: 'stroke', stroke: '#f5f6fa',
                                 strokeWidth: 3 * visualScale }}>
                    {c.name}
                  </text>
                </g>
              )
            })}
          </g>

          {/* Interconnector lines + flow arrows */}
          <g>
            {lines.map((l) => {
              const sw = l.stroke.width * visualScale
              return (
                <g key={l.ic.id}
                   onMouseMove={(e) => setHoverIC({ ic: l.ic, x: e.clientX, y: e.clientY })}
                   onMouseLeave={() => setHoverIC(null)}
                   style={{ cursor: 'help' }}>
                  {l.stroke.color === '#ff3b30' && (
                    <path d={l.path} fill="none"
                          stroke={l.stroke.color}
                          strokeWidth={sw + 6 * visualScale}
                          strokeOpacity={0.18} strokeLinecap="round" />
                  )}
                  <path d={l.path} fill="none"
                        stroke={l.stroke.color}
                        strokeWidth={sw}
                        strokeOpacity={l.stroke.opacity}
                        strokeLinecap="round"
                        strokeDasharray={l.ic.mnsp ? `${5 * visualScale} ${4 * visualScale}` : undefined} />
                  <circle cx={l.startX} cy={l.startY} r={2.2 * visualScale}
                          fill={l.stroke.color} fillOpacity={l.stroke.opacity} />
                  <circle cx={l.endX}   cy={l.endY}   r={2.2 * visualScale}
                          fill={l.stroke.color} fillOpacity={l.stroke.opacity} />
                  <polygon points={l.arrow}
                           fill={l.stroke.color}
                           fillOpacity={Math.max(0.7, l.stroke.opacity)} />
                  <path d={l.path} fill="none" stroke="transparent" strokeWidth={16 * visualScale} />
                </g>
              )
            })}
          </g>

          {/* Generator markers — shape by fuel, BESS with pulse + direction arrows */}
          <g>
            {generators && stationDotsSorted.map((d) => {
              const isBess    = d.s.fuel === 'battery'
              const baseColor = generators.fuel_colors[d.s.fuel] ?? '#86868b'
              const rr        = d.r * visualScale
              const shape     = FUEL_SHAPE[d.s.fuel] ?? circlePath
              const isMajor   = d.s.capacity_mw >= 500
              const onMove    = (e: any) => setHoverStation({ s: d.s, x: e.clientX, y: e.clientY })
              const onLeave   = () => setHoverStation(null)

              if (isBess) {
                const state    = classifyBess(d.s.mw, d.s.capacity_mw)
                const stateCol = BESS_STATE_COLOR[state]
                const haloR    = Math.max(rr + 2 * visualScale, rr * (1 + Math.min(1, d.util)))
                return (
                  <g key={`${d.s.station}-${d.s.region}`}
                     transform={`translate(${d.x},${d.y})`}
                     onMouseMove={onMove} onMouseLeave={onLeave}
                     style={{ cursor: 'help' }}>
                    {(state === 'charging' || state === 'discharging') && (
                      <circle r={haloR + 4 * visualScale}
                              fill={stateCol} fillOpacity={0.10}
                              filter="url(#nem-pulse)">
                        <animate attributeName="r"
                                 values={`${haloR + 2 * visualScale};${haloR + 8 * visualScale};${haloR + 2 * visualScale}`}
                                 dur="2.4s" repeatCount="indefinite" />
                        <animate attributeName="fill-opacity"
                                 values="0.22;0.04;0.22"
                                 dur="2.4s" repeatCount="indefinite" />
                      </circle>
                    )}
                    {/* Outer square frame */}
                    <path d={squarePath(rr + 1.5 * visualScale)}
                          fill="#ffffff" stroke={stateCol}
                          strokeWidth={1.5} strokeOpacity={0.95}
                          vectorEffect="non-scaling-stroke" />
                    {/* Inner fill scaled by output */}
                    <path d={squarePath(Math.max(1.2 * visualScale, rr * Math.sqrt(d.util)))}
                          fill={stateCol} fillOpacity={0.92} />
                    {/* Direction arrows — ↑ discharging, ↓ charging */}
                    {state === 'discharging' && (
                      <text y={-rr - 5 * visualScale} textAnchor="middle"
                            fontSize={11 * visualScale} fontWeight={700} fill={stateCol}
                            style={{ paintOrder: 'stroke', stroke: '#f5f6fa',
                                     strokeWidth: 3 * visualScale }}>↑</text>
                    )}
                    {state === 'charging' && (
                      <text y={rr + 11 * visualScale} textAnchor="middle"
                            fontSize={11 * visualScale} fontWeight={700} fill={stateCol}
                            style={{ paintOrder: 'stroke', stroke: '#f5f6fa',
                                     strokeWidth: 3 * visualScale }}>↓</text>
                    )}
                  </g>
                )
              }

              // Non-BESS generators
              const haloR = Math.max(1 * visualScale, rr * Math.sqrt(d.util))
              return (
                <g key={`${d.s.station}-${d.s.region}`}
                   transform={`translate(${d.x},${d.y})`}
                   onMouseMove={onMove} onMouseLeave={onLeave}
                   style={{ cursor: 'help' }}
                   filter={isMajor ? 'url(#nem-major-glow)' : undefined}>
                  <path d={shape(rr)}
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

          {/* MLF heatmap layer */}
          {showMLF && (
            <g>
              {mlfDots.map((d) => (
                <g key={`mlf-${d.e.duid}`}
                   transform={`translate(${d.x},${d.y})`}
                   onMouseMove={(e) => setHoverMLF({ e: d.e, x: e.clientX, y: e.clientY })}
                   onMouseLeave={() => setHoverMLF(null)}
                   style={{ cursor: 'help' }}>
                  <circle r={d.r + 1.5} fill="#ffffff" fillOpacity={0.7} />
                  <circle r={d.r}
                          fill={mlfColor(d.e.mlf)}
                          fillOpacity={0.82}
                          stroke="#ffffff"
                          strokeWidth={0.8}
                          strokeOpacity={0.6} />
                  {d.r >= 6 && (
                    <text y={d.r + 7} textAnchor="middle"
                          fontSize={7.5} fill="#1d1d1f" fillOpacity={0.75}
                          style={{ paintOrder: 'stroke', stroke: '#fff', strokeWidth: 2 }}>
                      {d.e.mlf.toFixed(3)}
                    </text>
                  )}
                </g>
              ))}
            </g>
          )}
        </ZoomableGroup>
      </ComposableMap>

      {/* IC tooltip */}
      {hoverIC && (
        <div className="fixed z-50 pointer-events-none rounded-xl bg-white shadow-cardHover border border-hairlineSoft px-3.5 py-2.5 text-[12px]"
             style={{ left: hoverIC.x + 14, top: hoverIC.y + 14, minWidth: 220 }}>
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
              <div className="tabular-nums text-ink font-medium">{fmtMW(hoverIC.ic.flow_mw, true)}</div>
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
              <div className="tabular-nums text-ink font-medium">{fmtPct(hoverIC.ic.utilisation)}</div>
            </div>
          </div>
        </div>
      )}

      {/* Station tooltip — BESS gets a coloured state badge */}
      {hoverStation && !hoverIC && (
        <div className="fixed z-50 pointer-events-none rounded-xl bg-white shadow-cardHover border border-hairlineSoft px-3.5 py-2.5 text-[12px]"
             style={{ left: hoverStation.x + 14, top: hoverStation.y + 14, minWidth: 220 }}>
          <div className="font-semibold text-ink leading-tight">{hoverStation.s.station}</div>
          <div className="text-muted text-[11px] mt-0.5 flex items-center gap-2 flex-wrap">
            <span>{hoverStation.s.region.replace(/1$/, '')} · {t(`fuel.${hoverStation.s.fuel}`)}</span>
            {hoverStation.s.fuel === 'battery' && (() => {
              const state = classifyBess(hoverStation.s.mw, hoverStation.s.capacity_mw)
              const col   = BESS_STATE_COLOR[state]
              return (
                <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold"
                      style={{ background: col + '22', color: col }}>
                  {t(`bess.${state}`)}
                </span>
              )
            })()}
            {hoverStation.s.online_units < hoverStation.s.units.length && (
              <span className="text-[10px] text-muted">
                {hoverStation.s.online_units}/{hoverStation.s.units.length} {t('map.online')}
              </span>
            )}
          </div>
          <div className="mt-2.5 grid grid-cols-3 gap-3">
            <div>
              <div className="text-[10px] text-muted uppercase tracking-wider">{t('map.now')}</div>
              <div className="tabular-nums text-ink font-medium">{fmtMW(hoverStation.s.mw, true)}</div>
            </div>
            <div>
              <div className="text-[10px] text-muted uppercase tracking-wider">{t('map.capacity')}</div>
              <div className="tabular-nums text-ink font-medium">{hoverStation.s.capacity_mw.toFixed(0)} MW</div>
            </div>
            <div>
              <div className="text-[10px] text-muted uppercase tracking-wider">{t('map.util')}</div>
              <div className="tabular-nums text-ink font-medium">
                {hoverStation.s.capacity_mw > 0
                  ? `${((Math.abs(hoverStation.s.mw) / hoverStation.s.capacity_mw) * 100).toFixed(0)}%`
                  : '—'}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MLF tooltip */}
      {hoverMLF && showMLF && (
        <div className="fixed z-50 pointer-events-none rounded-xl bg-white shadow-cardHover border border-hairlineSoft px-3.5 py-2.5 text-[12px]"
             style={{ left: hoverMLF.x + 14, top: hoverMLF.y + 14, minWidth: 200 }}>
          <div className="font-semibold text-ink leading-tight">{hoverMLF.e.station_name ?? hoverMLF.e.duid}</div>
          <div className="text-muted text-[11px] mt-0.5">
            {hoverMLF.e.duid} · {hoverMLF.e.region.replace(/1$/, '')} · {hoverMLF.e.fuel_type ?? '—'}
          </div>
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5">
            <div>
              <div className="text-[10px] text-muted uppercase tracking-wider">MLF</div>
              <div className="tabular-nums font-semibold text-[16px]"
                   style={{ color: mlfColor(hoverMLF.e.mlf) }}>
                {hoverMLF.e.mlf.toFixed(4)}
              </div>
            </div>
            {hoverMLF.e.capacity_mw && (
              <div>
                <div className="text-[10px] text-muted uppercase tracking-wider">{t('map.capacity')}</div>
                <div className="tabular-nums font-medium">{hoverMLF.e.capacity_mw} MW</div>
              </div>
            )}
          </div>
          <div className="mt-1.5 text-[10px] text-muted">{hoverMLF.e.financial_year} FY</div>
        </div>
      )}

      {/* Compact legend */}
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
        {generators && (fuelCounts.get('battery') ?? 0) > 0 && (
          <>
            <span className="h-3 w-px bg-hairlineSoft" />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-ink2 font-semibold mr-1">BESS</span>
              <span className="flex items-center gap-1.5">
                <svg width={12} height={12} viewBox="-6 -6 12 12">
                  <path d={squarePath(4.5)} fill={BESS_STATE_COLOR.discharging} fillOpacity={0.9} />
                </svg>
                {t('bess.discharging')} ↑
              </span>
              <span className="flex items-center gap-1.5">
                <svg width={12} height={12} viewBox="-6 -6 12 12">
                  <path d={squarePath(4.5)} fill={BESS_STATE_COLOR.charging} fillOpacity={0.9} />
                </svg>
                {t('bess.charging')} ↓
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
        {showTx && (
          <>
            <span className="h-3 w-px bg-hairlineSoft" />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-ink2 font-semibold mr-1">{t('map.txLines')}</span>
              <span className="flex items-center gap-1.5"><span className="inline-block w-5 h-[2px] bg-[#1d4ed8]" /> 500 kV</span>
              <span className="flex items-center gap-1.5"><span className="inline-block w-5 h-[1.5px] bg-[#2563eb]" /> 330 kV</span>
              <span className="flex items-center gap-1.5"><span className="inline-block w-5 h-[1px] bg-[#3b82f6]" /> 220 kV</span>
              <span className="flex items-center gap-1.5"><span className="inline-block w-5 h-px bg-[#60a5fa]" /> 132 kV</span>
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

      {/* MLF colour legend */}
      {showMLF && mlfData && (
        <div className="mt-2 flex items-center gap-x-3 gap-y-1 flex-wrap text-[11px] text-muted">
          <span className="text-ink2 font-semibold mr-1">MLF</span>
          {(
            [
              { color: '#ff3b30', label: '< 0.94' },
              { color: '#ff9500', label: '0.94–0.97' },
              { color: '#ffd60a', label: '0.97–0.99' },
              { color: '#a8e063', label: '0.99–1.00' },
              { color: '#30d158', label: '≥ 1.00' },
            ] as const
          ).map(({ color, label }) => (
            <span key={label} className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ backgroundColor: color }} />
              <span>{label}</span>
            </span>
          ))}
          <span className="text-ink3 text-[10px]">· {t('map.mlfSource')}</span>
        </div>
      )}
    </div>
  )
}
