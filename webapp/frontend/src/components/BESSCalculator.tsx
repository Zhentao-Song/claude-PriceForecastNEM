import { useEffect, useState } from 'react'
import { backtestBess, fetchBessBackfillStatus, fetchBessDefaults, modelBess, startBessBackfill } from '../api'
import type {
  BessBacktestHaircuts, BessBacktestResponse, BessDefaultsResponse, BessInputs, BessModelResponse,
  BessProvenance, BessRegion, BessSensitivityRow, BessYearlyRow,
} from '../types'
import { useT } from '../i18n'

/**
 * BESS-Calc — project finance modelling for a new BESS investment.
 *
 * Layout:
 *   ┌──── Inputs (left, ~320px) ──┬──── Outputs (right, flex) ─────────┐
 *   │ Required (region/MW/MWh/    │ 6 KPI cards (NPV/IRR/Payback/...)  │
 *   │   CapEx/debt/rate/tenor)    ├────────────────────────────────────┤
 *   │ ▾ Advanced (engineering)    │ Stacked area chart: revenue/yr     │
 *   │ ▾ Revenue (calibrated)      ├────────────────────────────────────┤
 *   │ ▾ Financial (WACC/tax)      │ Tornado sensitivity                │
 *   │                              ├────────────────────────────────────┤
 *   │ [Recalculate] [Reset]       │ Year-by-year cashflow table        │
 *   │                              ├────────────────────────────────────┤
 *   │                              │ Assumptions provenance (honest)    │
 *   └─────────────────────────────┴────────────────────────────────────┘
 *
 * Defaults endpoint pre-calibrates region-specific values (arb_spread,
 * fcas_revenue, MLF) from the last 90 days of real RRP/FCAS data. The
 * provenance map tells the UI which inputs came from real data vs which
 * are industry defaults — surfaced in the bottom panel.
 */

const REGION_OPTS: BessRegion[] = ['NSW1', 'QLD1', 'VIC1', 'SA1', 'TAS1']

function fmtMoney(v: number, scale: 'M' | 'k' | '$' = 'M'): string {
  if (scale === 'M') return `$${(v / 1_000_000).toFixed(2)}M`
  if (scale === 'k') return `$${(v / 1_000).toFixed(0)}k`
  return `$${v.toLocaleString('en-AU', { maximumFractionDigits: 0 })}`
}
function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined) return '—'
  return `${v.toFixed(digits)}%`
}
function fmtYears(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—'
  return `${v.toFixed(1)} yr`
}

