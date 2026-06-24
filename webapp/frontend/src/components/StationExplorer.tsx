/**
 * StationExplorer — "Station X-Ray" per-DUID drill-down view.
 *
 * Left rail: searchable list of every registered DUID (curated + AEMO
 * facility registry, ~700 units). Main panel for the selected unit:
 *   · KPI strip — live MW, capacity, utilisation, MLF, schedule type
 *   · Today card — energy generated/consumed, spot revenue / charge cost
 *   · Output × price chart — 5-min SCADA MW vs regional RRP (dual axis)
 *   · Bid ladder — actual AEMO BIDDAYOFFER prices × BIDPEROFFER
 *     availabilities, the classic 10-band stacked view
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Area, Bar, Brush, CartesianGrid, ComposedChart, Line,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { useT } from '../i18n'

// ---- API types -----------------------------------------------------------
type StationListItem = {
  duid: string; station: string; region: string; fuel: string | null
  capacity_mw: number | null; dispatch_type: string; on_map: boolean
}
type StationSummary = {
  duid: string; station: string; region: string; fuel: string | null
  capacity_mw: number | null; dispatch_type: string
  schedule_type: string | null; co2e_source: string | null
  emissions_factor: number | null
  mlf: number; mlf_fy: string | null
  latest_mw: number | null; latest_interval: string | null
  today: {
    generated_mwh: number; consumed_mwh: number
    spot_revenue_aud: number; charge_cost_aud: number; net_aud: number
    intervals: number
  }
}
type HistPoint = { t: string; mw: number | null; rrp: number | null }
type BidsResponse = {
  duid: string; date: string; bidtype: string
  direction: string | null; submitted_at: string | null
  prices: (number | null)[] | null
  intervals: { t: string; avail: (number | null)[]; maxavail: number | null }[]
}

const FUEL_COLORS: Record<string, string> = {
  coal_black: '#1d1d1f', coal_brown: '#8b5a2b', gas: '#af52de',
  hydro: '#0a84ff', wind: '#34c759', solar: '#ff9500',
  battery: '#ff2d92', bioenergy: '#a85a00',
}

// Band 1 (cheapest, always-on) → band 10 (price cap). Green → red ramp.
const BAND_COLORS = [
  '#1f9d55', '#34c759', '#7ed321', '#c0d62b', '#ffd60a',
  '#ffb340', '#ff9500', '#ff6340', '#ff3b30', '#b91d1d',
]

function fmtAud(v: number): string {
  const sign = v < 0 ? '-' : ''
  const a = Math.abs(v)
  if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(2)}M`
  if (a >= 1_000) return `${sign}$${(a / 1_000).toFixed(1)}k`
  return `${sign}$${a.toFixed(0)}`
}

export function StationExplorer() {
  const { t } = useT()
  const [list, setList] = useState<StationListItem[]>([])
  const [regionF, setRegionF] = useState<string>('')
  const [fuelF, setFuelF] = useState<string>('')
  const [search, setSearch] = useState('')
  const [duid, setDuid] = useState<string>('WTAHB1')

  const [summary, setSummary] = useState<StationSummary | null>(null)
  const [hist, setHist] = useState<HistPoint[]>([])
  const [histHours, setHistHours] = useState(24)
  const [bids, setBids] = useState<BidsResponse | null>(null)
  // GEN = sell/discharge ladder; LOAD = buy/charge ladder (storage only).
  const [bidDir, setBidDir] = useState<'GEN' | 'LOAD'>('GEN')
  // Visible bid-chart window (Brush indices). Default = first 6 hours
  // (72 × 5-min intervals) so bars stay readable; drag the brush to pan
  // across the full 288-interval trading day.
  const [brushWin, setBrushWin] = useState<{ s: number; e: number }>({ s: 0, e: 71 })
  const [loading, setLoading] = useState(false)

  // Station list — once.
  useEffect(() => {
    fetch('/api/station/list')
      .then((r) => r.json())
      .then((d) => setList(d.stations ?? []))
      .catch(() => {})
  }, [])

  // Per-DUID data — summary + history + bids in parallel.
  useEffect(() => {
    if (!duid) return
    setLoading(true)
    Promise.allSettled([
      fetch(`/api/station/${duid}/summary`).then((r) => r.json()),
      fetch(`/api/station/${duid}/history?hours=${histHours}`).then((r) => r.json()),
      fetch(`/api/station/${duid}/bids?direction=${bidDir}`).then((r) => r.json()),
    ]).then(([s, h, b]) => {
      setSummary(s.status === 'fulfilled' && !('detail' in s.value) ? s.value : null)
      setHist(h.status === 'fulfilled' ? (h.value.series ?? []) : [])
      setBids(b.status === 'fulfilled' ? b.value : null)
    }).finally(() => setLoading(false))
  }, [duid, histHours, bidDir])

  // Switching to a non-storage unit: snap back to the sell-side ladder.
  useEffect(() => {
    if (summary && summary.fuel !== 'battery' && bidDir !== 'GEN') setBidDir('GEN')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary?.duid])

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase()
    return list.filter((s) =>
      (!regionF || s.region === regionF) &&
      (!fuelF || s.fuel === fuelF) &&
      (!q || s.duid.includes(q) || s.station.toUpperCase().includes(q)),
    ).slice(0, 120)
  }, [list, regionF, fuelF, search])

  const histSeries = useMemo(
    () => hist.map((p) => ({ ...p, hm: p.t.slice(11, 16) })),
    [hist],
  )

  // Bid availability stacked series.
  const bidSeries = useMemo(() => {
    if (!bids?.intervals?.length) return []
    return bids.intervals.map((iv) => {
      const row: Record<string, number | string | null> = { hm: iv.t.slice(11, 16) }
      iv.avail.forEach((a, i) => { row[`b${i + 1}`] = a ?? 0 })
      return row
    })
  }, [bids])

  const utilPct = summary?.latest_mw != null && summary.capacity_mw
    ? Math.abs(summary.latest_mw) / summary.capacity_mw * 100
    : null

  return (
    <div>
    <div className="flex gap-5">
      {/* ── Left rail: picker ──────────────────────────────────────────── */}
      <div className="w-[270px] flex-shrink-0 bg-surface rounded-xl2 shadow-card p-4 self-start">
        <div className="flex gap-2 mb-3">
          <select value={regionF} onChange={(e) => setRegionF(e.target.value)}
                  className="flex-1 text-[12px] px-2 py-1.5 rounded-lg border border-hairlineSoft bg-surface text-ink">
            <option value="">{t('stx.allRegions')}</option>
            {['NSW1', 'QLD1', 'VIC1', 'SA1', 'TAS1'].map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <select value={fuelF} onChange={(e) => setFuelF(e.target.value)}
                  className="flex-1 text-[12px] px-2 py-1.5 rounded-lg border border-hairlineSoft bg-surface text-ink">
            <option value="">{t('stx.allFuels')}</option>
            {Object.keys(FUEL_COLORS).map((f) => <option key={f} value={f}>{t(`fuel.${f}`)}</option>)}
          </select>
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('stx.searchPh')}
          className="w-full text-[12px] px-3 py-2 mb-3 rounded-lg border border-hairlineSoft bg-surface
                     text-ink outline-none focus:border-accent transition-colors"
        />
        <div className="max-h-[560px] overflow-y-auto -mx-1 px-1">
          {filtered.map((s) => (
            <button key={s.duid}
                    onClick={() => setDuid(s.duid)}
                    className={`w-full text-left px-2.5 py-2 rounded-lg mb-0.5 transition-colors ${
                      duid === s.duid ? 'bg-accent/10 border border-accent/40' : 'hover:bg-surfaceAlt border border-transparent'
                    }`}>
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ background: s.fuel ? FUEL_COLORS[s.fuel] ?? '#86868b' : '#c7c7cc' }} />
                <span className="text-[12px] font-semibold text-ink font-mono">{s.duid}</span>
                <span className="ml-auto text-[10px] text-muted tabular-nums">
                  {s.capacity_mw ? `${s.capacity_mw.toFixed(0)}MW` : ''}
                </span>
              </div>
              <div className="text-[10px] text-muted truncate pl-4">{s.station} · {s.region}</div>
            </button>
          ))}
          {!filtered.length && (
            <div className="text-[12px] text-muted text-center py-6">{t('stx.noMatch')}</div>
          )}
        </div>
      </div>

      {/* ── Main panel ─────────────────────────────────────────────────── */}
      <div className="flex-1 min-w-0">
        {!summary ? (
          <div className="bg-surface rounded-xl2 shadow-card p-10 text-center text-muted text-sm">
            {loading ? t('chart.loading') : t('stx.pickOne')}
          </div>
        ) : (
          <>
            {/* Title + KPI strip */}
            <div className="bg-surface rounded-xl2 shadow-card p-6 mb-5">
              <div className="flex items-baseline gap-3 flex-wrap">
                <span className="text-[22px] font-semibold tracking-tight text-ink">{summary.station}</span>
                <span className="text-[13px] font-mono text-muted">{summary.duid}</span>
                <span className="text-[11px] px-2 py-0.5 rounded-full text-white"
                      style={{ background: summary.fuel ? FUEL_COLORS[summary.fuel] ?? '#86868b' : '#86868b' }}>
                  {summary.fuel ? t(`fuel.${summary.fuel}`) : summary.co2e_source ?? '—'}
                </span>
                <span className="text-[11px] text-muted">{summary.region} · {summary.schedule_type ?? summary.dispatch_type}</span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mt-5">
                {[
                  { label: t('stx.liveMw'), val: summary.latest_mw != null ? `${summary.latest_mw.toFixed(1)} MW` : '—',
                    sub: summary.latest_interval?.slice(11, 16) ?? '', color: '#0a84ff' },
                  { label: t('stx.capacity'), val: summary.capacity_mw ? `${summary.capacity_mw.toFixed(0)} MW` : '—',
                    sub: '', color: '#1d1d1f' },
                  { label: t('stx.util'), val: utilPct != null ? `${utilPct.toFixed(0)}%` : '—',
                    sub: '', color: '#ff9500' },
                  { label: 'MLF', val: summary.mlf.toFixed(4),
                    sub: summary.mlf_fy ?? '', color: '#af52de' },
                  { label: t('stx.emissions'), val: summary.emissions_factor != null ? `${summary.emissions_factor.toFixed(2)}` : '—',
                    sub: 'tCO₂e/MWh', color: '#86868b' },
                ].map((k) => (
                  <div key={k.label} className="rounded-lg bg-surfaceAlt px-3 py-2.5">
                    <div className="text-[10px] text-muted uppercase tracking-wide">{k.label}</div>
                    <div className="text-[17px] font-semibold tabular-nums" style={{ color: k.color }}>{k.val}</div>
                    {k.sub && <div className="text-[10px] text-muted">{k.sub}</div>}
                  </div>
                ))}
              </div>

              {/* Today's economics */}
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mt-3">
                {[
                  { label: t('stx.todayGen'), val: `${summary.today.generated_mwh.toFixed(1)} MWh`, color: '#34c759' },
                  { label: t('stx.todayLoad'), val: `${summary.today.consumed_mwh.toFixed(1)} MWh`, color: '#ff9500' },
                  { label: t('stx.revenue'), val: fmtAud(summary.today.spot_revenue_aud), color: '#34c759' },
                  { label: t('stx.chargeCost'), val: fmtAud(summary.today.charge_cost_aud), color: '#ff3b30' },
                  { label: t('stx.net'), val: fmtAud(summary.today.net_aud),
                    color: summary.today.net_aud >= 0 ? '#34c759' : '#ff3b30' },
                ].map((k) => (
                  <div key={k.label} className="rounded-lg bg-surfaceAlt px-3 py-2.5">
                    <div className="text-[10px] text-muted uppercase tracking-wide">{k.label}</div>
                    <div className="text-[15px] font-semibold tabular-nums" style={{ color: k.color }}>{k.val}</div>
                  </div>
                ))}
              </div>
              <div className="text-[10px] text-muted mt-2">{t('stx.revNote')}</div>
            </div>

            {/* Output × price chart */}
            <div className="bg-surface rounded-xl2 shadow-card p-6 mb-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <div className="text-[15px] font-semibold text-ink">{t('stx.outputTitle')}</div>
                  <div className="text-[11px] text-muted mt-0.5">{t('stx.outputHint')}</div>
                </div>
                <div className="flex gap-1 p-0.5 bg-surfaceAlt rounded-lg">
                  {[24, 72, 168].map((h) => (
                    <button key={h} onClick={() => setHistHours(h)}
                            className={`text-[11px] px-2.5 py-1 rounded-md transition ${
                              histHours === h ? 'bg-white text-ink shadow-sm font-medium' : 'text-ink2 hover:text-ink'
                            }`}>
                      {h / 24}d
                    </button>
                  ))}
                </div>
              </div>
              {histSeries.length ? (
                <ResponsiveContainer width="100%" height={280}>
                  <ComposedChart data={histSeries} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                    <defs>
                      <linearGradient id="stx-mw" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#0a84ff" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="#0a84ff" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" vertical={false} />
                    <XAxis dataKey="hm" tick={{ fontSize: 10, fill: '#86868b' }}
                           interval={Math.max(1, Math.floor(histSeries.length / 12))}
                           axisLine={false} tickLine={false} />
                    <YAxis yAxisId="mw" tick={{ fontSize: 10, fill: '#86868b' }}
                           tickFormatter={(v) => `${v}`} axisLine={false} tickLine={false} width={46}
                           label={{ value: 'MW', angle: -90, position: 'insideLeft', fontSize: 10, fill: '#86868b' }} />
                    <YAxis yAxisId="rrp" orientation="right" tick={{ fontSize: 10, fill: '#86868b' }}
                           tickFormatter={(v) => `$${v}`} axisLine={false} tickLine={false} width={52} />
                    <Tooltip
                      formatter={(v: number, name: string) =>
                        name === 'mw' ? [`${v?.toFixed(1)} MW`, t('stx.output')] : [`$${v?.toFixed(2)}`, 'RRP']}
                      contentStyle={{ fontSize: 12, borderRadius: 8 }}
                    />
                    <Area yAxisId="mw" type="stepAfter" dataKey="mw" stroke="#0a84ff"
                          strokeWidth={1.6} fill="url(#stx-mw)" isAnimationActive={false} />
                    <Line yAxisId="rrp" type="stepAfter" dataKey="rrp" stroke="#ff9500"
                          strokeWidth={1.4} dot={false} isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-40 flex items-center justify-center text-muted text-sm">{t('stx.noScada')}</div>
              )}
            </div>

          </>
        )}
      </div>
    </div>

    {/* ── Bid ladder — full-width row below the two columns, so the
        288-interval trading day gets the whole page width ────────────── */}
    {summary && (
            <div className="mt-5 bg-surface rounded-xl2 shadow-card p-6">
              <div className="mb-4 flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <div className="text-[15px] font-semibold text-ink flex items-center gap-2">
                    {t('stx.bidTitle')}
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full text-white ${
                      bidDir === 'GEN' ? 'bg-[#34c759]' : 'bg-[#ff9500]'
                    }`}>
                      {bidDir === 'GEN' ? t('stx.dirSell') : t('stx.dirBuy')}
                    </span>
                  </div>
                  <div className="text-[11px] text-muted mt-0.5">
                    {bids?.date ? `${t('stx.bidDate')} ${bids.date}` : ''}
                    {bids?.submitted_at ? ` · ${t('stx.submitted')} ${bids.submitted_at.replace('T', ' ').slice(0, 16)}` : ''}
                  </div>
                  <div className="text-[10px] text-muted mt-0.5">{t('stx.bidDayNote')}</div>
                </div>
                {/* Buy/sell ladder toggle — only storage bids both directions */}
                {summary.fuel === 'battery' && (
                  <div className="flex gap-1 p-0.5 bg-surfaceAlt rounded-lg">
                    {([['GEN', t('stx.dirSell')], ['LOAD', t('stx.dirBuy')]] as const).map(([k, label]) => (
                      <button key={k} onClick={() => setBidDir(k)}
                              className={`text-[11px] px-2.5 py-1 rounded-md transition ${
                                bidDir === k ? 'bg-white text-ink shadow-sm font-medium' : 'text-ink2 hover:text-ink'
                              }`}>
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {bids?.prices ? (
                <div className="flex flex-col lg:flex-row gap-5">
                  {/* Price ladder */}
                  <div className="lg:w-[210px] flex-shrink-0">
                    <div className="text-[10px] text-muted uppercase tracking-wide mb-2">{t('stx.bandPrices')}</div>
                    {bids.prices.map((p, i) => (
                      <div key={i} className="flex items-center gap-2 mb-1">
                        <span className="w-3 h-3 rounded-sm flex-shrink-0" style={{ background: BAND_COLORS[i] }} />
                        <span className="text-[11px] text-muted w-7">B{i + 1}</span>
                        <span className="text-[12px] font-semibold tabular-nums text-ink">
                          {p != null ? `$${p.toFixed(2)}` : '—'}
                        </span>
                      </div>
                    ))}
                  </div>
                  {/* Availability stack — defaults to a 6-hour window so the
                      bars are readable; the Brush below pans/zooms across the
                      full 288-interval trading day */}
                  <div className="flex-1 min-w-0">
                    {bidSeries.length ? (
                      <ResponsiveContainer width="100%" height={380}>
                        <ComposedChart data={bidSeries} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}
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
                                     const price = bids.prices?.[idx]
                                     return [`${v?.toFixed(0)} MW`, `B${idx + 1} ${price != null ? `($${price.toFixed(0)})` : ''}`]
                                   }} />
                          {Array.from({ length: 10 }, (_, i) => (
                            <Bar key={i} dataKey={`b${i + 1}`} stackId="bands"
                                 fill={BAND_COLORS[i]} isAnimationActive={false} />
                          ))}
                          {/* Scroll bar: drag the body to pan, drag the
                              handles to widen/narrow the visible window */}
                          <Brush dataKey="hm" height={26} travellerWidth={8}
                                 stroke="#0a84ff" fill="rgba(10,132,255,0.06)"
                                 startIndex={Math.min(brushWin.s, Math.max(0, bidSeries.length - 1))}
                                 endIndex={Math.min(brushWin.e, bidSeries.length - 1)}
                                 onChange={(r: { startIndex?: number; endIndex?: number }) =>
                                   setBrushWin({
                                     s: r.startIndex ?? 0,
                                     e: r.endIndex ?? bidSeries.length - 1,
                                   })}
                                 tickFormatter={(v: string) => v} />
                        </ComposedChart>
                      </ResponsiveContainer>
                    ) : (
                      <div className="h-40 flex items-center justify-center text-muted text-sm">{t('stx.noBids')}</div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="h-24 flex items-center justify-center text-muted text-sm">{t('stx.noBids')}</div>
              )}
            </div>
    )}
    </div>
  )
}
