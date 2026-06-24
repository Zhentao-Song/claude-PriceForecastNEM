/**
 * IntroLanding — "Sunwind Continent" landing screen.
 *
 * Algorithmic philosophy (新能源 / new-energy theme):
 *   Australia is the centerpiece, floating in deep space-blue, its coastline
 *   glowing green. A golden sun rises from the east. Across the whole screen
 *   a WIND flows — a layered Perlin flow-field — and the CURSOR is a live
 *   energy source: moving the mouse anywhere sprays glowing particles that
 *   the wind catches and carries into streaks. Major cities pulse as energy
 *   nodes on the map. Sun + wind = solar + wind, the two pillars of
 *   renewables, sweeping the National Electricity Market.
 *
 * Pure HTML5 Canvas (no extra deps) + d3-geo for an accurate outline.
 * Seeded noise → reproducible field. Only prop is onEnter().
 */
import { useEffect, useRef } from 'react'
import { geoMercator, geoPath } from 'd3-geo'
import { useT } from '../i18n'

// ── Compact seeded Perlin noise ───────────────────────────────────────────
function makeNoise(seed: number) {
  const p = new Uint8Array(512)
  const perm = Array.from({ length: 256 }, (_, i) => i)
  let s = seed >>> 0
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]]
  }
  for (let i = 0; i < 512; i++) p[i] = perm[i & 255]
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)
  const lerp = (a: number, b: number, t: number) => a + t * (b - a)
  const grad = (h: number, x: number, y: number) => ((h & 1) === 0 ? x : -x) + ((h & 2) === 0 ? y : -y)
  return (x: number, y: number) => {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255
    const xf = x - Math.floor(x), yf = y - Math.floor(y)
    const u = fade(xf), v = fade(yf)
    const aa = p[p[X] + Y], ab = p[p[X] + Y + 1]
    const ba = p[p[X + 1] + Y], bb = p[p[X + 1] + Y + 1]
    return (lerp(lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u),
      lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u), v) + 1) / 2
  }
}

type P = {
  x: number; y: number; px: number; py: number; vx: number; vy: number
  life: number; maxLife: number; spark: boolean // spark = cursor-spawned (brighter, warmer)
}

// Major demand centres (lon, lat) — pulse as energy nodes on the map.
const CITIES: [number, number][] = [
  [151.21, -33.87], [144.96, -37.81], [153.03, -27.47],
  [138.60, -34.93], [115.86, -31.95], [147.33, -42.88],
]

