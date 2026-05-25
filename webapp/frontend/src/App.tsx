import { useEffect, useMemo, useState } from 'react'
import {
  fetchConstraints, fetchFCAS, fetchForecast, fetchGenerators, fetchGrid,
  fetchHeatmap, fetchHistory, fetchSnapshot, openSnapshotStream,
} from './api'
import type {
  Constraints, FCASMatrix, Forecast, GeneratorsSnapshot, GridSnapshot, Heatmap,
  History, Snapshot,
} from './types'
import { Header } from './components/Header'
import { RegionTile, regionTilePropsForNEM, regionTilePropsForWEM } from './components/RegionTile'
import { PriceChart } from './components/PriceChart'
import { PriceKPIs } from './components/PriceKPIs'
import { FCASMatrixView } from './components/FCASMatrix'
import { HeatMap } from './components/HeatMap'
import { NEMMap } from './components/NEMMap'
import { NSWDeepDive } from './components/NSWDeepDive'
import { VPPConsole } from './components/VPPConsole'
import { BESSCalculator } from './components/BESSCalculator'
import { useT } from './i18n'

const REGIONS = ['NSW1', 'QLD1', 'VIC1', 'SA1', 'TAS1', 'WEM']

type View = 'nem' | 'nsw' | 'vpp' | 'bess-calc'

