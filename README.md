# Memora — Your conversations, preserved forever.

A private, offline-first PWA that imports WhatsApp "Export Chat" ZIPs and lets you browse them in a WhatsApp-style, **read-only** archive: chats, photos, videos, voice notes, documents, global search, bookmarks, backup & restore.

**Privacy:** everything lives in your browser's IndexedDB. No server, analytics, ads or AI APIs. Never commit exported ZIPs / chats / backups (`.gitignore` blocks them).

## Use
1. Open the site → **Import Chats** → pick one or many WhatsApp ZIPs (Android or iPhone exports).
2. Same contact exported twice? Memora suggests **merging**; messages are interleaved chronologically and *probable duplicates are flagged for review, never auto-deleted*.
3. Check **Settings → Data integrity** — it will never claim a clean import if media/lines were skipped.
4. **Download a backup regularly** (Settings → Backup & Restore). Browser storage can be cleared or evicted.

## What it parses
Android (`12/03/2022, 8:14 pm - Name: text`) and iOS (`[12/03/22, 20:14:05] Name: text`) formats, 12/24h clocks, `/ . -` date separators, DD/MM vs MM/DD detection (by value, then by chronology), multi-line messages, Hindi/emoji/Unicode, system lines, `(file attached)`, `<attached: …>`, "omitted" placeholders, locations, deleted messages, calls. Unparseable timestamps/lines are kept and flagged, with the raw text stored for future re-parsing.

## Known limits (honest list)
- ZIPs are streamed (central directory + one file at a time, ZIP64 supported), so multi-GB exports import without loading the archive into RAM. A single media file is still decompressed in memory (fine for normal videos). On iPhone keep the app open and screen on during a big import; very large archives also need free device storage (media is stored once; the original ZIP copy is optional and off by default above 300 MB).
- Voice notes are `.opus`; playback depends on the browser (Chrome/Edge/Firefox fine; some Safari versions can't — download fallback provided). HEIC photos display only in Safari.
- Timestamps carry no timezone in exports; Memora shows the exact clock time written in the export.
- WhatsApp does not say which sender is "you": detected for 1:1 chats, otherwise set it once (Settings / Contact info).
- PIN lock hides the UI; it does not encrypt data at rest.
- Backups are built in memory: for multi-GB archives, untick "original ZIPs" or back up in parts.

## Develop
```
npm i
npm run dev      # local
npm test         # parser / importer / backup tests (synthetic data only)
npm run build    # outputs dist/ (relative base, deploys on any GitHub Pages path)
```
Deployment: GitHub Actions (`.github/workflows/deploy.yml`) → GitHub Pages. In the repo, set **Settings → Pages → Source: GitHub Actions** once.

Stack: React, TypeScript, Vite, Tailwind, Dexie/IndexedDB, JSZip, MiniSearch, react-virtuoso, Workbox PWA.
