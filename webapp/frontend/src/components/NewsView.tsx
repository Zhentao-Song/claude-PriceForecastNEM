/**
 * NewsView — "NEWS" top-level tab.
 *
 * Two streams in one page:
 *   · Australian energy-market news — RSS from RenewEconomy, pv-magazine,
 *     Energy Magazine, The Driven. Cards with image, source, excerpt and a
 *     link straight to the original article (opens in a new tab).
 *   · AEMO market notices — the official LOR / intervention / price feed,
 *     same data as the global ticker, here in a full filterable list.
 *
 * A segmented control switches between 全部 / 新闻 / AEMO 公告.
 */
import { useEffect, useMemo, useState } from 'react'
import { useT } from '../i18n'

type Article = {
  url: string
  title: string
  source: string
  author: string | null
  published_at: string | null
  summary: string | null
  image_url: string | null
  categories: string[]
}

type Notice = {
  notice_id: number
  notice_type: string
  type_description: string | null
  creation_date: string | null
  external_ref: string | null
  reason: string | null
}

// Shared with the ticker — keep colours consistent across the app.
function noticeColor(type: string): { bg: string; fg: string } {
  const t = type.toUpperCase()
  if (t.includes('LOR2') || t.includes('LOR3') || t.includes('DIRECTION') || t.includes('INTERVENTION'))
    return { bg: '#ff3b30', fg: '#fff' }
  if (t.includes('RESERVE') || t.includes('LOR')) return { bg: '#ff9500', fg: '#fff' }
  if (t.includes('RECLASSIF')) return { bg: '#af52de', fg: '#fff' }
  if (t.includes('TRANSFER') || t.includes('CONSTRAINT')) return { bg: '#0a84ff', fg: '#fff' }
  if (t.includes('PRICE')) return { bg: '#86868b', fg: '#fff' }
  return { bg: '#1d1d1f', fg: '#fff' }
}

const NOTICE_TYPE_ZH: Record<string, string> = {
  'RESERVE NOTICE': '储备预警 (LOR)', 'RECLASSIFY CONTINGENCY': '重大意外事件重分类',
  'MARKET INTERVENTION': '市场干预', 'INTER-REGIONAL TRANSFER': '跨区输电限额',
  'NON-CONFORMANCE': '机组不符合调度', 'PRICES SUBJECT TO REVIEW': '价格待复核',
  'PRICES UNCHANGED': '价格确认无误', 'PRICE': '价格', 'PRICE ERROR': '价格错误',
  'MARKET SYSTEMS': '市场系统', 'SETTLEMENTS RESIDUE': '结算残差', 'CONSTRAINTS': '约束',
  'GENERAL NOTICE': '一般公告', 'POWER SYSTEM EVENTS': '电力系统事件', 'LOAD SHEDDING': '减载',
}
function noticeTypeLabel(type: string, lang: string): string {
  if (lang !== 'zh') return type
  return NOTICE_TYPE_ZH[type.toUpperCase().trim()] ?? type
}

const SOURCE_COLOR: Record<string, string> = {
  'RenewEconomy': '#34c759',
  'pv-magazine AU': '#ff9500',
  'Energy Magazine': '#0a84ff',
  'The Driven': '#af52de',
}

function timeAgo(iso: string | null, lang: string): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return iso.slice(0, 16).replace('T', ' ')
  const mins = Math.floor((Date.now() - then) / 60000)
  if (mins < 60) return lang === 'zh' ? `${mins} 分钟前` : `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return lang === 'zh' ? `${hrs} 小时前` : `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return lang === 'zh' ? `${days} 天前` : `${days}d ago`
}

