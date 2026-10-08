import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { rowFromPr, statusLine } from '../hooks/logic'
import type { GhPr } from '../hooks/logic'
import { styleById } from '../hooks/styles/index'

const failed = [{ __typename: 'CheckRun', name: 'rspec', status: 'COMPLETED', conclusion: 'FAILURE' }]
const green = [{ __typename: 'CheckRun', name: 'rspec', status: 'COMPLETED', conclusion: 'SUCCESS' }]
const CHECKS: Record<number, unknown[]> = { 1: failed, 2: green, 3: green }

function prJson(n: number) {
  return {
    number: n, title: `PR ${n}`, url: `https://github.com/acme/app/pull/${n}`, state: 'OPEN', isDraft: false,
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: CHECKS[n], body: '',
    headRefName: 'h', baseRefName: 'main',
  }
}
const row = (n: number) => rowFromPr(prJson(n) as unknown as GhPr, 'acme/app', 1_000)!

type Owned = { repo: string; number: number }[]

/** Three open PRs; `files` maps a session id to its HQ file's `owned`, absent meaning no file. */
async function start($: Engine, on: On, files: Map<string, Owned>, sid: { id: string }, style?: string) {
  const clock = mock.clock(on, { now: 1_000 })
  mock.store(on, style ? { style } : {})
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('session.id', () => ({ value: sid.id }))
  on('fs.read', ($, e) => {
    const id = /\/home\/u\/\.claude\/hq\/sessions\/(.+)\.json$/.exec(e.path)?.[1] ?? ''
    const owned = files.get(id)
    if (owned === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: JSON.stringify({ sessionId: id, updatedAt: 1, owned }) }
  })
  on('process.run', ($, e) => {
    const stdout =
      e.argv[1] === 'search'
        ? JSON.stringify([1, 2, 3].map(n => ({
            number: n, repository: { nameWithOwner: 'acme/app' }, title: `PR ${n}`, url: `https://github.com/acme/app/pull/${n}`,
          })))
        : JSON.stringify(prJson(Number(e.argv[3])))
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const statuses: (string | undefined)[] = []
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.settle()
  return { clock, statuses }
}

for (const id of ['classic', 'd1', 'd2', 'd3']) {
  test(`status under ${id} counts only the owned PRs`, async ($, on) => {
    const files = new Map([['sid-1', [{ repo: 'Acme/App', number: 1 }, { repo: 'acme/app', number: 2 }]]])
    const { statuses } = await start($, on, files, { id: 'sid-1' }, id)
    const ctx = { rows: [row(1), row(2)], error: null, polledAt: 1_000, now: 1_000 }
    const own = styleById(id)?.status
    const expected = own ? own(ctx) : statusLine(ctx.rows, null)
    expect(statuses.at(-1)).toBe(expected)
    if (id === 'classic') expect(expected).toBe('wave: 1 green · 1 red')
  })
}

test('a session that owns no PRs clears the status line', async ($, on) => {
  const { statuses } = await start($, on, new Map([['sid-1', []]]), { id: 'sid-1' })
  expect(statuses.length).toBeGreaterThan(0)
  expect(statuses.at(-1)).toBeUndefined()
})

test('owned PRs that are not in the poll clear the status line', async ($, on) => {
  const { statuses } = await start($, on, new Map([['sid-1', [{ repo: 'acme/app', number: 9 }]]]), { id: 'sid-1' })
  expect(statuses.at(-1)).toBeUndefined()
})

test('no HQ file clears the status line rather than counting every PR', async ($, on) => {
  const { statuses } = await start($, on, new Map(), { id: 'sid-1' })
  expect(statuses.length).toBeGreaterThan(0)
  expect(statuses.every(text => text === undefined)).toBe(true)
})

test('after /clear the new session id picks the HQ file', async ($, on) => {
  const files = new Map<string, Owned>([['sid-1', [{ repo: 'acme/app', number: 1 }]]])
  const sid = { id: 'sid-1' }
  const { clock, statuses } = await start($, on, files, sid)
  expect(statuses.at(-1)).toBe(statusLine([row(1)], null))

  sid.id = 'sid-2'
  await clock.advance(10_000)
  expect(statuses.at(-1)).toBeUndefined()

  files.set('sid-2', [{ repo: 'acme/app', number: 2 }, { repo: 'acme/app', number: 3 }])
  await clock.advance(10_000)
  expect(statuses.at(-1)).toBe('wave: 2 green')
})
