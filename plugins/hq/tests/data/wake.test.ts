import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import type { PrVM } from '../../hooks/model/types'
import { detectTransitions, parseWake, prStatusPart, toastText, wakePrompt, withPrStatus } from '../../hooks/data/wake'

function pr(number: number, over: Partial<PrVM> = {}): PrVM {
  return {
    repo: 'acme/app', number, title: `PR ${number}`, url: `https://github.com/acme/app/pull/${number}`,
    ci: { kind: 'passed', total: 3 }, merge: 'mergeable', gallery: 'none', watcher: 'ci-wait', claimedBy: 'main',
    ...over,
  }
}

const RED: PrVM['ci'] = { kind: 'failed', done: 3, total: 3, failed: 1, firstFailing: 'rspec' }
const RUNNING: PrVM['ci'] = { kind: 'running', done: 1, total: 3, failed: 0 }

describe('transitions', () => {
  test('a PR seen for the first time is never a transition', () => {
    expect(detectTransitions([], [pr(1, { ci: RED }), pr(2, { merge: 'merged' })])).toEqual([])
  })

  test('green or running to red is one transition naming the check', () => {
    for (const ci of [{ kind: 'passed', total: 3 } as const, RUNNING]) {
      const next = pr(1, { ci: RED })
      expect(detectTransitions([pr(1, { ci })], [next])).toEqual([{ kind: 'ci-red', pr: next, failing: 'rspec' }])
    }
  })

  test('none or registering to red, staying red, or going green is not a transition', () => {
    expect(detectTransitions([pr(1, { ci: { kind: 'none' } })], [pr(1, { ci: RED })])).toEqual([])
    expect(detectTransitions([pr(1, { ci: { kind: 'registering' } })], [pr(1, { ci: RED })])).toEqual([])
    expect(detectTransitions([pr(1, { ci: RED })], [pr(1, { ci: RED })])).toEqual([])
    expect(detectTransitions([pr(1, { ci: RED })], [pr(1)])).toEqual([])
  })

  test('mergeable or blocked to conflicting or behind is a transition; unknown to either is not', () => {
    expect(detectTransitions([pr(1)], [pr(1, { merge: 'conflicting' })]).map(t => t.kind)).toEqual(['conflicting'])
    expect(detectTransitions([pr(1, { merge: 'blocked' })], [pr(1, { merge: 'behind' })]).map(t => t.kind)).toEqual(['behind'])
    expect(detectTransitions([pr(1, { merge: 'unknown' })], [pr(1, { merge: 'conflicting' })])).toEqual([])
  })

  test('a stale row carries no transition', () => {
    expect(detectTransitions([pr(1)], [pr(1, { ci: RED, stale: true })])).toEqual([])
  })

  test('merged lists the other open owned PRs in that repo only', () => {
    const merged = pr(5, { merge: 'merged' })
    const next = [merged, pr(6), pr(7, { merge: 'closed' }), pr(8, { repo: 'acme/other' })]
    expect(detectTransitions([pr(5), pr(6), pr(7), pr(8, { repo: 'acme/other' })], next)).toEqual([
      { kind: 'merged', pr: merged, others: [6] },
    ])
  })

  test('closing unmerged is not a transition', () => {
    expect(detectTransitions([pr(1)], [pr(1, { merge: 'closed', ci: RED })])).toEqual([])
  })
})

