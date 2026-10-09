import { expect, test } from 'claude-code/testing'

import { noticeOnce } from '../../hooks/data/notices'

function io(seen: Record<string, unknown> = {}) {
  const toasts: string[] = []
  return {
    toasts,
    seen,
    get: async (k: string) => seen[k],
    set: async (k: string, v: true) => {
      seen[k] = v
    },
    toast: (t: string) => void toasts.push(t),
  }
}

test('a notice toasts once, even when two callers ask in the same tick', async () => {
  const h = io()
  const got = await Promise.all([noticeOnce(h, 'k', 'hello'), noticeOnce(h, 'k', 'hello')])
  expect(got.filter(Boolean)).toHaveLength(1)
  expect(await noticeOnce(h, 'k', 'hello')).toBe(false)
  expect(h.toasts).toEqual(['hello'])
  expect(h.seen.k).toBe(true)
})

test('a notice the store has seen stays quiet; a store that fails stays quiet too', async () => {
  const seen = io({ k: true })
  expect(await noticeOnce(seen, 'k', 'hello')).toBe(false)
  expect(seen.toasts).toEqual([])
  const broken = { ...io(), get: async () => Promise.reject(new Error('locked')) }
  expect(await noticeOnce(broken, 'k2', 'hello')).toBe(false)
  expect(broken.toasts).toEqual([])
})
