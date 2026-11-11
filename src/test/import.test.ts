import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import JSZip from 'jszip'
import { db } from '../lib/db'
import { importZipCore, type Hooks } from '../lib/importCore'

const hooks = (over: Partial<Hooks> = {}): Hooks => ({ progress() {}, decide: async (_n, u) => u.map(x => x.defaultDecision), isCancelled: () => false, ...over })
const mk = async (files: Record<string, string | Uint8Array>) => { const z = new JSZip(); for (const [k, v] of Object.entries(files)) z.file(k, v); return z.generateAsync({ type: 'blob' }) }
const chat = (lines: string[]) => lines.join('\n')

beforeEach(async () => { await db.delete(); await db.open() })

describe('import engine', () => {
  it('imports android zip with nested media, matches attachments, reports missing', async () => {
    const zip = await mk({
      'Media/chat.txt': chat(['12/03/2022, 8:14 pm - Aditi: hi', '12/03/2022, 8:15 pm - Me: IMG-1.jpg (file attached)', '12/03/2022, 8:16 pm - Aditi: GONE.pdf (file attached)', '12/03/2022, 8:17 pm - Me: <Media omitted>']),
      'Media/IMG-1.jpg': new Uint8Array([1, 2, 3]), 'Media/extra.png': new Uint8Array([9])
    })
    const r = await importZipCore(zip, 'WhatsApp Chat with Aditi.zip', hooks())
    const rep = r.reports[0]
    expect(rep).toMatchObject({ conversation: 'Aditi', parsed: 4, matched: 1, missing: 1, omittedByWhatsApp: 1, orphanFiles: 1, outgoing: 2, incoming: 2 })
    expect(r.status).toBe('done_with_warnings')
    const msgs = (await db.messages.toArray()).sort((a, b) => a.seq - b.seq)
    expect(msgs[1].attId).toBeTruthy(); expect(msgs[2].attMissing).toBe(true)
    expect(await db.attachments.count()).toBe(2)
    expect((await db.zips.get(r.zipId))!.blob.size).toBe(zip.size)   // original preserved
  })
  it('merges overlapping export, flags duplicates, never deletes', async () => {
    const a = await mk({ 'chat.txt': chat(['01/01/2023, 10:00 am - Aditi: one', '01/01/2023, 10:01 am - Me: two']) })
    const b = await mk({ 'chat.txt': chat(['01/01/2023, 10:01 am - Me: two', '01/01/2023, 10:02 am - Aditi: three']) })
    await importZipCore(a, 'Aditi.zip', hooks())
    const r = await importZipCore(b, 'Aditi_2.zip', hooks())
    expect(r.reports[0].mergedIntoExisting).toBe(true); expect(r.reports[0].dupCandidates).toBe(1)
    expect(await db.conversations.count()).toBe(1)
    const msgs = (await db.messages.toArray()).sort((x, y) => x.sortTs - y.sortTs || x.seq - y.seq)
    expect(msgs).toHaveLength(4); expect(msgs.map(m => m.body)).toContain('three')
    expect(msgs.filter(m => m.dupState === 'pending')).toHaveLength(1)
  })
  it('different contacts are never merged', async () => {
    await importZipCore(await mk({ 'chat.txt': '01/01/2023, 10:00 am - Aditi: x' }), 'Aditi.zip', hooks())
    await importZipCore(await mk({ 'chat.txt': '01/01/2023, 10:00 am - Rahul: x' }), 'Rahul.zip', hooks())
    expect(await db.conversations.count()).toBe(2)
  })
  it('group detection', async () => {
    const r = await importZipCore(await mk({ 'chat.txt': chat(['01/01/2023, 10:00 am - A: x', '01/01/2023, 10:01 am - B: y', '01/01/2023, 10:02 am - C: z']) }), 'Family Group.zip', hooks())
    expect((await db.conversations.get(r.convIds[0]))!.isGroup).toBe(true)
  })
  it('cancel rolls back everything', async () => {
    let n = 0
    const z = await mk({ 'chat.txt': '01/01/2023, 10:00 am - Aditi: x\n01/01/2023, 10:00 am - Me: IMG.jpg (file attached)', 'IMG.jpg': new Uint8Array([1]) })
    await expect(importZipCore(z, 'Aditi.zip', hooks({ isCancelled: () => ++n > 3 }))).rejects.toThrow()
    expect(await db.messages.count()).toBe(0); expect(await db.conversations.count()).toBe(0); expect(await db.attachments.count()).toBe(0)
    expect((await db.zips.toArray())[0].status).toBe('cancelled')
  })
  it('unrecognised zip fails loudly but is preserved', async () => {
    await expect(importZipCore(await mk({ 'notes.txt': 'nothing here' }), 'weird.zip', hooks())).rejects.toThrow(/No WhatsApp chat/)
    const z = (await db.zips.toArray())[0]; expect(z.status).toBe('failed'); expect(z.blob.size).toBeGreaterThan(0)
  })
  it('large chat (20k messages) imports and keeps order', async () => {
    const lines: string[] = []
    for (let i = 0; i < 20000; i++) lines.push(`${String(1 + (i % 28)).padStart(2, '0')}/0${1 + Math.floor(i / 3000) % 9}/2022, 10:${String(i % 60).padStart(2, '0')} am - ${i % 2 ? 'Me' : 'Aditi'}: message ${i}`)
    const r = await importZipCore(await mk({ 'chat.txt': lines.join('\n') }), 'Big.zip', hooks())
    expect(r.reports[0].parsed).toBe(20000)
    const first = await db.messages.where('convId').equals(r.convIds[0]).sortBy('seq')
    expect(first.map(m => m.body).slice(0, 3)).toEqual(['message 0', 'message 1', 'message 2'])
  })
})

import { vi } from 'vitest'
describe('storage failures (iOS Safari IndexedDB blob errors)', () => {
  it('retries, then skips only the file the browser refuses, reports it, and finishes the import', async () => {
    const z = await mk({ 'chat.txt': chat(['12/03/2022, 8:14 pm - Aditi: hi', '12/03/2022, 8:15 pm - Me: GOOD.jpg (file attached)', '12/03/2022, 8:16 pm - Me: BAD.jpg (file attached)']), 'GOOD.jpg': new Uint8Array([1, 2]), 'BAD.jpg': new Uint8Array([3, 4]) })
    const realAdd = db.attachments.add.bind(db.attachments), realBulk = db.attachments.bulkAdd.bind(db.attachments)
    vi.spyOn(db.attachments, 'bulkAdd').mockImplementation((async (items: any, o: any) => { if (items.some((i: any) => i.name === 'BAD.jpg')) throw new Error('UnknownError: Attempt to generate key in database without an in-progress transaction'); return realBulk(items, o) }) as any)
    vi.spyOn(db.attachments, 'add').mockImplementation((async (a: any) => { if (a.name === 'BAD.jpg') throw new Error('UnknownError'); return realAdd(a) }) as any)
    const r = await importZipCore(z, 'Aditi.zip', hooks())
    vi.restoreAllMocks()
    expect(r.reports[0].storageFailed).toEqual(['BAD.jpg'])
    expect(r.status).toBe('done_with_warnings')
    const msgs = (await db.messages.toArray()).sort((a, b) => a.seq - b.seq)
    expect(msgs[1].attId).toBeTruthy(); expect(msgs[2].attId).toBeUndefined(); expect(msgs[2].attMissing).toBe(true)   // message kept, flagged unavailable
    expect(await db.attachments.count()).toBe(1)
  })
})
