import type { FCASMatrix } from '../types'
import { useT } from '../i18n'

const LABEL: Record<string, string> = {
  raise1sec: 'R1', raise6sec: 'R6', raise60sec: 'R60', raise5min: 'R5', raisereg: 'RReg',
  lower1sec: 'L1', lower6sec: 'L6', lower60sec: 'L60', lower5min: 'L5', lowerreg: 'LReg',
}

const REGION_LABEL: Record<string, string> = {
  NSW1: 'NSW', QLD1: 'QLD', VIC1: 'VIC', SA1: 'SA', TAS1: 'TAS',
}

function cellTone(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v as number)) return 'text-hairline'
  const n = v as number
  if (n < 0) return 'text-negative'
  if (n > 50) return 'text-accent font-semibold'
  if (n > 10) return 'text-accentInk'
  return 'text-ink2'
}

function fmtInterval(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleString('en-AU', {
    day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit',
  })
}

export function FCASMatrixView({ data }: { data: FCASMatrix | null }) {
  const { t } = useT()
  if (!data) return <div className="text-muted text-sm">{t('fcas.loading')}</div>
  const ordered = ['raise1sec', 'raise6sec', 'raise60sec', 'raise5min', 'raisereg',
                   'lower1sec', 'lower6sec', 'lower60sec', 'lower5min', 'lowerreg']
  // All regions share a settlementdate within a dispatch interval; surface it once.
  const interval = data.regions[0]?.settlementdate as string | null | undefined
  return (
    <div className="overflow-x-auto">
      {interval && (
        <div className="text-[11px] text-muted mb-2 tabular-nums">
          {t('fcas.dispatchInterval')} · {fmtInterval(interval)}
        </div>
      )}
      <table className="w-full text-[13px] tabular-nums">
        <thead>
          <tr className="text-[11px] text-muted uppercase tracking-wider">
            <th className="text-left font-medium py-3 pr-3">{t('fcas.region')}</th>
            {ordered.map((m) => (
              <th key={m} className="text-right font-medium py-3 pr-3">{LABEL[m]}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.regions.map((r) => (
            <tr key={r.regionid} className="border-t border-hairlineSoft">
              <td className="py-3 pr-3 text-ink font-medium">
                {REGION_LABEL[r.regionid] ?? r.regionid}
              </td>
              {ordered.map((m) => {
                const v = (r as any)[m] as number | null
                return (
                  <td key={m} className={`text-right py-3 pr-3 ${cellTone(v)}`}>
                    {v === null || v === undefined ? '—' : `$${v.toFixed(2)}`}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="text-[11px] text-muted mt-3 leading-relaxed">
        {t('fcas.legend')}
        <br />
        {t('fcas.legend2')}
      </div>
    </div>
  )
}
