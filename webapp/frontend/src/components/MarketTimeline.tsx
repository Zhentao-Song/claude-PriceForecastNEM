import { useEffect, useMemo, useState } from 'react'
import { fetchTimeline } from '../api'
import type { Timeline, TimelineStage, TimelineStatus } from '../types'
import { useT } from '../i18n'

type Props = {
  /** Optional target interval (ISO). Omit to use "next 5-min". */
  interval?: string | null
  /** Optional DUID to overlay your own day-ahead / rebid history. */
  duid?: string | null
  /** Refresh cadence in ms. Defaults to 30s — fast enough to keep the
   *  gate-closure countdown ticking down naturally. */
  refreshMs?: number
}

/**
 * Visualises one dispatch interval's full lifecycle: BIDDAYOFFER lockdown
 * (yesterday 12:30) → PREDISPATCH / P5MIN forecast runs → gate closure
 * (T−5min) → DISPATCH clearing → preliminary settlement. Stages are
 * placed on a horizontal track and coloured by status — past stages
 * filled, the in-progress one pulsing, future stages outlined. The
 * NOW marker glides between them as time advances.
 *
 * Backed by `/api/bids/timeline` which pulls together row counts from
 * predispatch / dispatch / bid tables and computes statuses server-side.
 */
export function MarketTimeline({ interval, duid, refreshMs = 30000 }: Props) {
  const { t, lang } = useT()
  const [data, setData] = useState<Timeline | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Re-fetch on interval/duid change, and on a recurring timer.
  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true); setError(null)
      try {
        const t = await fetchTimeline(interval ?? undefined, duid ?? undefined)
        if (!cancelled) setData(t)
      } catch (e) {
        if (!cancelled) setError(String((e as Error).message ?? e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    const id = window.setInterval(load, refreshMs)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [interval, duid, refreshMs])

  // Local clock for second-by-second countdown — without re-fetching every sec.
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setTick(x => x + 1), 1000)
    return () => window.clearInterval(id)
  }, [])

  // Compute positions on the [0..1] track relative to a sensible window:
  // BIDDAY → settlement is way too wide, so we anchor the visible window on
  // [bidday_deadline, dispatch.interval_end + 10min] and place settlement as
  // a small marker beyond the dispatch with a "T+7d" label.
  const layout = useMemo(() => layoutStages(data), [data])

  if (loading && !data) {
    return <SkeletonRow />
  }
  if (error || !data) {
    return (
      <div className="text-[12px] text-negative px-3 py-2">
        {t('timeline.error')} {error}
      </div>
    )
  }

  const targetDate = new Date(data.target_interval)
  const nowDate = new Date(data.now)
  // Live "ms since render" so the second hand actually ticks even between
  // the 30s server refreshes.
  const liveNow = new Date(nowDate.getTime() + tick * 1000)

  // Recompute the NOW marker position every tick (=every second) instead of
  // only when server data refreshes. Markers stay where layoutStages put
  // them; only the NOW pointer slides between them.
  const live = computeLivePosition(layout.markers, liveNow.getTime())

  return (
    <div className="space-y-3">
      {/* Headline + DUID overlay */}
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-muted">
            {t('timeline.kicker')}
          </div>
          <div className="text-[20px] font-semibold tracking-tight text-ink leading-tight">
            {t('timeline.title', formatNemTime(targetDate, lang))}
          </div>
          <div className="text-[12px] text-ink2 mt-0.5">
            {t('timeline.subtitle', data.trading_date, `${data.interval_minutes} min`)}
          </div>
        </div>
        {duid && data.duid_state && (
          <div className="text-right text-[11px]">
            <div className="uppercase tracking-[0.2em] text-muted">{t('timeline.yourDuid')} {duid}</div>
            <div className="text-ink mt-0.5">
              {data.duid_state.day_ahead_submitted
                ? t('timeline.dayAheadSubmitted', shortStamp(data.duid_state.day_ahead_submitted, lang))
                : t('timeline.dayAheadMissing')}
            </div>
            <div className="text-ink2">
              {t('timeline.versionsForInterval',
                String(data.duid_state.versions_for_interval),
                data.duid_state.latest_version_submitted
                  ? shortStamp(data.duid_state.latest_version_submitted, lang)
                  : '—')}
            </div>
          </div>
        )}
      </div>

      {/* Track. Tall enough for label + ts + sub-line + countdown + detail
          per marker (up to 5 short lines) without overflowing the card. */}
      <div className="relative h-[160px]">
        {/* Hairline track */}
        <div className="absolute left-0 right-0 top-[58px] h-px bg-hairline" />

        {/* In-progress band(s) — solid colored hairline over the past portion */}
        {layout.spans.map(s => (
          <div
            key={`span-${s.key}`}
            className="absolute top-[57px] h-[3px] rounded-full"
            style={{
              left: `${s.startPct * 100}%`,
              width: `${Math.max(0.5, (s.endPct - s.startPct) * 100)}%`,
              background: s.status === 'complete' ? '#34c759'
                       : s.status === 'in_progress'
                       ? 'linear-gradient(90deg,#34c759,#ff9500)'
                       : 'transparent',
              opacity: s.status === 'upcoming' ? 0 : 1,
            }}
          />
        ))}

        {/* Live "now" marker — slides smoothly via CSS transition every tick.
            Above the dot floats a live-clock badge: wall time + countdown
            to the next milestone. The vertical line connects badge → dot
            ONLY (it doesn't extend below into the label area). */}
        {live.pct >= 0 && live.pct <= 1 && (
          <div
            className="absolute inset-y-0 pointer-events-none"
            style={{
              left: `calc(${live.pct * 100}% - 1px)`,
              transition: 'left 950ms linear',
            }}
          >
            {/* Live clock badge — anchored to the top so it can hover above
                the dot regardless of NOW's horizontal position. */}
            <div
              className="absolute top-0 left-1/2 -translate-x-1/2 px-2.5 py-1 rounded-lg bg-ink text-white shadow-md whitespace-nowrap tabular-nums"
              style={{ minWidth: 96 }}
            >
              <div className="text-[12px] font-semibold leading-none text-center">
                {formatClock(liveNow, lang)}
              </div>
              {live.nextLabel && (
                <div className="text-[10px] text-white/75 leading-tight mt-0.5 flex items-center justify-center gap-1">
                  <span className="truncate max-w-[70px]" title={live.nextLabel}>
                    → {live.nextLabel}
                  </span>
                  <span className="font-semibold" style={{
                    color: live.urgent ? '#ff8a80' : '#ffffff',
                  }}>
                    {live.countdown}
                  </span>
                </div>
              )}
            </div>
            {/* Short connector line: from below the badge down to just above
                the dot. Capped so it never crosses the marker labels below. */}
            <div
              className="absolute left-0 w-[2px] bg-ink/85 rounded-full"
              style={{ top: 36, height: 22 }}
            />
            {/* Chevron at the line's bottom, pointing at the dot */}
            <div
              className="absolute left-1/2 -translate-x-1/2 w-0 h-0"
              style={{
                top: 54,
                borderLeft: '4px solid transparent',
                borderRight: '4px solid transparent',
                borderTop: '5px solid #1d1d1f',
              }}
            />
            {/* Pulsing dot exactly on the hairline track at top:58 */}
            <div
              className="absolute left-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-ink ring-2 ring-white shadow-md timeline-pulse"
              style={{ top: 52 }}
            />
          </div>
        )}

        {/* Stage markers */}
        {layout.markers.map(m => (
          <StageDot key={m.key} m={m} liveNow={liveNow} lang={lang} t={t} />
        ))}
      </div>
    </div>
  )
}

