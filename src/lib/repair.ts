import { db, getSetting, setSetting, recomputeConversation } from './db'
import { extKind } from './parser'

/**
 * One-time repair of chats imported by an older version:
 *  - iPhone lines like "Report.pdf • 1 page <attached: 0001-Report.pdf>" were stored as plain text -> turn them into real attachments
 *  - attachments whose type was stored as "document" although the file is a photo/video/audio -> correct the type
 * Nothing is deleted; only message type/links are updated.
 */
export async function repairAttachedLines(): Promise<number> {
  if (await getSetting<boolean>('repair_attached_v2', false)) return 0
  const touched = new Set<number>(); let n = 0
  const byConv = new Map<number, Map<string, number>>()
  const attIndex = async (convId: number) => {
    let m = byConv.get(convId); if (m) return m
    m = new Map(); await db.attachments.where('convId').equals(convId).each(a => { if (a.id !== undefined && !m!.has(a.name)) m!.set(a.name, a.id) }); byConv.set(convId, m); return m
  }
  const ids: number[] = []
  await db.messages.filter(m => m.kind === 'text' && !m.attName && m.body.includes('<attached:')).each(m => { ids.push(m.id!) })
  for (const id of ids) {
    const msg = await db.messages.get(id); if (!msg) continue
    const lines = msg.body.split('\n')
    const mm = /^(.*\S)?\s*<attached:\s*(.+?)>$/i.exec(lines[0].trim())
    if (!mm || !/\.[A-Za-z0-9]{1,8}$/.test(mm[2].trim())) continue
    const name = mm[2].trim()
    const attId = (await attIndex(msg.convId)).get(name)
    const caption = [mm[1] ?? '', ...lines.slice(1)].join('\n').trim()
    await db.messages.update(id, { kind: extKind(name), attName: name, attId, attMissing: attId === undefined ? true : undefined, body: `<attached: ${name}>\n${caption}` })
    if (attId !== undefined) await db.attachments.update(attId, { orphan: undefined })
    touched.add(msg.convId); n++
  }
  const wrong: { id: number; kind: ReturnType<typeof extKind>; conv: number }[] = []
  await db.messages.filter(m => !!m.attName && m.kind === 'document').each(m => { const k = extKind(m.attName!); if (k !== 'document') wrong.push({ id: m.id!, kind: k, conv: m.convId }) })
  for (const w of wrong) { await db.messages.update(w.id, { kind: w.kind }); touched.add(w.conv); n++ }
  for (const c of touched) await recomputeConversation(c)
  await setSetting('repair_attached_v2', true)
  return n
}
