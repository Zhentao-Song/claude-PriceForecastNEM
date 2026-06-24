import { useEffect, useMemo, useState } from 'react'
import { ComposableMap, Geographies, Geography, ZoomableGroup } from 'react-simple-maps'
import { geoMercator } from 'd3-geo'
import type {
  Bid, BessState, Fill,
  GeneratorsSnapshot, GridSnapshot, Interconnector, RegionSnapshot, Snapshot, Station, Fuel,
} from '../types'
import {
  fetchPaperBids, fetchPaperFills, fetchPaperState, resetPaperState,
} from '../api'
import { BidForm } from './BidForm'
import { PositionCard } from './PositionCard'
import { BidLedger } from './BidLedger'
import { PaperAnalyticsPanel } from './PaperAnalyticsPanel'
import { SuggestedBids } from './SuggestedBids'
import { MarketTimeline } from './MarketTimeline'
import { FuelMixLive } from './FuelMixLive'
import { BESSDispatchPanel } from './BESSDispatchPanel'
import { BESSLeaderboard } from './BESSLeaderboard'
import { useT } from '../i18n'

// ---- NSW projection ------------------------------------------------------
// NSW bounding box: lon ~141°–154°, lat ~−37.5° to −28.2°. Centred over the
// state, scale tuned so NSW fills the viewBox with neighbouring states
// (QLD/VIC/SA) just visible at the edges for spatial context.
const VIEW_W = 720
const VIEW_H = 600
const projection = geoMercator()
  .center([147.5, -33])
  .scale(2900)
  .translate([VIEW_W / 2, VIEW_H / 2])

// ---- Constants -----------------------------------------------------------
const FOCUS_REGION = 'NSW1'
const FOCUS_STATE_NAME = 'New South Wales'
const NEIGHBOURS = new Set(['Queensland', 'Victoria', 'South Australia',
                            'Australian Capital Territory'])
const DEFAULT_BESS_DUID = 'WTAHB1'

// Default centre+zoom for the NSW view. Used to "reset" the zoom and as
// the initial ZoomableGroup state. Centre is slightly east of the state's
// geometric centre to give the dense Sydney/Newcastle generator cluster
// room to breathe.
const DEFAULT_CENTER: [number, number] = [147.5, -33]
const DEFAULT_ZOOM = 1
const MIN_ZOOM = 1
const MAX_ZOOM = 6

// Major demand centres for spatial orientation. These don't carry data —
// they're just landmarks so the user can recognise "oh, that's Sydney".
type CityAnchor = { name: string; coord: [number, number]; major?: boolean }
const NSW_CITIES: CityAnchor[] = [
  { name: 'Sydney',     coord: [151.21, -33.87], major: true },
  { name: 'Newcastle',  coord: [151.78, -32.93] },
  { name: 'Wollongong', coord: [150.89, -34.43] },
  { name: 'Canberra',   coord: [149.13, -35.28] },
  { name: 'Albury',     coord: [146.92, -36.08] },
  { name: 'Dubbo',      coord: [148.60, -32.25] },
  { name: 'Wagga',      coord: [147.36, -35.12] },
  { name: 'Tamworth',   coord: [150.93, -31.09] },
]

// Where to anchor the big state labels on neighbouring states (rough
// centroids — we don't have label coords in the geojson and computing them
// here would be overkill).
const NEIGHBOUR_LABEL_COORDS: Record<string, [number, number]> = {
  Queensland:           [148.5, -29.0],
  Victoria:             [144.0, -37.0],
  'South Australia':    [142.0, -33.5],
  'Australian Capital Territory': [149.1, -35.5],
}

// Fuel ordering for the stacked bar (heavy at bottom, intermittent at top).
const FUEL_ORDER: Fuel[] = [
  'coal_black', 'coal_brown', 'gas', 'hydro',
  'bioenergy', 'wind', 'solar', 'battery',
]
// Translation keys for fuels live in the i18n dictionary under `fuel.<id>`.
// Use `tFuel(t, fuel)` to resolve at render time.
function tFuel(t: (k: string, ...args: (string | number)[]) => string, f: Fuel): string {
  return t(`fuel.${f}`)
}

// ---- Generator shape encoding -------------------------------------------
// Inspired by opengridworks.com — give each fuel category a distinct shape
// so a fast glance reads "where is the BESS / wind / solar" without
// stopping to decode a colour legend. Symbol functions return SVG path
// strings centred on (0,0) scaled to radius r.
type ShapeFn = (r: number) => string
const FUEL_SHAPE: Record<Fuel, ShapeFn> = {
  coal_black:    circlePath,   // thermal = solid circle
  coal_brown:    circlePath,
  gas:           circlePath,
  bioenergy:     circlePath,
  hydro:         triangleDown, // ▽ — flowing water reservoir
  wind:          circlePath,   // ● — turbine "rotor"
  solar:         diamondPath,  // ◆ — panel tilt
  rooftop_solar: diamondPath,  // ◆ — same panel silhouette, golden colour
  battery:       squarePath,   // ■ — cell rack
}
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

// ---- Helpers -------------------------------------------------------------
function fmtMW(v: number | null | undefined, signed = false): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  const s = signed && v >= 0 ? '+' : ''
  return `${s}${v.toFixed(0)} MW`
}
function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  return `${(v * 100).toFixed(0)}%`
}
function radiusFromCapacity(mw: number): number {
  return Math.max(2.5, Math.sqrt(mw) * 0.32)
}
function utilStyle(u: number | null): { color: string; width: number; opacity: number } {
  if (u === null || Number.isNaN(u)) return { color: '#c7c7cc', width: 1.5, opacity: 0.5 }
  if (u >= 0.85) return { color: '#ff3b30', width: 4.5, opacity: 0.95 }
  if (u >= 0.55) return { color: '#ff9500', width: 3.5, opacity: 0.9 }
  if (u >= 0.25) return { color: '#ffb340', width: 2.5, opacity: 0.85 }
  return                  { color: '#86868b', width: 1.5, opacity: 0.55 }
}

// BESS state classification from current MW. Renamed `BessClass` to avoid
// colliding with the `BessState` type from ../types (paper-trading account).
type BessClass = 'charging' | 'discharging' | 'idle' | 'unknown'
function classifyBess(mw: number | null | undefined, capacity: number): BessClass {
  if (mw === null || mw === undefined || Number.isNaN(mw)) return 'unknown'
  // Within ±2% of capacity = idle (avoids flapping at near-zero readings).
  const threshold = Math.max(0.5, capacity * 0.02)
  if (mw > threshold) return 'discharging'
  if (mw < -threshold) return 'charging'
  return 'idle'
}
const BESS_STATE_COLOR: Record<BessClass, string> = {
  charging:    '#34c759',  // Apple green — taking energy in
  discharging: '#ff9500',  // Apple orange — pushing energy out
  idle:        '#86868b',  // Apple grey
  unknown:     '#c7c7cc',
}
// BESS state labels are dictionary-driven; resolve via `tBess(t, state)`.
function tBess(t: (k: string, ...args: (string | number)[]) => string, s: BessClass): string {
  return t(`bess.${s}`)
}

