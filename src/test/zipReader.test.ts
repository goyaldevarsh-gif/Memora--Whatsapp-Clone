import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { openZip } from '../lib/zipReader'

describe('streaming zip reader', () => {
  it('reads STORE and DEFLATE entries, nested dirs, unicode names', async () => {
    const z = new JSZip()
    z.file('chat.txt', 'hello '.repeat(5000), { compression: 'DEFLATE' })
    z.file('Media/सुचि 1.jpg', new Uint8Array([1, 2, 3, 4, 5]), { compression: 'STORE' })
    z.file('Media/deep/a b.pdf', new Uint8Array(100000).fill(7), { compression: 'DEFLATE' })
    const blob = await z.generateAsync({ type: 'blob' })
    const entries = await openZip(blob)
    const byName = Object.fromEntries(entries.filter(e => !e.dir).map(e => [e.name, e]))
    expect(Object.keys(byName).sort()).toEqual(['Media/deep/a b.pdf', 'Media/सुचि 1.jpg', 'chat.txt'])
    expect(await byName['chat.txt'].text()).toBe('hello '.repeat(5000))
    expect([...new Uint8Array(await (await byName['Media/सुचि 1.jpg'].blob()).arrayBuffer())]).toEqual([1, 2, 3, 4, 5])
    const pdf = await byName['Media/deep/a b.pdf'].blob(); expect(pdf.size).toBe(100000)
  })
  it('rejects non-zip input with a clear error', async () => {
    await expect(openZip(new Blob(['definitely not a zip file at all, just text padding'.repeat(3)]))).rejects.toThrow(/ZIP/)
  })
})
