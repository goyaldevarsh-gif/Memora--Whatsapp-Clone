import { useEffect, useRef, useState } from 'react'
import { Virtuoso } from 'react-virtuoso'
import { useLiveQuery } from 'dexie-react-hooks'
import { AlertTriangle, CheckCircle2, Download, Upload, Loader2, ShieldAlert, Undo2, Eye } from 'lucide-react'
import { db, recomputeConversation } from '../lib/db'
import { computeIntegrity, type Integrity } from '../lib/integrity'
import { createBackup, estimateBackupBytes, restoreBackup, verifyBackup } from '../lib/backup'
import { invalidateIndex, removeFromIndex, indexZip } from '../lib/search'
import { fmtDateTime, fmtNum, fmtSize } from '../lib/format'
import { Btn, Card, Empty, Header, download, useToast } from './common'
import { nav } from './router'
import { Reports } from './ImportPage'
import { MessageDetails } from './ChatView'
import type { Message } from '../lib/types'

export function useStorage() {
  const [s, setS] = useState<{ usage: number; quota: number; persisted: boolean } | null>(null)
  const load = async () => { if (!navigator.storage?.estimate) return setS(null); const e = await navigator.storage.estimate(); setS({ usage: e.usage ?? 0, quota: e.quota ?? 0, persisted: (await navigator.storage.persisted?.()) ?? false }) }
  useEffect(() => { load() }, [])
  return [s, load] as const
}

export function StorageBar() {
  const [s, reload] = useStorage()
  if (!s) return <div className="text-sm text-mute">Storage usage isn't reported by this browser.</div>
  const pct = s.quota ? (s.usage / s.quota) * 100 : 0
  return <div className="space-y-2">
    <div className="flex justify-between text-sm"><span>{fmtSize(s.usage)} used</span><span className="text-mute">{fmtSize(s.quota)} available to Memora</span></div>
    <div className="h-2 bg-bg rounded-full overflow-hidden"><div className={`h-full ${pct > 80 ? 'bg-err' : pct > 60 ? 'bg-warn' : 'bg-accent'}`} style={{ width: `${Math.min(100, pct)}%` }} /></div>
    {pct > 80 && <div className="text-xs text-err flex gap-1.5"><AlertTriangle size={14} className="shrink-0 mt-0.5" />Storage is almost full. Download a backup now and free space before importing more.</div>}
    {pct > 60 && pct <= 80 && <div className="text-xs text-warn">Storage is getting full — consider a backup.</div>}
    <div className="text-xs text-mute">{s.persisted ? '✅ Persistent storage granted — the browser will not evict your data automatically.' : '⚠ Persistent storage not granted: browsers may clear site data when space is low.'}</div>
    {!s.persisted && <button onClick={async () => { await navigator.storage.persist?.(); reload() }} className="text-sm text-accent">Request persistent storage</button>}
  </div>
}

