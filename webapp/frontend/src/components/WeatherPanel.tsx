/**
 * WeatherPanel — Weather-to-price signal translator for NEM electricity traders.
 *
 * This is NOT a general weather widget. Its purpose is to answer two questions:
 *   1. Will today's weather push prices UP (→ discharge BESS, sell into grid)?
 *   2. Will today's weather push prices DOWN (→ charge BESS from cheap grid)?
 *
 * Layout:
 *  ┌── current conditions bar ───────────────────────────────────────────────┐
 *  ├── 4 KPI cards: peak temp · solar peak · wind · BESS signal ────────────┤
 *  ├── 24-hour price pressure timeline ─────────────────────────────────────┤
 *  └── 7-day temperature heatmap ────────────────────────────────────────────┘
 */
import { useEffect, useMemo, useState } from 'react'
import { fetchNemWeather } from '../api'
import type { NemWeather, WeatherRegion } from '../types'
import { useT } from '../i18n'

// ---- WMO code lookup --------------------------------------------------------
const WMO: Record<number, { icon: string; en: string; zh: string }> = {
  0:  { icon: '☀️',  en: 'Clear',         zh: '晴' },
  1:  { icon: '🌤️', en: 'Mostly clear',  zh: '少云' },
  2:  { icon: '⛅',  en: 'Partly cloudy', zh: '局部多云' },
  3:  { icon: '☁️',  en: 'Overcast',      zh: '阴天' },
  45: { icon: '🌫️', en: 'Fog',           zh: '雾' },
  48: { icon: '🌫️', en: 'Icy fog',       zh: '冻雾' },
  51: { icon: '🌦️', en: 'Drizzle',       zh: '毛毛雨' },
  61: { icon: '🌧️', en: 'Rain',          zh: '雨' },
  65: { icon: '🌧️', en: 'Heavy rain',    zh: '大雨' },
  80: { icon: '🌧️', en: 'Showers',       zh: '阵雨' },
  95: { icon: '⛈️', en: 'Thunderstorm',  zh: '雷暴' },
}
function wmoInfo(code: number | null) {
  if (code === null) return { icon: '—', en: '—', zh: '—' }
  const keys = Object.keys(WMO).map(Number).sort((a, b) => b - a)
  for (const k of keys) if (code >= k) return WMO[k]
  return { icon: '?', en: 'Unknown', zh: '未知' }
}

const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
function windDir(deg: number | null) {
  if (deg === null) return '—'
  return DIRS[Math.round(deg / 45) % 8]
}

// ---- Colour scale (mean-relative divergent) ---------------------------------
// ±5 % of 7-day mean → white  ·  above → deep orange-red  ·  below → dark slate
function tempColorRelative(v: number, mean: number, minT: number, maxT: number): string {
  const halfBand = Math.max(Math.abs(mean) * 0.05, 1)
  const lo = mean - halfBand
  const hi = mean + halfBand
  if (v >= lo && v <= hi) return '#ffffff'
  if (v > hi) {
    const frac = Math.min(1, (v - hi) / (maxT - hi || 1))
    return `rgb(${Math.round(255 - frac * 61)},${Math.round(255 - frac * 190)},${Math.round(255 - frac * 243)})`
  }
  const frac = Math.min(1, (lo - v) / (lo - minT || 1))
  return `rgb(${Math.round(255 - frac * 204)},${Math.round(255 - frac * 190)},${Math.round(255 - frac * 170)})`
}

// ---- Price signal computation -----------------------------------------------
/**
 * Composite electricity price-pressure signal for a single hour.
 *   Positive → demand pressure (high temp or cold snap) → price likely UP → discharge BESS
 *   Negative → supply surplus (solar or wind generation) → price likely DOWN → charge BESS
 *   Range: −4 to +4
 */
function priceSignal(temp: number | null, solar: number | null, wind: number | null): number {
  let demand = 0
  let supply = 0
  if (temp !== null) {
    if (temp >= 35) demand += 3       // severe heat demand
    else if (temp >= 30) demand += 2  // high heat demand
    else if (temp >= 26) demand += 1  // moderate heat
    if (temp <= 5)  demand += 3       // severe cold demand
    else if (temp <= 8)  demand += 2
    else if (temp <= 12) demand += 1
  }
  if (solar !== null) {
    if (solar >= 600) supply += 3     // strong solar → big price suppression
    else if (solar >= 400) supply += 2
    else if (solar >= 200) supply += 1
  }
  if (wind !== null) {
    if (wind >= 35) supply += 2       // strong wind generation
    else if (wind >= 20) supply += 1
  }
  return Math.max(-4, Math.min(4, demand - supply))
}

