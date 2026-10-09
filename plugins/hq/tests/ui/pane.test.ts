import { expect, test } from 'claude-code/testing'
import type { EngineInterface, On, RenderElement, RenderInput } from 'claude-code'

import type { HqModel } from '../../hooks/model/types'
import { runJump } from '../../hooks/ui/jump'
import { layout } from '../../hooks/ui/layout'
import type { Layout } from '../../hooks/ui/layout'
import { drawPane } from '../../hooks/ui/pane'
import { BUSY, EMPTY, LONG, QUIET } from './fixtures'
import { METERED } from './usage-fixtures'

type PaneEvent = RenderInput<'Pane'>

const PROBE = 'hq-probe'
const props = (bodyColumns: number, bodyRows: number, isFocused = false) => ({
  title: 'hq',
  isFocused,
  bodyColumns,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows },
  view: {},
})

type Probe = { model: HqModel; cursor: string | null; expanded: string[]; phase?: number; last?: Layout }

function probe(on: On, p: Probe) {
  on('ui.render', { component: 'Pane', requestId: PROBE }, ($, e) => draw($, e, p))
}

function draw($: EngineInterface, e: PaneEvent, p: Probe) {
  const l = layout(p.model, {
    width: e.props.bodyColumns,
    rows: e.props.scroll.bodyRows,
    focused: e.props.isFocused,
    cursor: p.cursor,
    expanded: p.expanded,
    scroll: 0,
    phase: p.phase ?? 0,
  })
  p.last = l
  return drawPane(l.rows, { el: $.ui.resolve(e), autoFocusKey: l.items[0], onAction: () => undefined })
}

test('the engine validates every state on terminal and desktop, with no background', async ($, on) => {
  const p: Probe = { model: BUSY, cursor: null, expanded: [] }
  probe(on, p)
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const [model, w, r, focused] of [
      [BUSY, 80, 58, false],
      [BUSY, 72, 58, true],
      [QUIET, 88, 58, true],
      [LONG, 80, 34, false],
      [EMPTY, 60, 20, true],
      [BUSY, 40, 10, true],
    ] as const) {
      p.model = model
      p.expanded = ['a3', 'a1']
      const ui = await $.ui.mount({ plugin: 'hq', surface, component: 'Pane', requestId: PROBE, props: props(w, r, focused) })
      const drawn: RenderElement = await ui.drawn()
      expect(drawn).toMatchObject({ type: 'Box' })
      expect(JSON.stringify(drawn).includes('backgroundColor')).toBe(false)
      const buttons = await ui.findAll({ type: 'Button' })
      const visible = p.last!.items.filter(k => p.last!.rows.some(row => row.head && row.item === k))
      for (const key of visible) expect(buttons.some(b => b.props.key === key || b.key === key)).toBe(true)
      if (focused) expect(buttons.filter(b => b.props.hotkey !== undefined).map(b => b.props.hotkey)).toEqual(['j', 'k'])
      await ui.unmount()
    }
  }
})

const run = (ran: string[][]) => (_$: unknown, e: { readonly argv: readonly string[] }) => {
  ran.push([...e.argv])
  return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
}

test('a jump runs only its own commands: tmux switch then pane select, or open for a web URL', async () => {
  const l = layout(BUSY, { width: 80, rows: 58, focused: true, cursor: null, expanded: [], scroll: 0, phase: 0 })
  const jumpOf = (key: string) => {
    const a = l.actions[key]
    if (a?.kind !== 'jump') throw new Error(`${key} is not a jump`)
    return a.jump
  }
  const ran: string[][] = []
  const ok = async (argv: string[]) => {
    ran.push(argv)
    return { exitCode: 0, stderr: '' }
  }
  expect(await runJump(jumpOf('flare'), ok)).toBe(undefined)
  expect(ran).toEqual([
    ['tmux', 'switch-client', '-t', 'acme-store:@3.%6'],
    ['tmux', 'select-pane', '-t', '%6'],
  ])
  ran.length = 0
  await runJump(jumpOf('p:acmeco/webapp-ui#212'), ok)
  expect(ran).toEqual([['open', 'https://github.com/acmeco/webapp-ui/pull/212']])
  ran.length = 0
  await runJump(jumpOf('s:s-st-admin'), ok)
  expect(ran[0]).toEqual(['tmux', 'switch-client', '-t', 'acme-store:@4.%13'])
  // Agents expand and j/k move: none of them is a jump.
  for (const key of ['a:a3', 'j', 'k']) expect(l.actions[key]?.kind === 'jump').toBe(false)
  ran.length = 0
  expect(await runJump({ kind: 'url', url: 'file:///etc/passwd' }, ok)).toBe('nothing to open for file:///etc/passwd')
  expect(ran).toEqual([])
  // A failed switch stops before the pane select.
  const fails = async (argv: string[]) => {
    ran.push(argv)
    return { exitCode: 1, stderr: "can't find session: acme-store" }
  }
  expect(await runJump(jumpOf('flare'), fails)).toBe("tmux switch-client failed: can't find session: acme-store")
  expect(ran.length).toBe(1)
})

