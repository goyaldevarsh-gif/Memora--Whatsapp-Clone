import { registerSW } from 'virtual:pwa-register'
import { useSyncExternalStore } from 'react'

// In-app update flow: new deploy -> service worker downloads it in the background -> banner -> one tap applies it.
// User data lives in IndexedDB, so reloading never loses anything. No need to re-add to the home screen.
let ready = false
let updateFn: ((reload?: boolean) => Promise<void>) | null = null
const subs = new Set<() => void>()
const emit = () => subs.forEach(s => s())
export const useUpdateReady = () => useSyncExternalStore(cb => { subs.add(cb); return () => { subs.delete(cb) } }, () => ready)
export function applyUpdate() {
  // Deterministic: reload as soon as the new service worker takes control (with a safety net).
  let done = false
  const reload = () => { if (!done) { done = true; location.reload() } }
  navigator.serviceWorker?.addEventListener('controllerchange', reload)
  updateFn?.(true)
  setTimeout(reload, 5000)
}
export const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev'
export const BUILD_TIME = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : ''

let reg: ServiceWorkerRegistration | undefined
export const checkForUpdate = async () => { try { await reg?.update() } catch { /* offline */ } }

export function initUpdates() {
  updateFn = registerSW({
    immediate: true,
    onNeedRefresh() { ready = true; emit() },
    onRegisteredSW(_url, r) {
      reg = r
      // iPhone home-screen apps stay alive for days: re-check on every foreground + every 30 min.
      setInterval(checkForUpdate, 30 * 60 * 1000)
    }
  })
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdate() })
  addEventListener('online', checkForUpdate)
}
