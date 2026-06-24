/**
 * HistoricalDayView — date-picker explorer for archived 5-min prices.
 *
 * The local archive holds ~14 months of dispatch prices (backfill loads
 * 90 days on first boot; long-running instances accumulate more). Pick any
 * date → full 288-interval RRP + demand curve for that NEM trading day,
 * with summary stats (max/min/avg/spread, negative & >$300 interval counts).
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts'
import { useT } from '../i18n'

type DayPoint = { t: string; rrp: number | null; demand: number | null }
type DayStats = {
  max: number; min: number; avg: number; spread: number
  neg_intervals: number; over300_intervals: number
}
type DayResponse = {
  region: string
  date: string
  series: DayPoint[]
  stats: DayStats | null
  available_from: string | null
  available_to: string | null
}

async function fetchDay(region: string, date: string): Promise<DayResponse> {
  const r = await fetch(`/api/prices/day?region=${encodeURIComponent(region)}&date=${date}`)
  if (!r.ok) throw new Error(`day ${r.status}`)
  return r.json()
}

function yesterdayISO(): string {
  const d = new Date(Date.now() - 24 * 3600 * 1000)
  return d.toISOString().slice(0, 10)
}

export function HistoricalDayView({ region }: { region: string }) {
  const { t } = useT()
  const [date, setDate] = useState<string>(yesterdayISO())
  const [data, setData] = useState<DayResponse | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (region === 'WEM') { setData(null); return }
    setLoading(true)
    fetchDay(region, date)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [region, date])

  const series = useMemo(
    () => (data?.series ?? []).map((p) => ({
      ...p,
      // x label: "HH:MM" out of "2025-07-15T14:35:00"
      hm: p.t.slice(11, 16),
    })),
    [data],
  )

  if (region === 'WEM') return null

  const s = data?.stats

  return (
    <div>
      {/* Date picker row */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <input
          type="date"
          value={date}
          min={data?.available_from ?? '2025-04-01'}
          max={data?.available_to ?? yesterdayISO()}
          onChange={(e) => e.target.value && setDate(e.target.value)}
          className="text-[13px] px-3 py-1.5 rounded-lg border border-hairlineSoft bg-surface
                     text-ink outline-none focus:border-accent transition-colors"
        />
        <span className="text-[11px] text-muted">
          {t('histday.range')}: {data?.available_from ?? '…'} → {data?.available_to ?? '…'}
        </span>
      </div>

      {/* Stats strip */}
      {s && (
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-4">
          {[
            { label: t('histday.max'),    val: `$${s.max.toFixed(0)}`,    color: '#ff3b30' },
            { label: t('histday.min'),    val: `$${s.min.toFixed(0)}`,    color: s.min < 0 ? '#34c759' : '#0a84ff' },
            { label: t('histday.avg'),    val: `$${s.avg.toFixed(0)}`,    color: '#1d1d1f' },
            { label: t('histday.spread'), val: `$${s.spread.toFixed(0)}`, color: '#af52de' },
            { label: t('histday.neg'),    val: String(s.neg_intervals),    color: '#34c759' },
            { label: t('histday.spikes'), val: String(s.over300_intervals), color: '#ff9500' },
          ].map((k) => (
            <div key={k.label} className="rounded-lg bg-surfaceAlt px-3 py-2">
              <div className="text-[10px] text-muted uppercase tracking-wide">{k.label}</div>
              <div className="text-[15px] font-semibold tabular-nums" style={{ color: k.color }}>
                {k.val}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Day curve */}
      {loading ? (
        <div className="h-64 flex items-center justify-center text-muted text-sm">{t('chart.loading')}</div>
      ) : !series.length ? (
        <div className="h-64 flex items-center justify-center text-muted text-sm">{t('histday.noData')}</div>
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <AreaChart data={series} margin={{ top: 6, right: 12, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="histday-rrp" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#ff9500" stopOpacity={0.35} />
                <stop offset="100%" stopColor="#ff9500" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" vertical={false} />
            <XAxis dataKey="hm" tick={{ fontSize: 10, fill: '#86868b' }}
                   interval={35} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={(v) => `$${v}`} tick={{ fontSize: 10, fill: '#86868b' }}
                   axisLine={false} tickLine={false} width={52} />
            <Tooltip
              formatter={(v: number, name: string) =>
                name === 'rrp' ? [`$${v?.toFixed(2)}/MWh`, 'RRP'] : [`${v?.toFixed(0)} MW`, t('chart.demand')]}
              labelFormatter={(l) => `${data?.date}  ${l}`}
              contentStyle={{ fontSize: 12, borderRadius: 8 }}
            />
            <Area type="stepAfter" dataKey="rrp" stroke="#ff9500" strokeWidth={1.8}
                  fill="url(#histday-rrp)" isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}
