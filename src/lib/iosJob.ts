import { useSyncExternalStore } from 'react'
import initSqlJs from 'sql.js'
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url'
import { getSetting } from './db'
import { findBackups, importIosBackup } from './iosBackup'
import { indexZip } from './search'
import type { ImportReport } from './types'

export interface BackupJob { state: 'idle' | 'running' | 'done' | 'paused'; pct: number; msg: string; error?: string; reports?: ImportReport[]; found?: number }
let job: BackupJob = { state: 'idle', pct: 0, msg: '' }
const subs = new Set<() => void>()
const set = (p: Partial<BackupJob>) => { job = { ...job, ...p }; subs.forEach(s => s()) }
export const useBackupJob = () => useSyncExternalStore(cb => { subs.add(cb); return () => { subs.delete(cb) } }, () => job)
let stop = false
export const stopBackupImport = () => { stop = true }

export async function startBackupImport(files: File[]) {
  if (job.state === 'running') return
  stop = false
  const sets = findBackups(files)
  if (!sets.length) { set({ state: 'paused', error: 'No iPhone backup found in that folder (Manifest.db missing). Pick the folder whose name is a long code (the device ID), inside MobileSync\\Backup.', msg: '' }); return }
  set({ state: 'running', pct: 0, msg: 'Starting…', error: undefined, reports: undefined, found: sets.length })
  let lock: { release(): Promise<void> } | null = null
  try {
    try { await navigator.storage?.persist?.() } catch { /* best effort */ }
    try { lock = await (navigator as unknown as { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen') ?? null } catch { /* optional */ }
    const sql = await initSqlJs({ locateFile: () => wasmUrl })
    const myName = await getSetting<string | null>('myName', null)
    const all: ImportReport[] = []
    for (const bk of sets) {
      const r = await importIosBackup(bk, { sql, myName, progress: (pct, msg) => set({ pct, msg }), isCancelled: () => stop })
      all.push(...r.reports); try { await indexZip(r.zipId) } catch { /* rebuilt lazily */ }
    }
    set({ state: 'done', pct: 100, msg: 'Imported', reports: all })
  } catch (e) { set({ state: 'paused', error: (e as Error).message, msg: 'Stopped' }) }
  finally { lock?.release().catch(() => {}) }
}