export default function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [selected, setSelected] = useState<string>('NSW1')
  const [history, setHistory] = useState<History | null>(null)
  const [forecast, setForecast] = useState<Forecast | null>(null)
  const [constraints, setConstraints] = useState<Constraints | null>(null)
  const [fcas, setFcas] = useState<FCASMatrix | null>(null)
  const [grid, setGrid] = useState<GridSnapshot | null>(null)
  const [gens, setGens] = useState<GeneratorsSnapshot | null>(null)
  const [heatmap, setHeatmap] = useState<Heatmap | null>(null)
  const [hours, setHours] = useState<number>(24)
  const [live, setLive] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [view, setView] = useState<View>('nem')
  const { t } = useT()

  useEffect(() => {
    fetchSnapshot().then(setSnap).catch(console.error)
    fetchFCAS().then(setFcas).catch(console.error)
    fetchGrid().then(setGrid).catch(console.error)
    fetchGenerators().then(setGens).catch(console.error)
    fetchHeatmap(90).then(setHeatmap).catch(console.error)
    const close = openSnapshotStream((s) => {
      setSnap(s)
      setLive(true)
    })
    return close
  }, [])

  useEffect(() => {
    if (!snap) return
    fetchFCAS().then(setFcas).catch(() => {})
    fetchGrid().then(setGrid).catch(() => {})
    fetchGenerators().then(setGens).catch(() => {})
  }, [snap?.generated_at])

  // Heatmap is daily-grained — refresh once an hour is plenty.
  useEffect(() => {
    const id = setInterval(() => {
      fetchHeatmap(90).then(setHeatmap).catch(() => {})
    }, 60 * 60 * 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    setHistoryLoading(true)
    fetchHistory(selected, hours)
      .then(setHistory)
      .catch(console.error)
      .finally(() => setHistoryLoading(false))
  }, [selected, hours, snap?.generated_at])

  // Binding-constraint overlay: only worth fetching when we're showing a
  // NEM region (WEM has no DISPATCHCONSTRAINT data) and on close-up views
  // — beyond a day the marker density becomes noise. We pass `hours` as the
  // window so the overlay matches whatever the user picked for the chart.
  useEffect(() => {
    if (selected === 'WEM' || hours > 24) {
      setConstraints(null)
      return
    }
    fetchConstraints(selected, hours)
      .then(setConstraints)
      .catch(() => setConstraints(null))
  }, [selected, hours, snap?.generated_at])

  // AEMO forecast overlay only renders on the close-up views (6h / 1d). We
  // fetch forecasts spanning the full window (past_hours = hours) plus a
  // future tail, so the dashed line overlays the solid line for the past
  // window and extends into the future as far as AEMO publishes. P5MIN
  // covers ~1h ahead at 5-min resolution; PREDISPATCHIS extends to ~24-40h
  // ahead at 30-min resolution. On the 1d view we want the full PREDISPATCH
  // horizon visible; on the 6h view a shorter tail keeps the chart balanced.
  useEffect(() => {
    if (selected === 'WEM' || hours > 24) {
      setForecast(null)
      return
    }
    const futureHours = hours >= 24 ? 40 : 8
    fetchForecast(selected, hours, futureHours)
      .then(setForecast)
      .catch(() => setForecast(null))
  }, [selected, hours, snap?.generated_at])

  const nemMap = useMemo(() => {
    const m = new Map<string, any>()
    snap?.nem.forEach((r) => m.set(r.regionid, r))
    return m
  }, [snap])

  const selectedLabel = selected === 'WEM'
    ? `WA · ${t('sec.suffix.wemRtp')}`
    : `${selected.replace(/1$/, '')} · ${t('sec.suffix.rrp')}`

  return (
    <div className="min-h-screen flex flex-col bg-canvas">
      <Header generatedAt={snap?.generated_at ?? null} live={live} />

      <main className="flex-1 px-8 py-10 max-w-[1400px] w-full mx-auto">
        {/* Page intro + view toggle */}
        <div className="mb-8 flex items-end justify-between gap-6">
          <div>
            <h1 className="text-[28px] font-semibold tracking-tight text-ink leading-tight">
              {view === 'nem' ? t('intro.titleNem')
               : view === 'nsw' ? t('intro.titleNsw')
               : view === 'bess-calc' ? t('intro.titleBessCalc')
               : t('nav.vpp')}
            </h1>
            <p className="text-[15px] text-ink2 mt-2">
              {view === 'nem' ? t('intro.subtitleNem')
               : view === 'nsw' ? t('intro.subtitleNsw')
               : view === 'bess-calc' ? t('intro.subtitleBessCalc')
               : t('vpp.kicker')}
            </p>
          </div>
          <div className="flex gap-1 p-0.5 bg-surfaceAlt rounded-lg shrink-0">
            {([
              { k: 'nem' as View, label: t('nav.allNem') },
              { k: 'nsw' as View, label: t('nav.nswDeepDive') },
              { k: 'vpp' as View, label: t('nav.vpp') },
              { k: 'bess-calc' as View, label: t('nav.bessCalc') },
            ]).map(({ k, label }) => (
              <button
                key={k}
                onClick={() => setView(k)}
                className={`text-[12px] px-3 py-1.5 rounded-md transition ${
                  view === k
                    ? 'bg-white text-ink shadow-sm font-medium'
                    : 'text-ink2 hover:text-ink'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {view === 'nsw' ? (
          <NSWDeepDive snap={snap} generators={gens} grid={grid} />
        ) : view === 'vpp' ? (
          <VPPConsole />
        ) : view === 'bess-calc' ? (
          <BESSCalculator />
        ) : (
        <>
        {/* Region tiles */}
        <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {REGIONS.map((r) => {
            if (r === 'WEM') {
              return (
                <RegionTile
                  key={r}
                  {...regionTilePropsForWEM(snap?.wem ?? null, selected === 'WEM', () =>
                    setSelected('WEM'),
                  )}
                />
              )
            }
            const nemRow = nemMap.get(r)
            const props = nemRow
              ? regionTilePropsForNEM(nemRow, selected === r, () => setSelected(r))
              : {
                  label: r.replace(/1$/, ''),
                  subtitle: r,
                  rrp: null,
                  prior: null,
                  ts: null,
                  selected: selected === r,
                  onClick: () => setSelected(r),
                }
            return <RegionTile key={r} {...props} />
          })}
        </section>

        {/* NEM map: states + interconnector flows */}
        <section className="mt-6 bg-surface rounded-xl2 p-6 shadow-card">
          <div className="flex items-baseline justify-between mb-2">
            <div>
              <div className="text-[17px] font-semibold tracking-tight text-ink">
                {t('sec.nemMap')}
              </div>
              <div className="text-[12px] text-muted mt-1">
                {t('sec.nemMapHint')}
              </div>
            </div>
            {grid && (
              <div className="text-[11px] text-muted tabular-nums">
                {grid.interconnectors[0]?.settlementdate
                  ? new Date(grid.interconnectors[0].settlementdate!).toLocaleString('en-AU', {
                      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
                    })
                  : ''}
              </div>
            )}
          </div>
          <NEMMap
            grid={grid}
            generators={gens}
            nem={snap?.nem ?? []}
            selected={selected}
            onSelect={setSelected}
          />
        </section>

        {/* Market timeline lives in the NSW deep-dive view (immediately
            above the Suggested bid sheet) — that's where users are actually
            making bid decisions and need the lifecycle context. */}

        {/* Chart */}
        <section className="mt-6 bg-surface rounded-xl2 p-6 shadow-card">
          {selected !== 'WEM' && (
            <div className="mb-5">
              <PriceKPIs
                region={nemMap.get(selected) ?? null}
                forecastRun={forecast?.p5min_run ?? forecast?.predispatch_run ?? null}
              />
            </div>
          )}
          <div className="flex items-baseline justify-between mb-5">
            <div>
              <div className="text-[17px] font-semibold tracking-tight text-ink">
                {selectedLabel}
              </div>
              <div className="text-[12px] text-muted mt-1">{t('sec.priceTitle')}</div>
            </div>
            <div className="flex gap-1 p-0.5 bg-surfaceAlt rounded-lg">
              {[6, 24, 72, 168].map((h) => (
                <button
                  key={h}
                  onClick={() => setHours(h)}
                  className={`text-[12px] px-3 py-1.5 rounded-md transition ${
                    hours === h
                      ? 'bg-white text-ink shadow-sm font-medium'
                      : 'text-ink2 hover:text-ink'
                  }`}
                >
                  {h < 24 ? `${h}h` : `${h / 24}d`}
                </button>
              ))}
            </div>
          </div>
          <PriceChart
            history={history}
            loading={historyLoading}
            forecast={forecast}
            nowTs={nemMap.get(selected)?.settlementdate ?? null}
            constraints={constraints}
          />
        </section>

        {/* FCAS matrix */}
        <section className="mt-6 bg-surface rounded-xl2 p-6 shadow-card">
          <div className="mb-4">
            <div className="text-[17px] font-semibold tracking-tight text-ink">
              {t('sec.fcasMatrix')}
            </div>
            <div className="text-[12px] text-muted mt-1">
              {t('sec.fcasMatrixHint')}
            </div>
          </div>
          <FCASMatrixView data={fcas} />
        </section>

        {/* 90-day price heatmaps (energy + FCAS) */}
        <section className="mt-6 bg-surface rounded-xl2 p-6 shadow-card">
          <div className="mb-4">
            <div className="text-[17px] font-semibold tracking-tight text-ink">
              {t('sec.heatmap')}
            </div>
            <div className="text-[12px] text-muted mt-1">
              {t('sec.heatmapHint')}
            </div>
          </div>
          <HeatMap data={heatmap} />
        </section>
        </>
        )}

        <footer className="mt-12 pb-4 text-[11px] text-muted text-center">
          {t('footer')}
        </footer>
      </main>
    </div>
  )
}
