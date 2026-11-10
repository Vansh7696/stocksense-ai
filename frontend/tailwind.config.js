/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        fintech: {
          dark: '#0a0e17',
          card: '#111827',
          surface: '#151d30',
          border: '#1f293d',
          muted: '#8e9bb0',
          accent: '#2563eb',
          cyan: '#06b6d4',
          bullish: '#10b981', // Green for gains
          bearish: '#ef4444', // Red for losses
          hold: '#f59e0b',    // Neutral amber for hold
          hover: '#1e293b'
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Menlo', 'monospace']
      }
    },
  },
  plugins: [],
}
