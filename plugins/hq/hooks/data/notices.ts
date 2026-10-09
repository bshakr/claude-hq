/** `$.store` flags: each notice shows once per machine, whichever session reaches it first. */
export const WAKE_NOTICE_KEY = 'noticed:wake'
export const SUMMARIES_NOTICE_KEY = 'noticed:summaries'

export const SUMMARIES_NOTICE = 'HQ sends up to 6,000 characters per session to Haiku for goal lines · /hq summaries off to stop'
export const wakeNotice = (reason: string) => `HQ started this turn because ${reason} · /hq wake off to stop`

// Two callers in one tick would both read the flag unset before either writes it.
const inflight = new Map<string, Promise<boolean>>()

export interface NoticeIO {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: true) => Promise<void>
  toast: (text: string) => void
}

/** Toasts `text` the first time `key` comes up on this machine; true when it did. */
export function noticeOnce(io: NoticeIO, key: string, text: string): Promise<boolean> {
  const pending = inflight.get(key)
  if (pending) return pending.then(() => false)
  const job = (async () => {
    try {
      if ((await io.get(key)) === true) return false
      await io.set(key, true)
    } catch {
      return false
    }
    io.toast(text)
    return true
  })().finally(() => inflight.delete(key))
  inflight.set(key, job)
  return job
}