// ---------- Backup & Restore ----------
export function BackupPage() {
  const [media, setMedia] = useState(true), [zips, setZips] = useState(true)
  const [est, setEst] = useState(0)
  const [busy, setBusy] = useState<{ pct: number; msg: string } | null>(null)
  const [verify, setVerify] = useState<{ file: File; ok: boolean; problems: string[]; counts?: string; date?: number } | null>(null)
  const [toast, toastEl] = useToast()
  const last = useLiveQuery(() => db.settings.get('lastBackupAt'), [])
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { estimateBackupBytes({ includeMedia: media, includeZips: zips }).then(setEst) }, [media, zips])
  const make = async () => {
    setBusy({ pct: 0, msg: 'Starting…' })
    try { const b = await createBackup({ includeMedia: media, includeZips: zips }, (pct, msg) => setBusy({ pct, msg })); download(b, `memora-backup-${new Date().toISOString().slice(0, 10)}.memora.zip`); toast('Backup downloaded — store it on Windows / external storage') }
    catch (e) { toast('Backup failed: ' + (e as Error).message) }
    setBusy(null)
  }
  const pick = async (f: File) => {
    setBusy({ pct: 0, msg: 'Verifying integrity…' })
    const r = await verifyBackup(f, (pct, msg) => setBusy({ pct, msg }))
    setVerify({ file: f, ok: r.ok, problems: r.problems, counts: r.manifest ? `${fmtNum(r.manifest.counts.conversations)} conversations · ${fmtNum(r.manifest.counts.messages)} messages · ${fmtNum(r.manifest.counts.attachments)} media` : undefined, date: r.manifest?.createdAt })
    setBusy(null)
  }
  const restore = async () => {
    if (!verify) return
    setBusy({ pct: 0, msg: 'Restoring…' })
    try { const r = await restoreBackup(verify.file, (pct, msg) => setBusy({ pct, msg })); toast(`Restored ${fmtNum(r.conversations)} conversations`); setVerify(null) } catch (e) { toast((e as Error).message) }
    setBusy(null)
  }
  return <div className="h-full flex flex-col bg-bg"><Header title="Backup & Restore" onBack backTo="settings" />
    <div className="flex-1 overflow-auto p-4 space-y-4 max-w-2xl w-full mx-auto">
      <Card className="p-4 bg-warn/10 border-warn/30 text-sm text-warn flex gap-2"><ShieldAlert size={18} className="shrink-0" /><div>Browser storage is <b>not</b> a permanent backup. It can be cleared if you clear site data, uninstall the app, or when the device runs low on space (iPhone Safari may also clear unused sites). Download a backup regularly and keep it on your PC / external drive.</div></Card>
      <Card className="p-4 space-y-3"><div className="font-semibold">Create complete backup</div>
        <label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={media} onChange={e => setMedia(e.target.checked)} />Include extracted media (photos, videos, voice notes, documents)</label>
        <label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={zips} onChange={e => setZips(e.target.checked)} />Include original WhatsApp ZIPs</label>
        <div className="text-xs text-mute">Estimated size ≈ {fmtSize(est)} · Last backup: {last?.value ? new Date(last.value as number).toLocaleString() : 'never'}</div>
        {est > 1.2 * 1024 ** 3 && <div className="text-xs text-warn">Very large backups can exceed browser memory. If this fails, untick “original ZIPs” (they remain downloadable one by one from Import history) or back up in parts.</div>}
        <Btn onClick={make} disabled={!!busy} className="w-full flex items-center justify-center gap-2"><Download size={18} />Download backup</Btn></Card>
      <Card className="p-4 space-y-3"><div className="font-semibold">Restore from backup</div>
        <div className="text-xs text-mute">The backup is checksum-verified first. Restore <b>adds</b> everything as new data and never overwrites what is already here — best used on a fresh install.</div>
        <Btn kind="ghost" onClick={() => input.current?.click()} disabled={!!busy} className="w-full flex items-center justify-center gap-2"><Upload size={18} />Choose backup file</Btn>
        <input ref={input} hidden type="file" accept=".zip,.memora" onChange={e => { const f = e.target.files?.[0]; if (f) pick(f); e.target.value = '' }} />
        {verify && <div className={`rounded-xl p-3 text-sm ${verify.ok ? 'bg-accent/10' : 'bg-err/10'}`}>
          {verify.ok ? <><div className="flex items-center gap-2 text-accent font-semibold"><CheckCircle2 size={17} />Integrity verified</div><div className="text-xs text-mute mt-1">{verify.counts} · created {verify.date ? new Date(verify.date).toLocaleString() : ''}</div><Btn onClick={restore} className="w-full mt-3" disabled={!!busy}>Restore</Btn></>
            : <><div className="text-err font-semibold">Backup failed verification — nothing was restored</div><ul className="text-xs mt-1 list-disc pl-4">{verify.problems.slice(0, 6).map((p, i) => <li key={i}>{p}</li>)}</ul></>}
        </div>}</Card>
      {busy && <Card className="p-4"><div className="flex items-center gap-2 text-sm mb-2"><Loader2 className="animate-spin text-accent" size={16} />{busy.msg}</div><div className="h-1.5 bg-bg rounded-full overflow-hidden"><div className="h-full bg-accent" style={{ width: `${busy.pct}%` }} /></div></Card>}
    </div>{toastEl}</div>
}

// ---------- Integrity ----------
export function IntegrityPage() {
  const [d, setD] = useState<Integrity | null>(null)
  useEffect(() => { computeIntegrity().then(setD) }, [])
  if (!d) return <div className="p-8 text-mute">Calculating…</div>
  const row = (l: string, v: number | string, bad = false, to?: string) => <button key={l} disabled={!to} onClick={() => to && nav(to)} className="w-full flex justify-between py-3 text-left border-b border-line/50 disabled:cursor-default"><span className="text-mute">{l}</span><span className={bad ? 'text-warn font-semibold' : ''}>{typeof v === 'number' ? fmtNum(v) : v}{bad && to ? ' ›' : ''}</span></button>
  return <div className="h-full flex flex-col bg-bg"><Header title="Data Integrity" onBack backTo="settings" />
    <div className="flex-1 overflow-auto p-4 max-w-2xl w-full mx-auto space-y-4">
      <Card className={`p-4 flex gap-3 ${d.clean ? 'bg-accent/10' : 'bg-warn/10 border-warn/30'}`}>{d.clean ? <CheckCircle2 className="text-accent shrink-0" /> : <AlertTriangle className="text-warn shrink-0" />}
        <div><div className="font-semibold">{d.messages === 0 ? 'Nothing imported yet' : d.clean ? 'Everything imported cleanly' : 'Some items need your attention'}</div>
          <div className="text-sm text-mute">{d.clean ? 'All parsed messages and media are accounted for.' : 'Memora never reports a perfect import when messages or media were skipped, missing, or unreviewed.'}</div></div></Card>
      <Card className="px-4">
        {row('ZIPs imported', d.zips, false, 'history')}{row('Conversations', d.conversations)}{row('Messages', d.messages)}{row('Media files stored', d.mediaFiles)}
        {row('Attachments linked to messages', d.attachmentsOk)}{row('Missing attachments (referenced, not in ZIP)', d.attachmentsMissing, d.attachmentsMissing > 0, 'flagged')}
        {row('Exported without media by WhatsApp', d.omittedByWhatsApp, d.omittedByWhatsApp > 0)}{row('Parsing errors (unparsed lines / timestamps)', d.parsingErrors, d.parsingErrors > 0, 'flagged')}
        {row('Unreviewed duplicate candidates', d.dupCandidates, d.dupCandidates > 0, 'duplicates')}{row('Failed / cancelled imports', d.failedImports, d.failedImports > 0, 'history')}
        {d.mediaSuccessPct !== null && row('Media recovered', `${d.mediaSuccessPct}%`, d.mediaSuccessPct < 100)}</Card>
    </div></div>
}

