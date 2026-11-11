import Dexie, { type Table } from 'dexie'
import type { Attachment, Bookmark, Conversation, LogEntry, Message, Setting, ZipRecord } from './types'

export class MemoraDB extends Dexie {
  conversations!: Table<Conversation, number>
  messages!: Table<Message, number>
  attachments!: Table<Attachment, number>
  zips!: Table<ZipRecord, number>
  bookmarks!: Table<Bookmark, number>
  logs!: Table<LogEntry, number>
  settings!: Table<Setting, string>
  searchIndex!: Table<{ key: string; msgCount: number; json: string; builtAt: number }, string>

  constructor(name = 'memora') {
    super(name)
    this.version(1).stores({
      conversations: '++id, name, lastTs, firstTs, messageCount, importedAt, favourite, archived',
      // compound index drives chronological display & pagination; others drive stats/search/review
      messages: '++id, [convId+sortTs+seq], convId, zipId, kind, ts, dupState, flagged, attId',
      attachments: '++id, convId, zipId, kind, name, messageId, [convId+kind]',
      zips: '++id, name, importedAt, status',
      bookmarks: '++id, messageId, convId, kind, createdAt',
      logs: '++id, ts, level, zipId',
      settings: 'key',
      searchIndex: 'key'
    })
  }
}

export const db = new MemoraDB()

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const r = await db.settings.get(key)
  return (r ? r.value : fallback) as T
}
export const setSetting = (key: string, value: unknown) => db.settings.put({ key, value })

export async function log(level: LogEntry['level'], msg: string, zipId?: number) {
  await db.logs.add({ ts: Date.now(), level, msg, zipId })
}

/** Recompute denormalised conversation stats from messages/attachments. */
export async function recomputeConversation(convId: number) {
  const conv = await db.conversations.get(convId)
  if (!conv) return
  const count = await db.messages.where('convId').equals(convId).count()
  if (count === 0) { return }
  const attCount = await db.attachments.where('convId').equals(convId).count()
  const first = await db.messages.where('[convId+sortTs+seq]').between([convId, -Infinity, -Infinity], [convId, Infinity, Infinity]).first()
  const lastVisible = await db.messages.where('[convId+sortTs+seq]').between([convId, -Infinity, -Infinity], [convId, Infinity, Infinity])
    .reverse().filter(m => !m.hidden && m.kind !== 'system' && m.kind !== 'unparsed').first()
  const last = lastVisible ?? await db.messages.where('[convId+sortTs+seq]').between([convId, -Infinity, -Infinity], [convId, Infinity, Infinity]).last()
  const firstTs = (await db.messages.where('[convId+sortTs+seq]').between([convId, -Infinity, -Infinity], [convId, Infinity, Infinity]).filter(m => m.ts !== null).first())?.ts ?? first?.ts ?? null
  const lastTs = (await db.messages.where('[convId+sortTs+seq]').between([convId, -Infinity, -Infinity], [convId, Infinity, Infinity]).reverse().filter(m => m.ts !== null).first())?.ts ?? last?.ts ?? null
  await db.conversations.update(convId, {
    messageCount: count, attachmentCount: attCount, firstTs, lastTs,
    lastPreview: last ? previewOf(last) : '', lastSender: last?.sender ?? '', lastKind: last?.kind ?? 'text'
  })
}

export function previewOf(m: Pick<Message, 'kind' | 'body' | 'attName'>): string {
  switch (m.kind) {
    case 'image': return '📷 Photo'
    case 'video': return '🎥 Video'
    case 'voice': return '🎤 Voice message'
    case 'audio': return '🎵 Audio'
    case 'document': return '📄 ' + (m.attName ?? 'Document')
    case 'sticker': return 'Sticker'
    case 'gif': return 'GIF'
    case 'location': return '📍 Location'
    case 'contact': return '👤 Contact'
    case 'deleted': return '🚫 This message was deleted'
    case 'call': return '📞 ' + m.body.split('\n')[0]
    default: return m.body.replace(/\s+/g, ' ').slice(0, 120)
  }
}

/** Remove everything tagged with a zipId (used for safe cancel / interrupted-import rollback). */
export async function rollbackZip(zipId: number, status: ZipRecord['status'] = 'cancelled', error?: string) {
  const zip = await db.zips.get(zipId)
  await db.transaction('rw', db.messages, db.attachments, db.conversations, db.bookmarks, async () => {
    const msgIds = await db.messages.where('zipId').equals(zipId).primaryKeys()
    await db.bookmarks.where('messageId').anyOf(msgIds).delete()
    await db.messages.where('zipId').equals(zipId).delete()
    await db.attachments.where('zipId').equals(zipId).delete()
  })
  if (zip) {
    for (const cid of zip.convIds) {
      const left = await db.messages.where('convId').equals(cid).count()
      if (left === 0) await db.conversations.delete(cid)
      else {
        const c = await db.conversations.get(cid)
        if (c) await db.conversations.update(cid, { sourceZipIds: c.sourceZipIds.filter(z => z !== zipId) })
        await recomputeConversation(cid)
      }
    }
    // a failed/cancelled multi-GB original is NOT kept inside the browser (it would waste storage); the user still has the file
    const drop = status === 'cancelled' || (zip.size > 100 * 1024 * 1024)
    await db.zips.update(zipId, { status, error, convIds: [], ...(drop ? { blob: new Blob([]), originalKept: false } : {}) })
  }
  await log('warn', `Import rolled back (${status})${error ? ': ' + error : ''}`, zipId)
}

/** Any import left in 'importing' state means the tab was closed/crashed mid-import: roll it back cleanly. */
export async function recoverInterruptedImports() {
  const stuck = await db.zips.where('status').equals('importing').toArray()
  for (const z of stuck) await rollbackZip(z.id!, 'failed', 'Import was interrupted (app closed or crashed). Nothing was partially saved; please import again.')
  return stuck.length
}
