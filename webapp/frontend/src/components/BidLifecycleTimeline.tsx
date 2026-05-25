import { useMemo, useState } from 'react'
import { useT } from '../i18n'

/**
 * BidLifecycleTimeline — visual walkthrough of an AEMO bid going through
 * its full lifecycle, from BIDDAYOFFER lock at D-1 12:30 to final
 * settlement at T+15 business days.
 *
 * Designed as a learning aid for new team members: each stage is tagged
 * with the relevant NER rule, the responsible actor (participant / AEMO /
 * AER), what physical action happens, and which file in our codebase
 * implements/honours that stage. Click a stage to expand the detail panel.
 *
 * Note: the lifecycle spans ~30 calendar days end-to-end so we DON'T try
 * to render time-proportional spacing. Stages are equally spaced; the
 * actual relative time appears under each node.
 */

type Actor = 'participant' | 'aemo' | 'aer'

type Stage = {
  key: string
  /** Relative time anchor (e.g. "T−12:30 (D−1)"). Computed at render time
   *  from the next dispatch interval for the "today's example" line. */
  computeTime: (anchor: Date) => string
  /** Stage display name + one-line subtitle. */
  titleKey: string
  subtitleKey: string
  /** NER citation(s) — appears in the chip below the dot. */
  ner: string
  actor: Actor
  /** Detail body shown when this stage is selected. */
  detailKey: string
  /** Pointer to where this is implemented in our codebase. */
  implRef?: string
  /** Whether this stage is something participants DO vs AEMO does TO
   *  them. Drives the dot colour ramp. */
  participantStage: boolean
}

const ACTOR_STYLE: Record<Actor, { bg: string; fg: string; label: string }> = {
  participant: { bg: 'bg-accent/12',   fg: 'text-accent',   label: 'Participant' },
  aemo:        { bg: 'bg-positive/12', fg: 'text-positive', label: 'AEMO' },
  aer:         { bg: 'bg-negative/12', fg: 'text-negative', label: 'AER' },
}

// ---- Time helpers --------------------------------------------------------

function nemNow(): Date {
  // NEM is UTC+10 (no DST in AEMO operational time)
  return new Date(Date.now() + 10 * 3600 * 1000)
}

function ceilToDispatch(d: Date): Date {
  const m = d.getUTCMinutes() - (d.getUTCMinutes() % 5)
  const r = new Date(d)
  r.setUTCMinutes(m, 0, 0)
  if (r <= d) r.setUTCMinutes(r.getUTCMinutes() + 5)
  return r
}

/** Add N business days (Mon-Fri) to a date — for AEMO settlement timing. */
function addBusinessDays(d: Date, n: number): Date {
  const r = new Date(d)
  let added = 0
  while (added < n) {
    r.setUTCDate(r.getUTCDate() + 1)
    const dow = r.getUTCDay()  // 0 = Sun, 6 = Sat
    if (dow !== 0 && dow !== 6) added++
  }
  return r
}

function fmt(d: Date, withDate = true): string {
  const date = d.toISOString().slice(0, 10)
  const time = d.toISOString().slice(11, 16)
  return withDate ? `${date} ${time}` : time
}

// ---- Stage catalogue -----------------------------------------------------
//
// Eight stages picked to cover the full AEMO bid lifecycle. Some real-life
// sub-stages are collapsed (e.g. NEMDE optimisation + dispatch instruction
// are merged into one node) to keep the visualisation scannable.

