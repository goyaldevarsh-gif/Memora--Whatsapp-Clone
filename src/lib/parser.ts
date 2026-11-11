import type { MsgKind } from './types'

export interface ParsedMessage {
  idx: number
  lineNo: number
  rawTs: string
  ts: number | null
  sender: string          // '' => system
  body: string
  kind: MsgKind
  attName?: string
  attMissing?: boolean
  raw: string
  flagged?: string
}

export interface ParseResult {
  messages: ParsedMessage[]
  format: 'android' | 'ios' | 'mixed' | 'unknown'
  dateOrder: 'dmy' | 'mdy' | 'ymd'
  dateOrderAmbiguous: boolean
  senders: string[]
  warnings: string[]
  totalLines: number
  headerLines: number
}

// Invisible direction marks / narrow no-break spaces that WhatsApp sprinkles everywhere.
const INVIS = /[‎‏‪-‮⁦-⁩﻿]/g
const norm = (s: string) => s.replace(INVIS, '').replace(/[   ]/g, ' ')

const DATE = String.raw`(\d{1,4}[\/.\-]\d{1,2}[\/.\-]\d{1,4})`
const TIME = String.raw`(\d{1,2}[:.]\d{2}(?:[:.]\d{2})?)\s*([APap]\.?\s?[Mm]\.?)?`
const ANDROID = new RegExp(String.raw`^${DATE}[,\s]+${TIME}\s+[-–—]\s+(.*)$`)
const IOS = new RegExp(String.raw`^\[${DATE}[,\s]+${TIME}\]\s+(.*)$`)

