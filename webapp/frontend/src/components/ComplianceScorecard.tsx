import { useEffect, useState } from 'react'
import { fetchVPPCompliance } from '../api'
import type {
  VPPCompliance, VPPComplianceCategory, VPPComplianceConductItem,
  VPPComplianceContractItem, VPPComplianceDataItem, VPPComplianceItemStatus,
  VPPComplianceRuleItem, VPPComplianceStatus,
} from '../types'
import { useT } from '../i18n'

/**
 * ComplianceScorecard — one-page "prudent participant" report card.
 *
 * Four stacked sections:
 *   1. Rule enforcement matrix (informational) — honest disclosure of
 *      which NER rules our validators cover vs which we skip.
 *   2. Participant conduct (the AER lens) — rebid frequency, reason
 *      quality, gate timing.
 *   3. Customer contract compliance — per-resource events/day vs cap.
 *   4. Data freshness — scraper lag as proxy for operational health.
 *
 * Overall score is a weighted blend of (2), (3), (4). The rule section
 * deliberately doesn't add to the score because "we wrote validators" is
 * a self-assertion, not a measurement of behaviour.
 *
 * Designed to be screenshot-ready: regulators / customers / investors
 * can glance at the top number + status badge and know "are these
 * people behaving like serious operators."
 */

const STATUS_STYLE: Record<VPPComplianceStatus, { bg: string; fg: string; ring: string; label: string }> = {
  'PRUDENT':       { bg: 'bg-positive/12',  fg: 'text-positive', ring: 'ring-positive/30',  label: 'PRUDENT' },
  'ACCEPTABLE':    { bg: 'bg-accent/12',    fg: 'text-accent',   ring: 'ring-accent/30',    label: 'ACCEPTABLE' },
  'NEEDS REVIEW':  { bg: 'bg-warn/12',      fg: 'text-warn',     ring: 'ring-warn/30',      label: 'NEEDS REVIEW' },
  'AT RISK':       { bg: 'bg-negative/12',  fg: 'text-negative', ring: 'ring-negative/30',  label: 'AT RISK' },
}

const ITEM_STATUS_STYLE: Record<VPPComplianceItemStatus, { dot: string; fg: string }> = {
  ok:     { dot: 'bg-positive', fg: 'text-positive' },
  warn:   { dot: 'bg-warn',     fg: 'text-warn' },
  breach: { dot: 'bg-negative', fg: 'text-negative' },
  info:   { dot: 'bg-muted/40', fg: 'text-muted' },
}

function scoreColor(score: number | null): string {
  if (score === null) return 'text-muted'
  if (score >= 85) return 'text-positive'
  if (score >= 70) return 'text-accent'
  if (score >= 55) return 'text-warn'
  return 'text-negative'
}

function staleness(sec: number | null): string {
  if (sec === null) return '—'
  if (sec < 90) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
  return `${Math.floor(sec / 86400)}d`
}

