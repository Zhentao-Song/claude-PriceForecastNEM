import type { RegionSnapshot, WemSnapshot } from '../types'
import { useT } from '../i18n'

type Props = {
  label: string
  rrp: number | null
  prior: number | null
  ts: string | null
  demand?: number | null
  selected?: boolean
  onClick?: () => void
  subtitle?: string
}

function fmtPrice(v: number | null): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  return v.toLocaleString('en-AU', { maximumFractionDigits: 2, minimumFractionDigits: 2 })
}

function priceTone(v: number | null): string {
  // Restrained: only escalate to color when it actually matters.
  if (v === null) return 'text-muted'
  if (v < 0) return 'text-negative'
  if (v > 300) return 'text-accent'
  return 'text-ink'
}

function fmtTime(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })
}

export function RegionTile({
  label, rrp, prior, ts, demand, selected, onClick, subtitle,
}: Props) {
  const { t } = useT()
  const delta = rrp !== null && prior !== null ? rrp - prior : null
  // Down is good (price relief), up is "bad" — but kept very subtle.
  const deltaTone =
    delta === null ? 'text-muted' : delta >= 0 ? 'text-negative' : 'text-positive'
  const deltaArrow = delta === null ? '' : delta >= 0 ? '↑' : '↓'

  return (
    <button
      onClick={onClick}
      className={`card-hover text-left bg-surface rounded-xl2 p-5 w-full
        flex flex-col
        outline-none focus:outline-none focus-visible:shadow-cardActive
        ${selected ? 'shadow-cardActive' : 'shadow-card hover:shadow-cardHover'}`}
    >
      {/* Header row: state name (top-left) + last-update time (top-right) */}
      <div className="flex items-baseline justify-between">
        <div className="text-[15px] font-semibold tracking-tight text-ink leading-none">
          {label}
        </div>
        <div className="text-[11px] text-muted tabular-nums">{fmtTime(ts)}</div>
      </div>
      {/* Subtitle directly under the name. Always rendered (with &nbsp; for
          empty case) so every card has the same total height. */}
      <div className="text-[11px] text-muted mt-1 leading-none">
        {subtitle ?? ' '}
      </div>

      {/* Price block — single line: $ + big number + /MWh unit, all on
          the same baseline. Number gets the headline font (38px) and the
          $ / /MWh markers are kept small so the value reads first. */}
      <div className="mt-5 flex items-baseline gap-1 leading-none">
        <span className="text-[14px] text-muted">$</span>
        <span className={`text-[38px] font-semibold tracking-tight tabular-nums ${priceTone(rrp)}`}>
          {fmtPrice(rrp)}
        </span>
        <span className="text-[12px] text-muted ml-1">/MWh</span>
      </div>

      {/* Bottom row — always rendered. Sits at the very bottom thanks to
          mt-auto on the wrapping flex column. */}
      <div className="mt-auto pt-4 flex items-center justify-between text-[11px] leading-none">
        <span className={`tabular-nums ${deltaTone}`}>
          {delta !== null ? `${deltaArrow} ${fmtPrice(Math.abs(delta))}` : '—'}
          <span className="text-muted ml-1">{t('nsw.vsLastHour')}</span>
        </span>
        {demand !== undefined && demand !== null && (
          <span className="text-muted tabular-nums">{(demand / 1000).toFixed(2)} GW</span>
        )}
      </div>
    </button>
  )
}

export function regionTilePropsForNEM(
  r: RegionSnapshot,
  selected: boolean,
  onClick: () => void,
): Props {
  const labels: Record<string, string> = {
    NSW1: 'NSW', QLD1: 'QLD', VIC1: 'VIC', SA1: 'SA', TAS1: 'TAS',
  }
  return {
    label: labels[r.regionid] ?? r.regionid,
    subtitle: r.regionid,
    rrp: r.rrp,
    prior: r.rrp_1h_ago,
    ts: r.settlementdate,
    demand: r.totaldemand,
    selected,
    onClick,
  }
}

export function regionTilePropsForWEM(
  w: WemSnapshot | null,
  selected: boolean,
  onClick: () => void,
): Props {
  return {
    label: 'WA',
    subtitle: 'WEM · RTP',
    rrp: w?.reference_trading_price ?? null,
    prior: null,
    ts: w?.interval_start ?? null,
    demand: null,
    selected,
    onClick,
  }
}
