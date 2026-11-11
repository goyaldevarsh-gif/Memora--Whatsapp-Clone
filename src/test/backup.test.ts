import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import JSZip from 'jszip'
import { db } from '../lib/db'
import { importZipCore, type Hooks } from '../lib/importCore'
import { createBackup, restoreBackup, verifyBackup } from '../lib/backup'
import { computeIntegrity } from '../lib/integrity'

const hooks: Hooks = { progress() {}, decide: async (_n, u) => u.map(x => x.defaultDecision), isCancelled: () => false }
const mk = async (files: Record<string, string | Uint8Array>) => { const z = new JSZip(); for (const [k, v] of Object.entries(files)) z.file(k, v); return z.generateAsync({ type: 'blob' }) }
beforeEach(async () => { await db.delete(); await db.open() })

describe('backup / restore / integrity', () => {
  it('round-trips conversations, messages, media, zips, bookmarks; detects corruption', async () => {
    const z = await mk({ 'chat.txt': '12/03/2022, 8:14 pm - Aditi: hi\n12/03/2022, 8:15 pm - Me: IMG-1.jpg (file attached)\n12/03/2022, 8:15 pm - Me: gone.pdf (file attached)', 'IMG-1.jpg': new Uint8Array([1, 2, 3, 4]) })
    const r = await importZipCore(z, 'Aditi.zip', hooks)
    const m = (await db.messages.toArray())[1]
    await db.bookmarks.add({ messageId: m.id!, convId: r.convIds[0], kind: m.kind, note: 'important', createdAt: 1 })
    const before = await computeIntegrity()
    expect(before.clean).toBe(false)                // a missing attachment must never read as a clean import
    expect(before.attachmentsMissing).toBe(1)

    const backup = await createBackup({ includeMedia: true, includeZips: true })
    expect((await verifyBackup(backup)).ok).toBe(true)
    await db.delete(); await db.open()
    const res = await restoreBackup(backup)
    expect(res).toEqual({ conversations: 1, messages: 3 })
    const msgs = (await db.messages.toArray()).sort((a, b) => a.seq - b.seq)
    expect(msgs.map(x => x.body.split('\n')[0])).toEqual(['hi', 'IMG-1.jpg (file attached)', 'gone.pdf (file attached)'])
    const att = await db.attachments.get(msgs[1].attId!)
    expect(att!.blob.size).toBe(4)
    expect((await db.bookmarks.toArray())[0]).toMatchObject({ note: 'important', messageId: msgs[1].id })
    expect((await db.zips.toArray())[0].blob.size).toBe(z.size)
  })
  it('rejects a tampered backup and restores nothing', async () => {
    await importZipCore(await mk({ 'chat.txt': '12/03/2022, 8:14 pm - Aditi: hi' }), 'Aditi.zip', hooks)
    const backup = await createBackup({ includeMedia: true, includeZips: false })
    const zip = await JSZip.loadAsync(backup)
    const f = Object.keys(zip.files).find(n => n.startsWith('data/messages-'))!
    zip.file(f, (await zip.file(f)!.async('string')).replace('hi', 'HACKED'))
    const bad = await zip.generateAsync({ type: 'blob' })
    await db.delete(); await db.open()
    expect((await verifyBackup(bad)).ok).toBe(false)
    await expect(restoreBackup(bad)).rejects.toThrow(/verification/)
    expect(await db.conversations.count()).toBe(0)
  })
})
