import MiniSearch from 'minisearch'
import { db } from './db'
import { MONTH_NAMES } from './format'
import type { Message, Conversation, MsgKind } from './types'

type Doc = { id: number; body: string; sender: string; attName: string; convId: number; ts: number | null; kind: MsgKind }
const make = () => new MiniSearch<Doc>({
  fields: ['body', 'sender', 'attName'],
  storeFields: ['convId', 'ts', 'sender', 'kind'],
  searchOptions: { prefix: true, fuzzy: (t: string) => (t.length > 5 ? 0.15 : false), combineWith: 'AND', boost: { body: 2 } }
})
let index = make()
let ready = false
let building: Promise<void> | null = null
const listeners = new Set<() => void>()
export const searchState = { ready: false, indexed: 0, total: 0 }
const notify = () => listeners.forEach(l => l())
export const onSearchState = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }

const toDoc = (m: Message): Doc => ({ id: m.id!, body: m.kind === 'unparsed' || m.kind === 'system' || m.kind === 'text' || m.attName || true ? m.body : '', sender: m.sender, attName: m.attName ?? '', convId: m.convId, ts: m.ts, kind: m.kind })
const tick = () => new Promise<void>(r => setTimeout(r, 0))

export function ensureIndex(): Promise<void> {
  if (ready) return Promise.resolve()
  if (building) return building
  building = (async () => {
    const total = await db.messages.count()
    searchState.total = total; searchState.indexed = 0; notify()
    const cached = await db.searchIndex.get('main')
    if (cached && cached.msgCount === total) {
      try { index = MiniSearch.loadJSON(cached.json, { fields: ['body', 'sender', 'attName'], storeFields: ['convId', 'ts', 'sender', 'kind'], searchOptions: { prefix: true, fuzzy: (t: string) => (t.length > 5 ? 0.15 : false), combineWith: 'AND', boost: { body: 2 } } }); ready = true; searchState.ready = true; searchState.indexed = total; notify(); return } catch { /* rebuild */ }
    }
    index = make()
    let buf: Doc[] = []
    await db.messages.each(m => {
      if (m.hidden) return
      buf.push(toDoc(m))
    })
    for (let i = 0; i < buf.length; i += 2000) {
      index.addAll(buf.slice(i, i + 2000)); searchState.indexed = Math.min(buf.length, i + 2000); notify(); await tick()
    }
    buf = []
    ready = true; searchState.ready = true; notify()
    saveIndex(total)
  })().finally(() => { building = null })
  return building
}

async function saveIndex(total: number) {
  try { await db.searchIndex.put({ key: 'main', msgCount: total, json: JSON.stringify(index), builtAt: Date.now() }) } catch { /* quota: index is rebuildable */ }
}

export async function invalidateIndex() { ready = false; searchState.ready = false; await db.searchIndex.clear(); index = make(); notify() }

export async function indexZip(zipId: number) {
  if (!ready) { await invalidateIndex(); return ensureIndex() }
  const docs: Doc[] = []
  await db.messages.where('zipId').equals(zipId).each(m => { docs.push(toDoc(m)) })
  for (let i = 0; i < docs.length; i += 2000) { index.addAll(docs.slice(i, i + 2000)); await tick() }
  saveIndex(await db.messages.count())
}

export function removeFromIndex(id: number) { try { index.discard(id) } catch { /* not indexed */ } }

export interface SearchFilters { convId?: number; sender?: string; from?: number | null; to?: number | null; type?: 'all' | 'media' | 'docs' | 'bookmarked'; sort?: 'relevance' | 'newest' | 'oldest' }
export interface SearchHit { message: Message; conv: Conversation | undefined; score: number }
export interface SearchOutput { hits: SearchHit[]; contacts: Conversation[]; total: number; dateRange?: { from: number; to: number; label: string } }

