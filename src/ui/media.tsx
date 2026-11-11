import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, FileText, FileSpreadsheet, Presentation, FileArchive, File as FileIcon, Play, Pause, X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, AlertTriangle, MapPin, UserRound, Mic } from 'lucide-react'
import { db } from '../lib/db'
import type { Attachment } from '../lib/types'
import { download, useObjectUrl, IconBtn } from './common'
import { extOf, fmtDur, fmtSize } from '../lib/format'

export function useAttachment(id?: number) {
  const [att, setAtt] = useState<Attachment | undefined>()
  useEffect(() => { let off = false; setAtt(undefined); if (id) db.attachments.get(id).then(a => { if (!off) setAtt(a) }); return () => { off = true } }, [id])
  return att
}

export interface ViewerItem { id: number; kind: string; name: string }

export function ImageThumb({ attId, onOpen, className = '', cover = true }: { attId: number; onOpen?: () => void; className?: string; cover?: boolean }) {
  const att = useAttachment(attId)
  const url = useObjectUrl(att?.blob)
  const [err, setErr] = useState(false)
  const [retry, setRetry] = useState<string | null>(null)
  const [broken, setBroken] = useState(false)
  // iOS Safari sometimes hands back a blob it cannot decode: re-wrap the bytes with an explicit type once; if the bytes are empty, say so.
  useEffect(() => {
    if (!err || !att || retry || broken) return
    let u: string | null = null
    att.blob.arrayBuffer().then(ab => { if (!ab.byteLength) return setBroken(true); u = URL.createObjectURL(new Blob([ab], { type: att.mime.startsWith('image/') ? att.mime : 'image/jpeg' })); setRetry(u) }).catch(() => setBroken(true))
    return () => { if (u) URL.revokeObjectURL(u) }
  }, [err, att, retry, broken])
  if (!att) return <div className={`bg-surface animate-pulse ${className}`} style={{ minHeight: 120 }} />
  if (broken) return <div><FileCard att={att} compact /><div className="text-[11px] text-warn mt-1">This stored copy cannot be read on this device. Try Download, or import this ZIP again.</div></div>
  if (err && retry) return <img src={retry} alt={att.name} onClick={onOpen} onError={() => setBroken(true)} className={`${cover ? 'object-cover' : 'object-contain'} cursor-zoom-in ${className}`} />
  if (err || !url) return <FileCard att={att} compact />
  return <img src={url} alt={att.name} loading="lazy" onError={() => setErr(true)} onClick={onOpen} className={`${cover ? 'object-cover' : 'object-contain'} cursor-zoom-in ${className}`} />
}

export function VideoThumb({ attId, onOpen, className = '' }: { attId: number; onOpen?: () => void; className?: string }) {
  const att = useAttachment(attId)
  const url = useObjectUrl(att?.blob)
  if (!att) return <div className={`bg-surface animate-pulse ${className}`} style={{ minHeight: 120 }} />
  return (
    <div className={`relative cursor-pointer ${className}`} onClick={onOpen}>
      <video src={url ? url + '#t=0.1' : undefined} preload="metadata" muted playsInline className="w-full h-full object-cover bg-black" />
      <div className="absolute inset-0 flex items-center justify-center"><div className="w-12 h-12 rounded-full bg-black/55 flex items-center justify-center"><Play size={22} fill="white" /></div></div>
    </div>
  )
}

function seeded(seed: string, n: number) { let h = 2166136261; for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return Array.from({ length: n }, () => { h = Math.imul(h ^ (h >>> 13), 1274126177); return 0.25 + (((h >>> 0) % 1000) / 1000) * 0.75 }) }

