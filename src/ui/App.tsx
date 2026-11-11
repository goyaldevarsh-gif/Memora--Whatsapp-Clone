import { useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { MessageSquareText, Image as ImageIcon, FileText, Archive, Settings, Lock, Upload, Search as SearchIcon, ShieldCheck, WifiOff, FolderUp } from 'lucide-react'
import { db, recoverInterruptedImports } from '../lib/db'
import { ensureIndex } from '../lib/search'
import { hasPin, verifyPin } from '../lib/lock'
import { ChatList } from './ChatList'
import { ChatView } from './ChatView'
import { ContactInfo } from './ContactInfo'
import { ArchiveTab, FilesTab, MediaTab } from './Sections'
import { SearchPage } from './SearchPage'
import { ImportPage } from './ImportPage'
import { SettingsPage } from './SettingsPage'
import { BackupPage, DuplicatesPage, FlaggedPage, HistoryPage, IntegrityPage } from './Data'
import { Btn } from './common'
import { nav, useIsDesktop, useRoute } from './router'

const SECTIONS = [['chats', 'Chats', MessageSquareText], ['media', 'Media', ImageIcon], ['files', 'Files', FileText], ['archive', 'Archive', Archive], ['settings', 'Settings', Settings]] as const

function Welcome() {
  const feats: [React.ReactNode, string, string][] = [[<Upload size={22} key="a" />, 'Import WhatsApp Exports', 'Add your chat ZIP files easily'], [<MessageSquareText size={22} key="b" />, 'WhatsApp-like Experience', 'Browse chats just like before'], [<SearchIcon size={22} key="c" />, 'Powerful Search', 'Find any message, media or file'], [<ShieldCheck size={22} key="d" />, 'Private & Offline', 'Your data stays on your device']]
  return <div className="h-full overflow-auto bg-gradient-to-b from-bg to-[#0A2229] flex flex-col items-center px-6 pt-safe">
    <div className="flex-1 flex flex-col items-center justify-center py-10 max-w-md w-full">
      <MessageSquareText size={84} className="text-accent" strokeWidth={1.6} />
      <h1 className="text-5xl font-bold mt-3 tracking-tight">Memora</h1>
      <p className="text-mute text-lg mt-2 text-center">Your conversations, preserved forever.</p>
      <div className="w-full mt-10 space-y-4">{feats.map(([ic, t, s]) => <div key={t} className="flex items-center gap-4"><div className="w-12 h-12 rounded-xl bg-surface text-accent flex items-center justify-center shrink-0">{ic}</div><div><div className="font-semibold">{t}</div><div className="text-sm text-mute">{s}</div></div></div>)}</div>
      <Btn className="w-full mt-10 py-4 text-lg flex items-center justify-center gap-2" onClick={() => nav('import')}><FolderUp size={20} />Import Chats</Btn>
      <button onClick={() => nav('backup')} className="text-accent mt-4 text-sm pb-8">Restore from a Memora backup</button>
    </div></div>
}

function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  const [p, setP] = useState(''), [bad, setBad] = useState(false)
  const press = async (d: string) => { const n = (p + d).slice(0, 8); setP(n); setBad(false); if (n.length >= 4 && await verifyPin(n)) { onUnlock(); setP('') } }
  return <div className="fixed inset-0 z-[100] bg-bg flex flex-col items-center justify-center gap-6 px-6">
    <Lock size={44} className="text-accent" /><div className="text-xl font-semibold">Memora is locked</div>
    <div className="flex gap-2 h-4">{Array.from({ length: Math.max(4, p.length) }).map((_, i) => <div key={i} className={`w-3.5 h-3.5 rounded-full ${i < p.length ? 'bg-accent' : 'bg-line'}`} />)}</div>
    {bad && <div className="text-err text-sm">Wrong PIN</div>}
    <div className="grid grid-cols-3 gap-3 w-64">{['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '↵'].map(k => <button key={k} onClick={async () => { if (k === '⌫') setP(p.slice(0, -1)); else if (k === '↵') { if (await verifyPin(p)) onUnlock(); else { setBad(true); setP('') } } else press(k) }} className="h-14 rounded-2xl bg-surface text-xl active:bg-white/15">{k}</button>)}</div>
  </div>
}

export default function App() {
  const r = useRoute()
  const desktop = useIsDesktop()
  const [locked, setLocked] = useState<boolean | null>(null)
  const hiddenAt = useRef(0)
  const counts = useLiveQuery(async () => ({ c: await db.conversations.count(), z: await db.zips.count() }), [])
  const [online, setOnline] = useState(navigator.onLine)

  useEffect(() => { hasPin().then(h => setLocked(h)); recoverInterruptedImports(); const on = () => setOnline(true), off = () => setOnline(false); addEventListener('online', on); addEventListener('offline', off); return () => { removeEventListener('online', on); removeEventListener('offline', off) } }, [])
  useEffect(() => { if (counts && counts.c > 0) setTimeout(() => ensureIndex(), 300) }, [counts?.c])
  useEffect(() => {
    const f = async () => { if (document.hidden) hiddenAt.current = Date.now(); else if (hiddenAt.current && Date.now() - hiddenAt.current > 60000 && await hasPin()) setLocked(true) }
    document.addEventListener('visibilitychange', f); return () => document.removeEventListener('visibilitychange', f)
  }, [])
  if (locked === null || !counts) return <div className="h-full bg-bg" />
  if (locked) return <LockScreen onUnlock={() => setLocked(false)} />

  const [first = 'chats', arg] = r.path
  const id = arg ? Number(arg) : undefined
  const jump = r.query.get('m') ? Number(r.query.get('m')) : undefined
  const empty = counts.c === 0 && counts.z === 0
  const isSection = SECTIONS.some(s => s[0] === first)
  const twoPane = first === 'chats' || first === 'chat' || first === 'info'

  const page = (): React.ReactNode => {
    switch (first) {
      case 'chat': return id ? <ChatView key={id} convId={id} jumpTo={jump} /> : null
      case 'info': return id ? <ContactInfo convId={id} /> : null
      case 'media': return <MediaTab />
      case 'files': return <FilesTab />
      case 'archive': return <ArchiveTab />
      case 'settings': return <SettingsPage />
      case 'search': return <SearchPage />
      case 'import': return <ImportPage />
      case 'backup': return <BackupPage />
      case 'integrity': return <IntegrityPage />
      case 'duplicates': return <DuplicatesPage />
      case 'flagged': return <FlaggedPage />
      case 'history': return <HistoryPage />
      default: return null
    }
  }
  const offline = !online && <div className="bg-bg2 text-[11px] text-mute text-center py-0.5 flex items-center justify-center gap-1"><WifiOff size={11} />Offline — everything still works</div>

  if (empty && first === 'chats') return <>{offline}<Welcome /></>
  const activeSection = first === 'chat' || first === 'info' ? 'chats' : first

  if (desktop) {
    return <div className="h-full flex bg-bg">
      <nav className="w-[72px] shrink-0 bg-bg2 border-r border-line flex flex-col items-center py-4 gap-1">
        <MessageSquareText className="text-accent mb-4" size={30} />
        {SECTIONS.map(([k, l, Ic]) => <button key={k} onClick={() => nav(k)} title={l} className={`w-14 py-2 rounded-xl flex flex-col items-center gap-0.5 text-[10px] ${activeSection === k ? 'bg-accent/15 text-accent' : 'text-mute hover:bg-white/5'}`}><Ic size={21} />{l}</button>)}
        <div className="flex-1" />
        <button onClick={() => nav('search')} title="Search" className={`w-14 py-2 rounded-xl flex flex-col items-center gap-0.5 text-[10px] ${first === 'search' ? 'bg-accent/15 text-accent' : 'text-mute hover:bg-white/5'}`}><SearchIcon size={21} />Search</button>
      </nav>
      <div className="flex-1 min-w-0 flex flex-col">{offline}
        <div className="flex-1 min-h-0 flex">
          {twoPane ? <>
            <div className="w-[380px] shrink-0 border-r border-line min-h-0"><ChatList activeId={first === 'chats' ? undefined : id} /></div>
            <div className="flex-1 min-w-0 min-h-0">{first === 'chats' ? <div className="h-full wallpaper flex flex-col items-center justify-center text-mute gap-2"><MessageSquareText size={56} className="text-accent/60" /><div className="text-lg text-ink">Memora</div><div className="text-sm">Select a conversation to read it</div><div className="text-xs mt-6">🔒 Private · offline · read-only</div></div> : page()}</div>
          </> : <div className="flex-1 min-w-0 min-h-0">{page()}</div>}
        </div></div></div>
  }
  return <div className="h-full flex flex-col bg-bg">{offline}
    <div className="flex-1 min-h-0">{first === 'chats' ? <ChatList /> : page()}</div>
    {isSection && <nav className="pb-safe bg-bg2 border-t border-line flex">{SECTIONS.map(([k, l, Ic]) => <button key={k} onClick={() => nav(k)} className={`flex-1 py-2 flex flex-col items-center gap-0.5 text-[10.5px] ${activeSection === k ? 'text-accent' : 'text-mute'}`}><Ic size={22} />{l}</button>)}</nav>}
  </div>
}