/** Background colour for a signal score — traffic light from red (sell) to green (buy). */
function signalBg(s: number): string {
  if (s >= 3) return '#ff3b30'   // extreme demand → red
  if (s >= 2) return '#ff9500'   // high demand → orange (site accent)
  if (s >= 1) return '#ffcc02'   // mild pressure → amber
  if (s === 0) return '#e8e8ed'  // neutral
  if (s === -1) return '#bbf7d0' // mild surplus → pale green
  if (s === -2) return '#4ade80' // good charge window → green
  return '#22c55e'               // strong surplus → bright green
}

// ---- 0a. Plain-language market insight (auto-generated) ---------------------
/**
 * Converts weather signals into a one-paragraph market interpretation — the
 * kind of text WattClarity writes manually for major events, but generated
 * automatically from the computed priceSignal scores.
 */
function InsightText({ w, lang }: { w: WeatherRegion; lang: string }) {
  const lines = useMemo(() => {
    const todayTemp  = w.hourly_temp.slice(144)
    const todaySolar = w.hourly_solar.slice(144)
    const todayWind  = w.hourly_wind_speed.slice(144)

    const validTemps = todayTemp.filter((v): v is number  => v != null)
    const validSolar = todaySolar.filter((v): v is number => v != null)
    const validWinds = todayWind.filter((v): v is number  => v != null)

    const maxTemp   = validTemps.length ? Math.max(...validTemps) : null
    const peakSolar = validSolar.length ? Math.max(...validSolar) : null
    const avgWind   = validWinds.length ? validWinds.reduce((a, b) => a + b, 0) / validWinds.length : null

    const solarStart = todaySolar.findIndex(s => (s ?? 0) >= 300)
    const solarRev   = [...todaySolar].reverse().findIndex(s => (s ?? 0) >= 300)
    const solarEnd   = solarRev >= 0 ? 23 - solarRev : -1
    const hasSolar   = solarStart >= 0 && solarEnd > solarStart

    const signals = Array.from({ length: 24 }, (_, i) =>
      priceSignal(todayTemp[i] ?? null, todaySolar[i] ?? null, todayWind[i] ?? null),
    )
    const peakSig    = Math.max(...signals)
    const peakHour   = signals.indexOf(peakSig)
    const discHours  = signals.filter(s => s >= 2).length
    const charHours  = signals.filter(s => s <= -2).length

    if (lang === 'zh') {
      const out: string[] = []
      if (hasSolar && peakSolar && peakSolar >= 300)
        out.push(`☀️ ${solarStart}—${solarEnd}时光伏辐射强（峰值 ${peakSolar.toFixed(0)} W/m²），现货价格大概率走低，充电窗口明显`)
      if (maxTemp && maxTemp >= 35)
        out.push(`🔥 气温达 ${maxTemp.toFixed(0)}°C，触及 AEMO 需求响应预警线，${peakHour}时前后电价上行风险显著`)
      else if (maxTemp && maxTemp >= 30)
        out.push(`🌡️ 气温峰值 ${maxTemp.toFixed(0)}°C，${peakHour}时前后需求压力最高，价格上行`)
      else if (maxTemp && maxTemp <= 8)
        out.push(`🥶 低温 ${maxTemp.toFixed(0)}°C，供暖负荷拉高需求，关注早晚价格`)
      if (avgWind && avgWind >= 25)
        out.push(`💨 风速均值 ${avgWind.toFixed(0)} km/h，风电持续增加可用供给，有助于压低价格`)
      if (discHours >= 3 && charHours >= 3)
        out.push(`⚡ 今日存在明显套利机会：${charHours}h 充电窗口 + ${discHours}h 放电窗口，建议关注时段切换点`)
      else if (discHours >= 3)
        out.push(`⚡ 放电为主（${discHours}h 高价期）；充电机会有限，需关注市场动态`)
      else if (charHours >= 3)
        out.push(`⚡ 充电为主（${charHours}h 低价期）；可优先补充电量，静候高价期`)
      else
        out.push(`⚡ 今日天气驱动价格压力温和，无明显套利窗口`)
      return out
    } else {
      const out: string[] = []
      if (hasSolar && peakSolar && peakSolar >= 300)
        out.push(`☀️ Solar peaks at ${peakSolar.toFixed(0)} W/m² from ${solarStart}h–${solarEnd}h — strong charge window, prices likely suppressed midday`)
      if (maxTemp && maxTemp >= 35)
        out.push(`🔥 Temp hits ${maxTemp.toFixed(0)}°C, crossing AEMO demand response alert level — high price risk around ${peakHour}:00`)
      else if (maxTemp && maxTemp >= 30)
        out.push(`🌡️ Peak ${maxTemp.toFixed(0)}°C drives demand pressure; highest price risk around ${peakHour}:00`)
      else if (maxTemp && maxTemp <= 8)
        out.push(`🥶 Cold snap at ${maxTemp.toFixed(0)}°C lifts heating load — watch morning and evening prices`)
      if (avgWind && avgWind >= 25)
        out.push(`💨 Avg wind ${avgWind.toFixed(0)} km/h provides sustained generation, suppresses prices throughout the day`)
      if (discHours >= 3 && charHours >= 3)
        out.push(`⚡ Clear arbitrage today: ${charHours}h cheap-charging window + ${discHours}h high-price discharge window`)
      else if (discHours >= 3)
        out.push(`⚡ Discharge-heavy day (${discHours}h high-price periods) — charge opportunities are limited`)
      else if (charHours >= 3)
        out.push(`⚡ Charge-heavy day (${charHours}h low-price periods) — good time to fill SOC ahead of next demand peak`)
      else
        out.push(`⚡ Weather-driven price pressure is moderate today — limited arbitrage window`)
      return out
    }
  }, [w, lang])

  return (
    <div style={{
      background: '#fffbeb', border: '1px solid #fde68a',
      borderRadius: 10, padding: '12px 14px', marginBottom: 20,
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#92400e', marginBottom: 8 }}>
        {lang === 'zh' ? '📊 今日市场信号解读' : '📊 Market signal interpretation — today'}
      </div>
      {lines.map((line, i) => (
        <div key={i} style={{
          fontSize: 12, color: '#78350f', lineHeight: 1.7,
          marginBottom: i < lines.length - 1 ? 3 : 0,
        }}>
          {line}
        </div>
      ))}
    </div>
  )
}

// ---- 0b. All-region signal comparison (OpenElectricity pattern) -------------
/**
 * Shows current weather-derived price signals for every NEM region side by
 * side — lets traders spot inter-regional price differentials at a glance,
 * and helps anticipate interconnector flow direction.
 */
function RegionSignalStrip({ data, currentRegion, lang }: {
  data: NemWeather; currentRegion: string; lang: string
}) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#86868b', marginBottom: 8 }}>
        {lang === 'zh'
          ? 'NEM 各区域当前信号对比（温度 · 价格压力）'
          : 'NEM region comparison — current conditions & price signal'}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        {data.regions.map(r => {
          const sig        = priceSignal(r.temperature, r.solar_radiation_wm2, r.wind_speed_kmh)
          const isSelected = r.region === currentRegion
          // Only the selected region gets signal colour; others are neutral grey
          const bg         = isSelected ? signalBg(sig) : '#f1f5f9'
          const heatAlert  = r.temperature != null && r.temperature >= 35
          return (
            <div key={r.region} style={{
              flex: '1 1 0',
              padding: '8px 10px', borderRadius: 8,
              background: bg,
              border: isSelected ? '2px solid #1d1d1f' : '1px solid #e2e8f0',
              opacity: isSelected ? 1 : 0.55,
              position: 'relative',
            }}>
              {/* AEMO heat-alert badge */}
              {heatAlert && (
                <div style={{
                  position: 'absolute', top: 4, right: 4,
                  fontSize: 8, background: '#dc2626', color: '#fff',
                  borderRadius: 3, padding: '1px 3px', fontWeight: 700,
                }}>
                  ALERT
                </div>
              )}
              <div style={{ fontSize: 10, fontWeight: 700, color: '#1d1d1f', marginBottom: 2 }}>
                {r.region.replace(/1$/, '')}
              </div>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#1d1d1f', lineHeight: 1 }}>
                {r.temperature?.toFixed(0) ?? '—'}°
              </div>
              <div style={{
                fontSize: 9, marginTop: 4, fontWeight: 600,
                color: sig > 0 ? '#92400e' : sig < 0 ? '#14532d' : '#6b7280',
              }}>
                {sig >= 3 ? (lang === 'zh' ? '需求暴涨' : 'Demand spike') :
                 sig >= 2 ? (lang === 'zh' ? '需求偏高' : 'Demand high') :
                 sig >= 1 ? (lang === 'zh' ? '轻微压力' : 'Mild pressure') :
                 sig === 0 ? (lang === 'zh' ? '平稳' : 'Neutral') :
                 sig === -1 ? (lang === 'zh' ? '轻微压价' : 'Mild surplus') :
                 sig <= -2 ? (lang === 'zh' ? '供给充裕' : 'Supply surplus') : '—'}
              </div>
            </div>
          )
        })}
      </div>
      <p style={{ fontSize: 10, color: '#94a3b8', margin: '5px 0 0' }}>
        {lang === 'zh'
          ? 'ALERT = 气温 ≥ 35°C（达到 AEMO 需求响应预警线） · 各区域差异反映跨州联络线潮流方向'
          : 'ALERT = temp ≥ 35°C (AEMO demand response threshold) · Regional differences drive interconnector flows'}
      </p>
    </div>
  )
}

