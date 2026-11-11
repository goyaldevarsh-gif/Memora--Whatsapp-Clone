import JSZip from 'jszip'
import { db, recomputeConversation, log } from './db'
import { invalidateIndex } from './search'
import type { Attachment, Bookmark, Conversation, Message, ZipRecord } from './types'

export const BACKUP_FORMAT = 'memora-backup'
export const BACKUP_VERSION = 1

export interface BackupOptions { includeMedia: boolean; includeZips: boolean; convIds?: number[] }
export interface Manifest {
  format: typeof BACKUP_FORMAT; version: number; createdAt: number; app: string
  options: { includeMedia: boolean; includeZips: boolean; partial: boolean }
  counts: { conversations: number; messages: number; attachments: number; zips: number; bookmarks: number }
  files: Record<string, { sha256: string; size: number }>
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('')
async function sha(data: ArrayBuffer | string) {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data
  return hex(await crypto.subtle.digest('SHA-256', buf as ArrayBuffer))
}
const MSG_PER_FILE = 5000
type Progress = (pct: number, msg: string) => void

export async function estimateBackupBytes(o: BackupOptions): Promise<number> {
  let n = 0
  if (o.includeMedia) await db.attachments.each(a => { if (!o.convIds || o.convIds.includes(a.convId)) n += a.size })
  if (o.includeZips) await db.zips.each(z => { n += z.size })
  return n + (await db.messages.count()) * 400
}

export async function createBackup(o: BackupOptions, progress: Progress = () => {}): Promise<Blob> {
  const zip = new JSZip()
  const files: Manifest['files'] = {}
  const addText = async (path: string, text: string) => { zip.file(path, text); files[path] = { sha256: await sha(text), size: new Blob([text]).size } }
  const addBlob = async (path: string, blob: Blob) => { const ab = await blob.arrayBuffer(); zip.file(path, ab); files[path] = { sha256: await sha(ab), size: ab.byteLength } }
  const inScope = (c: number) => !o.convIds || o.convIds.includes(c)

  progress(2, 'Collecting conversations…')
  const convs = (await db.conversations.toArray()).filter(c => inScope(c.id!))
  const convIds = new Set(convs.map(c => c.id!))
  await addText('data/conversations.json', JSON.stringify(convs))

  const total = await db.messages.count()
  let chunk: Message[] = [], part = 0, done = 0, msgCount = 0
  const flush = async () => { if (!chunk.length) return; await addText(`data/messages-${String(part++).padStart(4, '0')}.ndjson`, chunk.map(m => JSON.stringify(m)).join('\n')); chunk = [] }
  await db.messages.each(m => { if (convIds.has(m.convId)) { chunk.push(m); msgCount++ } })
  const all = chunk; chunk = []
  for (let i = 0; i < all.length; i += MSG_PER_FILE) { chunk = all.slice(i, i + MSG_PER_FILE); await flush(); done += chunk.length; progress(5 + Math.round((i / Math.max(1, total)) * 25), `Messages ${Math.min(i + MSG_PER_FILE, all.length)}/${all.length}`) }

  const atts = (await db.attachments.toArray()).filter(a => convIds.has(a.convId))
  await addText('data/attachments.json', JSON.stringify(atts.map(({ blob, ...meta }) => ({ ...meta, file: o.includeMedia ? `media/${meta.id}` : null }))))
  if (o.includeMedia) {
    let i = 0
    for (const a of atts) { await addBlob(`media/${a.id}`, a.blob); i++; if (i % 20 === 0) progress(30 + Math.round((i / atts.length) * 40), `Media ${i}/${atts.length}`) }
  }
  const zips = (await db.zips.toArray()).filter(z => z.convIds.some(c => convIds.has(c)) || !o.convIds)
  await addText('data/zips.json', JSON.stringify(zips.map(({ blob, ...meta }) => ({ ...meta, file: o.includeZips ? `originals/${meta.id}.zip` : null }))))
  if (o.includeZips) {
    let i = 0
    for (const z of zips) { await addBlob(`originals/${z.id}.zip`, z.blob); i++; progress(70 + Math.round((i / zips.length) * 20), `Original ZIPs ${i}/${zips.length}`) }
  }
  const bms = (await db.bookmarks.toArray()).filter(b => convIds.has(b.convId))
  await addText('data/bookmarks.json', JSON.stringify(bms))
  await addText('data/logs.json', JSON.stringify(await db.logs.toArray()))
  const settings = (await db.settings.toArray()).filter(s => s.key !== 'pin')   // PIN hash is device-specific, never exported
  await addText('data/settings.json', JSON.stringify(settings))

  const manifest: Manifest = {
    format: BACKUP_FORMAT, version: BACKUP_VERSION, createdAt: Date.now(), app: 'memora-pwa',
    options: { includeMedia: o.includeMedia, includeZips: o.includeZips, partial: !!o.convIds },
    counts: { conversations: convs.length, messages: msgCount, attachments: atts.length, zips: zips.length, bookmarks: bms.length }, files
  }
  zip.file('manifest.json', JSON.stringify(manifest, null, 2))
  progress(92, 'Packaging…')
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 3 }, streamFiles: true }, m => progress(92 + Math.round(m.percent * 0.07), 'Packaging…'))
  await db.settings.put({ key: 'lastBackupAt', value: Date.now() })
  progress(100, 'Done')
  return blob
}

