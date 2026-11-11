import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Relative base => works on any GitHub Pages repo path (and on localhost / custom domains).
const BUILD = process.env.GITHUB_SHA?.slice(0, 7) ?? new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(BUILD), __BUILD_TIME__: JSON.stringify(new Date().toISOString()) },
  base: process.env.VITE_BASE ?? './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['icons/*.png', 'icons/icon.svg'],
      manifest: {
        name: 'Memora',
        short_name: 'Memora',
        description: 'Your conversations, preserved forever.',
        theme_color: '#071419',
        background_color: '#071419',
        display: 'standalone',
        orientation: 'any',
        start_url: './',
        scope: './',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest,wasm}'],
        navigateFallback: 'index.html',
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024
      }
    })
  ],
  worker: { format: 'es' },
  test: { environment: 'node', include: ['src/test/**/*.test.ts'], testTimeout: 60000 }
})
