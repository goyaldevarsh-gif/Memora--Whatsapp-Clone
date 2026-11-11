import { useMemo, useState } from 'react'
import { VirtuosoGrid, Virtuoso } from 'react-virtuoso'
import { useLiveQuery } from 'dexie-react-hooks'
import { Image as ImageIcon, FileText, Archive as ArchiveIcon, Bookmark, Star, Mic, Link2, ChevronRight, Search, Trash2 } from 'lucide-react'
import { db } from '../lib/db'
import type { Attachment, Bookmark as BM, Message } from '../lib/types'
import { fmtDateTime, fmtDate, fmtSize, extOf, fmtNum } from '../lib/format'
import { Avatar, Card, Empty, Header, IconBtn, Modal, Btn, download } from './common'
import { AudioPlayer, DocAttachment, FileCard, ImageThumb, VideoThumb, Viewer, type ViewerItem } from './media'
import { nav } from './router'
import { ChatList } from './ChatList'
import { MessageDetails } from './ChatView'

type AttMeta = Pick<Attachment, 'id' | 'convId' | 'name' | 'kind' | 'mime' | 'size' | 'ts'>
const meta = (a: Attachment): AttMeta => ({ id: a.id, convId: a.convId, name: a.name, kind: a.kind, mime: a.mime, size: a.size, ts: a.ts })

/** Metadata-only listing of attachments (blobs are loaded lazily per visible cell). */
function useAttMeta(filter: (a: Attachment) => boolean, deps: unknown[]) {
  return useLiveQuery(async () => { const out: AttMeta[] = []; await db.attachments.each(a => { if (filter(a)) out.push(meta(a)) }); return out.sort((x, y) => (y.ts ?? 0) - (x.ts ?? 0)) }, deps)
}

const MEDIA_KINDS = ['image', 'video', 'gif', 'sticker']
export function MediaGrid({ convId, type = 'all' }: { convId?: number; type?: 'all' | 'photos' | 'videos' | 'gifs' }) {
  const list = useAttMeta(a => (!convId || a.convId === convId) && (type === 'all' ? MEDIA_KINDS.includes(a.kind) && a.kind !== 'sticker' : type === 'photos' ? a.kind === 'image' : type === 'videos' ? a.kind === 'video' : a.kind === 'gif'), [convId, type])
  const [view, setView] = useState<number | null>(null)
  const items: ViewerItem[] = useMemo(() => (list ?? []).map(a => ({ id: a.id!, kind: a.kind, name: a.name })), [list])
  if (!list) return null
  if (!list.length) return <Empty icon={<ImageIcon size={40} />} title="No media" text="Photos and videos from imported chats appear here." />
  return <>
    <VirtuosoGrid totalCount={list.length} className="h-full" listClassName="grid grid-cols-3 md:grid-cols-5 lg:grid-cols-6 gap-0.5 p-0.5"
      itemContent={i => { const a = list[i]; return <div className="aspect-square bg-surface overflow-hidden">{a.kind === 'video' || a.kind === 'gif' ? <VideoThumb attId={a.id!} onOpen={() => setView(i)} className="w-full h-full" /> : <ImageThumb attId={a.id!} onOpen={() => setView(i)} className="w-full h-full" />}</div> }} />
    {view !== null && <Viewer items={items} start={view} onClose={() => setView(null)} />}
  </>
}

const DOC_FILTERS: [string, (e: string) => boolean][] = [['All', () => true], ['PDFs', e => e === 'PDF'], ['Documents', e => ['DOC', 'DOCX', 'TXT'].includes(e)], ['Sheets', e => ['XLS', 'XLSX', 'CSV'].includes(e)], ['Slides', e => ['PPT', 'PPTX'].includes(e)], ['Others', e => !['PDF', 'DOC', 'DOCX', 'TXT', 'XLS', 'XLSX', 'CSV', 'PPT', 'PPTX'].includes(e)]]
export function DocList({ convId }: { convId?: number }) {
  const [f, setF] = useState(0), [q, setQ] = useState('')
  const list = useAttMeta(a => (!convId || a.convId === convId) && (a.kind === 'document' || a.kind === 'contact'), [convId])
  const [view, setView] = useState<ViewerItem[] | null>(null)
  const rows = useMemo(() => (list ?? []).filter(a => DOC_FILTERS[f][1](extOf(a.name)) && a.name.toLowerCase().includes(q.toLowerCase())), [list, f, q])
  return <div className="h-full flex flex-col">
    <div className="px-3 pt-3 space-y-2">
      <div className="relative"><Search size={16} className="absolute left-3 top-3 text-mute" /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search files" className="w-full bg-surface rounded-xl pl-9 pr-3 py-2.5 outline-none" /></div>
      <div className="flex gap-2 overflow-x-auto pb-2">{DOC_FILTERS.map(([l], i) => <button key={l} onClick={() => setF(i)} className={`px-3.5 py-1.5 rounded-full text-sm whitespace-nowrap ${f === i ? 'bg-accent text-bg font-semibold' : 'bg-surface text-mute'}`}>{l}</button>)}</div>
    </div>
    <div className="flex-1 min-h-0">{!rows.length ? <Empty icon={<FileText size={40} />} title="No files" text="Documents shared in your chats show up here." /> :
      <Virtuoso data={rows} itemContent={(_, a) => <div className="px-3 py-1.5"><DocAttachmentRow a={a} onOpen={() => setView([{ id: a.id!, kind: a.kind, name: a.name }])} /></div>} />}</div>
    {view && <Viewer items={view} start={0} onClose={() => setView(null)} />}
  </div>
}
function DocAttachmentRow({ a, onOpen }: { a: AttMeta; onOpen: () => void }) {
  return <div className="bg-surface rounded-2xl p-1"><div className="flex items-center"><div className="flex-1 min-w-0"><DocAttachment attId={a.id!} onOpen={onOpen} /></div></div><div className="text-[11px] text-mute px-3 pb-1.5 flex gap-3"><span>{a.ts ? fmtDate(a.ts) : ''}</span><span>{fmtSize(a.size)}</span></div></div>
}

