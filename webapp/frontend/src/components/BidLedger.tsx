import { useMemo } from 'react'
import type { Bid, Fill } from '../types'
import { cancelPaperBid } from '../api'
import { useT } from '../i18n'

const STATUS_COLOR: Record<string, string> = {
  PENDING:   'bg-amber-100  text-amber-800',
  SETTLED:   'bg-emerald-100 text-emerald-800',
  CANCELLED: 'bg-zinc-100   text-zinc-600',
  EXPIRED:   'bg-zinc-100   text-zinc-500',
}

// Mirrors the codes in SuggestedBids (AEMO NER 3.8.22A rebid reasons).
// Kept loose (string) so legacy / unknown codes still render gracefully.
const KNOWN_REBID_CODES = new Set([
  'INITIAL', 'PRICE', 'FORECAST', 'DEMAND', 'OUTAGE',
  'RAMP', 'ENERGY_LIMIT', 'TEMPERATURE', 'STRATEGY', 'OTHER',
])

const REBID_CODE_COLOR: Record<string, string> = {
  INITIAL:      'bg-zinc-100   text-zinc-600',
  PRICE:        'bg-amber-100  text-amber-800',
  FORECAST:     'bg-sky-100    text-sky-800',
  DEMAND:       'bg-blue-100   text-blue-800',
  OUTAGE:       'bg-rose-100   text-rose-800',
  RAMP:         'bg-violet-100 text-violet-800',
  ENERGY_LIMIT: 'bg-orange-100 text-orange-800',
  TEMPERATURE:  'bg-red-100    text-red-800',
  STRATEGY:     'bg-emerald-100 text-emerald-800',
  OTHER:        'bg-zinc-100   text-zinc-600',
}

type ParsedNotes = {
  /** Standard rebid code if the notes start with `[CODE] … · rest`. */
  code: string | null
  /** Free-text detail provided alongside the code (max ~128 chars). */
  detail: string | null
  /** Anything after the ` · ` separator — usually the per-leg explanation
   *  produced by the suggestion engine. */
  rest: string | null
}

/** Parse the `[CODE] detail · rest` prefix that SuggestedBids prepends.
 *  Falls back to raw notes when no prefix is present so legacy bids
 *  (or future user-typed notes) still display.  */
function parseNotes(notes: string | null): ParsedNotes {
  if (!notes) return { code: null, detail: null, rest: null }
  const m = /^\[([A-Z_]+)\](?:[ \t]+([^·\n]+?))?[ \t]*·[ \t]*(.*)$/.exec(notes)
  if (!m) return { code: null, detail: null, rest: notes }
  const detail = (m[2] ?? '').trim()
  const rest = m[3].trim()
  return {
    code: m[1],
    detail: detail.length ? detail : null,
    rest: rest.length ? rest : null,
  }
}

function fmtTs(iso: string): string {
  // "2026-05-16T02:15:00" → "16 May · 02:15"
  const d = iso.slice(8, 10)
  const m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(iso.slice(5,7)) - 1] || ''
  return `${d} ${m} · ${iso.slice(11, 16)}`
}

function fmtAud(v: number): string {
  const sign = v >= 0 ? '+' : '−'
  return `${sign}$${Math.abs(v).toLocaleString('en-AU', { maximumFractionDigits: 2 })}`
}

function bidTotalMw(bid: Bid): number {
  return bid.bands.reduce((a, b) => a + b.mw, 0)
}

type Props = {
  bids: Bid[]
  fills: Fill[]
  onChanged: () => void
}

