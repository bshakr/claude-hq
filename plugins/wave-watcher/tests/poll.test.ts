import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { ownedFrom, ownedTransitions, rowFromPr, statusLine, wakePrompt } from '../hooks/logic'
import type { WaveRow } from '../types'
import type { GhPr } from '../hooks/logic'
import { STYLES, styleById } from '../hooks/styles/index'

const URL1 = 'https://github.com/acme/app/pull/1'

function engineBeneath(on: On, registered: string[] = []) {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
}

function prJson(checks: unknown[]) {
  return {
    number: 1, title: 'One', url: URL1, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN', statusCheckRollup: checks, body: '', headRefName: 'h', baseRefName: 'main',
  }
}

/** HQ's published file for this session: `owned` names the PRs it owns. */
function hqFile(on: On, owned: { repo: string; number: number }[] | null) {
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('session.id', () => ({ value: 'sid-1' }))
  on('fs.read', ($, e) => {
    if (owned === null || e.path !== '/home/u/.claude/hq/sessions/sid-1.json') throw new Error(`ENOENT ${e.path}`)
    return { value: JSON.stringify({ sessionId: 'sid-1', updatedAt: 1, owned }) }
  })
}

function fakeGh(on: On, checks: () => unknown[], calls: string[][]) {
  on('process.run', async ($, e) => {
    calls.push([...e.argv])
    const stdout =
      e.argv[1] === 'search'
        ? JSON.stringify([{ number: 1, repository: { nameWithOwner: 'acme/app' }, title: 'One', url: URL1 }])
        : JSON.stringify(prJson(checks()))
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

const running = [{ __typename: 'CheckRun', name: 'rspec', status: 'IN_PROGRESS', conclusion: '' }]
const failed = [{ __typename: 'CheckRun', name: 'rspec', status: 'COMPLETED', conclusion: 'FAILURE' }]

for (const isWaking of [true, false]) {
  test(`CI going red toasts${isWaking ? ' and wakes once' : ', and does not wake when off'}`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    mock.store(on, isWaking ? {} : { wake: false })
    engineBeneath(on)
    hqFile(on, [{ repo: 'acme/app', number: 1 }])
    let checks = running
    const calls: string[][] = []
    fakeGh(on, () => checks, calls)
    const prompts: string[] = []
    on('prompt.submit', ($, e) => {
      prompts.push(e.text)
      return { text: e.text }
    })
    const toasts: string[] = []
    on('ui.toast', ($, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })

    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await clock.settle()
    expect(calls.length).toBe(2)
    expect(prompts).toEqual([])

    checks = failed
    await clock.advance(60_000)
    expect(calls.length).toBe(4)
    expect(toasts.some(t => t.includes('acme/app#1 CI went red: rspec'))).toBe(true)
    expect(prompts.length).toBe(isWaking ? 1 : 0)
    if (isWaking) expect(prompts[0]).toContain('[wave-watcher] acme/app#1 CI went red (failing check: rspec)')

    await clock.advance(60_000)
    expect(prompts.length).toBe(isWaking ? 1 : 0)
  })
}

for (const [label, owned] of [['another session owns it', [{ repo: 'acme/app', number: 2 }]], ['HQ has published nothing', null]] as const) {
  test(`CI going red toasts but does not wake when ${label}`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    mock.store(on)
    engineBeneath(on)
    hqFile(on, owned === null ? null : [...owned])
    let checks = running
    fakeGh(on, () => checks, [])
    const prompts: string[] = []
    on('prompt.submit', ($, e) => {
      prompts.push(e.text)
      return { text: e.text }
    })
    const toasts: string[] = []
    on('ui.toast', ($, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await clock.settle()
    checks = failed
    await clock.advance(60_000)
    expect(toasts.some(t => t.includes('acme/app#1 CI went red: rspec'))).toBe(true)
    expect(prompts).toEqual([])
  })
}

test('a merge wakes only its owner, and lists only the owner\'s other open PRs', () => {
  const row = (n: number, status: WaveRow['status'] = 'open'): WaveRow => ({
    url: `https://github.com/acme/app/pull/${n}`, repo: 'acme/app', number: n, title: `#${n}`, status, isDraft: false,
    ci: { kind: 'green' }, merge: 'mergeable', gallery: 'none', mergedAt: null,
  })
  const merged = { kind: 'merged' as const, row: row(5, 'merged'), others: [6, 7, 8] }
  const red = { kind: 'ci-red' as const, row: row(9), failing: 'lint' }
  const owned = ownedFrom(JSON.stringify({ owned: [{ repo: 'Acme/App', number: 5 }, { repo: 'acme/app', number: 7 }] }))
  const mine = ownedTransitions([merged, red], owned)
  expect(mine).toEqual([{ ...merged, others: [7] }])
  expect(wakePrompt(mine)).toContain('Other open PRs in that repo: #7 ')
  expect(ownedTransitions([merged, red], ownedFrom(undefined))).toEqual([])
  expect(ownedFrom('{broken')).toEqual(new Set())
})

test('gh failing sets the error status line instead of throwing', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  engineBeneath(on)
  hqFile(on, [{ repo: 'acme/app', number: 1 }])
  on('process.run', () => ({
    value: {
      exitCode: 4, stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login\nmore',
      isStdoutTruncated: false, isStderrTruncated: false,
    },
  }))
  const statuses: (string | undefined)[] = []
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(statuses.at(-1)).toBe('wave: gh failed: To get started with GitHub CLI, please run:  gh auth login')
})

test('the pane draws rows and footer on terminal and desktop', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  mock.store(on)
  engineBeneath(on)
  fakeGh(on, () => failed, [])
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.settle()
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'wave-watcher',
      surface,
      component: 'Pane',
      requestId: 'wave',
      props: { title: 'Wave', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
    })
    expect(await ui.find({ type: 'Text', text: /Wave: 1 open PRs, polled 0s ago/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /acme\/app#1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'CI red: rspec · mergeable · gallery none' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /gh every 60s, 0 model tokens/ })).toBeDefined()
    await ui.unmount()
  }
})

test('registers /prs, not /wave', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const registered: string[] = []
  engineBeneath(on, registered)
  fakeGh(on, () => running, [])
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(registered).toEqual(['prs'])
})

test('a refused command registration is logged and polling still runs', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  mock.store(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', () => {
    throw new Error(`$.command.register: "/prs" refused: it is the user's /prs`)
  })
  const calls: string[][] = []
  fakeGh(on, () => running, calls)
  const logs: string[] = []
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(calls.length).toBe(2)
  expect(logs.length).toBe(1)
  expect(logs[0]).toContain('/prs was not registered')
  await clock.advance(60_000)
  expect(calls.length).toBe(4)
})

