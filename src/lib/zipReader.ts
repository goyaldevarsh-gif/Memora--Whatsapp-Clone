import { inflateSync } from 'fflate'

/**
 * Streaming ZIP reader. Never loads the whole archive: it reads only the central directory
 * (via Blob.slice) and then each entry's bytes on demand. Handles ZIP64 (>4 GB / >65k files),
 * STORE (lazy blob slice, zero copy) and DEFLATE (DecompressionStream, fflate fallback).
 * This is what lets multi-GB WhatsApp exports import on a phone.
 */
export interface ZipEntry {
  name: string
  size: number            // uncompressed
  csize: number
  method: number
  dir: boolean
  text(): Promise<string>
  blob(): Promise<Blob>
}

const u16 = (d: DataView, o: number) => d.getUint16(o, true)
const u32 = (d: DataView, o: number) => d.getUint32(o, true)
const u64 = (d: DataView, o: number) => Number(d.getBigUint64(o, true))
const buf = async (b: Blob) => new DataView(await b.arrayBuffer())

async function inflateBlob(slice: Blob): Promise<Blob> {
  if (typeof DecompressionStream !== 'undefined') {
    try { return await new Response(slice.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob() } catch { /* fall through */ }
  }
  return new Blob([inflateSync(new Uint8Array(await slice.arrayBuffer())) as BlobPart])
}

export async function openZip(file: Blob): Promise<ZipEntry[]> {
  const size = file.size
  if (size < 22) throw new Error('File is too small to be a ZIP archive')
  // 1. End Of Central Directory (within the last 64 KB + 22 bytes)
  const tailLen = Math.min(size, 65557)
  const tail = await buf(file.slice(size - tailLen))
  let eocd = -1
  for (let i = tailLen - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) throw new Error('ZIP end-of-central-directory not found (file truncated or not a ZIP)')
  let total = u16(tail, eocd + 10), cdSize = u32(tail, eocd + 12), cdOff = u32(tail, eocd + 16)
  if (total === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
    const locAt = eocd - 20
    if (locAt < 0 || u32(tail, locAt) !== 0x07064b50) throw new Error('ZIP64 locator missing')
    const z64Off = u64(tail, locAt + 8)
    const z = await buf(file.slice(z64Off, z64Off + 56))
    if (u32(z, 0) !== 0x06064b50) throw new Error('ZIP64 end record missing')
    total = u64(z, 32); cdSize = u64(z, 40); cdOff = u64(z, 48)
  }
  // 2. Central directory
  const cd = await buf(file.slice(cdOff, cdOff + cdSize))
  const dec = new TextDecoder('utf-8')
  const out: ZipEntry[] = []
  let p = 0
  for (let n = 0; n < total && p + 46 <= cd.byteLength; n++) {
    if (u32(cd, p) !== 0x02014b50) throw new Error('ZIP central directory is corrupted')
    const flags = u16(cd, p + 8), method = u16(cd, p + 10)
    let csize = u32(cd, p + 20), usize = u32(cd, p + 24)
    const nameLen = u16(cd, p + 28), extraLen = u16(cd, p + 30), commentLen = u16(cd, p + 32)
    let lho = u32(cd, p + 42)
    const name = dec.decode(new Uint8Array(cd.buffer, p + 46, nameLen))
    // ZIP64 extra field (0x0001): values appear only for fields that are 0xFFFFFFFF, in this order
    let e = p + 46 + nameLen; const eEnd = e + extraLen
    while (e + 4 <= eEnd) {
      const id = u16(cd, e), len = u16(cd, e + 2)
      if (id === 0x0001) {
        let q = e + 4
        if (usize === 0xffffffff) { usize = u64(cd, q); q += 8 }
        if (csize === 0xffffffff) { csize = u64(cd, q); q += 8 }
        if (lho === 0xffffffff) { lho = u64(cd, q); q += 8 }
      }
      e += 4 + len
    }
    p += 46 + nameLen + extraLen + commentLen
    if (flags & 1) throw new Error(`"${name}" is password-protected; encrypted ZIPs are not supported`)
    const dir = name.endsWith('/')
    const slicePayload = async (): Promise<Blob> => {
      const lh = await buf(file.slice(lho, lho + 30))
      if (u32(lh, 0) !== 0x04034b50) throw new Error(`Corrupted local header for "${name}"`)
      const start = lho + 30 + u16(lh, 26) + u16(lh, 28)
      return file.slice(start, start + csize)
    }
    const entry: ZipEntry = {
      name, size: usize, csize, method, dir,
      async blob() {
        const raw = await slicePayload()
        if (method === 0) return raw
        if (method === 8) return inflateBlob(raw)
        throw new Error(`"${name}" uses unsupported compression method ${method}`)
      },
      async text() { return (await entry.blob()).text() }
    }
    out.push(entry)
  }
  return out
}
