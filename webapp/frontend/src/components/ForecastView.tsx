import { useEffect, useMemo, useState } from 'react'
import {
  Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line,
  LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip,
  XAxis, YAxis,
} from 'recharts'
import { fetchForecastAccuracy, fetchForecastSeries } from '../api'
import type { ForecastAccuracy, ForecastSeries } from '../types'
import { useT } from '../i18n'

const REGION = 'NSW1'
const GRID = '#e8e8ed'
const MUTED = '#86868b'
const INK = '#1d1d1f'
const ACTUAL_COLOR = '#1d1d1f'

const hhmm = (t: string) => t.slice(11, 16)
const money = (v: number | null | undefined) =>
  v == null ? '—' : `$${Math.round(v).toLocaleString()}`

export function ForecastView() {
  const { t } = useT()
  const [series, setSeries] = useState<ForecastSeries | null>(null)
  const [acc, setAcc] = useState<ForecastAccuracy | null>(null)
  const [windowDays, setWindowDays] = useState<7 | 30>(7)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  // Live chart series — fetched once on mount (refreshes on a slow interval).
  useEffect(() => {
    let alive = true
    const load = () => fetchForecastSeries(REGION, 12)
      .then((s) => { if (alive) { setSeries(s); setErr(null) } })
      .catch((e) => { if (alive) setErr(String(e)) })
      .finally(() => { if (alive) setLoading(false) })
    load()
    const id = setInterval(load, 5 * 60_000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  // Accuracy panel — refetched when the window toggle changes.
  useEffect(() => {
    let alive = true
    fetchForecastAccuracy(REGION, windowDays)
      .then((a) => { if (alive) setAcc(a) })
      .catch(() => { if (alive) setAcc(null) })
    return () => { alive = false }
  }, [windowDays])

  // ── Merge actuals + every model into one row per timestamp ────────────────
  const rows = useMemo(() => {
    if (!series) return []
    const map = new Map<string, Record<string, number | string>>()
    for (const a of series.actuals) map.set(a.t, { t: a.t, actual: a.rrp })
    for (const m of series.models) {
      for (const p of m.points) {
        const row = map.get(p.t) ?? { t: p.t }
        row[m.name] = p.rrp
        if (m.is_benchmark && p.p10 != null && p.p90 != null) {
          row.aemo_lo = p.p10
          row.aemo_band = Math.max(0, p.p90 - p.p10)
        }
        map.set(p.t, row)
      }
    }
    return [...map.values()].sort((a, b) => String(a.t).localeCompare(String(b.t)))
  }, [series])

  const lastActualT = series?.actuals.at(-1)?.t

  // By-hour error: one row per hour, one column per model.
  const byHour = useMemo(() => {
    if (!acc) return []
    return Array.from({ length: 24 }, (_, h) => {
      const row: Record<string, number | null> = { hour: h }
      for (const m of acc.models) row[m.name] = m.by_hour[h] ?? null
      return row
    })
  }, [acc])

  if (loading) {
    return <div className="h-64 flex items-center justify-center text-muted text-sm">
      <span className="animate-pulse">Loading…</span></div>
  }
  if (err || !series) {
    return <div className="rounded-xl border border-[#e8e8ed] bg-white p-6 text-sm text-muted">
      {t('forecast.loadError')}{err ? ` — ${err}` : ''}</div>
  }

  const ratedModels = acc?.models.filter((m) => m.rmse != null) ?? []
  const peak = acc?.evening_peak ?? [16, 20]

  return (
    <div className="space-y-5">
      {/* ── Top: forecast vs actual chart ─────────────────────────────── */}
      <section className="rounded-xl border border-[#e8e8ed] bg-white p-4">
        <div className="flex items-baseline justify-between mb-1">
          <h2 className="text-[15px] font-semibold text-ink">
            NSW · {t('forecast.chartTitle')}
          </h2>
          <span className="text-[11px] text-muted tabular-nums">
            {t('forecast.now')} {series.now.slice(5, 16)} · ±1σ≈${Math.round(series.aemo_error_std)}
          </span>
        </div>
        <p className="text-[12px] text-muted mb-3">{t('forecast.chartSub')}</p>
        <ResponsiveContainer width="100%" height={340}>
          <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis
              dataKey="t" tickFormatter={hhmm} interval={5}
              stroke={MUTED} tick={{ fontSize: 11, fill: MUTED }}
              axisLine={{ stroke: GRID }} tickLine={false}
            />
            <YAxis
              stroke={MUTED} tick={{ fontSize: 11, fill: MUTED }}
              axisLine={false} tickLine={false} width={52}
              tickFormatter={(v) => `$${v}`}
            />
            <Tooltip
              contentStyle={{ background: '#fff', border: `1px solid ${GRID}`,
                borderRadius: 8, fontSize: 12, color: INK }}
              labelStyle={{ color: MUTED, marginBottom: 4 }}
              labelFormatter={(l) => String(l).slice(5, 16)}
              formatter={(v: number, name) => [money(v), name]}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} iconType="plainline" />
            {/* AEMO ±1σ band, drawn as two stacked areas (lo invisible) */}
            <Area dataKey="aemo_lo" stackId="band" stroke="none" fill="none"
              isAnimationActive={false} legendType="none" name="_lo" />
            <Area dataKey="aemo_band" stackId="band" stroke="none" fill="#3b82f6"
              fillOpacity={0.08} isAnimationActive={false} legendType="none" name="_band" />
            {/* Actual cleared price */}
            <Line dataKey="actual" name={t('forecast.actual')} stroke={ACTUAL_COLOR}
              strokeWidth={2.5} dot={false} connectNulls isAnimationActive={false} />
            {/* Each model's forecast */}
            {series.models.map((m) => (
              <Line key={m.name} dataKey={m.name} name={m.label} stroke={m.color}
                strokeWidth={m.is_benchmark ? 2 : 1.6}
                strokeDasharray={m.is_benchmark ? '5 3' : undefined}
                dot={false} connectNulls isAnimationActive={false} />
            ))}
            {lastActualT && (
              <ReferenceLine x={lastActualT} stroke={MUTED} strokeDasharray="2 2"
                label={{ value: t('forecast.now'), position: 'top', fontSize: 10, fill: MUTED }} />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </section>

      {/* ── Bottom: accuracy analysis ─────────────────────────────────── */}
      <section className="rounded-xl border border-[#e8e8ed] bg-white p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-[15px] font-semibold text-ink">{t('forecast.accTitle')}</h2>
            <p className="text-[12px] text-muted">
              {t('forecast.accSub')}
              {acc && acc.n_common > 0 && ` · ${acc.n_common} ${t('forecast.commonPts')}`}
            </p>
          </div>
          <div className="flex gap-1 p-0.5 bg-surfaceAlt rounded-lg shrink-0">
            {([7, 30] as const).map((w) => (
              <button key={w} onClick={() => setWindowDays(w)}
                className={`text-[12px] px-3 py-1.5 rounded-md transition ${
                  windowDays === w ? 'bg-white text-ink shadow-sm font-medium'
                    : 'text-ink2 hover:text-ink'}`}>
                {w}{t('forecast.days')}
              </button>
            ))}
          </div>
        </div>

        {!acc || ratedModels.length === 0 ? (
          <div className="text-sm text-muted py-8 text-center">{t('forecast.accEmpty')}</div>
        ) : (
          <>
            {/* Metric table */}
            <div className="overflow-x-auto">
              <table className="w-full text-[13px] border-collapse">
                <thead>
                  <tr className="text-muted text-[11px] uppercase tracking-wide">
                    <th className="text-left font-medium py-1.5 pr-3">{t('forecast.model')}</th>
                    <th className="text-right font-medium py-1.5 px-3">MAE</th>
                    <th className="text-right font-medium py-1.5 px-3">RMSE</th>
                    <th className="text-right font-medium py-1.5 px-3">sMAPE</th>
                    <th className="text-right font-medium py-1.5 px-3">{t('forecast.bias')}</th>
                    <th className="text-right font-medium py-1.5 px-3">{t('forecast.skill')}</th>
                    <th className="text-right font-medium py-1.5 pl-3">{t('forecast.coverage')}</th>
                  </tr>
                </thead>
                <tbody>
                  {acc.models.map((m) => {
                    const isWinner = m.name === acc.winner
                    return (
                      <tr key={m.name} className="border-t border-[#f0f0f2]">
                        <td className="py-1.5 pr-3">
                          <span className="inline-flex items-center gap-2">
                            <span className="inline-block w-2.5 h-2.5 rounded-sm"
                              style={{ background: m.color }} />
                            <span className="text-ink">{m.label}</span>
                            {m.is_benchmark && (
                              <span className="text-[10px] text-muted">({t('forecast.benchmark')})</span>)}
                            {isWinner && <span title={t('forecast.winner')}>🏆</span>}
                          </span>
                        </td>
                        <td className="text-right tabular-nums px-3">{money(m.mae)}</td>
                        <td className="text-right tabular-nums px-3 font-medium">{money(m.rmse)}</td>
                        <td className="text-right tabular-nums px-3">{m.smape == null ? '—' : `${m.smape}%`}</td>
                        <td className="text-right tabular-nums px-3"
                          style={{ color: m.bias == null ? MUTED : m.bias < 0 ? '#0a84ff' : '#ff3b30' }}>
                          {m.bias == null ? '—' : `${m.bias > 0 ? '+' : ''}${money(m.bias)}`}
                        </td>
                        <td className="text-right tabular-nums px-3"
                          style={{ color: m.skill == null ? MUTED : m.skill > 0 ? '#34c759' : '#ff3b30' }}>
                          {m.skill == null ? '—' : `${m.skill > 0 ? '+' : ''}${(m.skill * 100).toFixed(0)}%`}
                        </td>
                        <td className="text-right tabular-nums pl-3 text-muted" title={t('forecast.coverageHint')}>{m.n_total}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <p className="text-[11px] text-muted mt-2">{t('forecast.skillNote')}</p>
            </div>

            {/* RMSE comparison + error-by-hour */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mt-5">
              <div>
                <h3 className="text-[12px] font-medium text-ink2 mb-2">{t('forecast.rmseTitle')}</h3>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={ratedModels} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke={GRID} vertical={false} />
                    <XAxis dataKey="label" stroke={MUTED} tick={{ fontSize: 11, fill: MUTED }}
                      axisLine={{ stroke: GRID }} tickLine={false} />
                    <YAxis stroke={MUTED} tick={{ fontSize: 11, fill: MUTED }} axisLine={false}
                      tickLine={false} width={48} tickFormatter={(v) => `$${v}`} />
                    <Tooltip contentStyle={{ background: '#fff', border: `1px solid ${GRID}`,
                      borderRadius: 8, fontSize: 12 }} formatter={(v: number) => money(v)} cursor={{ fill: '#f5f5f7' }} />
                    <Bar dataKey="rmse" radius={[4, 4, 0, 0]}>
                      {ratedModels.map((m) => <Cell key={m.name} fill={m.color} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div>
                <h3 className="text-[12px] font-medium text-ink2 mb-2">{t('forecast.byHourTitle')}</h3>
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={byHour} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke={GRID} vertical={false} />
                    <ReferenceArea x1={peak[0]} x2={peak[1]} fill="#ff9500" fillOpacity={0.08}
                      label={{ value: t('forecast.eveningPeak'), position: 'insideTop', fontSize: 9, fill: '#b35e00' }} />
                    <XAxis dataKey="hour" stroke={MUTED} tick={{ fontSize: 11, fill: MUTED }}
                      axisLine={{ stroke: GRID }} tickLine={false} interval={2}
                      tickFormatter={(h) => `${h}h`} />
                    <YAxis stroke={MUTED} tick={{ fontSize: 11, fill: MUTED }} axisLine={false}
                      tickLine={false} width={48} tickFormatter={(v) => `$${v}`} />
                    <Tooltip contentStyle={{ background: '#fff', border: `1px solid ${GRID}`,
                      borderRadius: 8, fontSize: 12 }} formatter={(v: number, n) => [money(v), n]}
                      labelFormatter={(h) => `${h}:00`} />
                    {acc.models.filter((m) => m.rmse != null).map((m) => (
                      <Line key={m.name} dataKey={m.name} name={m.label} stroke={m.color}
                        strokeWidth={1.6} dot={false} connectNulls isAnimationActive={false} />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  )
}
