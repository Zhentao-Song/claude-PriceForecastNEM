/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Apple-inspired neutrals
        canvas: '#ffffff',
        surface: '#ffffff',
        surfaceAlt: '#f5f5f7',
        ink: '#1d1d1f',          // Apple primary text
        ink2: '#424245',         // Apple secondary text
        muted: '#86868b',        // Apple tertiary text
        hairline: '#d2d2d7',     // Apple separator
        hairlineSoft: '#e8e8ed',

        // Single accent: Apple system orange
        accent: '#ff9500',
        accentSoft: '#fff4e5',
        accentInk: '#a85a00',

        // Semantic (kept restrained)
        positive: '#34c759',     // Apple green (only for "down vs prev")
        negative: '#ff3b30',     // Apple red (only for spikes / errors)
        warn: '#ff9500',         // = accent
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', '"SF Pro Display"', '"SF Pro Text"',
               'system-ui', 'Inter', 'Helvetica Neue', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        // Visibly card-like on white: soft drop shadow + faint hairline edge.
        card: '0 1px 2px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.05), 0 0 0 1px rgba(0,0,0,0.05)',
        cardHover: '0 2px 4px rgba(0,0,0,0.05), 0 12px 24px rgba(0,0,0,0.08), 0 0 0 1px rgba(0,0,0,0.06)',
        // Selected: keep card shadow underneath, add orange ring on top.
        cardActive: '0 1px 2px rgba(0,0,0,0.04), 0 6px 18px rgba(255,149,0,0.18), 0 0 0 2px #ff9500',
      },
      borderRadius: {
        xl2: '14px',
      },
    },
  },
  plugins: [],
}
