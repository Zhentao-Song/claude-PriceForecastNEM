import type { RegionSnapshot } from '../types'
import { useT } from '../i18n'

type Props = {
  region: RegionSnapshot | null
  /** Optional: latest forecast run timestamp (P5MIN preferred). */
  forecastRun?: string | null
}

function fmt2(v: number | null | undefined) {
  if (v == null || Number.isNaN(v)) return '—'
  return v.toLocaleString('en-AU', { maximumFractionDigits: 2, minimumFractionDigits: 2 })
}

function fmt0(v: number | null | undefined) {
  if (v == null || Number.isNaN(v)) return '—'
  return Math.round(v).toLocaleString('en-AU')
}

function minutesAgo(iso: string | null | undefined): number | null {
  if (!iso) return null
  // ISO without TZ is treated as local. DB timestamps are NEM time
  // (UTC+10, no DST). Convert client "now" to NEM-time, then diff.
  const nowNem = new Date(Date.now() + 10 * 3600_000)
  const t = new Date(iso + 'Z')   // pretend NEM time is UTC for diff math
  const diffMs = nowNem.getTime() - t.getTime()
  return Math.max(0, Math.round(diffMs / 60_000))
}

function deltaTone(delta: number | null): string {
  if (delta === null) return 'text-muted'
  return delta >= 0 ? 'text-negative' : 'text-positive'
}

function deltaArrow(delta: number | null): string {
  if (delta === null) return ''
  return delta >= 0 ? '↑' : '↓'
}

/** Compact AEMO-style KPI strip: spot, demand, next-interval forecasts,
 *  forecast vintage, APC status. Mirrors what aemo.com.au surfaces at the
 *  top of every region tile, plus the vintage badge (which AEMO omits). */
export function PriceKPIs({ region, forecastRun }: Props) {
  const { t } = useT()
  if (!region) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 text-[12px]">
        <Kpi label={t('kpi.spot')} value="—" />
        <Kpi label={t('kpi.demand')} value="—" />
        <Kpi label={t('kpi.forecastPrice')} value="—" />
        <Kpi label={t('kpi.forecastDemand')} value="—" />
        <Kpi label={t('kpi.apc')} value={t('kpi.apc.inactive')} dim />
      </div>
    )
  }
  const fc = region.next_forecast
  const fcRrpDelta =
    fc?.rrp != null && region.rrp != null ? fc.rrp - region.rrp : null
  const fcDemandDelta =
    fc?.demand != null && region.totaldemand != null
      ? fc.demand - region.totaldemand : null

  // Prefer the per-region next_forecast.run_datetime; fall back to the
  // global P5MIN run from /api/forecast.
  const vintage = minutesAgo(fc?.run_datetime ?? forecastRun ?? null)

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 text-[12px]">
      <Kpi
        label={t('kpi.spot')}
        value={`$${fmt2(region.rrp)}`}
        unit="/MWh"
        accent="orange"
      />
      <Kpi
        label={t('kpi.demand')}
        value={fmt0(region.totaldemand)}
        unit="MW"
        accent="blue"
      />
      <Kpi
        label={t('kpi.forecastPrice')}
        value={fc?.rrp != null ? `$${fmt2(fc.rrp)}` : '—'}
        unit="/MWh"
        delta={fcRrpDelta != null ? `${deltaArrow(fcRrpDelta)} ${fmt2(Math.abs(fcRrpDelta))}` : undefined}
        deltaClass={deltaTone(fcRrpDelta)}
        sub={vintage != null ? t('kpi.vintage', vintage) : undefined}
      />
      <Kpi
        label={t('kpi.forecastDemand')}
        value={fmt0(fc?.demand)}
        unit="MW"
        delta={fcDemandDelta != null ? `${deltaArrow(fcDemandDelta)} ${fmt0(Math.abs(fcDemandDelta))}` : undefined}
        deltaClass={deltaTone(fcDemandDelta)}
      />
      <Kpi
        label={t('kpi.apc')}
        value={t('kpi.apc.inactive')}
        sub={t('kpi.apc.note')}
        dim
      />
    </div>
  )
}

function Kpi({
  label, value, unit, sub, delta, deltaClass, accent, dim,
}: {
  label: string
  value: string
  unit?: string
  sub?: string
  delta?: string
  deltaClass?: string
  accent?: 'orange' | 'blue'
  dim?: boolean
}) {
  const accentClass = accent === 'orange' ? 'text-accent' : 'text-ink'
  // Demand uses Apple system blue (#0a84ff) inline since the design system
  // intentionally exposes only one named accent (orange).
  const accentStyle = !dim && accent === 'blue' ? { color: '#0a84ff' } : undefined
  return (
    <div className="bg-surfaceAlt rounded-lg px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className="flex items-baseline gap-1 mt-1">
        <span
          className={`text-[20px] font-semibold tabular-nums leading-none ${dim ? 'text-muted' : accentClass}`}
          style={accentStyle}
        >
          {value}
        </span>
        {unit && <span className="text-[10px] text-muted leading-none">{unit}</span>}
        {delta && (
          <span className={`text-[11px] tabular-nums ml-auto ${deltaClass ?? 'text-muted'}`}>
            {delta}
          </span>
        )}
      </div>
      {sub && <div className="text-[10px] text-muted mt-1">{sub}</div>}
    </div>
  )
}