export function LinkList({ convId }: { convId: number }) {
  const links = useLiveQuery(async () => {
    const out: { id: number; url: string; ts: number | null; sender: string }[] = []
    await db.messages.where('convId').equals(convId).each(m => { if (m.hidden) return; for (const u of m.body.match(/https?:\/\/[^\s<>"']+/g) ?? []) out.push({ id: m.id!, url: u, ts: m.ts, sender: m.sender }) })
    return out.reverse()
  }, [convId])
  if (!links?.length) return <Empty icon={<Link2 size={40} />} title="No links" />
  return <Virtuoso data={links} itemContent={(_, l) => <div className="px-3 py-1.5"><button onClick={() => nav(`chat/${convId}?m=${l.id}`)} className="w-full text-left bg-surface rounded-2xl px-4 py-3"><div className="text-[#6FD3FF] text-sm break-all line-clamp-2">{l.url}</div><div className="text-[11px] text-mute mt-1">{l.sender} · {l.ts ? fmtDate(l.ts) : ''}</div></button></div>} />
}

export function MediaTab() {
  const [t, setT] = useState<'all' | 'photos' | 'videos' | 'gifs'>('all')
  return <div className="h-full flex flex-col bg-bg"><Header title="Media" />
    <div className="flex gap-2 px-3 py-2.5">{([['all', 'All'], ['photos', 'Photos'], ['videos', 'Videos'], ['gifs', 'GIFs']] as const).map(([k, l]) => <button key={k} onClick={() => setT(k)} className={`px-3.5 py-1.5 rounded-full text-sm ${t === k ? 'bg-accent text-bg font-semibold' : 'bg-surface text-mute'}`}>{l}</button>)}</div>
    <div className="flex-1 min-h-0"><MediaGrid type={t} /></div></div>
}
export const FilesTab = () => <div className="h-full flex flex-col bg-bg"><Header title="Files" /><div className="flex-1 min-h-0"><DocList /></div></div>

// ---------- Archive ----------
type ArchView = null | 'archived' | 'favourites' | 'bookmarks' | 'docs' | 'photos' | 'voice'
export function ArchiveTab() {
  const [v, setV] = useState<ArchView>(null)
  const counts = useLiveQuery(async () => {
    const [convs, bms] = await Promise.all([db.conversations.toArray(), db.bookmarks.toArray()])
    return { archived: convs.filter(c => c.archived).length, favourites: convs.filter(c => c.favourite).length, bookmarks: bms.length, docs: bms.filter(b => b.kind === 'document').length, photos: bms.filter(b => b.kind === 'image').length, voice: bms.filter(b => b.kind === 'voice' || b.kind === 'audio').length }
  }, [])
  if (v) return <ArchiveDetail v={v} onBack={() => setV(null)} />
  const rows: [ArchView, React.ReactNode, string, number | undefined][] = [
    ['archived', <ArchiveIcon size={20} key="a" />, 'Archived chats', counts?.archived], ['favourites', <Star size={20} key="f" />, 'Favourite contacts', counts?.favourites],
    ['bookmarks', <Bookmark size={20} key="b" />, 'Bookmarked messages', counts?.bookmarks], ['docs', <FileText size={20} key="d" />, 'Important documents', counts?.docs],
    ['photos', <ImageIcon size={20} key="p" />, 'Saved photos', counts?.photos], ['voice', <Mic size={20} key="v" />, 'Important voice notes', counts?.voice]]
  return <div className="h-full flex flex-col bg-bg"><Header title="Archive" />
    <div className="p-3 space-y-2 overflow-auto">{rows.map(([k, ic, l, n]) => <button key={k} onClick={() => setV(k)} className="w-full flex items-center gap-3 bg-surface rounded-2xl px-4 py-4 text-left hover:bg-white/5"><span className="text-accent">{ic}</span><span className="flex-1 font-medium">{l}</span><span className="text-mute text-sm">{n ?? 0}</span><ChevronRight size={18} className="text-mute" /></button>)}
      <p className="text-xs text-mute px-2 pt-3">Bookmark any message from the ⌄ menu on its bubble. Your personal notes live next to the bookmark and never alter the original message.</p></div></div>
}

function ArchiveDetail({ v, onBack }: { v: Exclude<ArchView, null>; onBack: () => void }) {
  const titles = { archived: 'Archived chats', favourites: 'Favourite contacts', bookmarks: 'Bookmarked messages', docs: 'Important documents', photos: 'Saved photos', voice: 'Important voice notes' }
  return <div className="h-full flex flex-col bg-bg"><Header title={titles[v]} onBack backTo="archive" right={<span />} />
    <button onClick={onBack} className="hidden" />
    <div className="flex-1 min-h-0">{v === 'archived' ? <ChatList showArchived /> : v === 'favourites' ? <Favs /> : <BookmarkList filter={v} />}</div></div>
}
function Favs() {
  const c = useLiveQuery(() => db.conversations.filter(x => x.favourite).toArray(), [])
  if (!c?.length) return <Empty icon={<Star size={40} />} title="No favourites" text="Mark a contact as favourite from Contact info." />
  return <div>{c.map(x => <button key={x.id} onClick={() => nav(`chat/${x.id}`)} className="w-full flex items-center gap-3 px-4 py-3 border-b border-line/40 text-left"><Avatar name={x.name} group={x.isGroup} /><div className="flex-1"><div className="font-medium">{x.name}</div><div className="text-xs text-mute">{fmtNum(x.messageCount)} messages</div></div></button>)}</div>
}
function BookmarkList({ filter }: { filter: 'bookmarks' | 'docs' | 'photos' | 'voice' }) {
  const data = useLiveQuery(async () => {
    let bms = await db.bookmarks.orderBy('createdAt').reverse().toArray()
    if (filter === 'docs') bms = bms.filter(b => b.kind === 'document'); if (filter === 'photos') bms = bms.filter(b => b.kind === 'image'); if (filter === 'voice') bms = bms.filter(b => b.kind === 'voice' || b.kind === 'audio')
    const msgs = await db.messages.bulkGet(bms.map(b => b.messageId)); const convs = new Map((await db.conversations.toArray()).map(c => [c.id!, c]))
    return bms.map((b, i) => ({ b, m: msgs[i], c: convs.get(b.convId) })).filter(x => x.m) as { b: BM; m: Message; c?: { name: string } }[]
  }, [filter])
  const [note, setNote] = useState<BM | null>(null), [t, setT] = useState('')
  if (!data?.length) return <Empty icon={<Bookmark size={40} />} title="Nothing here yet" text="Bookmark messages in a chat to find them quickly later." />
  return <div className="overflow-auto h-full p-3 space-y-2">
    {data.map(({ b, m, c }) => <Card key={b.id} className="p-3">
      <button className="w-full text-left" onClick={() => nav(`chat/${b.convId}?m=${m.id}`)}>
        <div className="text-xs text-mute mb-1">{c?.name} · {fmtDateTime(m.ts, m.rawTs)} · {m.sender}</div>
        {m.attId && (m.kind === 'voice' || m.kind === 'audio') ? <AudioPlayer attId={m.attId} voice /> : m.attId && m.kind === 'image' ? <ImageThumb attId={m.attId} className="rounded-xl max-h-60" /> : m.attId && m.kind === 'document' ? <DocAttachment attId={m.attId} /> : <div className="text-[15px] whitespace-pre-wrap line-clamp-4">{m.body}</div>}
      </button>
      {b.note && <div className="mt-2 text-sm bg-warn/10 text-warn rounded-lg px-3 py-2">📝 {b.note}</div>}
      <div className="flex gap-1 mt-2"><button className="text-xs text-accent px-2 py-1" onClick={() => { setNote(b); setT(b.note) }}>{b.note ? 'Edit note' : 'Add note'}</button><button className="text-xs text-mute px-2 py-1" onClick={() => db.bookmarks.delete(b.id!)}>Remove bookmark</button></div>
    </Card>)}
    {note && <Modal title="Personal note" onClose={() => setNote(null)}><textarea value={t} onChange={e => setT(e.target.value)} rows={4} className="w-full bg-surface rounded-xl p-3 outline-none mb-3" /><Btn className="w-full" onClick={async () => { await db.bookmarks.update(note.id!, { note: t }); setNote(null) }}>Save</Btn></Modal>}
  </div>
}
export { FileCard, IconBtn, Trash2, download, MessageDetails }
