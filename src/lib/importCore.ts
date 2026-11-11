import { openZip, type ZipEntry } from './zipReader'
import { db, log, recomputeConversation, rollbackZip, suspendZip, previewOf } from './db'
import { parseWhatsAppText, captionOf, extKind, type ParsedMessage, type ParseResult } from './parser'
import { guessIsGroup, guessMe, matchKey, nameFromFile } from './names'
import type { Attachment, Conversation, ImportReport, Message, MsgKind, ZipRecord } from './types'

export interface Decision { action: 'merge' | 'new'; convId?: number; name: string; isGroup?: boolean }
export interface UnitInfo {
  chatFile: string; name: string; isGroup: boolean; messageCount: number
  firstTs: number | null; lastTs: number | null
  candidates: { convId: number; name: string; messageCount: number }[]
  defaultDecision: Decision
}
export interface Hooks {
  progress(p: { phase: string; pct: number; msg: string }): void
  decide(zipName: string, units: UnitInfo[]): Promise<Decision[]>
  isCancelled(): boolean
  resumeZipId?: number
  myName?: string | null
  keepOriginal?: boolean       // copy the original ZIP into IndexedDB (doubles storage); default true
}
export interface ImportResult { zipId: number; status: ZipRecord['status']; reports: ImportReport[]; convIds: number[] }

const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', gif: 'image/gif',
  mp4: 'video/mp4', mov: 'video/quicktime', '3gp': 'video/3gpp', webm: 'video/webm', mkv: 'video/x-matroska',
  opus: 'audio/ogg; codecs=opus', ogg: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', aac: 'audio/aac', amr: 'audio/amr',
  pdf: 'application/pdf', txt: 'text/plain', zip: 'application/zip', vcf: 'text/vcard',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
}
export const mimeOf = (name: string) => MIME[(name.split('.').pop() ?? '').toLowerCase()] ?? 'application/octet-stream'

const normName = (s: string) => s.replace(/[‎‏‪-‮]/g, '').replace(/[  ]/g, ' ').normalize('NFC').trim().toLowerCase()
const minMax = (a: (number | null)[]) => { let lo: number | null = null, hi: number | null = null; for (const t of a) { if (t === null) continue; if (lo === null || t < lo) lo = t; if (hi === null || t > hi) hi = t } return { lo, hi } }
const baseName = (p: string) => p.split('/').pop() ?? p

export function dupKeyOf(m: { ts: number | null; rawTs: string; sender: string; body: string; kind: MsgKind; attName?: string }): string {
  const text = captionOf({ ...m, attMissing: false }).replace(/\s+/g, ' ').trim().toLowerCase()
  const att = m.attName ? 'att:' + m.kind : ''
  return `${m.ts ?? m.rawTs}|${m.sender.toLowerCase()}|${att}|${text}`
}

const VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'test'
// Safari/iOS exposes no navigator.deviceMemory and kills pages that use a lot of RAM: use smaller write batches there.
const LOW_MEM = typeof navigator !== 'undefined' && !(navigator as unknown as { deviceMemory?: number }).deviceMemory
const CHUNK = LOW_MEM ? 500 : 1500
const BATCH_FILES = LOW_MEM ? 10 : 25
const BATCH_BYTES = (LOW_MEM ? 3 : 40) * 1024 * 1024
const SINGLE_BYTES = (LOW_MEM ? 1 : 8) * 1024 * 1024   // files at least this big are written one per transaction