// ---- Component -----------------------------------------------------------
type Props = {
  snap: Snapshot | null
  generators: GeneratorsSnapshot | null
  grid: GridSnapshot | null
}

export function NSWDeepDive({ snap, generators, grid }: Props) {
  const { t } = useT()
  const [hoverIC, setHoverIC] = useState<{ ic: Interconnector; x: number; y: number } | null>(null)
  const [hoverStation, setHoverStation] = useState<{ s: Station; x: number; y: number } | null>(null)

  // ---- Pan + zoom state --------------------------------------------------
  // ZoomableGroup is a controlled component — it fires onMoveEnd with the
  // new {coordinates, zoom} and we push back via these state hooks so the
  // dot/line scaling stays in sync with the visible scale.
  const [mapPos, setMapPos] = useState<{ coordinates: [number, number]; zoom: number }>({
    coordinates: DEFAULT_CENTER, zoom: DEFAULT_ZOOM,
  })
  // Inverse scale so generator dots + IC line widths don't grow linearly
  // with zoom (Google-Maps-style: markers grow some but not 1:1). √zoom
  // keeps things readable across the full 1–6× zoom range.
  const visualScale = 1 / Math.sqrt(mapPos.zoom)
  const setZoom = (z: number) => setMapPos((p) => ({
    ...p, zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z)),
  }))
  const resetView = () => setMapPos({ coordinates: DEFAULT_CENTER, zoom: DEFAULT_ZOOM })

  // ---- Paper-trading state -----------------------------------------------
  const [paperState, setPaperState] = useState<BessState | null>(null)
  const [paperBids, setPaperBids] = useState<Bid[]>([])
  const [paperFills, setPaperFills] = useState<Fill[]>([])
  const [paperLoading, setPaperLoading] = useState(true)
  const [bidFormOpen, setBidFormOpen] = useState(false)

  const refreshPaper = async () => {
    try {
      const [s, b, f] = await Promise.all([
        fetchPaperState(DEFAULT_BESS_DUID),
        fetchPaperBids(DEFAULT_BESS_DUID, 50),
        fetchPaperFills(DEFAULT_BESS_DUID, 50),
      ])
      setPaperState(s)
      setPaperBids(b.bids)
      setPaperFills(f.fills)
    } catch (e) {
      console.warn('paper refresh failed', e)
    } finally {
      setPaperLoading(false)
    }
  }

  // Initial load + refresh whenever the snapshot ticks (settlement runs after
  // every NEM tick, so a new snapshot means our SoC/P&L may have moved).
  useEffect(() => { refreshPaper() }, [snap?.generated_at])

  const handleReset = async () => {
    if (!confirm(t('pos.resetConfirm'))) return
    await resetPaperState(DEFAULT_BESS_DUID)
    refreshPaper()
  }

  // NSW snapshot
  const nsw: RegionSnapshot | null = useMemo(
    () => snap?.nem.find((r) => r.regionid === FOCUS_REGION) ?? null,
    [snap],
  )

  // NSW-only stations (everything else is hidden on this view).
  const nswStations = useMemo(
    () => generators?.stations.filter((s) => s.region === FOCUS_REGION) ?? [],
    [generators],
  )

  // Find the headline BESS (WTAHB1 — Waratah Super Battery — by default).
  // inside any station's units (a station can have multiple DUIDs).
  const headlineBess = useMemo(() => {
    if (!generators) return null
    for (const s of generators.stations) {
      if (s.region !== FOCUS_REGION || s.fuel !== 'battery') continue
      const u = s.units.find((u) => u.duid === DEFAULT_BESS_DUID)
      if (u) return { station: s, unit: u }
    }
    // Fall back to any NSW battery if WTAHB1 not found.
    const any = nswStations.find((s) => s.fuel === 'battery')
    if (any && any.units[0]) return { station: any, unit: any.units[0] }
    return null
  }, [generators, nswStations])

  // Fuel mix MW totals for NSW (from current SCADA roll-up).
  const fuelTotals = useMemo(() => {
    const m = new Map<Fuel, number>()
    for (const s of nswStations) {
      m.set(s.fuel, (m.get(s.fuel) ?? 0) + Math.max(0, s.mw))
    }
    return m
  }, [nswStations])
  const totalGenMW = Array.from(fuelTotals.values()).reduce((a, b) => a + b, 0)

  // NSW-touching ICs: any IC where region_from or region_to is NSW1.
  const nswICs = useMemo(
    () => grid?.interconnectors.filter(
      (ic) => ic.region_from === FOCUS_REGION || ic.region_to === FOCUS_REGION,
    ) ?? [],
    [grid],
  )

  // Compute net IC inflow for NSW (positive = importing, negative = exporting).
  // For each IC, if NSW is region_to and flow > 0, it's an inflow. If NSW is
  // region_from and flow > 0, it's outflow. flow_mw < 0 reverses both.
  const netInflowMW = useMemo(() => {
    let sum = 0
    for (const ic of nswICs) {
      const f = ic.flow_mw ?? 0
      if (ic.region_to === FOCUS_REGION) sum += f          // nominal flow lands in NSW
      else if (ic.region_from === FOCUS_REGION) sum -= f   // nominal flow leaves NSW
    }
    return sum
  }, [nswICs])

  // Project IC line endpoints + Bézier control + arrow head. Same idea as
  // the all-NEM map but rendered in this view's projection.
  const icPaths = useMemo(() => {
    return nswICs.map((ic, idx) => {
      const a = projection(ic.from)
      const b = projection(ic.to)
      if (!a || !b) return null
      const flow = ic.flow_mw ?? 0
      const reverse = flow < 0
      const start = reverse ? b : a
      const end = reverse ? a : b
      const dx = end[0] - start[0], dy = end[1] - start[1]
      const len = Math.hypot(dx, dy) || 1
      const ux = dx / len, uy = dy / len
      const nx = -uy, ny = ux
      const sign = idx % 2 === 0 ? 1 : -1
      const bow = Math.min(40, len * 0.13) * sign
      const cx = (start[0] + end[0]) / 2 + nx * bow
      const cy = (start[1] + end[1]) / 2 + ny * bow
      const path = `M ${start[0]} ${start[1]} Q ${cx} ${cy} ${end[0]} ${end[1]}`
      const mx = 0.25 * start[0] + 0.5 * cx + 0.25 * end[0]
      const my = 0.25 * start[1] + 0.5 * cy + 0.25 * end[1]
      const tx = end[0] - start[0], ty = end[1] - start[1]
      const tlen = Math.hypot(tx, ty) || 1
      const tux = tx / tlen, tuy = ty / tlen
      const tnx = -tuy, tny = tux
      const sz = 6
      const tip   = [mx + tux * sz, my + tuy * sz]
      const baseL = [mx - tux * sz * 0.6 + tnx * sz * 0.7, my - tuy * sz * 0.6 + tny * sz * 0.7]
      const baseR = [mx - tux * sz * 0.6 - tnx * sz * 0.7, my - tuy * sz * 0.6 - tny * sz * 0.7]
      return {
        ic, path, stroke: utilStyle(ic.utilisation),
        startX: start[0], startY: start[1], endX: end[0], endY: end[1],
        arrow: `${tip[0]},${tip[1]} ${baseL[0]},${baseL[1]} ${baseR[0]},${baseR[1]}`,
      }
    }).filter(Boolean) as Array<{
      ic: Interconnector; path: string
      stroke: { color: string; width: number; opacity: number }
      startX: number; startY: number; endX: number; endY: number
      arrow: string
    }>
  }, [nswICs])

  // Sort station dots so big ones render below small ones (small remain hoverable).
  const stationDots = useMemo(() => {
    return nswStations.map((s) => {
      const p = projection([s.lon, s.lat])
      if (!p) return null
      const r = radiusFromCapacity(s.capacity_mw)
      const cap = s.capacity_mw || 1
      const util = Math.max(0, Math.min(1.2, Math.abs(s.mw) / cap))
      return { s, x: p[0], y: p[1], r, util }
    }).filter(Boolean) as Array<{ s: Station; x: number; y: number; r: number; util: number }>
  }, [nswStations])
  const stationDotsSorted = useMemo(
    () => [...stationDots].sort((a, b) => b.r - a.r),
    [stationDots],
  )

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-6">
      {/* ============================ MAP ============================ */}
      <section className="bg-surface rounded-xl2 p-6 shadow-card">
        <div className="flex items-baseline justify-between mb-3">
          <div>
            <div className="text-[17px] font-semibold tracking-tight text-ink">
              {t('nsw.mapTitle')}
            </div>
            <div className="text-[12px] text-muted mt-1">
              {t('nsw.mapHint')}
            </div>
          </div>
          {snap?.generated_at && (
            <div className="text-[11px] text-muted tabular-nums">
              {new Date(snap.generated_at).toLocaleTimeString('en-AU', { hour12: false })}
            </div>
          )}
        </div>

        <div className="relative">
          <ComposableMap
            projection={projection as any}
            width={VIEW_W}
            height={VIEW_H}
            style={{ width: '100%', height: 'auto', display: 'block',
              // Warm ivory "table" background — NOT gray. Cream tone keeps
              // the feel minimal but gives the white NSW silhouette something
              // to pop against. (#fbf7ef is roughly paper-cream.)
              background: '#fbf7ef',
              borderRadius: 8,
              cursor: mapPos.zoom > 1 ? 'grab' : 'default' }}
          >
            <defs>
              {/* Halo glow for big generators (≥500 MW) */}
              <filter id="nsw-major-glow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur in="SourceGraphic" stdDeviation="2.4" result="b" />
                <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
              {/* Pulse aura for active BESS */}
              <filter id="nsw-pulse" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur in="SourceGraphic" stdDeviation="1.8" />
              </filter>
              {/* PROMINENT drop shadow for the NSW "paper card" — wider and
                  darker than before so NSW literally lifts off the cream
                  background like a postcard on a desk. */}
              <filter id="nsw-card-shadow" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur in="SourceAlpha" stdDeviation="3.5" />
                <feOffset dx="0" dy="3" result="b" />
                <feComponentTransfer><feFuncA type="linear" slope="0.28" /></feComponentTransfer>
                <feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
            </defs>

            <ZoomableGroup
              center={mapPos.coordinates}
              zoom={mapPos.zoom}
              minZoom={MIN_ZOOM}
              maxZoom={MAX_ZOOM}
              onMoveEnd={({ coordinates, zoom }) =>
                setMapPos({ coordinates: coordinates as [number, number], zoom })
              }
            >
            {/* Geographies: NSW prominent, neighbours filled for orientation. */}
            <Geographies geography="/aus-states.geojson">
              {({ geographies }) =>
                geographies.map((geo) => {
                  const name = geo.properties.STATE_NAME as string
                  // "Paper card on a table" metaphor — NO GREYS anywhere.
                  // First pass paints NSW as a pure-white card with a sharp
                  // dark border + drop shadow. Neighbours get NO fill
                  // (transparent) here — they're drawn as faint dashed
                  // outlines in the second pass so they're present for
                  // orientation but visually invisible next to NSW.
                  if (name === FOCUS_STATE_NAME) {
                    return (
                      <Geography
                        key={geo.rsmKey} geography={geo}
                        filter="url(#nsw-card-shadow)"
                        style={{
                          default: {
                            fill: '#ffffff',
                            stroke: '#1d1d1f',
                            strokeWidth: 2.2,
                            strokeLinejoin: 'round',
                            outline: 'none',
                            vectorEffect: 'non-scaling-stroke',
                          } as any,
                          hover:   { fill: '#ffffff', stroke: '#1d1d1f',
                            strokeWidth: 2.2, outline: 'none',
                            vectorEffect: 'non-scaling-stroke' } as any,
                          pressed: { fill: '#ffffff', stroke: '#1d1d1f',
                            strokeWidth: 2.2, outline: 'none',
                            vectorEffect: 'non-scaling-stroke' } as any,
                        }}
                      />
                    )
                  }
                  return null  // neighbours rendered in the dashed pass below
                  return null  // hide WA / NT / TAS — out of frame anyway
                })
              }
            </Geographies>

            {/* Second pass — neighbour state silhouettes as faint dashed
                outlines (no fill). They're present so the user can tell
                where QLD/VIC/SA are on the map, but visually they recede
                so NSW reads as THE subject. Dashed warm-tone lines pick
                up the cream background rather than fight with it. */}
            <Geographies geography="/aus-states.geojson">
              {({ geographies }) =>
                geographies.filter((g) => NEIGHBOURS.has(g.properties.STATE_NAME as string))
                  .map((geo) => (
                    <Geography
                      key={`neighbour-${geo.rsmKey}`} geography={geo}
                      style={{
                        default: { fill: 'none', stroke: '#c8bfae',
                          strokeWidth: 1, strokeDasharray: '4 4',
                          strokeLinejoin: 'round', outline: 'none',
                          pointerEvents: 'none',
                          vectorEffect: 'non-scaling-stroke' } as any,
                        hover:   { fill: 'none', stroke: '#c8bfae',
                          strokeWidth: 1, strokeDasharray: '4 4',
                          outline: 'none',
                          vectorEffect: 'non-scaling-stroke' } as any,
                        pressed: { fill: 'none', stroke: '#c8bfae',
                          strokeWidth: 1, strokeDasharray: '4 4',
                          outline: 'none',
                          vectorEffect: 'non-scaling-stroke' } as any,
                      }}
                    />
                  ))
              }
            </Geographies>

            {/* Transmission network — REAL OSM data, ~4,700 line segments
                132/220/275/330/500 kV. Voltage encodes line weight and
                opacity so the eye picks out the 500/330 kV backbone first
                and the 132 kV subtransmission fills in the texture
                underneath. At zoom 1 we filter out 132 kV to keep the
                base view legible; user can zoom in to see more detail. */}
            <Geographies geography="/nsw-transmission.geojson">
              {({ geographies }) =>
                geographies
                  .filter((g) => {
                    const v = (g.properties.v as number) || 132
                    // Below 220 kV only shows from zoom 2× upward.
                    if (v < 220 && mapPos.zoom < 2) return false
                    return true
                  })
                  .map((geo) => {
                    const v = (geo.properties.v as number) || 132
                    const { sw, col, op } =
                      v >= 500 ? { sw: 1.6, col: '#1d4ed8', op: 0.85 }
                      : v >= 330 ? { sw: 1.2, col: '#2563eb', op: 0.75 }
                      : v >= 220 ? { sw: 0.85, col: '#3b82f6', op: 0.6 }
                      : { sw: 0.55, col: '#60a5fa', op: 0.42 }
                    return (
                      <Geography
                        key={geo.rsmKey} geography={geo}
                        style={{
                          default: {
                            fill: 'none', stroke: col, strokeWidth: sw,
                            strokeOpacity: op,
                            strokeLinecap: 'round', strokeLinejoin: 'round',
                            outline: 'none', pointerEvents: 'none',
                            vectorEffect: 'non-scaling-stroke',
                          } as any,
                          hover:   { fill: 'none', stroke: col, strokeWidth: sw,
                            strokeOpacity: op, outline: 'none',
                            vectorEffect: 'non-scaling-stroke' } as any,
                          pressed: { fill: 'none', stroke: col, strokeWidth: sw,
                            strokeOpacity: op, outline: 'none',
                            vectorEffect: 'non-scaling-stroke' } as any,
                        }}
                      />
                    )
                  })
              }
            </Geographies>

            {/* Substations — the network "nodes" that anchor the lines.
                ~380 sites across NSW, sized by max voltage they handle.
                Drawn as small open squares so they read as "infrastructure"
                without competing with the generator shape pack. */}
            <Geographies geography="/nsw-substations.geojson">
              {({ geographies }) =>
                geographies
                  .filter((g) => {
                    const v = (g.properties.v as number) || 132
                    // Same tiered visibility as lines — 132kV only at zoom ≥2.
                    if (v < 220 && mapPos.zoom < 2) return false
                    return true
                  })
                  .map((geo) => {
                    const [lon, lat] = geo.geometry.coordinates as [number, number]
                    const p = projection([lon, lat])
                    if (!p) return null
                    const v = (geo.properties.v as number) || 132
                    const r = (v >= 500 ? 3.0 : v >= 330 ? 2.4 : v >= 220 ? 1.9 : 1.4) * visualScale
                    const col = v >= 500 ? '#1d4ed8' : v >= 330 ? '#2563eb' : '#3b82f6'
                    return (
                      <g key={geo.rsmKey} transform={`translate(${p[0]},${p[1]})`}
                         pointerEvents="none">
                        <rect x={-r} y={-r} width={r * 2} height={r * 2}
                              fill="#ffffff" stroke={col}
                              strokeWidth={1.1}
                              strokeOpacity={0.85}
                              vectorEffect="non-scaling-stroke" />
                      </g>
                    )
                  })
              }
            </Geographies>

            {/* Neighbour state labels — anchored on rough centroids so the
                user can tell which blob is QLD vs VIC vs SA at a glance. */}
            {Object.entries(NEIGHBOUR_LABEL_COORDS).map(([name, coord]) => {
              const p = projection(coord)
              if (!p) return null
              const short =
                name === 'Queensland' ? 'QLD'
                : name === 'Victoria' ? 'VIC'
                : name === 'South Australia' ? 'SA'
                : 'ACT'
              return (
                <text
                  key={name}
                  x={p[0]} y={p[1]}
                  textAnchor="middle" dominantBaseline="middle"
                  fontSize={14 * visualScale} fontWeight={700}
                  fill="#8b8b92" letterSpacing="0.08em"
                  pointerEvents="none"
                >
                  {short}
                </text>
              )
            })}

            {/* IC paths — line widths inverse-scale with zoom so they stay
                legible at high zoom without becoming horse-arteries at 1×. */}
            <g>
              {icPaths.map((l) => {
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
                  <circle cx={l.startX} cy={l.startY} r={2.4 * visualScale}
                          fill={l.stroke.color} fillOpacity={l.stroke.opacity} />
                  <circle cx={l.endX}   cy={l.endY}   r={2.4 * visualScale}
                          fill={l.stroke.color} fillOpacity={l.stroke.opacity} />
                  <polygon points={l.arrow}
                           fill={l.stroke.color}
                           fillOpacity={Math.max(0.7, l.stroke.opacity)} />
                  <path d={l.path} fill="none" stroke="transparent" strokeWidth={16 * visualScale} />
                </g>
                )
              })}
            </g>

            {/* City landmarks — small grey dots + labels so users have
                spatial reference points. Pure landmarks, no data. */}
            <g pointerEvents="none">
              {NSW_CITIES.map((c) => {
                const p = projection(c.coord)
                if (!p) return null
                const r = (c.major ? 3.4 : 2.2) * visualScale
                return (
                  <g key={c.name}>
                    <circle cx={p[0]} cy={p[1]} r={r * 2.4}
                            fill="#1d1d1f" fillOpacity={0.04} />
                    <circle cx={p[0]} cy={p[1]} r={r}
                            fill="#5a5a62" fillOpacity={0.55} />
                    <text x={p[0] + r + 3} y={p[1] + 1}
                          fontSize={(c.major ? 11 : 9.5) * visualScale}
                          fontWeight={c.major ? 600 : 500}
                          fill="#5a5a62"
                          style={{ paintOrder: 'stroke',
                                   stroke: '#ffffff', strokeWidth: 3 * visualScale }}>
                      {c.name}
                    </text>
                  </g>
                )
              })}
            </g>

            {/* Generators — shape-encoded by fuel (opengridworks-style):
                ● circles for thermal/wind, ■ squares for BESS, ◆ diamonds
                for solar, ▽ triangles for hydro. Large stations (≥500 MW
                cap) get a soft halo so the big movers pop. Radii inverse-
                scale with √zoom — they grow somewhat when zoomed in but
                don't overwhelm. */}
            <g>
              {generators && stationDotsSorted.map((d) => {
                const isBess = d.s.fuel === 'battery'
                const baseColor = generators.fuel_colors[d.s.fuel] ?? '#86868b'
                const rr = d.r * visualScale
                const shape = FUEL_SHAPE[d.s.fuel] ?? circlePath
                const isMajor = d.s.capacity_mw >= 500
                const onMove = (e: any) =>
                  setHoverStation({ s: d.s, x: e.clientX, y: e.clientY })
                const onLeave = () => setHoverStation(null)

                if (isBess) {
                  const state = classifyBess(d.s.mw, d.s.capacity_mw)
                  const stateCol = BESS_STATE_COLOR[state]
                  const haloR = Math.max(rr + 2 * visualScale,
                                          rr * (1 + Math.min(1, d.util)))
                  return (
                    <g key={`${d.s.station}-${d.s.region}`}
                       transform={`translate(${d.x},${d.y})`}
                       onMouseMove={onMove} onMouseLeave={onLeave}
                       style={{ cursor: 'help' }}>
                      {(state === 'charging' || state === 'discharging') && (
                        <circle r={haloR + 4 * visualScale}
                                fill={stateCol} fillOpacity={0.10}
                                filter="url(#nsw-pulse)">
                          <animate attributeName="r"
                                   values={`${haloR + 2 * visualScale};${haloR + 8 * visualScale};${haloR + 2 * visualScale}`}
                                   dur="2.4s" repeatCount="indefinite" />
                          <animate attributeName="fill-opacity"
                                   values="0.22;0.05;0.22"
                                   dur="2.4s" repeatCount="indefinite" />
                        </circle>
                      )}
                      {/* Outer square frame */}
                      <path d={squarePath(rr + 1.5 * visualScale)}
                            fill="#ffffff" stroke={stateCol}
                            strokeWidth={1.6} strokeOpacity={0.95}
                            vectorEffect="non-scaling-stroke" />
                      {/* Inner fill scaled by output */}
                      <path d={squarePath(Math.max(1.2 * visualScale,
                                                    rr * Math.sqrt(d.util)))}
                            fill={stateCol} fillOpacity={0.92} />
                      {state === 'discharging' && (
                        <text y={-rr - 5 * visualScale} textAnchor="middle"
                              fontSize={11 * visualScale} fontWeight={700} fill={stateCol}
                              style={{ paintOrder: 'stroke', stroke: '#fff',
                                       strokeWidth: 3 * visualScale }}>↑</text>
                      )}
                      {state === 'charging' && (
                        <text y={rr + 11 * visualScale} textAnchor="middle"
                              fontSize={11 * visualScale} fontWeight={700} fill={stateCol}
                              style={{ paintOrder: 'stroke', stroke: '#fff',
                                       strokeWidth: 3 * visualScale }}>↓</text>
                      )}
                    </g>
                  )
                }

                // Non-BESS generators: shape by fuel, glow only for majors.
                const haloR = Math.max(1 * visualScale, rr * Math.sqrt(d.util))
                return (
                  <g key={`${d.s.station}-${d.s.region}`}
                     transform={`translate(${d.x},${d.y})`}
                     onMouseMove={onMove} onMouseLeave={onLeave}
                     style={{ cursor: 'help' }}
                     filter={isMajor ? 'url(#nsw-major-glow)' : undefined}>
                    <path d={shape(rr)}
                          fill="#ffffff" fillOpacity={0.96}
                          stroke={baseColor} strokeOpacity={0.85}
                          strokeWidth={isMajor ? 1.5 : 1}
                          vectorEffect="non-scaling-stroke" />
                    <path d={shape(haloR)}
                          fill={baseColor} fillOpacity={0.9} />
                  </g>
                )
              })}
            </g>

            {/* "NEW SOUTH WALES" headline — two-line minimal label sitting
                in the empty inland area, opengridworks-style. Letter-spaced
                wide so it reads as a map title, not a generator name. */}
            {(() => {
              const p = projection([146.5, -32.5])
              if (!p) return null
              return (
                <g pointerEvents="none" textAnchor="middle">
                  <text x={p[0]} y={p[1]} fontSize={11}
                        fontWeight={700} fill="#1d1d1f" fillOpacity={0.55}
                        style={{ letterSpacing: '0.32em' }}>
                    NEW SOUTH
                  </text>
                  <text x={p[0]} y={p[1] + 16} fontSize={11}
                        fontWeight={700} fill="#1d1d1f" fillOpacity={0.55}
                        style={{ letterSpacing: '0.32em' }}>
                    WALES
                  </text>
                </g>
              )
            })()}
            </ZoomableGroup>
          </ComposableMap>

          {/* Zoom controls — floating overlay top-right of the map. Apple-
              styled little plate of three buttons (+/−/reset). Sits on top
              of the SVG, doesn't interfere with map pan/zoom drag. */}
          <div className="absolute top-2 right-2 flex flex-col bg-white/95 backdrop-blur rounded-md shadow-card border border-hairlineSoft overflow-hidden text-[14px] select-none">
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
          </div>

          {/* Zoom level read-out — bottom-left, only when zoomed in */}
          {mapPos.zoom > 1.05 && (
            <div className="absolute bottom-2 left-2 px-2 py-1 rounded bg-white/95 border border-hairlineSoft text-[10px] text-muted tabular-nums shadow-sm">
              {mapPos.zoom.toFixed(1)}×
            </div>
          )}

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

          {/* Station tooltip */}
          {hoverStation && !hoverIC && (
            <div className="fixed z-50 pointer-events-none rounded-xl bg-white shadow-cardHover border border-hairlineSoft px-3.5 py-2.5 text-[12px]"
                 style={{ left: hoverStation.x + 14, top: hoverStation.y + 14, minWidth: 220 }}>
              <div className="font-semibold text-ink leading-tight">{hoverStation.s.station}</div>
              <div className="text-muted text-[11px] mt-0.5">
                {hoverStation.s.region.replace(/1$/, '')} · {tFuel(t, hoverStation.s.fuel)}
                {hoverStation.s.fuel === 'battery' && (
                  <span className="ml-2 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded"
                        style={{ background: BESS_STATE_COLOR[classifyBess(hoverStation.s.mw, hoverStation.s.capacity_mw)] + '22',
                                 color: BESS_STATE_COLOR[classifyBess(hoverStation.s.mw, hoverStation.s.capacity_mw)] }}>
                    {tBess(t, classifyBess(hoverStation.s.mw, hoverStation.s.capacity_mw))}
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
        </div>

        {/* Compact legend — only shows fuels actually present in current
            NSW data, with a count badge so users can tell at a glance how
            many dots of each shape they should be looking for on the map
            (e.g. "Hydro 5" → there are 5 ▽ markers somewhere in NSW). */}
        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] text-muted">
          {generators && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-ink2 font-semibold mr-1">{t('map.fuel')}</span>
              {(['coal_black','coal_brown','gas','hydro','wind','solar','battery','bioenergy'] as Fuel[])
                .filter((fuel) => (fuelTotals.get(fuel) ?? 0) > 0
                                || nswStations.some((s) => s.fuel === fuel))
                .map((fuel) => {
                  const color = generators.fuel_colors[fuel] ?? '#86868b'
                  const shape = FUEL_SHAPE[fuel]
                  const count = nswStations.filter((s) => s.fuel === fuel).length
                  return (
                    <span key={fuel} className="flex items-center gap-1.5">
                      <svg width={12} height={12} viewBox="-6 -6 12 12">
                        <path d={shape(4.5)} fill={color} fillOpacity={0.9} />
                      </svg>
                      <span className="text-ink2">{tFuel(t, fuel)}</span>
                      <span className="tabular-nums text-muted text-[10px]">{count}</span>
                    </span>
                  )
                })}
            </div>
          )}
          <span className="h-3 w-px bg-hairlineSoft" />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-ink2 font-semibold mr-1">{t('map.bess')}</span>
            <span className="flex items-center gap-1.5">
              <svg width={12} height={12} viewBox="-6 -6 12 12">
                <path d={squarePath(4.5)} fill="#34c759" fillOpacity={0.85} />
              </svg>
              {t('bess.charging')}
            </span>
            <span className="flex items-center gap-1.5">
              <svg width={12} height={12} viewBox="-6 -6 12 12">
                <path d={squarePath(4.5)} fill="#ff9500" fillOpacity={0.85} />
              </svg>
              {t('bess.discharging')}
            </span>
            <span className="flex items-center gap-1.5">
              <svg width={12} height={12} viewBox="-6 -6 12 12">
                <path d={squarePath(4.5)} fill="#ffffff" stroke="#86868b" strokeWidth={1} />
              </svg>
              {t('bess.idle')}
            </span>
          </div>
          <span className="h-3 w-px bg-hairlineSoft" />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-ink2 font-semibold mr-1">{t('map.transmission')}</span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-5 h-[2px]" style={{ background: '#1d4ed8', opacity: 0.85 }} />
              500 kV
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-5 h-[1.6px]" style={{ background: '#2563eb', opacity: 0.75 }} />
              330 kV
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-5 h-[1.2px]" style={{ background: '#3b82f6', opacity: 0.6 }} />
              220 kV
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-5 h-[0.8px]" style={{ background: '#60a5fa', opacity: 0.5 }} />
              132 kV
              <span className="text-[10px] text-muted ml-1">({t('map.zoomToSee')})</span>
            </span>
            <span className="flex items-center gap-1.5 ml-1">
              <span className="inline-block w-3 h-3 border" style={{ borderColor: '#2563eb', background: '#fff' }} />
              {t('map.substation')}
            </span>
          </div>
        </div>

        {/* Live fuel mix — fills the empty space below the legend with a
            "此消彼长" stacked area + live snapshot bar. Polls the new
            /api/grid/generators/history endpoint every 60s; each band's
            polygon path transitions smoothly between updates so the chart
            breathes rather than snaps. */}
        <div className="mt-6 pt-5 border-t border-hairlineSoft">
          <div className="mb-3">
            <div className="text-[14px] font-semibold tracking-tight text-ink">
              {t('fuelmix.title')}
            </div>
            <div className="text-[11px] text-muted mt-0.5">
              {t('fuelmix.hint')}
            </div>
          </div>
          <FuelMixLive region={FOCUS_REGION} hours={6} />
        </div>
      </section>

      {/* ============================ SIDEBAR ============================ */}
      {/* space-y-5 (20px) instead of -y-4 so the 5 cards stretch to match
          the height of the map+tanks column on the left. */}
      <aside className="space-y-5">
        <PriceCard nsw={nsw} />
        <SupplyDemandCard nsw={nsw} totalGenMW={totalGenMW} netInflowMW={netInflowMW} />
        <FuelMixCard fuelTotals={fuelTotals} totalGenMW={totalGenMW} fuelColors={generators?.fuel_colors} />
        <BessCard headline={headlineBess} />
        <PositionCard
          state={paperState}
          loading={paperLoading}
          onTrade={() => setBidFormOpen(true)}
          onReset={handleReset}
        />
      </aside>

      {/* ============================ BESS DISPATCH (full width) ============= */}
      <div className="lg:col-span-2">
        <BESSDispatchPanel duid={DEFAULT_BESS_DUID} region={FOCUS_REGION} />
      </div>

      {/* ============================ BESS LEADERBOARD (full width) ========== */}
      {/* Real per-DUID arbitrage league table — context for how the paper
          account's strategy stacks up against actual operators. */}
      <section className="lg:col-span-2 bg-surface rounded-xl2 p-6 shadow-card">
        <BESSLeaderboard defaultRegion={FOCUS_REGION} />
      </section>

      {/* ============================ MARKET TIMELINE (full width) =========== */}
      {/* Sits directly above Suggested bids so the user has the lifecycle
          context — "what stage is the next interval in?" — right next to
          where they’re choosing which proposals to submit. WTAHB1 is the
          paper-trading DUID so the "Your DUID" overlay tracks the same
          unit the bid sheet acts on. */}
      <section className="lg:col-span-2 bg-surface rounded-xl2 p-6 shadow-card">
        <div className="mb-4">
          <div className="text-[17px] font-semibold tracking-tight text-ink">
            {t('sec.timeline')}
          </div>
          <div className="text-[12px] text-muted mt-1">
            {t('sec.timelineHint')}
          </div>
        </div>
        <MarketTimeline duid="WTAHB1" />
      </section>

      {/* ============================ SUGGESTED BIDS (full width) ============= */}
      {/* Sits above the ledger: users see the AEMO-forecast-driven proposals
          first, action what they like, then the result lands in the ledger. */}
      <div className="lg:col-span-2">
        <SuggestedBids
          paperState={paperState}
          existingBids={paperBids}
          refreshKey={snap?.generated_at}
          onSubmitted={refreshPaper}
        />
      </div>

      {/* ============================ ANALYTICS (full width) ================== */}
      <div className="lg:col-span-2">
        <div className="rounded-2xl border border-border bg-surface p-4">
          <h3 className="text-[13px] font-semibold text-ink mb-3">{t('pa.title')}</h3>
          <PaperAnalyticsPanel duid={DEFAULT_BESS_DUID} refreshKey={snap?.generated_at} />
        </div>
      </div>

      {/* ============================ LEDGER (full width) ===================== */}
      <div className="lg:col-span-2">
        <BidLedger bids={paperBids} fills={paperFills} onChanged={refreshPaper} />
      </div>

      {/* ============================ BID MODAL ============================== */}
      {bidFormOpen && paperState && (
        <BidForm
          duid={paperState.duid}
          powerMw={paperState.power_mw}
          onSubmitted={refreshPaper}
          onClose={() => setBidFormOpen(false)}
        />
      )}
    </div>
  )
}

