import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import {
  fetchConstraints, fetchFCAS, fetchForecast, fetchGenerators, fetchGrid,
  fetchHeatmap, fetchHistory, fetchMLF, fetchOHLC, fetchPriceForecast, fetchSnapshot, openSnapshotStream,
} from './api'
import type {
  Constraints, FCASMatrix, Forecast, GeneratorsSnapshot, GridSnapshot, Heatmap,
  History, MLFEntry, OHLCData, PriceForecast, Snapshot,
} from './types'
import { Header } from './components/Header'
import { RegionTile, regionTilePropsForNEM, regionTilePropsForWEM } from './components/RegionTile'
import { PriceChart } from './components/PriceChart'
import { PriceKPIs } from './components/PriceKPIs'
import { FCASMatrixView } from './components/FCASMatrix'
import { FCASForecastPanel } from './components/FCASForecastPanel'
import { HeatMap } from './components/HeatMap'
import { NEMMap } from './components/NEMMap'
import { PASAView } from './components/PASAView'

// Heavy view-level components are lazy-loaded so first paint of the
// default NEM dashboard doesn't pay for the trading/VPP/calculator code.
const NSWDeepDive = lazy(() =>
  import('./components/NSWDeepDive').then((m) => ({ default: m.NSWDeepDive })))
const VPPConsole = lazy(() =>
  import('./components/VPPConsole').then((m) => ({ default: m.VPPConsole })))
const BESSCalculator = lazy(() =>
  import('./components/BESSCalculator').then((m) => ({ default: m.BESSCalculator })))
const StationExplorer = lazy(() =>
  import('./components/StationExplorer').then((m) => ({ default: m.StationExplorer })))
const NewsView = lazy(() =>
  import('./components/NewsView').then((m) => ({ default: m.NewsView })))
const IntroLanding = lazy(() =>
  import('./components/IntroLanding').then((m) => ({ default: m.IntroLanding })))
const VPPCalc = lazy(() =>
  import('./components/VPPCalc').then((m) => ({ default: m.VPPCalc })))
const ForecastView = lazy(() =>
  import('./components/ForecastView').then((m) => ({ default: m.ForecastView })))
import { WeatherPanel } from './components/WeatherPanel'
import { FuelMixLive } from './components/FuelMixLive'
import { CandlestickChart } from './components/CandlestickChart'
import { HistoricalDayView } from './components/HistoricalDayView'
import { MarketNoticeTicker } from './components/MarketNoticeTicker'
import { useT } from './i18n'

const REGIONS = ['NSW1', 'QLD1', 'VIC1', 'SA1', 'TAS1', 'WEM']

/** Skeleton shown while a lazy-loaded view chunk downloads. */
function ViewLoading() {
  return (
    <div className="h-64 flex items-center justify-center text-muted text-sm">
      <span className="animate-pulse">Loading…</span>
    </div>
  )
}

type View = 'nem' | 'nsw' | 'forecast' | 'vpp' | 'vpp-calc' | 'bess-calc' | 'stations' | 'news'

