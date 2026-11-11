import { useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { FolderUp, Check, X, Loader2, Clock, AlertTriangle, ChevronDown, ChevronUp, HelpCircle } from 'lucide-react'
import { db } from '../lib/db'
import type { Decision, UnitInfo } from '../lib/importCore'
import { answerDecision, cancelAll, cancelCurrent, clearFinished, enqueue, useQueue, type QueueItem } from '../lib/importClient'
import { fmtDate, fmtNum, fmtSize } from '../lib/format'
import { Btn, Card, Header } from './common'
import { nav } from './router'

export function ImportPage() {
  const q = useQueue()
  const [drag, setDrag] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const take = (fl: FileList | null) => { if (!fl) return; const files = [...fl]; const zips = files.filter(f => /\.zip$/i.test(f.name) || f.type === 'application/zip' || f.type === 'application/x-zip-compressed'); if (zips.length) { enqueue(zips); navigator.storage?.persist?.() } }
  const active = q.some(i => ['queued', 'running', 'waiting'].includes(i.status))
  const done = q.filter(i => ['done', 'warn'].includes(i.status)).length
  return (
    <div className="h-full flex flex-col bg-bg" onDragOver={e => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)} onDrop={e => { e.preventDefault(); setDrag(false); take(e.dataTransfer.files) }}>
      <Header title="Import Chats" onBack backTo="chats" />
      <div className="flex-1 overflow-auto p-4 max-w-3xl w-full mx-auto space-y-4">
        <button onClick={() => input.current?.click()} className={`w-full border-2 border-dashed rounded-3xl py-10 px-4 flex flex-col items-center gap-3 transition ${drag ? 'border-accent bg-accent/10' : 'border-accent/50 bg-bg2'}`}>
          <FolderUp size={48} className="text-accent" /><div className="text-lg font-semibold">Upload WhatsApp Export ZIPs</div>
          <div className="text-sm text-mute">Select or drag &amp; drop one or many ZIP files</div>
          <span className="mt-1 bg-accent text-bg font-semibold rounded-xl px-6 py-2.5">Choose Files</span>
        </button>
        <input ref={input} type="file" accept=".zip,application/zip" multiple hidden onChange={e => { take(e.target.files); e.target.value = '' }} />

        {q.length > 0 && <div className="space-y-2">
          <div className="flex items-center justify-between"><div className="font-semibold">{active ? `Importing ${done + 1} of ${q.length}` : `${done} of ${q.length} imported`}</div>
            <div className="flex gap-2">{active ? <button onClick={cancelAll} className="text-sm text-err px-3 py-1.5 rounded-lg bg-err/10">Cancel all</button> : <button onClick={clearFinished} className="text-sm text-mute px-3 py-1.5">Clear list</button>}</div></div>
          {q.map(i => <QItem key={i.id} i={i} />)}
          {!active && done > 0 && <Btn className="w-full" onClick={() => nav('chats')}>View chats</Btn>}
        </div>}

        <Card className="p-4 text-sm text-mute space-y-1.5">
          <div className="font-semibold text-ink flex items-center gap-2"><HelpCircle size={16} />How to export from WhatsApp</div>
          <div><b className="text-ink">Android:</b> open chat → ⋮ → More → Export chat → <i>Include media</i> (or Without media) → save the ZIP.</div>
          <div><b className="text-ink">iPhone:</b> open chat → name at top → Export Chat → <i>Attach Media</i> → Save to Files.</div>
          <div>Memora keeps every original ZIP untouched, shows what could not be matched, and never overwrites existing data. Large ZIPs are processed one at a time in the background; a ZIP bigger than ~1.5&nbsp;GB may exceed browser memory — export those chats in smaller date ranges.</div>
        </Card>
        <ImportHistoryMini />
      </div>
    </div>
  )
}

function QItem({ i }: { i: QueueItem }) {
  const [open, setOpen] = useState(false)
  const icon = i.status === 'done' ? <Check size={18} className="text-accent" /> : i.status === 'warn' ? <AlertTriangle size={18} className="text-warn" /> : i.status === 'failed' ? <X size={18} className="text-err" /> : i.status === 'cancelled' ? <X size={18} className="text-mute" /> : i.status === 'queued' ? <Clock size={18} className="text-mute" /> : <Loader2 size={18} className="animate-spin text-accent" />
  return <Card className="p-3.5">
    <div className="flex items-center gap-3">{icon}<div className="flex-1 min-w-0"><div className="font-medium truncate">{i.name}</div><div className="text-xs text-mute">{fmtSize(i.file.size)} · {i.status === 'failed' ? <span className="text-err">{i.error}</span> : i.msg}</div></div>
      {i.status === 'running' && <button onClick={cancelCurrent} className="text-xs text-err px-2 py-1 bg-err/10 rounded-lg">Cancel</button>}
      {i.reports && <button aria-label="Toggle report" onClick={() => setOpen(!open)} className="p-1.5">{open ? <ChevronUp size={18} /> : <ChevronDown size={18} />}</button>}</div>
    {(i.status === 'running') && <div className="h-1.5 bg-bg rounded-full mt-3 overflow-hidden"><div className="h-full bg-accent transition-all" style={{ width: `${i.pct}%` }} /></div>}
    {i.status === 'waiting' && i.pending && <DecisionCard i={i} units={i.pending.units} />}
    {open && i.reports && <Reports reports={i.reports} />}
  </Card>
}