describe('wake prompt and toasts', () => {
  test('one transition is one line; several batch into one prompt', () => {
    const red = { kind: 'ci-red' as const, pr: pr(1, { ci: RED }), failing: 'rspec' }
    expect(wakePrompt([red])).toBe(
      '[hq] acme/app#1 CI went red (failing check: rspec). Triage: read the failing log and report; do not merge or push without asking.',
    )
    const prompt = wakePrompt([red, { kind: 'behind', pr: pr(2) }, { kind: 'merged', pr: pr(3), others: [4] }])!
    expect(prompt.split('\n')).toHaveLength(4)
    expect(prompt.split('\n')[0]).toBe('[hq] Several PRs changed:')
    expect(prompt).toContain('acme/app#3 merged. Other owned open PRs in that repo: #4 ')
  })

  test('a merge with no other owned open PR toasts but does not wake', () => {
    const t = { kind: 'merged' as const, pr: pr(3, { merge: 'merged' }), others: [] }
    expect(toastText(t)).toBe('acme/app#3 merged')
    expect(wakePrompt([t])).toBeNull()
  })

  test('toast texts', () => {
    expect(toastText({ kind: 'ci-red', pr: pr(1), failing: 'lint' })).toBe('acme/app#1 CI went red: lint')
    expect(toastText({ kind: 'conflicting', pr: pr(1) })).toBe('acme/app#1 has merge conflicts')
    expect(toastText({ kind: 'behind', pr: pr(1) })).toBe('acme/app#1 needs a rebase')
  })

  test('/hq wake parses on and off only', () => {
    expect(parseWake('wake on')).toBe('on')
    expect(parseWake(' wake   off ')).toBe('off')
    expect(parseWake('wake')).toBeNull()
    expect(parseWake('wake maybe')).toBeNull()
  })
})

describe('status line', () => {
  test('counts owned PRs, and adds nothing without any', () => {
    const prs = [pr(1), pr(2, { ci: RUNNING }), pr(3, { ci: RED, merge: 'behind' }), pr(4, { merge: 'conflicting' }), pr(5, { merge: 'merged' })]
    expect(prStatusPart(prs)).toBe('PRs 2 green · 1 running · 1 red · 1 conflict · 1 rebase · 1 merged')
    expect(prStatusPart([pr(1, { ci: { kind: 'none' } })])).toBe('PRs 1 open')
    expect(prStatusPart([])).toBeUndefined()
    expect(withPrStatus('', [])).toBe('')
    expect(withPrStatus('hq: 1 broken', [])).toBe('hq: 1 broken')
    expect(withPrStatus('', [pr(1)])).toBe('hq: PRs 1 green')
    expect(withPrStatus('hq: 1 broken', [pr(1, { ci: RED })])).toBe('hq: 1 broken · PRs 1 red')
  })
})

// The plugin end to end: owned PRs come from the store, their state from pr-watch files.
const HOME = '/home/u'
const SID = 'self-sid'
const WATCH = `${HOME}/.cache/pr-watch`

type Check = { name: string; status: string; conclusion: string | null }
const ok = (name: string): Check => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' })
const pending = (name: string): Check => ({ name, status: 'IN_PROGRESS', conclusion: null })
const failing = (name: string): Check => ({ name, status: 'COMPLETED', conclusion: 'FAILURE' })

interface Host {
  files: Record<string, string>
  prompts: string[]
  toasts: string[]
  statuses: (string | undefined)[]
  store: Map<string, unknown>
}

function watchFile(h: Host, n: number, checks: Check[], state: 'OPEN' | 'MERGED' = 'OPEN', at = '2026-10-08T00:00:00Z') {
  h.files[`${WATCH}/acme__app__${n}.ci-wait.json`] = JSON.stringify({
    version: 1, repo: 'acme/app', number: n, watcher: 'ci-wait', pid: 500, updatedAt: at, headSha: 'abc',
    title: `PR ${n}`, url: `https://github.com/acme/app/pull/${n}`, state, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', checks,
  })
}

function host(on: On, owned: number[], wake?: boolean): Host {
  const h: Host = { files: {}, prompts: [], toasts: [], statuses: [], store: new Map() }
  h.store.set(`owned:${SID}`, {
    claims: owned.map(n => ({ repo: 'acme/app', number: n, claimedBy: 'main', claimedAt: 1, reason: 'created' })),
    branches: [],
  })
  if (wake !== undefined) h.store.set('wake', wake)
  on('store.get', ($, e) => ({ value: h.store.get(e.key) }))
  on('store.set', ($, e) => {
    h.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('session.id', () => ({ value: SID }))
  on('session.cwd', () => ({ value: `${HOME}/code/app` }))
  on('agent.list', () => ({ value: [] }))
  on('fs.list', ($, e) => {
    throw new Error(`ENOENT ${e.path}`)
  })
  on('fs.read', ($, e) => {
    const text = h.files[e.path]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.stat', ($, e) => {
    throw new Error(`ENOENT ${e.path}`)
  })
  on('fs.write', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] === 'ps') return out('500\n')
    if (e.argv[0] === 'git' && e.argv[1] === 'branch') return out('main\n')
    if (e.argv[0] === 'git' && e.argv[1] === 'remote') return out('git@github.com:acme/app.git\n')
    return { value: { exitCode: 1, stdout: '', stderr: 'unexpected', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.submit', ($, e) => {
    if (e.origin?.kind === 'plugin') h.prompts.push(e.text)
    return { text: e.text }
  })
  on('ui.toast', ($, e) => {
    h.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    h.statuses.push(e.text)
    return { value: undefined }
  })
  return h
}

async function begin($: Engine, on: On) {
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: `${HOME}/code/app`, surface: 'terminal', isInteractive: true })
  await clock.settle()
  return clock
}