export function AudioPlayer({ attId, voice }: { attId: number; voice: boolean }) {
  const att = useAttachment(attId)
  const url = useObjectUrl(att?.blob)
  const ref = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false), [cur, setCur] = useState(0), [dur, setDur] = useState(0), [bars, setBars] = useState<number[] | null>(null), [bad, setBad] = useState(false)
  const N = 38
  // Real waveform when the browser can decode the file; stylised bars otherwise.
  useEffect(() => {
    if (!att || att.size > 6 * 1024 * 1024) return
    let off = false
    ;(async () => {
      try {
        const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        const ctx = new AC(); const buf = await ctx.decodeAudioData(await att.blob.arrayBuffer()); ctx.close()
        const d = buf.getChannelData(0), step = Math.floor(d.length / N), out: number[] = []
        for (let i = 0; i < N; i++) { let s = 0; for (let j = 0; j < step; j += Math.max(1, Math.floor(step / 40))) s += Math.abs(d[i * step + j]); out.push(s) }
        const mx = Math.max(...out) || 1
        if (!off) { setBars(out.map(v => 0.2 + (v / mx) * 0.8)); setDur(prev => prev || buf.duration) }
      } catch { /* undecodable here: keep stylised bars */ }
    })()
    return () => { off = true }
  }, [att])
  const b = useMemo(() => bars ?? seeded(att?.name ?? 'x', N), [bars, att])
  const toggle = () => { const a = ref.current; if (!a) return; if (a.paused) a.play().catch(() => setBad(true)); else a.pause() }
  if (!att) return <div className="h-12 w-56 bg-white/5 rounded-xl animate-pulse" />
  const pct = dur ? cur / dur : 0
  return (
    <div className="flex items-center gap-2 w-64 max-w-full">
      <audio ref={ref} src={url} preload="metadata" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => { setPlaying(false); setCur(0) }}
        onTimeUpdate={e => setCur(e.currentTarget.currentTime)} onLoadedMetadata={e => isFinite(e.currentTarget.duration) && setDur(e.currentTarget.duration)} onError={() => setBad(true)} />
      <button onClick={toggle} aria-label={playing ? 'Pause' : 'Play'} className="w-10 h-10 rounded-full bg-accent text-bg flex items-center justify-center shrink-0">{playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}</button>
      <div className="flex-1 min-w-0">
        <div className="flex items-end gap-[2px] h-8 cursor-pointer" onClick={e => { const r = e.currentTarget.getBoundingClientRect(); const a = ref.current; if (a && dur) a.currentTime = ((e.clientX - r.left) / r.width) * dur }}>
          {b.map((v, i) => <div key={i} className="flex-1 rounded-full" style={{ height: `${v * 100}%`, background: i / N < pct ? '#35D6AD' : 'rgba(255,255,255,.35)' }} />)}
        </div>
        <div className="text-[11px] text-mute flex justify-between mt-0.5"><span>{fmtDur(playing || cur ? cur : dur)}</span>{voice && <Mic size={11} />}</div>
      </div>
      {bad && <button title="This browser can't play this audio format (WhatsApp uses Opus). Click to download." onClick={() => download(att.blob, att.name)}><AlertTriangle size={16} className="text-warn" /></button>}
    </div>
  )
}

const iconFor = (ext: string) => ['PDF', 'DOC', 'DOCX', 'TXT'].includes(ext) ? FileText : ['XLS', 'XLSX', 'CSV'].includes(ext) ? FileSpreadsheet : ['PPT', 'PPTX'].includes(ext) ? Presentation : ['ZIP', 'RAR', '7Z'].includes(ext) ? FileArchive : ext === 'VCF' ? UserRound : FileIcon
const colorForExt = (ext: string) => ext === 'PDF' ? '#E35D68' : ['XLS', 'XLSX'].includes(ext) ? '#35D6AD' : ['PPT', 'PPTX'].includes(ext) ? '#E5A44D' : ['DOC', 'DOCX'].includes(ext) ? '#5B9BF0' : '#9AAEB4'

export function FileCard({ att, compact, onOpen }: { att: Attachment; compact?: boolean; onOpen?: () => void }) {
  const ext = extOf(att.name); const Ic = iconFor(ext)
  return (
    <div className={`flex items-center gap-3 bg-black/20 rounded-xl p-2.5 ${compact ? '' : 'w-64 max-w-full'}`}>
      <div className="w-11 h-11 rounded-lg flex items-center justify-center shrink-0" style={{ background: colorForExt(ext) + '25', color: colorForExt(ext) }}><Ic size={22} /></div>
      <div className="min-w-0 flex-1 cursor-pointer" onClick={onOpen}><div className="text-sm truncate">{att.name}</div><div className="text-[11px] text-mute">{ext} · {fmtSize(att.size)}</div></div>
      <button aria-label="Download" onClick={() => download(att.blob, att.name)} className="p-2 rounded-full hover:bg-white/10"><Download size={18} /></button>
    </div>
  )
}

export function DocAttachment({ attId, onOpen }: { attId: number; onOpen?: (a: Attachment) => void }) {
  const att = useAttachment(attId)
  if (!att) return <div className="h-16 w-64 bg-white/5 rounded-xl animate-pulse" />
  return <FileCard att={att} onOpen={() => onOpen?.(att)} />
}

export function MissingAttachment({ name, omitted }: { name?: string; omitted?: boolean }) {
  return (
    <div className="flex items-center gap-2 bg-warn/10 border border-warn/30 text-warn rounded-xl px-3 py-2 text-[13px] max-w-[260px]">
      <AlertTriangle size={16} className="shrink-0" />
      <div className="min-w-0"><div className="font-medium">Attachment unavailable</div><div className="text-[11px] opacity-80 truncate">{omitted ? 'Exported without media' : name}</div></div>
    </div>
  )
}

export function LocationCard({ text }: { text: string }) {
  const url = /https?:\/\/\S+/.exec(text)?.[0]
  return (
    <a href={url} target="_blank" rel="noreferrer" className="flex items-center gap-3 bg-black/20 rounded-xl p-3 w-64 max-w-full">
      <MapPin className="text-err" /><div className="text-sm"><div className="font-medium">Location</div><div className="text-[11px] text-mute truncate">{url ?? text}</div></div>
    </a>
  )
}

