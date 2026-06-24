/**
 * FCASTrapeziuBuilder — Interactive FCAS enablement trapezium editor.
 *
 * The FCAS co-optimisation trapezium (NER 3.8.7A + MASS) defines the shape of
 * the joint ENERGY + FCAS feasible region in NEMDE. Four MW points form the
 * trapezoid:
 *
 *   EnablementMin (EnMin) — minimum energy dispatch that *enables* any FCAS
 *   LowBreakpoint (LowBP) — energy at which full FCAS is enabled from below
 *   HighBreakpoint (HiBP) — energy at which full FCAS is still enabled from above
 *   EnablementMax (EnMax) — max energy dispatch compatible with any FCAS
 *
 * Four time parameters govern the BESS's ability to respond:
 *   T1 — response delay (seconds)
 *   T2 — ramp-to-full (seconds); T1+T2 ≤ market response window
 *   T3 — hold (seconds)
 *   T4 — recovery / release (seconds)
 *
 * Response windows (MASS Rule 3.8.7A):
 *   RAISE6SEC / LOWER6SEC  → T1+T2 ≤ 6 s
 *   RAISE60SEC / LOWER60SEC → T1+T2 ≤ 60 s
 *   RAISE5MIN / LOWER5MIN  → T1+T2 ≤ 300 s
 *   RAISEREG / LOWERREG    → T1+T2 ≤ 5 s
 *
 * This component renders an SVG trapezoid that updates live as sliders/inputs
 * are changed, and exposes the result via an `onChange` callback so the
 * caller (e.g. BESSCalculator) can embed the trapezium in a bid payload.
 */
import { useEffect, useMemo, useState } from 'react'
import type { VPPFcasTrapezium } from '../types'
import { useT } from '../i18n'

// Per-market max response window (T1+T2)
const RESPONSE_WINDOW: Record<string, number> = {
  RAISE6SEC: 6,
  LOWER6SEC: 6,
  RAISEREG: 5,
  LOWERREG: 5,
  RAISE60SEC: 60,
  LOWER60SEC: 60,
  RAISE5MIN: 300,
  LOWER5MIN: 300,
  RAISE1SEC: 1,
  LOWER1SEC: 1,
}

export interface FCASTrapeziuBuilderProps {
  /** Which FCAS market (drives T1+T2 validation). */
  market: string
  /** BESS power rating in MW (constrains the max FCAS MW values shown). */
  powerMw: number
  /** Initial trapezium (optional — defaults to a sensible shape for the BESS). */
  initial?: Partial<VPPFcasTrapezium>
  onChange?: (trap: VPPFcasTrapezium) => void
}

const DEFAULT_TRAP = (mw: number): VPPFcasTrapezium => ({
  enablement_min_mw: 0,
  low_breakpoint_mw: mw * 0.2,
  high_breakpoint_mw: mw * 0.8,
  enablement_max_mw: mw,
  t1_sec: 0,
  t2_sec: 4,
  t3_sec: 60,
  t4_sec: 60,
})

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v))
}

interface SliderRowProps {
  label: string
  unit: string
  value: number
  min: number
  max: number
  step?: number
  warn?: boolean
  onChange: (v: number) => void
}

function SliderRow({ label, unit, value, min, max, step = 1, warn, onChange }: SliderRowProps) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr 70px', gap: 8, alignItems: 'center', marginBottom: 6 }}>
      <label style={{ fontSize: 12, color: warn ? '#dc2626' : '#374151', fontWeight: warn ? 700 : 400 }}>
        {label}
      </label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ accentColor: warn ? '#dc2626' : '#3b82f6' }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={e => onChange(clamp(Number(e.target.value), min, max))}
          style={{
            width: 52, padding: '2px 4px', border: '1px solid #d1d5db',
            borderRadius: 4, fontSize: 12, textAlign: 'right',
            borderColor: warn ? '#dc2626' : '#d1d5db',
          }}
        />
        <span style={{ fontSize: 11, color: '#9ca3af', whiteSpace: 'nowrap' }}>{unit}</span>
      </div>
    </div>
  )
}