// ---- 0c. 7-day signal bar (historical + today forecast) ---------------------
/**
 * Shows the dominant weather-driven price signal for each of the past 6 days
 * plus today's forecast — gives the weekly context that premium platforms
 * (Modo, ez2view) expose via longer time horizons.
 */
function SevenDayOutlook({ w, lang }: { w: WeatherRegion; lang: string }) {
  const days = useMemo(() => Array.from({ length: 7 }, (_, d) => {
    const base = d * 24
    // Use daytime hours 7-21 for the signal (overnight cold demand skews results)
    const daytimeSigs = Array.from({ length: 15 }, (_, h) => h + 7).map(h =>
      priceSignal(
        w.hourly_temp[base + h] ?? null,
        w.hourly_solar[base + h] ?? null,
        w.hourly_wind_speed[base + h] ?? null,
      ),
    )
    const maxSig  = Math.max(...daytimeSigs)
    const minSig  = Math.min(...daytimeSigs)
    const dominant = Math.abs(maxSig) >= Math.abs(minSig) ? maxSig : minSig

    const dayTemps = Array.from({ length: 24 }, (_, h) => w.hourly_temp[base + h]).filter((v): v is number => v != null)
    const maxTemp  = dayTemps.length ? Math.max(...dayTemps) : null

    const ts = w.hourly_times[base]
    const date = ts ? new Date(ts) : null
    const weekdayLabel = date
      ? date.toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-AU', { weekday: 'short', timeZone: 'UTC' })
      : `D${d + 1}`
    const dateLabel = date
      ? date.toLocaleDateString('en-AU', { month: 'short', day: 'numeric', timeZone: 'UTC' })
      : ''
    const isToday = d === 6 // index 6 = Open-Meteo forecast day

    return { d, weekdayLabel, dateLabel, dominant, maxTemp, isToday }
  }), [w, lang])

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#86868b', marginBottom: 8 }}>
        {lang === 'zh'
          ? '近7日价格信号（6天回顾 + 今日预测）'
          : '7-day price signal — 6 days history + today forecast'}
      </div>
      <div style={{ display: 'flex', gap: 5 }}>
        {days.map(day => (
          <div key={day.d} style={{ flex: 1, textAlign: 'center' }}>
            <div style={{
              fontSize: 9, fontWeight: day.isToday ? 700 : 400,
              color: day.isToday ? '#ff9500' : '#9ca3af', marginBottom: 2,
            }}>
              {day.weekdayLabel}
            </div>
            <div style={{ fontSize: 8, color: '#c0c0c0', marginBottom: 3 }}>
              {day.dateLabel}
            </div>
            <div style={{
              height: 38, borderRadius: 5,
              background: signalBg(day.dominant),
              border: day.isToday ? '2px solid #ff9500' : '1px solid rgba(0,0,0,0.06)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 11, fontWeight: 700,
              color: Math.abs(day.dominant) >= 2 ? '#fff' : '#424245',
            }}>
              {day.maxTemp?.toFixed(0) ?? '—'}°
            </div>
            <div style={{ fontSize: 8, color: '#9ca3af', marginTop: 2 }}>
              {day.dominant >= 2 ? (lang === 'zh' ? '↑价' : '↑P') :
               day.dominant <= -2 ? (lang === 'zh' ? '↓价' : '↓P') : '—'}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ---- 1. Day-summary KPI cards -----------------------------------------------
function DaySummaryCards({ w, lang }: { w: WeatherRegion; lang: string }) {
  const todayTemp  = useMemo(() => w.hourly_temp.slice(144),  [w])
  const todaySolar = useMemo(() => w.hourly_solar.slice(144), [w])
  const todayWind  = useMemo(() => w.hourly_wind_speed.slice(144), [w])

  const validTemps  = todayTemp.filter((v): v is number  => v != null)
  const validSolar  = todaySolar.filter((v): v is number => v != null)
  const validWinds  = todayWind.filter((v): v is number  => v != null)

  const maxTemp   = validTemps.length ? Math.max(...validTemps) : null
  const minTemp   = validTemps.length ? Math.min(...validTemps) : null
  const peakSolar = validSolar.length ? Math.max(...validSolar) : null
  const avgWind   = validWinds.length
    ? validWinds.reduce((a, b) => a + b, 0) / validWinds.length : null
  const peakSolarIdx = peakSolar != null ? todaySolar.indexOf(peakSolar) : -1

  const signals = Array.from({ length: 24 }, (_, i) =>
    priceSignal(todayTemp[i] ?? null, todaySolar[i] ?? null, todayWind[i] ?? null),
  )
  const dischargeHours = signals.filter(s => s >= 2).length
  const chargeHours    = signals.filter(s => s <= -2).length

  const cards = [
    {
      icon: '🌡️',
      title: lang === 'zh' ? '今日温度区间' : 'Temp range today',
      value: (maxTemp != null && minTemp != null)
        ? `${minTemp.toFixed(0)}–${maxTemp.toFixed(0)}°C` : '—',
      hint: maxTemp == null ? '' :
        maxTemp >= 35 ? (lang === 'zh' ? '高温预警 · 需求↑↑' : 'Heat alert · demand↑↑') :
        maxTemp >= 30 ? (lang === 'zh' ? '偏热 · 需求压力' : 'Warm · demand pressure') :
        maxTemp <= 8  ? (lang === 'zh' ? '低温 · 需求压力' : 'Cold · demand pressure') :
        (lang === 'zh' ? '温度正常' : 'Normal range'),
      accent: maxTemp != null && (maxTemp >= 30 || maxTemp <= 8) ? '#ff9500' : '#86868b',
    },
    {
      icon: '☀️',
      title: lang === 'zh' ? '光伏辐射峰值' : 'Solar radiation peak',
      value: peakSolar != null ? `${peakSolar.toFixed(0)} W/m²` : '—',
      hint: peakSolar == null ? '' :
        peakSolar >= 600
          ? (lang === 'zh' ? `${peakSolarIdx}时强压价` : `@${peakSolarIdx}h strong↓price`) :
        peakSolar >= 300
          ? (lang === 'zh' ? '午间光伏压价' : 'Midday solar↓price') :
        (lang === 'zh' ? '光伏影响有限' : 'Low solar impact'),
      accent: peakSolar != null && peakSolar >= 300 ? '#34c759' : '#86868b',
    },
    {
      icon: '💨',
      title: lang === 'zh' ? '风速均值' : 'Avg wind speed',
      value: avgWind != null ? `${avgWind.toFixed(0)} km/h` : '—',
      hint: avgWind == null ? '' :
        avgWind >= 35 ? (lang === 'zh' ? '强风 · 风电供给↑↑' : 'Strong wind · supply↑↑') :
        avgWind >= 20 ? (lang === 'zh' ? '中等风力贡献' : 'Moderate wind supply') :
        (lang === 'zh' ? '风力贡献低' : 'Low wind impact'),
      accent: avgWind != null && avgWind >= 20 ? '#34c759' : '#86868b',
    },
    {
      icon: '⚡',
      title: lang === 'zh' ? '储能操作信号' : 'BESS signal',
      value: dischargeHours >= 3
        ? (lang === 'zh' ? `放电 ${dischargeHours}h` : `Discharge ${dischargeHours}h`) :
        chargeHours >= 3
          ? (lang === 'zh' ? `充电 ${chargeHours}h` : `Charge ${chargeHours}h`) :
        (lang === 'zh' ? '平稳日' : 'Normal day'),
      hint: lang === 'zh'
        ? `放电 ${dischargeHours}h · 充电 ${chargeHours}h`
        : `Discharge ${dischargeHours}h · Charge ${chargeHours}h`,
      accent: dischargeHours >= 3 ? '#ff9500' : chargeHours >= 3 ? '#34c759' : '#86868b',
    },
  ]

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginBottom: 20 }}>
      {cards.map(c => (
        <div key={c.icon} style={{
          background: '#f8fafc', borderRadius: 10, padding: '10px 12px',
          border: `1px solid ${c.accent === '#86868b' ? '#e8e8ed' : c.accent + '44'}`,
        }}>
          <div style={{ fontSize: 10, color: '#86868b', marginBottom: 4 }}>
            {c.icon} {c.title}
          </div>
          <div style={{ fontSize: 17, fontWeight: 700, color: '#1d1d1f', letterSpacing: -0.3, lineHeight: 1 }}>
            {c.value}
          </div>
          <div style={{ fontSize: 10, color: c.accent, fontWeight: 600, marginTop: 4 }}>
            {c.hint}
          </div>
        </div>
      ))}
    </div>
  )
}

// ---- 2. 24-hour price-pressure timeline -------------------------------------
function PriceSignalTimeline({ w, lang }: { w: WeatherRegion; lang: string }) {
  const [hovIdx, setHovIdx] = useState<number | null>(null)

  const hours = useMemo(() => Array.from({ length: 24 }, (_, i) => {
    const idx     = 144 + i
    const temp    = w.hourly_temp[idx] ?? null
    const solar   = w.hourly_solar[idx] ?? null
    const wind    = w.hourly_wind_speed[idx] ?? null
    const timeStr = w.hourly_times[idx] ?? ''
    const hour    = timeStr ? new Date(timeStr).getUTCHours() : i
    return { i, hour, sig: priceSignal(temp, solar, wind), temp, solar, wind }
  }), [w])

  const hov = hovIdx !== null ? hours[hovIdx] : null

  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#1d1d1f', marginBottom: 8 }}>
        ⚡ {lang === 'zh'
          ? '今日价格压力时段（气温 · 光照 · 风力综合）'
          : 'Price Pressure Forecast — Today (temp · solar · wind)'}
      </div>

      {/* Signal bar row */}
      <div style={{ display: 'flex', gap: 2, marginBottom: 3 }}>
        {hours.map(h => (
          <div
            key={h.i}
            onMouseEnter={() => setHovIdx(h.i)}
            onMouseLeave={() => setHovIdx(null)}
            style={{
              flex: 1, height: 48,
              background: signalBg(h.sig),
              borderRadius: 3,
              cursor: 'default',
              outline: hovIdx === h.i ? '2px solid #1d1d1f' : 'none',
              outlineOffset: 1,
              transition: 'outline 0.08s',
            }}
          />
        ))}
      </div>

      {/* Hour axis */}
      <div style={{ display: 'flex', marginBottom: 6 }}>
        {hours.map(h => (
          <div key={h.i} style={{ flex: 1, fontSize: 9, color: '#9ca3af', textAlign: 'center' }}>
            {h.hour % 6 === 0 ? `${h.hour}h` : ''}
          </div>
        ))}
      </div>

      {/* Hover detail strip */}
      <div style={{ height: 20, marginBottom: 8 }}>
        {hov && (
          <div style={{ fontSize: 11, color: '#424245', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700 }}>{hov.hour}:00</span>
            <span>🌡️ {hov.temp?.toFixed(0) ?? '—'}°C</span>
            <span>☀️ {hov.solar?.toFixed(0) ?? '—'} W/m²</span>
            <span>💨 {hov.wind?.toFixed(0) ?? '—'} km/h {windDir(w.wind_direction_deg)}</span>
            <span style={{
              fontWeight: 700, padding: '0 6px', borderRadius: 4,
              background: signalBg(hov.sig) + '55',
              color: hov.sig > 0 ? '#d97706' : hov.sig < 0 ? '#15803d' : '#6b7280',
            }}>
              {hov.sig > 0
                ? (lang === 'zh' ? `↑ 价格压力 +${hov.sig}` : `↑ Demand pressure +${hov.sig}`)
                : hov.sig < 0
                  ? (lang === 'zh' ? `↓ 供给充裕 ${hov.sig}` : `↓ Supply surplus ${hov.sig}`)
                  : (lang === 'zh' ? '平稳' : 'Neutral')}
            </span>
          </div>
        )}
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {[
          { c: '#ff3b30', l: lang === 'zh' ? '高温拉需↑价'    : 'Heat demand↑' },
          { c: '#ff9500', l: lang === 'zh' ? '需求偏高'        : 'Demand pressure' },
          { c: '#e8e8ed', l: lang === 'zh' ? '平稳'            : 'Neutral' },
          { c: '#4ade80', l: lang === 'zh' ? '充电窗口'        : 'Charge window' },
          { c: '#22c55e', l: lang === 'zh' ? '光伏/风电压价↓' : 'Solar/wind↓price' },
        ].map(l => (
          <div key={l.c} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, color: '#6b7280' }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, background: l.c, flexShrink: 0 }} />
            {l.l}
          </div>
        ))}
      </div>
    </div>
  )
}