async function startWithStyle(
  $: Engine,
  on: On,
  stored: Record<string, unknown>,
  checks: () => unknown[] = () => failed,
) {
  const clock = mock.clock(on, { now: 1_000 })
  const store = new Map(Object.entries(stored))
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  engineBeneath(on)
  hqFile(on, [{ repo: 'acme/app', number: 1 }])
  fakeGh(on, checks, [])
  const statuses: (string | undefined)[] = []
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  let tick = 0
  on('state.set', ($, e, next) => {
    if (e.plugin === 'wave-watcher' && e.key === 'tick') tick = e.value as number
    return next(e)
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const run = async (args: string) =>
    (
      await $.command.run({
        command: 'prs', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 },
      })
    ).text ?? ''
  return { run, store, statuses, clock, tickOf: () => tick }
}

const PANE_TARGET = {
  plugin: 'wave-watcher',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'wave',
  props: { title: 'Wave', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

test('/prs style lists every style and marks the default active', async ($, on) => {
  const { run } = await startWithStyle($, on, {})
  const listed = await run('style')
  for (const id of ['classic', 'd1', 'd2', 'd3', 'd4']) expect(listed).toContain(id)
  expect(listed).toContain('* classic')
  for (const one of STYLES) expect(listed).toContain(one.meta.name)
})

test('/prs style <id> switches and persists in the store', async ($, on) => {
  const { run, store } = await startWithStyle($, on, {})
  expect(await run('style d2')).toContain('Pane style is now d2')
  expect(await run('style')).toContain('* d2')
  expect(store.get('style')).toBe('d2')
})

test('a stored style is restored at session start', async ($, on) => {
  const { run } = await startWithStyle($, on, { style: 'd3' })
  expect(await run('style')).toContain('* d3')
})

test('a stored style that no longer exists falls back to classic', async ($, on) => {
  const { run } = await startWithStyle($, on, { style: 'gone' })
  expect(await run('style')).toContain('* classic')
})

test('an unknown style id changes nothing', async ($, on) => {
  const { run, store } = await startWithStyle($, on, { style: 'd1' })
  expect(await run('style nope')).toContain('Unknown style "nope"; nothing changed.')
  expect(await run('style')).toContain('* d1')
  expect(store.get('style')).toBe('d1')
})

test('the pane still draws under a switched style', async ($, on) => {
  const { run } = await startWithStyle($, on, {})
  await run('style d1')
  const ui = await $.ui.mount(PANE_TARGET)
  expect(await ui.find({ type: 'Text', text: /app#1/ })).toBeDefined()
  await ui.unmount()
})

test('the pane draws a Raster under d4 on a terminal', async ($, on) => {
  const { run } = await startWithStyle($, on, {})
  await run('style d4')
  const ui = await $.ui.mount(PANE_TARGET)
  expect(await ui.find({ type: 'Raster' })).toBeDefined()
  await ui.unmount()
})

const ROW = rowFromPr(prJson(failed) as unknown as GhPr, 'acme/app', 1_000)!
const STATUS_CTX = { rows: [ROW], error: null, polledAt: 1_000, now: 1_000 }

test('classic and d4 have no status of their own; d1, d2 and d3 do', () => {
  expect(styleById('classic')?.status).toBeUndefined()
  expect(styleById('d4')?.status).toBeUndefined()
  for (const id of ['d1', 'd2', 'd3']) expect(typeof styleById(id)?.status).toBe('function')
})

for (const id of ['classic', 'd1', 'd2', 'd3', 'd4']) {
  test(`status line under ${id} is ${styleById(id)?.status ? 'the style\'s own' : 'logic.statusLine'}`, async ($, on) => {
    const { statuses } = await startWithStyle($, on, { style: id })
    const own = styleById(id)?.status
    expect(statuses.at(-1)).toBe(own ? own(STATUS_CTX) : statusLine([ROW], null))
  })
}

test('switching style rewrites the status line at once', async ($, on) => {
  const { run, statuses } = await startWithStyle($, on, {})
  expect(statuses.at(-1)).toBe(statusLine([ROW], null))
  const before = statuses.length
  await run('style d2')
  expect(statuses.length).toBe(before + 1)
  expect(statuses.at(-1)).toBe(styleById('d2')!.status!(STATUS_CTX))
  expect(statuses.at(-1)).not.toBe(statuses.at(-2))
  await run('style classic')
  expect(statuses.at(-1)).toBe(statusLine([ROW], null))
})

const ANIMATED = STYLES.find(one => one.meta.animated === true)!.meta.id

for (const [label, style, ci, mounted, moves] of [
  ['animated style, running CI, pane rendered', ANIMATED, running, true, true],
  ['pane not rendered', ANIMATED, running, false, false],
  ['style not animated', 'classic', running, true, false],
  ['no CI running', ANIMATED, failed, true, false],
] as const) {
  test(`the 1 s timer: ${label} -> ${moves ? 'ticks once a second' : 'still'}`, async ($, on) => {
    const { clock, tickOf } = await startWithStyle($, on, { style }, () => ci)
    const ui = mounted ? await $.ui.mount(PANE_TARGET) : undefined
    await clock.settle()
    const start = tickOf()
    // 10 s crosses the 10 s timer too: exactly 10 means it never adds its own step.
    await clock.advance(10_000)
    expect((tickOf()) - start).toBe(moves ? 10 : 0)
    await ui?.unmount()
  })
}

test('tick advances by exactly 1 per second', async ($, on) => {
  const { clock, tickOf } = await startWithStyle($, on, { style: ANIMATED }, () => running)
  const ui = await $.ui.mount(PANE_TARGET)
  await clock.settle()
  let last = tickOf()
  for (let s = 0; s < 25; s++) {
    await clock.advance(1_000)
    const n = tickOf()
    expect(n - last).toBe(1)
    last = n
  }
  await ui.unmount()
})

test('the 1 s timer stops when CI finishes', async ($, on) => {
  let checks: unknown[] = running
  const { clock, tickOf } = await startWithStyle($, on, { style: ANIMATED, wake: false }, () => checks)
  const ui = await $.ui.mount(PANE_TARGET)
  await clock.settle()
  checks = failed
  await clock.advance(60_000)
  const settled = tickOf()
  await clock.advance(30_000)
  expect(tickOf()).toBe(settled)
  await ui.unmount()
})

test('after a reload with the pane up, the timer starts without /prs', async ($, on) => {
  on('ui.panes', () => ({
    value: [{ id: 'wave', title: 'Wave', isShown: true, isFocused: false, isPlaced: true }],
  }))
  const { clock, tickOf } = await startWithStyle($, on, { style: ANIMATED }, () => running)
  const start = tickOf()
  await clock.advance(3_000)
  expect((tickOf()) - start).toBe(3)
})
