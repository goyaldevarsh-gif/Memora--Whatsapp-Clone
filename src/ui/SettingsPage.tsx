import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Lock, HardDrive, CloudDownload, ShieldCheck, History, Copy, AlertCircle, Info, ChevronRight, Trash2, User } from 'lucide-react'
import { db, getSetting, setSetting } from '../lib/db'
import { clearPin, hasPin, setPin, verifyPin } from '../lib/lock'
import { createBackup } from '../lib/backup'
import { invalidateIndex } from '../lib/search'
import { Btn, Card, Header, Modal, download, useToast } from './common'
import { StorageBar } from './Data'
import { nav } from './router'

export function SettingsPage() {
  const pin = useLiveQuery(() => hasPin(), [])
  const myName = useLiveQuery(() => getSetting<string>('myName', ''), [])
  const lastBackup = useLiveQuery(() => db.settings.get('lastBackupAt'), [])
  const [pinModal, setPinModal] = useState<'set' | 'remove' | null>(null)
  const [wipe, setWipe] = useState(false)
  const [toast, toastEl] = useToast()
  const [name, setName] = useState<string | null>(null)
  const Row = ({ ic, label, sub, to, onClick }: { ic: React.ReactNode; label: string; sub?: string; to?: string; onClick?: () => void }) =>
    <button onClick={() => (to ? nav(to) : onClick?.())} className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-white/5 border-b border-line/40 last:border-0"><span className="text-accent">{ic}</span><div className="flex-1 min-w-0"><div>{label}</div>{sub && <div className="text-xs text-mute">{sub}</div>}</div><ChevronRight size={17} className="text-mute" /></button>
  return <div className="h-full flex flex-col bg-bg"><Header title="Settings" />
    <div className="flex-1 overflow-auto p-3 space-y-3 max-w-2xl w-full mx-auto pb-10">
      <Card className="p-4 space-y-2"><div className="flex items-center gap-2 font-medium"><User size={18} className="text-accent" />My name in group chats</div>
        <div className="text-xs text-mute">Used on future imports to tell which sender is you (individual chats are detected automatically). Fix it per chat in Contact info.</div>
        <div className="flex gap-2"><input value={name ?? myName ?? ''} onChange={e => setName(e.target.value)} placeholder="Exactly as it appears in the export" className="flex-1 bg-bg rounded-xl px-3 py-2.5 outline-none" /><Btn onClick={async () => { await setSetting('myName', (name ?? '').trim()); toast('Saved') }}>Save</Btn></div></Card>
      <Card><Row ic={<Lock size={19} />} label="App lock (PIN)" sub={pin ? 'On — locks when the app is hidden for a minute' : 'Off'} onClick={() => setPinModal(pin ? 'remove' : 'set')} /></Card>
      <Card className="p-4 space-y-3"><div className="flex items-center gap-2 font-medium"><HardDrive size={18} className="text-accent" />Storage &amp; data</div><StorageBar /></Card>
      <Card>
        <Row ic={<CloudDownload size={19} />} label="Backup & Restore" sub={lastBackup?.value ? `Last backup ${new Date(lastBackup.value as number).toLocaleDateString()}` : 'No backup yet — download one!'} to="backup" />
        <Row ic={<ShieldCheck size={19} />} label="Data integrity dashboard" to="integrity" />
        <Row ic={<History size={19} />} label="Import history & audit log" to="history" />
        <Row ic={<Copy size={19} />} label="Review duplicates" to="duplicates" />
        <Row ic={<AlertCircle size={19} />} label="Needs review (unparsed / missing)" to="flagged" />
      </Card>
      <Card className="p-4 text-sm text-mute space-y-1.5"><div className="flex items-center gap-2 font-medium text-ink"><Info size={18} className="text-accent" />About Memora</div>
        <div>Your conversations, preserved forever. Everything stays in this browser's IndexedDB: no servers, analytics, ads or AI APIs. Works offline once loaded.</div>
        <div>The PIN lock hides the app but does <b>not</b> encrypt the stored data.</div></Card>
      <Card className="p-4"><div className="flex items-center gap-2 font-medium text-err mb-1"><Trash2 size={18} />Danger zone</div><div className="text-xs text-mute mb-3">Deleting all data cannot be undone. A backup download is required first.</div><Btn kind="danger" onClick={() => setWipe(true)}>Delete all Memora data…</Btn></Card>
    </div>
    {pinModal && <PinModal mode={pinModal} onClose={() => setPinModal(null)} onDone={m => { toast(m); setPinModal(null) }} />}
    {wipe && <WipeModal onClose={() => setWipe(false)} />}
    {toastEl}</div>
}

function PinModal({ mode, onClose, onDone }: { mode: 'set' | 'remove'; onClose: () => void; onDone: (m: string) => void }) {
  const [a, setA] = useState(''), [b, setB] = useState(''), [err, setErr] = useState('')
  return <Modal title={mode === 'set' ? 'Set PIN' : 'Remove PIN'} onClose={onClose}>
    <input type="password" inputMode="numeric" autoFocus value={a} onChange={e => setA(e.target.value.replace(/\D/g, '').slice(0, 8))} placeholder={mode === 'set' ? 'New PIN (4–8 digits)' : 'Current PIN'} className="w-full bg-surface rounded-xl px-3 py-3 mb-2 outline-none tracking-widest" />
    {mode === 'set' && <input type="password" inputMode="numeric" value={b} onChange={e => setB(e.target.value.replace(/\D/g, '').slice(0, 8))} placeholder="Repeat PIN" className="w-full bg-surface rounded-xl px-3 py-3 mb-2 outline-none tracking-widest" />}
    {err && <div className="text-err text-sm mb-2">{err}</div>}
    <Btn className="w-full" onClick={async () => {
      if (mode === 'set') { if (a.length < 4) return setErr('Use at least 4 digits'); if (a !== b) return setErr('PINs do not match'); await setPin(a); onDone('PIN enabled') }
      else { if (!(await verifyPin(a))) return setErr('Wrong PIN'); await clearPin(); onDone('PIN removed') }
    }}>{mode === 'set' ? 'Enable lock' : 'Remove lock'}</Btn></Modal>
}

function WipeModal({ onClose }: { onClose: () => void }) {
  const [backedUp, setBackedUp] = useState(false), [busy, setBusy] = useState(''), [txt, setTxt] = useState('')
  return <Modal title="Delete all data" onClose={onClose}>
    <p className="text-sm text-mute mb-3">This removes every conversation, message, media file, original ZIP and bookmark from this browser.</p>
    <Btn kind="ghost" className="w-full mb-3" disabled={!!busy} onClick={async () => { setBusy('Creating backup…'); const b = await createBackup({ includeMedia: true, includeZips: true }, (_, m) => setBusy(m)); download(b, `memora-backup-before-delete-${Date.now()}.memora.zip`); setBackedUp(true); setBusy('') }}>{busy || (backedUp ? '✅ Backup downloaded' : '1. Download full backup')}</Btn>
    <input value={txt} onChange={e => setTxt(e.target.value)} disabled={!backedUp} placeholder='2. Type DELETE to confirm' className="w-full bg-surface rounded-xl px-3 py-3 mb-3 outline-none disabled:opacity-40" />
    <Btn kind="danger" className="w-full" disabled={!backedUp || txt !== 'DELETE'} onClick={async () => { await invalidateIndex(); await db.delete(); location.reload() }}>Delete everything</Btn></Modal>
}