export function NewsView() {
  const { t, lang } = useT()
  const [tab, setTab] = useState<'all' | 'news' | 'notices'>('all')
  const [articles, setArticles] = useState<Article[]>([])
  const [notices, setNotices] = useState<Notice[]>([])
  const [sourceF, setSourceF] = useState('')
  const [sources, setSources] = useState<string[]>([])
  const [expanded, setExpanded] = useState<number | null>(null)

  useEffect(() => {
    fetch('/api/news?limit=80')
      .then((r) => r.json())
      .then((d) => { setArticles(d.articles ?? []); setSources(d.sources ?? []) })
      .catch(() => {})
    fetch('/api/notices?limit=60')
      .then((r) => r.json())
      .then((d) => setNotices(d.notices ?? []))
      .catch(() => {})
  }, [])

  const shownArticles = useMemo(
    () => (sourceF ? articles.filter((a) => a.source === sourceF) : articles),
    [articles, sourceF],
  )

  return (
    <div>
      {/* Segmented control + source filter */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div className="flex gap-1 p-0.5 bg-surfaceAlt rounded-lg">
          {([['all', t('news.tabAll')], ['news', t('news.tabNews')], ['notices', t('news.tabNotices')]] as const)
            .map(([k, label]) => (
              <button key={k} onClick={() => setTab(k)}
                      className={`text-[13px] px-4 py-1.5 rounded-md transition font-medium ${
                        tab === k ? 'bg-white text-ink shadow-sm' : 'text-ink2 hover:text-ink'
                      }`}>
                {label}
              </button>
            ))}
        </div>
        {tab !== 'notices' && sources.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <button onClick={() => setSourceF('')}
                    className={`text-[11px] px-2.5 py-1 rounded-full border transition ${
                      !sourceF ? 'bg-ink text-white border-ink' : 'border-hairlineSoft text-ink2 hover:text-ink'
                    }`}>
              {t('news.allSources')}
            </button>
            {sources.map((s) => (
              <button key={s} onClick={() => setSourceF(s)}
                      className={`text-[11px] px-2.5 py-1 rounded-full border transition ${
                        sourceF === s ? 'text-white border-transparent' : 'border-hairlineSoft text-ink2 hover:text-ink'
                      }`}
                      style={sourceF === s ? { background: SOURCE_COLOR[s] ?? '#1d1d1f' } : undefined}>
                {s}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* News cards */}
      {tab !== 'notices' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
          {shownArticles.map((a) => (
            <a key={a.url} href={a.url} target="_blank" rel="noopener noreferrer"
               className="group flex flex-col rounded-xl2 bg-surface border border-hairlineSoft shadow-sm
                          overflow-hidden hover:shadow-card transition-shadow">
              {a.image_url && (
                <div className="h-40 overflow-hidden bg-surfaceAlt">
                  <img src={a.image_url} alt="" loading="lazy"
                       className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                       onError={(e) => { (e.currentTarget.parentElement as HTMLElement).style.display = 'none' }} />
                </div>
              )}
              <div className="flex flex-col flex-1 p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full text-white"
                        style={{ background: SOURCE_COLOR[a.source] ?? '#1d1d1f' }}>
                    {a.source}
                  </span>
                  <span className="text-[10px] text-muted">{timeAgo(a.published_at, lang)}</span>
                </div>
                <h3 className="text-[14px] font-semibold text-ink leading-snug mb-2 line-clamp-3
                               group-hover:text-accent transition-colors">
                  {a.title}
                </h3>
                {a.summary && (
                  <p className="text-[12px] text-muted leading-relaxed line-clamp-3 mb-3">{a.summary}</p>
                )}
                <div className="mt-auto flex items-center gap-2 text-[11px] text-muted">
                  {a.author && <span className="truncate">{a.author}</span>}
                  <span className="ml-auto text-accent group-hover:underline">{t('news.readMore')} ↗</span>
                </div>
              </div>
            </a>
          ))}
          {!shownArticles.length && (
            <div className="col-span-full h-32 flex items-center justify-center text-muted text-sm">
              {t('news.loading')}
            </div>
          )}
        </div>
      )}

      {/* AEMO notices list */}
      {tab !== 'news' && (
        <div>
          {tab === 'all' && (
            <div className="text-[15px] font-semibold tracking-tight text-ink mb-3">{t('news.aemoSection')}</div>
          )}
          <div className="rounded-xl2 bg-surface border border-hairlineSoft shadow-sm overflow-hidden">
            {notices.map((n) => {
              const c = noticeColor(n.notice_type)
              const isExp = expanded === n.notice_id
              return (
                <div key={n.notice_id}
                     className="px-4 py-3 border-b border-hairlineSoft last:border-b-0 cursor-pointer hover:bg-surfaceAlt transition-colors"
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
                      {lang === 'zh' && <div className="text-[10px] text-muted mb-1">{t('notices.enOnly')}</div>}
                      <pre className="text-[11px] text-ink2 whitespace-pre-wrap font-mono bg-surfaceAlt rounded-lg p-3 max-h-72 overflow-y-auto">
                        {n.reason}
                      </pre>
                    </div>
                  )}
                </div>
              )
            })}
            {!notices.length && (
              <div className="h-24 flex items-center justify-center text-muted text-sm">{t('news.loading')}</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
