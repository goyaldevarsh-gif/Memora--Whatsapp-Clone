import { db } from './db'
export interface Integrity {
  zips: number; failedImports: number; conversations: number; messages: number; mediaFiles: number
  attachmentsOk: number; attachmentsMissing: number; omittedByWhatsApp: number
  parsingErrors: number; flaggedTimestamps: number; unparsedLines: number; dupCandidates: number
  clean: boolean; mediaSuccessPct: number | null
}
export async function computeIntegrity(): Promise<Integrity> {
  const [zips, convs, mediaFiles] = await Promise.all([db.zips.toArray(), db.conversations.count(), db.attachments.count()])
  let messages = 0, ok = 0, missing = 0, omitted = 0, unparsed = 0, flaggedTs = 0, dup = 0
  await db.messages.each(m => {
    messages++
    if (m.attId) ok++
    else if (m.attMissing) { if (m.attName) missing++; else omitted++ }
    if (m.kind === "unparsed" && !m.reviewed) unparsed++
    else if (m.flagged && !m.reviewed) flaggedTs++
    if (m.dupState === 'pending') dup++
  })
  const failed = zips.filter(z => z.status === 'failed' || z.status === 'cancelled').length
  const total = ok + missing + omitted
  const clean = failed === 0 && missing === 0 && omitted === 0 && unparsed === 0 && flaggedTs === 0 && dup === 0
  return { zips: zips.length, failedImports: failed, conversations: convs, messages, mediaFiles, attachmentsOk: ok, attachmentsMissing: missing, omittedByWhatsApp: omitted,
    parsingErrors: unparsed + flaggedTs, flaggedTimestamps: flaggedTs, unparsedLines: unparsed, dupCandidates: dup, clean, mediaSuccessPct: total ? Math.floor((ok / total) * 1000) / 10 : null }
}
