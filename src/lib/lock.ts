import { getSetting, setSetting, db } from './db'
const enc = new TextEncoder()
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('')
async function derive(pin: string, salt: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits'])
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(salt), iterations: 120000, hash: 'SHA-256' }, key, 256))
}
export const hasPin = async () => !!(await getSetting<{ salt: string; hash: string } | null>('pin', null))
export async function setPin(pin: string) { const salt = hex(crypto.getRandomValues(new Uint8Array(16)).buffer); await setSetting('pin', { salt, hash: await derive(pin, salt) }) }
export async function verifyPin(pin: string) { const p = await getSetting<{ salt: string; hash: string } | null>('pin', null); return !!p && p.hash === await derive(pin, p.salt) }
export const clearPin = () => db.settings.delete('pin')
