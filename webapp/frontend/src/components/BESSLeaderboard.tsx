/**
 * BESSLeaderboard — Modo-style battery revenue league table.
 *
 * Ranks every NEM battery by energy-arbitrage net revenue over the window:
 * discharge earnings (× MLF) minus charging spend (÷ MLF), plus the
 * realised spread ($/MWh out − $/MWh in) — the metric BESS traders compare.
 * Energy-only: FCAS revenue not included, so figures are a floor.
 */
import { useEffect, useState } from 'react'
import { useT } from '../i18n'

type Entry = {
  duid: string; station: string; region: string
  capacity_mw: number | null
  discharged_mwh: number; charged_mwh: number
  revenue_aud: number; charge_cost_aud: number; net_aud: number
  avg_discharge_price: number | null; avg_charge_price: number | null
  spread: number | null
}

function fmtAud(v: number): string {
  const sign = v < 0 ? '−' : ''
  const a = Math.abs(v)
  if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(2)}M`
  if (a >= 1_000) return `${sign}$${(a / 1_000).toFixed(1)}k`
  return `${sign}$${a.toFixed(0)}`
}

const MEDALS = ['🥇', '🥈', '🥉']

export function BESSLeaderboard({ defaultRegion = 'NSW1' }: { defaultRegion?: string }) {
  const { t } = useT()
  const [scope, setScope] = useState<'region' | 'nem'>('region')
  const [hours, setHours] = useState(24)
  const [entries, setEntries] = useState<Entry[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setLoading(true)
    const q = new URLSearchParams({ hours: String(hours) })
    if (scope === 'region') q.set('region', defaultRegion)
    fetch(`/api/grid/bess/leaderboard?${q}`)
      .then((r) => r.json())
      .then((d) => setEntries(d.entries ?? []))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false))
  }, [scope, hours, defaultRegion])

  const maxNet = Math.max(1, ...entries.map((e) => Math.abs(e.net_aud)))

  return (
    <div>
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
        <div>
          <div className="text-[15px] font-semibold tracking-tight text-ink">{t('bessLb.title')}</div>
          <div className="text-[11px] text-muted mt-0.5">{t('bessLb.hint')}</div>
        </div>
        <div className="flex gap-2">
          <div className="flex gap-1 p-0.5 bg-surfaceAlt rounded-lg">
            {([['region', defaultRegion.replace(/1$/, '')], ['nem', t('bessLb.allNem')]] as const).map(([k, label]) => (
              <button key={k} onClick={() => setScope(k)}
                      className={`text-[11px] px-2.5 py-1 rounded-md transition ${
                        scope === k ? 'bg-white text-ink shadow-sm font-medium' : 'text-ink2 hover:text-ink'
                      }`}>
                {label}
              </button>
            ))}
          </div>
          <div className="flex gap-1 p-0.5 bg-surfaceAlt rounded-lg">
            {[24, 72, 168].map((h) => (
              <button key={h} onClick={() => setHours(h)}
                      className={`text-[11px] px-2.5 py-1 rounded-md transition ${
                        hours === h ? 'bg-white text-ink shadow-sm font-medium' : 'text-ink2 hover:text-ink'
                      }`}>
                {h / 24}d
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="h-40 flex items-center justify-center text-muted text-sm">{t('chart.loading')}</div>
      ) : !entries.length ? (
        <div className="h-40 flex items-center justify-center text-muted text-sm">{t('bessLb.noData')}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-[10px] text-muted uppercase tracking-wide border-b border-hairlineSoft">
                <th className="text-left  py-2 pr-2 font-medium">#</th>
                <th className="text-left  py-2 pr-3 font-medium">{t('bessLb.station')}</th>
                <th className="text-right py-2 px-2 font-medium">{t('bessLb.cap')}</th>
                <th className="text-right py-2 px-2 font-medium">{t('bessLb.dis')}</th>
                <th className="text-right py-2 px-2 font-medium">{t('bessLb.sellAvg')}</th>
                <th className="text-right py-2 px-2 font-medium">{t('bessLb.buyAvg')}</th>
                <th className="text-right py-2 px-2 font-medium">{t('bessLb.spread')}</th>
                <th className="text-right py-2 pl-2 font-medium">{t('bessLb.net')}</th>
                <th className="w-[120px] py-2 pl-3"></th>
              </tr>
            </thead>
            <tbody>
              {entries.slice(0, 20).map((e, i) => (
                <tr key={e.duid} className="border-b border-hairlineSoft/60 hover:bg-surfaceAlt/60 transition-colors">
                  <td className="py-2 pr-2 tabular-nums text-muted">
                    {i < 3 ? MEDALS[i] : i + 1}
                  </td>
                  <td className="py-2 pr-3">
                    <div className="font-medium text-ink truncate max-w-[220px]">{e.station}</div>
                    <div className="text-[10px] text-muted font-mono">{e.duid} · {e.region}</div>
                  </td>
                  <td className="py-2 px-2 text-right tabular-nums text-ink2">
                    {e.capacity_mw ? `${e.capacity_mw.toFixed(0)}` : '—'}
                  </td>
                  <td className="py-2 px-2 text-right tabular-nums text-ink2">{e.discharged_mwh.toFixed(0)}</td>
                  <td className="py-2 px-2 text-right tabular-nums" style={{ color: '#34c759' }}>
                    {e.avg_discharge_price != null ? `$${e.avg_discharge_price.toFixed(0)}` : '—'}
                  </td>
                  <td className="py-2 px-2 text-right tabular-nums" style={{ color: '#ff9500' }}>
                    {e.avg_charge_price != null ? `$${e.avg_charge_price.toFixed(0)}` : '—'}
                  </td>
                  <td className="py-2 px-2 text-right tabular-nums font-medium text-ink">
                    {e.spread != null ? `$${e.spread.toFixed(0)}` : '—'}
                  </td>
                  <td className="py-2 pl-2 text-right tabular-nums font-semibold"
                      style={{ color: e.net_aud >= 0 ? '#34c759' : '#ff3b30' }}>
                    {fmtAud(e.net_aud)}
                  </td>
                  <td className="py-2 pl-3">
                    <div className="h-2 rounded-full bg-surfaceAlt overflow-hidden">
                      <div className="h-full rounded-full"
                           style={{
                             width: `${Math.abs(e.net_aud) / maxNet * 100}%`,
                             background: e.net_aud >= 0 ? '#34c759' : '#ff3b30',
                             opacity: 0.75,
                           }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="text-[10px] text-muted mt-2">{t('bessLb.note')}</div>
        </div>
      )}
    </div>
  )
}
