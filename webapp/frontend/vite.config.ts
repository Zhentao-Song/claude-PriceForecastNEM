import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In Docker compose the backend is reachable as `http://backend:8000`.
// On bare-metal local dev it's `http://localhost:8000`. Override via env.
const apiTarget = process.env.VITE_API_TARGET || 'http://localhost:8000'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    // Allow public tunnel hostnames so quick-share workflows
    // (cloudflared, localhost.run, ngrok) work without per-URL config.
    // Vite 5.4.12+ blocks unknown hosts by default as a CVE fix; this
    // wildcard list re-permits the share domains we actually use.
    allowedHosts: [
      'localhost',
      '.trycloudflare.com',
      '.lhr.life',
      '.loca.lt',
      '.ngrok-free.app',
      '.ngrok.io',
      '.serveo.net',
    ],
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
})
