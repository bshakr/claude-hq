import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { resolveConfig } from '../../hooks/config'
import { HELP, NARROW_TOAST } from '../../hooks/register'
import { layout } from '../../hooks/ui/layout'
import { drawPane } from '../../hooks/ui/pane'
import { BUSY } from './fixtures'

const MOCHA = {
  colorBroken: '#f38ba8',
  colorWaiting: '#f9e2af',
  colorWorking: '#89b4fa',
  colorDone: '#a6e3a1',
  colorAccent: '#94e2d5',
  colorDim: '#6c7086',
}
const props = (isFocused: boolean) => ({
  title: 'hq',
  isFocused,
  bodyColumns: 80,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
})

function host(on: On, isPlaced = true) {
  const h = { opens: [] as string[], toasts: [] as string[], store: new Map<string, unknown>() }
  on('ui.toast', ($, e) => {
    h.toasts.push(e.text)
    return { value: undefined }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', ($, e) => {
    h.opens.push(e.id)
    return { value: isPlaced ? { isPlaced } : { isPlaced, reason: 'under 144 columns: 120' } }
  })
  on('store.get', ($, e) => ({ value: h.store.get(e.key) }))
  on('store.set', ($, e) => {
    h.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    h.store.delete(e.key)
    return { value: undefined }
  })
  return h
}

test('the engine accepts hex tokens on every coloured element, the dimmed running dot included', async ($, on) => {
  const tokens = resolveConfig(MOCHA).tokens
  on('ui.render', { component: 'Pane', requestId: 'probe' }, ($, e) => {
    const l = layout(BUSY, { width: 80, rows: 58, focused: true, cursor: null, expanded: [], scroll: 0, phase: 1 })
    return drawPane(l.rows, { el: $.ui.resolve(e), tokens, onAction: () => undefined })
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'hq', surface, component: 'Pane', requestId: 'probe', props: props(true) })
    const json = JSON.stringify(await ui.drawn())
    expect(json.includes('ansi256(')).toBe(false)
    expect(/"color":"#89b4fa","dimColor":true/.test(json)).toBe(true)
    for (const hex of ['#f38ba8', '#f9e2af', '#94e2d5']) expect(json.includes(`"color":"${hex}"`)).toBe(true)
    await ui.unmount()
  }
})

test(
  'the plugin paints with its configured colours and shows a bad one as a dim footer line',
  { options: { colorAccent: '#94e2d5', colorDone: 'mauve' } },
  async ($, on) => {
    host(on)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq', props: props(true) })
    const json = JSON.stringify(await ui.drawn())
    expect(json.includes('"color":"#94e2d5"')).toBe(true)
    expect(json.includes('hq: ignored colour done (use #rrggbb, ansi256(N) or N)')).toBe(true)
    await ui.unmount()
  },
)

test('autoOpen: the pane opens by itself once per session, never again on a second start', async ($, on) => {
  const h = host(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  expect(h.opens).toEqual(['hq'])
})

test('autoOpen off: the pane waits for /hq', { options: { autoOpen: false } }, async ($, on) => {
  const h = host(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  expect(h.opens).toEqual([])
  await $.command.run({ command: 'hq', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(h.opens).toEqual(['hq'])
})

test('a -p run never opens the pane', async ($, on) => {
  const h = host(on)
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  expect(h.opens).toEqual([])
})

test('/hq summaries shows the config default, then on|off persists and wins over it', { options: { summaries: false } }, async ($, on) => {
  const h = host(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const cmd = (args: string) =>
    $.command.run({ command: 'hq', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(await cmd('summaries')).toMatchObject({ text: 'hq summaries are off.' })
  expect(await cmd('summaries on')).toMatchObject({ text: 'hq summaries on.' })
  expect(h.store.get('summaries')).toBe(true)
  expect(await cmd('summaries')).toMatchObject({ text: 'hq summaries are on.' })
  expect(await cmd('notify')).toMatchObject({ text: 'hq notifications are on.' })
})

test('/hq notify shows the config default when nothing is stored', { options: { notify: false } }, async ($, on) => {
  host(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  expect(
    await $.command.run({
      command: 'hq',
      args: 'notify',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 160 },
    }),
  ).toMatchObject({ text: 'hq notifications are off.' })
})

test(
  '/hq reset forgets every stored toggle, so the plugin config applies again',
  { options: { summaries: false, notify: false } },
  async ($, on) => {
    const h = host(on)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    const cmd = (args: string) =>
      $.command.run({ command: 'hq', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
    await cmd('summaries on')
    await cmd('notify on')
    await cmd('wake off')
    h.store.set('unrelated', 1)
    expect([...h.store.keys()].sort()).toEqual(['notify', 'summaries', 'unrelated', 'wake'])
    expect(await cmd('reset')).toMatchObject({ text: 'hq toggles reset to the plugin config: wake on, notify off, summaries off.' })
    expect([...h.store.keys()]).toEqual(['unrelated'])
    expect(await cmd('summaries')).toMatchObject({ text: 'hq summaries are off.' })
    expect(await cmd('notify')).toMatchObject({ text: 'hq notifications are off.' })
  },
)

test('autoOpen on a narrow terminal: one toast per session says /hq opens the pane', async ($, on) => {
  const h = host(on, false)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  expect(h.toasts.filter(t => t === NARROW_TOAST)).toEqual(['HQ is ready · /hq opens the pane'])
})

test('a placed pane brings no narrow-terminal toast', async ($, on) => {
  const h = host(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  expect(h.toasts.includes(NARROW_TOAST)).toBe(false)
})

test('/hq help and /hq name the engine chord, ctrl+x tab, and how to bind your own', async ($, on) => {
  host(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const cmd = (args: string) =>
    $.command.run({ command: 'hq', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  const help = (await cmd('help')) as { text: string }
  expect(help.text).toBe(HELP)
  for (const text of [help.text, ((await cmd('')) as { text: string }).text]) {
    expect(text).toContain('ctrl+x tab')
    expect(text).toContain('abovePrompt:focus')
    expect(text.includes('⌃g')).toBe(false)
  }
  expect(help.text).toContain('~/.claude/keybindings.json')
})
