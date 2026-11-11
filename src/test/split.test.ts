import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import JSZip from 'jszip'
import { db } from '../lib/db'
import { importZipCore, type Hooks } from '../lib/importCore'
import { splitZip, type Sink } from '../lib/zipSplit'

const hooks = (): Hooks => ({ progress() {}, decide: async (_n, u) => u.map(x => x.defaultDecision), isCancelled: () => false })
beforeEach(async () => { await db.delete(); await db.open() })

describe('split big zip', () => {
  it('caps each part at a maximum size', async () => {
    const z = new JSZip(); z.file('chat.txt', '12/03/2022, 8:14 pm - Aditi: hi')
    for (let i = 1; i <= 10; i++) z.file(`F${i}.bin`, new Uint8Array(1000).fill(i))
    const big = await z.generateAsync({ type: 'blob' })
    const out = new Map<string, Uint8Array[]>()
    const names = await splitZip(big, 'X', { maxBytes: 3500 }, async f => { const c: Uint8Array[] = []; out.set(f, c); return { write: async b => { c.push(b.slice()) }, close: async () => {} } })
    expect(names.length).toBe(4)                         // 3+3+3+1 files
    for (const n of names) { const zz = await JSZip.loadAsync(new Blob(out.get(n)! as BlobPart[])); const sz = (await Promise.all(Object.values(zz.files).filter(f => !f.dir && f.name.startsWith('F')).map(async f => (await f.async('uint8array')).length))).reduce((a, b) => a + b, 0); expect(sz).toBeLessThanOrEqual(3500) }
  })
  it('makes valid parts (CRC checked) and importing them in order links every attachment', async () => {
    const z = new JSZip()
    const lines = ['12/03/2022, 8:14 pm - Aditi: hi']
    for (let i = 1; i <= 6; i++) { lines.push(`12/03/2022, 8:${15 + i} pm - Me: IMG-${i}.jpg (file attached)`); z.file(`IMG-${i}.jpg`, new Uint8Array(2000).fill(i)) }
    z.file('chat.txt', lines.join('\n'))
    const big = await z.generateAsync({ type: 'blob', compression: 'DEFLATE' })
    const out = new Map<string, Uint8Array[]>()
    const open = async (fname: string): Promise<Sink> => { const chunks: Uint8Array[] = []; out.set(fname, chunks); return { write: async c => { chunks.push(c.slice()) }, close: async () => {} } }
    const names = await splitZip(big, 'WhatsApp Chat with Aditi', 3, open)
    expect(names).toHaveLength(3)
    const parts = names.map(n => new Blob(out.get(n)! as BlobPart[]))
    for (const p of parts) { const zz = await JSZip.loadAsync(p, { checkCRC32: true }); expect(Object.keys(zz.files).length).toBeGreaterThan(0) }
    expect(Object.keys((await JSZip.loadAsync(parts[0])).files)).toContain('chat.txt')
    expect(Object.keys((await JSZip.loadAsync(parts[1])).files)).not.toContain('chat.txt')
    for (let i = 0; i < parts.length; i++) await importZipCore(parts[i], names[i], hooks())
    const msgs = await db.messages.toArray()
    expect(msgs.filter(m => m.attName)).toHaveLength(6)
    expect(msgs.filter(m => m.attName && m.attId)).toHaveLength(6)       // all linked after the media-only parts
    expect(await db.attachments.count()).toBe(6)
    expect(await db.conversations.count()).toBe(1)
  })
})
