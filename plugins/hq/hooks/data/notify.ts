// A native notification when another session newly waits on the user (ADR 0006).
import type { TmuxGroupVM } from '../model/types'
import { isRealWait } from './waiting'

export const NOTIFY_TITLE = 'Claude needs you'
export const NOTIFY_STORE_KEY = 'notify'
/** A wait first seen older than this is not news (a fresh load over long-standing waits). */
export const NOTIFY_FRESH_MS = 10 * 60_000
export const NOTIFIED_PRUNE_MS = 60 * 60_000

export interface Due {
  key: string
  text: string
}

export function dueNotifications(others: readonly TmuxGroupVM[], seen: ReadonlySet<string>, selfId: string, now: number): Due[] {
  const out: Due[] = []
  for (const s of others.flatMap(g => g.sessions)) {
    if (s.sessionId === selfId || !isRealWait(s.wait) || now - s.wait.since > NOTIFY_FRESH_MS) continue
    const key = `${s.sessionId}:${s.wait.since}`
    if (!seen.has(key)) out.push({ key, text: `${s.name}: ${s.wait.text}` })
  }
  return out
}

export interface NotifyDeps {
  enabled: () => Promise<boolean>
  /** True for the one HQ instance that wins this wait; the others stay quiet. */
  claim: (key: string) => Promise<boolean>
  send: (text: string) => Promise<void>
}

/** Sends each due wait once; a wait seen while notifications are off is not sent when they come back on. */
export async function notifyWaits(due: readonly Due[], seen: Set<string>, deps: NotifyDeps): Promise<number> {
  if (due.length === 0) return 0
  for (const d of due) seen.add(d.key)
  if (!(await deps.enabled())) return 0
  let sent = 0
  for (const d of due) {
    if (!(await deps.claim(d.key))) continue
    try {
      await deps.send(d.text)
      sent++
    } catch {
      // a refused or failed notification is not retried
    }
  }
  return sent
}

/** A directory name for a claim: mkdir is atomic, so one instance across the machine wins. */
export const claimName = (key: string) => key.replace(/[^A-Za-z0-9._-]/g, '_')

export function parseNotifyArg(args: string): boolean | 'show' | undefined {
  const a = args.trim().split(/\s+/)
  if (a[0] !== 'notify') return undefined
  if (a.length === 1) return 'show'
  if (a[1] === 'on') return true
  if (a[1] === 'off') return false
  return undefined
}