const SYSTEM_PHRASES = [
  /end-to-end encrypted/i,
  /\b(created group|created this group|changed the subject|changed this group's|changed the group|changed their phone number|changed the group description|added|removed|left|joined using|is now an admin|were added|security code changed|turned on disappearing|turned off disappearing|pinned a message|started a call|joined)\b/i
]

const OMITTED = /^(<media omitted>|image omitted|video omitted|audio omitted|sticker omitted|gif omitted|document omitted|contact card omitted|voice message omitted|<attachment omitted>)$/i

export function extKind(name: string): MsgKind {
  const n = name.toLowerCase()
  const ext = n.split('.').pop() ?? ''
  if (/^stk-|sticker/.test(n) && ext === 'webp') return 'sticker'
  if (['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'bmp', 'tiff'].includes(ext)) return 'image'
  if (ext === 'gif') return 'gif'
  if (['mp4', 'mov', '3gp', 'mkv', 'webm', 'avi', 'm4v'].includes(ext)) return /gif/i.test(n) ? 'gif' : 'video'
  if (['opus', 'ogg', 'mp3', 'm4a', 'wav', 'aac', 'amr', 'caf'].includes(ext)) {
    if (/^aud-/.test(n)) return 'audio'
    if (/^ptt-|-audio-|^audio-/.test(n) || ext === 'opus') return 'voice'
    return 'audio'
  }
  if (ext === 'vcf') return 'contact'
  return 'document'
}

function monthLen(y: number, m: number) { return new Date(Date.UTC(y, m, 0)).getUTCDate() }

function parseTime(t: string, ampm?: string): { h: number; mi: number; s: number } | null {
  const parts = t.split(/[:.]/).map(Number)
  let [h, mi, s] = [parts[0], parts[1], parts[2] ?? 0]
  if (ampm) {
    const pm = /p/i.test(ampm)
    if (h < 1 || h > 12) return null
    if (pm && h < 12) h += 12
    if (!pm && h === 12) h = 0
  }
  if (h > 23 || mi > 59 || s > 59) return null
  return { h, mi, s }
}

function toTs(y: number, mo: number, d: number, tm: { h: number; mi: number; s: number } | null): number | null {
  if (!tm) return null
  if (y < 100) y += y < 70 ? 2000 : 1900
  if (mo < 1 || mo > 12 || d < 1 || d > monthLen(y, mo)) return null
  return Date.UTC(y, mo - 1, d, tm.h, tm.mi, tm.s)
}

interface Header { date: string; time: string; ampm?: string; rest: string; style: 'android' | 'ios' }

function matchHeader(line: string): Header | null {
  const l = norm(line)
  let m = ANDROID.exec(l)
  if (m) return { date: m[1], time: m[2], ampm: m[3], rest: m[4], style: 'android' }
  m = IOS.exec(l)
  if (m) return { date: m[1], time: m[2], ampm: m[3], rest: m[4], style: 'ios' }
  return null
}

function splitDate(d: string): number[] { return d.split(/[\/.\-]/).map(Number) }

function detectDateOrder(dates: string[]): { order: 'dmy' | 'mdy' | 'ymd'; ambiguous: boolean } {
  const parts = dates.map(splitDate)
  if (parts.length && dates[0].split(/[\/.\-]/)[0].length === 4) return { order: 'ymd', ambiguous: false }
  let aOver = false, bOver = false
  for (const [a, b] of parts) { if (a > 12) aOver = true; if (b > 12) bOver = true }
  if (aOver && !bOver) return { order: 'dmy', ambiguous: false }
  if (bOver && !aOver) return { order: 'mdy', ambiguous: false }
  // Ambiguous by values: exports are chronological, so pick the reading with fewer backwards jumps.
  const viol = (order: 'dmy' | 'mdy') => {
    let v = 0, prev = -Infinity
    for (const [a, b, c] of parts) {
      const dd = order === 'dmy' ? a : b, mm = order === 'dmy' ? b : a
      const yy = c < 100 ? c + 2000 : c
      const key = yy * 10000 + mm * 100 + dd
      if (key < prev) v++
      prev = key
    }
    return v
  }
  const vd = viol('dmy'), vm = viol('mdy')
  if (vd < vm) return { order: 'dmy', ambiguous: false }
  if (vm < vd) return { order: 'mdy', ambiguous: false }
  return { order: 'dmy', ambiguous: true }
}

function resolveTs(h: Header, order: 'dmy' | 'mdy' | 'ymd'): number | null {
  const p = splitDate(h.date)
  const tm = parseTime(h.time, h.ampm)
  if (order === 'ymd') return toTs(p[0], p[1], p[2], tm)
  if (order === 'dmy') return toTs(p[2], p[1], p[0], tm)
  return toTs(p[2], p[0], p[1], tm)
}

function looksSystem(rest: string, colonIdx: number): boolean {
  if (colonIdx < 0) return true
  const head = rest.slice(0, colonIdx)
  // "Aditi changed the subject to "Trip: 2022"" -> colon is inside quoted text, head holds the verb phrase
  return SYSTEM_PHRASES[1].test(head) && /\s(created|changed|added|removed|left|joined|pinned|turned|started)\b/i.test(head) && head.split(' ').length > 2
}

export function classify(bodyFirstLine: string): { kind: MsgKind; attName?: string; attMissing?: boolean } {
  const clean = norm(bodyFirstLine).trim()
  if (OMITTED.test(clean)) {
    const w = clean.toLowerCase()
    const kind: MsgKind = w.includes('image') ? 'image' : w.includes('video') ? 'video' : w.includes('audio') || w.includes('voice') ? 'voice'
      : w.includes('sticker') ? 'sticker' : w.includes('gif') ? 'gif' : w.includes('contact') ? 'contact' : w.includes('document') ? 'document' : 'omitted'
    return { kind, attMissing: true }
  }
  let m = /^<attached:\s*(.+?)>$/i.exec(clean)
  if (!m) m = /^(.+?)\s*\((?:file attached|bestand bijgevoegd|Datei angehängt|archivo adjunto|fichier joint|file allegato)\)$/i.exec(clean)
  // A real attachment line is *only* a filename (with extension); prose that merely ends in "(file attached)" stays text.
  if (m && /\.[A-Za-z0-9]{1,8}$/.test(m[1].trim()) && !/[\r\n]/.test(m[1]) && !/:\s/.test(m[1])) {
    const name = m[1].trim()
    return { kind: extKind(name), attName: name }
  }
  if (/^(live )?location:\s*https?:\/\//i.test(clean) || /^<?location:/i.test(clean)) return { kind: 'location' }
  if (/^(you deleted this message|this message was deleted|🚫 this message was deleted|🚫 you deleted this message)$/i.test(clean)) return { kind: 'deleted' }
  if (/^(missed (voice|video) call|voice call|video call|missed group (voice|video) call|call back|no answer)/i.test(clean)) return { kind: 'call' }
  return { kind: 'text' }
}

export function parseWhatsAppText(text: string): ParseResult {
  const lines = text.replace(/^﻿/, '').split(/\r\n|\n|\r/)
  const warnings: string[] = []

  // Pass 1: collect header dates to settle the date order for the whole file.
  const headers: (Header | null)[] = lines.map(matchHeader)
  const dates = headers.filter((h): h is Header => !!h).map(h => h.date)
  const { order, ambiguous } = detectDateOrder(dates)
  if (ambiguous) warnings.push('Date order (DD/MM vs MM/DD) could not be determined from the file; assumed DD/MM. Original timestamps are preserved on every message.')
  const styles = new Set(headers.filter((h): h is Header => !!h).map(h => h.style))
  const format = styles.size === 0 ? 'unknown' : styles.size > 1 ? 'mixed' : [...styles][0]

  const messages: ParsedMessage[] = []
  let cur: ParsedMessage | null = null
  const lead: { lineNo: number; text: string }[] = []
  const flush = () => { if (cur) { finalize(cur); messages.push(cur); cur = null } }

  lines.forEach((line, i) => {
    const h = headers[i]
    if (h) {
      flush()
      const rest = h.rest
      const colonIdx = rest.indexOf(': ')
      const isSys = looksSystem(rest, colonIdx)
      const sender = isSys ? '' : norm(rest.slice(0, colonIdx)).trim()
      const body = isSys ? rest : rest.slice(colonIdx + 2)
      const ts = resolveTs(h, order)
      cur = {
        idx: messages.length, lineNo: i + 1, rawTs: `${h.date}, ${h.time}${h.ampm ? ' ' + h.ampm : ''}`.trim(), ts,
        sender, body, kind: isSys ? 'system' : 'text', raw: line,
        flagged: ts === null ? 'Timestamp could not be parsed confidently' : undefined
      }
      return
    }
    if (cur) {
      cur.body += '\n' + line
      cur.raw += '\n' + line
    } else if (line.trim() !== '') {
      lead.push({ lineNo: i + 1, text: line })
    }
  })
  flush()

  // Unparsed leading lines are preserved as flagged raw entries instead of being dropped.
  const leadMsgs: ParsedMessage[] = lead.map((l, k) => ({
    idx: -1 - k, lineNo: l.lineNo, rawTs: '', ts: null, sender: '', body: l.text, kind: 'unparsed', raw: l.text,
    flagged: 'Line did not match any known WhatsApp message pattern'
  }))
  const all = [...leadMsgs, ...messages].map((m, i) => ({ ...m, idx: i }))
  if (lead.length) warnings.push(`${lead.length} line(s) before the first recognisable message were kept as flagged raw text.`)

  const senders = [...new Set(all.filter(m => m.sender).map(m => m.sender))]
  return { messages: all, format, dateOrder: order, dateOrderAmbiguous: ambiguous, senders, warnings, totalLines: lines.length, headerLines: dates.length }
}

function finalize(m: ParsedMessage) {
  if (m.kind === 'system' || m.kind === 'unparsed') return
  // Android puts the filename on line 1 and an optional caption on following lines.
  const first = m.body.split('\n')[0]
  const c = classify(first)
  m.kind = c.kind
  if (c.attName) m.attName = c.attName
  if (c.attMissing) m.attMissing = true
  if (c.kind === 'text' && m.body.trim() === '' ) m.kind = 'text'
}

/** Body shown to the user: caption without the attachment filename line. */
export function captionOf(m: { body: string; kind: MsgKind; attName?: string; attMissing?: boolean }): string {
  if (m.attName || m.attMissing) {
    const rest = m.body.split('\n').slice(1).join('\n')
    return norm(rest).trim() === '' ? '' : rest
  }
  return m.body
}