// ============================ SIDEBAR CARDS ===============================

function PriceCard({ nsw }: { nsw: RegionSnapshot | null }) {
  const { t } = useT()
  const rrp = nsw?.rrp ?? null
  const prior = nsw?.rrp_1h_ago ?? null
  const delta = rrp !== null && prior !== null ? rrp - prior : null
  const deltaPct = rrp !== null && prior !== null && prior !== 0
    ? ((rrp - prior) / Math.abs(prior)) * 100 : null
  const next = nsw?.next_forecast
  const raisereg = nsw?.fcas?.raisereg ?? null
  const r6 = nsw?.fcas?.raise6sec ?? null
  return (
    // Hero-sized price card. Big number + delta + forecast + 2 FCAS prices
    // so this single card fills the visual weight of the section while the
    // map column also has weight from the map + tanks below it. Both
    // columns now bottom-align without ad-hoc spacers.
    <div className="bg-surface rounded-xl2 p-6 shadow-card">
      <div className="flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-[0.22em] text-muted">
          {t('nsw.spotPrice')}
        </div>
        {nsw?.settlementdate && (
          <div className="text-[10px] text-muted tabular-nums">
            {new Date(nsw.settlementdate).toLocaleString('en-AU', {
              day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
            })}
          </div>
        )}
      </div>

      {/* Headline price — huge */}
      <div className="mt-3 flex items-baseline gap-2">
        <span className="text-[64px] font-semibold text-ink tabular-nums leading-[0.9] tracking-tight">
          {rrp !== null ? `$${rrp.toFixed(0)}` : '—'}
        </span>
        <span className="text-[14px] text-muted">/MWh</span>
      </div>

      {delta !== null && (
        <div className={`mt-2 text-[14px] tabular-nums font-medium ${
          delta > 0 ? 'text-negative' : delta < 0 ? 'text-positive' : 'text-muted'
        }`}>
          {delta >= 0 ? '↑' : '↓'} ${Math.abs(delta).toFixed(0)}
          {deltaPct !== null && (
            <span className="ml-1 text-muted">({Math.abs(deltaPct).toFixed(0)}%)</span>
          )}
          <span className="text-muted ml-1.5 text-[12px]">{t('nsw.vsLastHour')}</span>
        </div>
      )}

      {/* Next-interval forecast strip */}
      {next && next.rrp !== null && (
        <div className="mt-4 pt-4 border-t border-hairlineSoft flex items-baseline justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] text-muted">
              {t('price.nextForecast')}
            </div>
            <div className="text-[11px] text-ink2 mt-0.5 tabular-nums">
              {next.interval_datetime
                ? new Date(next.interval_datetime).toLocaleTimeString('en-AU', {
                    hour: '2-digit', minute: '2-digit',
                  })
                : '—'}
              <span className="ml-1.5 text-muted">· {next.source}</span>
            </div>
          </div>
          <div className="text-right">
            <div className="text-[28px] font-semibold text-ink tabular-nums leading-none">
              ${next.rrp.toFixed(0)}
            </div>
            {rrp !== null && next.rrp !== null && (
              <div className="text-[11px] mt-1 tabular-nums">
                <span className={
                  next.rrp - rrp > 0 ? 'text-negative'
                  : next.rrp - rrp < 0 ? 'text-positive' : 'text-muted'
                }>
                  {next.rrp - rrp >= 0 ? '↑' : '↓'} ${Math.abs(next.rrp - rrp).toFixed(0)}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* FCAS preview — two most-watched FCAS markets */}
      {(raisereg !== null || r6 !== null) && (
        <div className="mt-4 pt-4 border-t border-hairlineSoft">
          <div className="text-[10px] uppercase tracking-[0.2em] text-muted mb-2">
            {t('price.fcasNow')}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-[10px] text-muted">RAISEREG</div>
              <div className="text-[20px] font-semibold text-ink tabular-nums leading-none mt-0.5">
                ${raisereg !== null ? raisereg.toFixed(2) : '—'}
              </div>
              <div className="text-[10px] text-muted mt-0.5">$/MW/h</div>
            </div>
            <div>
              <div className="text-[10px] text-muted">RAISE6SEC</div>
              <div className="text-[20px] font-semibold text-ink tabular-nums leading-none mt-0.5">
                ${r6 !== null ? r6.toFixed(2) : '—'}
              </div>
              <div className="text-[10px] text-muted mt-0.5">$/MW/h</div>
            </div>
          </div>
        </div>
      )}

      {/* Demand context — fills the bottom and explains the price */}
      {(nsw?.totaldemand || nsw?.availablegeneration) && (
        <div className="mt-4 pt-4 border-t border-hairlineSoft grid grid-cols-2 gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] text-muted">
              {t('price.demand')}
            </div>
            <div className="text-[18px] font-semibold text-ink tabular-nums leading-none mt-1">
              {nsw.totaldemand !== null
                ? (nsw.totaldemand / 1000).toFixed(2)
                : '—'}
              <span className="text-[12px] text-muted ml-1 font-normal">GW</span>
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] text-muted">
              {t('price.reserve')}
            </div>
            <div className="text-[18px] font-semibold text-ink tabular-nums leading-none mt-1">
              {nsw.availablegeneration !== null && nsw.totaldemand !== null
                ? ((nsw.availablegeneration - nsw.totaldemand) / 1000).toFixed(2)
                : '—'}
              <span className="text-[12px] text-muted ml-1 font-normal">GW</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function SupplyDemandCard({
  nsw, totalGenMW, netInflowMW,
}: { nsw: RegionSnapshot | null; totalGenMW: number; netInflowMW: number }) {
  const { t } = useT()
  const demand = nsw?.totaldemand ?? null
  const local = totalGenMW
  const supplied = local + netInflowMW
  const balance = demand !== null ? supplied - demand : null

  return (
    <div className="bg-surface rounded-xl2 p-5 shadow-card">
      <div className="text-[11px] uppercase tracking-wider text-muted">{t('nsw.supplyDemand')}</div>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-3 text-[12px]">
        <div>
          <div className="text-muted text-[10px] uppercase tracking-wider">{t('nsw.demand')}</div>
          <div className="text-ink font-medium tabular-nums text-[18px]">{fmtMW(demand)}</div>
        </div>
        <div>
          <div className="text-muted text-[10px] uppercase tracking-wider">{t('nsw.localGen')}</div>
          <div className="text-ink font-medium tabular-nums text-[18px]">{fmtMW(local)}</div>
        </div>
        <div>
          <div className="text-muted text-[10px] uppercase tracking-wider">{t('nsw.netIcInflow')}</div>
          <div className={`font-medium tabular-nums text-[18px] ${
            netInflowMW > 0 ? 'text-accentInk' : netInflowMW < 0 ? 'text-positive' : 'text-ink'
          }`}>
            {fmtMW(netInflowMW, true)}
          </div>
        </div>
        <div>
          <div className="text-muted text-[10px] uppercase tracking-wider">{t('nsw.balance')}</div>
          <div className={`font-medium tabular-nums text-[18px] ${
            balance === null ? 'text-muted'
              : balance >= 0 ? 'text-positive' : 'text-negative'
          }`}>
            {balance === null ? '—' : fmtMW(balance, true)}
          </div>
        </div>
      </div>
      {/* Tiny bar: local gen vs net imports stacked, vs demand line */}
      {demand && demand > 0 && (
        <div className="mt-3">
          <div className="relative h-2 rounded-full bg-surfaceAlt overflow-hidden">
            <div className="absolute left-0 top-0 h-full bg-accent"
                 style={{ width: `${Math.min(100, (local / demand) * 100)}%` }} />
            {netInflowMW > 0 && (
              <div className="absolute top-0 h-full bg-positive"
                   style={{ left: `${(local / demand) * 100}%`,
                            width: `${Math.min(100 - (local / demand) * 100, (netInflowMW / demand) * 100)}%` }} />
            )}
            {/* Demand 100% line */}
            <div className="absolute top-0 h-full w-px bg-ink" style={{ left: '100%' }} />
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-muted tabular-nums">
            <span>0 MW</span>
            <span>{fmtMW(demand)} {t('nsw.demandSuffix')}</span>
          </div>
        </div>
      )}
    </div>
  )
}

function FuelMixCard({
  fuelTotals, totalGenMW, fuelColors,
}: { fuelTotals: Map<Fuel, number>; totalGenMW: number; fuelColors?: Record<Fuel, string> }) {
  const { t } = useT()
  const ordered = FUEL_ORDER
    .map((f) => ({ fuel: f, mw: fuelTotals.get(f) ?? 0 }))
    .filter((x) => x.mw > 0)
  return (
    <div className="bg-surface rounded-xl2 p-5 shadow-card">
      <div className="flex items-baseline justify-between">
        <div className="text-[11px] uppercase tracking-wider text-muted">{t('nsw.fuelMix')}</div>
        <div className="text-[11px] text-muted tabular-nums">{fmtMW(totalGenMW)}</div>
      </div>
      {/* Stacked bar */}
      <div className="mt-3 h-3 rounded-full overflow-hidden flex bg-surfaceAlt">
        {ordered.map((x) => {
          const pct = totalGenMW > 0 ? (x.mw / totalGenMW) * 100 : 0
          return (
            <div key={x.fuel}
                 style={{ width: `${pct}%`, background: fuelColors?.[x.fuel] ?? '#86868b' }}
                 title={`${tFuel(t, x.fuel)} ${x.mw.toFixed(0)} MW (${pct.toFixed(0)}%)`} />
          )
        })}
      </div>
      {/* Per-fuel rows */}
      <div className="mt-3 space-y-1.5 text-[12px]">
        {ordered.map((x) => {
          const pct = totalGenMW > 0 ? (x.mw / totalGenMW) * 100 : 0
          return (
            <div key={x.fuel} className="flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full"
                    style={{ background: fuelColors?.[x.fuel] ?? '#86868b' }} />
              <span className="text-ink2 flex-1">{tFuel(t, x.fuel)}</span>
              <span className="text-ink tabular-nums font-medium">{x.mw.toFixed(0)} MW</span>
              <span className="text-muted tabular-nums w-10 text-right">{pct.toFixed(0)}%</span>
            </div>
          )
        })}
        {ordered.length === 0 && (
          <div className="text-muted text-[12px]">{t('nsw.noLiveGen')}</div>
        )}
      </div>
    </div>
  )
}

function BessCard({ headline }: { headline: { station: Station; unit: { duid: string; mw: number | null; capacity_mw: number } } | null }) {
  const { t } = useT()
  if (!headline) {
    return (
      <div className="bg-surface rounded-xl2 p-5 shadow-card">
        <div className="text-[11px] uppercase tracking-wider text-muted">{t('bess.watch')}</div>
        <div className="mt-2 text-[13px] text-muted">{t('bess.noNswBattery')}</div>
      </div>
    )
  }
  const { station, unit } = headline
  const mw = unit.mw
  const cap = unit.capacity_mw
  const state = classifyBess(mw, cap)
  const col = BESS_STATE_COLOR[state]
  return (
    <div className="bg-surface rounded-xl2 p-5 shadow-card">
      <div className="flex items-baseline justify-between">
        <div className="text-[11px] uppercase tracking-wider text-muted">{t('bess.watch')}</div>
        <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded font-medium"
              style={{ background: col + '22', color: col }}>
          {tBess(t, state)}
        </span>
      </div>
      <div className="mt-2 text-[15px] font-semibold text-ink leading-tight">{station.station}</div>
      <div className="text-[11px] text-muted">{unit.duid} · {cap} {t('bess.nameplate')}</div>

      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-[12px]">
        <div>
          <div className="text-muted text-[10px] uppercase tracking-wider">{t('bess.power')}</div>
          <div className="font-semibold tabular-nums text-[22px]"
               style={{ color: state === 'idle' || state === 'unknown' ? '#1d1d1f' : col }}>
            {mw === null || mw === undefined ? '—' : `${mw >= 0 ? '+' : ''}${mw.toFixed(1)} MW`}
          </div>
        </div>
        <div>
          <div className="text-muted text-[10px] uppercase tracking-wider">{t('bess.utilisation')}</div>
          <div className="font-semibold tabular-nums text-[22px] text-ink">
            {mw === null || mw === undefined ? '—' : `${((Math.abs(mw) / cap) * 100).toFixed(0)}%`}
          </div>
        </div>
      </div>

      {/* Charge/discharge bar relative to nameplate (zero-centred) */}
      <div className="mt-4">
        <div className="relative h-2 rounded-full bg-surfaceAlt overflow-hidden">
          {/* Zero line in the middle */}
          <div className="absolute top-0 h-full w-px bg-hairline" style={{ left: '50%' }} />
          {mw !== null && mw !== undefined && (
            <div className="absolute top-0 h-full"
                 style={{
                   left: mw >= 0 ? '50%' : `${50 - Math.min(50, (Math.abs(mw) / cap) * 50)}%`,
                   width: `${Math.min(50, (Math.abs(mw) / cap) * 50)}%`,
                   background: col,
                 }} />
          )}
        </div>
        <div className="mt-1 flex justify-between text-[10px] text-muted tabular-nums">
          <span>{t('bess.chargeLeft', cap)}</span>
          <span>0</span>
          <span>{t('bess.dischargeRight', cap)}</span>
        </div>
      </div>

      <div className="mt-4 text-[11px] text-muted leading-relaxed">
        {t('bess.demoNote')}
      </div>
    </div>
  )
}