// =========================================================================
// Layout helpers
// =========================================================================

type Marker = {
  key: string
  pct: number
  label: string
  status: TimelineStatus
  ts: Date | null
  detail?: Record<string, unknown>
  rule?: string
  countdownTo?: Date | null
  /** Optional secondary line under the dot. */
  sub?: string
}

type Span = {
  key: string
  startPct: number
  endPct: number
  status: TimelineStatus
}

type Layout = {
  windowStart: number   // unix ms
  windowEnd: number
  nowPct: number
  markers: Marker[]
  spans: Span[]
}

function layoutStages(data: Timeline | null): Layout {
  if (!data) return { windowStart: 0, windowEnd: 1, nowPct: -1, markers: [], spans: [] }

  const now = new Date(data.now).getTime()
  const byKey: Record<string, TimelineStage> = {}
  for (const s of data.stages) byKey[s.key] = s

  // Even-spaced layout: the real time gap between BIDDAYOFFER (T-1 day 12:30)
  // and DISPATCH (T-5min) is ~24h, while gate closure and dispatch sit ~30s
  // apart — laying out by real time crushes everything past the gate into a
  // sliver. Instead we lay markers out as evenly spaced beads on a string and
  // let the NOW indicator interpolate WITHIN whichever segment it's in.

  type Spec = {
    key: string
    label: string
    ts: Date | null
    status: TimelineStatus
    detail?: Record<string, unknown>
    rule?: string
    sub?: string
    countdown?: boolean
  }

  // Fixed chronological order. Each spec pulls its timestamp from the
  // matching server stage. We always include the slot even if the server
  // didn't populate it, so spacing stays stable across renders.
  const specs: Spec[] = [
    {
      key: 'bidday_deadline',
      label: byKey.bidday_deadline?.name ?? 'BIDDAYOFFER',
      ts: byKey.bidday_deadline?.ts ? new Date(byKey.bidday_deadline.ts) : null,
      status: byKey.bidday_deadline?.status ?? 'upcoming',
      detail: byKey.bidday_deadline?.detail,
      rule: byKey.bidday_deadline?.rule,
    },
    {
      key: 'predispatch_start',
      label: 'PREDISPATCH',
      ts: byKey.predispatch?.ts_start ? new Date(byKey.predispatch.ts_start) : null,
      status: byKey.predispatch?.status ?? 'upcoming',
      detail: byKey.predispatch?.detail,
      rule: byKey.predispatch?.rule,
      sub: '30-min cadence',
    },
    {
      key: 'p5min_start',
      label: 'P5MIN',
      ts: byKey.p5min?.ts_start ? new Date(byKey.p5min.ts_start) : null,
      status: byKey.p5min?.status ?? 'upcoming',
      detail: byKey.p5min?.detail,
      rule: byKey.p5min?.rule,
      sub: '5-min cadence',
    },
    {
      key: 'gate_closure',
      label: byKey.gate_closure?.name ?? 'Gate closure',
      ts: byKey.gate_closure?.ts ? new Date(byKey.gate_closure.ts) : null,
      status: byKey.gate_closure?.status ?? 'upcoming',
      detail: byKey.gate_closure?.detail,
      rule: byKey.gate_closure?.rule,
      countdown: true,
    },
    {
      key: 'dispatch',
      label: byKey.dispatch?.name ?? 'DISPATCH',
      ts: byKey.dispatch?.ts ? new Date(byKey.dispatch.ts) : null,
      status: byKey.dispatch?.status ?? 'upcoming',
      detail: byKey.dispatch?.detail,
      rule: byKey.dispatch?.rule,
    },
    {
      key: 'interval_end',
      label: 'Interval end',
      ts: byKey.dispatch?.interval_end ? new Date(byKey.dispatch.interval_end) : null,
      status: byKey.dispatch?.interval_end && new Date(byKey.dispatch.interval_end).getTime() <= now
        ? 'complete' : 'upcoming',
      sub: 'settlement starts',
    },
    {
      key: 'settlement',
      label: byKey.settlement?.name ?? 'Settlement',
      ts: byKey.settlement?.ts ? new Date(byKey.settlement.ts) : null,
      status: byKey.settlement?.status ?? 'upcoming',
      detail: byKey.settlement?.detail,
      rule: byKey.settlement?.rule,
      sub: 'T+7 business days',
    },
  ]

  // Drop slots with no timestamp at all — keeps layout meaningful when
  // the server omits a stage.
  const usable = specs.filter(s => s.ts !== null)
  const N = usable.length
  // Position[i] = (i+1) / (N+1) — gives even margin on both sides so the
  // leftmost / rightmost labels don't bleed off the track.
  const positions = usable.map((_, i) => (i + 1) / (N + 1))

  const markers: Marker[] = usable.map((s, i) => ({
    key: s.key,
    pct: positions[i],
    label: s.label,
    status: s.status,
    ts: s.ts,
    detail: s.detail,
    rule: s.rule,
    sub: s.sub,
    countdownTo: s.countdown ? s.ts : null,
  }))

  // Segments connect consecutive markers. Status:
  //   - both endpoints past now  → complete (solid green hairline)
  //   - left past, right future  → in_progress (gradient)
  //   - both endpoints future    → upcoming (faint)
  const spans: Span[] = []
  for (let i = 0; i < markers.length - 1; i++) {
    const a = markers[i].ts!.getTime()
    const b = markers[i + 1].ts!.getTime()
    let status: TimelineStatus
    if (now >= b) status = 'complete'
    else if (now >= a) status = 'in_progress'
    else status = 'upcoming'
    spans.push({
      key: `seg-${i}`,
      startPct: positions[i],
      endPct: positions[i + 1],
      status,
    })
  }

  // NOW position: find which real-time segment we're in, then map back to
  // the corresponding even-spaced slot proportionally.
  let nowPct = -1
  if (N > 0) {
    const firstTs = usable[0].ts!.getTime()
    const lastTs = usable[N - 1].ts!.getTime()
    if (now <= firstTs) nowPct = positions[0]
    else if (now >= lastTs) nowPct = positions[N - 1]
    else {
      for (let i = 0; i < N - 1; i++) {
        const a = usable[i].ts!.getTime()
        const b = usable[i + 1].ts!.getTime()
        if (now >= a && now <= b) {
          const realFrac = (now - a) / Math.max(1, b - a)
          nowPct = positions[i] + realFrac * (positions[i + 1] - positions[i])
          break
        }
      }
    }
  }

  return {
    windowStart: 0,
    windowEnd: 1,
    nowPct,
    markers,
    spans,
  }
}