// ---- 3. 7-day temperature heatmap (mean-relative divergent scale) ------------
function TempHeatmap({ w, lang }: { w: WeatherRegion; lang: string }) {
  const [hovered, setHovered] = useState<{ day: number; hour: number; temp: number } | null>(null)

  const days = useMemo(() => {
    const result: { label: string; hours: (number | null)[] }[] = []
    for (let d = 0; d < 7; d++) {
      const hours: (number | null)[] = []
      for (let h = 0; h < 24; h++) hours.push(w.hourly_temp[d * 24 + h] ?? null)
      const ts = w.hourly_times[d * 24]
      const label = ts
        ? new Date(ts).toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-AU', {
            month: 'short', day: 'numeric', timeZone: 'UTC',
          })
        : `Day ${d + 1}`
      result.push({ label, hours })
    }
    return result
  }, [w, lang])

  const CELL_W = 16, CELL_H = 22, LABEL_W = 52
  const allTemps = w.hourly_temp.filter((v): v is number => v != null)
  const minT = allTemps.length ? Math.floor(Math.min(...allTemps)) : 0
  const maxT = allTemps.length ? Math.ceil(Math.max(...allTemps))  : 40
  const meanT = allTemps.length
    ? allTemps.reduce((a, b) => a + b, 0) / allTemps.length
    : (minT + maxT) / 2

  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#1d1d1f', marginBottom: 6 }}>
        🌡️ {lang === 'zh' ? '气温热力图（近7天）' : 'Temperature Heatmap (7 days)'}
      </div>
      <div style={{ overflowX: 'auto' }}>
        {/* Hour labels — top */}
        <div style={{ display: 'flex', marginLeft: LABEL_W, marginBottom: 2 }}>
          {[0, 3, 6, 9, 12, 15, 18, 21, 23].map(h => (
            <div key={h} style={{
              position: 'relative', left: h * CELL_W,
              fontSize: 9, color: '#9ca3af', whiteSpace: 'nowrap', width: 0, overflow: 'visible',
            }}>{h}</div>
          ))}
        </div>
        {/* Rows */}
        {days.map((day, di) => (
          <div key={di} style={{ display: 'flex', alignItems: 'center' }}>
            <div style={{ width: LABEL_W, fontSize: 10, color: '#6b7280', textAlign: 'right', paddingRight: 6, flexShrink: 0 }}>
              {day.label}
            </div>
            {day.hours.map((temp, hi) => (
              <div
                key={hi}
                title={temp != null ? `${day.label} ${hi}:00 → ${temp.toFixed(1)}°C` : '—'}
                onMouseEnter={() => temp != null && setHovered({ day: di, hour: hi, temp })}
                onMouseLeave={() => setHovered(null)}
                style={{
                  width: CELL_W, height: CELL_H,
                  background: temp != null ? tempColorRelative(temp, meanT, minT, maxT) : '#f3f4f6',
                  border: hovered?.day === di && hovered?.hour === hi
                    ? '1.5px solid #1d1d1f' : '0.5px solid rgba(255,255,255,0.25)',
                  cursor: 'crosshair',
                }}
              />
            ))}
          </div>
        ))}
        {/* Hour labels — bottom */}
        <div style={{ display: 'flex', marginLeft: LABEL_W, marginTop: 3 }}>
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} style={{ width: CELL_W, textAlign: 'center', fontSize: 8, color: '#d1d5db' }}>
              {h % 6 === 0 ? h : ''}
            </div>
          ))}
        </div>
      </div>
      {/* Colour legend */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
        <span style={{ fontSize: 10, color: '#6b7280' }}>{minT}°</span>
        <div style={{ width: 56, height: 7, borderRadius: '4px 0 0 4px', background: 'linear-gradient(to right, #334155, #ffffff)' }} />
        <div style={{ width: 56, height: 7, borderRadius: '0 4px 4px 0', background: 'linear-gradient(to right, #ffffff, #c2410c)' }} />
        <span style={{ fontSize: 10, color: '#6b7280' }}>{maxT}°C</span>
        <span style={{ fontSize: 10, color: '#94a3b8', marginLeft: 2 }}>
          {lang === 'zh' ? `均值 ${meanT.toFixed(1)}°` : `avg ${meanT.toFixed(1)}°`}
        </span>
        {hovered && (
          <span style={{ fontSize: 11, marginLeft: 8, fontWeight: 600, color: '#374151', background: '#f1f5f9', padding: '2px 8px', borderRadius: 4 }}>
            {days[hovered.day]?.label} {hovered.hour}:00 → {hovered.temp.toFixed(1)}°C
          </span>
        )}
      </div>
      <p style={{ fontSize: 10, color: '#94a3b8', margin: '3px 0 0' }}>
        {lang === 'zh'
          ? '白色 = 均值附近 ±5% · 深橙 = 偏高 · 深灰 = 偏低'
          : 'White = within ±5% of mean · deep orange = above avg · dark grey = below avg'}
      </p>
    </div>
  )
}

