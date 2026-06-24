/**
 * VPPCalc — C&I "should I join a VPP?" revenue simulator.
 *
 * Lets a C&I user set annual load, PV and battery, then compares three modes
 * over a representative day + annualised:
 *   A 无 VPP (零售 ToU)  ·  B VPP 非工作时段  ·  C VPP 全程
 * Shows a combined day chart (load / PV / spot price lines + battery
 * charge/discharge bars) and a full annual cost breakdown per mode.
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Bar, CartesianGrid, ComposedChart, Line, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { useT } from '../i18n'

type Annual = {
  gross_load_cost: number; network_cost: number; pv_self_saving: number
  pv_export_revenue: number; bess_value: number; vpp_arbitrage: number
  fcas_revenue: number; net_bill: number; savings_vs_a: number
  tariff_switch_saving: number; vpp_uplift: number; total_saving: number
  battery_asset_value: number
}
type Mode = { mode: string; curves: { load: number[]; pv: number[]; bess: number[]; price: number[] }; annual: Annual }
type ExtremeDay = {
  date: string; peak_price_mwh: number; discharge_price_mwh: number
  revenue: number; equiv_cycles: number; normal_day_revenue: number
  x_normal_days: number | null; curves: { price: number[]; bess: number[] }
}
type SimResp = { region: string; axis: string[]; modes: Record<string, Mode>; extreme_day: ExtremeDay | null }

type Segment = 'ci' | 'residential'
type Inputs = {
  segment: Segment
  region: string; annual_load_mwh: number; pv_kw: number
  bess_power_kw: number; bess_energy_kwh: number; rte_pct: number
  retail_peak: number; retail_shoulder: number; retail_offpeak: number
  feed_in_tariff: number; network_per_kwh: number
  fcas_per_mw_day: number; vpp_customer_share_pct: number
}

const DEFAULTS: Inputs = {
  segment: 'ci',
  region: 'NSW1', annual_load_mwh: 1000, pv_kw: 100,
  bess_power_kw: 100, bess_energy_kwh: 215, rte_pct: 88,
  retail_peak: 0.66, retail_shoulder: 0.36, retail_offpeak: 0.25,
  feed_in_tariff: 0.05, network_per_kwh: 0.10,
  fcas_per_mw_day: 2.5, vpp_customer_share_pct: 80,
}

// Residential: ~6 MWh/yr home, 6.6 kW PV, 5 kW / 13.5 kWh battery (Powerwall
// class), residential ToU rates. Battery does PV self-consumption (mode A).
const RESIDENTIAL_DEFAULTS: Inputs = {
  segment: 'residential',
  region: 'NSW1', annual_load_mwh: 6, pv_kw: 6.6,
  bess_power_kw: 5, bess_energy_kwh: 13.5, rte_pct: 90,
  retail_peak: 0.45, retail_shoulder: 0.28, retail_offpeak: 0.20,
  feed_in_tariff: 0.06, network_per_kwh: 0.10,
  fcas_per_mw_day: 2.5, vpp_customer_share_pct: 80,
}

const DEFAULTS_BY_SEGMENT: Record<Segment, Inputs> = { ci: DEFAULTS, residential: RESIDENTIAL_DEFAULTS }

const MODE_KEYS = ['A', 'B', 'C'] as const
const MODE_COLOR: Record<string, string> = { A: '#86868b', B: '#0a84ff', C: '#34c759' }

function money(v: number): string {
  const s = v < 0 ? '−' : ''
  const a = Math.abs(v)
  if (a >= 1_000_000) return `${s}$${(a / 1e6).toFixed(2)}M`
  if (a >= 1000) return `${s}$${(a / 1000).toFixed(1)}k`
  return `${s}$${a.toFixed(0)}`
}

export function VPPCalc() {
  const { t } = useT()
  const [inp, setInp] = useState<Inputs>(DEFAULTS)
  const [data, setData] = useState<SimResp | null>(null)
  const [loading, setLoading] = useState(false)
  const [activeMode, setActiveMode] = useState<'A' | 'B' | 'C'>('C')
  // Raw text being typed per field, so partial decimals ("0.", "0.5") aren't
  // stripped by number coercion mid-edit. Cleared on blur → shows canonical value.
  const [draft, setDraft] = useState<Partial<Record<keyof Inputs, string>>>({})

  const run = (override?: Partial<Inputs>) => {
    const body = { ...inp, ...override }
    setLoading(true)
    fetch('/api/vpp-calc/simulate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json()).then(setData).catch(() => setData(null)).finally(() => setLoading(false))
  }
  useEffect(() => { run() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Switch C&I ⇄ Residential: replace the whole input set with that segment's
  // defaults and recompute.
  const setSegment = (seg: Segment) => {
    if (seg === inp.segment) return
    const next = DEFAULTS_BY_SEGMENT[seg]
    setDraft({}); setInp(next); run(next)
  }

  const res = inp.segment === 'residential'
  const modeName = (m: string) =>
    m === 'A' ? t('vc.modeA')
      : m === 'B' ? t(res ? 'vc.modeB.res' : 'vc.modeB')
        : t('vc.modeC')
  // Mode A is on a retail ToU tariff; B/C are wholesale spot pass-through.
  const priceLabel = activeMode === 'A' ? t('vc.retailPrice') : t('vc.spot')

  // Build chart rows from the active mode's curves.
  const chartData = useMemo(() => {
    if (!data) return []
    const c = data.modes[activeMode].curves
    return data.axis.map((hm, i) => ({
      hm,
      load: c.load[i],
      pv: c.pv[i],
      price: c.price[i],
      charge: c.bess[i] < 0 ? c.bess[i] : 0,
      discharge: c.bess[i] > 0 ? c.bess[i] : 0,
    }))
  }, [data, activeMode])

  // Extreme-price-day replay: real 5-min spot spike + VPP battery response.
  const extremeData = useMemo(() => {
    const ed = data?.extreme_day
    if (!ed || !data) return []
    return data.axis.map((hm, i) => ({
      hm,
      price: ed.curves.price[i],
      charge: ed.curves.bess[i] < 0 ? ed.curves.bess[i] : 0,
      discharge: ed.curves.bess[i] > 0 ? ed.curves.bess[i] : 0,
    }))
  }, [data])

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const num = (key: keyof Inputs, label: string, _step = 1, unit = '') => {
    const shown = draft[key] ?? String(inp[key] ?? '')
    return (
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-muted">{label}{unit && <span className="text-muted/60"> ({unit})</span>}</span>
        {/* step="any" + free-text draft: accept any number, with decimals */}
        <input type="number" inputMode="decimal" step="any" value={shown}
          onChange={(e) => {
            const raw = e.target.value
            setDraft((d) => ({ ...d, [key]: raw }))
            const n = parseFloat(raw)
            if (!Number.isNaN(n)) setInp((s) => ({ ...s, [key]: n }))
          }}
          onBlur={() => setDraft((d) => { const { [key]: _omit, ...rest } = d; return rest })}
          className="text-[13px] px-2.5 py-1.5 rounded-lg border border-hairlineSoft bg-surface text-ink
                     outline-none focus:border-accent transition-colors tabular-nums" />
      </label>
    )
  }

  const breakdownRows: { key: keyof Annual; label: string; positive?: boolean }[] = [
    { key: 'gross_load_cost', label: t('vc.bd.energy') },
    { key: 'network_cost', label: t('vc.bd.network') },
    { key: 'pv_self_saving', label: t('vc.bd.pvSelf'), positive: true },
    { key: 'pv_export_revenue', label: t('vc.bd.pvExport'), positive: true },
    { key: 'bess_value', label: t('vc.bd.bess'), positive: true },
    { key: 'vpp_arbitrage', label: t('vc.bd.vppArb'), positive: true },
    { key: 'fcas_revenue', label: t('vc.bd.fcas'), positive: true },
  ]

  return (
    <div>
      {/* ── Inputs ─────────────────────────────────────────────────────── */}
      <section className="bg-surface rounded-xl2 p-6 shadow-card mb-5">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
          <div className="text-[15px] font-semibold text-ink">{t('vc.inputsTitle')}</div>
          {/* C&I ⇄ Residential segment toggle */}
          <div className="flex gap-1 p-0.5 bg-surfaceAlt rounded-lg">
            {(['ci', 'residential'] as Segment[]).map((seg) => (
              <button key={seg} onClick={() => setSegment(seg)}
                className={`text-[12px] px-3 py-1 rounded-md transition ${
                  inp.segment === seg ? 'bg-white text-ink shadow-sm font-medium' : 'text-ink2 hover:text-ink'
                }`}>{t(seg === 'ci' ? 'vc.seg.ci' : 'vc.seg.res')}</button>
            ))}
          </div>
        </div>
        <div className="text-[11px] text-muted mb-4">{t(res ? 'vc.inputsHint.res' : 'vc.inputsHint')}</div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-muted">{t('vc.region')}</span>
            <select value={inp.region} onChange={(e) => setInp((s) => ({ ...s, region: e.target.value }))}
              className="text-[13px] px-2.5 py-1.5 rounded-lg border border-hairlineSoft bg-surface text-ink">
              {['NSW1', 'QLD1', 'VIC1', 'SA1', 'TAS1'].map((r) => <option key={r}>{r}</option>)}
            </select>
          </label>
          {num('annual_load_mwh', t('vc.annualLoad'), 50, 'MWh/yr')}
          {num('pv_kw', t('vc.pv'), 50, 'kW')}
          {num('bess_power_kw', t('vc.bessPower'), 50, 'kW')}
          {num('bess_energy_kwh', t('vc.bessEnergy'), 100, 'kWh')}
          {num('rte_pct', t('vc.rte'), 1, '%')}
          {num('retail_peak', t('vc.retailPeak'), 0.01, '$/kWh')}
          {num('retail_shoulder', t('vc.retailShoulder'), 0.01, '$/kWh')}
          {num('retail_offpeak', t('vc.retailOffpeak'), 0.01, '$/kWh')}
          {num('feed_in_tariff', t('vc.fit'), 0.01, '$/kWh')}
          {num('network_per_kwh', t('vc.network'), 0.01, '$/kWh')}
          {num('fcas_per_mw_day', t('vc.fcas'), 5, '$/MW/d')}
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button onClick={() => run()}
            className="text-[13px] font-medium px-5 py-2 rounded-lg bg-accent text-white hover:opacity-90 transition">
            {loading ? t('vc.computing') : t('vc.recalc')}
          </button>
          <button onClick={() => { const d = DEFAULTS_BY_SEGMENT[inp.segment]; setDraft({}); setInp(d); run(d) }}
            className="text-[12px] text-muted hover:text-ink transition">{t('vc.reset')}</button>
        </div>
      </section>

      {/* ── Mode comparison cards ──────────────────────────────────────── */}
      {data && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
          {MODE_KEYS.map((m) => {
            const a = data.modes[m].annual
            const isActive = activeMode === m
            return (
              <button key={m} onClick={() => setActiveMode(m)}
                className={`text-left rounded-xl2 p-5 border-2 transition-all ${
                  isActive ? 'shadow-card' : 'border-transparent shadow-sm hover:shadow-card'
                }`}
                style={{ borderColor: isActive ? MODE_COLOR[m] : undefined, background: 'var(--surface, #fff)' }}>
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-2.5 h-2.5 rounded-full" style={{ background: MODE_COLOR[m] }} />
                  <span className="text-[13px] font-semibold text-ink">{modeName(m)}</span>
                </div>
                <div className="text-[26px] font-bold tabular-nums text-ink">{money(a.net_bill)}</div>
                <div className="text-[11px] text-muted">{t('vc.annualBill')}</div>
                {m !== 'A' && (
                  <div className="mt-3 flex items-center justify-between gap-2 pt-2 border-t border-hairlineSoft/60">
                    <span className="text-[10px] font-medium" style={{ color: MODE_COLOR[m] }}>{t('vc.card.vpp')}</span>
                    <span className="text-[13px] font-bold tabular-nums" style={{ color: '#34c759' }}>
                      +{money(a.vpp_uplift)}
                    </span>
                  </div>
                )}
              </button>
            )
          })}
        </div>
      )}

      {/* ── Day chart for the active mode ──────────────────────────────── */}
      {data && (
        <section className="bg-surface rounded-xl2 p-6 shadow-card mb-5">
          <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
            <div>
              <div className="text-[15px] font-semibold text-ink">
                {t('vc.dayTitle')} · <span style={{ color: MODE_COLOR[activeMode] }}>{modeName(activeMode)}</span>
              </div>
              <div className="text-[11px] text-muted mt-0.5">{t('vc.dayHint')}</div>
            </div>
            <div className="flex gap-1 p-0.5 bg-surfaceAlt rounded-lg">
              {MODE_KEYS.map((m) => (
                <button key={m} onClick={() => setActiveMode(m)}
                  className={`text-[11px] px-2.5 py-1 rounded-md transition ${
                    activeMode === m ? 'bg-white text-ink shadow-sm font-medium' : 'text-ink2 hover:text-ink'
                  }`}>{modeName(m)}</button>
              ))}
            </div>
          </div>
          <ResponsiveContainer width="100%" height={340}>
            <ComposedChart data={chartData} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" vertical={false} />
              <XAxis dataKey="hm" tick={{ fontSize: 10, fill: '#86868b' }}
                     interval={Math.max(0, Math.floor(chartData.length / 12))} minTickGap={20}
                     axisLine={false} tickLine={false} />
              <YAxis yAxisId="kw" tick={{ fontSize: 10, fill: '#86868b' }} axisLine={false} tickLine={false}
                     width={46} label={{ value: 'kW', angle: -90, position: 'insideLeft', fontSize: 10, fill: '#86868b' }} />
              <YAxis yAxisId="price" orientation="right" tick={{ fontSize: 10, fill: '#86868b' }}
                     axisLine={false} tickLine={false} width={52}
                     label={{ value: '$/MWh', angle: 90, position: 'insideRight', fontSize: 10, fill: '#86868b' }} />
              <Tooltip contentStyle={{ fontSize: 11, borderRadius: 8 }}
                formatter={(v: number, n: string) => {
                  const lbl: Record<string, string> = {
                    load: t('vc.load'), pv: t('vc.pvGen'), price: priceLabel,
                    charge: t('vc.charge'), discharge: t('vc.discharge'),
                  }
                  return [n === 'price' ? `$${v?.toFixed(0)}/MWh` : `${v?.toFixed(0)} kW`, lbl[n] ?? n]
                }} />
              <ReferenceLine yAxisId="kw" y={0} stroke="rgba(0,0,0,0.2)" />
              {/* Battery charge (down) / discharge (up) bars */}
              <Bar yAxisId="kw" dataKey="discharge" fill="#34c759" fillOpacity={0.55} isAnimationActive={false} />
              <Bar yAxisId="kw" dataKey="charge" fill="#ff9f1c" fillOpacity={0.55} isAnimationActive={false} />
              {/* Load + PV lines */}
              <Line yAxisId="kw" type="monotone" dataKey="load" stroke="#1d1d1f" strokeWidth={1.8} dot={false} isAnimationActive={false} />
              <Line yAxisId="kw" type="monotone" dataKey="pv" stroke="#ffcc00" strokeWidth={1.8} dot={false} isAnimationActive={false} />
              {/* Spot price on right axis */}
              <Line yAxisId="price" type="stepAfter" dataKey="price" stroke="#af52de" strokeWidth={1.5}
                    strokeDasharray="4 2" dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
          {/* Legend */}
          <div className="flex flex-wrap gap-4 mt-3 text-[11px] text-muted">
            <Lg c="#1d1d1f" label={t('vc.load')} /><Lg c="#ffcc00" label={t('vc.pvGen')} />
            <Lg c="#34c759" label={t('vc.discharge')} /><Lg c="#ff9f1c" label={t('vc.charge')} />
            <Lg c="#af52de" label={priceLabel} dash />
          </div>
        </section>
      )}

      {/* ── Annual breakdown table (all 3 modes) ───────────────────────── */}
      {data && (
        <section className="bg-surface rounded-xl2 p-6 shadow-card">
          <div className="text-[15px] font-semibold text-ink mb-1">{t('vc.bdTitle')}</div>
          <div className="text-[11px] text-muted mb-4">{t('vc.bdHint')}</div>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-[11px] text-muted border-b border-hairlineSoft">
                  <th className="text-left py-2 pr-3 font-medium">{t('vc.bd.item')}</th>
                  {MODE_KEYS.map((m) => (
                    <th key={m} className="text-right py-2 px-3 font-medium" style={{ color: MODE_COLOR[m] }}>
                      {modeName(m)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {breakdownRows.map((row) => (
                  <tr key={row.key} className="border-b border-hairlineSoft/60">
                    <td className="py-2 pr-3 text-ink2">
                      {row.label}
                      <span className="text-[10px] text-muted ml-1">{row.positive ? t('vc.bd.minus') : t('vc.bd.plus')}</span>
                    </td>
                    {MODE_KEYS.map((m) => {
                      const v = data.modes[m].annual[row.key]
                      return (
                        <td key={m} className="py-2 px-3 text-right tabular-nums"
                            style={{ color: row.positive ? '#34c759' : '#1d1d1f' }}>
                          {money(v)}
                        </td>
                      )
                    })}
                  </tr>
                ))}
                <tr className="border-t border-hairlineSoft font-semibold">
                  <td className="py-2 pr-3 text-ink2 text-[12px]">{t('vc.bd.assetValue')}</td>
                  {MODE_KEYS.map((m) => (
                    <td key={m} className="py-2 px-3 text-right tabular-nums" style={{ color: '#34c759' }}>
                      {money(data.modes[m].annual.battery_asset_value)}
                    </td>
                  ))}
                </tr>
                <tr className="border-t-2 border-hairline font-semibold">
                  <td className="py-2.5 pr-3 text-ink">{t('vc.bd.netBill')}</td>
                  {MODE_KEYS.map((m) => (
                    <td key={m} className="py-2.5 px-3 text-right tabular-nums text-ink">
                      {money(data.modes[m].annual.net_bill)}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className="py-2 pr-3 text-[12px] font-semibold text-ink">{t('vc.bd.vppUplift')}</td>
                  {MODE_KEYS.map((m) => {
                    const sv = data.modes[m].annual.vpp_uplift
                    return (
                      <td key={m} className="py-2 px-3 text-right tabular-nums font-semibold"
                          style={{ color: sv > 0 ? '#34c759' : '#86868b' }}>
                        {m === 'A' ? '—' : `+${money(sv)}`}
                      </td>
                    )
                  })}
                </tr>
              </tbody>
            </table>
          </div>
          <div className="text-[10px] text-muted mt-3 leading-relaxed">{t('vc.bd.note')}</div>
        </section>
      )}

      {/* ── Extreme-price day scenario ─────────────────────────────────── */}
      {data?.extreme_day && (
        <section className="bg-surface rounded-xl2 p-6 shadow-card mt-5">
          <div className="text-[15px] font-semibold text-ink mb-1">
            {t('vc.ex.title')} · <span className="tabular-nums">{data.extreme_day.date}</span>
          </div>
          <div className="text-[11px] text-muted mb-4">{t('vc.ex.hint')}</div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            <Stat label={t('vc.ex.peak')}
                  value={`$${data.extreme_day.peak_price_mwh.toLocaleString()}`} unit="/MWh" accent="#ff3b30" />
            <Stat label={t('vc.ex.revenue')}
                  value={money(data.extreme_day.revenue)} accent="#34c759" big />
            <Stat label={t('vc.ex.cycles')}
                  value={`${data.extreme_day.equiv_cycles}`} unit={t('vc.ex.cyclesUnit')} />
            <Stat label={t('vc.ex.vsNormal')}
                  value={data.extreme_day.x_normal_days ? `${data.extreme_day.x_normal_days}×` : '—'}
                  unit={t('vc.ex.vsNormalUnit')} accent="#0a84ff" />
          </div>

          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={extremeData} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" vertical={false} />
              <XAxis dataKey="hm" tick={{ fontSize: 10, fill: '#86868b' }}
                     interval={Math.max(0, Math.floor(extremeData.length / 12))} minTickGap={20}
                     axisLine={false} tickLine={false} />
              <YAxis yAxisId="kw" tick={{ fontSize: 10, fill: '#86868b' }} axisLine={false} tickLine={false}
                     width={46} label={{ value: 'kW', angle: -90, position: 'insideLeft', fontSize: 10, fill: '#86868b' }} />
              <YAxis yAxisId="price" orientation="right" tick={{ fontSize: 10, fill: '#86868b' }}
                     axisLine={false} tickLine={false} width={64} scale="log" domain={[1, 'auto']} allowDataOverflow
                     label={{ value: '$/MWh', angle: 90, position: 'insideRight', fontSize: 10, fill: '#86868b' }} />
              <Tooltip contentStyle={{ fontSize: 11, borderRadius: 8 }}
                formatter={(v: number, n: string) => {
                  const lbl: Record<string, string> = {
                    price: t('vc.spot'), charge: t('vc.charge'), discharge: t('vc.discharge'),
                  }
                  return [n === 'price' ? `$${v?.toLocaleString()}/MWh` : `${v?.toFixed(0)} kW`, lbl[n] ?? n]
                }} />
              <ReferenceLine yAxisId="kw" y={0} stroke="rgba(0,0,0,0.2)" />
              <Bar yAxisId="kw" dataKey="discharge" fill="#34c759" fillOpacity={0.6} isAnimationActive={false} />
              <Bar yAxisId="kw" dataKey="charge" fill="#ff9f1c" fillOpacity={0.6} isAnimationActive={false} />
              <Line yAxisId="price" type="stepAfter" dataKey="price" stroke="#ff3b30" strokeWidth={1.6}
                    dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
          <div className="flex flex-wrap gap-4 mt-3 text-[11px] text-muted">
            <Lg c="#ff3b30" label={t('vc.spot')} dash /><Lg c="#34c759" label={t('vc.discharge')} />
            <Lg c="#ff9f1c" label={t('vc.charge')} />
          </div>
        </section>
      )}
    </div>
  )
}

function Stat({ label, value, unit, accent, big }:
  { label: string; value: string; unit?: string; accent?: string; big?: boolean }) {
  return (
    <div className="rounded-xl bg-surfaceAlt px-3.5 py-3">
      <div className="text-[10px] text-muted mb-1">{label}</div>
      <div className={`font-bold tabular-nums ${big ? 'text-[22px]' : 'text-[18px]'}`}
           style={{ color: accent ?? 'var(--ink, #1d1d1f)' }}>
        {value}<span className="text-[11px] font-normal text-muted ml-0.5">{unit}</span>
      </div>
    </div>
  )
}

function Lg({ c, label, dash }: { c: string; label: string; dash?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="inline-block" style={dash
        ? { width: 14, height: 0, borderTop: `2px dashed ${c}` }
        : { width: 12, height: 3, background: c, borderRadius: 2 }} />
      {label}
    </span>
  )
}
