/**
 * VPPCompetitorBids — "VPP X-Ray": Station-Explorer-style drill-down for
 * every real VPP / DER aggregator / WDR unit registered with AEMO.
 *
 * Left rail: searchable list (AGL, Simply, ShineHub, Energy Locals, EnelX
 * WDR fleet, VIOTAS, Boral, …). Main panel for the selected unit:
 *   · KPI strip — fleet max offered MW (7-day BIDPEROFFER peak, the real
 *     usable-capacity proxy; DUDETAIL registers these as 1 MW placeholders),
 *     markets count, dispatch side, latest bid day
 *   · Market overview table — every FCAS market it bids: direction,
 *     offered MW, price range
 *   · Bid ladder — band prices + per-interval availability with a
 *     scroll-window Brush (defaults to 6 h)
 *
 * Aggregated DER has no SCADA (non-scheduled) — bids ARE the public
 * footprint, disclosed by AEMO D+1.
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Bar, Brush, CartesianGrid, ComposedChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { useT } from '../i18n'

type CompetitorUnit = {
  duid: string
  station: string
  region: string
  dispatch_type: string | null
  schedule_type: string | null
  markets: string[]
  latest_bid_day: string | null
}

type MarketProfile = {
  bidtype: string
  direction: string | null
  latest_day: string | null
  submitted_at: string | null
  max_avail_mw: number | null
  price_min: number | null
  price_max: number | null
}

type CompetitorSummary = {
  duid: string
  station: string
  region: string
  dispatch_type: string | null
  schedule_type: string | null
  registered_capacity_mw: number | null
  fleet_max_avail_mw: number
  markets: MarketProfile[]
}

type BidsResponse = {
  duid: string; date: string; bidtype: string
  submitted_at: string | null
  prices: (number | null)[] | null
  intervals: { t: string; avail: (number | null)[]; maxavail: number | null }[]
}

const BAND_COLORS = [
  '#1f9d55', '#34c759', '#7ed321', '#c0d62b', '#ffd60a',
  '#ffb340', '#ff9500', '#ff6340', '#ff3b30', '#b91d1d',
]

/** RAISE services sit on the GEN side, LOWER on the LOAD side. */
function dirForMarket(market: string): 'GEN' | 'LOAD' {
  return market.toUpperCase().startsWith('LOWER') ? 'LOAD' : 'GEN'
}

