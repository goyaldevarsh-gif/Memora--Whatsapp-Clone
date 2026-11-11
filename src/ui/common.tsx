import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, X } from 'lucide-react'
import { initials } from '../lib/names'
import { back } from './router'

const PALETTE = ['#0D9488', '#2563EB', '#7C3AED', '#DB2777', '#D97706', '#059669', '#DC2626', '#0891B2', '#65A30D', '#9333EA']
export const colorFor = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return PALETTE[h % PALETTE.length] }

export function Avatar({ name, size = 48, group }: { name: string; size?: number; group?: boolean }) {
  return (
    <div className="shrink-0 rounded-full flex items-center justify-center font-semibold select-none" aria-hidden
      style={{ width: size, height: size, background: `linear-gradient(135deg, ${colorFor(name)}, ${colorFor(name)}99)`, fontSize: size * 0.36 }}>
      {group ? <svg width={size * .5} height={size * .5} viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><circle cx="17" cy="9" r="2.8"/><path d="M17 14c2.7 0 4.5 1.8 4.5 4.5"/></svg> : initials(name)}
    </div>
  )
}

export function Header({ title, sub, onBack, right, backTo }: { title: ReactNode; sub?: ReactNode; onBack?: boolean; right?: ReactNode; backTo?: string }) {
  return (
    <div className="pt-safe bg-bg2/95 backdrop-blur border-b border-line sticky top-0 z-20">
      <div className="h-14 px-2 flex items-center gap-1">
        {onBack && <IconBtn label="Back" onClick={() => back(backTo)}><ArrowLeft size={22} /></IconBtn>}
        <div className="flex-1 min-w-0 px-2"><div className="font-semibold text-[17px] truncate">{title}</div>{sub && <div className="text-xs text-mute truncate">{sub}</div>}</div>
        {right}
      </div>
    </div>
  )
}
export function IconBtn({ children, onClick, label, active, className = '' }: { children: ReactNode; onClick?: () => void; label: string; active?: boolean; className?: string }) {
  return <button aria-label={label} title={label} onClick={onClick} className={`w-10 h-10 shrink-0 rounded-full flex items-center justify-center hover:bg-white/10 active:bg-white/15 transition ${active ? 'text-accent' : ''} ${className}`}>{children}</button>
}
export const Btn = ({ children, onClick, kind = 'primary', disabled, className = '' }: { children: ReactNode; onClick?: () => void; kind?: 'primary' | 'ghost' | 'danger'; disabled?: boolean; className?: string }) => (
  <button disabled={disabled} onClick={onClick} className={`rounded-xl px-4 py-2.5 font-semibold text-[15px] transition disabled:opacity-40 active:scale-[.98] ${kind === 'primary' ? 'bg-accent text-bg' : kind === 'danger' ? 'bg-err/90 text-white' : 'bg-surface border border-line'} ${className}`}>{children}</button>
)
export const Card = ({ children, className = '' }: { children: ReactNode; className?: string }) => <div className={`bg-surface rounded-2xl border border-line/60 ${className}`}>{children}</div>
export const Empty = ({ icon, title, text, action }: { icon?: ReactNode; title: string; text?: string; action?: ReactNode }) => (
  <div className="h-full flex flex-col items-center justify-center text-center px-8 py-16 gap-3 fade-in">
    {icon && <div className="text-accent/80">{icon}</div>}
    <div className="text-lg font-semibold">{title}</div>
    {text && <div className="text-mute text-sm max-w-sm">{text}</div>}
    {action}
  </div>
)
export function Modal({ children, onClose, title, wide }: { children: ReactNode; onClose: () => void; title?: string; wide?: boolean }) {
  useEffect(() => { const f = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); addEventListener('keydown', f); return () => removeEventListener('keydown', f) }, [onClose])
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center fade-in" onClick={onClose}>
      <div className={`bg-bg2 border border-line w-full ${wide ? 'sm:max-w-2xl' : 'sm:max-w-md'} rounded-t-3xl sm:rounded-3xl max-h-[88dvh] overflow-auto pb-safe`} onClick={e => e.stopPropagation()}>
        <div className="flex items-center px-4 pt-4 pb-2"><div className="font-semibold text-lg flex-1">{title}</div><IconBtn label="Close" onClick={onClose}><X size={20} /></IconBtn></div>
        <div className="px-4 pb-5">{children}</div>
      </div>
    </div>
  )
}
export function useToast() {
  const [t, setT] = useState<string | null>(null)
  const tm = useRef<number>(0)
  const show = (m: string) => { setT(m); clearTimeout(tm.current); tm.current = window.setTimeout(() => setT(null), 2600) }
  const el = t ? <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[60] bg-surface border border-line px-4 py-2.5 rounded-full text-sm shadow-xl fade-in">{t}</div> : null
  return [show, el] as const
}
export function useObjectUrl(blob: Blob | undefined | null) {
  const [url, setUrl] = useState<string>()
  useEffect(() => { if (!blob) { setUrl(undefined); return } const u = URL.createObjectURL(blob); setUrl(u); return () => URL.revokeObjectURL(u) }, [blob])
  return url
}
export function download(blob: Blob, name: string) {
  const u = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 10000)
}
export function Highlight({ text, q }: { text: string; q: string }) {
  const terms = q.replace(/"/g, ' ').split(/\s+/).filter(t => t.length > 1).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (!terms.length) return <>{text}</>
  const parts = text.split(new RegExp(`(${terms.join('|')})`, 'gi'))
  return <>{parts.map((p, i) => i % 2 ? <mark key={i}>{p}</mark> : p)}</>
}
