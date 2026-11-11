import { openZip, type ZipEntry } from './zipReader'

/**
 * Split one big ZIP into N smaller ZIPs without loading it into memory (desktop Chrome/Edge).
 * Part 1 gets every .txt (the chat) plus its share of media; the other parts hold only media.
 * Entries are copied one at a time as a stream; output is an uncompressed (STORE) ZIP written with data descriptors,
 * ZIP64 only where needed, so each part opens in Windows Explorer / 7-Zip and in Memora.
 */
export interface Sink { write(chunk: Uint8Array): Promise<void>; close(): Promise<void> }

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
const crcUpdate = (crc: number, buf: Uint8Array) => { let c = crc; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return c >>> 0 }

interface Rec { name: Uint8Array; crc: number; size: number; offset: number; z64: boolean; dosTime: number; dosDate: number }
const U32 = 0xffffffff
const dos = (d: Date) => ({ time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() })

class ZipWriter {
  private recs: Rec[] = []
  private pos = 0
  constructor(private sink: Sink) {}
  private async out(b: Uint8Array) { await this.sink.write(b); this.pos += b.length }
  async add(name: string, size: number, stream: ReadableStream<Uint8Array>) {
    const nb = new TextEncoder().encode(name)
    const z64 = size >= U32
    const { time, date } = dos(new Date())
    const extra = z64 ? new Uint8Array(20) : new Uint8Array(0)
    const h = new DataView(new ArrayBuffer(30))
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, z64 ? 45 : 20, true); h.setUint16(6, 0x0808, true); h.setUint16(8, 0, true)
    h.setUint16(10, time, true); h.setUint16(12, date, true); h.setUint32(14, 0, true)
    h.setUint32(18, z64 ? U32 : 0, true); h.setUint32(22, z64 ? U32 : 0, true); h.setUint16(26, nb.length, true); h.setUint16(28, extra.length, true)
    if (z64) { const e = new DataView(extra.buffer); e.setUint16(0, 1, true); e.setUint16(2, 16, true) }
    const offset = this.pos
    await this.out(new Uint8Array(h.buffer)); await this.out(nb); if (extra.length) await this.out(extra)
    let crc = U32, n = 0
    const rd = stream.getReader()
    for (;;) { const { done, value } = await rd.read(); if (done) break; crc = crcUpdate(crc, value); n += value.length; await this.out(value) }
    crc = (crc ^ U32) >>> 0
    const d = new DataView(new ArrayBuffer(z64 ? 24 : 16))
    d.setUint32(0, 0x08074b50, true); d.setUint32(4, crc, true)
    if (z64) { d.setBigUint64(8, BigInt(n), true); d.setBigUint64(16, BigInt(n), true) } else { d.setUint32(8, n, true); d.setUint32(12, n, true) }
    await this.out(new Uint8Array(d.buffer))
    this.recs.push({ name: nb, crc, size: n, offset, z64: z64 || n >= U32, dosTime: time, dosDate: date })
  }
  async finish() {
    const cdStart = this.pos
    for (const r of this.recs) {
      const big = r.size >= U32, bigOff = r.offset >= U32
      const ex: number[] = []; if (big) ex.push(r.size, r.size); if (bigOff) ex.push(r.offset)
      const extra = new DataView(new ArrayBuffer(ex.length ? 4 + ex.length * 8 : 0))
      if (ex.length) { extra.setUint16(0, 1, true); extra.setUint16(2, ex.length * 8, true); ex.forEach((v, i) => extra.setBigUint64(4 + i * 8, BigInt(v), true)) }
      const c = new DataView(new ArrayBuffer(46))
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 45, true); c.setUint16(6, ex.length ? 45 : 20, true); c.setUint16(8, 0x0808, true); c.setUint16(10, 0, true)
      c.setUint16(12, r.dosTime, true); c.setUint16(14, r.dosDate, true); c.setUint32(16, r.crc, true)
      c.setUint32(20, big ? U32 : r.size, true); c.setUint32(24, big ? U32 : r.size, true); c.setUint16(28, r.name.length, true); c.setUint16(30, extra.byteLength, true)
      c.setUint32(42, bigOff ? U32 : r.offset, true)
      await this.out(new Uint8Array(c.buffer)); await this.out(r.name); if (extra.byteLength) await this.out(new Uint8Array(extra.buffer))
    }
    const cdSize = this.pos - cdStart, n = this.recs.length
    const need64 = n >= 0xffff || cdStart >= U32 || cdSize >= U32 || this.recs.some(r => r.z64 || r.offset >= U32)
    if (need64) {
      const z = new DataView(new ArrayBuffer(56 + 20))
      z.setUint32(0, 0x06064b50, true); z.setBigUint64(4, 44n, true); z.setUint16(12, 45, true); z.setUint16(14, 45, true)
      z.setBigUint64(24, BigInt(n), true); z.setBigUint64(32, BigInt(n), true); z.setBigUint64(40, BigInt(cdSize), true); z.setBigUint64(48, BigInt(cdStart), true)
      z.setUint32(56, 0x07064b50, true); z.setBigUint64(64, BigInt(this.pos), true); z.setUint32(72, 1, true)
      await this.out(new Uint8Array(z.buffer))
    }
    const e = new DataView(new ArrayBuffer(22))
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, need64 ? 0xffff : n, true); e.setUint16(10, need64 ? 0xffff : n, true)
    e.setUint32(12, need64 ? U32 : cdSize, true); e.setUint32(16, need64 ? U32 : cdStart, true)
    await this.out(new Uint8Array(e.buffer))
    await this.sink.close()
  }
}

export interface SplitPlan { parts: ZipEntry[][]; bytes: number[] }
export function planSplit(entries: ZipEntry[], n: number): SplitPlan {
  const files = entries.filter(e => !e.dir && !/(^|\/)(__MACOSX|\.DS_Store)/.test(e.name) && !/(^|\/)\._/.test(e.name))
  const txt = files.filter(e => /\.txt$/i.test(e.name)), media = files.filter(e => !/\.txt$/i.test(e.name))
  const total = media.reduce((a, e) => a + e.size, 0)
  const target = total / Math.max(1, n)
  const parts: ZipEntry[][] = [txt.slice()]; let cur = 0, acc = 0
  for (const e of media) {
    if (acc >= target && cur < n - 1) { parts.push([]); cur++; acc = 0 }
    if (cur === 0 && !parts[0].length) { /* keep */ }
    parts[cur].push(e); acc += e.size
  }
  const kept = parts.filter(p => p.length)
  return { parts: kept, bytes: kept.map(p => p.reduce((a, e) => a + e.size, 0)) }
}

export async function splitZip(file: Blob, baseName: string, n: number, openSink: (fileName: string) => Promise<Sink>, onProgress: (pct: number, msg: string) => void = () => {}): Promise<string[]> {
  const entries = await openZip(file)
  const plan = planSplit(entries, n)
  const total = plan.bytes.reduce((a, b) => a + b, 0) || 1
  const names: string[] = []; let done = 0
  for (let i = 0; i < plan.parts.length; i++) {
    const fname = `${baseName} - part ${i + 1} of ${plan.parts.length}.zip`
    const w = new ZipWriter(await openSink(fname))
    for (const e of plan.parts[i]) {
      onProgress(Math.round((done / total) * 100), `Part ${i + 1}/${plan.parts.length}: ${e.name.split('/').pop()}`)
      await w.add(e.name, e.size, (await e.blob()).stream() as ReadableStream<Uint8Array>)
      done += e.size
    }
    await w.finish(); names.push(fname)
  }
  onProgress(100, 'Done')
  return names
}
