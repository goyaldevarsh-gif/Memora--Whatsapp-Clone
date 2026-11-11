const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
export const MONTH_NAMES = MONTHS
const pad = (n: number) => String(n).padStart(2, '0')

// Timestamps are stored "naive-UTC": the clock time written in the export, so UTC getters reproduce it exactly.
export function fmtTime(ts: number | null, raw = ''): string {
  if (ts === null) return raw ? raw.split(',').pop()!.trim() : ''
  const d = new Date(ts); let h = d.getUTCHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12
  return `${h}:${pad(d.getUTCMinutes())} ${ap}`
}
export const fmtDate = (ts: number) => { const d = new Date(ts); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCFullYear()}` }
export const fmtDateLong = (ts: number) => { const d = new Date(ts); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` }
export const fmtDateTime = (ts: number | null, raw = '') => ts === null ? raw : `${fmtDate(ts)}, ${fmtTime(ts)}`
export const dayKey = (ts: number) => Math.floor(ts / 86400000)
const todayNaive = () => { const n = new Date(); return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()) }
export function dayLabel(ts: number): string {
  const diff = dayKey(todayNaive()) - dayKey(ts)
  if (diff === 0) return 'TODAY'
  if (diff === 1) return 'YESTERDAY'
  return fmtDateLong(ts).toUpperCase()
}
/** Chat-list style timestamp: time today, "Yesterday", weekday this week, else date. */
export function listStamp(ts: number | null): string {
  if (ts === null) return ''
  const diff = dayKey(todayNaive()) - dayKey(ts)
  if (diff === 0) return fmtTime(ts)
  if (diff === 1) return 'Yesterday'
  if (diff > 1 && diff < 7) return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date(ts).getUTCDay()]
  const d = new Date(ts); return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${String(d.getUTCFullYear()).slice(2)}`
}
export function fmtSize(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} KB`
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`
  return `${(b / 1024 ** 3).toFixed(2)} GB`
}
export const fmtDur = (s: number) => !isFinite(s) ? '0:00' : `${Math.floor(s / 60)}:${pad(Math.floor(s % 60))}`
export const fmtNum = (n: number) => n.toLocaleString('en-IN')
export const extOf = (n: string) => (n.split('.').pop() ?? '').toUpperCase()
