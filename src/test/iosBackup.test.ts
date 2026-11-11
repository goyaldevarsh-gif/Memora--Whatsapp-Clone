import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import initSqlJs from 'sql.js'
import { db } from '../lib/db'
import { importIosBackup, findBackups, type BackupSet } from '../lib/iosBackup'

const APPLE = Date.UTC(2001, 0, 1) / 1000
const at = (y: number, mo: number, d: number, h: number, mi: number) => Date.UTC(y, mo - 1, d, h, mi) / 1000 - APPLE   // utc instant; test machine tz is irrelevant to assertions below
const hex = (n: number) => n.toString(16).padStart(40, '0')

async function fixture(opts: { encrypted?: boolean; skipMedia?: boolean } = {}): Promise<BackupSet> {
  const SQL = await initSqlJs()
  const chat = new SQL.Database()
  chat.run(`CREATE TABLE ZWACHATSESSION (Z_PK INTEGER PRIMARY KEY, ZPARTNERNAME TEXT, ZCONTACTJID TEXT, ZSESSIONTYPE INTEGER, ZARCHIVED INTEGER);
    CREATE TABLE ZWAMESSAGE (Z_PK INTEGER PRIMARY KEY, ZCHATSESSION INTEGER, ZMESSAGEDATE REAL, ZISFROMME INTEGER, ZTEXT TEXT, ZMESSAGETYPE INTEGER, ZFROMJID TEXT, ZGROUPMEMBER INTEGER, ZPUSHNAME TEXT);
    CREATE TABLE ZWAMEDIAITEM (Z_PK INTEGER PRIMARY KEY, ZMESSAGE INTEGER, ZMEDIALOCALPATH TEXT, ZTITLE TEXT);
    CREATE TABLE ZWAGROUPMEMBER (Z_PK INTEGER PRIMARY KEY, ZMEMBERJID TEXT, ZCONTACTNAME TEXT);
    INSERT INTO ZWACHATSESSION VALUES (1,'Aditi','919999900001@s.whatsapp.net',0,0),(2,'Family','1203@g.us',1,0),(3,NULL,'status@broadcast',0,0);
    INSERT INTO ZWAGROUPMEMBER VALUES (1,'919999900002@s.whatsapp.net','Rohan');`)
  const ins = (pk: number, s: number, t: number, me: number, text: string | null, type: number, gm: number | null = null) => chat.run('INSERT INTO ZWAMESSAGE (Z_PK,ZCHATSESSION,ZMESSAGEDATE,ZISFROMME,ZTEXT,ZMESSAGETYPE,ZGROUPMEMBER) VALUES (?,?,?,?,?,?,?)', [pk, s, t, me, text, type, gm])
  ins(1, 1, at(2024, 3, 12, 20, 14), 0, 'hi', 0); ins(2, 1, at(2024, 3, 12, 20, 15), 1, 'pic caption', 1); ins(3, 1, at(2024, 3, 12, 20, 16), 0, null, 1); ins(4, 1, at(2024, 3, 12, 20, 17), 0, null, 99)
  ins(5, 2, at(2024, 3, 13, 9, 0), 0, 'hello group', 0, 1); ins(6, 2, at(2024, 3, 13, 9, 1), 1, 'reply', 0)
  ins(7, 3, at(2024, 3, 13, 9, 1), 0, 'status', 0)
  chat.run("INSERT INTO ZWAMEDIAITEM (Z_PK,ZMESSAGE,ZMEDIALOCALPATH) VALUES (1,2,'Media/919999900001@s.whatsapp.net/a/b/IMG1.jpg')")
  const manifest = new SQL.Database()
  manifest.run('CREATE TABLE Files (fileID TEXT, domain TEXT, relativePath TEXT, flags INTEGER, file BLOB)')
  const D = 'AppDomainGroup-group.net.whatsapp.WhatsApp.shared'
  manifest.run('INSERT INTO Files VALUES (?,?,?,1,NULL)', [hex(1), D, 'ChatStorage.sqlite'])
  manifest.run('INSERT INTO Files VALUES (?,?,?,1,NULL)', [hex(2), D, 'Message/Media/919999900001@s.whatsapp.net/a/b/IMG1.jpg'])
  const mk = (b: Uint8Array, n: string, path: string) => { const f = new File([b as BlobPart], n); Object.defineProperty(f, 'webkitRelativePath', { value: path }); return f }
  const files = [
    mk(opts.encrypted ? new Uint8Array(64).fill(7) : manifest.export(), 'Manifest.db', 'Backup/UDID1/Manifest.db'),
    mk(chat.export(), hex(1), `Backup/UDID1/00/${hex(1)}`),
    ...(opts.skipMedia ? [] : [mk(new Uint8Array([1, 2, 3]), hex(2), `Backup/UDID1/00/${hex(2)}`)])
  ]
  return findBackups(files)[0]
}
const opts = async () => ({ sql: await initSqlJs(), progress() {}, isCancelled: () => false })

beforeEach(async () => { await db.delete(); await db.open() })

describe('iPhone iTunes backup import', () => {
  it('imports every chat with media, senders, group members; skips status broadcast', async () => {
    const r = await importIosBackup(await fixture(), await opts())
    expect(r.chats).toBe(2)
    const convs = await db.conversations.toArray()
    expect(convs.map(c => c.name).sort()).toEqual(['Aditi', 'Family'])
    const msgs = await db.messages.toArray()
    expect(msgs).toHaveLength(6)
    expect(msgs.find(m => m.body === 'pic caption')!.attId).toBeTruthy()
    expect(msgs.find(m => m.body === 'hello group')!.sender).toBe('Rohan')
    expect(msgs.find(m => m.body === 'reply')!.isMe).toBe(true)
    const unk = msgs.find(m => m.body.includes('type 99'))!; expect(unk.flagged).toBeTruthy()        // unknown type kept + flagged
    const noMedia = msgs.find(m => m.lineNo === 3)!; expect(noMedia.attMissing).toBe(true)           // image never downloaded on phone
    expect(r.status).toBe('done_with_warnings')
    expect(await db.attachments.count()).toBe(1)
  })
  it('rejects an encrypted backup with a clear message', async () => {
    await expect(importIosBackup(await fixture({ encrypted: true }), await opts())).rejects.toThrow(/ENCRYPTED/)
  })
  it('resumes: finished chats are kept, run again completes without duplicates', async () => {
    const bk = await fixture(); const o = await opts()
    const real = db.messages.bulkAdd.bind(db.messages); let calls = 0
    vi.spyOn(db.messages, 'bulkAdd').mockImplementation(((rows: any) => { if (++calls === 2) throw new Error('boom'); return real(rows) }) as any)
    await expect(importIosBackup(bk, o)).rejects.toThrow('boom')
    vi.restoreAllMocks()
    const rec = (await db.zips.toArray())[0]
    expect(rec.status).toBe('interrupted')
    expect(await db.messages.count()).toBe(4)                 // first chat (4 msgs) finished and kept
    const r = await importIosBackup(bk, o)
    expect(await db.zips.count()).toBe(1)
    expect(await db.messages.count()).toBe(6)
    expect(await db.attachments.count()).toBe(1)
    expect(r.chats).toBe(2)
  })
  it('flags missing media file referenced by the chat', async () => {
    const r = await importIosBackup(await fixture({ skipMedia: true }), await opts())
    expect(r.reports.find(x => x.conversation === 'Aditi')!.missing).toBe(1)
  })
})
