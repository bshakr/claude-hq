import { describe, expect, test } from 'claude-code/testing'

import type { HqModel } from '../../hooks/model/types'
import { layout } from '../../hooks/ui/layout'
import type { View } from '../../hooks/ui/layout'
import { filledCells, meterParts, usageTone } from '../../hooks/ui/meter'
import type { Row, Sty } from '../../hooks/ui/row'
import { cellLen } from '../../hooks/ui/text'
import { BUSY } from './fixtures'
import * as SHEET from './sheet'
import { METERED, ctx } from './usage-fixtures'

const view = (over: Partial<View> = {}): View => ({
  width: 80, rows: 20, focused: false, cursor: null, expanded: [], scroll: 0, phase: 0, ...over,
})
const rowsOf = (m: HqModel, width: number) => layout(m, view({ width })).rows
const lines = (m: HqModel, width: number) => rowsOf(m, width).map(r => r.text())

const M80 = [
  ' ● 1 working · nothing needs you                                  5h 5% · wk 18%',
  '',
  ' ╭─ this session ─────────────────────────────────────────────────────────────╮',
  ' │                                                                            │',
  ' │  Session usage meters                                    day 2  ▰▰▱▱▱ 28%  │',
  ' │                                                                            │',
  ' ╰────────────────────────────────────────────────────────────────────────────╯',
  '',
  ' ╭─ work ─────────────────────────────────────────────────────────────────────╮',
  ' │  rp-api                                      2 PRs · ● busy 6m  ▰▰▰▱▱ 55%  │',
  ' │                                                                            │',
  ' │  rp-docs                                               idle 1h  ▰▰▰▰▰ 85%  │',
  ' │                                                                            │',
  ' │  fresh                                                            idle 1m  │',
  ' ╰────────────────────────────────────────────────────────────────────────────╯',
]

// Narrow: rp-api keeps its PR count and drops the meter's cells first; the header keeps 5h only.
const M40 = [
  ' ● 1 working · nothing needs you   5h 5%',
  '',
  ' ╭─ this session ─────────────────────╮',
  ' │                                    │',
  ' │  Session usage…  day 2  ▰▰▱▱▱ 28%  │',
  ' │                                    │',
  ' ╰────────────────────────────────────╯',
  '',
  ' ╭─ work ─────────────────────────────╮',
  ' │  rp-api    2 PRs · ● busy 6m  55%  │',
  ' │                                    │',
  ' │  rp-docs       idle 1h  ▰▰▰▰▰ 85%  │',
  ' │                                    │',
  ' │  fresh                    idle 1m  │',
  ' ╰────────────────────────────────────╯',
]

/** Style of the first cell of `text` in a row. */
function styleAt(r: Row, text: string): Sty {
  const at = r.text().indexOf(text)
  if (at < 0) throw new Error(`${text} not in ${r.text()}`)
  return r.cells[[...r.text().slice(0, at)].reduce((n, ch) => n + cellLen(ch), 0)]!.s
}

describe('sheet', () => {
  test('80 cols: meter on each first line, plan usage once in the header', () => expect(lines(METERED, 80).slice(0, 15)).toEqual(M80))
  test('40 cols: meter cells drop before the percent', () => expect(lines(METERED, 40).slice(0, 15)).toEqual(M40))
  test('30 cols: PR facts drop next; the percent stays', () => {
    const l = lines(METERED, 30)
    expect(l[9]).toBe(' │  rp-api  ● busy 6m  55%  │')
    expect(l[4]).toBe(' │  Session u…  day 2  28%  │')
  })
  test('narrower still: the percent goes before the status', () => {
    const docs = lines(METERED, 26)[11]!
    expect(docs).toBe(' │  rp-docs    idle 1h  │')
  })
  test('without figures nothing is drawn: the sheet stays as it was', () => {
    expect(layout(BUSY, view({ rows: 64 })).rows.map(r => r.text())).toEqual(SHEET.a80)
  })
  test('rows never pass the width', () => {
    for (const width of [12, 20, 30, 40, 48, 60, 80, 120]) for (const r of rowsOf(METERED, width)) expect(cellLen(r.text()) <= width).toBe(true)
  })
})

describe('colour thresholds', () => {
  test('dim below 50, warn from 50, fail from 80', () => {
    expect(usageTone(0)).toEqual({ dim: true })
    expect(usageTone(49)).toEqual({ dim: true })
    expect(usageTone(50)).toEqual({ c: 'wait' })
    expect(usageTone(79)).toEqual({ c: 'wait' })
    expect(usageTone(80)).toEqual({ c: 'fail' })
    expect(usageTone(100)).toEqual({ c: 'fail' })
  })

  test('cells: any use lights one, five at 81 and up', () => {
    expect([0, 1, 20, 21, 28, 40, 55, 80, 81, 100].map(p => filledCells(p))).toEqual([0, 1, 1, 2, 2, 2, 3, 4, 5, 5])
  })

  test('meter parts: filled cells and percent take the tone, empty cells stay dim, no backgrounds', () => {
    const { full, pct } = meterParts(ctx(55))
    expect(full.map(p => p.t).join('')).toBe('  ▰▰▰▱▱ 55%')
    expect(full.map(p => p.s)).toEqual([{}, { c: 'wait' }, { dim: true }, { c: 'wait' }])
    expect(pct.map(p => p.t).join('')).toBe('  55%')
    expect(meterParts(undefined)).toEqual({ full: [], pct: [] })
  })

  for (const width of [40, 80]) {
    test(`${width} cols: each meter and header figure is coloured by its threshold`, () => {
      const r = rowsOf(METERED, width)
      expect(styleAt(r[4]!, '28%')).toEqual({ dim: true })
      expect(styleAt(r[9]!, '55%')).toEqual({ c: 'wait' })
      expect(styleAt(r[11]!, '85%')).toEqual({ c: 'fail' })
      expect(styleAt(r[11]!, '▰')).toEqual({ c: 'fail' })
      expect(styleAt(r[0]!, '5h')).toEqual({ dim: true })
      expect(styleAt(r[0]!, '5%')).toEqual({ dim: true })
    })
  }

  test('header: 5h and weekly figures warn past 50 and fail past 80', () => {
    const r = rowsOf({ ...METERED, account: { fiveHour: 85, week: 50 } }, 80)[0]!
    expect(r.text().endsWith('5h 85% · wk 50%')).toBe(true)
    expect(styleAt(r, '85%')).toEqual({ c: 'fail' })
    expect(styleAt(r, '50%')).toEqual({ c: 'wait' })
    expect(styleAt(r, 'wk')).toEqual({ dim: true })
  })

  test('header: a figure keeps the precision the engine sent', () => {
    expect(rowsOf({ ...METERED, account: { fiveHour: 23.5 } }, 80)[0]!.text().endsWith('5h 23.5%')).toBe(true)
  })
})
