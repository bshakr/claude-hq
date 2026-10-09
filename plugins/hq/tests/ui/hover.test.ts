import { describe, expect, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

import type { HqModel } from '../../hooks/model/types'
import { caretItem, caretKey } from '../../hooks/ui/caret'
import { FINISHED_ID, FINISHED_KEY, layout } from '../../hooks/ui/layout'
import type { Layout, View } from '../../hooks/ui/layout'
import { drawPane } from '../../hooks/ui/pane'
import type { Action } from '../../hooks/ui/row'
import { BUSY, WITH_PRS } from './fixtures'

const PROBE = 'hover-probe'
const SURFACES = ['terminal', 'desktop'] as const
const props = (isFocused: boolean) => ({
  title: 'hq',
  isFocused,
  bodyColumns: 80,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 120 },
  view: {},
})

type Probe = { model: HqModel; view: Partial<View>; last?: Layout; pressed: [string, Action][] }

function probe(on: On, p: Probe) {
  on('ui.render', { component: 'Pane', requestId: PROBE }, ($, e) => {
    const l = layout(p.model, {
      width: e.props.bodyColumns,
      rows: e.props.scroll.bodyRows,
      focused: e.props.isFocused,
      cursor: null,
      expanded: [],
      scroll: 0,
      phase: 0,
      ...p.view,
    })
    p.last = l
    return drawPane(l.rows, { el: $.ui.resolve(e), onAction: (key, action) => p.pressed.push([key, action]) })
  })
}

type Drawn = { key: string; hover?: Record<string, unknown> }

/** Every Button in the drawn tree with its `hover`, which `findAll` does not report. */
function buttonsOf(tree: RenderElement): Drawn[] {
  const out: Drawn[] = []
  const walk = (n: unknown) => {
    if (n === null || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(walk)
    const el = n as { type?: string; props?: { key?: string }; hover?: Record<string, unknown>; children?: unknown }
    if (el.type === 'Button') out.push({ key: String(el.props?.key), ...(el.hover ? { hover: el.hover } : {}) })
    walk(el.children)
  }
  walk(tree)
  return out
}

// The probe's hook is the test's, so its Buttons are pressed under the test's plugin name.
const press = { plugin: 'test' }

const finished = (id: string, mins: number) => ({
  id,
  title: `Finished ${id}`,
  status: 'completed' as const,
  background: true,
  startedAt: BUSY.now - 20 * 60_000,
  endedAt: BUSY.now - mins * 60_000,
  toolCount: 1,
  files: [],
})
const WITH_FINISHED: HqModel = {
  ...BUSY,
  current: { ...BUSY.current, agents: [...BUSY.current.agents, finished('f1', 1), finished('f2', 2)] },
}

describe('under the pointer a Button reads as the keyboard cursor does, never inverted', () => {
  for (const focused of [false, true]) {
    test(`${focused ? 'focused' : 'unfocused'} pane: titles bold, PR titles underlined too, the cursor caret left to the ring`, async ($, on) => {
      const cursor = 's:s-st-api'
      const p: Probe = { model: WITH_PRS, view: { cursor }, pressed: [] }
      probe(on, p)
      for (const surface of SURFACES) {
        const ui = await $.ui.mount({ plugin: 'hq', surface, component: 'Pane', requestId: PROBE, props: props(focused) })
        const buttons = buttonsOf(await ui.drawn())
        const l = p.last!
        let prTitles = 0
        for (const { key, hover } of buttons) {
          const item = caretItem(key)
          if (item !== undefined) {
            if (focused && item === cursor) expect(hover).toBeUndefined()
            else expect(hover).toEqual({ inverse: false })
            continue
          }
          const action = l.actions[key]
          const link = action?.kind === 'jump' && action.jump.kind === 'url'
          if (link && key.startsWith('p:')) prTitles++
          const look = { inverse: false, bold: true, ...(link ? { underline: true } : {}) }
          // An item's Buttons follow its keyed Box; the rest name a scope of their own.
          expect(hover).toEqual(l.owner[key] !== undefined ? look : { scope: `hq:${key}`, ...look })
        }
        expect(prTitles > 0).toBe(true)
        // Focused, the j/k hint Buttons sit outside any item.
        expect(buttons.some(b => l.owner[b.key] === undefined && caretItem(b.key) === undefined)).toBe(focused)
        await ui.unmount()
      }
    })
  }

  test('only a link underlines on hover: a session or agent title stays bold alone', async ($, on) => {
    const p: Probe = { model: WITH_PRS, view: {}, pressed: [] }
    probe(on, p)
    const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: PROBE, props: props(false) })
    const buttons = buttonsOf(await ui.drawn())
    const hoverOf = (key: string) => buttons.find(b => b.key === key)?.hover
    expect(hoverOf('s:s-st-api')).toEqual({ inverse: false, bold: true })
    expect(hoverOf('p:acmeco/webapp-ui#212')).toEqual({ inverse: false, bold: true, underline: true })
    await ui.unmount()
  })
})

describe('a click runs the row it lands on', () => {
  test('a PR title opens the PR, a session title jumps, its caret does the same', async ($, on) => {
    const p: Probe = { model: WITH_PRS, view: {}, pressed: [] }
    probe(on, p)
    for (const surface of SURFACES) {
      p.pressed.length = 0
      const ui = await $.ui.mount({ plugin: 'hq', surface, component: 'Pane', requestId: PROBE, props: props(false) })
      const l = p.last!
      for (const key of ['p:acmeco/webapp-ui#212', 's:s-st-api', caretKey('s:s-st-api')]) await ui.press({ key, ...press })
      expect(p.pressed).toEqual([
        ['p:acmeco/webapp-ui#212', l.actions['p:acmeco/webapp-ui#212']!],
        ['s:s-st-api', l.actions['s:s-st-api']!],
        [caretKey('s:s-st-api'), l.actions['s:s-st-api']!],
      ])
      expect(p.pressed[0]![1]).toMatchObject({ kind: 'jump', jump: { kind: 'url' } })
      expect(p.pressed[1]![1]).toMatchObject({ kind: 'jump', jump: { kind: 'tmux' } })
      await ui.unmount()
    }
  })

  test('+N finished toggles the rest, open or closed, and hovers bold without inverting', async ($, on) => {
    const p: Probe = { model: WITH_FINISHED, view: {}, pressed: [] }
    probe(on, p)
    for (const expanded of [[], [FINISHED_ID]]) {
      p.view = { expanded }
      p.pressed.length = 0
      const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: PROBE, props: props(false) })
      const toggle = buttonsOf(await ui.drawn()).find(b => b.key === FINISHED_KEY)
      expect(toggle?.hover).toEqual({ inverse: false, bold: true })
      await ui.press({ key: FINISHED_KEY, ...press })
      expect(p.pressed).toEqual([[FINISHED_KEY, { kind: 'toggle', id: FINISHED_ID }]])
      await ui.unmount()
    }
  })
})
