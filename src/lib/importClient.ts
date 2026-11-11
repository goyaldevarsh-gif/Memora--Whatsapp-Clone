import { useSyncExternalStore } from 'react'
import { db, getSetting, rollbackZip } from './db'
import type { Decision, UnitInfo } from './importCore'
import type { ImportReport } from './types'
import { indexZip } from './search'

export interface QueueItem {
  id: number; file: File; name: string
  status: 'queued' | 'running' | 'waiting' | 'done' | 'warn' | 'failed' | 'cancelled'
  pct: number; msg: string; error?: string; reports?: ImportReport[]; zipId?: number
  pending?: { units: UnitInfo[] }
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

export function enqueue(files: File[]) {
  for (const f of files) items.push({ id: nextId++, file: f, name: f.name, status: 'queued', pct: 0, msg: 'Waiting…' })
  emit(); pump()
}
export function clearFinished() { items = items.filter(i => ['queued', 'running', 'waiting'].includes(i.status)); emit() }

async function pump() {
  if (running) return
  running = true
  // keep the screen on: iOS suspends/kills a backgrounded page mid-import
  let lock: { release(): Promise<void> } | null = null
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
        patch(it, { status: 'failed', error: m.message, msg: 'Failed' }); finish()
      }
    }
    w.onerror = e => { patch(it, { status: 'failed', error: e.message || 'Worker crashed', msg: 'Failed' }); finish() }
    w.postMessage({ type: 'import', file: it.file, name: it.name, myName, keepOriginal })
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