// ---------- Duplicates ----------
export function DuplicatesPage() {
  const [toast, toastEl] = useToast()
  const rows = useLiveQuery(async () => {
    const pend = await db.messages.where('dupState').anyOf('pending', 'hidden').toArray()
    const others = await db.messages.bulkGet(pend.map(p => p.dupOf!))
    const convs = new Map((await db.conversations.toArray()).map(c => [c.id!, c.name]))
    const zips = new Map((await db.zips.toArray()).map(z => [z.id!, z.name]))
    return pend.map((m, i) => ({ m, other: others[i], conv: convs.get(m.convId), zip: zips.get(m.zipId), ozip: others[i] ? zips.get(others[i]!.zipId) : '' }))
  }, [])
  const set = async (m: Message, state: 'kept' | 'hidden' | 'pending') => {
    await db.messages.update(m.id!, { dupState: state, hidden: state === 'hidden' || undefined })
    if (state === 'hidden') removeFromIndex(m.id!); else if (state === 'kept') await invalidateIndex()
    await recomputeConversation(m.convId)
  }
  const keepAll = async () => { const p = rows?.filter(r => r.m.dupState === 'pending') ?? []; for (const r of p) await db.messages.update(r.m.id!, { dupState: 'kept' }); toast(`Kept all ${p.length}`) }
  return <div className="h-full flex flex-col bg-bg"><Header title="Duplicate review" sub="Probable duplicates from overlapping exports" onBack backTo="settings" right={rows?.some(r => r.m.dupState === 'pending') ? <button onClick={keepAll} className="text-sm text-accent px-3">Keep all</button> : undefined} />
    <div className="flex-1 min-h-0">{!rows?.length ? <Empty icon={<CheckCircle2 size={42} />} title="No duplicate candidates" text="When you merge overlapping exports, messages that look identical are listed here. Nothing is removed automatically." /> :
      <Virtuoso data={rows} itemContent={(_, { m, other, conv, zip, ozip }) => <div className="px-3 py-1.5"><Card className="p-3 text-sm space-y-2">
        <div className="text-xs text-mute">{conv} · {fmtDateTime(m.ts, m.rawTs)} · {m.sender}</div>
        <div className="whitespace-pre-wrap line-clamp-3">{m.body}</div>
        <div className="text-[11px] text-mute">New: {zip} · Already had: {ozip} {other ? `(“${other.body.slice(0, 30)}…”)` : ''}</div>
        <div className="flex gap-2">{m.dupState === 'hidden' ? <button onClick={() => set(m, 'pending')} className="flex items-center gap-1 text-accent text-sm"><Undo2 size={14} />Undo hide</button> : <>
          <button onClick={() => set(m, 'kept')} className="px-3 py-1.5 rounded-lg bg-surface border border-line">Keep both</button>
          <button onClick={() => set(m, 'hidden')} className="px-3 py-1.5 rounded-lg bg-warn/15 text-warn">Hide the new copy</button></>}
          <span className="flex-1" />{m.dupState === 'kept' ? <span className="text-xs text-mute self-center">kept</span> : m.dupState === 'hidden' ? <span className="text-xs text-warn self-center">hidden (reversible)</span> : null}</div>
      </Card></div>} />}</div>{toastEl}</div>
}

