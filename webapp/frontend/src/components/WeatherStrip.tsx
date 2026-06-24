/**
 * WeatherStrip — NEM regional weather relevant to electricity prices.
 *
 * Fetches Open-Meteo data via /api/weather/nem and displays one card per
 * NEM region showing current conditions + price-impact signals:
 *
 *  · Temperature / feels-like  →  high temp = demand spike (price↑)
 *  · Solar radiation (W/m²)    →  high solar = generation surplus (price↓)
 *  · Wind speed / direction    →  strong wind = more renewable supply (price↓)
 *  · Weather code icon          →  at-a-glance condition
 *  · 24 h temperature sparkline →  trend context
 *
 * Data refreshes every 30 min (server-side cache TTL).
 */
import { useEffect, useState } from 'react'
import { fetchNemWeather } from '../api'
import type { NemWeather, WeatherRegion } from '../types'
import { useT } from '../i18n'

// ---- WMO weather-code → icon + label ----------------------------------------
const WMO: Record<number, { icon: string; en: string; zh: string }> = {
  0:  { icon: '☀️',  en: 'Clear',           zh: '晴' },
  1:  { icon: '🌤️', en: 'Mostly clear',    zh: '少云' },
  2:  { icon: '⛅',  en: 'Partly cloudy',   zh: '局部多云' },
  3:  { icon: '☁️',  en: 'Overcast',        zh: '阴天' },
  45: { icon: '🌫️', en: 'Fog',             zh: '雾' },
  48: { icon: '🌫️', en: 'Icy fog',         zh: '冻雾' },
  51: { icon: '🌦️', en: 'Light drizzle',   zh: '小毛毛雨' },
  53: { icon: '🌦️', en: 'Drizzle',         zh: '毛毛雨' },
  55: { icon: '🌦️', en: 'Heavy drizzle',   zh: '大毛毛雨' },
  61: { icon: '🌧️', en: 'Light rain',      zh: '小雨' },
  63: { icon: '🌧️', en: 'Rain',            zh: '雨' },
  65: { icon: '🌧️', en: 'Heavy rain',      zh: '大雨' },
  71: { icon: '🌨️', en: 'Light snow',      zh: '小雪' },
  73: { icon: '🌨️', en: 'Snow',            zh: '雪' },
  75: { icon: '🌨️', en: 'Heavy snow',      zh: '大雪' },
  80: { icon: '🌧️', en: 'Showers',         zh: '阵雨' },
  81: { icon: '🌧️', en: 'Heavy showers',   zh: '大阵雨' },
  82: { icon: '🌧️', en: 'Violent shower',  zh: '暴阵雨' },
  95: { icon: '⛈️', en: 'Thunderstorm',    zh: '雷暴' },
  96: { icon: '⛈️', en: 'Thunderstorm',    zh: '雷暴' },
  99: { icon: '⛈️', en: 'Thunderstorm',    zh: '强雷暴' },
}

function wmoInfo(code: number | null) {
  if (code === null) return { icon: '—', en: '—', zh: '—' }
  // Find the closest code key (WMO codes have gaps)
  const keys = Object.keys(WMO).map(Number).sort((a, b) => b - a)
  for (const k of keys) {
    if (code >= k) return WMO[k]
  }
  return { icon: '?', en: 'Unknown', zh: '未知' }
}

// ---- helpers ----------------------------------------------------------------

const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
function windDir(deg: number | null): string {
  if (deg === null) return '—'
  return DIRS[Math.round(deg / 45) % 8]
}

/** Solar impact on price — returns a badge descriptor */
function solarBadge(wm2: number | null, lang: string): { text: string; color: string } | null {
  if (wm2 === null || wm2 < 20) return null
  if (wm2 >= 600) return {
    text: lang === 'zh' ? `☀️ 太阳能压价 ${wm2.toFixed(0)} W/m²` : `☀️ Solar price↓ ${wm2.toFixed(0)} W/m²`,
    color: '#166534',  // green — price suppression good for buyer
  }
  if (wm2 >= 300) return {
    text: lang === 'zh' ? `🌤️ 中等辐射 ${wm2.toFixed(0)} W/m²` : `🌤️ Moderate solar ${wm2.toFixed(0)} W/m²`,
    color: '#92400e',
  }
  return {
    text: lang === 'zh' ? `🌥️ 低辐射 ${wm2.toFixed(0)} W/m²` : `🌥️ Low solar ${wm2.toFixed(0)} W/m²`,
    color: '#6b7280',
  }
}

/** Demand-pressure badge — high or low temperature drives demand */
function demandBadge(temp: number | null, lang: string): { text: string; color: string } | null {
  if (temp === null) return null
  if (temp >= 34) return {
    text: lang === 'zh' ? `🔥 高温拉需 ${temp.toFixed(0)}°C` : `🔥 Heat demand↑ ${temp.toFixed(0)}°C`,
    color: '#dc2626',
  }
  if (temp <= 8) return {
    text: lang === 'zh' ? `🥶 低温拉需 ${temp.toFixed(0)}°C` : `🥶 Cold demand↑ ${temp.toFixed(0)}°C`,
    color: '#1d4ed8',
  }
  return null
}

// ---- mini SVG sparkline (24 h temperature) ----------------------------------
function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null
  const W = 80, H = 22
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * W
    const y = H - ((v - min) / range) * (H - 4) - 2
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  return (
    <svg width={W} height={H} style={{ overflow: 'visible' }}>
      <polyline
        points={pts.join(' ')}
        fill="none"
        stroke="#3b82f6"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.7}
      />
    </svg>
  )
}

