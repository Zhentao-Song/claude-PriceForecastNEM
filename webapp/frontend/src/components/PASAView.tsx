/**
 * PASAView — ST PASA 14-day demand forecast + reserve condition display.
 *
 * Shows P10/P50/P90 demand bands and available generation as a stacked area /
 * bar chart, plus a LOR status badge for each interval.
 */
import { useEffect, useMemo, useState } from 'react'
import {
  AreaChart, Area, Bar, BarChart, CartesianGrid, Legend,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { fetchSTPASA } from '../api'
import type { STPASAPoint, STPASAResponse } from '../types'
import { useT } from '../i18n'

const NEM_REGIONS = ['NSW1', 'QLD1', 'VIC1', 'SA1', 'TAS1']

// LOR label keys — resolved via t() at render time
const LOR_KEY: Record<number, string> = {
  0: 'pasa.lor.ok',
  1: 'pasa.lor.lor1',
  2: 'pasa.lor.lor2',
  3: 'pasa.lor.lor3',
}
const LOR_COLOR: Record<number, string> = {
  0: '#22c55e',
  1: '#f59e0b',
  2: '#f97316',
  3: '#ef4444',
}

// Short badge labels — these are AEMO industry codes, kept in English
const LOR_SHORT: Record<number, string> = { 0: 'OK', 1: 'LOR1', 2: 'LOR2', 3: 'LOR3' }

function lorBadge(rc: number | null) {
  const lvl = rc ?? 0
  return (
    <span
      style={{
        background: LOR_COLOR[lvl] ?? '#6b7280',
        color: '#fff',
        borderRadius: 4,
        padding: '1px 6px',
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.5,
      }}
    >
      {LOR_SHORT[lvl] ?? `LOR${lvl}`}
    </span>
  )
}

function fmtNem(iso: string): string {
  // "2026-05-28 14:30:00" → "28/05 14:30"
  const [date, time] = iso.split(' ')
  if (!date || !time) return iso
  const [, m, d] = date.split('-')
  return `${d}/${m} ${time.slice(0, 5)}`
}

function aggregateDaily(series: STPASAPoint[]): {
  day: string
  demand50_min: number | null
  demand50_max: number | null
  demand10_min: number | null
  demand90_max: number | null
  avgen_mean: number | null
  worst_lor: number
}[] {
  const by_day: Record<string, STPASAPoint[]> = {}
  for (const pt of series) {
    const day = pt.interval_datetime.slice(0, 10)
    if (!by_day[day]) by_day[day] = []
    by_day[day].push(pt)
  }
  return Object.entries(by_day)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, pts]) => {
      const d50 = pts.map(p => p.demand50).filter((v): v is number => v !== null)
      const d10 = pts.map(p => p.demand10).filter((v): v is number => v !== null)
      const d90 = pts.map(p => p.demand90).filter((v): v is number => v !== null)
      const ag = pts.map(p => p.available_generation).filter((v): v is number => v !== null)
      const lrs = pts.map(p => p.reservecondition ?? 0)
      return {
        day,
        demand50_min: d50.length ? Math.min(...d50) : null,
        demand50_max: d50.length ? Math.max(...d50) : null,
        demand10_min: d10.length ? Math.min(...d10) : null,
        demand90_max: d90.length ? Math.max(...d90) : null,
        avgen_mean: ag.length ? ag.reduce((a, b) => a + b, 0) / ag.length : null,
        worst_lor: lrs.length ? Math.max(...lrs) : 0,
      }
    })
}

interface Props {
  region?: string
}