// ---- Main component ---------------------------------------------------------
export function WeatherPanel({ region }: { region: string }) {
  const { t, lang } = useT()
  const [data, setData]           = useState<NemWeather | null>(null)
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState<string | null>(null)
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true); setError(null)
      try {
        const d = await fetchNemWeather()
        if (!cancelled) { setData(d); setFetchedAt(new Date()) }
      } catch (e) {
        if (!cancelled) setError(String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    const id = setInterval(load, 30 * 60 * 1000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  const w = data?.regions.find(r => r.region === region)
         ?? data?.regions.find(r => r.region === 'NSW1')

  if (loading && !data) return (
    <div style={{ padding: '40px 0', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
      {t('weather.loading')}
    </div>
  )
  if (error || !w) return (
    <div style={{ padding: '20px 0', color: '#dc2626', fontSize: 12 }}>{t('weather.error')}</div>
  )

  const wmo = wmoInfo(w.weather_code)

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif' }}>

      {/* ── Current conditions bar ──────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        marginBottom: 20, paddingBottom: 14, borderBottom: '1px solid #f1f5f9',
      }}>
        <span style={{ fontSize: 30, lineHeight: 1 }}>{wmo.icon}</span>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#1d1d1f', letterSpacing: -0.5, lineHeight: 1 }}>
            {w.temperature != null ? `${w.temperature.toFixed(0)}°C` : '—'}
          </div>
          <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
            {lang === 'zh' ? wmo.zh : wmo.en}
            {w.apparent_temperature != null && Math.abs(w.apparent_temperature - (w.temperature ?? 0)) >= 2 && (
              <span style={{ marginLeft: 6, color: '#9ca3af' }}>
                {lang === 'zh' ? '体感' : 'FL'} {w.apparent_temperature.toFixed(0)}°
              </span>
            )}
          </div>
        </div>
        {/* Quick-stat pills */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {[
            { icon: '💨', v: w.wind_speed_kmh != null ? `${w.wind_speed_kmh.toFixed(0)} km/h ${windDir(w.wind_direction_deg)}` : '—' },
            { icon: '☀️', v: w.solar_radiation_wm2 != null ? `${w.solar_radiation_wm2.toFixed(0)} W/m²` : '—' },
            { icon: '🌧️', v: `${(w.precipitation_mm ?? 0).toFixed(1)} mm` },
          ].map(s => (
            <div key={s.icon} style={{
              display: 'flex', alignItems: 'center', gap: 4,
              background: '#f8fafc', border: '1px solid #e2e8f0',
              borderRadius: 8, padding: '3px 10px', fontSize: 11, color: '#374151',
            }}>
              <span>{s.icon}</span>
              <span style={{ fontWeight: 500 }}>{s.v}</span>
            </div>
          ))}
        </div>
        <span style={{ marginLeft: 'auto', fontSize: 10, color: '#94a3b8' }}>
          {fetchedAt && `${t('weather.updated')} ${fetchedAt.toLocaleTimeString(
            lang === 'zh' ? 'zh-CN' : 'en-AU', { hour: '2-digit', minute: '2-digit' }
          )}`}
        </span>
      </div>

      {/* ── Auto-generated market insight text ─────────────────────────── */}
      <InsightText w={w} lang={lang} />

      {/* ── Day KPI cards ───────────────────────────────────────────────── */}
      <DaySummaryCards w={w} lang={lang} />

      {/* ── All-region signal comparison ────────────────────────────────── */}
      <RegionSignalStrip data={data!} currentRegion={region} lang={lang} />

      {/* ── 7-day signal bar ────────────────────────────────────────────── */}
      <SevenDayOutlook w={w} lang={lang} />

      {/* ── 24-hour price-pressure timeline ─────────────────────────────── */}
      <PriceSignalTimeline w={w} lang={lang} />

      {/* ── 7-day temperature heatmap ────────────────────────────────────── */}
      <TempHeatmap w={w} lang={lang} />

      <p style={{ fontSize: 10, color: '#94a3b8', margin: '10px 0 0' }}>
        {lang === 'zh'
          ? '价格压力信号基于气温需求 + 光伏/风电供给综合推算 · 数据来源：Open-Meteo'
          : 'Price signal = temp demand − solar/wind supply · Data: Open-Meteo'}
      </p>
    </div>
  )
}