export function BESSCalculator() {
  const { t } = useT()
  const [region, setRegion] = useState<BessRegion>('NSW1')
  const [defaults, setDefaults] = useState<BessDefaultsResponse | null>(null)
  const [model, setModel] = useState<BessModelResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Form state — initialised from /defaults, mutated by user
  const [form, setForm] = useState<BessInputs | null>(null)
  // Track which fields user has manually edited so they survive region change
  const [dirty, setDirty] = useState<Set<string>>(new Set())

  // 365-day backtest of the current BESS spec. Auto-runs (debounced)
  // whenever power/duration/rte/cycles/region changes.
  const [backtest, setBacktest] = useState<BessBacktestResponse | null>(null)
  const [backtestLoading, setBacktestLoading] = useState(false)
  const [backtestErr, setBacktestErr] = useState<string | null>(null)
  const [backtestLookback, setBacktestLookback] = useState(365)
  // Dynamic dispatch parameters exposed to the user
  const [degCostPerMwh, setDegCostPerMwh] = useState(35)
  const [maxCyclesPerDay, setMaxCyclesPerDay] = useState(2.0)

  // MMSDM historical backfill state — tracks progress of the background
  // job that downloads missing months from the AEMO archive.
  const [backfillRunning, setBackfillRunning] = useState(false)
  const [backfillDone, setBackfillDone] = useState(false)
  const [backfillDbDays, setBackfillDbDays] = useState<number | null>(null)
  const [backfillMonthsDone, setBackfillMonthsDone] = useState(0)
  const [backfillMonthsTotal, setBackfillMonthsTotal] = useState(0)

  // ---- CapEx cost decomposition (UI-only) ----
  // Industry-standard split that matches AEMO ISP / Lazard LCOS / NREL
  // ATB methodology: CapEx = $/kW × MW + $/kWh × MWh + fixed (grid +
  // civils + engineering). The 2024 starting defaults below land on
  // $80M for 100MW/200MWh — same as the old hardcoded number.
  //
  // Cost regimes (AEMO ISP 2024-25 anchors):
  //   low:    $250/kW + $200/kWh  → cheap supplier, large-volume site
  //   mid:    $300/kW + $250/kWh  → median NSW tier-1 EPC
  //   high:   $400/kW + $350/kWh  → small/remote/complex grid connection
  const COST_REGIMES = {
    low:  { kw: 250, kwh: 200, fixed: 0,       label: 'Low (large-volume EPC)' },
    mid:  { kw: 300, kwh: 250, fixed: 0,       label: 'Mid (NSW tier-1, 2024-25)' },
    high: { kw: 400, kwh: 350, fixed: 5_000_000, label: 'High (remote/complex)' },
  } as const
  type CostRegime = keyof typeof COST_REGIMES
  const [regime, setRegime] = useState<CostRegime>('mid')
  const [powerCostPerKw, setPowerCostPerKw] = useState<number>(COST_REGIMES.mid.kw)
  const [energyCostPerKwh, setEnergyCostPerKwh] = useState<number>(COST_REGIMES.mid.kwh)
  const [fixedCapex, setFixedCapex] = useState<number>(COST_REGIMES.mid.fixed)
  // Track if user has manually nudged the cost knobs (so preset switch
  // doesn't blow away their tweaks unexpectedly).
  const [costDirty, setCostDirty] = useState<Set<string>>(new Set())

  // Auto-derive CapEx from (power × $/kW) + (energy × $/kWh) + fixed.
  // Skipped if user has manually overridden CapEx (dirty.has('capex_aud')).
  useEffect(() => {
    if (!form || dirty.has('capex_aud')) return
    const energy_mwh = form.power_mw * form.duration_h
    const derived =
      form.power_mw * 1000 * powerCostPerKw +
      energy_mwh * 1000 * energyCostPerKwh +
      fixedCapex
    if (Math.abs(derived - form.capex_aud) > 1) {
      setForm((f) => f ? ({ ...f, capex_aud: derived }) : f)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form?.power_mw, form?.duration_h, powerCostPerKw, energyCostPerKwh, fixedCapex, dirty])

  const applyRegime = (r: CostRegime) => {
    setRegime(r)
    if (!costDirty.has('powerCostPerKw'))  setPowerCostPerKw(COST_REGIMES[r].kw)
    if (!costDirty.has('energyCostPerKwh')) setEnergyCostPerKwh(COST_REGIMES[r].kwh)
    if (!costDirty.has('fixedCapex'))       setFixedCapex(COST_REGIMES[r].fixed)
  }

  // Initial load + region change refetch
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetchBessDefaults(region, 90)
      .then((d) => {
        if (cancelled) return
        setDefaults(d)
        // Preserve dirty-user-edits when switching region; otherwise take new defaults
        setForm((prev) => {
          if (!prev) return d.inputs
          const next = { ...d.inputs } as any
          for (const k of dirty) {
            next[k] = (prev as any)[k]
          }
          return next as BessInputs
        })
        setErr(null)
      })
      .catch((e) => !cancelled && setErr(String(e.message ?? e)))
      .finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [region])

  // Run model whenever form changes (debounced)
  useEffect(() => {
    if (!form) return
    const id = setTimeout(() => {
      setLoading(true)
      modelBess(form as any, true)
        .then(setModel)
        .catch((e) => setErr(String(e.message ?? e)))
        .finally(() => setLoading(false))
    }, 350)
    return () => clearTimeout(id)
  }, [form])

  // Poll backfill status while a job is running, then refresh backtest once done.
  useEffect(() => {
    if (!backfillRunning) return
    const id = setInterval(async () => {
      try {
        const s = await fetchBessBackfillStatus()
        setBackfillDbDays(s.db_days_nsw1)
        setBackfillMonthsDone(s.months_done)
        setBackfillMonthsTotal(s.months_total)
        if (!s.running) {
          setBackfillRunning(false)
          setBackfillDone(true)
          clearInterval(id)
          // Re-trigger backtest now that we have more data
          if (form) {
            setBacktestLoading(true)
            backtestBess({
              region,
              power_mw: form.power_mw,
              duration_h: form.duration_h,
              rte_pct: form.rte_pct,
              mlf: form.mlf,
              aux_load_pct: form.aux_load_pct,
              lookback_days: 365,
              deg_cost_per_mwh: degCostPerMwh,
              max_cycles_per_day: maxCyclesPerDay,
            })
              .then((r) => { setBacktest(r); setBacktestErr(null) })
              .catch((e) => setBacktestErr(String(e.message ?? e)))
              .finally(() => setBacktestLoading(false))
          }
        }
      } catch { /* ignore transient errors */ }
    }, 3000)
    return () => clearInterval(id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backfillRunning])

  // Re-run backtest whenever the BESS spec or dispatch params change.
  useEffect(() => {
    if (!form) return
    const id = setTimeout(() => {
      setBacktestLoading(true)
      backtestBess({
        region: region,
        power_mw: form.power_mw,
        duration_h: form.duration_h,
        rte_pct: form.rte_pct,
        mlf: form.mlf,
        aux_load_pct: form.aux_load_pct,
        lookback_days: backtestLookback,
        deg_cost_per_mwh: degCostPerMwh,
        max_cycles_per_day: maxCyclesPerDay,
      })
        .then((r) => { setBacktest(r); setBacktestErr(null) })
        .catch((e) => setBacktestErr(String(e.message ?? e)))
        .finally(() => setBacktestLoading(false))
    }, 800)
    return () => clearTimeout(id)
  }, [region, form?.power_mw, form?.duration_h, form?.rte_pct,
       form?.mlf, form?.aux_load_pct, backtestLookback,
       degCostPerMwh, maxCyclesPerDay])

  const updateField = <K extends keyof BessInputs>(key: K, value: BessInputs[K]) => {
    setForm((f) => f ? ({ ...f, [key]: value }) : f)
    setDirty((d) => new Set(d).add(key as string))
  }

  const resetToDefaults = () => {
    if (!defaults) return
    setForm(defaults.inputs)
    setDirty(new Set())
  }

  if (!form) {
    return <div className="h-64 flex items-center justify-center text-muted text-sm">{t('chart.loading')}</div>
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-5">
      {/* ============================ INPUTS ============================ */}
      <aside className="space-y-3">
        <InputCard title={t('bc.in.asset')}>
          <Field label={t('bc.in.region')}>
            <select value={region} onChange={(e) => setRegion(e.target.value as BessRegion)}
                    className="w-full text-[12px] border border-hairlineSoft rounded px-2 py-1.5 bg-surface focus:outline-none focus:border-accent">
              {REGION_OPTS.map((r) => <option key={r} value={r}>{r.replace('1','')}</option>)}
            </select>
          </Field>
          {/* Scale — Power (MW) + Energy (MWh) are the primary knobs;
              duration_h auto-derives. Changing either of these triggers
              the CapEx auto-derive (unless user has manually overridden). */}
          <FieldRow>
            <NumberInput label={t('bc.in.powerMw')} value={form.power_mw} unit="MW" step={5}
                          onChange={(v) => updateField('power_mw', v)} dirty={dirty.has('power_mw')} />
            <NumberInput
              label={t('bc.in.energyMwh')}
              value={form.power_mw * form.duration_h}
              unit="MWh" step={50}
              onChange={(mwh) => {
                // Translate to duration_h since the backend finance model
                // uses (power_mw, duration_h). Mark duration_h as edited.
                const hours = form.power_mw > 0 ? mwh / form.power_mw : form.duration_h
                updateField('duration_h', hours)
              }}
              dirty={dirty.has('duration_h')}
            />
          </FieldRow>
          {/* CapEx — auto-derived from (power × $/kW) + (energy × $/kWh)
              + fixed. User can override but the EDITED badge appears + a
              "↺ recompute" button to snap back to derived. */}
          <div>
            <NumberInput
              label={t('bc.in.capex')} value={form.capex_aud / 1_000_000}
              unit="M AUD" step={1}
              onChange={(v) => updateField('capex_aud', v * 1_000_000)}
              dirty={dirty.has('capex_aud')}
              onReset={dirty.has('capex_aud') ? () => {
                // Snap back to derived CapEx — clear the dirty flag and
                // let the auto-derive effect recompute.
                setDirty((d) => { const n = new Set(d); n.delete('capex_aud'); return n })
              } : undefined}
            />
            {/* Cost-breakdown chip directly under CapEx */}
            <CapexBreakdown
              power_mw={form.power_mw} energy_mwh={form.power_mw * form.duration_h}
              cost_per_kw={powerCostPerKw} cost_per_kwh={energyCostPerKwh}
              fixed={fixedCapex} capex={form.capex_aud}
              isOverride={dirty.has('capex_aud')}
              t={t}
            />
          </div>
          <div className="text-[10px] text-muted mt-1">
            {form.power_mw} MW × {form.duration_h.toFixed(2)} h
            = <b className="text-ink2">{(form.power_mw * form.duration_h).toFixed(0)} MWh</b>
            <span className="ml-2">
              {fmtMoney(form.capex_aud / (form.power_mw * form.duration_h * 1000), '$')} / kWh
            </span>
          </div>
        </InputCard>

        {/* ---- CapEx cost regime preset + advanced knobs ---- */}
        <CollapsibleCard title={t('bc.in.costRegime')} defaultOpen={false}>
          {/* Three preset regimes — clicking applies the matching unit costs
              UNLESS the user has manually nudged that knob. */}
          <div className="flex gap-1 bg-surfaceAlt rounded-md p-0.5">
            {(['low','mid','high'] as const).map((r) => (
              <button key={r} onClick={() => applyRegime(r)}
                      className={`flex-1 text-[10px] py-1 rounded transition-colors ${
                        regime === r ? 'bg-surface shadow-sm font-medium text-ink' : 'text-muted hover:text-ink'
                      }`}>
                {t(`bc.regime.${r}`)}
              </button>
            ))}
          </div>
          <div className="text-[10px] text-muted leading-relaxed">
            {t('bc.regime.note')}
          </div>
          <NumberInput
            label={t('bc.in.powerCost')} value={powerCostPerKw} unit="$/kW" step={10}
            onChange={(v) => { setPowerCostPerKw(v); setCostDirty(d => new Set(d).add('powerCostPerKw')) }}
            dirty={costDirty.has('powerCostPerKw')}
          />
          <NumberInput
            label={t('bc.in.energyCost')} value={energyCostPerKwh} unit="$/kWh" step={10}
            onChange={(v) => { setEnergyCostPerKwh(v); setCostDirty(d => new Set(d).add('energyCostPerKwh')) }}
            dirty={costDirty.has('energyCostPerKwh')}
          />
          <NumberInput
            label={t('bc.in.fixedCapex')} value={fixedCapex / 1_000_000} unit="M AUD" step={1}
            onChange={(v) => { setFixedCapex(v * 1_000_000); setCostDirty(d => new Set(d).add('fixedCapex')) }}
            dirty={costDirty.has('fixedCapex')}
          />
        </CollapsibleCard>

        <InputCard title={t('bc.in.capital')}>
          <FieldRow>
            <NumberInput label={t('bc.in.debtPct')} value={form.debt_pct} unit="%" step={5} min={0} max={100}
                          onChange={(v) => updateField('debt_pct', v)} dirty={dirty.has('debt_pct')} />
            <NumberInput label={t('bc.in.rate')} value={form.interest_rate_pct} unit="%" step={0.25}
                          onChange={(v) => updateField('interest_rate_pct', v)} dirty={dirty.has('interest_rate_pct')} />
          </FieldRow>
          <FieldRow>
            <NumberInput label={t('bc.in.tenor')} value={form.loan_tenor_years} unit="yr" step={1}
                          onChange={(v) => updateField('loan_tenor_years', v)} dirty={dirty.has('loan_tenor_years')} />
            <NumberInput label={t('bc.in.life')} value={form.project_life_years} unit="yr" step={1}
                          onChange={(v) => updateField('project_life_years', v)} dirty={dirty.has('project_life_years')} />
          </FieldRow>
        </InputCard>

        <CollapsibleCard title={t('bc.in.revenue')} defaultOpen={true}>
          {/* Backtest panel — the financially-correct way to estimate
              annual revenue. Runs auto on any spec change; user can
              "use backtested" to snap the manual inputs below to the
              backtest-implied values. */}
          <BacktestPanel
            backtest={backtest} loading={backtestLoading} err={backtestErr}
            lookback={backtestLookback} onLookbackChange={setBacktestLookback}
            degCostPerMwh={degCostPerMwh} onDegCostChange={setDegCostPerMwh}
            maxCyclesPerDay={maxCyclesPerDay} onMaxCyclesChange={setMaxCyclesPerDay}
            onUseBacktest={() => {
              if (!backtest) return
              if (backtest.energy) {
                setForm((f) => f ? ({
                  ...f,
                  arb_spread_per_mwh: backtest.energy!.implied_spread_per_mwh,
                  cycles_per_day: backtest.energy!.mean_cycles_per_day,
                }) : f)
                setDirty((d) => { const n = new Set(d); n.add('arb_spread_per_mwh'); n.add('cycles_per_day'); return n })
              }
              if (backtest.fcas) {
                setForm((f) => f ? ({ ...f, fcas_revenue_per_mw_year: backtest.fcas!.per_mw_year_after_util }) : f)
                setDirty((d) => new Set(d).add('fcas_revenue_per_mw_year'))
              }
            }}
            onBackfill={async () => {
              setBackfillRunning(true)
              setBackfillDone(false)
              await startBessBackfill(400)
            }}
            backfillRunning={backfillRunning}
            backfillDone={backfillDone}
            backfillDbDays={backfillDbDays}
            backfillMonthsDone={backfillMonthsDone}
            backfillMonthsTotal={backfillMonthsTotal}
            t={t}
          />
          <NumberInput label={t('bc.in.arbSpread')} value={form.arb_spread_per_mwh} unit="$/MWh" step={5}
                        onChange={(v) => updateField('arb_spread_per_mwh', v)}
                        dirty={dirty.has('arb_spread_per_mwh')}
                        provenance={defaults?.provenance.arb_spread_per_mwh}
                        onReset={() => {
                          const v = defaults?.provenance.arb_spread_per_mwh?.stats?.value
                          if (v !== undefined) {
                            setForm((f) => f ? ({ ...f, arb_spread_per_mwh: v }) : f)
                            setDirty((d) => { const n = new Set(d); n.delete('arb_spread_per_mwh'); return n })
                          }
                        }} />
          <NumberInput label={t('bc.in.fcasRev')} value={form.fcas_revenue_per_mw_year / 1000} unit="k AUD/MW/yr" step={1}
                        displayScale={1000}
                        onChange={(v) => updateField('fcas_revenue_per_mw_year', v * 1000)}
                        dirty={dirty.has('fcas_revenue_per_mw_year')}
                        provenance={defaults?.provenance.fcas_revenue_per_mw_year}
                        onReset={() => {
                          const v = defaults?.provenance.fcas_revenue_per_mw_year?.stats?.value
                          if (v !== undefined) {
                            setForm((f) => f ? ({ ...f, fcas_revenue_per_mw_year: v }) : f)
                            setDirty((d) => { const n = new Set(d); n.delete('fcas_revenue_per_mw_year'); return n })
                          }
                        }} />
          <NumberInput label={t('bc.in.fcasDecline')} value={form.fcas_decline_pct_year} unit="%/yr" step={1}
                        onChange={(v) => updateField('fcas_decline_pct_year', v)}
                        dirty={dirty.has('fcas_decline_pct_year')} />
          <NumberInput label={t('bc.in.cis')} value={form.cis_floor_revenue_per_mw_year / 1000} unit="k AUD/MW/yr" step={1}
                        onChange={(v) => updateField('cis_floor_revenue_per_mw_year', v * 1000)}
                        dirty={dirty.has('cis_floor_revenue_per_mw_year')} />
        </CollapsibleCard>

        <CollapsibleCard title={t('bc.in.engineering')} defaultOpen={false}>
          <FieldRow>
            <NumberInput label={t('bc.in.rte')} value={form.rte_pct} unit="%" step={1}
                          onChange={(v) => updateField('rte_pct', v)} dirty={dirty.has('rte_pct')} />
            <NumberInput label={t('bc.in.cycles')} value={form.cycles_per_day} unit="/day" step={0.1}
                          onChange={(v) => updateField('cycles_per_day', v)} dirty={dirty.has('cycles_per_day')} />
          </FieldRow>
          <FieldRow>
            <NumberInput label={t('bc.in.degrad')} value={form.degradation_pct_year} unit="%/yr" step={0.1}
                          onChange={(v) => updateField('degradation_pct_year', v)} dirty={dirty.has('degradation_pct_year')} />
            <NumberInput label={t('bc.in.mlf')} value={form.mlf} unit="" step={0.005}
                          onChange={(v) => updateField('mlf', v)} dirty={dirty.has('mlf')}
                          provenance={defaults?.provenance.mlf} />
          </FieldRow>
          <FieldRow>
            <NumberInput label={t('bc.in.augPct')} value={form.augmentation_capex_pct} unit="%" step={1}
                          onChange={(v) => updateField('augmentation_capex_pct', v)} dirty={dirty.has('augmentation_capex_pct')} />
            <NumberInput label={t('bc.in.augYr')} value={form.augmentation_year} unit="yr" step={1}
                          onChange={(v) => updateField('augmentation_year', v)} dirty={dirty.has('augmentation_year')} />
          </FieldRow>
          <FieldRow>
            <NumberInput label={t('bc.in.opex')} value={form.opex_per_kw_year} unit="$/kW/yr" step={1}
                          onChange={(v) => updateField('opex_per_kw_year', v)} dirty={dirty.has('opex_per_kw_year')} />
            <NumberInput label={t('bc.in.insurance')} value={form.insurance_per_mwh_year} unit="$/MWh/yr" step={0.5}
                          onChange={(v) => updateField('insurance_per_mwh_year', v)} dirty={dirty.has('insurance_per_mwh_year')} />
          </FieldRow>
        </CollapsibleCard>

        <CollapsibleCard title={t('bc.in.financial')} defaultOpen={false}>
          <FieldRow>
            <NumberInput label={t('bc.in.wacc')} value={form.discount_rate_pct} unit="%" step={0.5}
                          onChange={(v) => updateField('discount_rate_pct', v)} dirty={dirty.has('discount_rate_pct')} />
            <NumberInput label={t('bc.in.tax')} value={form.tax_rate_pct} unit="%" step={1}
                          onChange={(v) => updateField('tax_rate_pct', v)} dirty={dirty.has('tax_rate_pct')} />
          </FieldRow>
          <FieldRow>
            <NumberInput label={t('bc.in.inflation')} value={form.inflation_pct} unit="%" step={0.25}
                          onChange={(v) => updateField('inflation_pct', v)} dirty={dirty.has('inflation_pct')} />
            <NumberInput label={t('bc.in.deprLife')} value={form.depreciation_life_years} unit="yr" step={1}
                          onChange={(v) => updateField('depreciation_life_years', v)} dirty={dirty.has('depreciation_life_years')} />
          </FieldRow>
        </CollapsibleCard>

        <button onClick={resetToDefaults}
                className="w-full text-[11px] py-2 rounded-md border border-hairlineSoft text-muted hover:text-ink hover:border-hairline transition-colors">
          {t('bc.in.reset')}
        </button>
        {err && <div className="text-[11px] text-negative bg-red-50 px-3 py-2 rounded">{err}</div>}
      </aside>

      {/* ============================ OUTPUTS ============================ */}
      <main className="space-y-4">
        {model && <KpiRow model={model} loading={loading} t={t} />}
        {model && <RevenueChart yearly={model.yearly} t={t} />}
        {model && model.sensitivity.length > 0 && <TornadoChart rows={model.sensitivity} t={t} />}
        {model && <DscrCurve yearly={model.yearly} t={t} />}
        {model && <CashflowTable yearly={model.yearly} t={t} />}
        {defaults && model && <ProvenancePanel provenance={model.provenance} t={t} />}
      </main>
    </div>
  )
}

// =========================================================================
// Sub-components
// =========================================================================

function InputCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-surface rounded-xl2 p-4 shadow-card">
      <div className="text-[11px] uppercase tracking-[0.18em] text-muted mb-2 font-semibold">{title}</div>
      <div className="space-y-2.5">{children}</div>
    </section>
  )
}

