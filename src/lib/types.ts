export type MsgKind =
  | 'text' | 'image' | 'video' | 'voice' | 'audio' | 'document' | 'sticker' | 'gif'
  | 'location' | 'contact' | 'deleted' | 'call' | 'system' | 'omitted' | 'unparsed'

export interface Conversation {
  id?: number
  name: string
  isGroup: boolean
  meName: string | null          // which sender is "me" (outgoing bubbles)
  firstTs: number | null
  lastTs: number | null
  messageCount: number
  attachmentCount: number
  lastPreview: string
  lastSender: string
  lastKind: MsgKind
  favourite: boolean
  archived: boolean
  importedAt: number
  sourceZipIds: number[]
}

export interface Message {
  id?: number
  convId: number
  seq: number                     // original order within conversation (monotonic)
  sortTs: number                  // chronological sort key (naive-UTC ms)
  ts: number | null               // parsed timestamp, naive-UTC ms (displayed with UTC getters => exact original clock time)
  rawTs: string                   // timestamp string exactly as exported
  sender: string                  // '' for system messages
  isMe: boolean
  body: string
  kind: MsgKind
  attName?: string
  attId?: number
  attMissing?: boolean
  zipId: number
  srcFile: string
  lineNo: number
  raw: string                     // original raw lines of this message (for future re-parsing)
  flagged?: string                // reason this needs review
  reviewed?: boolean              // user acknowledged the flag
  dupKey: string
  dupOf?: number                  // id of probable duplicate already in archive
  dupState?: 'pending' | 'kept' | 'hidden'
  hidden?: boolean                // soft-hidden by explicit user decision (reversible)
}

export interface Attachment {
  id?: number
  convId: number
  zipId: number
  name: string
  path: string
  mime: string
  size: number
  kind: MsgKind
  blob: Blob
  messageId?: number
  orphan?: boolean
  ts?: number | null
}

export interface ImportReport {
  zipName: string
  conversation: string
  conversationId: number
  mergedIntoExisting: boolean
  chatFiles: string[]
  parsed: number
  outgoing: number
  incoming: number
  system: number
  mediaRefs: number
  matched: number
  missing: number
  omittedByWhatsApp: number
  orphanFiles: number
  unparsedLines: number
  flaggedTimestamps: number
  firstTs: number | null
  lastTs: number | null
  dupCandidates: number
  dateOrder: string
  format: string
  warnings: string[]
  missingNames: string[]
  storageFailed: string[]        // files the browser's storage refused to save even after retries (reported, never silent)
}

export interface ZipRecord {
  id?: number
  name: string
  size: number
  blob: Blob
  importedAt: number
  appVersion?: string
  lastPhase?: string               // last checkpoint written during import (shows where an interrupted import died)
  originalKept: boolean            // false => the (large) original was not copied into Memora; user still has it on their device
  status: 'importing' | 'done' | 'done_with_warnings' | 'failed' | 'cancelled'
  error?: string
  convIds: number[]
  reports: ImportReport[]
}

export interface Bookmark {
  id?: number
  messageId: number
  convId: number
  kind: MsgKind
  note: string
  createdAt: number
}

export interface LogEntry { id?: number; ts: number; level: 'info' | 'warn' | 'error'; msg: string; zipId?: number }

export interface Setting { key: string; value: unknown }
