import JSZip from 'jszip'
import { db, log, recomputeConversation, rollbackZip, previewOf } from './db'
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
  myName?: string | null
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
const baseName = (p: string) => p.split('/').pop() ?? p

export function dupKeyOf(m: { ts: number | null; rawTs: string; sender: string; body: string; kind: MsgKind; attName?: string }): string {
  const text = captionOf({ ...m, attMissing: false }).replace(/\s+/g, ' ').trim().toLowerCase()
  const att = m.attName ? 'att:' + m.kind : ''
  return `${m.ts ?? m.rawTs}|${m.sender.toLowerCase()}|${att}|${text}`
}

const CHUNK = 1500

export async function importZipCore(file: Blob, zipName: string, hooks: Hooks): Promise<ImportResult> {
  const cancelled = () => { if (hooks.isCancelled()) throw new Error('__cancelled__') }
  hooks.progress({ phase: 'read', pct: 2, msg: 'Reading ZIP…' })

  // 1. Preserve the original ZIP first, untouched.
  const zipId = await db.zips.add({ name: zipName, size: file.size, blob: file, importedAt: Date.now(), status: 'importing', convIds: [], reports: [] })
  try {
    let zip: JSZip
    try { zip = await JSZip.loadAsync(file) } catch (e) { throw new Error(`Not a readable ZIP file (${(e as Error).message}). The original file was kept so it can be investigated.`) }
    cancelled()

    const entries = Object.values(zip.files).filter(f => !f.dir && !/(^|\/)(__MACOSX|\.DS_Store)/.test(f.name) && !/(^|\/)\._/.test(f.name))
    const txtEntries = entries.filter(f => /\.txt$/i.test(f.name))
    hooks.progress({ phase: 'parse', pct: 8, msg: `Parsing ${txtEntries.length} text file(s)…` })

    const chats: { entry: JSZip.JSZipObject; parsed: ParseResult }[] = []
    const nonChatTxt = new Set<string>()
    for (const e of txtEntries) {
      const text = await e.async('string')
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
      const tss = parsed.messages.map(m => m.ts).filter((t): t is number => t !== null)
      const defaultDecision: Decision = candidates.length ? { action: 'merge', convId: candidates[0].convId, name: candidates[0].name, isGroup } : { action: 'new', name: nm, isGroup }
      return { chatFile: entry.name, name: nm, isGroup, messageCount: parsed.messages.length, firstTs: tss.length ? Math.min(...tss) : null, lastTs: tss.length ? Math.max(...tss) : null, candidates, defaultDecision }
    })
    const decisions = await hooks.decide(zipName, units)
    cancelled()

    // 3. Resolve conversations.
    const convIds: number[] = []
    const unitConv: { convId: number; merged: boolean; meName: string | null; conv: Conversation }[] = []
    for (let i = 0; i < units.length; i++) {
      const d = decisions[i] ?? units[i].defaultDecision
      const parsed = chats[i].parsed
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
    await db.zips.update(zipId, { convIds })

    // 4. Which unit references which media file? (names are matched case/space/invisible-char tolerant)
    const mediaByName = new Map<string, JSZip.JSZipObject[]>()
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
    let doneFiles = 0
    let orphan = units.map(() => 0)
    let batch: Attachment[] = [], batchKeys: string[] = [], batchBytes = 0
    const flushBatch = async () => {
      if (!batch.length) return
      const ids = await db.attachments.bulkAdd(batch, { allKeys: true })
      ids.forEach((id, i) => attIdByEntry.set(batchKeys[i], id as number))
      batch = []; batchKeys = []; batchBytes = 0
    }
    for (const e of mediaEntries) {
      cancelled()
      const ui = refUnit.get(e.name) ?? 0
      const isOrphan = !refUnit.has(e.name)
      if (isOrphan) orphan[ui]++
      const blob = await e.async('blob')
      const nm = baseName(e.name)
      const mimeBlob = new Blob([blob], { type: mimeOf(nm) })
      batch.push({ convId: unitConv[ui].convId, zipId, name: nm, path: e.name, mime: mimeOf(nm), size: mimeBlob.size, kind: extKind(nm), blob: mimeBlob, orphan: isOrphan || undefined, ts: refTs.get(e.name) ?? null })
      batchKeys.push(e.name); batchBytes += mimeBlob.size
      if (batch.length >= 25 || batchBytes > 40 * 1024 * 1024) await flushBatch()
      doneFiles++
      hooks.progress({ phase: 'media', pct: 15 + Math.round((doneFiles / Math.max(1, mediaEntries.length)) * 55), msg: `Saving media ${doneFiles}/${mediaEntries.length}` })
    }
    await flushBatch()
    cancelled()

    // 6. Messages.
    const reports: ImportReport[] = []
    let totalMsgs = chats.reduce((a, c) => a + c.parsed.messages.length, 0), doneMsgs = 0
    for (let ui = 0; ui < units.length; ui++) {
      const { parsed, entry } = chats[ui]
      const { convId, merged, meName } = unitConv[ui]
      const base = ((await db.messages.where('convId').equals(convId).reverse().sortBy('seq'))[0]?.seq ?? -1) + 1
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
          zipId, srcFile: entry.name, lineNo: m.lineNo, raw: m.raw, flagged: m.flagged, dupKey: ''
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
        hooks.progress({ phase: 'messages', pct: 70 + Math.round((doneMsgs / Math.max(1, totalMsgs)) * 27), msg: `Saving messages ${doneMsgs.toLocaleString()}/${totalMsgs.toLocaleString()}` })
      }
      await recomputeConversation(convId)
      const tss = parsed.messages.map(m => m.ts).filter((t): t is number => t !== null)
      const warnings = warningsPer[ui]
      if (!meName && !unitConv[ui].conv.isGroup) warnings.push('Could not tell which sender is you — set “My name” in Contact info so outgoing messages appear on the right.')
      if (!meName && unitConv[ui].conv.isGroup) warnings.push('Set “My name” in Settings or Contact info so your messages appear as outgoing.')
      if (refCount[ui].missing) warnings.push(`${refCount[ui].missing} attachment(s) referenced in the chat were not found in the ZIP.`)
      if (refCount[ui].omitted) warnings.push(`${refCount[ui].omitted} attachment(s) were exported “without media” by WhatsApp and cannot be recovered from this ZIP.`)
      if (nonChatTxt.size) warnings.push(`${nonChatTxt.size} other .txt file(s) kept as documents.`)
      reports.push({
        zipName, conversation: unitConv[ui].conv.name, conversationId: convId, mergedIntoExisting: merged, chatFiles: [entry.name],
        parsed: parsed.messages.length, outgoing: out, incoming: inn, system: sys,
        mediaRefs: refCount[ui].refs + refCount[ui].omitted, matched: refCount[ui].matched, missing: refCount[ui].missing, omittedByWhatsApp: refCount[ui].omitted,
        orphanFiles: orphan[ui], unparsedLines: parsed.messages.filter(m => m.kind === 'unparsed').length, flaggedTimestamps: flaggedTs,
        firstTs: tss.length ? Math.min(...tss) : null, lastTs: tss.length ? Math.max(...tss) : null,
        dupCandidates: dupCount, dateOrder: parsed.dateOrder.toUpperCase() + (parsed.dateOrderAmbiguous ? ' (assumed)' : ''), format: parsed.format,
        warnings, missingNames: refCount[ui].missingNames
      })
    }

    const hasIssues = reports.some(r => r.missing || r.unparsedLines || r.flaggedTimestamps || r.dupCandidates || r.omittedByWhatsApp || r.warnings.length)
    const status: ZipRecord['status'] = hasIssues ? 'done_with_warnings' : 'done'
    await db.zips.update(zipId, { status, reports, convIds })
    await log(hasIssues ? 'warn' : 'info', `Imported ${zipName}: ${reports.map(r => `${r.conversation} (${r.parsed} msgs)`).join(', ')}`, zipId)
    hooks.progress({ phase: 'done', pct: 100, msg: 'Done' })
    return { zipId, status, reports, convIds }
  } catch (e) {
    const msg = (e as Error).message
    if (msg === '__cancelled__') { await rollbackZip(zipId, 'cancelled'); throw e }
    await rollbackZip(zipId, 'failed', msg)
    throw e
  }
}

export { previewOf }