// ---- single region card -----------------------------------------------------
function RegionWeatherCard({ r, lang }: { r: WeatherRegion; lang: string }) {
  const wmo = wmoInfo(r.weather_code)
  const solar = solarBadge(r.solar_radiation_wm2, lang)
  const demand = demandBadge(r.temperature, lang)

  if (r.error) {
    return (
      <div style={{
        flex: '1 1 0', minWidth: 130,
        background: '#f9fafb', border: '1px solid #e5e7eb',
        borderRadius: 12, padding: '10px 12px',
        fontSize: 11, color: '#9ca3af',
      }}>
        <div style={{ fontWeight: 700, color: '#374151', marginBottom: 4 }}>
          {r.region.replace(/1$/, '')} · {r.city}
        </div>
        <div>—</div>
      </div>
    )
  }

  return (
    <div style={{
      flex: '1 1 0', minWidth: 140,
      background: '#fff', border: '1px solid #e5e7eb',
      borderRadius: 12, padding: '10px 14px',
    }}>
      {/* Region + city header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <span style={{
          fontSize: 10, fontWeight: 700, background: '#eff6ff',
          color: '#1d4ed8', borderRadius: 4, padding: '1px 5px', letterSpacing: 0.3,
        }}>
          {r.region.replace(/1$/, '')}
        </span>
        <span style={{ fontSize: 11, color: '#6b7280' }}>{r.city}</span>
      </div>

      {/* Temperature + icon */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 2 }}>
        <span style={{ fontSize: 22, lineHeight: 1 }}>{wmo.icon}</span>
        <span style={{ fontSize: 20, fontWeight: 700, color: '#111827', letterSpacing: -0.5 }}>
          {r.temperature !== null ? `${r.temperature.toFixed(0)}°` : '—'}
        </span>
        {r.apparent_temperature !== null && Math.abs(r.apparent_temperature - (r.temperature ?? 0)) >= 2 && (
          <span style={{ fontSize: 11, color: '#6b7280' }}>
            {lang === 'zh' ? '体感' : 'FL'} {r.apparent_temperature.toFixed(0)}°
          </span>
        )}
      </div>

      {/* Condition label */}
      <div style={{ fontSize: 10, color: '#9ca3af', marginBottom: 6 }}>
        {lang === 'zh' ? wmo.zh : wmo.en}
      </div>

      {/* Wind */}
      {r.wind_speed_kmh !== null && (
        <div style={{ fontSize: 11, color: '#374151', marginBottom: 3 }}>
          💨 {r.wind_speed_kmh.toFixed(0)} km/h {windDir(r.wind_direction_deg)}
        </div>
      )}

      {/* 24 h sparkline — use today's slice (last 24 of 168) */}
      {r.hourly_temp.length > 1 && (
        <div style={{ marginBottom: 6, marginTop: 2 }}>
          <Sparkline values={r.hourly_temp.slice(-24)} />
        </div>
      )}

      {/* Price-impact badges */}
      {demand && (
        <div style={{
          fontSize: 10, fontWeight: 600, color: demand.color,
          background: demand.color + '15',
          borderRadius: 4, padding: '2px 6px', marginBottom: 3,
          display: 'inline-block',
        }}>
          {demand.text}
        </div>
      )}
      {solar && (
        <div style={{
          fontSize: 10, fontWeight: 600, color: solar.color,
          background: solar.color + '18',
          borderRadius: 4, padding: '2px 6px',
          display: 'block',
        }}>
          {solar.text}
        </div>
      )}
    </div>
  )
}

// ---- main component ---------------------------------------------------------
export function WeatherStrip() {
  const { t, lang } = useT()
  const [data, setData] = useState<NemWeather | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const d = await fetchNemWeather()
        if (!cancelled) {
          setData(d)
          setFetchedAt(new Date())
        }
      } catch (e) {
        if (!cancelled) setError(String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    // Refresh every 30 min (matches server-side cache TTL)
    const id = setInterval(load, 30 * 60 * 1000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  return (
    <section style={{
      background: '#f8fafc',
      border: '1px solid #e2e8f0',
      borderRadius: 14,
      padding: '14px 16px',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#1e293b' }}>
            {t('weather.title')}
          </span>
          <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 8 }}>
            {t('weather.priceHint')}
          </span>
        </div>
        <div style={{ fontSize: 10, color: '#94a3b8' }}>
          {fetchedAt
            ? `${t('weather.updated')} ${fetchedAt.toLocaleTimeString(
                lang === 'zh' ? 'zh-CN' : 'en-AU',
                { hour: '2-digit', minute: '2-digit' },
              )}`
            : loading ? t('weather.loading') : ''}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={{ fontSize: 12, color: '#dc2626', padding: '6px 10px', background: '#fef2f2', borderRadius: 6 }}>
          {t('weather.error')}
        </div>
      )}

      {/* Cards */}
      {!error && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {loading && !data
            ? Array.from({ length: 5 }).map((_, i) => (
                <div key={i} style={{
                  flex: '1 1 0', minWidth: 140, height: 120,
                  background: '#f1f5f9', borderRadius: 12, animation: 'pulse 1.5s infinite',
                }} />
              ))
            : data?.regions.map(r => (
                <RegionWeatherCard key={r.region} r={r} lang={lang} />
              ))}
        </div>
      )}
    </section>
  )
}