export async function importZipCore(file: Blob, zipName: string, hooks: Hooks): Promise<ImportResult> {
  const cancelled = () => { if (hooks.isCancelled()) throw new Error('__cancelled__') }
  hooks.progress({ phase: 'read', pct: 2, msg: 'Reading ZIP…' })

  // 1. Preserve the original ZIP first, untouched.
  const keep = hooks.keepOriginal !== false
  const prev = hooks.resumeZipId ? await db.zips.get(hooks.resumeZipId) : undefined
  const resuming = !!prev && prev.status === 'interrupted'
  let zipId: number
  if (resuming) {
    zipId = prev!.id!
    await db.zips.update(zipId, { status: 'importing', error: undefined, appVersion: VERSION, lastPhase: 'resuming', ...(keep ? { blob: file, originalKept: true } : {}) })
  } else zipId = await db.zips.add({ name: zipName, size: file.size, blob: keep ? file : new Blob([]), originalKept: keep, appVersion: VERSION, lastPhase: 'opened ZIP', importedAt: Date.now(), status: 'importing', convIds: [], reports: [] })
  let staged = false     // true once conversations/media exist for this ZIP => failures keep them so the import can be resumed
  let lastBeat = 0
  const progress: Hooks['progress'] = p => {
    hooks.progress(p)
    const now = Date.now()
    if (now - lastBeat > 1500) { lastBeat = now; db.zips.update(zipId, { lastPhase: p.msg }).catch(() => {}) }
  }
  try {
    let all: ZipEntry[]
    try { all = await openZip(file) } catch (e) { throw new Error(`Not a readable ZIP file (${(e as Error).message}).`) }
    cancelled()

    const entries = all.filter(f => !f.dir && !/(^|\/)(__MACOSX|\.DS_Store)/.test(f.name) && !/(^|\/)\._/.test(f.name))
    const txtEntries = entries.filter(f => /\.txt$/i.test(f.name))
    progress({ phase: 'parse', pct: 8, msg: `Parsing ${txtEntries.length} text file(s)…` })

    const chats: { entry: ZipEntry; parsed: ParseResult }[] = []
    const nonChatTxt = new Set<string>()
    for (const e of txtEntries) {
      const text = await e.text()
      const parsed = parseWhatsAppText(text)
      if (parsed.headerLines > 0) chats.push({ entry: e, parsed }); else nonChatTxt.add(e.name)
    }
    if (!chats.length) throw new Error('No WhatsApp chat text file was recognised in this ZIP (no message lines matched any known format). The ZIP was preserved — please share a sample so the parser can be extended.')
    cancelled()

    // 2. Describe units and ask what to do with each.
    const mediaEntries = entries.filter(f => !chats.some(c => c.entry === f))
    const existing = await db.conversations.toArray()
    const units: UnitInfo[] = chats.map(({ entry, parsed }) => {
      const nm = chats.length === 1 ? nameFromFile(zipName) : nameFromFile(baseName(entry.name)) === 'chat' || /^_?chat$/i.test(nameFromFile(baseName(entry.name))) ? nameFromFile(zipName) : nameFromFile(baseName(entry.name))
      const sys = parsed.messages.filter(m => m.kind === 'system').map(m => m.body)
      const isGroup = guessIsGroup(parsed.senders, sys)
      const key = matchKey(nm)
      const candidates = existing.filter(c => matchKey(c.name) === key && c.isGroup === isGroup).map(c => ({ convId: c.id!, name: c.name, messageCount: c.messageCount }))
      const { lo: dLo, hi: dHi } = minMax(parsed.messages.map(m => m.ts))
      const defaultDecision: Decision = candidates.length ? { action: 'merge', convId: candidates[0].convId, name: candidates[0].name, isGroup } : { action: 'new', name: nm, isGroup }
      return { chatFile: entry.name, name: nm, isGroup, messageCount: parsed.messages.length, firstTs: dLo, lastTs: dHi, candidates, defaultDecision }
    })
    const savedOk = resuming && prev!.convIds.length === units.length && (prev!.decisions?.length ?? 0) === units.length
    const decisions = savedOk ? (prev!.decisions as Decision[]) : await hooks.decide(zipName, units)
    cancelled()

    // 3. Resolve conversations.
    const convIds: number[] = []
    const unitConv: { convId: number; merged: boolean; meName: string | null; conv: Conversation }[] = []
    for (let i = 0; i < units.length; i++) {
      const d = decisions[i] ?? units[i].defaultDecision
      const parsed = chats[i].parsed
      if (savedOk) {
        const conv = await db.conversations.get(prev!.convIds[i])
        if (conv) { unitConv.push({ convId: conv.id!, merged: d.action === 'merge', meName: conv.meName, conv }); convIds.push(conv.id!); continue }
      }
      if (d.action === 'merge' && d.convId) {
        const conv = (await db.conversations.get(d.convId))!
        const meName = conv.meName ?? guessMe(conv.name, parsed.senders, conv.isGroup, hooks.myName)
        if (!conv.meName && meName) await db.conversations.update(conv.id!, { meName })
        await db.conversations.update(conv.id!, { sourceZipIds: [...new Set([...conv.sourceZipIds, zipId])] })
        unitConv.push({ convId: conv.id!, merged: true, meName: conv.meName ?? meName, conv })
        convIds.push(conv.id!)
      } else {
        const isGroup = d.isGroup ?? units[i].isGroup
        const name = d.name.trim() || units[i].name
        const meName = guessMe(name, parsed.senders, isGroup, hooks.myName)
        const conv: Conversation = { name, isGroup, meName, firstTs: null, lastTs: null, messageCount: 0, attachmentCount: 0, lastPreview: '', lastSender: '', lastKind: 'text', favourite: false, archived: false, importedAt: Date.now(), sourceZipIds: [zipId] }
        const id = await db.conversations.add(conv)
        conv.id = id
        unitConv.push({ convId: id, merged: false, meName, conv })
        convIds.push(id)
      }
    }
    await db.zips.update(zipId, { convIds, decisions })
    staged = true

    // 4. Which unit references which media file? (names are matched case/space/invisible-char tolerant)
    const mediaByName = new Map<string, ZipEntry[]>()
    for (const e of mediaEntries) { const k = normName(baseName(e.name)); (mediaByName.get(k) ?? mediaByName.set(k, []).get(k)!).push(e) }
    const refUnit = new Map<string, number>()         // media entry path -> unit idx
    const refTs = new Map<string, number | null>()    // media entry path -> ts of the first referencing message
    const refCount = units.map(() => ({ refs: 0, matched: 0, missing: 0, omitted: 0, missingNames: [] as string[] }))
    const warningsPer = units.map((_, i) => [...chats[i].parsed.warnings])
    chats.forEach(({ parsed }, ui) => {
      for (const m of parsed.messages) {
        if (m.attMissing) { refCount[ui].omitted++; continue }
        if (!m.attName) continue
        refCount[ui].refs++
        const cands = mediaByName.get(normName(baseName(m.attName)))
        if (cands?.length) {
          refCount[ui].matched++
          const e = cands[0]
          if (!refUnit.has(e.name)) { refUnit.set(e.name, ui); refTs.set(e.name, m.ts) }
          if (cands.length > 1 && !warningsPer[ui].some(w => w.includes(m.attName!))) warningsPer[ui].push(`Several files named "${m.attName}" exist in the ZIP (different folders); the first was used.`)
        } else { refCount[ui].missing++; refCount[ui].missingNames.push(m.attName) }
      }
    })

    // 5. Store media (one file in memory at a time).
    const attIdByEntry = new Map<string, number>()
    if (resuming) await db.attachments.where('zipId').equals(zipId).each(a => { if (a.id !== undefined) attIdByEntry.set(a.path, a.id) })   // already stored by the earlier attempt
    let doneFiles = 0
    let orphan = units.map(() => 0)
    const failedByUnit: string[][] = units.map(() => [])
    let consecutiveFail = 0
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
    const reopen = async () => { try { db.close(); await db.open() } catch { /* retry will surface it */ } }
    const materialize = async (b: Blob) => (b.size < 300 * 1024 * 1024 ? new Blob([await b.arrayBuffer()], { type: b.type }) : b)
    const storageHint = async () => { try { const e = await navigator.storage.estimate(); return ` Browser storage: ${Math.round((e.usage ?? 0) / 1e6)} MB used of ${Math.round((e.quota ?? 0) / 1e6)} MB.` } catch { return '' } }
    let batch: { att: Attachment; key: string; ui: number }[] = [], batchBytes = 0
    // Safari/iOS IndexedDB sometimes rejects blob writes ("UnknownError"). Strategy: atomic batch -> per-file retries
    // (reopen DB, copy blob into memory) -> if a single file still can't be stored, skip it, REPORT it, keep importing.
    const storeOne = async (it: { att: Attachment; key: string; ui: number }) => {
      let lastErr = ''
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (attempt > 0) { await sleep(400 * attempt); await reopen(); it.att.blob = await materialize(it.att.blob) }
          const id = await db.attachments.add(it.att)
          attIdByEntry.set(it.key, id as number); consecutiveFail = 0; return
        } catch (e) { lastErr = (e as Error).message }
      }
      failedByUnit[it.ui].push(it.att.name); consecutiveFail++
      await log('warn', `Could not store "${it.att.name}" (${Math.round(it.att.size / 1024)} KB): ${lastErr}`, zipId)
      if (consecutiveFail >= 15) throw new Error(`The browser refused to store 15 files in a row — storage is probably full or unstable. Free some space on the device (or import on a PC and use Backup → Restore).${await storageHint()} Last error: ${lastErr}`)
    }
    const flushBatch = async () => {
      if (!batch.length) return
      const items = batch; batch = []; batchBytes = 0
      try {
        const ids = await db.transaction('rw', db.attachments, () => db.attachments.bulkAdd(items.map(i => i.att), { allKeys: true }))
        ids.forEach((id, i) => attIdByEntry.set(items[i].key, id as number)); consecutiveFail = 0
      } catch {
        for (const it of items) await storeOne(it)       // transaction was atomic: nothing from this batch was saved
      }
    }
    for (const e of mediaEntries) {
      cancelled()
      const ui = refUnit.get(e.name) ?? 0
      const isOrphan = !refUnit.has(e.name)
      if (isOrphan) orphan[ui]++
      if (attIdByEntry.has(e.name)) { doneFiles++; continue }       // resumed: this file is already safely stored
      const nm = baseName(e.name)
      let mimeBlob: Blob
      try { mimeBlob = new Blob([await e.blob()], { type: mimeOf(nm) }) }
      catch (err) { failedByUnit[ui].push(nm); await log('warn', `Could not read "${e.name}" from the ZIP: ${(err as Error).message}`, zipId); doneFiles++; continue }
      const item = { att: { convId: unitConv[ui].convId, zipId, name: nm, path: e.name, mime: mimeOf(nm), size: mimeBlob.size, kind: extKind(nm), blob: mimeBlob, orphan: isOrphan || undefined, ts: refTs.get(e.name) ?? null } as Attachment, key: e.name, ui }
      if (mimeBlob.size >= SINGLE_BYTES) { await flushBatch(); await storeOne(item) }     // big files get their own short transaction
      else { batch.push(item); batchBytes += mimeBlob.size; if (batch.length >= BATCH_FILES || batchBytes > BATCH_BYTES) await flushBatch() }
      doneFiles++
      progress({ phase: 'media', pct: 15 + Math.round((doneFiles / Math.max(1, mediaEntries.length)) * 55), msg: `Saving media ${doneFiles}/${mediaEntries.length}` })
    }
    await flushBatch()
    cancelled()

    // 6. Messages (all-or-nothing: a partial set from an earlier attempt is removed first).
    await db.messages.where('zipId').equals(zipId).delete()
    const reports: ImportReport[] = []
    let totalMsgs = chats.reduce((a, c) => a + c.parsed.messages.length, 0), doneMsgs = 0
    for (let ui = 0; ui < units.length; ui++) {
      const { parsed, entry } = chats[ui]
      const { convId, merged, meName } = unitConv[ui]
      const base = await db.messages.where('convId').equals(convId).count()   // monotonic tie-breaker; avoids loading a whole big conversation
      // dup candidates against messages from OTHER imports already in this conversation
      const existingKeys = new Map<string, number[]>()
      if (merged) await db.messages.where('convId').equals(convId).filter(m => m.zipId !== zipId && !m.hidden).each(m => { (existingKeys.get(m.dupKey) ?? existingKeys.set(m.dupKey, []).get(m.dupKey)!).push(m.id!) })

      // chronological key: forward-fill unparsable timestamps from neighbours, back-fill leading ones.
      const sortTs: number[] = []
      let last: number | null = null
      for (const m of parsed.messages) { const t = m.ts ?? last; sortTs.push(t ?? NaN); if (m.ts !== null) last = m.ts }
      let nextValid: number | null = null
      for (let i = sortTs.length - 1; i >= 0; i--) { if (Number.isNaN(sortTs[i])) sortTs[i] = nextValid ?? 0; else nextValid = sortTs[i] }

      let out = 0, inn = 0, sys = 0, dupCount = 0, flaggedTs = 0
      const rows: Message[] = parsed.messages.map((m: ParsedMessage, i: number) => {
        let attId: number | undefined
        if (m.attName) {
          const cands = mediaByName.get(normName(baseName(m.attName)))
          if (cands?.length) attId = attIdByEntry.get(cands[0].name)
        }
        const isMe = !!meName && m.sender !== '' && normName(m.sender) === normName(meName)
        if (m.kind === 'system' || m.kind === 'unparsed') sys++; else if (isMe) out++; else inn++
        if (m.ts === null && m.kind !== 'unparsed') flaggedTs++
        const row: Message = {
          convId, seq: base + i, sortTs: sortTs[i], ts: m.ts, rawTs: m.rawTs, sender: m.sender, isMe, body: m.body, kind: m.kind,
          attName: m.attName, attId, attMissing: m.attMissing || (!!m.attName && attId === undefined) || undefined,
          zipId, srcFile: entry.name, lineNo: m.lineNo,
          // raw is only stored when it can't be rebuilt from rawTs+sender+body (keeps big chats light in memory)
          raw: (m.flagged || m.kind === 'unparsed' || m.kind === 'system') ? m.raw : '', flagged: m.flagged, dupKey: ''
        }
        row.dupKey = dupKeyOf(row)
        if (merged && m.kind !== 'system' && m.kind !== 'unparsed') {
          const list = existingKeys.get(row.dupKey)
          if (list?.length) { row.dupOf = list.shift(); row.dupState = 'pending'; dupCount++ }
        }
        return row
      })
      for (let i = 0; i < rows.length; i += CHUNK) {
        cancelled()
        await db.messages.bulkAdd(rows.slice(i, i + CHUNK))
        doneMsgs += Math.min(CHUNK, rows.length - i)
        progress({ phase: 'messages', pct: 70 + Math.round((doneMsgs / Math.max(1, totalMsgs)) * 27), msg: `Saving messages ${doneMsgs.toLocaleString()}/${totalMsgs.toLocaleString()}` })
      }
      await recomputeConversation(convId)
      const { lo: rLo, hi: rHi } = minMax(parsed.messages.map(m => m.ts))
      const warnings = warningsPer[ui]
      if (!meName && !unitConv[ui].conv.isGroup) warnings.push('Could not tell which sender is you — set “My name” in Contact info so outgoing messages appear on the right.')
      if (!meName && unitConv[ui].conv.isGroup) warnings.push('Set “My name” in Settings or Contact info so your messages appear as outgoing.')
      if (failedByUnit[ui].length) warnings.push(`${failedByUnit[ui].length} file(s) could not be saved by the browser's storage (they show as “attachment unavailable”): ${failedByUnit[ui].slice(0, 8).join(', ')}${failedByUnit[ui].length > 8 ? '…' : ''}. See Audit log for details.`)
      if (refCount[ui].missing) warnings.push(`${refCount[ui].missing} attachment(s) referenced in the chat were not found in the ZIP.`)
      if (refCount[ui].omitted) warnings.push(`${refCount[ui].omitted} attachment(s) were exported “without media” by WhatsApp and cannot be recovered from this ZIP.`)
      if (nonChatTxt.size) warnings.push(`${nonChatTxt.size} other .txt file(s) kept as documents.`)
      reports.push({
        zipName, conversation: unitConv[ui].conv.name, conversationId: convId, mergedIntoExisting: merged, chatFiles: [entry.name],
        parsed: parsed.messages.length, outgoing: out, incoming: inn, system: sys,
        mediaRefs: refCount[ui].refs + refCount[ui].omitted, matched: refCount[ui].matched, missing: refCount[ui].missing, omittedByWhatsApp: refCount[ui].omitted,
        orphanFiles: orphan[ui], unparsedLines: parsed.messages.filter(m => m.kind === 'unparsed').length, flaggedTimestamps: flaggedTs,
        firstTs: rLo, lastTs: rHi,
        dupCandidates: dupCount, dateOrder: parsed.dateOrder.toUpperCase() + (parsed.dateOrderAmbiguous ? ' (assumed)' : ''), format: parsed.format,
        warnings, missingNames: refCount[ui].missingNames, storageFailed: failedByUnit[ui]
      })
    }

    const hasIssues = reports.some(r => r.missing || r.unparsedLines || r.flaggedTimestamps || r.dupCandidates || r.omittedByWhatsApp || r.warnings.length)
    const status: ZipRecord['status'] = hasIssues ? 'done_with_warnings' : 'done'
    await db.zips.update(zipId, { status, reports, convIds })
    await log(hasIssues ? 'warn' : 'info', `Imported ${zipName}: ${reports.map(r => `${r.conversation} (${r.parsed} msgs)`).join(', ')}`, zipId)
    progress({ phase: 'done', pct: 100, msg: 'Done' })
    return { zipId, status, reports, convIds }
  } catch (e) {
    const msg = (e as Error).message
    if (msg === '__cancelled__') { await rollbackZip(zipId, 'cancelled'); throw e }
    if (staged) { await suspendZip(zipId, msg); throw e }       // keep stored media: choosing the same ZIP again continues from here
    await rollbackZip(zipId, 'failed', msg)
    throw e
  }
}

