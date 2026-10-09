import { describe, expect, test } from 'claude-code/testing'
import type { On, UiFocusOrigin } from 'claude-code'

import type { HqModel } from '../../hooks/model/types'
import { caretItem, caretKey, pressedItem, ringMove } from '../../hooks/ui/caret'
import { layout } from '../../hooks/ui/layout'
import type { Layout, View } from '../../hooks/ui/layout'
import { drawPane } from '../../hooks/ui/pane'
import { BUSY, WITH_PRS } from './fixtures'

const view = (over: Partial<View> = {}): View => ({
  width: 80,
  rows: 120,
  focused: true,
  cursor: null,
  expanded: [],
  scroll: 0,
  phase: 0,
  ...over,
})
const PERSON: UiFocusOrigin = { kind: 'person' }

/** Every Button in drawing order: rows top to bottom, cells left to right, as the engine's Tab walks them. */
function stops(l: Layout): string[] {
  const out: string[] = []
  for (const r of l.rows) for (const s of r.segs()) if (s.s.btn !== undefined && out[out.length - 1] !== s.s.btn) out.push(s.s.btn)
  return out
}

/** Tab or shift+Tab `n` times from the cursor's caret, the plugin answering each move; the carets the ring rests on. */
function walk(m: HqModel, dir: 1 | -1, n: number): string[] {
  let cursor = layout(m, view()).items[0]!
  let ring = caretKey(cursor)
  const rested: string[] = []
  for (let i = 0; i < n;) {
    const l = layout(m, view({ cursor }))
    const all = stops(l)
    const at = all.indexOf(ring)
    expect(at >= 0).toBe(true)
    const element = all[(at + dir + all.length) % all.length]!
    const move = ringMove(l, cursor, { element, origin: PERSON })
    if (move && 'scrollTo' in move) throw new Error(`${move.scrollTo} is drawn`)
    ring = move ? move.caret : element
    const item = caretItem(ring)
    if (item === undefined) continue
    cursor = item
    rested.push(item)
    i++
  }
  return rested
}

describe('the focus ring rests on carets', () => {
  for (const m of [BUSY, WITH_PRS]) {
    const items = layout(m, view()).items

    test(`${items.length} items: Tab walks each once in order and wraps to the first`, () => {
      expect(walk(m, 1, items.length)).toEqual([...items.slice(1), items[0]!])
    })

    test(`${items.length} items: shift+Tab walks each once in reverse and wraps to the last`, () => {
      expect(walk(m, -1, items.length)).toEqual([...items].reverse())
    })

    test(`${items.length} items: a person's move onto any item's other Button lands on a caret`, () => {
      for (const cursor of [null, items[0]!, items[3]!]) {
        const l = layout(m, view({ cursor }))
        for (const key of stops(l).filter(k => caretItem(k) === undefined && l.owner[k] !== undefined)) {
          const move = ringMove(l, cursor, { element: key, origin: PERSON })
          expect(move !== undefined && 'caret' in move).toBe(true)
        }
      }
    })
  }

  test('a click on another item lands on its own caret; carets, j/k and plugin moves pass through', () => {
    const l = layout(BUSY, view({ cursor: 'a:a1' }))
    expect(ringMove(l, 'a:a1', { element: 'p:acmeco/webapp-ui#214', origin: PERSON })).toEqual({
      caret: caretKey('p:acmeco/webapp-ui#214'),
    })
    expect(ringMove(l, 'a:a1', { element: 'a:a5', origin: PERSON })).toEqual({ caret: caretKey('a:a5') })
    expect(ringMove(l, 'a:a1', { element: caretKey('a:a3'), origin: PERSON })).toBe(undefined)
    expect(ringMove(l, 'a:a1', { element: 'j', origin: PERSON })).toBe(undefined)
    expect(ringMove(l, 'a:a1', { element: 'a:a3', origin: { kind: 'plugin', name: 'hq' } })).toBe(undefined)
  })

  test('the next item off screen is scrolled to rather than focused', () => {
    const l = layout(BUSY, view({ rows: 20, cursor: 'a:a2' }))
    const last = l.items.filter(k => l.rows.some(r => r.head && r.item === k)).at(-1)!
    expect(ringMove(l, last, { element: last, origin: PERSON })).toEqual({ scrollTo: l.items[l.items.indexOf(last) + 1]! })
  })
})

describe('a press puts the cursor and the ring on its own item', () => {
  test("a title, a caret and a row's other Button each name their item", () => {
    const l = layout(WITH_PRS, view({ cursor: 's:s-st-api' }))
    const asks = Object.keys(l.owner).find(k => k.endsWith(':asks'))
    expect(pressedItem(l, 'p:acmeco/webapp-ui#212')).toBe('p:acmeco/webapp-ui#212')
    expect(pressedItem(l, caretKey('s:s-st-api'))).toBe('s:s-st-api')
    if (asks) expect(pressedItem(l, asks)).toBe(asks.slice(0, -':asks'.length))
    expect(pressedItem(l, 'j')).toBe('j')
  })

  test("a click on the cursor item's title bounces the ring onward; its press then brings it back", () => {
    const l = layout(BUSY, view({ cursor: 'a:a3' }))
    const move = ringMove(l, 'a:a3', { element: 'a:a3', origin: PERSON })
    expect(move).toEqual({ caret: caretKey(l.items[l.items.indexOf('a:a3') + 1]!) })
    expect(caretKey(pressedItem(l, 'a:a3'))).toBe(caretKey('a:a3'))
  })
})

describe('the cursor row is drawn bold; a PR, a link, underlined too', () => {
  const probe = (cursor: string) => (on: On) =>
    on('ui.render', { component: 'Pane', requestId: 'caret-probe' }, ($, e) =>
      drawPane(layout(WITH_PRS, view({ cursor })).rows, { el: $.ui.resolve(e), autoFocusKey: caretKey(cursor), onAction: () => undefined }),
    )
  const props = {
    title: 'hq',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 120 },
    view: {},
  }

  for (const [cursor, underlined] of [
    ['p:acmeco/webapp-ui#212', true],
    ['s:s-st-api', false],
  ] as const) {
    test(`${cursor}: bold${underlined ? ' and underlined' : ''}, its caret the one autoFocus Button`, async ($, on) => {
      probe(cursor)(on)
      for (const surface of ['terminal', 'desktop'] as const) {
        const ui = await $.ui.mount({ plugin: 'hq', surface, component: 'Pane', requestId: 'caret-probe', props })
        const buttons = await ui.findAll({ type: 'Button' })
        const title = JSON.stringify(buttons.find(b => (b.key ?? b.props.key) === cursor)?.children)
        expect(title.includes('"bold":true')).toBe(true)
        expect(title.includes('"underline":true')).toBe(underlined)
        const auto = buttons.filter(b => b.props.autoFocus === true).map(b => b.key ?? b.props.key)
        expect(auto).toEqual([caretKey(cursor)])
        const caret = JSON.stringify(buttons.find(b => (b.key ?? b.props.key) === caretKey(cursor)))
        expect(caret.includes('▶')).toBe(true)
        // No other row is underlined at rest (hover underlines are the surface's, under the pointer).
        const others = buttons.filter(b => (b.key ?? b.props.key) !== cursor)
        expect(others.some(b => JSON.stringify(b.children).includes('"underline":true'))).toBe(false)
        await ui.unmount()
      }
    })
  }
})