function CollapsibleCard({ title, children, defaultOpen = false }: {
  title: string; children: React.ReactNode; defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="bg-surface rounded-xl2 shadow-card overflow-hidden">
      <button onClick={() => setOpen(!open)}
              className="w-full text-left px-4 py-2.5 flex items-center gap-2 hover:bg-surfaceAlt/40 transition-colors">
        <span className={`text-[11px] text-muted transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
        <span className="text-[11px] uppercase tracking-[0.18em] text-muted font-semibold flex-1">{title}</span>
      </button>
      {open && <div className="px-4 pb-4 pt-1 space-y-2.5">{children}</div>}
    </section>
  )
}

function FieldRow({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-2">{children}</div>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wider text-muted block mb-1">{label}</span>
      {children}
    </label>
  )
}

function NumberInput({
  label, value, unit, step, min, max, onChange, dirty, provenance,
  // displayScale lets the input render values in a different unit than
  // the underlying field. e.g. FCAS revenue is stored in $/MW/yr but
  // displayed in k$/MW/yr — pass displayScale={1000} so the calibration
  // strip can compare apples-to-apples.
  displayScale = 1,
  onReset,
}: {
  label: string; value: number; unit?: string; step?: number; min?: number; max?: number;
  onChange: (v: number) => void; dirty?: boolean; provenance?: BessProvenance
  displayScale?: number
  onReset?: () => void
}) {
  // Source-of-truth "calibrated default" used for reset + display.
  // The backend stores the point estimate in `provenance.stats.value`
  // (using the model's native unit), so we apply displayScale here.
  const calibratedRaw = provenance?.stats?.value
  const calibratedShown = calibratedRaw !== undefined ? calibratedRaw / displayScale : undefined
  const calibratedDiffers = calibratedShown !== undefined && Math.abs(calibratedShown - value) > 0.01

  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wider text-muted flex items-center gap-1.5 mb-1">
        {label}
        {dirty && (
          <span className="text-[9px] px-1 py-px rounded bg-accent/15 text-accent font-medium leading-none"
                title="You manually edited this">EDITED</span>
        )}
        {!dirty && provenance?.source === 'historical' && (
          <span className="text-[9px] px-1 py-px rounded bg-positive/15 text-positive font-medium leading-none"
                title={provenance.note}>LIVE</span>
        )}
        {!dirty && provenance?.source === 'fallback' && (
          <span className="text-[9px] px-1 py-px rounded bg-warn/15 text-warn font-medium leading-none"
                title={provenance.note}>FALLBACK</span>
        )}
        {!dirty && provenance?.source === 'regulatory' && (
          <span className="text-[9px] px-1 py-px rounded bg-[#7c5cf6]/15 text-[#7c5cf6] font-medium leading-none"
                title={provenance.note}>RULE</span>
        )}
      </span>
      <div className="relative">
        <input
          type="number" value={value} step={step} min={min} max={max}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full text-[12px] tabular-nums border border-hairlineSoft rounded px-2 py-1.5 pr-12 bg-surface focus:outline-none focus:border-accent"
        />
        {unit && <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[9px] text-muted pointer-events-none whitespace-nowrap">{unit}</span>}
      </div>
      {/* Calibration strip — only when we have real historical stats */}
      {provenance?.stats && (
        <CalibrationStrip stats={provenance.stats} displayScale={displayScale}
                          differs={calibratedDiffers}
                          onReset={calibratedDiffers && onReset ? onReset : undefined} />
      )}
    </label>
  )
}

// =========================================================================
// BacktestPanel — runs the BESS spec over historical RRP to compute the
// real annual revenue (vs the naive "median × cycles × 365" guess).
// Shows annual headline, energy + FCAS split, monthly stacked bars, best
// day, and a "Use these values" button to snap the manual revenue inputs.
// =========================================================================

function BacktestPanel({
  backtest, loading, err, lookback, onLookbackChange,
  degCostPerMwh, onDegCostChange, maxCyclesPerDay, onMaxCyclesChange,
  onUseBacktest,
  onBackfill, backfillRunning, backfillDone, backfillDbDays,
  backfillMonthsDone, backfillMonthsTotal, t,
}: {
  backtest: BessBacktestResponse | null
  loading: boolean
  err: string | null
  lookback: number
  onLookbackChange: (d: number) => void
  degCostPerMwh: number
  onDegCostChange: (v: number) => void
  maxCyclesPerDay: number
  onMaxCyclesChange: (v: number) => void
  onUseBacktest: () => void
  onBackfill: () => void
  backfillRunning: boolean
  backfillDone: boolean
  backfillDbDays: number | null
  backfillMonthsDone: number
  backfillMonthsTotal: number
  t: (k: string, ...a: any[]) => string
}) {
  const nDays = backtest?.energy?.n_days_backtested ?? backtest?.fcas?.n_days_backtested ?? 0
  const hasFullYear = nDays >= 360

  if (err) {
    return (
      <div className="rounded-md border border-warn/30 bg-warn/[0.06] p-3 text-[11px] text-warn">
        Backtest unavailable: {err}
      </div>
    )
  }
  if (!backtest) {
    return (
      <div className="rounded-md border border-hairlineSoft bg-surfaceAlt/40 p-3 text-[11px] text-muted">
        {loading ? t('bc.bt.running') : t('bc.bt.waiting')}
      </div>
    )
  }
  const e = backtest.energy
  const f = backtest.fcas
  const fmtM = (v: number) => `$${(v / 1_000_000).toFixed(2)}M`
  const fmtK = (v: number) => `$${(v / 1_000).toFixed(0)}k`

  // Build monthly stacked data — match months across both energy & fcas
  const months: { month: string; energy: number; fcas: number }[] = []
  const allMonths = new Set<string>()
  e?.monthly.forEach(m => allMonths.add(m.month))
  f?.monthly.forEach(m => allMonths.add(m.month))
  const sortedMonths = Array.from(allMonths).sort()
  for (const m of sortedMonths) {
    const eRev = e?.monthly.find(x => x.month === m)?.energy_revenue_aud ?? 0
    const fRev = f?.monthly.find(x => x.month === m)?.fcas_revenue_aud ?? 0
    months.push({ month: m, energy: eRev, fcas: fRev })
  }
  const maxMonthRev = Math.max(...months.map(m => m.energy + m.fcas), 1)

  return (
    <div className="rounded-md border border-positive/25 bg-positive/[0.05] p-3 mb-2.5">
      {/* Header line */}
      <div className="flex items-baseline justify-between mb-2 flex-wrap gap-2">
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] px-1.5 py-px rounded-full bg-positive text-white font-bold tracking-wide">
            BACKTEST
          </span>
          <span className="text-[11px] text-ink2">
            {backtest.spec.power_mw}MW / {backtest.spec.duration_h.toFixed(1)}h · RTE {backtest.spec.rte_pct.toFixed(0)}%
            {e && <> · <span className="text-positive font-medium">{e.mean_cycles_per_day.toFixed(2)}×/day avg</span></>}
          </span>
        </div>
        <div className="text-right">
          <div className={`text-[18px] font-semibold tabular-nums leading-none text-positive ${loading ? 'opacity-50' : ''}`}>
            {fmtM(backtest.annual_total_revenue_aud)}
            <span className="text-[10px] text-muted font-normal ml-1">/yr</span>
          </div>
          {loading && <div className="text-[9px] text-muted mt-0.5 animate-pulse">recomputing…</div>}
        </div>
      </div>

      {/* Lookback selector */}
      <div className="flex items-center gap-2 mb-2 text-[10px]">
        <span className="text-muted">{t('bc.bt.window')}:</span>
        {[90, 180, 365].map((d) => (
          <button key={d} onClick={() => onLookbackChange(d)}
                  className={`px-2 py-0.5 rounded transition-colors ${
                    lookback === d
                      ? 'bg-positive text-white font-medium'
                      : 'bg-surface text-muted hover:text-ink ring-1 ring-hairlineSoft'
                  }`}>
            {d}d
          </button>
        ))}
        <span className="ml-auto text-muted tabular-nums">
          {nDays}/{lookback}d data
        </span>
      </div>

      {/* Backfill banner — shown when DB has < 360d, prompts user to top-up */}
      {!hasFullYear && (
        <div className={`mb-2 rounded px-2.5 py-2 text-[10px] flex items-center gap-2 ${
          backfillRunning
            ? 'bg-accent/[0.08] border border-accent/20 text-accent'
            : backfillDone
            ? 'bg-positive/[0.08] border border-positive/20 text-positive'
            : 'bg-warn/[0.08] border border-warn/20 text-warn'
        }`}>
          {backfillRunning ? (
            <>
              <span className="shrink-0 animate-spin">⟳</span>
              <span>
                Downloading {backfillMonthsDone}/{backfillMonthsTotal} months from AEMO archive
                {backfillDbDays !== null && ` · ${backfillDbDays}d in DB`}
              </span>
            </>
          ) : backfillDone ? (
            <span>✓ Backfill complete — {backfillDbDays ?? nDays}d now in DB. Re-running backtest…</span>
          ) : (
            <>
              <span className="shrink-0">⚠</span>
              <span className="flex-1">
                Only {nDays}d of data — spike days are under-represented. Download 12 months from AEMO?
              </span>
              <button
                onClick={onBackfill}
                className="shrink-0 px-2 py-0.5 rounded bg-warn text-white text-[10px] font-medium hover:opacity-90"
              >
                Backfill
              </button>
            </>
          )}
        </div>
      )}

      {/* Energy / FCAS breakdown */}
      <div className="grid grid-cols-2 gap-2 mb-2.5 text-[10px]">
        {e && (
          <div className="bg-surface rounded-md p-2 ring-1 ring-hairlineSoft">
            <div className="text-muted uppercase tracking-wider mb-1 flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-sm bg-[#ff9500]" />
              {t('bc.bt.energy')}
            </div>
            <div className="text-[14px] font-semibold tabular-nums text-ink leading-tight">
              {fmtM(e.annual_revenue_aud)}
            </div>
            <div className="text-[10px] text-muted mt-0.5 tabular-nums">
              {t('bc.bt.impliedSpread')}: <span className="text-ink2 font-medium">${e.implied_spread_per_mwh}/MWh</span>
            </div>
            <div className="text-[10px] text-muted tabular-nums">
              {t('bc.bt.capture')} {(e.capture_efficiency * 100).toFixed(0)}% · MLF {e.mlf_applied}
            </div>
            <div className="text-[10px] text-muted tabular-nums">
              {t('bc.bt.bestDay')}: <span className="text-ink2">{e.best_day.date ? `${e.best_day.date.slice(5)} ${fmtK(e.best_day.revenue)}` : '—'}</span>
            </div>
          </div>
        )}
        {f && (
          <div className="bg-surface rounded-md p-2 ring-1 ring-hairlineSoft">
            <div className="text-muted uppercase tracking-wider mb-1 flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-sm bg-positive" />
              {t('bc.bt.fcas')}
            </div>
            <div className="text-[14px] font-semibold tabular-nums text-ink leading-tight">
              {fmtM(f.annual_revenue_aud)}
            </div>
            <div className="text-[10px] text-muted mt-0.5 tabular-nums">
              {t('bc.bt.impliedPerMw')}: <span className="text-ink2 font-medium">${(f.per_mw_year_after_util / 1000).toFixed(1)}k/MW/yr</span>
            </div>
            <div className="text-[10px] text-muted tabular-nums">
              util {(f.utilisation * 100).toFixed(0)}% · raw ${(f.raw_per_mw_year / 1000).toFixed(0)}k
            </div>
            {Object.keys(f.by_market_per_mw_year).length > 0 && (() => {
              const sorted = Object.entries(f.by_market_per_mw_year).sort((a, b) => b[1] - a[1]).slice(0, 2)
              return (
                <div className="text-[10px] text-muted tabular-nums truncate">
                  top: {sorted.map(([k, v]) => `${k.replace(/SEC$|MIN$|REG$/, m => m === 'REG' ? 'reg' : m === 'MIN' ? 'min' : 's')} $${(v / 1000).toFixed(0)}k`).join(' · ')}
                </div>
              )
            })()}
          </div>
        )}
      </div>

      {/* Dynamic dispatch controls + cycle histogram */}
      {e && (
        <div className="mb-2.5">
          {/* Controls row */}
          <div className="flex items-center gap-3 mb-1.5 flex-wrap">
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] text-muted uppercase tracking-wider shrink-0">Deg cost</span>
              <div className="flex rounded overflow-hidden ring-1 ring-hairlineSoft text-[9px]">
                {[10, 20, 35, 60, 100].map(v => (
                  <button key={v} onClick={() => onDegCostChange(v)}
                    className={`px-1.5 py-px transition-colors ${degCostPerMwh === v ? 'bg-accent text-white font-medium' : 'bg-surface text-muted hover:text-ink'}`}>
                    ${v}
                  </button>
                ))}
              </div>
              <span className="text-[9px] text-muted">/MWh</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] text-muted uppercase tracking-wider shrink-0">Max cycles</span>
              <div className="flex rounded overflow-hidden ring-1 ring-hairlineSoft text-[9px]">
                {[1, 1.5, 2, 3].map(v => (
                  <button key={v} onClick={() => onMaxCyclesChange(v)}
                    className={`px-1.5 py-px transition-colors ${maxCyclesPerDay === v ? 'bg-accent text-white font-medium' : 'bg-surface text-muted hover:text-ink'}`}>
                    {v}×
                  </button>
                ))}
              </div>
            </div>
          </div>
          {/* Cycle histogram — shows distribution of cycles/day */}
          {(() => {
            const hist = e.cycle_histogram
            const buckets = Object.entries(hist).sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))
            const total = Object.values(hist).reduce((s, n) => s + n, 0)
            if (buckets.length === 0 || total === 0) return null
            return (
              <div>
                <div className="flex items-baseline justify-between mb-0.5">
                  <span className="text-[9px] text-muted uppercase tracking-wider">
                    Cycle distribution · avg {e.mean_cycles_per_day.toFixed(2)}×/day
                    {e.n_days_idle > 0 && <span className="text-warn ml-1">· {e.n_days_idle}d idle</span>}
                  </span>
                </div>
                <div className="flex gap-px items-end h-8">
                  {buckets.map(([bucket, count]) => {
                    const frac = count / total
                    const cycles = parseFloat(bucket)
                    const isAtCap = cycles >= maxCyclesPerDay - 0.01
                    return (
                      <div key={bucket} className="flex flex-col items-center gap-px flex-1" style={{ minWidth: 0 }}>
                        <div
                          className="w-full rounded-sm"
                          style={{
                            height: `${Math.max(frac * 100, 2)}%`,
                            background: cycles === 0 ? '#8e8e93' : isAtCap ? '#34c759' : '#ff9500',
                            opacity: 0.85,
                          }}
                          title={`${bucket}×/day: ${count} days (${(frac * 100).toFixed(0)}%)`}
                        />
                        <span className="text-[7px] text-muted tabular-nums">{bucket}</span>
                      </div>
                    )
                  })}
                </div>
                <div className="flex justify-between text-[8px] text-muted mt-0.5">
                  <span>cycles/day</span>
                  <span className="text-[8px]">
                    <span className="text-[#ff9500]">■</span> partial&nbsp;
                    <span className="text-positive">■</span> capped at {maxCyclesPerDay}×
                  </span>
                </div>
              </div>
            )
          })()}
        </div>
      )}

      {/* Spread waterfall — answers "why is the implied spread so low?" */}
      {e?.haircuts && <SpreadWaterfall h={e.haircuts} t={t} />}

      {/* Monthly stacked bar chart */}
      {months.length > 0 && (
        <div className="mb-2.5">
          <div className="flex items-baseline justify-between mb-1">
            <span className="text-[10px] text-muted uppercase tracking-wider">{t('bc.bt.monthly')}</span>
            <span className="text-[10px] text-muted tabular-nums">
              max ${(maxMonthRev / 1_000_000).toFixed(1)}M
            </span>
          </div>
          <svg viewBox={`0 0 ${months.length * 16 + 4} 50`} className="w-full" style={{ maxHeight: 60 }}>
            {months.map((m, i) => {
              const x = i * 16 + 2
              const eH = (m.energy / maxMonthRev) * 44
              const fH = (m.fcas / maxMonthRev) * 44
              const total = m.energy + m.fcas
              return (
                <g key={m.month}>
                  <rect x={x} y={50 - eH} width={12} height={eH} fill="#ff9500" fillOpacity={0.85}>
                    <title>{`${m.month}: Energy ${fmtK(m.energy)}, FCAS ${fmtK(m.fcas)}, Total ${fmtK(total)}`}</title>
                  </rect>
                  <rect x={x} y={50 - eH - fH} width={12} height={fH} fill="#34c759" fillOpacity={0.85} />
                </g>
              )
            })}
          </svg>
          <div className="flex justify-between text-[8px] text-muted tabular-nums px-1 mt-0.5">
            {months.length > 0 && <span>{months[0].month.slice(2)}</span>}
            {months.length > 6 && <span>{months[Math.floor(months.length / 2)].month.slice(2)}</span>}
            {months.length > 0 && <span>{months[months.length - 1].month.slice(2)}</span>}
          </div>
        </div>
      )}

      {/* Action: snap inputs to backtested values */}
      <button onClick={onUseBacktest}
              className="w-full text-[11px] py-2 rounded-md bg-positive text-white font-medium hover:opacity-90 transition-opacity">
        {t('bc.bt.useValues')}
      </button>
      <div className="text-[9px] text-muted mt-1.5 leading-relaxed">
        {t('bc.bt.methodology')}
      </div>
    </div>
  )
}

// =========================================================================
// SpreadWaterfall — shows how the raw NSW price-spread gets haircut
// step-by-step (RTE → MLF → capture efficiency) to arrive at the net
// implied $/MWh that feeds the revenue model.
// =========================================================================

function SpreadWaterfall({
  h, t,
}: {
  h: BessBacktestHaircuts
  t: (k: string, ...a: any[]) => string
}) {
  const steps = [
    {
      label: t('bc.wf.gross', 'Gross market spread'),
      value: h.gross_market_spread_per_mwh,
      loss: null as number | null,
      lossPct: null as number | null,
      color: '#ff9500',
    },
    {
      label: t('bc.wf.afterRte', 'After RTE losses'),
      value: h.after_rte_per_mwh,
      loss: h.gross_market_spread_per_mwh - h.after_rte_per_mwh,
      lossPct: h.rte_loss_pct,
      color: '#ff9500',
    },
    {
      label: t('bc.wf.afterMlf', 'After MLF + aux'),
      value: h.after_mlf_aux_per_mwh,
      loss: h.after_rte_per_mwh - h.after_mlf_aux_per_mwh,
      lossPct: h.mlf_aux_loss_pct,
      color: '#ff9500',
    },
    {
      label: t('bc.wf.afterCapture', 'After capture eff.'),
      value: h.after_capture_per_mwh,
      loss: h.after_mlf_aux_per_mwh - h.after_capture_per_mwh,
      lossPct: h.capture_loss_pct,
      color: '#34c759',
    },
  ]
  const maxVal = h.gross_market_spread_per_mwh || 1

  return (
    <div className="mb-2.5">
      <div className="text-[10px] text-muted uppercase tracking-wider mb-1.5">
        {t('bc.wf.title', 'Spread waterfall ($/MWh discharged)')}
      </div>
      <div className="space-y-1">
        {steps.map((s, i) => {
          const barW = Math.max(0, (s.value / maxVal) * 100)
          return (
            <div key={i} className="flex items-center gap-1.5">
              <div className="w-[110px] shrink-0 text-[9px] text-muted leading-tight">{s.label}</div>
              <div className="flex-1 relative h-4 bg-surface rounded overflow-hidden">
                <div
                  className="absolute inset-y-0 left-0 rounded"
                  style={{ width: `${barW}%`, background: s.color, opacity: 0.8 }}
                />
                <div className="absolute inset-0 flex items-center px-1.5">
                  <span className="text-[9px] font-medium tabular-nums text-ink2">
                    ${s.value.toFixed(1)}/MWh
                  </span>
                </div>
              </div>
              {s.lossPct !== null && (
                <div className="w-[36px] shrink-0 text-right text-[9px] text-negative tabular-nums">
                  −{s.lossPct.toFixed(1)}%
                </div>
              )}
              {s.lossPct === null && <div className="w-[36px] shrink-0" />}
            </div>
          )
        })}
      </div>
      <div className="mt-1 text-[9px] text-muted leading-relaxed">
        {t('bc.wf.hint',
          `Raw spread (top ${Math.round(h.gross_market_spread_per_mwh > 0 ? 100 * h.after_capture_per_mwh / h.gross_market_spread_per_mwh : 0)}% retained after RTE, MLF and capture efficiency haircuts)`
        )}
      </div>
    </div>
  )
}

// =========================================================================
// CapexBreakdown — visual proof that CapEx auto-tracks project scale.
// Shows the three additive components (power-related, energy-related,
// fixed) as a tiny stacked bar with $-figures, so the user can see WHY
// the CapEx number changes when they nudge MW or MWh.
// =========================================================================

function CapexBreakdown({
  power_mw, energy_mwh, cost_per_kw, cost_per_kwh, fixed, capex, isOverride, t,
}: {
  power_mw: number; energy_mwh: number; cost_per_kw: number;
  cost_per_kwh: number; fixed: number; capex: number; isOverride: boolean;
  t: (k: string, ...a: any[]) => string
}) {
  const powerCost = power_mw * 1000 * cost_per_kw
  const energyCost = energy_mwh * 1000 * cost_per_kwh
  const fixedCost = fixed
  const derived = powerCost + energyCost + fixedCost
  const total = isOverride ? capex : derived
  const fmtM = (v: number) => `$${(v / 1_000_000).toFixed(1)}M`
  // Use derived sum for proportions (the user override doesn't change the
  // underlying mix, just the headline number).
  const denom = derived || 1
  const wP = (powerCost / denom) * 100
  const wE = (energyCost / denom) * 100
  const wF = (fixedCost / denom) * 100
  return (
    <div className={`mt-1 px-2 py-1.5 rounded text-[10px] ${
      isOverride
        ? 'bg-accent/[0.06] border border-accent/15'
        : 'bg-positive/[0.06] border border-positive/15'
    }`}>
      {/* Top line: chip + total */}
      <div className="flex items-baseline justify-between mb-1.5">
        <span className={`font-medium ${isOverride ? 'text-accent' : 'text-positive'}`}>
          {isOverride ? t('bc.capex.override') : t('bc.capex.derived')}
        </span>
        {isOverride && (
          <span className="text-muted tabular-nums">
            {t('bc.capex.wouldBe')} {fmtM(derived)}
          </span>
        )}
      </div>
      {/* Stacked bar */}
      <div className="h-1.5 w-full rounded-full overflow-hidden flex bg-surface ring-1 ring-hairlineSoft">
        <div className="h-full bg-[#0a84ff]"   style={{ width: `${wP}%` }} title={`Power ${fmtM(powerCost)}`} />
        <div className="h-full bg-positive"   style={{ width: `${wE}%` }} title={`Energy ${fmtM(energyCost)}`} />
        {wF > 0 && (
          <div className="h-full bg-[#86868b]" style={{ width: `${wF}%` }} title={`Fixed ${fmtM(fixedCost)}`} />
        )}
      </div>
      {/* Component labels */}
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[9px] text-muted tabular-nums">
        <span className="inline-flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-sm bg-[#0a84ff]" />
          {t('bc.capex.power')}: <span className="text-ink2 font-medium">{fmtM(powerCost)}</span>
          <span>({power_mw}MW × ${cost_per_kw}/kW)</span>
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-sm bg-positive" />
          {t('bc.capex.energy')}: <span className="text-ink2 font-medium">{fmtM(energyCost)}</span>
          <span>({energy_mwh.toFixed(0)}MWh × ${cost_per_kwh}/kWh)</span>
        </span>
        {fixedCost > 0 && (
          <span className="inline-flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-sm bg-[#86868b]" />
            {t('bc.capex.fixed')}: <span className="text-ink2 font-medium">{fmtM(fixedCost)}</span>
          </span>
        )}
        <span className="ml-auto">
          = <span className="text-ink font-semibold">{fmtM(total)}</span>
        </span>
      </div>
    </div>
  )
}

// =========================================================================
// CalibrationStrip — small reference line under a calibrated input showing
// the historical distribution (median / IQR / last 7d) so the user knows
// what range "real" looks like before they override.
// =========================================================================

function CalibrationStrip({ stats, displayScale, onReset }: {
  stats: NonNullable<BessProvenance['stats']>
  displayScale: number
  /** Whether the user value differs from calibrated — already computed by
   *  the caller; we just decide whether to render the reset button based
   *  on whether `onReset` is supplied. */
  differs?: boolean
  onReset?: () => void
}) {
  // Pull the right keys depending on whether this is an arb-spread or
  // FCAS stat block (we use median/IQR for arb, daily_*/utilisation for FCAS).
  const isFcas = 'raw_per_mw_year' in stats
  const fmt = (v: number | null | undefined) => v === null || v === undefined
    ? '—'
    : (v / displayScale).toLocaleString('en-AU', { maximumFractionDigits: 1 })

  const median = isFcas ? stats.value : stats.median
  const p25 = isFcas ? null : stats.p25
  const p75 = isFcas ? null : stats.p75
  // For FCAS the backend now ships `last_7d_mean` already annualised +
  // utilisation-adjusted (matches `stats.value` units). For arb spread
  // `last_7d_mean` is also in the same $/MWh units as `stats.median`.
  // So one field works for both — no need to swap to `last_7d_daily_mean`.
  const last7 = stats.last_7d_mean

  return (
    <div className="mt-1 px-2 py-1 bg-positive/[0.06] border border-positive/15 rounded text-[10px] flex items-center gap-x-3 gap-y-0.5 flex-wrap">
      <span className="text-positive font-medium tabular-nums">
        ≈ {fmt(median)}
      </span>
      {!isFcas && p25 !== undefined && p75 !== undefined && (
        <span className="text-muted tabular-nums">
          IQR <span className="text-ink2">{fmt(p25)}–{fmt(p75)}</span>
        </span>
      )}
      {last7 !== null && last7 !== undefined && (
        <span className="text-muted tabular-nums">
          7d <span className={
            Math.abs(last7 - (median ?? 0)) / (median || 1) > 0.2
              ? 'text-warn font-medium'
              : 'text-ink2'
          }>{fmt(last7)}</span>
        </span>
      )}
      {isFcas && stats.utilisation !== undefined && (
        <span className="text-muted" title={`Raw ${fmt(stats.raw_per_mw_year)} × ${(stats.utilisation * 100).toFixed(0)}% utilisation`}>
          util {(stats.utilisation * 100).toFixed(0)}%
        </span>
      )}
      <span className="text-muted/70 tabular-nums">
        {stats.n_days}/{stats.lookback_days}d
      </span>
      {onReset && (
        <button onClick={onReset}
                className="ml-auto text-positive hover:underline font-medium tabular-nums"
                title="Reset to calibrated value">
          ↺ use {fmt(median)}
        </button>
      )}
    </div>
  )
}

// ---- KPI Row ------------------------------------------------------------

function KpiRow({ model, loading, t }: { model: BessModelResponse; loading: boolean; t: any }) {
  const s = model.summary
  const status = (s.equity_irr_pct ?? 0) >= 12 ? 'good' : (s.equity_irr_pct ?? 0) >= 8 ? 'ok' : 'poor'
  const statusStyle = status === 'good' ? 'text-positive bg-positive/10'
    : status === 'ok' ? 'text-accent bg-accent/10'
    : 'text-warn bg-warn/10'
  return (
    <section className="bg-surface rounded-xl2 p-6 shadow-card relative">
      {loading && (
        <span className="absolute top-3 right-4 text-[10px] text-muted animate-pulse">{t('bc.kpi.computing')}</span>
      )}
      <div className="flex items-baseline justify-between mb-4 flex-wrap gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-muted">{t('bc.kpi.kicker')}</div>
          <div className="text-[15px] font-semibold tracking-tight text-ink mt-0.5">
            {t('bc.kpi.title', `${model.inputs.power_mw} MW`, `${model.inputs.duration_h} h`, model.inputs.region)}
          </div>
        </div>
        <span className={`px-3 py-1 rounded-full text-[11px] font-semibold ${statusStyle}`}>
          {status === 'good' ? t('bc.kpi.attractive')
            : status === 'ok' ? t('bc.kpi.marginal')
            : t('bc.kpi.weak')}
        </span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-6 gap-2.5">
        <KpiCard label={t('bc.kpi.npv')} value={fmtMoney(s.npv_aud)} accent={s.npv_aud > 0 ? 'positive' : 'negative'} />
        <KpiCard label={t('bc.kpi.projIrr')} value={fmtPct(s.project_irr_pct)} sub={`@ ${model.inputs.discount_rate_pct}% WACC`}
                  accent={(s.project_irr_pct ?? 0) >= model.inputs.discount_rate_pct ? 'positive' : 'warn'} />
        <KpiCard label={t('bc.kpi.eqIrr')} value={fmtPct(s.equity_irr_pct)} sub={`${model.inputs.debt_pct.toFixed(0)}% debt`}
                  accent={(s.equity_irr_pct ?? 0) >= 12 ? 'positive' : (s.equity_irr_pct ?? 0) >= 8 ? 'warn' : 'negative'} />
        <KpiCard label={t('bc.kpi.payback')} value={fmtYears(s.payback_simple_years)}
                  sub={s.payback_discounted_years ? `disc ${fmtYears(s.payback_discounted_years)}` : ''} />
        <KpiCard label={t('bc.kpi.lcos')} value={s.lcos_per_mwh ? `$${s.lcos_per_mwh.toFixed(0)}` : '—'} sub="$/MWh dispatched" />
        <KpiCard label={t('bc.kpi.dscr')} value={s.min_dscr ? s.min_dscr.toFixed(2) + 'x' : '—'} sub={`avg ${s.avg_dscr?.toFixed(2) ?? '—'}x`}
                  accent={(s.min_dscr ?? 0) >= 1.3 ? 'positive' : (s.min_dscr ?? 0) >= 1.1 ? 'warn' : 'negative'} />
      </div>
      <div className="mt-4 grid grid-cols-3 gap-3 pt-3 border-t border-hairlineSoft text-[11px]">
        <div><span className="text-muted">{t('bc.kpi.debtAmt')}: </span><span className="tabular-nums font-medium">{fmtMoney(s.debt_amount)}</span></div>
        <div><span className="text-muted">{t('bc.kpi.eqAmt')}: </span><span className="tabular-nums font-medium">{fmtMoney(s.equity_amount)}</span></div>
        <div><span className="text-muted">{t('bc.kpi.annualDS')}: </span><span className="tabular-nums font-medium">{fmtMoney(s.annual_debt_service)}</span></div>
        <div><span className="text-muted">{t('bc.kpi.totalRev')}: </span><span className="tabular-nums font-medium">{fmtMoney(s.total_revenue_lifetime)}</span></div>
        <div><span className="text-muted">{t('bc.kpi.totalOpex')}: </span><span className="tabular-nums font-medium">{fmtMoney(s.total_opex_lifetime)}</span></div>
        <div><span className="text-muted">{t('bc.kpi.totalMwh')}: </span><span className="tabular-nums font-medium">{(s.total_discharge_mwh / 1000).toFixed(0)}k MWh</span></div>
      </div>
    </section>
  )
}

function KpiCard({ label, value, sub, accent }: {
  label: string; value: string; sub?: string;
  accent?: 'positive' | 'negative' | 'warn'
}) {
  const color = accent === 'positive' ? 'text-positive' : accent === 'negative' ? 'text-negative' : accent === 'warn' ? 'text-warn' : 'text-ink'
  return (
    <div className="bg-surfaceAlt rounded-md px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`text-[17px] font-semibold tabular-nums mt-0.5 leading-tight ${color}`}>{value}</div>
      {sub && <div className="text-[9px] text-muted mt-0.5">{sub}</div>}
    </div>
  )
}

// ---- Revenue stacked area chart -----------------------------------------

function RevenueChart({ yearly, t }: { yearly: BessYearlyRow[]; t: any }) {
  // Skip year 0 (construction)
  const data = yearly.filter(r => r.year > 0)
  const maxRev = Math.max(...data.map(r => r.total_revenue), 1)
  const W = 700, H = 200, padL = 50, padR = 16, padT = 16, padB = 28
  const innerW = W - padL - padR
  const innerH = H - padT - padB
  const barW = innerW / data.length

  return (
    <section className="bg-surface rounded-xl2 p-6 shadow-card">
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-muted">{t('bc.rev.kicker')}</div>
          <div className="text-[15px] font-semibold tracking-tight text-ink mt-0.5">{t('bc.rev.title')}</div>
        </div>
        <div className="flex items-center gap-3 text-[10px]">
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm" style={{ background: '#ff9500' }} />{t('bc.rev.energy')}</span>
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm" style={{ background: '#34c759' }} />{t('bc.rev.fcas')}</span>
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm" style={{ background: '#5cc8ff' }} />{t('bc.rev.cis')}</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 240 }}>
        {/* Grid lines */}
        {[0.25, 0.5, 0.75, 1].map((p) => (
          <line key={p} x1={padL} y1={padT + innerH * (1 - p)} x2={W - padR} y2={padT + innerH * (1 - p)}
                stroke="#ececef" strokeWidth={0.5} strokeDasharray={p === 1 ? undefined : '2 3'} />
        ))}
        {/* Y-axis labels */}
        {[0, 0.5, 1].map((p) => (
          <text key={p} x={padL - 6} y={padT + innerH * (1 - p) + 3} fontSize={9} fill="#86868b" textAnchor="end" className="tabular-nums">
            ${(maxRev * p / 1_000_000).toFixed(1)}M
          </text>
        ))}
        {/* Stacked bars */}
        {data.map((r, i) => {
          const x = padL + i * barW + barW * 0.15
          const w = barW * 0.7
          const eH = (r.energy_revenue / maxRev) * innerH
          const fH = (r.fcas_revenue / maxRev) * innerH
          const cH = (r.cis_revenue / maxRev) * innerH
          let y = padT + innerH
          return (
            <g key={i}>
              <rect x={x} y={y - eH} width={w} height={eH} fill="#ff9500" fillOpacity={0.85} />
              <rect x={x} y={y - eH - fH} width={w} height={fH} fill="#34c759" fillOpacity={0.85} />
              {cH > 0 && <rect x={x} y={y - eH - fH - cH} width={w} height={cH} fill="#5cc8ff" fillOpacity={0.85} />}
              {/* X-axis label every 2 years */}
              {(r.year % 2 === 1) && (
                <text x={x + w/2} y={H - padB + 12} fontSize={9} fill="#86868b" textAnchor="middle" className="tabular-nums">
                  {r.year}
                </text>
              )}
            </g>
          )
        })}
        <line x1={padL} y1={padT + innerH} x2={W - padR} y2={padT + innerH} stroke="#d2d2d7" strokeWidth={0.8} />
      </svg>
      <div className="text-[10px] text-muted mt-1">{t('bc.rev.note')}</div>
    </section>
  )
}

// ---- Tornado chart ------------------------------------------------------

function TornadoChart({ rows, t }: { rows: BessSensitivityRow[]; t: any }) {
  const maxSwing = Math.max(...rows.map(r => Math.abs(r.swing_pct ?? 0)), 0.1)
  const baseIrr = rows[0]?.base_irr_pct ?? 0

  return (
    <section className="bg-surface rounded-xl2 p-6 shadow-card">
      <div className="mb-3">
        <div className="text-[11px] uppercase tracking-[0.22em] text-muted">{t('bc.torn.kicker')}</div>
        <div className="text-[15px] font-semibold tracking-tight text-ink mt-0.5">{t('bc.torn.title')}</div>
        <div className="text-[12px] text-muted mt-0.5">{t('bc.torn.hint', baseIrr.toFixed(1))}</div>
      </div>
      <div className="space-y-2">
        {rows.map((r) => {
          const down = r.down_irr_pct ?? baseIrr
          const up = r.up_irr_pct ?? baseIrr
          const downDelta = down - baseIrr
          const upDelta = up - baseIrr
          // Bar goes from min(downDelta, upDelta) to max — sometimes both
          // negative (e.g. "high CapEx → lower IRR")
          const lo = Math.min(downDelta, upDelta)
          const hi = Math.max(downDelta, upDelta)
          const W = 400
          const cx = W / 2
          const scale = (W / 2 - 10) / maxSwing
          const xLo = cx + lo * scale
          const xHi = cx + hi * scale
          return (
            <div key={r.driver} className="grid grid-cols-[180px_1fr_60px] gap-2 items-center text-[11px]">
              <span className="text-ink2 truncate" title={r.driver}>{r.driver}</span>
              <svg viewBox={`0 0 ${W} 20`} className="w-full">
                {/* Axis */}
                <line x1={0} y1={10} x2={W} y2={10} stroke="#ececef" strokeWidth={0.5} />
                <line x1={cx} y1={2} x2={cx} y2={18} stroke="#86868b" strokeWidth={0.7} />
                {/* Down bar (left of centre) */}
                <rect x={Math.min(xLo, cx)} y={5} width={Math.abs(cx - Math.min(xLo, cx))} height={10}
                      fill="#ff9500" fillOpacity={0.7} />
                {/* Up bar (right of centre) */}
                <rect x={cx} y={5} width={Math.max(0, xHi - cx)} height={10}
                      fill="#34c759" fillOpacity={0.7} />
                <text x={xLo - 4} y={14} fontSize={9} fill="#86868b" textAnchor="end" className="tabular-nums">
                  {down.toFixed(1)}%
                </text>
                <text x={xHi + 4} y={14} fontSize={9} fill="#86868b" textAnchor="start" className="tabular-nums">
                  {up.toFixed(1)}%
                </text>
              </svg>
              <span className="text-right tabular-nums font-medium text-ink">
                ±{(Math.abs(r.swing_pct ?? 0) / 2).toFixed(1)}pp
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}

// ---- DSCR curve ---------------------------------------------------------

function DscrCurve({ yearly, t }: { yearly: BessYearlyRow[]; t: any }) {
  const points = yearly.filter(r => r.dscr !== null).map(r => ({ year: r.year, dscr: r.dscr as number }))
  if (points.length === 0) return null
  const W = 700, H = 120, padL = 40, padR = 16, padT = 12, padB = 24
  const innerW = W - padL - padR, innerH = H - padT - padB
  const maxDscr = Math.max(...points.map(p => p.dscr), 2)
  const minDscr = Math.min(...points.map(p => p.dscr), 1)
  const yRange = maxDscr - minDscr || 1
  const xAt = (i: number) => padL + (innerW * i) / Math.max(points.length - 1, 1)
  const yAt = (d: number) => padT + innerH * (1 - (d - minDscr) / yRange)
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i)} ${yAt(p.dscr)}`).join(' ')

  return (
    <section className="bg-surface rounded-xl2 p-6 shadow-card">
      <div className="flex items-baseline justify-between mb-2">
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-muted">{t('bc.dscr.kicker')}</div>
          <div className="text-[15px] font-semibold tracking-tight text-ink mt-0.5">{t('bc.dscr.title')}</div>
        </div>
        <div className="text-[10px] text-muted">{t('bc.dscr.hint')}</div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 140 }}>
        {/* Bank threshold lines */}
        {[1.0, 1.3].map((v) => (
          v >= minDscr && v <= maxDscr && (
            <g key={v}>
              <line x1={padL} y1={yAt(v)} x2={W - padR} y2={yAt(v)}
                    stroke={v === 1 ? '#ff3b30' : '#ff9500'} strokeWidth={0.8} strokeDasharray="3 3" />
              <text x={W - padR - 4} y={yAt(v) - 3} fontSize={9} fill={v === 1 ? '#ff3b30' : '#ff9500'} textAnchor="end">
                {v === 1 ? 'breach 1.0x' : 'bank min 1.3x'}
              </text>
            </g>
          )
        ))}
        <path d={path} fill="none" stroke="#0a84ff" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
        {points.map((p, i) => (
          <circle key={i} cx={xAt(i)} cy={yAt(p.dscr)} r={2.5} fill="#0a84ff" />
        ))}
        {/* Year labels */}
        {points.filter((_, i) => i % 2 === 0).map((p, i) => (
          <text key={i} x={xAt(p.year - 1)} y={H - 5} fontSize={9} fill="#86868b" textAnchor="middle" className="tabular-nums">
            {p.year}
          </text>
        ))}
      </svg>
    </section>
  )
}