const STAGES: Stage[] = [
  {
    key: 'bidday_lock',
    computeTime: (a) => {
      // BIDDAYOFFER lock is at 12:30 on D-1 (the day before the trading day).
      const d = new Date(a)
      d.setUTCDate(d.getUTCDate() - 1)
      d.setUTCHours(12, 30, 0, 0)
      return fmt(d)
    },
    titleKey: 'lc.stage.bidday.title',
    subtitleKey: 'lc.stage.bidday.subtitle',
    ner: 'NER 3.8.6',
    actor: 'participant',
    detailKey: 'lc.stage.bidday.detail',
    implRef: 'backend/app/routes/vpp.py · submit_trading_day()',
    participantStage: true,
  },
  {
    key: 'bidper_rebid',
    computeTime: () => 'D-1 12:30 → T-5min',
    titleKey: 'lc.stage.bidper.title',
    subtitleKey: 'lc.stage.bidper.subtitle',
    ner: 'NER 3.8.22A',
    actor: 'participant',
    detailKey: 'lc.stage.bidper.detail',
    implRef: 'backend/app/routes/vpp.py · submit_bid(rebid_reason)',
    participantStage: true,
  },
  {
    key: 'gate_close',
    computeTime: (a) => {
      const d = new Date(a)
      d.setUTCMinutes(d.getUTCMinutes() - 5)
      return fmt(d, false)
    },
    titleKey: 'lc.stage.gate.title',
    subtitleKey: 'lc.stage.gate.subtitle',
    ner: 'NER 3.8.20',
    actor: 'aemo',
    detailKey: 'lc.stage.gate.detail',
    implRef: 'backend/app/routes/vpp.py · _check_gate_closure()',
    participantStage: false,
  },
  {
    key: 'nemde',
    computeTime: () => 'T-5min → T-0',
    titleKey: 'lc.stage.nemde.title',
    subtitleKey: 'lc.stage.nemde.subtitle',
    ner: 'NER 3.8.7-9, 3.8.21',
    actor: 'aemo',
    detailKey: 'lc.stage.nemde.detail',
    implRef: '(not modelled — would receive dispatch target via SCADA)',
    participantStage: false,
  },
  {
    key: 'dispatch',
    computeTime: (a) => `${fmt(a, false)} → ${fmt(new Date(a.getTime() + 5*60000), false)}`,
    titleKey: 'lc.stage.dispatch.title',
    subtitleKey: 'lc.stage.dispatch.subtitle',
    ner: 'NER 3.8 · MASS',
    actor: 'participant',
    detailKey: 'lc.stage.dispatch.detail',
    implRef: 'backend/app/vpp_settle.py · _cleared_mw() (MaxAvail cap)',
    participantStage: true,
  },
  {
    key: 'rrp_publish',
    computeTime: (a) => fmt(new Date(a.getTime() + 5*60000), false),
    titleKey: 'lc.stage.rrp.title',
    subtitleKey: 'lc.stage.rrp.subtitle',
    ner: 'NER 3.13.4',
    actor: 'aemo',
    detailKey: 'lc.stage.rrp.detail',
    implRef: 'backend/app/scrapers/nem.py · DispatchIS polling (60s)',
    participantStage: false,
  },
  {
    key: 'preliminary',
    computeTime: (a) => fmt(addBusinessDays(a, 1)),
    titleKey: 'lc.stage.prelim.title',
    subtitleKey: 'lc.stage.prelim.subtitle',
    ner: 'NER 3.15.13',
    actor: 'aemo',
    detailKey: 'lc.stage.prelim.detail',
    implRef: '⚠ NOT modelled — we shadow-settle via RRP × MWh × MLF',
    participantStage: false,
  },
  {
    key: 'final',
    computeTime: (a) => fmt(addBusinessDays(a, 15)),
    titleKey: 'lc.stage.final.title',
    subtitleKey: 'lc.stage.final.subtitle',
    ner: 'NER 3.15.14',
    actor: 'aemo',
    detailKey: 'lc.stage.final.detail',
    implRef: '⚠ NOT modelled — no AEMO settlement statement reconciliation',
    participantStage: false,
  },
]

// ---- Component -----------------------------------------------------------

