import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { MessageSquare, Image as ImageIcon, Video, Mic, FileText, Link2, Bookmark, Star, Archive, Pencil, FileArchive, Download } from 'lucide-react'
import { db } from '../lib/db'
import { fmtDateLong, fmtNum, fmtSize } from '../lib/format'
import { Avatar, Btn, Card, Header, Modal, download } from './common'
import { DocList, LinkList, MediaGrid } from './Sections'
import { nav } from './router'

export function ContactInfo({ convId }: { convId: number }) {
  const conv = useLiveQuery(() => db.conversations.get(convId), [convId])
  const stats = useLiveQuery(async () => {
    const s = { sent: 0, recv: 0, photos: 0, videos: 0, docs: 0, voice: 0, links: 0, senders: new Map<string, number>() }
    await db.messages.where('convId').equals(convId).each(m => {
      if (m.hidden) return
      if (m.kind !== 'system' && m.kind !== 'unparsed') { m.isMe ? s.sent++ : s.recv++; s.senders.set(m.sender, (s.senders.get(m.sender) ?? 0) + 1) }
      if (m.kind === 'image') s.photos++; else if (m.kind === 'video' || m.kind === 'gif') s.videos++; else if (m.kind === 'document' || m.kind === 'contact') s.docs++; else if (m.kind === 'voice' || m.kind === 'audio') s.voice++
      if (/https?:\/\//.test(m.body)) s.links++
    })
    return s
  }, [convId])
  const zips = useLiveQuery(async () => conv ? (await db.zips.bulkGet(conv.sourceZipIds)).filter(Boolean) : [], [conv?.sourceZipIds.join()])
  const bmCount = useLiveQuery(() => db.bookmarks.where('convId').equals(convId).count(), [convId])
  const [tab, setTab] = useState<'media' | 'links' | 'docs' | null>(null)
  const [rename, setRename] = useState(false), [name, setName] = useState('')
  if (!conv || !stats) return <div className="p-8 text-mute">Loading…</div>
  const tiles: [React.ReactNode, number, string][] = [[<MessageSquare size={20} key="m" />, stats.sent + stats.recv, 'Messages'], [<ImageIcon size={20} key="i" />, stats.photos, 'Photos'], [<Video size={20} key="v" />, stats.videos, 'Videos'], [<Mic size={20} key="a" />, stats.voice, 'Voice notes'], [<FileText size={20} key="d" />, stats.docs, 'Documents'], [<Link2 size={20} key="l" />, stats.links, 'Links']]

  if (tab) return <div className="h-full flex flex-col bg-bg"><Header title={conv.name} sub={tab === 'media' ? 'Media' : tab === 'links' ? 'Links' : 'Docs'} onBack backTo={`info/${convId}`} />
    <div className="flex gap-2 px-3 py-2">{(['media', 'links', 'docs'] as const).map(t => <button key={t} onClick={() => setTab(t)} className={`px-4 py-1.5 rounded-full text-sm capitalize ${tab === t ? 'bg-accent text-bg font-semibold' : 'bg-surface text-mute'}`}>{t}</button>)}</div>
    <div className="flex-1 min-h-0">{tab === 'media' ? <MediaGrid convId={convId} /> : tab === 'links' ? <LinkList convId={convId} /> : <DocList convId={convId} />}</div></div>

  return <div className="h-full flex flex-col bg-bg"><Header title="Chat Info" onBack backTo={`chat/${convId}`} />
    <div className="flex-1 overflow-auto pb-10">
      <div className="flex flex-col items-center pt-6 pb-4 gap-2"><Avatar name={conv.name} group={conv.isGroup} size={96} />
        <button onClick={() => { setName(conv.name); setRename(true) }} className="text-2xl font-bold flex items-center gap-2">{conv.name}<Pencil size={15} className="text-mute" /></button>
        <div className="text-sm text-mute">{conv.isGroup ? 'Group' : 'Individual'} · {conv.firstTs ? `${fmtDateLong(conv.firstTs)} – ${fmtDateLong(conv.lastTs ?? conv.firstTs)}` : 'dates unavailable'}</div></div>
      <div className="grid grid-cols-3 gap-2 px-3">{tiles.map(([ic, n, l]) => <Card key={l} className="py-3 flex flex-col items-center gap-0.5"><span className="text-accent">{ic}</span><div className="font-bold text-lg">{fmtNum(n)}</div><div className="text-[11px] text-mute">{l}</div></Card>)}</div>
      <div className="px-3 mt-3 grid grid-cols-2 gap-2 text-sm"><Card className="p-3">Sent by me<div className="text-xl font-bold">{fmtNum(stats.sent)}</div></Card><Card className="p-3">Received<div className="text-xl font-bold">{fmtNum(stats.recv)}</div></Card></div>
      <div className="px-3 mt-4 space-y-2">
        <Card className="p-4"><div className="font-medium mb-2">Who am I in this chat?</div>
          <select value={conv.meName ?? ''} onChange={async e => { const v = e.target.value || null; await db.conversations.update(convId, { meName: v }); const norm = (s: string) => s.trim().toLowerCase(); await db.messages.where('convId').equals(convId).modify(m => { m.isMe = !!v && m.sender !== '' && norm(m.sender) === norm(v) }) }} className="w-full bg-bg2 rounded-xl px-3 py-3 outline-none text-ink">
            <option value="">— not set (all messages on the left) —</option>{[...stats.senders.keys()].map(s => <option key={s} value={s}>{s} ({stats.senders.get(s)})</option>)}</select>
          <div className="text-xs text-mute mt-2">This only affects which side bubbles appear on — message data is never modified.</div></Card>
        <button onClick={() => setTab('media')} className="w-full text-left bg-surface rounded-2xl px-4 py-4 flex justify-between"><span>Media, Links &amp; Docs</span><span className="text-mute">{fmtNum(stats.photos + stats.videos + stats.docs + stats.links)}</span></button>
        <button onClick={() => nav('archive')} className="w-full text-left bg-surface rounded-2xl px-4 py-4 flex justify-between"><span className="flex items-center gap-2"><Bookmark size={17} />Bookmarks</span><span className="text-mute">{bmCount ?? 0}</span></button>
        <button onClick={() => db.conversations.update(convId, { favourite: !conv.favourite })} className="w-full text-left bg-surface rounded-2xl px-4 py-4 flex items-center gap-2"><Star size={17} className={conv.favourite ? 'text-warn' : ''} fill={conv.favourite ? 'currentColor' : 'none'} />{conv.favourite ? 'Remove from favourites' : 'Add to favourites'}</button>
        <button onClick={() => db.conversations.update(convId, { archived: !conv.archived })} className="w-full text-left bg-surface rounded-2xl px-4 py-4 flex items-center gap-2"><Archive size={17} />{conv.archived ? 'Unarchive chat' : 'Archive chat'}</button>
        <Card className="p-4"><div className="font-medium mb-2 flex items-center gap-2"><FileArchive size={17} />Source ZIPs ({zips?.length ?? 0})</div>
          {zips?.map(z => z && <div key={z.id} className="flex items-center gap-2 py-1.5 text-sm"><div className="flex-1 min-w-0"><div className="truncate">{z.name}</div><div className="text-xs text-mute">{fmtSize(z.size)} · imported {new Date(z.importedAt).toLocaleDateString()}</div></div>{z.originalKept ? <button aria-label="Download original ZIP" className="p-2 rounded-full hover:bg-white/10" onClick={() => download(z.blob, z.name)}><Download size={17} /></button> : <span className="text-[10px] text-mute">original not kept</span>}</div>)}</Card>
      </div></div>
    {rename && <Modal title="Rename conversation" onClose={() => setRename(false)}><input value={name} onChange={e => setName(e.target.value)} className="w-full bg-surface rounded-xl px-3 py-3 mb-3 outline-none" /><Btn className="w-full" onClick={async () => { if (name.trim()) await db.conversations.update(convId, { name: name.trim() }); setRename(false) }}>Save</Btn></Modal>}
  </div>
}