for (const wake of [undefined, false] as const) {
  test(`an owned PR going red toasts${wake === false ? ' but does not wake after /hq wake off' : ' and wakes once'}`, async ($, on) => {
    const h = host(on, [40], wake)
    watchFile(h, 40, [ok('lint'), pending('rspec')])
    const clock = await begin($, on)
    expect(h.toasts).toEqual([])
    expect(h.statuses.at(-1)).toBe('hq: 1 in progress · PRs 1 running')

    watchFile(h, 40, [ok('lint'), failing('rspec')], 'OPEN', '2026-10-08T00:01:00Z')
    await clock.advance(2_000)
    expect(h.toasts).toEqual(['acme/app#40 CI went red: rspec'])
    expect(h.prompts).toEqual(
      wake === false ? [] : ['[hq] acme/app#40 CI went red (failing check: rspec). Triage: read the failing log and report; do not merge or push without asking.'],
    )
    expect(h.statuses.at(-1)).toBe('hq: 1 broken · PRs 1 red')

    await clock.advance(10_000)
    expect(h.toasts).toHaveLength(1)
    expect(h.prompts).toHaveLength(wake === false ? 0 : 1)
  })
}

test('a merge wakes with the other owned open PRs to rebase-check; alone it only toasts', async ($, on) => {
  const h = host(on, [40, 41])
  watchFile(h, 40, [ok('lint')])
  watchFile(h, 41, [ok('lint')])
  const clock = await begin($, on)

  watchFile(h, 40, [ok('lint')], 'MERGED', '2026-10-08T00:01:00Z')
  await clock.advance(2_000)
  expect(h.toasts).toEqual(['acme/app#40 merged'])
  expect(h.prompts).toHaveLength(1)
  expect(h.prompts[0]).toContain('[hq] acme/app#40 merged. Other owned open PRs in that repo: #41 ')

  watchFile(h, 41, [ok('lint')], 'MERGED', '2026-10-08T00:02:00Z')
  await clock.advance(2_000)
  expect(h.toasts).toEqual(['acme/app#40 merged', 'acme/app#41 merged'])
  expect(h.prompts).toHaveLength(1)
  expect(h.statuses.at(-1)).toBe('hq: PRs 2 merged')
})

test('a PR already red when first read, and a PR owned by no one here, are silent', async ($, on) => {
  const h = host(on, [40])
  watchFile(h, 40, [failing('rspec')])
  watchFile(h, 99, [pending('rspec')])
  const clock = await begin($, on)
  watchFile(h, 99, [failing('rspec')], 'OPEN', '2026-10-08T00:01:00Z')
  await clock.advance(4_000)
  expect(h.toasts).toEqual([])
  expect(h.prompts).toEqual([])
})

test('no owned PRs: the status line is cleared', async ($, on) => {
  const h = host(on, [])
  await begin($, on)
  expect(h.statuses.length).toBeGreaterThan(0)
  expect(h.statuses.every(s => s === undefined)).toBe(true)
})

test('/hq wake off and on persist in the store', async ($, on) => {
  const h = host(on, [])
  await begin($, on)
  expect(await $.command.run({ command: 'hq', args: 'wake off', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })).toMatchObject({ text: 'hq waking is off.' })
  expect(h.store.get('wake')).toBe(false)
  expect(await $.command.run({ command: 'hq', args: 'wake on', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })).toMatchObject({ text: 'hq waking is on.' })
  expect(h.store.get('wake')).toBe(true)
})