export function ComplianceScorecard({ portfolioId = 'NSW_CI_VPP' }: { portfolioId?: string }) {
  const { t } = useT()
  const [data, setData] = useState<VPPCompliance | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [days, setDays] = useState(7)
  const [expanded, setExpanded] = useState(true)

  useEffect(() => {
    let cancelled = false
    fetchVPPCompliance(portfolioId, days)
      .then(d => { if (!cancelled) setData(d) })
      .catch(e => { if (!cancelled) setErr(String((e as Error).message ?? e)) })
    return () => { cancelled = true }
  }, [portfolioId, days])

  if (err) return (
    <section className="bg-surface rounded-xl2 p-6 shadow-card">
      <div className="text-[11px] text-negative">compliance unavailable: {err}</div>
    </section>
  )
  if (!data) return (
    <section className="bg-surface rounded-xl2 p-6 shadow-card">
      <div className="text-[12px] text-muted">{t('chart.loading')}</div>
    </section>
  )

  const statusStyle = STATUS_STYLE[data.overall_status]

  return (
    <section className="bg-surface rounded-xl2 p-6 shadow-card">
      {/* ===== Header with big overall score ===== */}
      <div className="flex items-start justify-between flex-wrap gap-4 mb-5">
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-muted">
            {t('cs.kicker')}
          </div>
          <div className="text-[15px] font-semibold tracking-tight text-ink mt-0.5">
            {t('cs.title')}
          </div>
          <div className="text-[12px] text-muted mt-0.5">{t('cs.hint', String(data.window_days))}</div>
        </div>

        {/* Big score + status */}
        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wider text-muted">
              {t('cs.overallScore')}
            </div>
            <div className={`text-[44px] font-semibold tabular-nums leading-none mt-1 ${scoreColor(data.overall_score)}`}>
              {data.overall_score}
              <span className="text-[16px] text-muted font-normal ml-1">/100</span>
            </div>
          </div>
          <span className={`px-3 py-1 rounded-full text-[11px] font-semibold tracking-wide ring-1 ${statusStyle.bg} ${statusStyle.fg} ${statusStyle.ring}`}>
            {statusStyle.label}
          </span>
        </div>
      </div>

      {/* ===== Summary strip ===== */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2.5 mb-5">
        <SummaryChip label={t('cs.sum.bids')}     value={String(data.summary.total_bids)} />
        <SummaryChip label={t('cs.sum.settled')}  value={String(data.summary.settled)} accent="positive" />
        <SummaryChip label={t('cs.sum.pending')}  value={String(data.summary.pending)} accent="muted" />
        <SummaryChip label={t('cs.sum.rebids')}   value={String(data.summary.rebids)} />
        <SummaryChip
          label={t('cs.sum.ruleCov')}
          value={`${data.summary.rule_coverage_pct}%`}
          sub={`${data.summary.rules_enforced}/${data.summary.rules_total} ${t('cs.sum.rules')}`}
          accent={data.summary.rule_coverage_pct >= 70 ? 'positive' : 'warn'}
        />
      </div>

      {/* Lookback window selector */}
      <div className="flex items-center gap-2 mb-4 text-[11px]">
        <span className="text-muted">{t('cs.window')}:</span>
        {[1, 7, 30].map((d) => (
          <button key={d} onClick={() => setDays(d)}
                  className={`px-2 py-0.5 rounded transition-colors ${
                    days === d
                      ? 'bg-accent text-white font-medium'
                      : 'bg-surfaceAlt text-muted hover:text-ink'
                  }`}>
            {d}d
          </button>
        ))}
        <button onClick={() => setExpanded(!expanded)}
                className="ml-auto text-accent hover:underline">
          {expanded ? t('cs.collapse') : t('cs.expand')}
        </button>
      </div>

      {expanded && (
        <div className="space-y-4">
          {data.categories.map((cat) => (
            <CategoryCard key={cat.id} cat={cat} t={t} />
          ))}
        </div>
      )}

      {/* Footer with honest disclaimer */}
      <div className="mt-5 pt-3 border-t border-hairlineSoft text-[10px] text-muted leading-relaxed">
        {t('cs.disclaimer')}
      </div>
    </section>
  )
}

// =========================================================================
// Sub-components
// =========================================================================

function SummaryChip({ label, value, sub, accent }: {
  label: string; value: string; sub?: string;
  accent?: 'positive' | 'warn' | 'muted'
}) {
  const color = accent === 'positive' ? 'text-positive'
    : accent === 'warn'   ? 'text-warn'
    : accent === 'muted'  ? 'text-muted'
    : 'text-ink'
  return (
    <div className="bg-surfaceAlt rounded-md px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`text-[18px] font-semibold tabular-nums mt-0.5 ${color}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted mt-0.5">{sub}</div>}
    </div>
  )
}

function CategoryCard({ cat, t }: {
  cat: VPPComplianceCategory
  t: (k: string, ...a: any[]) => string
}) {
  return (
    <div className="rounded-md border border-hairlineSoft bg-surfaceAlt/30">
      <div className="px-4 py-2.5 border-b border-hairlineSoft flex items-baseline justify-between">
        <div className="flex items-baseline gap-3">
          <span className="text-[13px] font-semibold text-ink">{cat.title}</span>
          {cat.summary && (
            <span className="text-[10px] text-muted tabular-nums">
              {cat.summary.ok} ok · {cat.summary.warn} warn · {cat.summary.breach} breach
            </span>
          )}
        </div>
        {cat.score !== null && (
          <span className={`text-[14px] font-semibold tabular-nums ${scoreColor(cat.score)}`}>
            {cat.score}<span className="text-muted text-[11px] font-normal">/100</span>
          </span>
        )}
      </div>

      {/* Deductions (conduct only) */}
      {cat.deductions && cat.deductions.length > 0 && (
        <div className="px-4 py-2 border-b border-hairlineSoft/50 bg-warn/5">
          <div className="text-[10px] uppercase tracking-wider text-warn mb-1 font-semibold">
            {t('cs.deductions')}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-warn">
            {cat.deductions.map((d, i) => <span key={i}>· {d}</span>)}
          </div>
        </div>
      )}

      {/* Body */}
      <div className="p-3">
        {cat.id === 'rules' && <RulesGrid items={cat.items as VPPComplianceRuleItem[]} />}
        {cat.id === 'conduct' && <ConductList items={cat.items as VPPComplianceConductItem[]}
                                                reasons={cat.reason_distribution ?? []} t={t} />}
        {cat.id === 'contracts' && <ContractsList items={cat.items as VPPComplianceContractItem[]} t={t} />}
        {cat.id === 'data' && <DataList items={cat.items as VPPComplianceDataItem[]} />}
      </div>
    </div>
  )
}

