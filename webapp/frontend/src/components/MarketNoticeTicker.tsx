/**
 * MarketNoticeTicker — AEMO market notice event stream.
 *
 * Collapsed: a single-line horizontal auto-scrolling ticker (news-bar style)
 * under the header showing the latest notices — LOR reserve warnings,
 * price-cap events, interventions, transfer-limit variations.
 *
 * Click → expandable panel listing recent notices with type chips and
 * expandable reason text. Polls /api/notices every 60 s.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../i18n'

type Notice = {
  notice_id: number
  notice_type: string
  type_description: string | null
  creation_date: string | null
  external_ref: string | null
  reason: string | null
}

// Colour-code by how much an operator should care.
function noticeColor(type: string): { bg: string; fg: string } {
  const t = type.toUpperCase()
  if (t.includes('LOR2') || t.includes('LOR3') || t.includes('DIRECTION') || t.includes('INTERVENTION'))
    return { bg: '#ff3b30', fg: '#fff' }            // red — actual scarcity / AEMO stepping in
  if (t.includes('RESERVE') || t.includes('LOR'))
    return { bg: '#ff9500', fg: '#fff' }            // orange — forecast LOR
  if (t.includes('RECLASSIF'))
    return { bg: '#af52de', fg: '#fff' }            // purple — credible contingency change
  if (t.includes('TRANSFER') || t.includes('CONSTRAINT'))
    return { bg: '#0a84ff', fg: '#fff' }            // blue — network
  if (t.includes('PRICE'))
    return { bg: '#86868b', fg: '#fff' }            // grey — routine price confirmations
  return { bg: '#1d1d1f', fg: '#fff' }              // ink — everything else
}

function timeShort(iso: string | null): string {
  if (!iso) return ''
  return iso.slice(5, 16).replace('T', ' ')  // "06-10 15:17"
}

// AEMO notice-type enum → Chinese. The type chip is what users scan first,
// so it's the highest-value thing to localise. Free-text fields
// (external_ref, reason) stay in AEMO's authoritative English — official
// market notices are read in English industry-wide and machine-translating
// operational/legal text would introduce risk. Unknown types fall through
// to the raw AEMO string.
const NOTICE_TYPE_ZH: Record<string, string> = {
  'RESERVE NOTICE':          '储备预警 (LOR)',
  'RECLASSIFY CONTINGENCY':  '重大意外事件重分类',
  'MARKET INTERVENTION':     '市场干预',
  'INTER-REGIONAL TRANSFER': '跨区输电限额',
  'NON-CONFORMANCE':         '机组不符合调度',
  'PRICES SUBJECT TO REVIEW':'价格待复核',
  'PRICES UNCHANGED':        '价格确认无误',
  'PRICE':                   '价格',
  'PRICE ERROR':             '价格错误',
  'MARKET SYSTEMS':          '市场系统',
  'SETTLEMENTS RESIDUE':     '结算残差',
  'CONSTRAINTS':             '约束',
  'GENERAL NOTICE':          '一般公告',
  'POWER SYSTEM EVENTS':     '电力系统事件',
  'LOAD SHEDDING':           '减载',
}

function noticeTypeLabel(type: string, lang: string): string {
  if (lang !== 'zh') return type
  return NOTICE_TYPE_ZH[type.toUpperCase().trim()] ?? type
}

export function MarketNoticeTicker() {
  const { t, lang } = useT()
  const [notices, setNotices] = useState<Notice[]>([])
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<number | null>(null)
  const trackRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    const load = () =>
      fetch('/api/notices?limit=40')
        .then((r) => r.json())
        .then((d) => { if (alive) setNotices(d.notices ?? []) })
        .catch(() => {})
    load()
    const id = setInterval(load, 60_000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  // Ticker shows the non-routine ones first; routine price confirmations
  // only if there's nothing else.
  const tickerItems = useMemo(() => {
    const interesting = notices.filter((n) => !n.notice_type.toUpperCase().includes('PRICES UNCHANGED'))
    return (interesting.length >= 3 ? interesting : notices).slice(0, 12)
  }, [notices])

  // Animation duration scales with content length so speed stays constant.
  const duration = Math.max(30, tickerItems.length * 9)

  if (!notices.length) return null

  return (
    <div className="mt-3">
      {/* Collapsed ticker bar */}
      <div
        className="relative overflow-hidden rounded-xl bg-surface border border-hairlineSoft shadow-sm cursor-pointer select-none"
        onClick={() => setOpen((v) => !v)}
        title={t('notices.clickHint')}
      >
        <div className="flex items-center">
          {/* Static label chip */}
          <div className="flex-shrink-0 z-10 flex items-center gap-1.5 px-3 py-2 bg-surface border-r border-hairlineSoft">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-60" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-accent" />
            </span>
            <span className="text-[11px] font-semibold text-ink whitespace-nowrap">{t('notices.title')}</span>
          </div>

          {/* Scrolling track — content duplicated for a seamless loop */}
          <div className="flex-1 overflow-hidden relative">
            <div
              ref={trackRef}
              className="flex whitespace-nowrap will-change-transform"
              style={{ animation: `notice-marquee ${duration}s linear infinite` }}
              onMouseEnter={() => { if (trackRef.current) trackRef.current.style.animationPlayState = 'paused' }}
              onMouseLeave={() => { if (trackRef.current) trackRef.current.style.animationPlayState = 'running' }}
            >
              {[0, 1].map((dup) => (
                <div key={dup} className="flex items-center gap-6 pr-6">
                  {tickerItems.map((n) => {
                    const c = noticeColor(n.notice_type)
                    return (
                      <span key={`${dup}-${n.notice_id}`} className="inline-flex items-center gap-2 py-2">
                        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded"
                              style={{ background: c.bg, color: c.fg }}>
                          {noticeTypeLabel(n.notice_type, lang)}
                        </span>
                        <span className="text-[11px] text-muted tabular-nums">{timeShort(n.creation_date)}</span>
                        <span className="text-[12px] text-ink2">{n.external_ref ?? n.type_description ?? ''}</span>
                      </span>
                    )
                  })}
                </div>
              ))}
            </div>
          </div>

          <div className="flex-shrink-0 px-3 text-[11px] text-muted">{open ? '▲' : '▼'}</div>
        </div>
      </div>

      {/* Expanded panel */}
      {open && (
        <div className="mt-2 rounded-xl bg-surface border border-hairlineSoft shadow-card max-h-[420px] overflow-y-auto">
          {notices.map((n) => {
            const c = noticeColor(n.notice_type)
            const isExp = expanded === n.notice_id
            return (
              <div key={n.notice_id}
                   className="px-4 py-2.5 border-b border-hairlineSoft last:border-b-0 cursor-pointer hover:bg-surfaceAlt transition-colors"
                   onClick={() => setExpanded(isExp ? null : n.notice_id)}>
                <div className="flex items-center gap-2.5">
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded flex-shrink-0"
                        style={{ background: c.bg, color: c.fg }}>
                    {noticeTypeLabel(n.notice_type, lang)}
                  </span>
                  <span className="text-[11px] text-muted tabular-nums flex-shrink-0">{n.creation_date ?? ''}</span>
                  <span className="text-[12px] text-ink truncate">{n.external_ref ?? n.type_description ?? ''}</span>
                  <span className="ml-auto text-[10px] text-muted flex-shrink-0">#{n.notice_id}</span>
                </div>
                {isExp && n.reason && (
                  <div className="mt-2">
                    {lang === 'zh' && (
                      <div className="text-[10px] text-muted mb-1">{t('notices.enOnly')}</div>
                    )}
                    <pre className="text-[11px] text-ink2 whitespace-pre-wrap font-mono bg-surfaceAlt rounded-lg p-3 max-h-64 overflow-y-auto">
                      {n.reason}
                    </pre>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Marquee keyframes — scroll exactly one copy's width for a perfect loop */}
      <style>{`
        @keyframes notice-marquee {
          0%   { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
      `}</style>
    </div>
  )
}
