import type { Database, SqlJsStatic } from 'sql.js'
import { db, log, recomputeConversation } from './db'
import { dupKeyOf, mimeOf } from './importCore'
import { extKind } from './parser'
import { matchKey } from './names'
import type { Attachment, Conversation, ImportReport, Message, MsgKind } from './types'

/**
 * Import a full iPhone WhatsApp backup taken with iTunes / Apple Devices (UNENCRYPTED local backup).
 * The backup folder holds Manifest.db (maps real paths -> hashed file names) and the hashed files themselves.
 * We read ChatStorage.sqlite (all chats) and the media files straight from the folder, one chat at a time.
 * Each finished chat is committed and remembered, so an interrupted run resumes at the first unfinished chat.
 */

export interface BackupSet { root: string; manifest: File; byId: Map<string, File> }

const relPath = (f: File) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name
/** Find backup folders inside a picked folder (it may be the single backup, or the parent "Backup" folder). */
export function findBackups(files: File[]): BackupSet[] {
  const roots = new Map<string, BackupSet>()
  for (const f of files) if (f.name === 'Manifest.db') { const p = relPath(f); const root = p.slice(0, Math.max(0, p.lastIndexOf('/'))); roots.set(root, { root, manifest: f, byId: new Map() }) }
  for (const f of files) {
    if (!/^[0-9a-f]{40}$/i.test(f.name)) continue
    const p = relPath(f)
    for (const [root, set] of roots) if (root === '' || p.startsWith(root + '/')) { set.byId.set(f.name.toLowerCase(), f); break }
  }
  return [...roots.values()]
}

const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1)
/** Memora stores the wall-clock time as naive UTC; iPhone stores an absolute instant, so convert using this device's timezone. */
const naive = (appleSec: number) => { const d = new Date(APPLE_EPOCH_MS + appleSec * 1000); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()) }
const p2 = (n: number) => String(n).padStart(2, '0')
const rawOf = (ts: number) => { const d = new Date(ts); return `${p2(d.getUTCDate())}/${p2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}, ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}` }
const phoneOf = (jid: string | null) => (jid ? '+' + jid.split('@')[0].split(':')[0] : '')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>
function all(d: Database, sql: string, params: (string | number)[] = []): Row[] {
  const st = d.prepare(sql); const out: Row[] = []
  try { st.bind(params); while (st.step()) out.push(st.getAsObject() as Row) } finally { st.free() }
  return out
}
const colsOf = (d: Database, table: string) => { try { return new Set(all(d, `PRAGMA table_info(${table})`).map(r => String(r.name))) } catch { return new Set<string>() } }

const KIND: Record<number, MsgKind> = { 0: 'text', 1: 'image', 2: 'video', 3: 'voice', 4: 'contact', 5: 'location', 6: 'system', 7: 'text', 8: 'document', 10: 'system', 11: 'gif', 14: 'deleted', 15: 'sticker' }
const MEDIA_TYPES = new Set<MsgKind>(['image', 'video', 'voice', 'document', 'gif', 'sticker', 'audio'])

export interface BackupOpts {
  sql: SqlJsStatic
  myName?: string | null
  progress(pct: number, msg: string): void
  isCancelled(): boolean
}
export interface BackupResult { zipId: number; status: 'done' | 'done_with_warnings' | 'interrupted'; reports: ImportReport[]; chats: number }
interface Sess { sess: number; convId: number; done: boolean; merged?: boolean }