export function BidLifecycleTimeline() {
  const { t } = useT()
  const [expanded, setExpanded] = useState(false)
  const [selected, setSelected] = useState<string>('gate_close')

  // Anchor = the NEXT dispatch interval after current NEM time. Drives the
  // "today's example" timestamps under each node.
  const anchor = useMemo(() => ceilToDispatch(nemNow()), [])

  const currentStage = useMemo<Stage | null>(() => STAGES.find(s => s.key === selected) ?? null,
    [selected])

  return (
    <section className="bg-surface rounded-xl2 p-6 shadow-card">
      <div className="flex items-baseline justify-between mb-3 flex-wrap gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-muted">
            {t('lc.kicker')}
          </div>
          <div className="text-[15px] font-semibold tracking-tight text-ink mt-0.5">
            {t('lc.title')}
          </div>
          <div className="text-[12px] text-muted mt-0.5">{t('lc.hint')}</div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-muted">
            {t('lc.anchor')}
          </div>
          <div className="text-[13px] text-ink2 tabular-nums">
            T<sub>+0</sub> = {fmt(anchor)} NEM
          </div>
          <button
            onClick={() => setExpanded(!expanded)}
            className="mt-1 text-[11px] text-accent hover:underline inline-flex items-center gap-1"
          >
            <span className={`inline-block transition-transform ${expanded ? 'rotate-90' : ''}`}>▸</span>
            {expanded ? t('lc.collapse') : t('lc.expand')}
          </button>
        </div>
      </div>

      {/* ---- Timeline ---- */}
      <div className="relative pt-2 pb-4">
        {/* Background spine */}
        <div className="absolute left-[5%] right-[5%] top-[42px] h-px bg-hairlineSoft" />

        {/* Stage nodes */}
        <div className="relative grid" style={{ gridTemplateColumns: `repeat(${STAGES.length}, minmax(0, 1fr))` }}>
          {STAGES.map((s) => {
            const isSel = s.key === selected
            const actor = ACTOR_STYLE[s.actor]
            return (
              <div key={s.key} className="flex flex-col items-center text-center px-1">
                {/* Time label above */}
                <div className="text-[9px] text-muted tabular-nums leading-tight h-8 flex items-end justify-center">
                  {s.computeTime(anchor)}
                </div>
                {/* Node dot */}
                <button
                  onClick={() => { setSelected(s.key); setExpanded(true) }}
                  className={`mt-1 w-3.5 h-3.5 rounded-full ring-4 ring-surface transition-all hover:scale-125 ${
                    isSel
                      ? 'bg-accent shadow-[0_0_0_4px_rgba(255,149,0,0.18)]'
                      : s.participantStage ? 'bg-accent/40 hover:bg-accent/70'
                                            : 'bg-positive/40 hover:bg-positive/70'
                  }`}
                  title={t(s.titleKey)}
                />
                {/* Stage title below */}
                <div className={`mt-3 text-[11px] font-medium leading-tight ${isSel ? 'text-ink' : 'text-ink2'}`}>
                  {t(s.titleKey)}
                </div>
                {/* Actor + NER chip */}
                <div className="mt-1.5 flex flex-col items-center gap-1">
                  <span className={`text-[9px] px-1.5 py-px rounded-full font-medium leading-none ${actor.bg} ${actor.fg}`}>
                    {actor.label}
                  </span>
                  <span className="text-[9px] text-muted tabular-nums leading-none">
                    {s.ner}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* ---- Expanded detail panel ---- */}
      {expanded && currentStage && (
        <div className="mt-2 rounded-md border border-hairlineSoft bg-surfaceAlt/40 p-4">
          <div className="flex items-baseline justify-between mb-2 flex-wrap gap-2">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-[15px] font-semibold text-ink">
                {t(currentStage.titleKey)}
              </span>
              <span className="text-[11px] text-muted">{t(currentStage.subtitleKey)}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${ACTOR_STYLE[currentStage.actor].bg} ${ACTOR_STYLE[currentStage.actor].fg}`}>
                {ACTOR_STYLE[currentStage.actor].label}
              </span>
              <span className="text-[10px] text-muted font-medium tabular-nums px-2 py-0.5 rounded bg-surface ring-1 ring-hairlineSoft">
                {currentStage.ner}
              </span>
            </div>
          </div>
          <div className="text-[12px] text-ink2 leading-relaxed">
            {t(currentStage.detailKey)}
          </div>
          {currentStage.implRef && (
            <div className="mt-3 pt-3 border-t border-hairlineSoft/50">
              <div className="text-[10px] uppercase tracking-wider text-muted mb-1">
                {t('lc.impl')}
              </div>
              <code className="text-[11px] text-ink2 font-mono break-all">
                {currentStage.implRef}
              </code>
            </div>
          )}
          <div className="mt-3 pt-3 border-t border-hairlineSoft/50 text-[10px] text-muted">
            {t('lc.example', currentStage.computeTime(anchor))}
          </div>
        </div>
      )}

      {/* ---- Legend ---- */}
      <div className="mt-3 flex items-center gap-4 text-[10px] text-muted">
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-accent/60" />
          {t('lc.legend.participant')}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-positive/60" />
          {t('lc.legend.aemo')}
        </span>
        <span className="ml-auto text-muted/70">
          {t('lc.legend.clickHint')}
        </span>
      </div>
    </section>
  )
}
