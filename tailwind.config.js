/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#071419', bg2: '#101F26', surface: '#17272E', accent: '#35D6AD', accent2: '#0D9488',
        ink: '#F5F7F8', mute: '#9AAEB4', line: '#26383E', warn: '#E5A44D', err: '#E35D68',
        out: '#0E5A4C', inb: '#1A2B32'
      },
      fontFamily: { sans: ['-apple-system', 'BlinkMacSystemFont', 'SF Pro Text', 'Inter', 'Segoe UI', 'Roboto', 'Noto Sans Devanagari', 'sans-serif'] }
    }
  },
  plugins: []
}