// ---- Cashflow table -----------------------------------------------------

function CashflowTable({ yearly, t }: { yearly: BessYearlyRow[]; t: any }) {
  return (
    <section className="bg-surface rounded-xl2 p-6 shadow-card">
      <div className="text-[11px] uppercase tracking-[0.22em] text-muted">{t('bc.cf.kicker')}</div>
      <div className="text-[15px] font-semibold tracking-tight text-ink mt-0.5 mb-3">{t('bc.cf.title')}</div>
      <div className="overflow-x-auto -mx-2">
        <table className="w-full text-[11px]">
          <thead className="text-muted text-[10px] uppercase tracking-wide">
            <tr>
              <th className="text-left px-2 py-1.5 font-medium">Year</th>
              <th className="text-right px-2 py-1.5 font-medium">Energy</th>
              <th className="text-right px-2 py-1.5 font-medium">FCAS</th>
              <th className="text-right px-2 py-1.5 font-medium">Revenue</th>
              <th className="text-right px-2 py-1.5 font-medium">OpEx</th>
              <th className="text-right px-2 py-1.5 font-medium">EBITDA</th>
              <th className="text-right px-2 py-1.5 font-medium">Interest</th>
              <th className="text-right px-2 py-1.5 font-medium">Principal</th>
              <th className="text-right px-2 py-1.5 font-medium">Tax</th>
              <th className="text-right px-2 py-1.5 font-medium">CapEx</th>
              <th className="text-right px-2 py-1.5 font-medium">CF Eq</th>
              <th className="text-right px-2 py-1.5 font-medium">Cum Eq</th>
              <th className="text-right px-2 py-1.5 font-medium">DSCR</th>
              <th className="text-right px-2 py-1.5 font-medium">Cap</th>
            </tr>
          </thead>
          <tbody>
            {yearly.map((r) => (
              <tr key={r.year} className="border-t border-hairlineSoft/60 hover:bg-surfaceAlt/30">
                <td className="px-2 py-1 tabular-nums text-muted">{r.year}</td>
                <td className="px-2 py-1 text-right tabular-nums">{r.energy_revenue === 0 ? '—' : fmtMoney(r.energy_revenue, 'k')}</td>
                <td className="px-2 py-1 text-right tabular-nums">{r.fcas_revenue === 0 ? '—' : fmtMoney(r.fcas_revenue, 'k')}</td>
                <td className="px-2 py-1 text-right tabular-nums font-medium">{r.total_revenue === 0 ? '—' : fmtMoney(r.total_revenue, 'k')}</td>
                <td className="px-2 py-1 text-right tabular-nums text-muted">{r.opex === 0 ? '—' : `-${fmtMoney(r.opex, 'k')}`}</td>
                <td className="px-2 py-1 text-right tabular-nums font-medium">{r.ebitda === 0 ? '—' : fmtMoney(r.ebitda, 'k')}</td>
                <td className="px-2 py-1 text-right tabular-nums text-muted">{r.interest === 0 ? '—' : `-${fmtMoney(r.interest, 'k')}`}</td>
                <td className="px-2 py-1 text-right tabular-nums text-muted">{r.principal_repayment === 0 ? '—' : `-${fmtMoney(r.principal_repayment, 'k')}`}</td>
                <td className="px-2 py-1 text-right tabular-nums text-muted">{r.tax === 0 ? '—' : `-${fmtMoney(r.tax, 'k')}`}</td>
                <td className="px-2 py-1 text-right tabular-nums text-negative">{r.capex === 0 ? '—' : fmtMoney(Math.abs(r.capex), 'k')}</td>
                <td className={`px-2 py-1 text-right tabular-nums font-medium ${r.cashflow_equity < 0 ? 'text-negative' : 'text-positive'}`}>
                  {fmtMoney(r.cashflow_equity, 'k')}
                </td>
                <td className={`px-2 py-1 text-right tabular-nums ${r.cumulative_cf_equity < 0 ? 'text-negative' : 'text-positive'}`}>
                  {fmtMoney(r.cumulative_cf_equity, 'k')}
                </td>
                <td className="px-2 py-1 text-right tabular-nums text-muted">{r.dscr === null ? '—' : `${r.dscr.toFixed(2)}x`}</td>
                <td className="px-2 py-1 text-right tabular-nums text-muted">{r.capacity_factor_pct === 0 ? '—' : `${r.capacity_factor_pct.toFixed(0)}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="text-[10px] text-muted mt-2">{t('bc.cf.note')}</div>
    </section>
  )
}

// ---- Assumptions provenance panel ---------------------------------------

function ProvenancePanel({ provenance, t }: {
  provenance: Record<string, BessProvenance>
  t: any
}) {
  const sourceBadge: Record<string, { bg: string; fg: string; label: string }> = {
    historical:        { bg: 'bg-positive/12', fg: 'text-positive', label: 'Historical NEM data' },
    fallback:          { bg: 'bg-warn/12',     fg: 'text-warn',     label: 'Fallback (no data yet)' },
    industry:          { bg: 'bg-accent/12',   fg: 'text-accent',   label: 'Industry default' },
    regulatory:        { bg: 'bg-[#7c5cf6]/12', fg: 'text-[#7c5cf6]', label: 'Regulatory (ATO/AEMO)' },
    regional_baseline: { bg: 'bg-[#0a84ff]/12', fg: 'text-[#0a84ff]', label: 'Regional baseline' },
  }
  // Group by source
  const grouped: Record<string, { key: string; note?: string }[]> = {}
  for (const [key, p] of Object.entries(provenance)) {
    if (!grouped[p.source]) grouped[p.source] = []
    grouped[p.source].push({ key, note: p.note })
  }
  return (
    <section className="bg-surface rounded-xl2 p-6 shadow-card">
      <div className="text-[11px] uppercase tracking-[0.22em] text-muted">{t('bc.prov.kicker')}</div>
      <div className="text-[15px] font-semibold tracking-tight text-ink mt-0.5 mb-3">{t('bc.prov.title')}</div>
      <div className="text-[12px] text-muted mb-3">{t('bc.prov.hint')}</div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[11px]">
        {Object.entries(grouped).map(([source, items]) => {
          const style = sourceBadge[source] ?? sourceBadge.industry
          return (
            <div key={source} className="rounded-md border border-hairlineSoft bg-surfaceAlt/40 p-3">
              <div className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold mb-2 ${style.bg} ${style.fg}`}>
                {style.label}
              </div>
              <ul className="space-y-1">
                {items.map((it) => (
                  <li key={it.key}>
                    <span className="text-ink2 font-mono text-[10px]">{it.key}</span>
                    {it.note && <span className="text-muted ml-2">— {it.note}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )
        })}
      </div>
    </section>
  )
}