test('the plugin itself: /hq opens the pane, j and k are Buttons with hotkeys, pressing them runs nothing', async ($, on) => {
  const ran: string[][] = []
  on('process.run', run(ran))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const before = ran.length
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'hq', surface, component: 'Pane', requestId: 'hq', props: props(80, 30, true) })
    const hot = (await ui.findAll({ type: 'Button' })).filter(b => b.props.hotkey !== undefined)
    expect(hot.map(b => b.props.hotkey)).toEqual(['j', 'k'])
    await ui.press({ key: 'j' })
    await ui.press({ key: 'k' })
    const text = JSON.stringify(await ui.drawn())
    expect(text.includes('this session')).toBe(true)
    expect(text.includes('backgroundColor')).toBe(false)
    await ui.unmount()
  }
  expect(ran.slice(before).filter(a => a[0] === 'tmux' || a[0] === 'open')).toEqual([])
})

test('a dimmed running dot and the green plan bars validate as colour plus dimColor, never a background', async ($, on) => {
  const p: Probe = { model: { ...BUSY, account: METERED.account! }, cursor: null, expanded: [], phase: 1 }
  probe(on, p)
  const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: PROBE, props: props(80, 40) })
  const json = JSON.stringify(await ui.drawn())
  expect(json.includes('backgroundColor')).toBe(false)
  expect(/"color":"ansi256\(4\)","dimColor":true/.test(json)).toBe(true)
  expect(json.includes('"color":"ansi256(2)"')).toBe(true)
  await ui.unmount()
})

test('the +N finished toggle is a Button the engine accepts, open or closed', async ($, on) => {
  const fin = (id: string, mins: number) => ({
    id,
    title: `Finished ${id}`,
    status: 'completed' as const,
    background: true,
    startedAt: BUSY.now - 20 * 60_000,
    endedAt: BUSY.now - mins * 60_000,
    toolCount: 1,
    files: [],
  })
  const model: HqModel = { ...BUSY, current: { ...BUSY.current, agents: [...BUSY.current.agents, fin('f1', 1), fin('f2', 2)] } }
  const p: Probe = { model, cursor: null, expanded: [] }
  probe(on, p)
  for (const expanded of [[], ['+finished']]) {
    p.expanded = expanded
    const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: PROBE, props: props(80, 58) })
    const drawn = await ui.drawn()
    expect(JSON.stringify(drawn).includes('backgroundColor')).toBe(false)
    const buttons = await ui.findAll({ type: 'Button' })
    expect(buttons.some(b => b.props.key === 'finished' || b.key === 'finished')).toBe(true)
    await ui.unmount()
  }
})

test('the cursor row: a heavy card and a bold, wrapped title the engine accepts, its Button keyed as before', async ($, on) => {
  const p: Probe = { model: BUSY, cursor: null, expanded: [] }
  probe(on, p)
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const [model, cursor] of [
      [BUSY, 'a:a1'],
      [QUIET, 'p:acme-store/admin-web#433'],
      [BUSY, 's:s-st-admin'],
    ] as const) {
      p.model = model
      p.cursor = cursor
      const ui = await $.ui.mount({ plugin: 'hq', surface, component: 'Pane', requestId: PROBE, props: props(48, 80, true) })
      const json = JSON.stringify(await ui.drawn())
      expect(json.includes('backgroundColor')).toBe(false)
      expect(json.includes('┏━')).toBe(true)
      const buttons = await ui.findAll({ type: 'Button' })
      const target = buttons.filter(b => b.props.key === cursor || b.key === cursor)
      expect(target.length).toBe(1)
      expect(JSON.stringify(target[0]).includes('"bold":true')).toBe(true)
      await ui.unmount()
    }
  }
})
