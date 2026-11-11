import { useEffect, useState } from 'react'

export interface Route { path: string[]; query: URLSearchParams; raw: string }
const parse = (): Route => {
  const h = location.hash.replace(/^#\/?/, '')
  const [p, q = ''] = h.split('?')
  return { path: p.split('/').filter(Boolean), query: new URLSearchParams(q), raw: h }
}
export function useRoute(): Route {
  const [r, setR] = useState(parse)
  useEffect(() => { const f = () => setR(parse()); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f) }, [])
  return r
}
export const nav = (to: string, replace = false) => { const h = '#/' + to.replace(/^#?\/?/, ''); if (replace) location.replace(h); else location.hash = h }
export const back = (fallback = 'chats') => { if (history.length > 1) history.back(); else nav(fallback) }

export function useIsDesktop() {
  const q = '(min-width: 900px)'
  const [d, setD] = useState(() => matchMedia(q).matches)
  useEffect(() => { const m = matchMedia(q); const f = () => setD(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f) }, [])
  return d
}
