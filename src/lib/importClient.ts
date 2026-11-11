import { useSyncExternalStore } from 'react'
import { db, getSetting, rollbackZip, recoverInterruptedImports } from './db'
import type { Decision, UnitInfo } from './importCore'
import type { ImportReport } from './types'
import { indexZip } from './search'

export interface QueueItem {
  id: number; file: File; name: string
  status: 'queued' | 'running' | 'waiting' | 'done' | 'warn' | 'failed' | 'cancelled' | 'skipped'
  pct: number; msg: string; error?: string; reports?: ImportReport[]; zipId?: number
  pending?: { units: UnitInfo[] }; resumeZipId?: number; force?: boolean
}
let items: QueueItem[] = []
let snapshot = items
let nextId = 1
let worker: Worker | null = null
let current: QueueItem | null = null
let running = false
let rememberAuto = false
const subs = new Set<() => void>()
const emit = () => { snapshot = [...items]; subs.forEach(s => s()) }
const patch = (it: QueueItem, p: Partial<QueueItem>) => { Object.assign(it, p); emit() }

export const useQueue = () => useSyncExternalStore(cb => { subs.add(cb); return () => { subs.delete(cb) } }, () => snapshot)

/** Classify every picked ZIP: already imported (skip) / interrupted earlier (resume) / new. Nothing is imported twice. */
export async function enqueue(files: File[]) {
  if (!running) await recoverInterruptedImports()      // a crashed worker/page leaves 'importing' records: make them resumable first
  const known = await db.zips.toArray()
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  for (const f of sorted) {
    const same = (z: { name: string; size: number }) => z.name === f.name && z.size === f.size
    const done = known.find(z => same(z) && (z.status === 'done' || z.status === 'done_with_warnings'))
    const part = known.find(z => same(z) && z.status === 'interrupted')
    const dupInQueue = items.some(i => i.name === f.name && i.file.size === f.size && ['queued', 'running', 'waiting'].includes(i.status))
    const base = { id: nextId++, file: f, name: f.name, pct: 0 }
    if (dupInQueue) items.push({ ...base, status: 'skipped', msg: 'Already in this batch — skipped' })
    else if (done) items.push({ ...base, status: 'skipped', msg: 'Already imported — skipped (tap “Import again” to force)' })
    else if (part) items.push({ ...base, status: 'queued', msg: 'Resuming an interrupted import…', resumeZipId: part.id })
    else items.push({ ...base, status: 'queued', msg: 'New — waiting…' })
  }
  emit(); pump()
}
export function importAgain(id: number) { const it = items.find(i => i.id === id); if (it) { patch(it, { status: 'queued', msg: 'Waiting…', force: true }); pump() } }
export function clearFinished() { items = items.filter(i => ['queued', 'running', 'waiting'].includes(i.status)); emit() }

async function pump() {
  if (running) return
  running = true
  // keep the screen on: iOS suspends/kills a backgrounded page mid-import
  let lock: { release(): Promise<void> } | null = null
  try { await navigator.storage?.persist?.() } catch { /* best effort: asks the browser not to evict the archive */ }
  try { lock = await (navigator as unknown as { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen') ?? null } catch { /* not allowed */ }
  try {
    for (;;) {
      const it = items.find(i => i.status === 'queued')
      if (!it) break
      await runOne(it)
    }
  } finally { running = false; lock?.release().catch(() => {}) }
}

function runOne(it: QueueItem): Promise<void> {
  return new Promise(async resolve => {
    current = it
    patch(it, { status: 'running', msg: 'Starting…', pct: 1 })
    const myName = await getSetting<string | null>('myName', null)
    const keepMB = await getSetting<number>('keepOriginalMaxMB', 300)
    const keepOriginal = it.file.size <= keepMB * 1024 * 1024
    const w = new Worker(new URL('../worker/importWorker.ts', import.meta.url), { type: 'module' })
    worker = w
    const finish = () => { w.terminate(); if (worker === w) worker = null; current = null; resolve() }
    w.onmessage = async ev => {
      const m = ev.data
      if (m.type === 'progress') patch(it, { pct: m.pct, msg: m.msg })
      else if (m.type === 'decide') {
        const needsAsk = m.units.some((u: UnitInfo) => u.candidates.length > 0)
        if (!needsAsk || rememberAuto) { w.postMessage({ type: 'decision', decisions: m.units.map((u: UnitInfo) => u.defaultDecision) }); return }
        patch(it, { status: 'waiting', pending: { units: m.units }, msg: 'Waiting for your decision…' })
        decisionResolvers.set(it.id, (d, remember) => { rememberAuto = remember; patch(it, { status: 'running', pending: undefined }); w.postMessage({ type: 'decision', decisions: d }) })
      } else if (m.type === 'done') {
        const r = m.result
        patch(it, { status: r.status === 'done' ? 'done' : 'warn', pct: 100, msg: 'Imported', reports: r.reports, zipId: r.zipId })
        try { await indexZip(r.zipId) } catch { /* index is rebuilt lazily */ }
        finish()
      } else if (m.type === 'error') {
        patch(it, { status: 'failed', error: m.message + ' — safe to retry: pick the same ZIP again and it continues where it stopped.', msg: 'Failed' }); finish()
      }
    }
    w.onerror = async e => { await recoverInterruptedImports().catch(() => {}); patch(it, { status: 'failed', error: (e.message || 'Worker crashed') + ' — pick the same ZIP again to continue.', msg: 'Failed' }); finish() }
    w.postMessage({ type: 'import', file: it.file, name: it.name, myName, keepOriginal, resumeZipId: it.resumeZipId })
  })
}

const decisionResolvers = new Map<number, (d: Decision[], remember: boolean) => void>()
export function answerDecision(id: number, d: Decision[], remember: boolean) { decisionResolvers.get(id)?.(d, remember); decisionResolvers.delete(id) }

/** Safe cancel: stop the worker, then remove everything it had written for this ZIP (original file entry is kept as "cancelled"). */
export async function cancelCurrent() {
  const it = current; if (!it) return
  worker?.terminate(); worker = null
  const z = (await db.zips.where('status').equals('importing').toArray())
  for (const rec of z) await rollbackZip(rec.id!, 'cancelled')
  patch(it, { status: 'cancelled', msg: 'Cancelled — nothing was saved', pending: undefined })
  current = null
  // let pump continue with the next queued item
  running = false; pump()
}
export function cancelAll() {
  items.forEach(i => { if (i.status === 'queued') i.status = 'cancelled' }); emit(); cancelCurrent()
}
