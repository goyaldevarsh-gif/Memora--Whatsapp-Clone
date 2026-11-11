import { useEffect, useRef, useState } from 'react'
import { Virtuoso } from 'react-virtuoso'
import { useLiveQuery } from 'dexie-react-hooks'
import { Search, SlidersHorizontal, Paperclip, X, CalendarRange } from 'lucide-react'
import { db, previewOf } from '../lib/db'
import { ensureIndex, onSearchState, runSearch, searchState, type SearchFilters, type SearchOutput } from '../lib/search'
import { fmtDateTime, fmtNum } from '../lib/format'
import { Avatar, Empty, Highlight, IconBtn } from './common'
import { back, nav } from './router'
import { ArrowLeft } from 'lucide-react'
import { captionOf } from '../lib/parser'

export function SearchPage() {
  const [q, setQ] = useState(() => sessionStorage.getItem('lastQ') ?? '')
  const [type, setType] = useState<NonNullable<SearchFilters['type']>>('all')
  const [conv, setConv] = useState<number | undefined>(), [sender, setSender] = useState(''), [from, setFrom] = useState(''), [to, setTo] = useState('')
  const [sort, setSort] = useState<'relevance' | 'newest' | 'oldest'>('relevance')
  const [panel, setPanel] = useState(false)
  const [out, setOut] = useState<SearchOutput | null>(null), [busy, setBusy] = useState(false)
  const [, force] = useState(0)
  const convs = useLiveQuery(() => db.conversations.toArray(), [])
  const senders = useLiveQuery(async () => { if (!conv) return [] as string[]; const s = new Set<string>(); await db.messages.where('convId').equals(conv).each(m => { if (m.sender) s.add(m.sender) }); return [...s] }, [conv])
  const seq = useRef(0)
  useEffect(() => { ensureIndex(); return onSearchState(() => force(x => x + 1)) }, [])
  const dateMs = (v: string, end = false) => { if (!v) return null; const [y, m, d] = v.split('-').map(Number); return Date.UTC(y, m - 1, d + (end ? 1 : 0)) - (end ? 1 : 0) }
  const filtersActive = !!(conv || sender || from || to)
  useEffect(() => {
    sessionStorage.setItem('lastQ', q)
    const id = ++seq.current
    if (!q.trim() && !filtersActive && type === 'all') { setOut(null); return }
    setBusy(true)
    const t = setTimeout(async () => {
      const r = await runSearch(q, { type, convId: conv, sender: sender || undefined, from: dateMs(from), to: dateMs(to, true), sort }, 400)
      if (id === seq.current) { setOut(r); setBusy(false) }
    }, 180)
    return () => clearTimeout(t)
  }, [q, type, conv, sender, from, to, sort, searchState.ready]) // eslint-disable-line react-hooks/exhaustive-deps

  const chips: [typeof type, string][] = [['all', 'All'], ['media', 'Media'], ['docs', 'Files'], ['bookmarked', 'Bookmarked']]
  return (
    <div className="h-full flex flex-col bg-bg">
      <div className="pt-safe bg-bg2 border-b border-line">
        <div className="h-14 px-2 flex items-center gap-1">
          <IconBtn label="Back" onClick={() => back('chats')}><ArrowLeft size={22} /></IconBtn>
          <div className="flex-1 relative"><Search size={17} className="absolute left-3 top-3 text-mute" />
            <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder='Search messages, people, "exact phrase", Jan 2023…' className="w-full bg-surface rounded-xl pl-9 pr-9 py-2.5 outline-none text-[15px] placeholder:text-mute" />
            {q && <button aria-label="Clear" onClick={() => setQ('')} className="absolute right-2 top-2.5 p-0.5"><X size={18} className="text-mute" /></button>}</div>
          <IconBtn label="Filters" active={panel || filtersActive} onClick={() => setPanel(p => !p)}><SlidersHorizontal size={20} /></IconBtn>
        </div>
        <div className="flex gap-2 px-3 pb-2.5 overflow-x-auto">{chips.map(([k, l]) => <button key={k} onClick={() => setType(k)} className={`px-3.5 py-1 rounded-full text-sm whitespace-nowrap ${type === k ? 'bg-accent text-bg font-semibold' : 'bg-surface text-mute'}`}>{l}</button>)}</div>
        {panel && <div className="px-3 pb-3 grid grid-cols-2 gap-2 text-sm fade-in">
          <select value={conv ?? ''} onChange={e => { setConv(e.target.value ? +e.target.value : undefined); setSender('') }} className="bg-surface rounded-xl px-3 py-2.5 col-span-2 text-ink"><option value="">All conversations</option>{convs?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <select value={sender} disabled={!conv} onChange={e => setSender(e.target.value)} className="bg-surface rounded-xl px-3 py-2.5 col-span-2 text-ink disabled:opacity-40"><option value="">{conv ? 'Anyone' : 'Pick a conversation to filter by sender'}</option>{senders?.map(s => <option key={s}>{s}</option>)}</select>
          <label className="text-mute text-xs">From<input type="date" value={from} onChange={e => setFrom(e.target.value)} className="w-full bg-surface rounded-xl px-3 py-2 mt-1 text-ink" /></label>
          <label className="text-mute text-xs">To<input type="date" value={to} onChange={e => setTo(e.target.value)} className="w-full bg-surface rounded-xl px-3 py-2 mt-1 text-ink" /></label>
          <select value={sort} onChange={e => setSort(e.target.value as typeof sort)} className="bg-surface rounded-xl px-3 py-2.5 col-span-2 text-ink"><option value="relevance">Sort: best match</option><option value="newest">Sort: newest first</option><option value="oldest">Sort: oldest first</option></select>
        </div>}
      </div>
      {!searchState.ready && searchState.total > 0 && <div className="text-xs text-warn bg-warn/10 px-4 py-1.5">Building search index… {Math.round((searchState.indexed / searchState.total) * 100)}% — results will update.</div>}
      <div className="flex-1 min-h-0">
        {!out ? <Empty icon={<Search size={42} />} title="Search your whole archive" text={'Try: ACL surgery · "flight ticket" · January 2023 · 12 March 2022 · pdf · a person\'s name'} /> :
          !out.hits.length && !out.contacts.length ? <Empty title={busy ? 'Searching…' : 'No results'} text="Try fewer words, a partial word, or remove filters." /> :
            <Virtuoso data={out.hits} components={{ Header: () => <>
              {out.dateRange && <div className="px-4 py-2 text-sm text-accent flex items-center gap-2"><CalendarRange size={16} />Messages from {out.dateRange.label}</div>}
              {out.contacts.length > 0 && <div className="py-1"><div className="px-4 py-1.5 text-xs uppercase tracking-wide text-mute">Chats</div>{out.contacts.map(c => <button key={c.id} onClick={() => nav(`chat/${c.id}`)} className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-white/5 text-left"><Avatar name={c.name} group={c.isGroup} size={40} /><div><div className="font-medium">{c.name}</div><div className="text-xs text-mute">{fmtNum(c.messageCount)} messages</div></div></button>)}</div>}
              {out.hits.length > 0 && <div className="px-4 py-1.5 text-xs uppercase tracking-wide text-mute">{fmtNum(out.total)} message{out.total === 1 ? '' : 's'}{out.total > out.hits.length ? ` (showing ${out.hits.length})` : ''}</div>}</> }}
              itemContent={(_, h) => {
                const m = h.message; const text = ((m.attName || m.attMissing) ? captionOf(m) : m.body).replace(/\s+/g, ' ')
                return <button onClick={() => nav(`chat/${m.convId}?m=${m.id}`)} className="w-full text-left flex gap-3 px-4 py-3 border-b border-line/40 hover:bg-white/5">
                  <Avatar name={h.conv?.name ?? '?'} group={h.conv?.isGroup} size={44} />
                  <div className="min-w-0 flex-1"><div className="flex items-baseline gap-2"><div className="font-semibold truncate flex-1">{h.conv?.name}</div><div className="text-[11px] text-mute shrink-0">{fmtDateTime(m.ts, m.rawTs)}</div></div>
                    <div className="text-[14px] text-mute line-clamp-2 break-words">{m.sender && <span className="text-ink/80">{m.sender}: </span>}{m.attName && <span className="inline-flex items-center gap-1 text-accent"><Paperclip size={12} /><Highlight text={m.attName} q={q} /> </span>}{!m.attName && m.attMissing && !text && <span className="italic">{previewOf(m)} (not in export)</span>}<Highlight text={text.slice(0, 220)} q={q} /></div></div>
                </button>
              }} />}
      </div>
    </div>
  )
}