export function VPPCompetitorBids() {
  const { t } = useT()
  const [units, setUnits] = useState<CompetitorUnit[]>([])
  const [regionF, setRegionF] = useState('')
  const [search, setSearch] = useState('')
  const [duid, setDuid] = useState('')
  const [summary, setSummary] = useState<CompetitorSummary | null>(null)
  const [market, setMarket] = useState('')
  const [bids, setBids] = useState<BidsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [brushWin, setBrushWin] = useState<{ s: number; e: number }>({ s: 0, e: 71 })

  // Unit list once; preselect the first named VPP for a friendly default.
  useEffect(() => {
    fetch('/api/vpp/competitors')
      .then((r) => r.json())
      .then((d) => {
        const us: CompetitorUnit[] = d.units ?? []
        setUnits(us)
        if (us.length) {
          const vpp = us.find((u) => u.station.toUpperCase().includes('VPP')) ?? us[0]
          setDuid(vpp.duid)
        }
      })
      .catch(() => {})
  }, [])

  // Summary per unit; keeps the market chip valid.
  useEffect(() => {
    if (!duid) return
    fetch(`/api/vpp/competitors/${duid}/summary`)
      .then((r) => r.json())
      .then((s: CompetitorSummary) => {
        setSummary('detail' in (s as object) ? null : s)
        const mkts = (s.markets ?? []).map((m) => m.bidtype)
        setMarket((prev) => (mkts.includes(prev) ? prev : mkts[0] ?? ''))
      })
      .catch(() => setSummary(null))
  }, [duid])

  // Bid ladder per (unit, market).
  useEffect(() => {
    if (!duid || !market) { setBids(null); return }
    setLoading(true)
    fetch(`/api/station/${duid}/bids?bidtype=${encodeURIComponent(market)}&direction=${dirForMarket(market)}`)
      .then((r) => r.json())
      .then(setBids)
      .catch(() => setBids(null))
      .finally(() => setLoading(false))
  }, [duid, market])

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase()
    return units.filter((u) =>
      (!regionF || u.region === regionF) &&
      (!q || u.duid.includes(q) || u.station.toUpperCase().includes(q)),
    )
  }, [units, regionF, search])

  const series = useMemo(() => {
    if (!bids?.intervals?.length) return []
    return bids.intervals.map((iv) => {
      const row: Record<string, number | string | null> = { hm: iv.t.slice(11, 16) }
      iv.avail.forEach((a, i) => { row[`b${i + 1}`] = a ?? 0 })
      return row
    })
  }, [bids])

  if (!units.length) return null

  return (
    <div>
      <div className="mb-4">
        <div className="text-[17px] font-semibold tracking-tight text-ink">{t('vppcb.title')}</div>
        <div className="text-[12px] text-muted mt-1">{t('vppcb.hint')}</div>
      </div>

      <div className="relative">
        {/* ── Left rail: aggregator picker — absolutely positioned so its
            height EQUALS the main panel (it can never stretch the row);
            the unit list scrolls inside ──────────────────────────────── */}
        <div className="absolute inset-y-0 left-0 w-[250px] flex flex-col">
          <div className="flex gap-2 mb-2">
            <select value={regionF} onChange={(e) => setRegionF(e.target.value)}
                    className="flex-1 text-[12px] px-2 py-1.5 rounded-lg border border-hairlineSoft bg-surface text-ink">
              <option value="">{t('stx.allRegions')}</option>
              {['NSW1', 'QLD1', 'VIC1', 'SA1', 'TAS1'].map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('vppcb.searchPh')}
            className="w-full text-[12px] px-3 py-2 mb-2 rounded-lg border border-hairlineSoft bg-surface
                       text-ink outline-none focus:border-accent transition-colors"
          />
          <div className="flex-1 min-h-0 overflow-y-auto -mx-1 px-1">
            {filtered.map((u) => (
              <button key={u.duid}
                      onClick={() => setDuid(u.duid)}
                      className={`w-full text-left px-2.5 py-2 rounded-lg mb-0.5 transition-colors ${
                        duid === u.duid ? 'bg-accent/10 border border-accent/40' : 'hover:bg-surfaceAlt border border-transparent'
                      }`}>
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-semibold text-ink font-mono truncate">{u.duid}</span>
                  <span className="ml-auto text-[9px] px-1.5 py-0.5 rounded-full bg-surfaceAlt text-muted flex-shrink-0">
                    {u.markets.length} {t('vppcb.mktsShort')}
                  </span>
                </div>
                <div className="text-[10px] text-muted truncate">{u.station} · {u.region}</div>
              </button>
            ))}
            {!filtered.length && (
              <div className="text-[12px] text-muted text-center py-6">{t('stx.noMatch')}</div>
            )}
          </div>
        </div>

        {/* ── Main panel — drives the row height; rail follows ─────────── */}
        <div className="ml-[270px] min-w-0 min-h-[420px]">
          {summary && (
            <>
              {/* Header + KPI strip */}
              <div className="flex items-baseline gap-3 flex-wrap mb-4">
                <span className="text-[19px] font-semibold tracking-tight text-ink">{summary.station}</span>
                <span className="text-[12px] font-mono text-muted">{summary.duid}</span>
                <span className="text-[11px] text-muted">
                  {summary.region} · {summary.schedule_type ?? summary.dispatch_type}
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                {[
                  { label: t('vppcb.fleetMax'), val: summary.fleet_max_avail_mw > 0
                      ? `${summary.fleet_max_avail_mw.toFixed(1)} MW` : t('vppcb.dormant'),
                    sub: t('vppcb.fleetMaxSub'),
                    color: summary.fleet_max_avail_mw > 0 ? '#0a84ff' : '#86868b' },
                  { label: t('vppcb.marketsCount'), val: String(summary.markets.length),
                    sub: 'FCAS', color: '#af52de' },
                  { label: t('vppcb.side'), val: summary.dispatch_type ?? '—',
                    sub: summary.schedule_type ?? '', color: '#1d1d1f' },
                  { label: t('vppcb.latestDay'),
                    val: summary.markets[0]?.latest_day ?? '—',
                    sub: t('vppcb.d1Note'), color: '#ff9500' },
                ].map((k) => (
                  <div key={k.label} className="rounded-lg bg-surfaceAlt px-3 py-2.5">
                    <div className="text-[10px] text-muted uppercase tracking-wide">{k.label}</div>
                    <div className="text-[16px] font-semibold tabular-nums" style={{ color: k.color }}>{k.val}</div>
                    {k.sub && <div className="text-[9px] text-muted mt-0.5">{k.sub}</div>}
                  </div>
                ))}
              </div>

              {/* Market overview table */}
              <div className="mb-5 overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="text-[9px] text-muted uppercase tracking-wide border-b border-hairlineSoft">
                      <th className="text-left py-1.5 pr-2 font-medium">{t('vppcb.market')}</th>
                      <th className="text-left py-1.5 px-2 font-medium">{t('vppcb.side')}</th>
                      <th className="text-right py-1.5 px-2 font-medium">{t('vppcb.avail')}</th>
                      <th className="text-right py-1.5 pl-2 font-medium">{t('vppcb.priceRange')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.markets.map((m) => (
                      <tr key={m.bidtype}
                          onClick={() => setMarket(m.bidtype)}
                          className={`border-b border-hairlineSoft/60 cursor-pointer transition-colors ${
                            market === m.bidtype ? 'bg-accent/10' : 'hover:bg-surfaceAlt/60'
                          }`}>
                        <td className="py-1.5 pr-2 font-mono font-medium text-ink">{m.bidtype}</td>
                        <td className="py-1.5 px-2">
                          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded text-white ${
                            (m.direction ?? dirForMarket(m.bidtype)) === 'GEN' ? 'bg-[#34c759]' : 'bg-[#ff9500]'
                          }`}>
                            {(m.direction ?? dirForMarket(m.bidtype)) === 'GEN' ? t('vppcb.sideGen') : t('vppcb.sideLoad')}
                          </span>
                        </td>
                        <td className="py-1.5 px-2 text-right tabular-nums text-ink2">
                          {m.max_avail_mw != null && m.max_avail_mw > 0 ? `${m.max_avail_mw.toFixed(1)} MW` : '0'}
                        </td>
                        <td className="py-1.5 pl-2 text-right tabular-nums text-ink2">
                          {m.price_min != null && m.price_max != null
                            ? `$${m.price_min.toFixed(2)} – $${m.price_max.toFixed(0)}` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* Bid ladder for the selected market */}
          {loading ? (
            <div className="h-48 flex items-center justify-center text-muted text-sm">{t('chart.loading')}</div>
          ) : !bids?.prices && !series.length ? (
            <div className="h-32 flex items-center justify-center text-muted text-sm">{t('vppcb.noBids')}</div>
          ) : (
            <div className="flex flex-col lg:flex-row gap-5">
              <div className="lg:w-[190px] flex-shrink-0">
                <div className="text-[10px] text-muted uppercase tracking-wide mb-2">
                  {t('stx.bandPrices')} · {market}
                </div>
                {(bids?.prices ?? []).map((p, i) => (
                  <div key={i} className="flex items-center gap-2 mb-1">
                    <span className="w-3 h-3 rounded-sm flex-shrink-0" style={{ background: BAND_COLORS[i] }} />
                    <span className="text-[11px] text-muted w-7">B{i + 1}</span>
                    <span className="text-[12px] font-semibold tabular-nums text-ink">
                      {p != null ? `$${p.toFixed(2)}` : '—'}
                    </span>
                  </div>
                ))}
                <div className="text-[10px] text-muted mt-3">{t('vppcb.fcasNote')}</div>
              </div>
              <div className="flex-1 min-w-0">
                {series.length ? (
                  <ResponsiveContainer width="100%" height={260}>
                    <ComposedChart data={series} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}
                                   barCategoryGap="12%">
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" vertical={false} />
                      <XAxis dataKey="hm" tick={{ fontSize: 10, fill: '#86868b' }}
                             interval={Math.max(0, Math.floor((brushWin.e - brushWin.s) / 9))}
                             axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 10, fill: '#86868b' }} axisLine={false} tickLine={false}
                             width={46}
                             label={{ value: 'MW', angle: -90, position: 'insideLeft', fontSize: 10, fill: '#86868b' }} />
                      <Tooltip contentStyle={{ fontSize: 11, borderRadius: 8 }}
                               formatter={(v: number, name: string) => {
                                 const idx = Number(String(name).slice(1)) - 1
                                 const price = bids?.prices?.[idx]
                                 return [`${v?.toFixed(1)} MW`, `B${idx + 1} ${price != null ? `($${price.toFixed(2)})` : ''}`]
                               }} />
                      {Array.from({ length: 10 }, (_, i) => (
                        <Bar key={i} dataKey={`b${i + 1}`} stackId="bands"
                             fill={BAND_COLORS[i]} isAnimationActive={false} />
                      ))}
                      <Brush dataKey="hm" height={26} travellerWidth={8}
                             stroke="#0a84ff" fill="rgba(10,132,255,0.06)"
                             startIndex={Math.min(brushWin.s, Math.max(0, series.length - 1))}
                             endIndex={Math.min(brushWin.e, series.length - 1)}
                             onChange={(r: { startIndex?: number; endIndex?: number }) =>
                               setBrushWin({ s: r.startIndex ?? 0, e: r.endIndex ?? series.length - 1 })}
                             tickFormatter={(v: string) => v} />
                    </ComposedChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-48 flex items-center justify-center text-muted text-sm">{t('vppcb.noBids')}</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
