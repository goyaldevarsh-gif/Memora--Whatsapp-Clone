import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { useLiveQuery } from 'dexie-react-hooks'
import { Search, CalendarDays, Info, ChevronDown, ChevronUp, X, MoreVertical, Bookmark, BookmarkCheck, Copy, Share2, Download as DownloadIcon, FileArchive, ListTree, Phone } from 'lucide-react'
import { db } from '../lib/db'
import { runSearch } from '../lib/search'
import { captionOf } from '../lib/parser'
import type { Message } from '../lib/types'
import { dayKey, dayLabel, fmtDateLong, fmtDateTime, fmtTime, fmtNum } from '../lib/format'
import { Avatar, IconBtn, Modal, colorFor, useToast, download, Btn } from './common'
import { AudioPlayer, DocAttachment, ImageThumb, LocationCard, MissingAttachment, VideoThumb, Viewer, type ViewerItem } from './media'
import { back, nav } from './router'
import { ArrowLeft } from 'lucide-react'

const LINK = /(https?:\/\/[^\s<>"']+)/g
function Text({ t }: { t: string }) {
  const parts = t.split(LINK)
  return <>{parts.map((p, i) => i % 2 ? <a key={i} href={p} target="_blank" rel="noreferrer" className="text-[#6FD3FF] underline break-all">{p}</a> : p)}</>
}

interface BubbleProps { m: Message; showSender: boolean; isGroup: boolean; marked: boolean; highlight: boolean; onMenu: (m: Message) => void; onOpenMedia: (attId: number) => void }
const Bubble = memo(function Bubble({ m, showSender, isGroup, marked, highlight, onMenu, onOpenMedia }: BubbleProps) {
  if (m.kind === 'system') return <div className="flex justify-center my-1.5 px-6"><div className={`text-[12px] text-mute bg-bg2/90 rounded-lg px-3 py-1.5 text-center max-w-[85%] ${highlight ? 'hl' : ''}`}>{m.body}</div></div>
  if (m.kind === 'unparsed') return <div className="mx-4 my-1 text-[12px] font-mono text-warn/90 bg-warn/10 border border-warn/30 rounded-lg px-3 py-1.5 whitespace-pre-wrap">⚠ Unparsed: {m.body}</div>
  const caption = captionOf(m)
  const media = m.attId && ['image', 'sticker', 'gif', 'video', 'voice', 'audio', 'document', 'contact'].includes(m.kind)
  const sticker = m.kind === 'sticker' && m.attId
  return (
    <div className={`flex px-3 md:px-6 my-[3px] ${m.isMe ? 'justify-end' : 'justify-start'}`}>
      <div className={`group relative max-w-[86%] md:max-w-[62%] rounded-2xl ${sticker ? '' : m.isMe ? 'bubble-out rounded-tr-md' : 'bubble-in rounded-tl-md'} px-2.5 pt-1.5 pb-1 shadow-sm ${highlight ? 'hl' : ''}`} id={`m${m.id}`}>
        {showSender && isGroup && !m.isMe && m.sender && <div className="text-[13px] font-semibold px-0.5 mb-0.5" style={{ color: colorFor(m.sender) }}>{m.sender}</div>}
        {media && <div className="mb-1">
          {(m.kind === 'image' || m.kind === 'sticker') && <ImageThumb attId={m.attId!} onOpen={() => onOpenMedia(m.attId!)} cover={m.kind !== 'sticker'} className={m.kind === 'sticker' ? 'w-32 h-32' : 'rounded-xl max-h-80 w-72 max-w-full'} />}
          {(m.kind === 'video' || m.kind === 'gif') && <VideoThumb attId={m.attId!} onOpen={() => onOpenMedia(m.attId!)} className="rounded-xl overflow-hidden w-72 max-w-full h-48" />}
          {(m.kind === 'voice' || m.kind === 'audio') && <AudioPlayer attId={m.attId!} voice={m.kind === 'voice'} />}
          {(m.kind === 'document' || m.kind === 'contact') && <DocAttachment attId={m.attId!} onOpen={a => a.mime === 'application/pdf' || a.mime.startsWith('image/') ? onOpenMedia(a.id!) : undefined} />}
        </div>}
        {!media && m.attMissing && <div className="mb-1"><MissingAttachment name={m.attName} omitted={!m.attName} /></div>}
        {m.kind === 'location' && <div className="mb-1"><LocationCard text={m.body} /></div>}
        {m.kind === 'deleted' && <div className="text-[14px] italic text-mute py-0.5">🚫 {m.body}</div>}
        {m.kind === 'call' && <div className="text-[14px] flex items-center gap-2 py-0.5"><Phone size={14} className="text-accent" />{m.body}</div>}
        {(m.kind === 'text' || (m.kind !== 'deleted' && m.kind !== 'call' && m.kind !== 'location' && caption)) && (m.kind === 'text' ? m.body : caption) !== '' &&
          <div className="text-[15px] leading-[1.35] whitespace-pre-wrap break-words px-0.5" dir="auto"><Text t={m.kind === 'text' ? m.body : caption} /></div>}
        <div className="flex items-center justify-end gap-1.5 -mt-0.5 pl-6 select-none">
          {m.flagged && <span title={m.flagged} className="text-warn text-[11px]">⚠</span>}
          {marked && <BookmarkCheck size={12} className="text-warn" />}
          <span className="text-[11px] text-white/55">{fmtTime(m.ts, m.rawTs)}</span>
        </div>
        <button aria-label="Message actions" onClick={() => onMenu(m)} className="absolute top-0.5 right-0.5 w-7 h-7 rounded-full bg-black/30 opacity-0 group-hover:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-0 flex items-center justify-center"><ChevronDown size={16} /></button>
      </div>
    </div>
  )
})

export function ChatView({ convId, jumpTo }: { convId: number; jumpTo?: number }) {
  const conv = useLiveQuery(() => db.conversations.get(convId), [convId])
  const msgs = useLiveQuery(() => db.messages.where('[convId+sortTs+seq]').between([convId, -Infinity, -Infinity], [convId, Infinity, Infinity]).filter(m => !m.hidden).toArray(), [convId])
  const bookmarks = useLiveQuery(() => db.bookmarks.where('convId').equals(convId).toArray(), [convId])
  const marked = useMemo(() => new Set(bookmarks?.map(b => b.messageId)), [bookmarks])
  const vref = useRef<VirtuosoHandle>(null)
  const [hlId, setHlId] = useState<number | undefined>()
  const [menuMsg, setMenuMsg] = useState<Message | null>(null)
  const [detail, setDetail] = useState<Message | null>(null)
  const [noteFor, setNoteFor] = useState<Message | null>(null)
  const [viewer, setViewer] = useState<{ items: ViewerItem[]; start: number } | null>(null)
  const [searching, setSearching] = useState(false), [q, setQ] = useState(''), [matches, setMatches] = useState<number[]>([]), [mi, setMi] = useState(0)
  const [dateOpen, setDateOpen] = useState(false)
  const [toast, toastEl] = useToast()

  const idxById = useMemo(() => { const m = new Map<number, number>(); msgs?.forEach((x, i) => m.set(x.id!, i)); return m }, [msgs])
  const initial = useMemo(() => (jumpTo !== undefined && idxById.has(jumpTo) ? idxById.get(jumpTo)! : Math.max(0, (msgs?.length ?? 1) - 1)), [msgs?.length === undefined, convId]) // eslint-disable-line react-hooks/exhaustive-deps

  const jump = useCallback((id: number) => {
    const i = idxById.get(id); if (i === undefined) return
    vref.current?.scrollToIndex({ index: i, align: 'center', behavior: 'auto' }); setHlId(id); setTimeout(() => setHlId(h => (h === id ? undefined : h)), 2600)
  }, [idxById])
  useEffect(() => { if (jumpTo !== undefined && msgs) { const t = setTimeout(() => jump(jumpTo), 120); return () => clearTimeout(t) } }, [jumpTo, !!msgs, convId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!searching || !q.trim()) { setMatches([]); return }
    const t = setTimeout(async () => { const r = await runSearch(q, { convId, sort: 'oldest' }, 2000); const ids = r.hits.map(h => h.message.id!); setMatches(ids); setMi(0); if (ids.length) jump(ids[0]) }, 250)
    return () => clearTimeout(t)
  }, [q, searching, convId]) // eslint-disable-line react-hooks/exhaustive-deps
  const step = (d: number) => { if (!matches.length) return; const n = (mi + d + matches.length) % matches.length; setMi(n); jump(matches[n]) }

  const openMedia = useCallback(async (attId: number) => {
    const all = await db.attachments.where('convId').equals(convId).filter(a => /^(image|video|application\/pdf)/.test(a.mime) && a.kind !== 'sticker').toArray()
    const items = all.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0)).map(a => ({ id: a.id!, kind: a.kind, name: a.name }))
    setViewer({ items, start: Math.max(0, items.findIndex(x => x.id === attId)) })
  }, [convId])

  const toggleBookmark = async (m: Message) => {
    const ex = await db.bookmarks.where('messageId').equals(m.id!).first()
    if (ex) { await db.bookmarks.delete(ex.id!); toast('Bookmark removed') } else { await db.bookmarks.add({ messageId: m.id!, convId, kind: m.kind, note: '', createdAt: Date.now() }); toast('Bookmarked — add a note from the menu'); }
    setMenuMsg(null)
  }
  const copy = async (m: Message) => { await navigator.clipboard?.writeText(captionOf(m) || m.body); toast('Copied'); setMenuMsg(null) }
  const share = async (m: Message) => {
    const text = `${conv?.name} · ${fmtDateTime(m.ts, m.rawTs)}\n${m.sender ? m.sender + ': ' : ''}${m.body}`
    try { if (navigator.share) await navigator.share({ text }); else { download(new Blob([text], { type: 'text/plain' }), `message-${m.id}.txt`) } } catch { /* cancelled */ }
    setMenuMsg(null)
  }
  const dlAtt = async (m: Message) => { const a = m.attId ? await db.attachments.get(m.attId) : undefined; if (a) download(a.blob, a.name); setMenuMsg(null) }
  const dlZip = async (m: Message) => { const z = await db.zips.get(m.zipId); if (z) download(z.blob, z.name); setMenuMsg(null) }

  if (conv === undefined || !msgs) return <div className="h-full bg-bg flex items-center justify-center text-mute">Loading…</div>
  if (conv === null as unknown) return <div className="h-full flex items-center justify-center text-mute">Conversation not found</div>
  const range = conv.firstTs ? `${fmtDateLong(conv.firstTs)} – ${fmtDateLong(conv.lastTs ?? conv.firstTs)}` : ''
  return (
    <div className="h-full flex flex-col bg-bg relative">
      <div className="pt-safe bg-bg2/95 border-b border-line z-20">
        {searching ? (
          <div className="h-14 px-2 flex items-center gap-1">
            <IconBtn label="Close search" onClick={() => { setSearching(false); setQ('') }}><ArrowLeft size={21} /></IconBtn>
            <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search in this chat" className="flex-1 bg-surface rounded-xl px-3.5 py-2 outline-none text-[15px] placeholder:text-mute min-w-0" />
            <span className="text-xs text-mute w-14 text-center">{matches.length ? `${mi + 1}/${matches.length}` : q ? '0' : ''}</span>
            <IconBtn label="Previous match" onClick={() => step(-1)}><ChevronUp size={20} /></IconBtn><IconBtn label="Next match" onClick={() => step(1)}><ChevronDown size={20} /></IconBtn>
          </div>
        ) : (
          <div className="h-14 px-1.5 flex items-center gap-1">
            <IconBtn label="Back" onClick={() => back('chats')} className="md:hidden"><ArrowLeft size={22} /></IconBtn>
            <button className="flex items-center gap-3 flex-1 min-w-0 text-left" onClick={() => nav(`info/${convId}`)}>
              <Avatar name={conv.name} group={conv.isGroup} size={40} />
              <div className="min-w-0"><div className="font-semibold text-[16px] truncate">{conv.name}</div><div className="text-xs text-mute truncate">{fmtNum(conv.messageCount)} messages · {range || 'Read-only archive'}</div></div>
            </button>
            <IconBtn label="Search in chat" onClick={() => setSearching(true)}><Search size={20} /></IconBtn>
            <IconBtn label="Jump to date" onClick={() => setDateOpen(true)}><CalendarDays size={20} /></IconBtn>
            <IconBtn label="Contact info" onClick={() => nav(`info/${convId}`)}><Info size={20} /></IconBtn>
          </div>
        )}
      </div>
      {!conv.meName && msgs.length > 0 && <button onClick={() => nav(`info/${convId}`)} className="text-xs bg-warn/15 text-warn px-4 py-2 text-left z-10">Tell Memora which sender is you so your messages appear on the right → Contact info</button>}
      <div className="flex-1 min-h-0 wallpaper">
        {msgs.length === 0 ? <div className="h-full flex items-center justify-center text-mute text-sm">No messages</div> :
          <Virtuoso ref={vref} data={msgs} initialTopMostItemIndex={{ index: initial, align: jumpTo !== undefined ? 'center' : 'end' }} increaseViewportBy={{ top: 600, bottom: 600 }} className="h-full" computeItemKey={(_, m) => m.id!}
            itemContent={(i, m) => {
              const prev = msgs[i - 1]
              const newDay = m.ts !== null && (!prev || prev.ts === null || dayKey(prev.ts) !== dayKey(m.ts))
              return <div className={i === msgs.length - 1 ? 'pb-4' : ''}>
                {newDay && <div className="flex justify-center my-3"><span className="text-[12px] font-medium text-mute bg-bg2/95 px-3 py-1 rounded-lg shadow">{dayLabel(m.ts!)}</span></div>}
                <Bubble m={m} isGroup={conv.isGroup} showSender={!prev || prev.sender !== m.sender || newDay} marked={marked.has(m.id!)} highlight={hlId === m.id} onMenu={setMenuMsg} onOpenMedia={openMedia} />
              </div>
            }} />}
      </div>
      <div className="pb-safe bg-bg2 border-t border-line text-center text-[11px] text-mute py-1.5">🔒 Read-only archive · stored only on this device</div>

      {menuMsg && <Modal title="Message" onClose={() => setMenuMsg(null)}>
        <div className="text-sm text-mute mb-3 line-clamp-3 whitespace-pre-wrap">{menuMsg.body.slice(0, 200)}</div>
        <div className="flex flex-col">
          {[
            [marked.has(menuMsg.id!) ? <BookmarkCheck size={19} key="b" /> : <Bookmark size={19} key="b" />, marked.has(menuMsg.id!) ? 'Remove bookmark' : 'Bookmark message', () => toggleBookmark(menuMsg)],
            ...(marked.has(menuMsg.id!) ? [[<ListTree size={19} key="n" />, 'Add / edit personal note', () => { setNoteFor(menuMsg); setMenuMsg(null) }] as const] : []),
            [<Copy size={19} key="c" />, 'Copy text', () => copy(menuMsg)],
            [<Share2 size={19} key="s" />, 'Share / export message', () => share(menuMsg)],
            ...(menuMsg.attId ? [[<DownloadIcon size={19} key="d" />, 'Download attachment', () => dlAtt(menuMsg)] as const] : []),
            [<MoreVertical size={19} key="i" />, 'Message details', () => { setDetail(menuMsg); setMenuMsg(null) }],
            [<FileArchive size={19} key="z" />, 'Download source ZIP', () => dlZip(menuMsg)]
          ].map(([ic, label, fn], i) => <button key={i} onClick={fn as () => void} className="flex items-center gap-3 px-2 py-3 rounded-xl hover:bg-white/5 text-left">{ic as React.ReactNode}<span>{label as string}</span></button>)}
        </div>
      </Modal>}
      {detail && <MessageDetails m={detail} onClose={() => setDetail(null)} />}
      {noteFor && <NoteEditor m={noteFor} onClose={() => setNoteFor(null)} />}
      {dateOpen && <Modal title="Jump to date" onClose={() => setDateOpen(false)}>
        <input type="date" id="jd" min={conv.firstTs ? new Date(conv.firstTs).toISOString().slice(0, 10) : undefined} max={conv.lastTs ? new Date(conv.lastTs).toISOString().slice(0, 10) : undefined} defaultValue={conv.lastTs ? new Date(conv.lastTs).toISOString().slice(0, 10) : ''} className="w-full bg-surface rounded-xl px-3 py-3 mb-3 text-ink" />
        <Btn className="w-full" onClick={() => {
          const v = (document.getElementById('jd') as HTMLInputElement).value; if (!v) return
          const [y, mo, d] = v.split('-').map(Number); const t = Date.UTC(y, mo - 1, d)
          const m = msgs.find(x => x.sortTs >= t) ?? msgs[msgs.length - 1]
          setDateOpen(false); setTimeout(() => jump(m.id!), 50)
        }}>Go</Btn>
      </Modal>}
      {viewer && <Viewer items={viewer.items} start={viewer.start} onClose={() => setViewer(null)} />}
      {toastEl}
    </div>
  )
}