export interface VerifyResult { ok: boolean; manifest?: Manifest; problems: string[]; zip?: JSZip }
export async function verifyBackup(file: Blob, progress: Progress = () => {}): Promise<VerifyResult> {
  const problems: string[] = []
  let zip: JSZip
  try { zip = await JSZip.loadAsync(file) } catch { return { ok: false, problems: ['File is not a valid ZIP/backup archive.'] } }
  const mf = zip.file('manifest.json')
  if (!mf) return { ok: false, problems: ['manifest.json is missing — this is not a Memora backup.'] }
  let manifest: Manifest
  try { manifest = JSON.parse(await mf.async('string')) } catch { return { ok: false, problems: ['manifest.json is corrupted.'] } }
  if (manifest.format !== BACKUP_FORMAT) return { ok: false, problems: ['Unrecognised backup format.'] }
  if (manifest.version > BACKUP_VERSION) return { ok: false, manifest, problems: [`Backup version ${manifest.version} is newer than this app understands (${BACKUP_VERSION}). Update Memora first.`] }
  const paths = Object.keys(manifest.files); let i = 0
  for (const p of paths) {
    const f = zip.file(p)
    if (!f) { problems.push(`Missing file: ${p}`); continue }
    const ab = await f.async('arraybuffer')
    if (ab.byteLength !== manifest.files[p].size) problems.push(`Size mismatch: ${p}`)
    else if ((await sha(ab)) !== manifest.files[p].sha256) problems.push(`Checksum mismatch: ${p}`)
    if (++i % 25 === 0) progress(Math.round((i / paths.length) * 100), `Verifying ${i}/${paths.length}`)
  }
  return { ok: problems.length === 0, manifest, problems, zip }
}

/** Restore ADDS everything with fresh ids (never overwrites). Integrity is verified first. */
export async function restoreBackup(file: Blob, progress: Progress = () => {}): Promise<{ conversations: number; messages: number }> {
  const v = await verifyBackup(file, (p, m) => progress(p * 0.3, m))
  if (!v.ok || !v.zip || !v.manifest) throw new Error('Backup failed verification: ' + v.problems.slice(0, 5).join('; '))
  const zip = v.zip, mf = v.manifest
  const readJson = async <T>(p: string): Promise<T> => JSON.parse(await zip.file(p)!.async('string'))
  const convMap = new Map<number, number>(), zipMap = new Map<number, number>(), attMap = new Map<number, number>(), msgMap = new Map<number, number>()

  const convs = await readJson<Conversation[]>('data/conversations.json')
  for (const c of convs) { const old = c.id!; const { id, ...rest } = c; convMap.set(old, await db.conversations.add({ ...rest, sourceZipIds: [] })) }

  const zrecs = await readJson<(Omit<ZipRecord, 'blob'> & { file: string | null })[]>('data/zips.json')
  for (const z of zrecs) {
    const { id, file: f, ...rest } = z
    const blob = f ? await zip.file(f)!.async('blob') : new Blob([])
    zipMap.set(id!, await db.zips.add({ ...rest, blob, convIds: z.convIds.map(c => convMap.get(c)).filter((x): x is number => !!x), status: f ? z.status : z.status }))
  }
  for (const c of convs) await db.conversations.update(convMap.get(c.id!)!, { sourceZipIds: c.sourceZipIds.map(z => zipMap.get(z)).filter((x): x is number => !!x) })

  const atts = await readJson<(Omit<Attachment, 'blob'> & { file: string | null })[]>('data/attachments.json')
  let i = 0
  for (const a of atts) {
    const { id, file: f, ...rest } = a
    const blob = f ? new Blob([await zip.file(f)!.async('arraybuffer')], { type: a.mime }) : new Blob([], { type: a.mime })
    attMap.set(id!, await db.attachments.add({ ...rest, convId: convMap.get(a.convId)!, zipId: zipMap.get(a.zipId) ?? 0, blob }))
    if (++i % 20 === 0) progress(30 + Math.round((i / atts.length) * 30), `Media ${i}/${atts.length}`)
  }

  const parts = Object.keys(mf.files).filter(p => /^data\/messages-\d+\.ndjson$/.test(p)).sort()
  let n = 0
  for (const p of parts) {
    const rows: Message[] = (await zip.file(p)!.async('string')).split('\n').filter(Boolean).map(l => JSON.parse(l))
    const olds = rows.map(r => r.id!)
    const fresh = rows.map(r => { const { id, ...rest } = r; return { ...rest, convId: convMap.get(r.convId)!, zipId: zipMap.get(r.zipId) ?? 0, attId: r.attId ? attMap.get(r.attId) : undefined, dupOf: undefined as number | undefined, _dupOld: r.dupOf } })
    const keys = await db.messages.bulkAdd(fresh.map(({ _dupOld, ...m }) => m as Message), { allKeys: true })
    olds.forEach((o, k) => msgMap.set(o, keys[k] as number))
    // remap dupOf after ids are known
    const upd = fresh.map((f, k) => ({ k, old: f._dupOld })).filter(x => x.old)
    for (const u of upd) { const nid = msgMap.get(u.old!); if (nid) await db.messages.update(keys[u.k] as number, { dupOf: nid }) }
    n += rows.length; progress(60 + Math.round((n / Math.max(1, mf.counts.messages)) * 30), `Messages ${n}/${mf.counts.messages}`)
  }
  const bms = await readJson<Bookmark[]>('data/bookmarks.json')
  for (const b of bms) { const mid = msgMap.get(b.messageId), cid = convMap.get(b.convId); if (mid && cid) { const { id, ...rest } = b; await db.bookmarks.add({ ...rest, messageId: mid, convId: cid }) } }
  for (const nid of convMap.values()) await recomputeConversation(nid)
  await invalidateIndex()
  await log('info', `Restored backup from ${new Date(mf.createdAt).toISOString()}: ${convs.length} conversations, ${n} messages`)
  progress(100, 'Restored')
  return { conversations: convs.length, messages: n }
}
