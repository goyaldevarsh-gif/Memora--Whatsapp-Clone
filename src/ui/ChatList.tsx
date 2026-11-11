import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Search, Plus, Star, Archive as ArchiveIcon, ArrowUpDown, MessageSquareText } from 'lucide-react'
import { db, previewOf } from '../lib/db'
import { listStamp, fmtNum } from '../lib/format'
import { Avatar, Empty, IconBtn, Modal, Btn } from './common'
import { nav } from './router'
import { searchState } from '../lib/search'

type Sort = 'recent' | 'oldest' | 'alpha' | 'most' | 'imported'
const SORTS: [Sort, string][] = [['recent', 'Most recent'], ['oldest', 'Oldest'], ['alpha', 'Alphabetical'], ['most', 'Most messages'], ['imported', 'Recently imported']]

export function ChatList({ activeId, showArchived = false }: { activeId?: number; showArchived?: boolean }) {
  const convs = useLiveQuery(() => db.conversations.toArray(), [])
  const [sort, setSort] = useState<Sort>(() => (localStorage.getItem('sort') as Sort) || 'recent')
  const [menu, setMenu] = useState(false)
  const [filter, setFilter] = useState('')
  const list = useMemo(() => {
    if (!convs) return []
    let l = convs.filter(c => c.messageCount > 0 && (showArchived ? c.archived : !c.archived))   // chats of a half-finished (resumable) import stay hidden until complete
    if (filter) l = l.filter(c => c.name.toLowerCase().includes(filter.toLowerCase()))
    const by: Record<Sort, (a: typeof l[0], b: typeof l[0]) => number> = {
      recent: (a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0), oldest: (a, b) => (a.firstTs ?? 0) - (b.firstTs ?? 0),
      alpha: (a, b) => a.name.localeCompare(b.name), most: (a, b) => b.messageCount - a.messageCount, imported: (a, b) => b.importedAt - a.importedAt
    }
    return [...l].sort((a, b) => Number(b.favourite) - Number(a.favourite) || by[sort](a, b))
  }, [convs, sort, filter, showArchived])

  return (
    <div className="h-full flex flex-col bg-bg">
      <div className="pt-safe bg-bg2/95 border-b border-line">
        <div className="h-14 px-3 flex items-center gap-1">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <MessageSquareText className="text-accent" size={26} /><span className="text-[22px] font-bold tracking-tight">Memora</span>
          </div>
          <IconBtn label="Search everything" onClick={() => nav('search')}><Search size={21} /></IconBtn>
          <IconBtn label="Sort" onClick={() => setMenu(true)}><ArrowUpDown size={20} /></IconBtn>
          <IconBtn label="Import chats" onClick={() => nav('import')} className="bg-accent/15 text-accent"><Plus size={22} /></IconBtn>
        </div>
        {convs && convs.length > 6 && <div className="px-3 pb-2"><input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter chats" className="w-full bg-surface rounded-xl px-3.5 py-2 text-[15px] outline-none placeholder:text-mute" /></div>}
      </div>
      {!searchState.ready && searchState.total > 0 && searchState.indexed < searchState.total && <div className="text-[11px] text-mute px-4 py-1 bg-bg2">Indexing search… {Math.round(searchState.indexed / searchState.total * 100)}%</div>}
      <div className="flex-1 overflow-auto">
        {convs && list.length === 0 && <Empty icon={<MessageSquareText size={44} />} title={convs.length ? 'No chats here' : 'No conversations yet'} text={convs.length ? 'Nothing matches this view.' : 'Import your WhatsApp export ZIPs to build your archive.'} action={!convs.length && <Btn onClick={() => nav('import')}>Import chats</Btn>} />}
        {list.map(c => (
          <button key={c.id} onClick={() => nav(`chat/${c.id}`)} className={`w-full text-left flex items-center gap-3 px-3.5 py-3 border-b border-line/40 hover:bg-white/5 active:bg-white/10 ${activeId === c.id ? 'bg-white/10' : ''}`}>
            <Avatar name={c.name} group={c.isGroup} size={52} />
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-2">
                <div className="font-semibold text-[16px] truncate flex-1 flex items-center gap-1.5">{c.name}{c.favourite && <Star size={13} className="text-warn" fill="currentColor" />}{c.archived && <ArchiveIcon size={13} className="text-mute" />}</div>
                <div className="text-xs text-mute shrink-0">{listStamp(c.lastTs)}</div>
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <div className="text-[14px] text-mute truncate flex-1">{c.lastSender && c.isGroup ? <span>{c.lastSender.split(' ')[0]}: </span> : c.lastSender && c.lastSender === c.meName ? <span>You: </span> : null}{c.lastPreview || previewOf({ kind: c.lastKind, body: '' })}</div>
                <div className="text-[11px] text-mute/80 shrink-0 bg-surface rounded-full px-2 py-0.5">{fmtNum(c.messageCount)}</div>
              </div>
            </div>
          </button>
        ))}
      </div>
      {menu && <Modal title="Sort chats" onClose={() => setMenu(false)}>
        <div className="flex flex-col gap-1">{SORTS.map(([k, l]) => <button key={k} onClick={() => { setSort(k); localStorage.setItem('sort', k); setMenu(false) }} className={`text-left px-3 py-3 rounded-xl ${sort === k ? 'bg-accent/15 text-accent' : 'hover:bg-white/5'}`}>{l}</button>)}</div>
      </Modal>}
    </div>
  )
}