export function BidLedger({ bids, fills, onChanged }: Props) {
  const { t } = useT()

  // Index fills by bid_id for quick lookup.
  const fillByBid = useMemo(() => {
    const m = new Map<number, Fill>()
    fills.forEach((f) => m.set(f.bid_id, f))
    return m
  }, [fills])

  // ---- Rebid chain index ------------------------------------------------
  // A "chain" is a linked list of bids sharing the same (DUID, target,
  // market, direction): the chain root has previous_bid_id=null and each
  // successor points back via previous_bid_id. We expose two things per
  // bid: (a) its 1-indexed position in its chain (v1 = original), (b) the
  // chain length, so the table can show a "v2/3" chip. The chain itself
  // is precomputed so hover-tooltips can list the full history without
  // recomputing per row.
  const chainIndex = useMemo(() => {
    const byId = new Map<number, Bid>()
    bids.forEach((b) => byId.set(b.bid_id, b))
    // Find chain roots = bids with no previous_bid_id pointer
    const successorOf = new Map<number, number>() // prev_id → next_id
    for (const b of bids) {
      if (b.previous_bid_id != null) {
        successorOf.set(b.previous_bid_id, b.bid_id)
      }
    }
    // Walk back from any bid to its root by following previous_bid_id
    const rootOf = new Map<number, number>()
    for (const b of bids) {
      let cur: Bid | undefined = b
      while (cur && cur.previous_bid_id != null) {
        const prev = byId.get(cur.previous_bid_id)
        if (!prev) break
        cur = prev
      }
      rootOf.set(b.bid_id, cur ? cur.bid_id : b.bid_id)
    }
    // Group by root, sort oldest → newest by bid_id
    const chains = new Map<number, Bid[]>()
    for (const b of bids) {
      const root = rootOf.get(b.bid_id) ?? b.bid_id
      if (!chains.has(root)) chains.set(root, [])
      chains.get(root)!.push(b)
    }
    for (const arr of chains.values()) arr.sort((a, b) => a.bid_id - b.bid_id)
    // Per-bid: (chainPos 1-indexed, chainLength, chainArray)
    const meta = new Map<number, { pos: number; len: number; chain: Bid[] }>()
    for (const [root, arr] of chains) {
      arr.forEach((b, i) => meta.set(b.bid_id, { pos: i + 1, len: arr.length, chain: arr }))
      void root
    }
    return { meta, successorOf }
  }, [bids])

  const handleCancel = async (id: number) => {
    if (!confirm(t('ledger.cancelConfirm', id))) return
    try {
      await cancelPaperBid(id)
      onChanged()
    } catch (e: any) {
      alert(e.message || String(e))
    }
  }

  if (bids.length === 0) {
    return (
      <div className="bg-surface rounded-xl2 shadow-card p-6">
        <div className="text-[15px] font-semibold text-ink">{t('ledger.title')}</div>
        <div className="text-[12px] text-muted mt-2">{t('ledger.empty')}</div>
      </div>
    )
  }

  return (
    <div className="bg-surface rounded-xl2 shadow-card p-6">
      <div className="flex items-baseline justify-between mb-3">
        <div className="text-[15px] font-semibold text-ink">{t('ledger.title')}</div>
        <div className="text-[11px] text-muted">{t('ledger.summary', bids.length, fills.length)}</div>
      </div>
      <div className="overflow-x-auto -mx-2">
        <table className="w-full text-[12px]">
          <thead className="text-muted text-[10px] uppercase tracking-wide">
            <tr>
              <th className="text-left  px-2 py-2 font-medium">{t('ledger.col.target')}</th>
              <th className="text-left  px-2 py-2 font-medium">{t('ledger.col.market')}</th>
              <th className="text-left  px-2 py-2 font-medium">{t('ledger.col.reason')}</th>
              <th className="text-right px-2 py-2 font-medium">{t('ledger.col.bidMw')}</th>
              <th className="text-right px-2 py-2 font-medium">{t('ledger.col.cleared')}</th>
              <th className="text-right px-2 py-2 font-medium">{t('ledger.col.filled')}</th>
              <th className="text-right px-2 py-2 font-medium">{t('ledger.col.pnl')}</th>
              <th className="text-center px-2 py-2 font-medium">{t('ledger.col.status')}</th>
              <th className="px-2 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {bids.map((b) => {
              const f = fillByBid.get(b.bid_id)
              const dir = b.direction === 'GEN' ? '↑' : '↓'
              const marketLabel = b.market === 'ENERGY'
                ? (b.direction === 'GEN' ? t('ledger.energyDischarge') : t('ledger.energyCharge'))
                : b.market.replace('RAISE', 'R').replace('LOWER', 'L')
              const parsed = parseNotes(b.notes)
              // Rebid chain chip — show only when chain length > 1
              const chainMeta = chainIndex.meta.get(b.bid_id)
              const isChain = chainMeta != null && chainMeta.len > 1
              const isLatestInChain = isChain && chainMeta!.pos === chainMeta!.len
              const chainTitle = isChain
                ? chainMeta!.chain
                    .map((cb) => `v${chainMeta!.chain.indexOf(cb) + 1} · #${cb.bid_id} · ${fmtTs(cb.submitted_at)} · ${cb.status}`)
                    .join('\n')
                : ''
              const codeKnown = parsed.code != null && KNOWN_REBID_CODES.has(parsed.code)
              const codeLabel = parsed.code == null
                ? null
                : codeKnown ? t(`sug.reason.${parsed.code}`) : parsed.code
              const codeColor = parsed.code == null
                ? ''
                : (REBID_CODE_COLOR[parsed.code] ?? 'bg-zinc-100 text-zinc-600')
              // Build the tooltip: detail (if any) + leg explanation (rest).
              const reasonTitle = [
                codeKnown ? t(`sug.reason.${parsed.code!}`) : parsed.code,
                parsed.detail,
                parsed.rest,
              ].filter(Boolean).join(' · ')
              return (
                <tr
                  key={b.bid_id}
                  className={`border-t border-hairlineSoft tabular-nums ${
                    isChain && !isLatestInChain ? 'opacity-60' : ''
                  }`}
                >
                  <td className="px-2 py-2 text-ink">
                    <div className="flex items-center gap-1.5">
                      <span>{fmtTs(b.target_settlementdate)}</span>
                      {isChain && (
                        <span
                          className={`text-[9px] font-medium px-1.5 py-0.5 rounded ${
                            isLatestInChain
                              ? 'bg-sky-100 text-sky-800'
                              : 'bg-zinc-100 text-zinc-500 line-through'
                          }`}
                          title={t('ledger.chain.title') + '\n' + chainTitle}
                        >
                          {t('ledger.chain.badge', chainMeta!.pos, chainMeta!.len)}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-2 text-ink2">
                    <span className="mr-1" style={{ color: b.direction === 'GEN' ? '#ff9500' : '#34c759' }}>{dir}</span>
                    {marketLabel}
                  </td>
                  <td className="px-2 py-2 text-ink2 max-w-[180px]">
                    {parsed.code ? (
                      <span
                        className="inline-flex items-center gap-1 align-middle"
                        title={reasonTitle}
                      >
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${codeColor}`}>
                          {codeLabel}
                        </span>
                        {parsed.detail && (
                          <span className="truncate text-[11px] text-muted">{parsed.detail}</span>
                        )}
                      </span>
                    ) : parsed.rest ? (
                      <span className="text-[11px] text-muted truncate inline-block max-w-full" title={parsed.rest}>
                        {parsed.rest}
                      </span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td className="px-2 py-2 text-right text-ink2">{bidTotalMw(b).toFixed(1)}</td>
                  <td className="px-2 py-2 text-right text-ink2">
                    {f ? `$${f.cleared_price.toFixed(2)}` : '—'}
                  </td>
                  <td className="px-2 py-2 text-right text-ink2">
                    {f ? Math.abs(f.enabled_mw).toFixed(1) : '—'}
                  </td>
                  <td className="px-2 py-2 text-right" style={{ color: f ? (f.revenue_aud >= 0 ? '#34c759' : '#ff3b30') : '#86868b' }}>
                    {f ? fmtAud(f.revenue_aud) : '—'}
                  </td>
                  <td className="px-2 py-2 text-center">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${STATUS_COLOR[b.status] || ''}`}>
                      {t(`ledger.status.${b.status}`)}
                    </span>
                  </td>
                  <td className="px-2 py-2 text-right">
                    {b.status === 'PENDING' && (
                      <button
                        onClick={() => handleCancel(b.bid_id)}
                        className="text-[10px] text-muted hover:text-negative"
                      >
                        {t('ledger.cancel')}
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