export async function importIosBackup(bk: BackupSet, opts: BackupOpts): Promise<BackupResult> {
  const { sql, progress } = opts
  const name = `iPhone backup ${bk.root.split('/').pop() || 'folder'}`
  progress(1, 'Reading backup index…')

  // --- Manifest.db: real path -> hashed file name
  const mbytes = new Uint8Array(await bk.manifest.arrayBuffer())
  if (new TextDecoder().decode(mbytes.slice(0, 15)) !== 'SQLite format 3') throw new Error('This backup is ENCRYPTED, so it cannot be read. On the PC: iTunes / Apple Devices → turn OFF “Encrypt local backup” → Back Up Now → pick the new backup folder.')
  const manifest = new sql.Database(mbytes)
  const idByPath = new Map<string, string>()
  try {
    for (const r of all(manifest, "SELECT fileID, relativePath, domain FROM Files WHERE domain LIKE '%whatsapp%' AND relativePath <> ''")) {
      const p = String(r.relativePath); if (!idByPath.has(p) || String(r.domain).includes('group.net.whatsapp.WhatsApp.shared')) idByPath.set(p, String(r.fileID).toLowerCase())
    }
  } finally { manifest.close() }
  const chatId = idByPath.get('ChatStorage.sqlite')
  if (!chatId) throw new Error('No WhatsApp chat database in this backup (WhatsApp must be installed on the iPhone and the backup must be a full, unencrypted one).')
  const chatFile = bk.byId.get(chatId)
  if (!chatFile) throw new Error('ChatStorage.sqlite is listed in the backup but its file was not in the folder you picked. Pick the whole backup folder (the one that contains Manifest.db and the 00…ff sub-folders).')

  progress(3, 'Opening chat database…')
  const cdb = new sql.Database(new Uint8Array(await chatFile.arrayBuffer()))
  let zipId = 0
  try {
    // --- lookups
    const sessCols = colsOf(cdb, 'ZWACHATSESSION')
    const sessions = all(cdb, `SELECT Z_PK AS pk, ZPARTNERNAME AS pname, ZCONTACTJID AS jid, ${sessCols.has('ZSESSIONTYPE') ? 'ZSESSIONTYPE' : 'NULL'} AS stype, ${sessCols.has('ZARCHIVED') ? 'ZARCHIVED' : '0'} AS arch FROM ZWACHATSESSION`)
    const counts = new Map<number, number>(); for (const r of all(cdb, 'SELECT ZCHATSESSION AS s, COUNT(*) AS n FROM ZWAMESSAGE GROUP BY ZCHATSESSION')) counts.set(Number(r.s), Number(r.n))
    const todo = sessions.filter(s => (counts.get(Number(s.pk)) ?? 0) > 0 && String(s.jid) !== 'status@broadcast')
    const nameByJid = new Map<string, string>(); for (const s of sessions) if (s.jid && s.pname && !String(s.jid).endsWith('@g.us')) nameByJid.set(String(s.jid), String(s.pname))
    try { for (const r of all(cdb, 'SELECT ZJID AS j, ZPUSHNAME AS n FROM ZWAPROFILEPUSHNAME')) if (r.j && r.n && !nameByJid.has(String(r.j))) nameByJid.set(String(r.j), String(r.n)) } catch { /* table absent in some versions */ }
    const member = new Map<number, string>()
    try { for (const r of all(cdb, 'SELECT Z_PK AS pk, ZMEMBERJID AS j, ZCONTACTNAME AS n FROM ZWAGROUPMEMBER')) member.set(Number(r.pk), (r.n && String(r.n)) || nameByJid.get(String(r.j)) || phoneOf(String(r.j))) } catch { /* ignore */ }
    const mCols = colsOf(cdb, 'ZWAMESSAGE')
    const miCols = colsOf(cdb, 'ZWAMEDIAITEM')
    const totalMsgs = todo.reduce((a, s) => a + (counts.get(Number(s.pk)) ?? 0), 0) || 1

    // --- zip record (powers history, resume, discard)
    const prev = (await db.zips.where('name').equals(name).toArray()).find(z => z.status === 'interrupted')
    const sessState: Sess[] = (prev?.decisions as Sess[] | undefined) ?? []
    if (prev) { zipId = prev.id!; await db.zips.update(zipId, { status: 'importing', error: undefined, lastPhase: 'resuming' }) }
    else zipId = await db.zips.add({ name, size: chatFile.size, blob: new Blob([]), originalKept: false, lastPhase: 'start', importedAt: Date.now(), status: 'importing', convIds: [], reports: [], decisions: [] }) as number
    const save = () => db.zips.update(zipId, { decisions: sessState, convIds: sessState.map(s => s.convId) })

    const reports: ImportReport[] = []
    const prevReports = prev?.reports ?? []
    let doneMsgs = 0, processedChats = 0
    const existingPaths = new Set<string>(); const attByPath = new Map<string, number>()
    await db.attachments.where('zipId').equals(zipId).each(a => { if (a.id !== undefined) { attByPath.set(a.path, a.id); existingPaths.add(a.path) } })
    const meLabel = opts.myName?.trim() || 'Me'

    for (const s of todo) {
      if (opts.isCancelled()) throw new Error('Stopped by you')
      const spk = Number(s.pk)
      const nMsgs = counts.get(spk) ?? 0
      const st = sessState.find(x => x.sess === spk)
      if (st?.done) { doneMsgs += nMsgs; processedChats++; continue }

      const jid = String(s.jid ?? '')
      const isGroup = jid.endsWith('@g.us') || Number(s.stype) === 1
      const cname = (s.pname && String(s.pname).trim()) || phoneOf(jid) || `Chat ${spk}`
      progress(5 + Math.round((doneMsgs / totalMsgs) * 90), `${cname} — reading`)

      // conversation: reuse the one from an earlier attempt, else merge into a same-named chat, else create
      let conv: Conversation | undefined, merged = false
      if (st) conv = await db.conversations.get(st.convId)
      if (!conv) {
        const key = matchKey(cname)
        conv = (await db.conversations.toArray()).find(c => matchKey(c.name) === key && c.isGroup === isGroup)
        if (conv) { merged = true; await db.conversations.update(conv.id!, { sourceZipIds: [...new Set([...conv.sourceZipIds, zipId])] }) }
        else {
          const base: Conversation = { name: cname, isGroup, meName: meLabel, firstTs: null, lastTs: null, messageCount: 0, attachmentCount: 0, lastPreview: '', lastSender: '', lastKind: 'text', favourite: false, archived: !!Number(s.arch), importedAt: Date.now(), sourceZipIds: [zipId] }
          base.id = await db.conversations.add(base) as number; conv = base
        }
        sessState.push({ sess: spk, convId: conv.id!, done: false, merged }); await save()
      } else merged = !!st?.merged
      const convId = conv.id!
      const meName = conv.meName ?? meLabel
      await db.messages.where('zipId').equals(zipId).and(m => m.convId === convId).delete()   // a half-saved earlier attempt of THIS chat

      // messages joined with their media row
      const sel = [`m.Z_PK AS pk`, `m.ZMESSAGEDATE AS d`, `m.ZISFROMME AS me`, `m.ZTEXT AS text`, `m.ZMESSAGETYPE AS type`, mCols.has('ZFROMJID') ? 'm.ZFROMJID AS fjid' : 'NULL AS fjid', mCols.has('ZGROUPMEMBER') ? 'm.ZGROUPMEMBER AS gm' : 'NULL AS gm', mCols.has('ZPUSHNAME') ? 'm.ZPUSHNAME AS push' : 'NULL AS push',
        miCols.has('ZMEDIALOCALPATH') ? 'mi.ZMEDIALOCALPATH AS mpath' : 'NULL AS mpath', miCols.has('ZTITLE') ? 'mi.ZTITLE AS title' : 'NULL AS title'].join(', ')
      const raw = all(cdb, `SELECT ${sel} FROM ZWAMESSAGE m LEFT JOIN ZWAMEDIAITEM mi ON mi.ZMESSAGE = m.Z_PK WHERE m.ZCHATSESSION = ? ORDER BY m.ZMESSAGEDATE, m.Z_PK`, [spk])
      const seen = new Set<number>(); const rowsIn = raw.filter(r => { const k = Number(r.pk); if (seen.has(k)) return false; seen.add(k); return true })

      // media of this chat: store each file once (batched), skipping those saved by an earlier attempt
      const missingNames: string[] = [], failed: string[] = []
      let batch: Attachment[] = [], batchBytes = 0, omitted = 0, matched = 0, refs = 0
      const flush = async () => {
        if (!batch.length) return
        const items = batch; batch = []; batchBytes = 0
        try { const ids = await db.transaction('rw', db.attachments, () => db.attachments.bulkAdd(items, { allKeys: true })); ids.forEach((id, i) => attByPath.set(items[i].path, id as number)) }
        catch {
          const { storeAttachmentResilient } = await import('./importCore')
          for (const a of items) { const r = await storeAttachmentResilient(a); if (r.id === null) { failed.push(a.name); await log('warn', `Could not store "${a.name}": ${r.error}`, zipId) } else attByPath.set(a.path, r.id) }
        }
      }
      let ri = 0
      for (const r of rowsIn) {
        if (++ri % 200 === 0) { if (opts.isCancelled()) throw new Error('Stopped by you'); progress(5 + Math.round(((doneMsgs + (ri / rowsIn.length) * nMsgs * 0.7) / totalMsgs) * 90), `${cname} — media ${ri}/${rowsIn.length}`); await db.zips.update(zipId, { lastPhase: `${cname}: media ${ri}/${rowsIn.length}` }).catch(() => {}) }
        const mp = r.mpath ? String(r.mpath) : ''
        if (!mp) continue
        refs++
        const path = 'Message/' + mp
        if (attByPath.has(path)) { matched++; continue }
        const id = idByPath.get(path); const f = id ? bk.byId.get(id) : undefined
        if (!f) { missingNames.push(mp.split('/').pop()!); continue }
        const nm = mp.split('/').pop()!
        const blob = new Blob([f], { type: mimeOf(nm) })
        batch.push({ convId, zipId, name: nm, path, mime: mimeOf(nm), size: f.size, kind: extKind(nm), blob, ts: r.d == null ? null : naive(Number(r.d)) })
        batchBytes += f.size; matched++
        if (f.size >= 1 << 20 || batch.length >= 15 || batchBytes > 8 << 20) await flush()
      }
      await flush()

      // message rows
      const base = await db.messages.where('convId').equals(convId).count()
      const existingKeys = new Map<string, number[]>()
      if (merged) await db.messages.where('convId').equals(convId).filter(m => m.zipId !== zipId && !m.hidden).each(m => { (existingKeys.get(m.dupKey) ?? existingKeys.set(m.dupKey, []).get(m.dupKey)!).push(m.id!) })
      let out = 0, inn = 0, sys = 0, dups = 0, unknownTypes = 0
      const rows: Message[] = rowsIn.map((r, i) => {
        const type = Number(r.type ?? 0)
        let kind: MsgKind = KIND[type] ?? 'text'
        const isMe = !!Number(r.me)
        const ts = r.d == null ? null : naive(Number(r.d))
        const mp = r.mpath ? String(r.mpath) : ''
        const path = mp ? 'Message/' + mp : ''
        const attId = path ? attByPath.get(path) : undefined
        let body = r.text ? String(r.text) : ''
        let flagged: string | undefined
        if (!(type in KIND)) { unknownTypes++; flagged = `Unknown iPhone message type ${type}`; if (!body) body = `[Unsupported WhatsApp message type ${type}]` }
        if (kind === 'system' && !body) body = type === 10 ? 'Call or system event' : 'Group or system event'
        if (kind === 'deleted' && !body) body = 'This message was deleted'
        if (kind === 'location' && !body) body = 'Location'
        if (kind === 'contact' && !body) body = 'Contact card'
        let sender = ''
        if (kind !== 'system') sender = isMe ? meName : (isGroup ? (member.get(Number(r.gm)) || nameByJid.get(String(r.fjid)) || (r.push && String(r.push)) || phoneOf(r.fjid ? String(r.fjid) : null) || 'Unknown') : cname)
        const attMissing = (MEDIA_TYPES.has(kind) && attId === undefined) || undefined
        if (attMissing && !mp) omitted++
        if (kind === 'system') sys++; else if (isMe) out++; else inn++
        const row: Message = {
          convId, seq: base + i, sortTs: ts ?? 0, ts, rawTs: ts === null ? '' : rawOf(ts), sender, isMe, body, kind,
          attName: mp ? mp.split('/').pop() : undefined, attId, attMissing, zipId, srcFile: 'ChatStorage.sqlite', lineNo: Number(r.pk), raw: '', flagged, dupKey: ''
        }
        row.dupKey = dupKeyOf(row)
        if (merged && kind !== 'system') { const l = existingKeys.get(row.dupKey); if (l?.length) { row.dupOf = l.shift(); row.dupState = 'pending'; dups++ } }
        return row
      })
      for (let i = 0; i < rows.length; i += 1000) { await db.messages.bulkAdd(rows.slice(i, i + 1000)); progress(5 + Math.round(((doneMsgs + nMsgs * (0.7 + 0.3 * Math.min(1, (i + 1000) / rows.length))) / totalMsgs) * 90), `${cname} — saving messages`) }
      await recomputeConversation(convId)
      doneMsgs += nMsgs; processedChats++
      const tsList = rows.map(m => m.ts).filter((t): t is number => t !== null)
      const warnings: string[] = []
      if (missingNames.length) warnings.push(`${missingNames.length} media file(s) are referenced by the chat but are not in the backup folder (shown as “attachment unavailable”).`)
      if (omitted) warnings.push(`${omitted} media message(s) have no local file on the iPhone (never downloaded / deleted from the phone), so they cannot be recovered from this backup.`)
      if (failed.length) warnings.push(`${failed.length} file(s) could not be saved by the browser's storage: ${failed.slice(0, 8).join(', ')}`)
      if (unknownTypes) warnings.push(`${unknownTypes} message(s) have an unrecognised iPhone type; they are kept and flagged for review.`)
      reports.push({
        zipName: name, conversation: cname, conversationId: convId, mergedIntoExisting: merged, chatFiles: ['ChatStorage.sqlite'], parsed: rows.length, outgoing: out, incoming: inn, system: sys,
        mediaRefs: refs + omitted, matched, missing: missingNames.length, omittedByWhatsApp: omitted, orphanFiles: 0, unparsedLines: 0, flaggedTimestamps: rows.filter(m => m.ts === null).length,
        firstTs: tsList.length ? tsList[0] : null, lastTs: tsList.length ? tsList[tsList.length - 1] : null, dupCandidates: dups, dateOrder: 'n/a (database)', format: 'iPhone backup', warnings, missingNames, storageFailed: failed
      })
      const cur = sessState.find(x => x.sess === spk)!; cur.done = true; await save()
      await db.zips.update(zipId, { reports: [...prevReports, ...reports] })
    }

    const allReports = [...prevReports, ...reports]
    const hasIssues = allReports.some(r => r.missing || r.omittedByWhatsApp || r.dupCandidates || r.warnings.length)
    const status = hasIssues ? 'done_with_warnings' : 'done'
    await db.zips.update(zipId, { status, reports: allReports, lastPhase: 'done' })
    await log(hasIssues ? 'warn' : 'info', `Imported ${name}: ${processedChats} chats`, zipId)
    progress(100, 'Done')
    return { zipId, status, reports: allReports, chats: processedChats }
  } catch (e) {
    if (zipId) await pauseBackup(zipId, (e as Error).message)
    throw e
  } finally { cdb.close() }
}

/** Keep finished chats and media; drop only the unfinished chat's messages; mark resumable. */
async function pauseBackup(zipId: number, reason: string) {
  const z = await db.zips.get(zipId); if (!z) return
  const done = new Set(((z.decisions as Sess[] | undefined) ?? []).filter(s => s.done).map(s => s.convId))
  await db.messages.where('zipId').equals(zipId).filter(m => !done.has(m.convId)).delete()
  for (const c of z.convIds) await recomputeConversation(c)
  await db.zips.update(zipId, { status: 'interrupted', error: `${reason} — finished chats are safe. Pick the same backup folder again to continue with the remaining chats.` })
  await log('warn', `Backup import paused (resumable): ${reason}`, zipId)
}
