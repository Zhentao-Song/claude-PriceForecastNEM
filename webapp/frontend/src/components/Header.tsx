import { useT } from '../i18n'

type Props = { generatedAt: string | null; live: boolean }

function fmt(iso: string | null, lang: string): string {
  if (!iso) return '—'
  // Backend sends a NAIVE UTC timestamp (datetime.utcnow().isoformat(), no 'Z').
  // Append 'Z' so JS parses it as UTC, then render in NEM market time
  // (Australia/Brisbane = UTC+10, no DST) so it matches the dispatch clock.
  const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z')
  return d.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-AU', {
    hour12: false, timeZone: 'Australia/Brisbane',
  })
}

export function Header({ generatedAt, live }: Props) {
  const { t, lang, setLang } = useT()
  return (
    <header className="sticky top-0 z-10 bg-white/80 backdrop-blur-xl border-b border-hairlineSoft">
      <div className="max-w-[1400px] mx-auto px-8 py-4 flex items-center justify-between">
        <div className="flex items-center">
          <img
            src="/startye-logo.png"
            alt="StarTye 星星太乙"
            style={{ height: 36, width: 'auto', display: 'block' }}
          />
        </div>
        <div className="flex items-center gap-5 text-[12px]">
          <span className="text-muted tabular-nums">
            {t('header.updated')} <span className="text-ink2">{fmt(generatedAt, lang)}</span>
            <span className="ml-1 text-[10px] text-muted">NEM</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className={`inline-block w-1.5 h-1.5 rounded-full ${
                live ? 'bg-accent animate-pulse' : 'bg-muted'
              }`}
            />
            <span className={live ? 'text-accentInk font-medium' : 'text-muted'}>
              {live ? t('header.live') : t('header.idle')}
            </span>
          </span>
          {/* Language toggle */}
          <div className="flex gap-0.5 p-0.5 bg-surfaceAlt rounded-md">
            {(['en', 'zh'] as const).map((l) => (
              <button
                key={l}
                onClick={() => setLang(l)}
                className={`px-2 py-0.5 text-[11px] rounded transition ${
                  lang === l
                    ? 'bg-white text-ink shadow-sm font-medium'
                    : 'text-muted hover:text-ink'
                }`}
              >
                {t(`header.lang.${l}`)}
              </button>
            ))}
          </div>
        </div>
      </div>
    </header>
  )
}
