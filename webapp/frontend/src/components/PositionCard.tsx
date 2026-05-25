import type { BessState } from '../types'
import { useT } from '../i18n'

function fmtAud(v: number): string {
  const sign = v >= 0 ? '+' : '−'
  return `${sign}$${Math.abs(v).toLocaleString('en-AU', { maximumFractionDigits: 0 })}`
}

type Props = {
  state: BessState | null
  loading: boolean
  onTrade: () => void
  onReset: () => void
}

export function PositionCard({ state, loading, onTrade, onReset }: Props) {
  const { t } = useT()
  if (loading || !state) {
    return (
      <div className="bg-surface rounded-xl2 shadow-card p-4">
        <div className="text-[11px] text-muted uppercase tracking-wide">{t('pos.title')}</div>
        <div className="text-[12px] text-muted mt-3">{t('pos.loading')}</div>
      </div>
    )
  }

  const socColor =
    state.soc_pct >= 80 ? '#34c759' :
    state.soc_pct <= 20 ? '#ff9500' : '#1d1d1f'

  return (
    <div className="bg-surface rounded-xl2 shadow-card p-4">
      <div className="flex items-baseline justify-between">
        <div className="text-[11px] text-muted uppercase tracking-wide">
          {t('pos.titleFor', state.duid)}
        </div>
        <button onClick={onReset} className="text-[10px] text-muted hover:text-ink">{t('pos.reset')}</button>
      </div>

      {/* SoC */}
      <div className="mt-3">
        <div className="flex items-baseline justify-between text-[12px]">
          <span className="text-ink2">{t('pos.soc')}</span>
          <span className="tabular-nums font-medium" style={{ color: socColor }}>
            {t('pos.socUnit', state.soc_mwh.toFixed(1), state.capacity_mwh.toFixed(0))}
          </span>
        </div>
        <div className="mt-1 h-2 bg-surfaceAlt rounded overflow-hidden">
          <div
            className="h-full rounded transition-all"
            style={{ width: `${Math.min(100, state.soc_pct)}%`, background: socColor }}
          />
        </div>
        <div className="text-[10px] text-muted text-right mt-0.5 tabular-nums">
          {t('pos.socMeta', state.soc_pct.toFixed(1), state.power_mw, state.rte_pct)}
          {' · '}
          <span title={t('pos.mlfTitle')}>
            {t('pos.mlf', state.mlf.toFixed(3))}
          </span>
        </div>
      </div>

      {/* P&L */}
      <div className="mt-4 grid grid-cols-3 gap-2">
        <PnlCell label={t('pos.todayEnergy')} value={state.today_energy_pnl} />
        <PnlCell label={t('pos.todayFcas')}   value={state.today_fcas_pnl} />
        <PnlCell label={t('pos.cumulative')}  value={state.cumulative_pnl_aud} bold />
      </div>

      {/* Power envelope — shows the BESS dispatch range (−power…0…+power)
          with a marker at the inferred current direction. Adds a visual
          element that explains "what can this thing physically do" and
          fills the vertical space so the sidebar matches the map column. */}
      <div className="mt-4 pt-4 border-t border-hairlineSoft">
        <div className="text-[10px] text-muted uppercase tracking-wide mb-2">
          {t('pos.powerEnvelope')}
        </div>
        <div className="relative h-2 bg-surfaceAlt rounded overflow-hidden">
          {/* Left half = charge band (green tint), right half = discharge (orange tint) */}
          <div className="absolute inset-y-0 left-0 w-1/2"
               style={{ background: 'linear-gradient(90deg,#34c75922,#34c75900)' }} />
          <div className="absolute inset-y-0 left-1/2 w-1/2"
               style={{ background: 'linear-gradient(90deg,#ff950000,#ff950022)' }} />
          {/* Mid axis */}
          <div className="absolute top-0 bottom-0 left-1/2 w-px bg-hairline" />
          {/* Current direction marker — derived from today's energy P&L
              sign as a rough proxy (positive = net discharger). */}
          {(() => {
            const dir = state.today_energy_pnl > 0 ? 0.75
                       : state.today_energy_pnl < 0 ? 0.25 : 0.5
            const col = dir > 0.5 ? '#ff9500' : dir < 0.5 ? '#34c759' : '#86868b'
            return (
              <div className="absolute top-[-2px] w-1 h-3 rounded-full"
                   style={{ left: `calc(${dir * 100}% - 2px)`, background: col }} />
            )
          })()}
        </div>
        <div className="flex justify-between text-[10px] text-muted mt-1 tabular-nums">
          <span>−{state.power_mw.toFixed(0)} MW <span className="text-[9px]">{t('pos.charge')}</span></span>
          <span>0</span>
          <span><span className="text-[9px]">{t('pos.discharge')}</span> +{state.power_mw.toFixed(0)} MW</span>
        </div>
      </div>

      <button
        onClick={onTrade}
        className="mt-4 w-full text-[13px] px-4 py-2.5 rounded-md bg-accent text-white font-medium hover:opacity-90"
      >
        {t('pos.submitBid')}
      </button>

      {state.last_settled_interval && (
        <div className="text-[10px] text-muted mt-2 tabular-nums text-center">
          {t('pos.lastSettledFmt', state.last_settled_interval.slice(11, 16))}
        </div>
      )}
    </div>
  )
}

function PnlCell({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  const color = value > 0 ? '#34c759' : value < 0 ? '#ff3b30' : '#86868b'
  return (
    <div className="bg-surfaceAlt rounded-md px-2 py-2">
      <div className="text-[9px] text-muted uppercase tracking-wide truncate">{label}</div>
      <div
        className={`text-[14px] tabular-nums ${bold ? 'font-semibold' : ''} mt-0.5`}
        style={{ color }}
      >
        {fmtAud(value)}
      </div>
    </div>
  )
}