/** SVG enablement trapezoid — energy on X axis, FCAS MW on Y axis. */
function TrapezoidSVG({
  trap,
  powerMw,
  fcasMw,
}: {
  trap: VPPFcasTrapezium
  powerMw: number
  fcasMw: number
}) {
  const W = 320
  const H = 160
  const pad = { left: 40, right: 16, top: 12, bottom: 28 }
  const chartW = W - pad.left - pad.right
  const chartH = H - pad.top - pad.bottom

  const toX = (mw: number) => pad.left + (mw / powerMw) * chartW
  const toY = (fcas: number) => pad.top + chartH - (fcas / fcasMw) * chartH

  const {
    enablement_min_mw: enMin,
    low_breakpoint_mw: lowBP,
    high_breakpoint_mw: hiBP,
    enablement_max_mw: enMax,
  } = trap

  // Trapezoid vertices (clockwise from bottom-left)
  const pts = [
    [toX(enMin), toY(0)],
    [toX(lowBP), toY(fcasMw)],
    [toX(hiBP), toY(fcasMw)],
    [toX(enMax), toY(0)],
  ]
  const polyPts = pts.map(([x, y]) => `${x},${y}`).join(' ')

  // X-axis ticks
  const xTicks = [0, powerMw * 0.25, powerMw * 0.5, powerMw * 0.75, powerMw]
  const yTicks = [0, fcasMw * 0.5, fcasMw]

  return (
    <svg width={W} height={H} style={{ overflow: 'visible' }}>
      {/* Grid lines */}
      {xTicks.map(v => (
        <line
          key={v}
          x1={toX(v)} y1={pad.top}
          x2={toX(v)} y2={pad.top + chartH}
          stroke="#e5e7eb" strokeWidth={1}
        />
      ))}
      {yTicks.map(v => (
        <line
          key={v}
          x1={pad.left} y1={toY(v)}
          x2={pad.left + chartW} y2={toY(v)}
          stroke="#e5e7eb" strokeWidth={1}
        />
      ))}

      {/* Trapezoid fill */}
      <polygon points={polyPts} fill="#3b82f622" stroke="#3b82f6" strokeWidth={2} />

      {/* Vertex dots */}
      {pts.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={4} fill="#3b82f6" />
      ))}

      {/* X-axis */}
      <line
        x1={pad.left} y1={pad.top + chartH}
        x2={pad.left + chartW} y2={pad.top + chartH}
        stroke="#6b7280" strokeWidth={1}
      />
      {xTicks.map(v => (
        <g key={v}>
          <line
            x1={toX(v)} y1={pad.top + chartH}
            x2={toX(v)} y2={pad.top + chartH + 4}
            stroke="#6b7280"
          />
          <text
            x={toX(v)} y={pad.top + chartH + 14}
            textAnchor="middle"
            fontSize={9}
            fill="#6b7280"
          >
            {v.toFixed(0)}
          </text>
        </g>
      ))}
      <text
        x={pad.left + chartW / 2}
        y={H - 2}
        textAnchor="middle"
        fontSize={10}
        fill="#9ca3af"
      >
        Energy dispatch (MW)
      </text>

      {/* Y-axis */}
      <line
        x1={pad.left} y1={pad.top}
        x2={pad.left} y2={pad.top + chartH}
        stroke="#6b7280" strokeWidth={1}
      />
      {yTicks.map(v => (
        <g key={v}>
          <line
            x1={pad.left - 4} y1={toY(v)}
            x2={pad.left} y2={toY(v)}
            stroke="#6b7280"
          />
          <text
            x={pad.left - 6} y={toY(v) + 4}
            textAnchor="end"
            fontSize={9}
            fill="#6b7280"
          >
            {v.toFixed(0)}
          </text>
        </g>
      ))}
    </svg>
  )
}