// =========================================================================
// Stage dot
// =========================================================================

function StageDot({ m, liveNow, lang, t }: {
  m: Marker; liveNow: Date; lang: 'en'|'zh'; t: (k: string, ...args: any[]) => string
}) {
  const isGate = m.key === 'gate_closure'
  const inProgress = m.status === 'in_progress'
  const complete = m.status === 'complete'

  // Tailwind isn't aware of dynamic class names — use inline styles for the
  // dot colors so we get exactly the palette we want regardless of purge.
  const dotColor = complete ? '#34c759'
    : inProgress ? '#ff9500'
    : (isGate ? '#ff3b30' : '#86868b')
  const ring = complete ? '#34c75933'
    : inProgress ? '#ff950033'
    : (isGate ? '#ff3b3033' : '#0000')

  // Countdown text for gate closure
  let countdown = ''
  if (m.countdownTo && !complete) {
    const ms = m.countdownTo.getTime() - liveNow.getTime()
    if (ms > 0) {
      const s = Math.floor(ms / 1000)
      const mm = Math.floor(s / 60), ss = s % 60
      countdown = mm > 0 ? `${mm}m ${String(ss).padStart(2,'0')}s` : `${ss}s`
    } else {
      countdown = t('timeline.closed')
    }
  }

  return (
    <div
      className="absolute top-[58px]"
      style={{ left: `calc(${m.pct * 100}% - 7px)` }}
    >
      <div
        className={`w-3.5 h-3.5 rounded-full border-2 border-white ${inProgress ? 'animate-pulse' : ''}`}
        style={{ background: dotColor, boxShadow: `0 0 0 5px ${ring}` }}
        title={[
          m.label,
          m.ts ? shortStamp(m.ts.toISOString(), lang) : '',
          m.rule ?? '',
        ].filter(Boolean).join(' · ')}
      />
      {/* Label below the dot. Width-capped so neighbours don't bleed into
          each other; text-wraps as needed. Edge markers (first 8% / last 8%)
          shift to flush-left / flush-right so they don't get clipped. */}
      <div
        className="absolute mt-2 text-[10px] leading-tight w-[120px]"
        style={{
          left: m.pct > 0.92 ? 'auto' : m.pct < 0.08 ? '0' : '50%',
          right: m.pct > 0.92 ? '0' : 'auto',
          transform: m.pct > 0.92 || m.pct < 0.08 ? 'none' : 'translateX(-50%)',
          textAlign: m.pct > 0.92 ? 'right' : m.pct < 0.08 ? 'left' : 'center',
        }}
      >
        <div className="font-medium text-ink truncate" title={m.label}>{m.label}</div>
        {m.ts && <div className="text-muted tabular-nums truncate">{shortStamp(m.ts.toISOString(), lang)}</div>}
        {m.sub && <div className="text-muted truncate">{m.sub}</div>}
        {countdown && (
          <div className="font-medium tabular-nums truncate" style={{ color: isGate ? '#ff3b30' : '#1d1d1f' }}>
            {countdown}
          </div>
        )}
        {/* Stage-specific detail summary */}
        {m.detail && <StageDetail mKey={m.key} detail={m.detail} t={t} />}
      </div>
    </div>
  )
}