/** Full-screen viewer for images / videos / PDFs, with zoom + download + prev/next. */
export function Viewer({ items, start, onClose }: { items: ViewerItem[]; start: number; onClose: () => void }) {
  const [i, setI] = useState(start)
  const it = items[i]
  const att = useAttachment(it?.id)
  const url = useObjectUrl(att?.blob)
  const [scale, setScale] = useState(1), [pos, setPos] = useState({ x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null)
  const pinch = useRef<{ d: number; s: number } | null>(null)
  useEffect(() => { setScale(1); setPos({ x: 0, y: 0 }) }, [i])
  useEffect(() => {
    const f = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); if (e.key === 'ArrowRight') setI(v => Math.min(items.length - 1, v + 1)); if (e.key === 'ArrowLeft') setI(v => Math.max(0, v - 1)) }
    addEventListener('keydown', f); return () => removeEventListener('keydown', f)
  }, [items.length, onClose])
  if (!it) return null
  const isImg = att?.mime.startsWith('image/'), isVid = att?.mime.startsWith('video/'), isPdf = att?.mime === 'application/pdf'
  const dist = (t: React.TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
  return (
    <div className="fixed inset-0 z-[70] bg-black/95 flex flex-col fade-in" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="pt-safe flex items-center gap-1 px-2 h-14 text-white shrink-0">
        <IconBtn label="Close" onClick={onClose}><X size={22} /></IconBtn>
        <div className="flex-1 min-w-0 px-2 text-sm truncate">{att?.name ?? it.name}<span className="text-mute ml-2">{i + 1}/{items.length}</span></div>
        {isImg && <><IconBtn label="Zoom out" onClick={() => setScale(s => Math.max(1, s - 0.5))}><ZoomOut size={20} /></IconBtn><IconBtn label="Zoom in" onClick={() => setScale(s => Math.min(6, s + 0.5))}><ZoomIn size={20} /></IconBtn></>}
        {att && <IconBtn label="Download" onClick={() => download(att.blob, att.name)}><Download size={20} /></IconBtn>}
      </div>
      <div className="flex-1 min-h-0 relative flex items-center justify-center overflow-hidden select-none"
        onWheel={e => isImg && setScale(s => Math.min(6, Math.max(1, s - e.deltaY * 0.002)))}
        onClick={e => { if (e.target === e.currentTarget) onClose() }}>
        {url && isImg && <img src={url} alt={att!.name} draggable={false}
          onDoubleClick={() => { setScale(s => s > 1 ? 1 : 2.5); setPos({ x: 0, y: 0 }) }}
          onMouseDown={e => { drag.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y } }}
          onMouseMove={e => { if (drag.current && scale > 1) setPos({ x: drag.current.px + e.clientX - drag.current.x, y: drag.current.py + e.clientY - drag.current.y }) }}
          onMouseUp={() => { drag.current = null }} onMouseLeave={() => { drag.current = null }}
          onTouchStart={e => { if (e.touches.length === 2) pinch.current = { d: dist(e.touches), s: scale }; else drag.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, px: pos.x, py: pos.y } }}
          onTouchMove={e => { if (e.touches.length === 2 && pinch.current) setScale(Math.min(6, Math.max(1, pinch.current.s * dist(e.touches) / pinch.current.d))); else if (drag.current && scale > 1) setPos({ x: drag.current.px + e.touches[0].clientX - drag.current.x, y: drag.current.py + e.touches[0].clientY - drag.current.y }) }}
          onTouchEnd={() => { drag.current = null; pinch.current = null }}
          style={{ transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})`, touchAction: 'none', cursor: scale > 1 ? 'grab' : 'zoom-in' }} className="max-w-full max-h-full object-contain transition-transform duration-75" />}
        {url && isVid && <video src={url} controls autoPlay playsInline className="max-w-full max-h-full" />}
        {url && isPdf && <iframe src={url} title={att!.name} className="w-full h-full bg-white" />}
        {att && !isImg && !isVid && !isPdf && <div className="text-center text-white p-6"><FileCard att={att} /><p className="text-mute text-sm mt-3">This file type can't be previewed in the browser. Download it to open it.</p></div>}
        {att && isImg && !url && null}
        {att && /heic|heif/.test(att.mime) && <div className="absolute bottom-4 text-xs text-warn bg-black/60 px-3 py-1.5 rounded-full">HEIC may not display in this browser — use Download.</div>}
        {i > 0 && <button aria-label="Previous" onClick={() => setI(i - 1)} className="absolute left-2 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-black/50 text-white flex items-center justify-center"><ChevronLeft /></button>}
        {i < items.length - 1 && <button aria-label="Next" onClick={() => setI(i + 1)} className="absolute right-2 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-black/50 text-white flex items-center justify-center"><ChevronRight /></button>}
      </div>
    </div>
  )
}
