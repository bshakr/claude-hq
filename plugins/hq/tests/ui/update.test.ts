import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { HeaderNotice } from '../../hooks/data/update'
import { HELP } from '../../hooks/register'
import { pressJump } from '../../hooks/ui/jump'
import { WHATS_NEW_KEY, layout } from '../../hooks/ui/layout'
import type { View } from '../../hooks/ui/layout'
import { drawPane } from '../../hooks/ui/pane'
import { BUSY } from './fixtures'
import { METERED } from './usage-fixtures'

const AVAILABLE: HeaderNotice = { kind: 'available', version: '0.2.0' }
const UPDATED: HeaderNotice = { kind: 'updated', version: '0.2.0', url: 'https://github.com/bshakr/claude-hq/releases/tag/v0.2.0' }
const view = (width: number, notice?: HeaderNotice): View => ({
  width,
  rows: 40,
  focused: false,
  cursor: null,
  expanded: [],
  scroll: 0,
  phase: 0,
  ...(notice ? { notice } : {}),
})
const props = { title: 'hq', isFocused: false, bodyColumns: 80, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }

test('header: an available update is one dim line on the left; plan usage keeps its place on the right', () => {
  const plain = layout(METERED, view(80)).rows[0]!
  const row = layout(METERED, view(80, AVAILABLE)).rows[0]!
  expect(row.text().startsWith('  hq 0.2.0 available · /hq update')).toBe(true)
  expect(row.text().endsWith(plain.text().trim())).toBe(true)
  expect(row.segs().find(s => s.t.includes('available'))?.s).toEqual({ dim: true })
  expect(row.buttons).toEqual([])
})

test('header: on a narrow pane the notice stays and the usage narrows or goes; no row passes the width', () => {
  for (const width of [60, 40, 30]) {
    const l = layout(METERED, view(width, AVAILABLE))
    expect(l.rows[0]!.text().includes('hq 0.2.0')).toBe(true)
    for (const r of l.rows) expect(r.cells.length).toBe(width)
  }
})

test('header: no notice, no change', () => {
  for (const m of [METERED, BUSY]) {
    expect(layout(m, view(80)).rows.map(r => r.text())).toEqual(layout(m, view(80, undefined)).rows.map(r => r.text()))
  }
})

function probe(on: On, notice: HeaderNotice) {
  on('ui.render', { component: 'Pane', requestId: 'update-probe' }, ($, e) => {
    const l = layout(METERED, view(e.props.bodyColumns, notice))
    return drawPane(l.rows, { el: $.ui.resolve(e), onAction: () => undefined })
  })
}

test("header: after an update, a what's new Button opens that version's release page", async ($, on) => {
  const l = layout(METERED, view(80, UPDATED))
  expect(l.rows[0]!.text().startsWith("  updated to 0.2.0 · what's new")).toBe(true)
  const action = l.actions[WHATS_NEW_KEY]
  expect(action).toEqual({ kind: 'jump', jump: { kind: 'url', url: UPDATED.url } })
  // What a press does: /hq runs a Button's jump through pressJump.
  const ran: string[][] = []
  const run = async (argv: string[]) => {
    ran.push(argv)
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  if (action?.kind === 'jump') await pressJump(action.jump, { run, copy: async () => false, toast: () => undefined })
  expect(ran).toEqual([['open', UPDATED.url]])
  probe(on, UPDATED)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'hq', surface, component: 'Pane', requestId: 'update-probe', props })
    const found = (await ui.findAll({ type: 'Button' })).filter(b => b.props.key === WHATS_NEW_KEY || b.key === WHATS_NEW_KEY)
    expect(found).toHaveLength(1)
    expect(found[0]!.props.label).toBe("what's new")
    await ui.unmount()
  }
})

test('header: an available notice draws no Button', async ($, on) => {
  probe(on, AVAILABLE)
  const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'update-probe', props })
  const buttons = await ui.findAll({ type: 'Button' })
  expect(buttons.some(b => b.props.key === WHATS_NEW_KEY || b.key === WHATS_NEW_KEY)).toBe(false)
  expect(JSON.stringify(await ui.drawn()).includes('hq 0.2.0 available · /hq update')).toBe(true)
  await ui.unmount()
})

test('the plugin from a checkout: no update request, no notice, and /hq update runs nothing', async ($, on) => {
  const store = new Map<string, unknown>([
    ['update:latest', '9.9.9'],
    ['update:lastRun', '0.0.1'],
  ])
  const ran: string[][] = []
  const toasts: string[] = []
  let fetches = 0
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('http.fetch', () => {
    fetches++
    return { value: { status: 200, ok: true, headers: {}, text: '{"version":"9.9.9"}' } }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq', props })
  const drawn = JSON.stringify(await ui.drawn())
  await ui.unmount()
  expect(drawn.includes('available')).toBe(false)
  expect(drawn.includes('updated to')).toBe(false)
  expect(fetches).toBe(0)
  expect(store.get('update:lastRun')).toBe('0.0.1')

  const before = ran.length
  await $.command.run({ command: 'hq', args: 'update', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(ran.slice(before).filter(a => a[0] === 'claude')).toEqual([])
  expect(toasts.at(-1)).toBe('hq runs from a local folder, not the plugin store · update it with git pull, then /reload-plugins')
})

test('/hq help lists /hq update', () => {
  expect(HELP).toContain('/hq update')
})