function StageDetail({ mKey, detail, t }: {
  mKey: string; detail: Record<string, unknown>; t: (k: string, ...args: any[]) => string
}) {
  // Render at most two compact stats per stage. Avoid noise — only show
  // numbers that exist and are non-zero.
  if (mKey === 'bidday_deadline') {
    const n = Number(detail.duids_with_day_ahead ?? 0)
    if (!n) return null
    return <div className="text-muted">{t('timeline.duidsDayAhead', String(n))}</div>
  }
  if (mKey === 'p5min_start') {
    const runs = Number(detail.runs_so_far ?? 0)
    if (!runs) return null
    return <div className="text-muted">{t('timeline.runsSoFar', String(runs))}</div>
  }
  if (mKey === 'gate_closure') {
    const n = Number(detail.rebid_count_this_interval ?? 0)
    if (!n) return null
    return <div className="text-muted">{t('timeline.rebidsCount', String(n))}</div>
  }
  if (mKey === 'dispatch') {
    const rrp = detail.cleared_rrp_avg
    if (rrp == null) return null
    return <div className="text-accent font-medium">RRP ${Number(rrp).toFixed(2)}</div>
  }
  return null
}

// =========================================================================
// Formatting
// =========================================================================

function formatNemTime(d: Date, lang: 'en'|'zh') {
  return d.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-AU', {
    month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}