// ---------- Flagged / unparsed ----------
export function FlaggedPage() {
  const rows = useLiveQuery(async () => {
    const all = await db.messages.where('flagged').notEqual('').toArray()
    const missing: Message[] = []; await db.messages.filter(m => !!m.attName && !m.attId).each(m => { missing.push(m) })
    const convs = new Map((await db.conversations.toArray()).map(c => [c.id!, c.name]))
    return { flagged: all.filter(m => !m.reviewed).slice(0, 500).map(m => ({ m, conv: convs.get(m.convId) })), missing: missing.slice(0, 500).map(m => ({ m, conv: convs.get(m.convId) })) }
  }, [])
  const [detail, setDetail] = useState<Message | null>(null)
  if (!rows) return null
  const empty = !rows.flagged.length && !rows.missing.length
  return <div className="h-full flex flex-col bg-bg"><Header title="Needs review" sub="Unparsed text, unreadable timestamps, missing attachments" onBack backTo="settings" />
    <div className="flex-1 overflow-auto p-3 space-y-2">
      {empty && <Empty icon={<CheckCircle2 size={42} />} title="Nothing to review" />}
      {rows.flagged.length > 0 && <div className="text-xs uppercase text-mute px-1 pt-1">Flagged messages ({rows.flagged.length})</div>}
      {rows.flagged.map(({ m, conv }) => <Card key={m.id} className="p-3 text-sm space-y-1.5"><div className="text-xs text-warn">{m.flagged}</div><div className="text-xs text-mute">{conv} · raw timestamp “{m.rawTs || '—'}” · {m.srcFile}:{m.lineNo}</div>
        <pre className="text-xs bg-bg rounded-lg p-2 whitespace-pre-wrap break-words max-h-28 overflow-auto">{m.raw}</pre>
        <div className="flex gap-3"><button className="text-accent text-sm flex items-center gap-1" onClick={() => nav(`chat/${m.convId}?m=${m.id}`)}><Eye size={14} />Open in chat</button><button className="text-sm text-mute" onClick={() => db.messages.update(m.id!, { reviewed: true })}>Mark reviewed</button><button className="text-sm text-mute" onClick={() => setDetail(m)}>Details</button></div></Card>)}
      {rows.missing.length > 0 && <div className="text-xs uppercase text-mute px-1 pt-3">Attachments referenced but not in the ZIP ({rows.missing.length})</div>}
      {rows.missing.map(({ m, conv }) => <Card key={m.id} className="p-3 text-sm"><div className="font-medium break-all">{m.attName}</div><div className="text-xs text-mute">{conv} · {fmtDateTime(m.ts, m.rawTs)}</div><button className="text-accent text-sm mt-1" onClick={() => nav(`chat/${m.convId}?m=${m.id}`)}>Open in chat</button></Card>)}
    </div>{detail && <MessageDetails m={detail} onClose={() => setDetail(null)} />}</div>
}

// ---------- Import history ----------
export function HistoryPage() {
  const zips = useLiveQuery(() => db.zips.orderBy('importedAt').reverse().toArray(), [])
  const logs = useLiveQuery(() => db.logs.orderBy('ts').reverse().limit(60).toArray(), [])
  const [open, setOpen] = useState<number | null>(null)
  const [showLog, setShowLog] = useState(false)
  return <div className="h-full flex flex-col bg-bg"><Header title="Import history" onBack backTo="settings" right={<button onClick={() => setShowLog(!showLog)} className="text-sm text-accent px-3">{showLog ? 'ZIPs' : 'Audit log'}</button>} />
    <div className="flex-1 overflow-auto p-3 space-y-2 max-w-3xl w-full mx-auto">
      {showLog ? logs?.map(l => <div key={l.id} className="text-xs border-b border-line/40 py-2"><span className={l.level === 'error' ? 'text-err' : l.level === 'warn' ? 'text-warn' : 'text-accent'}>{l.level.toUpperCase()}</span> <span className="text-mute">{new Date(l.ts).toLocaleString()}</span><div className="mt-0.5">{l.msg}</div></div>) :
        !zips?.length ? <Empty title="No imports yet" /> : zips.map(z => <Card key={z.id} className="p-3.5">
          <div className="flex items-center gap-3"><div className="flex-1 min-w-0"><div className="font-medium truncate">{z.name}</div><div className="text-xs text-mute">{fmtSize(z.size)} · {new Date(z.importedAt).toLocaleString()} · <span className={z.status === 'done' ? 'text-accent' : z.status === 'done_with_warnings' ? 'text-warn' : 'text-err'}>{z.status.replace(/_/g, ' ')}</span></div>{z.error && <div className="text-xs text-err mt-1">{z.error}</div>}</div>
            <button aria-label="Download original ZIP" className="p-2 rounded-full hover:bg-white/10" onClick={() => download(z.blob, z.name)}><Download size={18} /></button>
            {z.reports.length > 0 && <button className="text-xs text-accent" onClick={() => setOpen(open === z.id ? null : z.id!)}>{open === z.id ? 'Hide' : 'Report'}</button>}</div>
          {open === z.id && <Reports reports={z.reports} />}</Card>)}
    </div></div>
}