export function FCASTrapeziuBuilder({
  market,
  powerMw,
  initial,
  onChange,
}: FCASTrapeziuBuilderProps) {
  const [trap, setTrap] = useState<VPPFcasTrapezium>({
    ...DEFAULT_TRAP(powerMw),
    ...initial,
  })
  const [fcasMw, setFcasMw] = useState(powerMw * 0.5)

  // Reset to sane defaults if powerMw changes dramatically
  useEffect(() => {
    setTrap(prev => ({
      ...prev,
      enablement_max_mw: Math.min(prev.enablement_max_mw, powerMw),
      high_breakpoint_mw: Math.min(prev.high_breakpoint_mw, powerMw),
    }))
    setFcasMw(mw => Math.min(mw, powerMw))
  }, [powerMw])

  const { t } = useT()
  const responseWindow = RESPONSE_WINDOW[market] ?? 60
  const t1t2 = trap.t1_sec + trap.t2_sec
  const t1t2Warn = t1t2 > responseWindow

  function update(patch: Partial<VPPFcasTrapezium>) {
    setTrap(prev => {
      const next = { ...prev, ...patch }
      onChange?.(next)
      return next
    })
  }

  // Validation messages
  const errors = useMemo(() => {
    const msgs: string[] = []
    if (trap.enablement_min_mw > trap.low_breakpoint_mw)
      msgs.push(t('trap.errEnMin'))
    if (trap.low_breakpoint_mw > trap.high_breakpoint_mw)
      msgs.push(t('trap.errLowBP'))
    if (trap.high_breakpoint_mw > trap.enablement_max_mw)
      msgs.push(t('trap.errHiBP'))
    if (trap.enablement_max_mw > powerMw)
      msgs.push(t('trap.errEnMax', trap.enablement_max_mw.toFixed(1), powerMw))
    if (t1t2Warn)
      msgs.push(t('trap.t1t2Warn', t1t2, market, responseWindow))
    return msgs
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trap, powerMw, market, t1t2Warn, t1t2, responseWindow, t])

  return (
    <div style={{ fontFamily: 'system-ui,sans-serif' }}>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {/* SVG preview */}
        <div>
          <p style={{ fontSize: 11, color: '#6b7280', margin: '0 0 4px' }}>
            {t('trap.preview', fcasMw.toFixed(0))}
          </p>
          <TrapezoidSVG trap={trap} powerMw={powerMw} fcasMw={fcasMw} />
          {/* FCAS MW slider */}
          <div style={{ marginTop: 4 }}>
            <SliderRow
              label={t('trap.fcasMw')}
              unit="MW"
              value={fcasMw}
              min={0}
              max={powerMw}
              step={0.5}
              onChange={setFcasMw}
            />
          </div>
        </div>

        {/* Controls */}
        <div style={{ flex: 1, minWidth: 280 }}>
          {/* MW breakpoints */}
          <p style={{ fontSize: 12, fontWeight: 700, color: '#374151', margin: '0 0 8px' }}>
            {t('trap.mwTitle')}
          </p>
          <SliderRow
            label={t('trap.enMin')}
            unit="MW"
            value={trap.enablement_min_mw}
            min={0}
            max={powerMw}
            step={0.5}
            onChange={v => update({ enablement_min_mw: Math.min(v, trap.low_breakpoint_mw) })}
          />
          <SliderRow
            label={t('trap.lowBP')}
            unit="MW"
            value={trap.low_breakpoint_mw}
            min={trap.enablement_min_mw}
            max={trap.high_breakpoint_mw}
            step={0.5}
            onChange={v => update({ low_breakpoint_mw: v })}
          />
          <SliderRow
            label={t('trap.hiBP')}
            unit="MW"
            value={trap.high_breakpoint_mw}
            min={trap.low_breakpoint_mw}
            max={trap.enablement_max_mw}
            step={0.5}
            onChange={v => update({ high_breakpoint_mw: v })}
          />
          <SliderRow
            label={t('trap.enMax')}
            unit="MW"
            value={trap.enablement_max_mw}
            min={trap.high_breakpoint_mw}
            max={powerMw}
            step={0.5}
            onChange={v => update({ enablement_max_mw: v })}
          />

          {/* Time parameters */}
          <p style={{ fontSize: 12, fontWeight: 700, color: '#374151', margin: '12px 0 8px' }}>
            {t('trap.timeTitle')}
            <span style={{ fontSize: 11, color: '#6b7280', fontWeight: 400, marginLeft: 8 }}>
              ({t('trap.window', responseWindow, market)})
            </span>
          </p>
          <SliderRow
            label={t('trap.t1')}
            unit="s"
            value={trap.t1_sec}
            min={0}
            max={responseWindow}
            step={1}
            warn={t1t2Warn}
            onChange={v => update({ t1_sec: v })}
          />
          <SliderRow
            label={t('trap.t2')}
            unit="s"
            value={trap.t2_sec}
            min={0}
            max={responseWindow}
            step={1}
            warn={t1t2Warn}
            onChange={v => update({ t2_sec: v })}
          />
          {t1t2Warn && (
            <div style={{
              fontSize: 11, color: '#dc2626', background: '#fef2f2',
              border: '1px solid #fca5a5', borderRadius: 4, padding: '3px 8px', marginBottom: 6,
            }}>
              {t('trap.t1t2Warn', t1t2, market, responseWindow)}
            </div>
          )}
          <SliderRow
            label={t('trap.t3')}
            unit="s"
            value={trap.t3_sec}
            min={0}
            max={600}
            step={5}
            onChange={v => update({ t3_sec: v })}
          />
          <SliderRow
            label={t('trap.t4')}
            unit="s"
            value={trap.t4_sec}
            min={0}
            max={600}
            step={5}
            onChange={v => update({ t4_sec: v })}
          />
        </div>
      </div>

      {/* Validation */}
      {errors.length > 0 && (
        <div style={{
          marginTop: 10,
          background: '#fef2f2',
          border: '1px solid #fca5a5',
          borderRadius: 6,
          padding: '6px 10px',
        }}>
          {errors.map((e, i) => (
            <div key={i} style={{ fontSize: 12, color: '#b91c1c' }}>⚠ {e}</div>
          ))}
        </div>
      )}

      {/* Summary JSON */}
      <details style={{ marginTop: 10 }}>
        <summary style={{ fontSize: 11, color: '#6b7280', cursor: 'pointer' }}>
          {t('trap.json')}
        </summary>
        <pre style={{
          fontSize: 11, background: '#f9fafb', border: '1px solid #e5e7eb',
          borderRadius: 4, padding: 8, overflowX: 'auto', margin: '4px 0 0',
        }}>
          {JSON.stringify(trap, null, 2)}
        </pre>
      </details>
    </div>
  )
}