export { previewOf }

/** Store one attachment with retries (reopen DB, in-memory copy). Returns the new id or null if the browser keeps refusing. */
export async function storeAttachmentResilient(att: Attachment): Promise<{ id: number | null; error: string }> {
  let lastErr = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) {
        await new Promise(r => setTimeout(r, 400 * attempt))
        try { db.close(); await db.open() } catch { /* surfaced below */ }
        if (att.blob.size < 300 * 1024 * 1024) att = { ...att, blob: new Blob([await att.blob.arrayBuffer()], { type: att.blob.type }) }
      }
      return { id: (await db.attachments.add(att)) as number, error: '' }
    } catch (e) { lastErr = (e as Error).message }
  }
  return { id: null, error: lastErr }
}

export interface FillResult { filled: number; stillMissing: number; failed: string[]; notInZip: number }
/**
 * Attach files that earlier imports could not store. Messages are NEVER re-imported or duplicated:
 * only messages that reference a filename but have no attachment get linked to the matching file in the ZIP.
 */
export async function fillMissingAttachments(file: Blob, zipName: string, onProgress: (pct: number, msg: string) => void = () => {}): Promise<FillResult> {
  const entries = (await openZip(file)).filter(f => !f.dir && !/(^|\/)(__MACOSX|\.DS_Store)/.test(f.name) && !/\.txt$/i.test(f.name))
  const byName = new Map<string, ZipEntry>()
  for (const e of entries) { const k = normName(baseName(e.name)); if (!byName.has(k)) byName.set(k, e) }
  const need = new Map<string, import('./types').Message[]>()     // key: convId|normalised filename
  let totalNeed = 0
  await db.messages.filter(m => !!m.attName && !m.attId && m.attMissing === true).each(m => {
    const k = `${m.convId}|${normName(baseName(m.attName!))}`; (need.get(k) ?? need.set(k, []).get(k)!).push(m); totalNeed++
  })
  const existingZip = await db.zips.where('name').equals(zipName).first()
  const zipId = existingZip?.id ?? await db.zips.add({ name: zipName, size: file.size, blob: new Blob([]), originalKept: false, appVersion: VERSION, importedAt: Date.now(), status: 'done', convIds: [], reports: [] })
  let filled = 0, notInZip = 0, i = 0; const failed: string[] = []; const touched = new Set<number>()
  for (const [key, msgs] of need) {
    onProgress(Math.round((i++ / Math.max(1, need.size)) * 100), `Matching ${i}/${need.size}`)
    const [convStr, nm] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)]
    const entry = byName.get(nm)
    if (!entry) { notInZip += msgs.length; continue }
    let blob: Blob
    try { blob = new Blob([await entry.blob()], { type: mimeOf(entry.name) }) } catch { failed.push(baseName(entry.name)); continue }
    const att: Attachment = { convId: +convStr, zipId, name: baseName(entry.name), path: entry.name, mime: mimeOf(entry.name), size: blob.size, kind: extKind(entry.name), blob, ts: msgs[0].ts }
    const r = await storeAttachmentResilient(att)
    if (r.id === null) { failed.push(att.name); await log('warn', `Could not store "${att.name}" while filling missing files: ${r.error}`, zipId); continue }
    for (const m of msgs) await db.messages.update(m.id!, { attId: r.id, attMissing: undefined })
    filled += msgs.length; touched.add(+convStr)
  }
  for (const c of touched) await recomputeConversation(c)
  const stillMissing = totalNeed - filled
  await log('info', `Filled ${filled} missing attachment(s) from ${zipName}; ${stillMissing} still missing`, zipId)
  onProgress(100, 'Done')
  return { filled, stillMissing, failed, notInZip }
}