function NoteEditor({ m, onClose }: { m: Message; onClose: () => void }) {
  const bm = useLiveQuery(() => db.bookmarks.where('messageId').equals(m.id!).first(), [m.id])
  const [t, setT] = useState<string | null>(null)
  return <Modal title="Personal note" onClose={onClose}>
    <p className="text-xs text-mute mb-2">Notes are stored separately and never change the original message.</p>
    <textarea value={t ?? bm?.note ?? ''} onChange={e => setT(e.target.value)} rows={4} className="w-full bg-surface rounded-xl p-3 outline-none mb-3" placeholder="Why is this important?" />
    <Btn className="w-full" onClick={async () => { if (bm) await db.bookmarks.update(bm.id!, { note: t ?? bm.note }); onClose() }}>Save note</Btn>
  </Modal>
}

export function MessageDetails({ m, onClose }: { m: Message; onClose: () => void }) {
  const zip = useLiveQuery(() => db.zips.get(m.zipId), [m.zipId])
  const rows: [string, string][] = [
    ['Sender', m.sender || '(system)'], ['Original timestamp', m.rawTs || '—'], ['Parsed timestamp', m.ts === null ? 'Could not be parsed' : fmtDateTime(m.ts)],
    ['Type', m.kind], ['Attachment', m.attName ?? (m.attMissing ? 'Exported without media' : '—')], ['Source ZIP', zip?.name ?? `#${m.zipId}`], ['Source text file', m.srcFile], ['Line in export', String(m.lineNo)], ['Original order #', String(m.seq + 1)]
  ]
  if (m.flagged) rows.push(['Flag', m.flagged])
  if (m.dupState) rows.push(['Duplicate review', m.dupState])
  return <Modal title="Message details" onClose={onClose} wide>
    <div className="divide-y divide-line">{rows.map(([k, v]) => <div key={k} className="flex gap-3 py-2 text-sm"><div className="w-36 text-mute shrink-0">{k}</div><div className="break-all">{v}</div></div>)}</div>
    <div className="text-xs text-mute mt-3 mb-1">Raw text exactly as exported</div>
    <pre className="bg-surface rounded-xl p-3 text-xs whitespace-pre-wrap break-words max-h-48 overflow-auto">{m.raw}</pre>
  </Modal>
}
