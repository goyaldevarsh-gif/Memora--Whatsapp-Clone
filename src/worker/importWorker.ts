/// <reference lib="webworker" />
import { importZipCore, type Decision, type UnitInfo } from '../lib/importCore'

type In =
  | { type: 'import'; file: File; name: string; myName: string | null; keepOriginal: boolean }
  | { type: 'decision'; decisions: Decision[] }

let resolveDecision: ((d: Decision[]) => void) | null = null
const ctx = self as unknown as DedicatedWorkerGlobalScope

ctx.onmessage = async (ev: MessageEvent<In>) => {
  const msg = ev.data
  if (msg.type === 'decision') { resolveDecision?.(msg.decisions); resolveDecision = null; return }
  try {
    const result = await importZipCore(msg.file, msg.name, {
      myName: msg.myName, keepOriginal: msg.keepOriginal,
      isCancelled: () => false, // cancellation = main thread terminates this worker, then rolls back by zipId
      progress: p => ctx.postMessage({ type: 'progress', ...p }),
      decide: (zipName: string, units: UnitInfo[]) => new Promise<Decision[]>(res => {
        resolveDecision = res
        ctx.postMessage({ type: 'decide', zipName, units })
      })
    })
    ctx.postMessage({ type: 'done', result })
  } catch (e) {
    ctx.postMessage({ type: 'error', message: (e as Error).message })
  }
}