export default function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [selected, setSelected] = useState<string>('NSW1')
  const [history, setHistory] = useState<History | null>(null)
  const [forecast, setForecast] = useState<Forecast | null>(null)
  const [priceForecast, setPriceForecast] = useState<PriceForecast | null>(null)
  const [constraints, setConstraints] = useState<Constraints | null>(null)
  const [fcas, setFcas] = useState<FCASMatrix | null>(null)
  const [grid, setGrid] = useState<GridSnapshot | null>(null)
  const [gens, setGens] = useState<GeneratorsSnapshot | null>(null)
  const [heatmap, setHeatmap] = useState<Heatmap | null>(null)
  const [mlfData, setMlfData] = useState<MLFEntry[] | null>(null)
  const [hours, setHours] = useState<number>(24)
  const [live, setLive] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [view, setView] = useState<View>('nem')
  const [chartTab, setChartTab] = useState<'price' | 'kline' | 'weather'>('price')
  const [ohlc, setOhlc] = useState<OHLCData | null>(null)
  const [ohlcLoading, setOhlcLoading] = useState(false)
  // Landing screen: shown once per browser session; "Open" enters the app.
  const [showIntro, setShowIntro] = useState(
    () => sessionStorage.getItem('nemwem.entered') !== '1')
  const enterApp = () => {
    sessionStorage.setItem('nemwem.entered', '1')
    setShowIntro(false)
  }
  const { t } = useT()

  useEffect(() => {
    fetchSnapshot().then(setSnap).catch(console.error)
    fetchFCAS().then(setFcas).catch(console.error)
    fetchGrid().then(setGrid).catch(console.error)
    fetchGenerators().then(setGens).catch(console.error)
    fetchHeatmap(90).then(setHeatmap).catch(console.error)
    // MLF data is static (annual FY release) — fetch once on mount
    fetchMLF().then((r) => setMlfData(r.entries)).catch(console.error)
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

  // OHLC data for the candlestick tab — fetched whenever region / hours change
  // or a new snapshot arrives (live refresh every ~1 min).
  useEffect(() => {
    if (selected === 'WEM') { setOhlc(null); return }
    setOhlcLoading(true)
    fetchOHLC(selected, hours)
      .then(setOhlc)
      .catch(() => setOhlc(null))
      .finally(() => setOhlcLoading(false))
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

  // P5MIN price forecast with error bands — fetched whenever selected region
  // changes (or snap updates). Only for NEM regions.
  useEffect(() => {
    if (selected === 'WEM') {
      setPriceForecast(null)
      return
    }
    fetchPriceForecast(selected)
      .then(setPriceForecast)
      .catch(() => setPriceForecast(null))
  }, [selected, snap?.generated_at])

  const nemMap = useMemo(() => {
    const m = new Map<string, any>()
    snap?.nem.forEach((r) => m.set(r.regionid, r))
    return m
  }, [snap])

  const selectedLabel = selected === 'WEM'
    ? `WA · ${t('sec.suffix.wemRtp')}`
    : `${selected.replace(/1$/, '')} · ${t('sec.suffix.rrp')}`

  if (showIntro) {
    return (
      <Suspense fallback={<div className="fixed inset-0 bg-[#040d1c]" />}>
        <IntroLanding onEnter={enterApp} />
      </Suspense>
    )
  }

  return (
    <div className="min-h-screen flex flex-col bg-canvas">
      <Header generatedAt={snap?.generated_at ?? null} live={live} />

      {/* AEMO market notice event stream — global, all views */}
      <div className="px-8 max-w-[1400px] w-full mx-auto">
        <MarketNoticeTicker />
      </div>

      <main className="flex-1 px-8 py-10 max-w-[1400px] w-full mx-auto">
        {/* Page intro + view toggle */}
        <div className="mb-8 flex items-end justify-between gap-6">
          <div>
            <h1 className="text-[28px] font-semibold tracking-tight text-ink leading-tight">
              {view === 'nem' ? t('intro.titleNem')
               : view === 'nsw' ? t('intro.titleNsw')
               : view === 'forecast' ? t('intro.titleForecast')
               : view === 'bess-calc' ? t('intro.titleBessCalc')
               : view === 'stations' ? t('intro.titleStations')
               : view === 'news' ? t('intro.titleNews')
               : view === 'vpp-calc' ? t('intro.titleVppCalc')
               : t('nav.vpp')}
            </h1>
            <p className="text-[15px] text-ink2 mt-2">
              {view === 'nem' ? t('intro.subtitleNem')
               : view === 'nsw' ? t('intro.subtitleNsw')
               : view === 'forecast' ? t('intro.subtitleForecast')
               : view === 'bess-calc' ? t('intro.subtitleBessCalc')
               : view === 'stations' ? t('intro.subtitleStations')
               : view === 'news' ? t('intro.subtitleNews')
               : view === 'vpp-calc' ? t('intro.subtitleVppCalc')
               : t('vpp.kicker')}
            </p>
          </div>
          <div className="flex gap-1 p-0.5 bg-surfaceAlt rounded-lg shrink-0">
            {([
              { k: 'nem' as View, label: t('nav.allNem') },
              { k: 'forecast' as View, label: t('nav.forecast') },
              { k: 'nsw' as View, label: t('nav.nswDeepDive') },
              { k: 'bess-calc' as View, label: t('nav.bessCalc') },
              { k: 'vpp' as View, label: t('nav.vpp') },
              { k: 'vpp-calc' as View, label: t('nav.vppCalc') },
              { k: 'stations' as View, label: t('nav.stations') },
              { k: 'news' as View, label: t('nav.news') },
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
          <Suspense fallback={<ViewLoading />}><NSWDeepDive snap={snap} generators={gens} grid={grid} /></Suspense>
        ) : view === 'forecast' ? (
          <Suspense fallback={<ViewLoading />}><ForecastView /></Suspense>
        ) : view === 'vpp' ? (
          <Suspense fallback={<ViewLoading />}><VPPConsole /></Suspense>
        ) : view === 'bess-calc' ? (
          <Suspense fallback={<ViewLoading />}><BESSCalculator /></Suspense>
        ) : view === 'stations' ? (
          <Suspense fallback={<ViewLoading />}><StationExplorer /></Suspense>
        ) : view === 'news' ? (
          <Suspense fallback={<ViewLoading />}><NewsView /></Suspense>
        ) : view === 'vpp-calc' ? (
          <Suspense fallback={<ViewLoading />}><VPPCalc /></Suspense>
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
            mlfData={mlfData}
          />

          {/* Live fuel mix — updates whenever a NEM region is selected */}
          {['NSW1','QLD1','VIC1','SA1','TAS1'].includes(selected) && (
            <div className="mt-5 border-t border-hairlineSoft pt-5">
              <FuelMixLive region={selected} hours={6} layout="inline" />
            </div>
          )}
        </section>

        {/* Market timeline lives in the NSW deep-dive view (immediately
            above the Suggested bid sheet) — that's where users are actually
            making bid decisions and need the lifecycle context. */}

        {/* ── Tab toggle: between NEM map and content ─────────────────── */}
        <div className="mt-5 flex items-center justify-between">
          <div className="flex gap-0 p-0.5 bg-surface border border-hairlineSoft rounded-xl shadow-sm">
            {([
              { k: 'price',   label: t('weather.tabPrice') },
              { k: 'kline',   label: t('weather.tabKline') },
              { k: 'weather', label: t('weather.tabWeather') },
            ] as { k: 'price' | 'kline' | 'weather'; label: string }[]).map(({ k, label }) => (
              <button
                key={k}
                onClick={() => { setChartTab(k); if (k === 'kline' && hours < 24) setHours(24) }}
                className={`text-[13px] px-4 py-2 rounded-lg transition font-medium ${
                  chartTab === k
                    ? 'bg-accent text-white shadow-sm'
                    : 'text-ink2 hover:text-ink hover:bg-surfaceAlt'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {/* Time range — price: 6h/1d/3d/7d; kline: 1d/3d/7d (6h too few candles) */}
          {(chartTab === 'price' || chartTab === 'kline') && (
            <div className="flex gap-1 p-0.5 bg-surfaceAlt rounded-lg">
              {(chartTab === 'kline' ? [24, 72, 168] : [6, 24, 72, 168]).map((h) => (
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
          )}
        </div>

        {/* Chart / Weather — content panel */}
        <section className="mt-3 bg-surface rounded-xl2 p-6 shadow-card">
          {/* Section title */}
          <div className="mb-5">
            <div className="text-[17px] font-semibold tracking-tight text-ink">{selectedLabel}</div>
            <div className="text-[12px] text-muted mt-1">
              {chartTab === 'price'   ? t('sec.priceTitle')
               : chartTab === 'kline' ? t('kline.subtitle')
               : t('weather.priceHint')}
            </div>
          </div>

          {/* Price tab: price chart + FCAS matrix + 90-day heatmap */}
          {chartTab === 'price' && (
            <>
              {selected !== 'WEM' && (
                <div className="mb-5">
                  <PriceKPIs
                    region={nemMap.get(selected) ?? null}
                    forecastRun={forecast?.p5min_run ?? forecast?.predispatch_run ?? null}
                  />
                </div>
              )}
              <PriceChart
                history={history}
                loading={historyLoading}
                forecast={forecast}
                priceForecast={priceForecast}
                nowTs={nemMap.get(selected)?.settlementdate ?? null}
                constraints={constraints}
              />

              {/* FCAS matrix — inside price tab */}
              <div className="mt-8 pt-6 border-t border-hairlineSoft">
                <div className="mb-4">
                  <div className="text-[15px] font-semibold tracking-tight text-ink">{t('sec.fcasMatrix')}</div>
                  <div className="text-[11px] text-muted mt-0.5">{t('sec.fcasMatrixHint')}</div>
                </div>
                <FCASMatrixView data={fcas} />
                {selected !== 'WEM' && (
                  <div className="mt-5">
                    <FCASForecastPanel
                      region={selected}
                      refreshKey={snap?.generated_at ?? null}
                    />
                  </div>
                )}
              </div>

              {/* 90-day price heatmap — inside price tab */}
              <div className="mt-8 pt-6 border-t border-hairlineSoft">
                <div className="mb-4">
                  <div className="text-[15px] font-semibold tracking-tight text-ink">{t('sec.heatmap')}</div>
                  <div className="text-[11px] text-muted mt-0.5">{t('sec.heatmapHint')}</div>
                </div>
                <HeatMap data={heatmap} />
              </div>

              {/* Archived-day explorer — pick any date in the price archive */}
              {selected !== 'WEM' && (
                <div className="mt-8 pt-6 border-t border-hairlineSoft">
                  <div className="mb-4">
                    <div className="text-[15px] font-semibold tracking-tight text-ink">{t('histday.title')}</div>
                    <div className="text-[11px] text-muted mt-0.5">{t('histday.hint')}</div>
                  </div>
                  <HistoricalDayView region={selected} />
                </div>
              )}
            </>
          )}

          {/* K线 candlestick tab */}
          {chartTab === 'kline' && (
            <CandlestickChart data={ohlc} loading={ohlcLoading} />
          )}

          {/* Weather tab */}
          {chartTab === 'weather' && (
            <WeatherPanel region={selected} />
          )}
        </section>

        {/* ST PASA — 14-day adequacy forecast */}
        <section className="mt-6 bg-surface rounded-xl2 p-6 shadow-card">
          <PASAView region={selected === 'WEM' ? 'NSW1' : selected} />
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