function shortStamp(iso: string, lang: 'en'|'zh') {
  const d = new Date(iso)
  return d.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-AU', {
    month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}
/** HH:MM:SS wall clock — used inside the NOW badge for the seconds-ticking
 *  display. NEM time is UTC+10 but `liveNow` is already in NEM local time
 *  because the server hands back NEM-local timestamps. */
function formatClock(d: Date, _lang: 'en'|'zh') {
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

/** Find the NOW marker's interpolated position on the even-spaced track
 *  AND the next milestone we're counting down to. Re-runs every render
 *  (i.e., every second once the live clock is wired up). */
function computeLivePosition(markers: Marker[], nowMs: number): {
  pct: number; nextLabel: string | null; countdown: string; urgent: boolean
} {
  if (markers.length === 0) return { pct: -1, nextLabel: null, countdown: '', urgent: false }

  const firstTs = markers[0].ts!.getTime()
  const lastTs = markers[markers.length - 1].ts!.getTime()
  // Find which segment we're in
  let pct = markers[0].pct
  let nextMarker: Marker | null = markers[0]
  if (nowMs <= firstTs) {
    pct = markers[0].pct
    nextMarker = markers[0]
  } else if (nowMs >= lastTs) {
    pct = markers[markers.length - 1].pct
    nextMarker = null   // nothing left to count down to
  } else {
    for (let i = 0; i < markers.length - 1; i++) {
      const a = markers[i].ts!.getTime()
      const b = markers[i + 1].ts!.getTime()
      if (nowMs >= a && nowMs <= b) {
        const frac = (nowMs - a) / Math.max(1, b - a)
        pct = markers[i].pct + frac * (markers[i + 1].pct - markers[i].pct)
        nextMarker = markers[i + 1]
        break
      }
    }
  }

  let nextLabel: string | null = null
  let countdown = ''
  let urgent = false
  if (nextMarker) {
    nextLabel = nextMarker.label
    const remMs = nextMarker.ts!.getTime() - nowMs
    countdown = formatDuration(remMs)
    // Bright red if < 60s — typical "rush" zone right before gate closure.
    urgent = remMs > 0 && remMs < 60_000
  }
  return { pct, nextLabel, countdown, urgent }
}

/** Format a millisecond duration into the most compact useful string:
 *   <1min  → "42s"
 *   <1h    → "12m 03s"
 *   <1d    → "4h 17m"
 *   ≥1d    → "2d 04h"
 *   past   → "00:00"
 */
function formatDuration(ms: number): string {
  if (ms <= 0) return '00:00'
  const totalSec = Math.floor(ms / 1000)
  const days = Math.floor(totalSec / 86400)
  const hours = Math.floor((totalSec % 86400) / 3600)
  const minutes = Math.floor((totalSec % 3600) / 60)
  const seconds = totalSec % 60
  if (days > 0) return `${days}d ${String(hours).padStart(2, '0')}h`
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

function SkeletonRow() {
  return (
    <div className="h-[140px] flex flex-col gap-3">
      <div className="h-3 w-1/3 bg-surfaceAlt rounded animate-pulse" />
      <div className="h-3 w-1/4 bg-surfaceAlt rounded animate-pulse" />
      <div className="h-px bg-hairline w-full mt-6" />
      <div className="flex gap-8 mt-2">
        {[0,1,2,3,4,5].map(i => (
          <div key={i} className="h-3 w-12 bg-surfaceAlt rounded animate-pulse" />
        ))}
      </div>
    </div>
  )
}
