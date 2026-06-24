/**
 * PaperAnalyticsPanel — Aggregated paper-trading performance dashboard.
 *
 * Shows four KPI cards (cumulative P&L, 7-day, 30-day, annualised run-rate),
 * two secondary chips (win-rate, filled count), a stacked daily bar chart
 * (Energy vs FCAS P&L), and a cumulative area chart.
 *
 * Data comes from GET /api/paper/analytics?duid=WTAHB1.
 */
import { useEffect, useState } from 'react'
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid,
  Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { fetchPaperAnalytics } from '../api'
import type { PaperAnalytics } from '../types'
import { useT } from '../i18n'

// ── helpers ──────────────────────────────────────────────────────────────────

function fmtAUD(v: number, compact = false): string {
  const abs = Math.abs(v)
  const sign = v >= 0 ? '+' : '−'
  if (compact && abs >= 1000) {
    return `${sign}$${(abs / 1000).toFixed(1)}k`
  }
  return `${sign}$${abs.toFixed(2)}`
}

function fmtDay(iso: string): string {
  // "2026-05-28" → "28/05"
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`
}

// ── sub-components ────────────────────────────────────────────────────────────

interface KpiCardProps {
  label: string
  value: number
  compact?: boolean
  highlight?: boolean
  sub?: string
}

function KpiCard({ label, value, compact = false, highlight = false, sub }: KpiCardProps) {
  const positive = value >= 0
  return (
    <div style={{
      background: highlight ? (positive ? '#f0fdf4' : '#fef2f2') : '#f9fafb',
      border: `1px solid ${highlight ? (positive ? '#bbf7d0' : '#fca5a5') : '#e5e7eb'}`,
      borderRadius: 10,
      padding: '10px 14px',
      minWidth: 0,
    }}>
      <p style={{ fontSize: 11, color: '#6b7280', margin: '0 0 4px', whiteSpace: 'nowrap' }}>{label}</p>
      <p style={{
        fontSize: compact ? 18 : 22,
        fontWeight: 700,
        color: positive ? '#16a34a' : '#dc2626',
        margin: 0,
        fontVariantNumeric: 'tabular-nums',
      }}>
        {fmtAUD(value, true)}
      </p>
      {sub && (
        <p style={{ fontSize: 10, color: '#9ca3af', margin: '2px 0 0' }}>{sub}</p>
      )}
    </div>
  )
}

interface ChipProps { label: string; value: string }
function Chip({ label, value }: ChipProps) {
  return (
    <div style={{
      display: 'inline-flex', flexDirection: 'column', alignItems: 'center',
      background: '#f3f4f6', border: '1px solid #e5e7eb',
      borderRadius: 8, padding: '6px 14px', gap: 2,
    }}>
      <span style={{ fontSize: 14, fontWeight: 700, color: '#1f2937' }}>{value}</span>
      <span style={{ fontSize: 10, color: '#6b7280' }}>{label}</span>
    </div>
  )
}

// ── main component ────────────────────────────────────────────────────────────

interface Props {
  duid?: string
  /** Change this value to trigger a re-fetch (e.g. pass snap.generated_at). */
  refreshKey?: string | number | null
}

export function PaperAnalyticsPanel({ duid = 'WTAHB1', refreshKey }: Props) {
  const { t } = useT()
  const [data, setData] = useState<PaperAnalytics | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetchPaperAnalytics(duid)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duid, refreshKey])

  if (loading) return (
    <div style={{ padding: '12px 0', color: '#9ca3af', fontSize: 12 }}>…</div>
  )

  if (!data || data.daily.length === 0) return (
    <div style={{
      background: '#f9fafb', border: '1px solid #e5e7eb',
      borderRadius: 10, padding: '16px',
      fontSize: 12, color: '#6b7280', textAlign: 'center',
    }}>
      {t('pa.noData')}
    </div>
  )

  const { stats, daily } = data

  return (
    <div style={{ fontFamily: 'system-ui,sans-serif' }}>

      {/* ── KPI row ──────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginBottom: 12 }}>
        <KpiCard
          label={t('pa.totalPnl')}
          value={stats.total_pnl}
          highlight
          sub={`${stats.trading_days} ${t('pa.days')}`}
        />
        <KpiCard label={t('pa.pnl7d')}  value={stats.pnl_7d}  compact />
        <KpiCard label={t('pa.pnl30d')} value={stats.pnl_30d} compact />
        <KpiCard
          label={t('pa.annualized')}
          value={stats.annualized_aud}
          compact
          sub="/yr"
        />
      </div>

      {/* ── secondary chips ─────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <Chip label={t('pa.winRate')} value={`${stats.win_rate.toFixed(1)}%`} />
        <Chip label={t('pa.nFills')}  value={`${stats.n_fills} ${t('pa.fills')}`} />
        <Chip label={t('pa.tradingDays')} value={`${stats.trading_days} ${t('pa.days')}`} />
      </div>

      {/* ── daily stacked bar chart ──────────────────────────────── */}
      <p style={{ fontSize: 11, color: '#6b7280', margin: '0 0 6px' }}>{t('pa.barHint')}</p>
      <ResponsiveContainer width="100%" height={180}>
        <BarChart data={daily} barCategoryGap="25%" margin={{ top: 4, right: 8, bottom: 18, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
          <XAxis
            dataKey="day"
            tickFormatter={fmtDay}
            tick={{ fontSize: 9 }}
            angle={-30}
            textAnchor="end"
            interval={Math.max(0, Math.floor(daily.length / 10) - 1)}
          />
          <YAxis
            tick={{ fontSize: 9 }}
            tickFormatter={v => `$${v >= 0 ? '' : '−'}${Math.abs(v).toFixed(0)}`}
            width={42}
          />
          <Tooltip
            formatter={(v: number, name: string) => [fmtAUD(v), name]}
            labelFormatter={l => fmtDay(String(l))}
          />
          <Legend wrapperStyle={{ fontSize: 10, paddingTop: 4 }} />
          <Bar dataKey="energy_pnl" name={t('pa.energy')} stackId="a" fill="#22c55e" radius={[0,0,0,0]} />
          <Bar dataKey="fcas_pnl"   name={t('pa.fcas')}   stackId="a" fill="#3b82f6" radius={[2,2,0,0]} />
        </BarChart>
      </ResponsiveContainer>

      {/* ── cumulative area chart ────────────────────────────────── */}
      <p style={{ fontSize: 11, color: '#6b7280', margin: '14px 0 6px' }}>{t('pa.cumHint')}</p>
      <ResponsiveContainer width="100%" height={160}>
        <AreaChart data={daily} margin={{ top: 4, right: 8, bottom: 18, left: 8 }}>
          <defs>
            <linearGradient id="cumGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor="#3b82f6" stopOpacity={0.25} />
              <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
          <XAxis
            dataKey="day"
            tickFormatter={fmtDay}
            tick={{ fontSize: 9 }}
            angle={-30}
            textAnchor="end"
            interval={Math.max(0, Math.floor(daily.length / 10) - 1)}
          />
          <YAxis
            tick={{ fontSize: 9 }}
            tickFormatter={v => `$${Math.abs(v) >= 1000 ? `${(v/1000).toFixed(1)}k` : v.toFixed(0)}`}
            width={42}
          />
          <Tooltip
            formatter={(v: number) => [fmtAUD(v), t('pa.cumulative')]}
            labelFormatter={l => fmtDay(String(l))}
          />
          <Area
            type="monotone"
            dataKey="cumulative"
            name={t('pa.cumulative')}
            stroke="#3b82f6"
            strokeWidth={2}
            fill="url(#cumGrad)"
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