export function IntroLanding({ onEnter }: { onEnter: () => void }) {
  const { t, lang } = useT()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number>(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    let W = 0, H = 0
    let ausPath: Path2D | null = null
    let proj: ReturnType<typeof geoMercator> | null = null
    let cityPx: [number, number][] = []
    const noise = makeNoise(20260617)
    const NOISE_SCALE = 0.0016
    const AMBIENT = 380           // background wind particles
    const particles: P[] = []
    let geojson: unknown = null
    let running = true

    // Mouse state (window-level so it works over text/buttons too)
    const mouse = { x: -9999, y: -9999, px: -9999, py: -9999, moved: false }

    const resize = () => {
      // Canvas is full-viewport (fixed/absolute inset-0); use the viewport
      // size directly so we never depend on layout-timing of clientWidth.
      W = window.innerWidth; H = window.innerHeight
      if (W < 50 || H < 50) return
      canvas.width = W * dpr; canvas.height = H * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      build()
      paintBackground()
    }

    const paintBackground = () => {
      const g = ctx.createRadialGradient(W * 0.5, H * 0.45, 0, W * 0.5, H * 0.5, Math.max(W, H))
      g.addColorStop(0, '#0e2746'); g.addColorStop(0.5, '#081a30'); g.addColorStop(1, '#03091a')
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H)
    }

    const build = () => {
      if (!geojson) return
      // Australia centered as the hero — fills most of the screen.
      proj = geoMercator().fitExtent(
        [[W * 0.04, H * 0.06], [W * 0.96, H * 0.98]], geojson as any)
      const d = geoPath(proj as any)(geojson as any)
      ausPath = d ? new Path2D(d) : null
      cityPx = CITIES.map((c) => proj!(c) as [number, number]).filter(Boolean) as [number, number][]
    }

    const ambient = (pp: P) => {
      pp.x = Math.random() * W * 0.5 - 10; pp.y = Math.random() * H
      pp.px = pp.x; pp.py = pp.y; pp.vx = 0; pp.vy = 0
      pp.maxLife = 70 + Math.random() * 140; pp.life = Math.random() * pp.maxLife
      pp.spark = false
    }
    for (let i = 0; i < AMBIENT; i++) {
      const pp: P = { x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0, life: 0, maxLife: 0, spark: false }
      ambient(pp); particles.push(pp)
    }

    // Spawn bright particles at the cursor, flung along the mouse motion.
    const emitAtCursor = () => {
      const dx = mouse.x - mouse.px, dy = mouse.y - mouse.py
      const speed = Math.min(Math.hypot(dx, dy), 40)
      const n = 2 + Math.floor(speed / 6)
      for (let i = 0; i < n; i++) {
        particles.push({
          x: mouse.x + (Math.random() - 0.5) * 12,
          y: mouse.y + (Math.random() - 0.5) * 12,
          px: mouse.x, py: mouse.y,
          vx: dx * 0.12 + (Math.random() - 0.5) * 1.5,
          vy: dy * 0.12 + (Math.random() - 0.5) * 1.5,
          life: 0, maxLife: 40 + Math.random() * 50, spark: true,
        })
      }
      // Cap total particles for performance.
      if (particles.length > AMBIENT + 600) particles.splice(AMBIENT, particles.length - (AMBIENT + 600))
    }

    let tNoise = 0
    const frame = () => {
      if (!running) return
      ctx.fillStyle = 'rgba(3, 9, 26, 0.10)'; ctx.fillRect(0, 0, W, H)
      tNoise += 0.0009

      if (mouse.moved) { emitAtCursor(); mouse.px = mouse.x; mouse.py = mouse.y; mouse.moved = false }

      // ── Australia ──
      if (ausPath) {
        ctx.save()
        ctx.fillStyle = 'rgba(18,64,92,0.28)'; ctx.fill(ausPath)
        ctx.shadowColor = 'rgba(52,199,120,0.6)'; ctx.shadowBlur = 18
        ctx.strokeStyle = 'rgba(130,235,180,0.8)'; ctx.lineWidth = 1.6; ctx.stroke(ausPath)
        ctx.restore()
        // Pulsing energy nodes
        ctx.save(); ctx.globalCompositeOperation = 'lighter'
        for (let i = 0; i < cityPx.length; i++) {
          const [cx, cy] = cityPx[i]
          const ph = Date.now() * 0.002 + i * 1.3
          const rr = 3 + 2.2 * (0.5 + 0.5 * Math.sin(ph))
          const ng = ctx.createRadialGradient(cx, cy, 0, cx, cy, rr * 4)
          ng.addColorStop(0, 'rgba(120,235,180,0.85)'); ng.addColorStop(1, 'rgba(120,235,180,0)')
          ctx.fillStyle = ng; ctx.beginPath(); ctx.arc(cx, cy, rr * 4, 0, Math.PI * 2); ctx.fill()
          ctx.fillStyle = 'rgba(220,255,235,0.95)'; ctx.beginPath(); ctx.arc(cx, cy, 1.8, 0, Math.PI * 2); ctx.fill()
        }
        ctx.restore()
      }

      // ── Wind + cursor particles ──
      ctx.save(); ctx.globalCompositeOperation = 'lighter'
      for (let k = particles.length - 1; k >= 0; k--) {
        const pp = particles[k]
        const ang = noise(pp.x * NOISE_SCALE, pp.y * NOISE_SCALE + tNoise * 40) * Math.PI * 3 + 0.35
        const fx = Math.cos(ang) * 1.5 + 0.45, fy = Math.sin(ang) * 1.5
        // Cursor swirl: nearby particles get pulled toward / around the cursor.
        const mdx = mouse.x - pp.x, mdy = mouse.y - pp.y
        const md2 = mdx * mdx + mdy * mdy
        let cursorBoost = 0
        if (md2 < 26000) {
          const f = (1 - Math.sqrt(md2) / 161) * 0.6
          pp.vx += mdx * 0.0006 * f - mdy * 0.004 * f // attract + swirl
          pp.vy += mdy * 0.0006 * f + mdx * 0.004 * f
          cursorBoost = f
        }
        pp.vx = pp.vx * 0.92 + fx * 0.08
        pp.vy = pp.vy * 0.92 + fy * 0.08
        pp.px = pp.x; pp.py = pp.y
        pp.x += pp.vx + (pp.spark ? 0 : 0.4)
        pp.y += pp.vy
        pp.life++

        const fade = 1 - pp.life / pp.maxLife
        let r, g, b, a
        if (pp.spark) {
          // Cursor sparks: warm gold flecks
          r = 255; g = Math.round(200 + 40 * fade); b = Math.round(90 + 60 * (1 - fade)); a = 0.75 * fade
        } else {
          // Wind: green→cyan, brighter near the cursor
          r = Math.round(60 + cursorBoost * 120)
          g = 210
          b = Math.round(150 + cursorBoost * 40)
          a = (0.42 + cursorBoost * 0.4) * fade
        }
        ctx.strokeStyle = `rgba(${r},${g},${b},${a})`
        ctx.lineWidth = pp.spark ? 1.6 : 1.1
        ctx.beginPath(); ctx.moveTo(pp.px, pp.py); ctx.lineTo(pp.x, pp.y); ctx.stroke()

        const dead = pp.life >= pp.maxLife || pp.x > W + 20 || pp.x < -20 || pp.y > H + 20 || pp.y < -20
        if (dead) {
          if (pp.spark) particles.splice(k, 1) // sparks are transient
          else ambient(pp)
        }
      }
      ctx.restore()

      rafRef.current = requestAnimationFrame(frame)
    }

    const onMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect()
      if (mouse.x < -1000) { mouse.px = e.clientX - rect.left; mouse.py = e.clientY - rect.top }
      mouse.x = e.clientX - rect.left; mouse.y = e.clientY - rect.top; mouse.moved = true
    }
    const onTouch = (e: TouchEvent) => {
      const tch = e.touches[0]; if (!tch) return
      const rect = canvas.getBoundingClientRect()
      mouse.x = tch.clientX - rect.left; mouse.y = tch.clientY - rect.top; mouse.moved = true
    }

    fetch('/aus-states.geojson').then((r) => r.json())
      .then((gj) => { geojson = gj; resize(); rafRef.current = requestAnimationFrame(frame) })
      .catch(() => { resize(); rafRef.current = requestAnimationFrame(frame) })

    window.addEventListener('resize', resize)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('touchmove', onTouch, { passive: true })
    return () => {
      running = false
      cancelAnimationFrame(rafRef.current)
      window.removeEventListener('resize', resize)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('touchmove', onTouch)
    }
  }, [])

  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-[#03091a]">
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />

      <div className="relative z-10 h-full flex flex-col items-center justify-center text-center px-6 select-none pointer-events-none">
        <div className="mb-3 flex items-center gap-2 text-[13px] tracking-[0.35em] uppercase" style={{ color: '#ffd65c' }}>
          <span>☀</span><span>{t('intro.kicker')}</span><span>🌿</span>
        </div>
        <h1 className="text-[clamp(34px,6vw,76px)] font-bold tracking-tight leading-[1.05]"
            style={{ color: '#f4f9ff', textShadow: '0 2px 50px rgba(52,199,120,0.4)' }}>
          {t('intro.brandLine1')}
        </h1>
        <p className="mt-4 max-w-[640px] text-[15px] sm:text-[17px] leading-relaxed" style={{ color: 'rgba(220,235,255,0.78)' }}>
          {t('intro.brandSub')}
        </p>
        <button
          onClick={onEnter}
          className="group mt-10 inline-flex items-center gap-3 rounded-full px-9 py-3.5 text-[16px] font-semibold
                     transition-all duration-300 hover:scale-105 hover:shadow-[0_0_40px_rgba(255,180,60,0.6)] pointer-events-auto"
          style={{ background: 'linear-gradient(135deg,#ffd65c 0%,#ff9f1c 60%,#ff7a1c 100%)', color: '#1a0e00' }}
        >
          {t('intro.openBtn')}<span className="transition-transform group-hover:translate-x-1">→</span>
        </button>
        <div className="mt-8 text-[11px] tracking-wide" style={{ color: 'rgba(180,200,225,0.5)' }}>
          {lang === 'zh' ? '数据来源 · AEMO 公开市场数据' : 'Data · AEMO public market data'}
        </div>
      </div>
    </div>
  )
}