function RulesGrid({ items }: { items: VPPComplianceRuleItem[] }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
      {items.map((it, i) => (
        <div key={i} className="flex items-start gap-2">
          <span className={`mt-0.5 w-1.5 h-1.5 rounded-full ${it.enforced ? 'bg-positive' : 'bg-muted/40'}`} />
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className={`tabular-nums text-[10px] font-mono font-medium ${it.enforced ? 'text-positive' : 'text-muted'}`}>
                {it.ner}
              </span>
              <span className={it.enforced ? 'text-ink2' : 'text-muted line-through'}>
                {it.rule}
              </span>
            </div>
            {it.where && (
              <div className="text-[10px] text-muted font-mono mt-0.5 break-all">
                {it.where}
              </div>
            )}
            {it.note && (
              <div className="text-[10px] text-muted italic mt-0.5">
                ⚠ {it.note}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function ConductList({ items, reasons, t }: {
  items: VPPComplianceConductItem[]
  reasons: { reason: string; count: number }[]
  t: any
}) {
  const totalReasons = reasons.reduce((s, r) => s + r.count, 0)
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
        {items.map((it, i) => {
          const s = ITEM_STATUS_STYLE[it.status]
          return (
            <div key={i} className="flex items-baseline gap-2">
              <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${s.dot}`} />
              <span className="text-ink2 flex-1 min-w-0">{it.metric}</span>
              <span className={`tabular-nums font-medium ${s.fg}`}>{it.value}</span>
              {it.threshold && (
                <span className="text-[10px] text-muted tabular-nums w-16 text-right">{it.threshold}</span>
              )}
            </div>
          )
        })}
      </div>
      {totalReasons > 0 && (
        <div className="pt-2 border-t border-hairlineSoft/50">
          <div className="text-[10px] uppercase tracking-wider text-muted mb-2">
            {t('cs.reasonDist')}
          </div>
          {/* Horizontal stacked bar */}
          <div className="h-2 w-full rounded-full overflow-hidden flex bg-surface">
            {reasons.map((r) => {
              const w = (r.count / totalReasons) * 100
              const isRed = r.reason === 'STRATEGY' || r.reason === 'OTHER'
              return (
                <div key={r.reason}
                     className={isRed ? 'bg-warn' : 'bg-accent/70'}
                     style={{ width: `${w}%` }}
                     title={`${r.reason}: ${r.count} (${w.toFixed(0)}%)`} />
              )
            })}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] tabular-nums">
            {reasons.map((r) => {
              const isRed = r.reason === 'STRATEGY' || r.reason === 'OTHER'
              return (
                <span key={r.reason} className="inline-flex items-center gap-1">
                  <span className={`w-1.5 h-1.5 rounded-full ${isRed ? 'bg-warn' : 'bg-accent/70'}`} />
                  <span className="text-ink2 font-medium">{r.reason}</span>
                  <span className="text-muted">{r.count}</span>
                </span>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function ContractsList({ items, t }: { items: VPPComplianceContractItem[]; t: any }) {
  if (items.length === 0) {
    return <div className="text-[11px] text-muted py-2">{t('cs.contracts.empty')}</div>
  }
  return (
    <div className="space-y-1.5 text-[11px]">
      {items.map((it) => {
        const s = ITEM_STATUS_STYLE[it.status]
        return (
          <div key={it.resource_id} className="flex items-center gap-2">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${s.dot}`} />
            <span className="text-ink2 flex-1 truncate">{it.site_name}</span>
            <div className="flex items-center gap-2 w-32">
              <div className="flex-1 h-1 rounded-full bg-surface overflow-hidden">
                <div className={`h-full ${s.dot}`}
                     style={{ width: `${Math.min(100, it.util_pct)}%` }} />
              </div>
              <span className={`tabular-nums font-medium ${s.fg} w-16 text-right`}>
                {it.events_today}/{it.max_events_per_day}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function DataList({ items }: { items: VPPComplianceDataItem[] }) {
  return (
    <div className="space-y-1.5 text-[11px]">
      {items.map((it, i) => {
        const s = ITEM_STATUS_STYLE[it.status]
        return (
          <div key={i} className="flex items-baseline gap-2">
            <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${s.dot}`} />
            <span className="text-ink2 flex-1 min-w-0 truncate">{it.label}</span>
            <span className="text-[10px] text-muted tabular-nums font-mono">{it.ner}</span>
            <span className={`tabular-nums font-medium w-20 text-right ${s.fg}`}>
              {it.staleness_sec === null ? '—' : staleness(it.staleness_sec)}
            </span>
            {it.target_sec && (
              <span className="text-[10px] text-muted tabular-nums w-16 text-right">
                ≤ {staleness(it.target_sec)}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