function DecisionCard({ i, units }: { i: QueueItem; units: UnitInfo[] }) {
  const [ds, setDs] = useState<Decision[]>(() => units.map(u => ({ ...u.defaultDecision })))
  const [remember, setRemember] = useState(false)
  const all = useLiveQuery(() => db.conversations.toArray(), [])
  return <div className="mt-3 space-y-3 bg-bg rounded-xl p-3 fade-in">
    <div className="text-sm font-semibold text-warn">This looks like a conversation you already have</div>
    {units.map((u, k) => <div key={k} className="space-y-2">
      <div className="text-xs text-mute">{u.chatFile} · {fmtNum(u.messageCount)} messages {u.firstTs ? `· ${fmtDate(u.firstTs)} – ${fmtDate(u.lastTs ?? u.firstTs)}` : ''}</div>
      <select value={ds[k].action === 'merge' ? `m${ds[k].convId}` : 'new'} onChange={e => { const v = e.target.value; setDs(ds.map((d, j) => j !== k ? d : v === 'new' ? { action: 'new', name: u.name, isGroup: u.isGroup } : { action: 'merge', convId: +v.slice(1), name: all?.find(c => c.id === +v.slice(1))?.name ?? u.name })) }} className="w-full bg-surface rounded-xl px-3 py-2.5 text-ink text-sm">
        <optgroup label="Likely matches">{u.candidates.map(c => <option key={c.convId} value={`m${c.convId}`}>Merge into “{c.name}” ({fmtNum(c.messageCount)} msgs)</option>)}</optgroup>
        <option value="new">Import as a separate conversation</option>
        <optgroup label="Merge into another chat">{all?.filter(c => !u.candidates.some(x => x.convId === c.id)).map(c => <option key={c.id} value={`m${c.id}`}>{c.name}</option>)}</optgroup>
      </select>
      {ds[k].action === 'new' && <input value={ds[k].name} onChange={e => setDs(ds.map((d, j) => j === k ? { ...d, name: e.target.value } : d))} placeholder="Conversation name" className="w-full bg-surface rounded-xl px-3 py-2.5 text-sm outline-none" />}
    </div>)}
    <div className="text-xs text-mute">Merging keeps every message and puts them in time order. Probable duplicates are never deleted — they're listed for you to review.</div>
    <label className="flex items-center gap-2 text-xs text-mute"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />Use the suggested choice automatically for the rest of this batch</label>
    <Btn className="w-full" onClick={() => answerDecision(i.id, ds, remember)}>Continue import</Btn>
  </div>
}

export function Reports({ reports }: { reports: import('../lib/types').ImportReport[] }) {
  return <div className="mt-3 space-y-3">{reports.map((r, k) => <div key={k} className="bg-bg rounded-xl p-3 text-sm space-y-2">
    <div className="font-semibold">{r.conversation} {r.mergedIntoExisting && <span className="text-xs font-normal text-accent">(merged)</span>}</div>
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[13px]">
      {([['Messages parsed', r.parsed], ['Outgoing', r.outgoing], ['Incoming', r.incoming], ['System', r.system], ['Media references', r.mediaRefs], ['Attachments matched', r.matched], ['Attachments missing', r.missing], ['Exported without media', r.omittedByWhatsApp], ['Unreferenced files kept', r.orphanFiles], ['Unparsed lines', r.unparsedLines], ['Unparsed timestamps', r.flaggedTimestamps], ['Probable duplicates', r.dupCandidates]] as [string, number][]).map(([l, v]) => <div key={l} className="flex justify-between"><span className="text-mute">{l}</span><span className={(l.includes('missing') || l.includes('Unparsed') || l.includes('Probable')) && v ? 'text-warn font-semibold' : ''}>{fmtNum(v)}</span></div>)}
    </div>
    <div className="text-xs text-mute">Date range: {r.firstTs ? `${fmtDate(r.firstTs)} – ${fmtDate(r.lastTs ?? r.firstTs)}` : '—'} · Format: {r.format} · Date order: {r.dateOrder}</div>
    {r.warnings.map((w, j) => <div key={j} className="text-xs text-warn flex gap-1.5"><AlertTriangle size={13} className="shrink-0 mt-0.5" />{w}</div>)}
    {r.missingNames.length > 0 && <details className="text-xs text-mute"><summary className="cursor-pointer">Missing attachment filenames ({r.missingNames.length})</summary><div className="mt-1 break-all max-h-32 overflow-auto">{r.missingNames.join(', ')}</div></details>}
  </div>)}</div>
}

function ImportHistoryMini() {
  const n = useLiveQuery(() => db.zips.count(), [])
  if (!n) return null
  return <button onClick={() => nav('history')} className="w-full text-left bg-surface rounded-2xl px-4 py-3.5 flex justify-between"><span>Import history &amp; reports</span><span className="text-mute">{n} ZIP{n === 1 ? '' : 's'}</span></button>
}
