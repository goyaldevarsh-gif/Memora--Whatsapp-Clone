import { describe, it, expect } from 'vitest'
import { parseWhatsAppText } from '../lib/parser'
import { nameFromFile, matchKey } from '../lib/names'

const android = `12/03/2022, 8:14 pm - Messages and calls are end-to-end encrypted. No one outside of this chat can read them.
12/03/2022, 8:14 pm - Aditi: Heyy! Reached?
12/03/2022, 8:20 pm - Me: Yes! Just checked in. 😊
Line two of my message
Line three
13/03/2022, 9:00 am - Aditi: IMG-20220313-WA0001.jpg (file attached)
Look at this view
13/03/2022, 9:05 am - Me: PTT-20220313-WA0002.opus (file attached)
13/03/2022, 9:06 am - Aditi: नमस्ते, कैसे हो?
13/03/2022, 9:07 am - Me: <Media omitted>
13/03/2022, 9:08 am - Aditi: You deleted this message
13/03/2022, 9:09 am - Aditi: location: https://maps.google.com/?q=26.9,75.8
13/03/2022, 9:10 am - Aditi: Missed voice call`

describe('parser', () => {
  it('android 12h, multiline, media, hindi, system', () => {
    const r = parseWhatsAppText(android)
    expect(r.format).toBe('android'); expect(r.dateOrder).toBe('dmy')
    expect(r.messages).toHaveLength(10)
    expect(r.messages[0].kind).toBe('system')
    expect(r.messages[2].body).toBe('Yes! Just checked in. 😊\nLine two of my message\nLine three')
    expect(r.messages[3]).toMatchObject({ kind: 'image', attName: 'IMG-20220313-WA0001.jpg' })
    expect(r.messages[4].kind).toBe('voice')
    expect(r.messages[5].body).toBe('नमस्ते, कैसे हो?')
    expect(r.messages[6]).toMatchObject({ kind: 'image', attMissing: true }.kind ? { attMissing: true } : {})
    expect(r.messages[7].kind).toBe('deleted'); expect(r.messages[8].kind).toBe('location'); expect(r.messages[9].kind).toBe('call')
    expect(new Date(r.messages[1].ts!).toISOString()).toBe('2022-03-12T20:14:00.000Z')
  })
  it('ios bracket format with seconds and LTR marks, 24h', () => {
    const t = `‎[12/03/22, 20:14:05] Rahul: Hello\n‎[12/03/22, 20:15:00] Rahul: ‎IMG-1.jpg (file attached)\n[13/03/22, 07:00:00] Me: <attached: 00000012-PHOTO-2022-03-13-07-00-00.jpg>`
    const r = parseWhatsAppText(t)
    expect(r.format).toBe('ios'); expect(r.messages).toHaveLength(3)
    expect(r.messages[2].attName).toBe('00000012-PHOTO-2022-03-13-07-00-00.jpg')
    expect(new Date(r.messages[0].ts!).toISOString()).toBe('2022-03-12T20:14:05.000Z')
  })
  it('detects US date order from values and from chronology', () => {
    expect(parseWhatsAppText('3/25/22, 8:14 PM - A: x\n3/26/22, 8:14 PM - B: y').dateOrder).toBe('mdy')
    const r = parseWhatsAppText('1/2/22, 8:14 PM - A: x\n1/3/22, 8:14 PM - B: y\n2/1/22, 1:00 PM - A: z')
    expect(r.dateOrder).toBe('mdy')
    expect(parseWhatsAppText('1/2/22, 8:14 PM - A: x').dateOrderAmbiguous).toBe(true)
  })
  it('narrow no-break space before PM, dotted dates', () => {
    const r = parseWhatsAppText('12.03.22, 8:14 PM - A: x\n13.03.22, 20:15 - B: y')
    expect(r.messages).toHaveLength(2)
  })
  it('ambiguous / invalid timestamp is preserved and flagged, not dropped', () => {
    const r = parseWhatsAppText('31/02/2022, 8:14 pm - A: impossible date\n01/03/2022, 8:14 pm - A: ok')
    expect(r.messages).toHaveLength(2); expect(r.messages[0].ts).toBeNull(); expect(r.messages[0].flagged).toBeTruthy()
  })
  it('keeps unparsed leading text', () => {
    const r = parseWhatsAppText('garbage line\n01/03/2022, 8:14 pm - A: ok')
    expect(r.messages[0].kind).toBe('unparsed'); expect(r.messages).toHaveLength(2)
  })
  it('group sender with colon-free system lines', () => {
    const r = parseWhatsAppText('01/03/2022, 8:14 pm - Dad created group "Family: 2022"\n01/03/2022, 8:15 pm - Dad added you\n01/03/2022, 8:16 pm - Dad: Hi all')
    expect(r.messages.map(m => m.kind)).toEqual(['system', 'system', 'text'])
  })
  it('prose ending in "(file attached)" is not mistaken for a filename', () => {
    const r = parseWhatsAppText('01/03/2022, 8:14 pm - A: please see the report (file attached)\n01/03/2022, 8:15 pm - A: Doc with spaces v2.pdf (file attached)')
    expect(r.messages[0].kind).toBe('text'); expect(parseWhatsAppText('01/03/2022, 8:14 pm - A: see this: Report.pdf (file attached)').messages[0].kind).toBe('text'); expect(r.messages[1]).toMatchObject({ kind: 'document', attName: 'Doc with spaces v2.pdf' })
  })
  it('names', () => {
    expect(nameFromFile('WhatsApp Chat with Aditi.zip')).toBe('Aditi')
    expect(nameFromFile('Chat with Rahul (1).zip')).toBe('Rahul')
    expect(nameFromFile('Family Group.zip')).toBe('Family Group')
    expect(matchKey('Aditi_2')).toBe('aditi'); expect(matchKey('Aditi Old Chat')).toBe('aditi'); expect(matchKey('Rahul')).not.toBe(matchKey('Aditi'))
  })
})