export function PASAView({ region: initRegion = 'NSW1' }: Props) {
  const [region, setRegion] = useState(initRegion)
  const { t } = useT()
  const [data, setData] = useState<STPASAResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<'daily' | '30min'>('daily')

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetchSTPASA(region, 14)
      .then(setData)
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }, [region])

  const daily = useMemo(() => (data ? aggregateDaily(data.series) : []), [data])

  const lorSummary = useMemo(() => {
    if (!data) return null
    const lc = data.lor_counts
    const total = Object.values(lc).reduce((a, b) => a + b, 0)
    const nok = Number(lc['0'] ?? 0)
    return { total, nok, lor1: Number(lc['1'] ?? 0), lor2: Number(lc['2'] ?? 0), lor3: Number(lc['3'] ?? 0) }
  }, [data])

  return (
    <div style={{ fontFamily: 'system-ui,sans-serif', padding: 16 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>
          {t('pasa.title')}
        </h3>

        {/* Region selector */}
        <select
          value={region}
          onChange={e => setRegion(e.target.value)}
          style={{ padding: '3px 8px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13 }}
        >
          {NEM_REGIONS.map(r => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>

        {/* View toggle */}
        <div style={{ display: 'flex', gap: 4 }}>
          {(['daily', '30min'] as const).map(v => (
            <button
              key={v}
              onClick={() => setView(v)}
              style={{
                padding: '3px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                background: view === v ? '#ff9500' : '#f5f5f7',
                color: view === v ? '#fff' : '#424245',
                border: '1px solid ' + (view === v ? '#e68600' : '#d2d2d7'),
                fontWeight: view === v ? 600 : 400,
              }}
            >
              {v === 'daily' ? t('pasa.viewDaily') : t('pasa.view30min')}
            </button>
          ))}
        </div>

        {data?.latest_run && (
          <span style={{ fontSize: 11, color: '#6b7280', marginLeft: 'auto' }}>
            {t('pasa.run')} {fmtNem(data.latest_run)}
          </span>
        )}
      </div>

      {/* LOR summary pills */}
      {lorSummary && lorSummary.total > 0 && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          {([
            { lvl: 0, count: lorSummary.nok },
            { lvl: 1, count: lorSummary.lor1 },
            { lvl: 2, count: lorSummary.lor2 },
            { lvl: 3, count: lorSummary.lor3 },
          ] as { lvl: number; count: number }[]).filter(x => x.count > 0).map(({ lvl, count }) => (
            <span
              key={lvl}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                padding: '2px 8px', borderRadius: 12, fontSize: 12,
                background: LOR_COLOR[lvl] + '22',
                border: `1px solid ${LOR_COLOR[lvl]}55`,
                color: lvl === 0 ? '#166534' : '#7c2d12',
              }}
            >
              {lorBadge(lvl)}
              <span style={{ fontWeight: 600 }}>{count}</span>
              <span style={{ color: '#6b7280' }}>{t('pasa.intervals')}</span>
            </span>
          ))}
        </div>
      )}

      {loading && (
        <div style={{ color: '#6b7280', fontSize: 13, marginBottom: 12 }}>{t('pasa.loading')}</div>
      )}
      {error && (
        <div style={{
          background: '#fef2f2', border: '1px solid #fca5a5',
          borderRadius: 8, padding: '8px 12px', color: '#dc2626', fontSize: 13, marginBottom: 12,
        }}>
          {error.includes('404') || error.includes('500')
            ? t('pasa.errorNoData')
            : `Error: ${error}`}
        </div>
      )}

      {!loading && !error && data && data.count === 0 && (
        <div style={{
          background: '#f9fafb', border: '1px solid #e5e7eb',
          borderRadius: 8, padding: '16px', color: '#6b7280', fontSize: 13, textAlign: 'center',
        }}>
          {t('pasa.noData')}
          <br />
          <span style={{ fontSize: 11, marginTop: 4, display: 'block' }}>
            {t('pasa.noDataSource')}
          </span>
        </div>
      )}

      {/* Daily summary chart */}
      {!loading && view === 'daily' && daily.length > 0 && (
        <div>
          <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 8px' }}>
            {t('pasa.chart.hintDaily')}
          </p>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={daily} barCategoryGap="20%" margin={{ top: 4, right: 8, bottom: 20, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis
                dataKey="day"
                tickFormatter={s => s.slice(5)}  // MM-DD
                tick={{ fontSize: 11 }}
                angle={-30}
                textAnchor="end"
              />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
              <Tooltip
                formatter={(v: number, name: string) => [`${v?.toFixed(0)} MW`, name]}
                labelFormatter={l => `Date: ${l}`}
              />
              <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
              <Bar dataKey="demand10_min" name={t('pasa.chart.demand10')} fill="#d2d2d7" radius={[2, 2, 0, 0]} />
              <Bar dataKey="demand50_max" name={t('pasa.chart.demand50')} fill="#86868b" radius={[2, 2, 0, 0]} />
              <Bar dataKey="demand90_max" name={t('pasa.chart.demand90')} fill="#424245" radius={[2, 2, 0, 0]} />
              <Bar dataKey="avgen_mean"   name={t('pasa.chart.avgen')}   fill="#ff9500" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>

          {/* LOR row heatmap */}
          <div style={{ display: 'flex', gap: 3, marginTop: 8, flexWrap: 'wrap' }}>
            {daily.map(d => (
              <div
                key={d.day}
                title={`${d.day}: ${t(LOR_KEY[d.worst_lor] ?? 'pasa.lor.lor3')}`}
                style={{
                  width: 28, height: 18, borderRadius: 3, cursor: 'default',
                  background: LOR_COLOR[d.worst_lor] ?? '#e5e7eb',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                <span style={{ fontSize: 9, color: '#fff', fontWeight: 700 }}>
                  {d.day.slice(5)}
                </span>
              </div>
            ))}
          </div>
          <p style={{ fontSize: 11, color: '#9ca3af', margin: '4px 0 0' }}>
            {t('pasa.lorHint')}
          </p>
        </div>
      )}

      {/* 30-min interval chart */}
      {!loading && view === '30min' && data && data.series.length > 0 && (
        <div>
          <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 8px' }}>
            {t('pasa.chart.hint30min')}
          </p>
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart
              data={data.series}
              margin={{ top: 4, right: 8, bottom: 20, left: 8 }}
            >
              <defs>
                <linearGradient id="grad90" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#424245" stopOpacity={0.25} />
                  <stop offset="95%" stopColor="#424245" stopOpacity={0.0} />
                </linearGradient>
                <linearGradient id="grad10" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#d2d2d7" stopOpacity={0.35} />
                  <stop offset="95%" stopColor="#d2d2d7" stopOpacity={0.0} />
                </linearGradient>
                <linearGradient id="gradAvgen" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#ff9500" stopOpacity={0.18} />
                  <stop offset="95%" stopColor="#ff9500" stopOpacity={0.0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis
                dataKey="interval_datetime"
                tickFormatter={fmtNem}
                tick={{ fontSize: 10 }}
                angle={-30}
                textAnchor="end"
                interval={Math.max(1, Math.floor(data.series.length / 14))}
              />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
              <Tooltip
                labelFormatter={l => fmtNem(String(l))}
                formatter={(v: number, name: string) => [`${v?.toFixed(0)} MW`, name]}
              />
              <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
              <Area
                type="monotone"
                dataKey="demand90"
                name={t('pasa.chart.demand90')}
                stroke="#424245"
                fill="url(#grad90)"
                dot={false}
                strokeWidth={1.5}
              />
              <Area
                type="monotone"
                dataKey="demand50"
                name={t('pasa.chart.demand50')}
                stroke="#86868b"
                fill="url(#grad10)"
                dot={false}
                strokeWidth={2}
              />
              <Area
                type="monotone"
                dataKey="demand10"
                name={t('pasa.chart.demand10')}
                stroke="#d2d2d7"
                fill="none"
                dot={false}
                strokeWidth={1.5}
                strokeDasharray="4 2"
              />
              <Area
                type="monotone"
                dataKey="available_generation"
                name={t('pasa.chart.avgen')}
                stroke="#ff9500"
                fill="url(#gradAvgen)"
                dot={false}
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}
