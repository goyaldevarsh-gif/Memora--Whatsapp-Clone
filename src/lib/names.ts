/** Conversation name from the ZIP filename, e.g. "WhatsApp Chat with Aditi (1).zip" -> "Aditi". */
export function nameFromFile(file: string): string {
  const base = file.split('/').pop() ?? file
  let n = base.replace(/\.(zip|txt)$/i, '')
  n = n.replace(/^whatsapp chat\s*(with|-|–|—)\s*/i, '').replace(/^chat with\s+/i, '').replace(/^whatsapp chat\s+/i, '')
  n = n.replace(/\s*\(\d+\)\s*$/, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
  return n || 'Imported chat'
}

/** Key for "probably the same contact" matching: Aditi, Aditi_2, Aditi Old Chat, Aditi (1) -> "aditi". */
export function matchKey(name: string): string {
  let n = name.toLowerCase().normalize('NFC').replace(/_/g, ' ')
  for (let i = 0; i < 4; i++) {
    const next = n.replace(/[\s-]*(\(?\d+\)?|old chat|old|backup|export|exported|new|copy|chat|part\s*\d+)\s*$/i, '')
    if (next === n || next.trim() === '') break
    n = next
  }
  return n.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

export function initials(name: string): string {
  const parts = name.replace(/[^\p{L}\p{N}\s]/gu, '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '#'
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}

export function guessIsGroup(senders: string[], systemBodies: string[]): boolean {
  if (senders.length > 2) return true
  return systemBodies.some(b => /created group|created this group|added you|changed the group|joined using this group|changed this group's/i.test(b))
}

export function sameName(a: string, b: string): boolean {
  const x = a.trim().toLowerCase(), y = b.trim().toLowerCase()
  return x === y
}

export function guessMe(convName: string, senders: string[], isGroup: boolean, globalMe?: string | null): string | null {
  const lc = senders.map(s => s.toLowerCase())
  if (globalMe) { const i = lc.indexOf(globalMe.trim().toLowerCase()); if (i >= 0) return senders[i] }
  if (isGroup || senders.length !== 2) return null
  const cn = convName.trim().toLowerCase()
  const k = matchKey(convName)
  const hit = senders.findIndex(s => { const l = s.toLowerCase(); return l === cn || (k && matchKey(s) === k) || (cn.length > 2 && (l.includes(cn) || cn.includes(l))) })
  if (hit < 0) return null
  return senders[1 - hit]
}
