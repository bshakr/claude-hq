import { expect, test } from 'claude-code/testing'

import type { HqModel, OtherSessionVM } from '../../hooks/model/types'
import { layout } from '../../hooks/ui/layout'
import { drawPane } from '../../hooks/ui/pane'
import type { View } from '../../hooks/ui/layout'
import { cellLen } from '../../hooks/ui/text'
import { BUSY, NOW } from './fixtures'

const M = 60_000
const view = (width: number): View => ({ width, rows: 64, focused: false, cursor: null, expanded: [], scroll: 0, phase: 0 })

const withWaits = (s: OtherSessionVM): OtherSessionVM =>
  s.sessionId === 's-st-api'
    ? {
        ...s,
        wait: { kind: 'question', text: 'Which date library should we use?', options: ['date-fns', 'dayjs', 'luxon'], since: NOW - 2 * M },
      }
    : s.sessionId === 's-st-admin'
      ? {
          ...s,
          status: 'waiting',
          statusSince: NOW - 1 * M,
          waitingFor: 'Bash: rm -rf tmp/',
          wait: { kind: 'permission', text: 'Bash: rm -rf tmp/', since: NOW - 1 * M },
        }
      : s.sessionId === 's-st-docs'
        ? { ...s, wait: { kind: 'turn', text: 'your turn', since: NOW - 60 * M } }
        : s

const NEEDS: HqModel = {
  ...BUSY,
  counts: { ...BUSY.counts, waiting: 4 },
  others: BUSY.others.map(g => ({ ...g, sessions: g.sessions.map(withWaits) })),
}

const card = (m: HqModel, width: number) => {
  const rows = layout(m, view(width)).rows.map(r => r.text())
  const at = rows.findIndex(r => r.includes('╭─ acme-store'))
  return rows.slice(at, rows.findIndex((r, i) => i > at && r.includes('╰')) + 1)
}

test('80 cols: a real wait reads "asks", its options after it; your turn replaces idle', () => {
  expect(card(NEEDS, 80)).toEqual([
    ' ╭─ acme-store ───────────────────────────────────────────────────────────────╮',
    ' │  st-api                           1 agent · 1 PR needs you · ◆ waiting 2m  │',
    ' │  ◆ asks: Which date library should we use? · date-fns / dayjs / luxon      │',
    ' │                                                                            │',
    ' │  st-admin                   4 agents · 1 of 2 PRs need you · ◆ waiting 1m  │',
    ' │  ◆ asks: Bash: rm -rf tmp/                                                 │',
    ' │                                                                            │',
    ' │  st-docs                                                     your turn 1h  │',
    ' ╰────────────────────────────────────────────────────────────────────────────╯',
  ])
})

test('40 cols: the text is clipped first and the options give way', () => {
  expect(card(NEEDS, 40)).toEqual([
    ' ╭─ acme-store ───────────────────────╮',
    ' │  st-api              ◆ waiting 2m  │',
    ' │  ◆ asks: Which date library shou…  │',
    ' │                                    │',
    ' │  st-admin            ◆ waiting 1m  │',
    ' │  ◆ asks: Bash: rm -rf tmp/         │',
    ' │                                    │',
    ' │  st-docs             your turn 1h  │',
    ' ╰────────────────────────────────────╯',
  ])
})

test('the asks line: yellow border, dim options, a button that jumps to the session, not a second j/k stop', () => {
  const l = layout(NEEDS, view(80))
  const top = l.rows.find(r => r.text().includes('╭─ acme-store'))!
  expect(top.cells[1]!.s.c).toBe('wait')
  const asks = l.rows.find(r => r.text().includes('date-fns'))!
  expect(asks.item).toBe('s:s-st-api')
  expect(asks.head).toBe(undefined)
  const opts = asks.segs().find(sg => sg.t.includes('date-fns'))!
  expect(opts.s.dim).toBe(true)
  expect(asks.buttons.map(b => [b.key, b.action])).toEqual([
    ['s:s-st-api:asks', { kind: 'jump', jump: { kind: 'tmux', target: 'acme-store:@3.%11' } }],
  ])
  expect(l.items.filter(k => k.endsWith(':asks'))).toEqual([])
  for (const width of [12, 30, 40, 60, 88]) for (const r of layout(NEEDS, view(width)).rows) expect(cellLen(r.text()) <= width).toBe(true)
})

test('the engine validates the asks line on terminal and desktop, one Button per wait', async ($, on) => {
  on('ui.render', { component: 'Pane', requestId: 'needs-probe' }, ($, e) => {
    const l = layout(NEEDS, { ...view(e.props.bodyColumns), rows: e.props.scroll.bodyRows })
    return drawPane(l.rows, { el: $.ui.resolve(e), onAction: () => undefined })
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const w of [40, 80]) {
      const ui = await $.ui.mount({
        plugin: 'hq',
        surface,
        component: 'Pane',
        requestId: 'needs-probe',
        props: { title: 'hq', isFocused: false, bodyColumns: w, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 58 }, view: {} },
      })
      const asks = (await ui.findAll({ type: 'Button' })).filter(b => String(b.props.key ?? b.key).endsWith(':asks'))
      expect(asks.length).toBe(2)
      await ui.unmount()
    }
  }
})