/** "January 2023", "12 March 2022", "2023-01", "2023" -> range (naive-UTC ms) + remaining query text. */
export function parseDateQuery(q: string): { from: number; to: number; label: string; rest: string } | null {
  const mon = '(' + MONTH_NAMES.map(m => m.slice(0, 3) + '[a-z]*').join('|') + ')'
  const mi = (s: string) => MONTH_NAMES.findIndex(m => m.toLowerCase().startsWith(s.slice(0, 3).toLowerCase()))
  let m: RegExpExecArray | null
  const cut = (x: RegExpExecArray) => (q.slice(0, x.index) + ' ' + q.slice(x.index + x[0].length)).replace(/\s+/g, ' ').trim()
  if ((m = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${mon}\\s+(\\d{4})\\b`, 'i').exec(q))) { const d = +m[1], mo = mi(m[2]), y = +m[3]; return { from: Date.UTC(y, mo, d), to: Date.UTC(y, mo, d + 1) - 1, label: `${d} ${MONTH_NAMES[mo]} ${y}`, rest: cut(m) } }
  if ((m = new RegExp(`\\b${mon}\\s+(\\d{4})\\b`, 'i').exec(q))) { const mo = mi(m[1]), y = +m[2]; return { from: Date.UTC(y, mo, 1), to: Date.UTC(y, mo + 1, 1) - 1, label: `${MONTH_NAMES[mo]} ${y}`, rest: cut(m) } }
  if ((m = /\b(\d{4})-(\d{2})(?:-(\d{2}))?\b/.exec(q))) { const y = +m[1], mo = +m[2] - 1; if (m[3]) { const d = +m[3]; return { from: Date.UTC(y, mo, d), to: Date.UTC(y, mo, d + 1) - 1, label: `${d} ${MONTH_NAMES[mo]} ${y}`, rest: cut(m) } } return { from: Date.UTC(y, mo, 1), to: Date.UTC(y, mo + 1, 1) - 1, label: `${MONTH_NAMES[mo]} ${y}`, rest: cut(m) } }
  if ((m = /^\s*((?:19|20)\d{2})\s*$/.exec(q))) { const y = +m[1]; return { from: Date.UTC(y, 0, 1), to: Date.UTC(y + 1, 0, 1) - 1, label: String(y), rest: '' } }
  return null
}

export async function runSearch(rawQuery: string, f: SearchFilters = {}, limit = 300): Promise<SearchOutput> {
  await ensureIndex()
  let q = rawQuery.trim()
  const phrases: string[] = []
  q = q.replace(/"([^"]+)"/g, (_, p) => { phrases.push(p.toLowerCase()); return ' ' + p + ' ' })
  const dq = parseDateQuery(q)
  let from = f.from ?? null, to = f.to ?? null
  let dateRange: SearchOutput['dateRange']
  if (dq) { from = dq.from; to = dq.to; q = dq.rest; dateRange = { from: dq.from, to: dq.to, label: dq.label } }
  const convs = await db.conversations.toArray()
  const convMap = new Map(convs.map(c => [c.id!, c]))
  const ql = rawQuery.trim().toLowerCase().replace(/"/g, '')
  const contacts = ql && !dq ? convs.filter(c => c.name.toLowerCase().includes(ql)).slice(0, 8) : []

  let bm: Set<number> | null = null
  if (f.type === 'bookmarked') bm = new Set((await db.bookmarks.toArray()).map(b => b.messageId))
  const okMeta = (d: { convId: number; ts: number | null; sender: string; kind: MsgKind; id?: number }) => {
    if (f.convId && d.convId !== f.convId) return false
    if (f.sender && d.sender !== f.sender) return false
    if (from !== null && (d.ts === null || d.ts < from)) return false
    if (to !== null && (d.ts === null || d.ts > to)) return false
    if (f.type === 'media' && !['image', 'video', 'gif', 'voice', 'audio', 'sticker'].includes(d.kind)) return false
    if (f.type === 'docs' && !['document', 'contact'].includes(d.kind)) return false
    if (bm && !bm.has(d.id!)) return false
    return true
  }

  let ids: { id: number; score: number }[] = []
  if (q.trim()) {
    const res = index.search(q, { filter: r => okMeta({ convId: r.convId, ts: r.ts, sender: r.sender, kind: r.kind, id: r.id }) })
    ids = res.map(r => ({ id: r.id as number, score: r.score }))
  } else if (dq || from !== null || to !== null || f.type !== undefined && f.type !== 'all' || f.convId || f.sender) {
    // filter-only browse (e.g. "January 2023")
    const hits: { id: number; score: number }[] = []
    await db.messages.each(m => { if (!m.hidden && okMeta(m) && m.kind !== 'system') hits.push({ id: m.id!, score: 0 }) })
    ids = hits
  }
  let total = ids.length
  let msgs = (await db.messages.bulkGet(ids.map(i => i.id))).filter((m): m is Message => !!m && !m.hidden)
  const scoreOf = new Map(ids.map(i => [i.id, i.score]))
  if (phrases.length) msgs = msgs.filter(m => phrases.every(p => (m.body + ' ' + (m.attName ?? '')).toLowerCase().includes(p)))
  total = msgs.length
  const sort = f.sort ?? (q.trim() ? 'relevance' : 'oldest')
  if (sort === 'relevance') msgs.sort((a, b) => (scoreOf.get(b.id!) ?? 0) - (scoreOf.get(a.id!) ?? 0))
  else msgs.sort((a, b) => sort === 'newest' ? b.sortTs - a.sortTs || b.seq - a.seq : a.sortTs - b.sortTs || a.seq - b.seq)
  return { hits: msgs.slice(0, limit).map(m => ({ message: m, conv: convMap.get(m.convId), score: scoreOf.get(m.id!) ?? 0 })), contacts, total, dateRange }
}
