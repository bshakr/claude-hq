import { describe, expect, test } from 'claude-code/testing'

import type { HqModel } from '../../hooks/model/types'
import { layout } from '../../hooks/ui/layout'
import type { View } from '../../hooks/ui/layout'
import { accountParts, bar, filledCells, meterParts, usageTone } from '../../hooks/ui/meter'
import type { Row, Sty } from '../../hooks/ui/row'
import { cellLen, clip } from '../../hooks/ui/text'
import { BUSY } from './fixtures'
import * as SHEET from './sheet'
import { METERED, ctx } from './usage-fixtures'

const view = (over: Partial<View> = {}): View => ({
  width: 80,
  rows: 20,
  focused: false,
  cursor: null,
  expanded: [],
  scroll: 0,
  phase: 0,
  ...over,
})
const rowsOf = (m: HqModel, width: number) => layout(m, view({ width })).rows
const lines = (m: HqModel, width: number) => rowsOf(m, width).map(r => r.text())

const M80 = [
  '                                          5h ● ● ● ● ● ● 5% · wk ● ● ● ● ● ● 18%',
  '',
  ' ╭─ claude-hq · this session ─────────────────────────────────────────────────╮',
  ' │  Session usage meters                         day 2 · idle  ● ● ● ● ● 28%  │',
  ' │  Wiring the header bars                                                    │',
  ' ╰────────────────────────────────────────────────────────────────────────────╯',
  '',
  ' ── other sessions ────────────────────────────────────────────────────────────',
  '',
  ' ╭─ work ─────────────────────────────────────────────────────────────────────╮',
  ' │  rp-api                                  2 PRs · ✻ busy 6m  ● ● ● ● ● 55%  │',
  ' │                                                                            │',
  ' │  rp-docs                                           idle 1h  ● ● ● ● ● 85%  │',
  ' │                                                                            │',
  ' │  fresh                                                            idle 1m  │',
  ' ╰────────────────────────────────────────────────────────────────────────────╯',
]

// Narrow: the session meters drop their bars before rp-api drops its PR count; rp-docs keeps its bar.
const M40 = [
  '  5h ● ● ● ● ● ● 5% · wk ● ● ● ● ● ● 18%',
  '',
  ' ╭─ claude-hq · this session ─────────╮',
  ' │  Session usag…  day 2 · idle  28%  │',
  ' │  Wiring the header bars            │',
  ' ╰────────────────────────────────────╯',
  '',
  ' ── other sessions ────────────────────',
  '',
  ' ╭─ work ─────────────────────────────╮',
  ' │  rp-api    2 PRs · ✻ busy 6m  55%  │',
  ' │                                    │',
  ' │  rp-docs   idle 1h  ● ● ● ● ● 85%  │',
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

// A lit dot and an unlit one.
const ON = '●'
const OFF = '●'
// n dots a space apart.
const dots = (n: number) => Array(n).fill(ON).join(' ')

// Lit and unlit dots share a glyph, so tell them apart by their segments' style.
const dotSegs = (r: { segs(): { t: string; s: object }[] }) =>
  r
    .segs()
    .filter(x => x.t.includes(ON))
    .map(x => ({ t: x.t.trim(), s: x.s }))

describe('sheet', () => {
  test('80 cols: meter on each first line, plan usage once in the header', () => expect(lines(METERED, 80).slice(0, 16)).toEqual(M80))
  test('40 cols: meter cells drop before the percent', () => expect(lines(METERED, 40).slice(0, 16)).toEqual(M40))
  test('30 cols: PR facts drop next; the percent stays', () => {
    const l = lines(METERED, 30)
    expect(l[10]).toBe(' │  rp-api  ✻ busy 6m  55%  │')
    expect(l[3]).toBe(' │  Session us…  idle  28%  │')
  })
  test('narrower still: the percent goes before the status', () => {
    const docs = lines(METERED, 26)[12]!
    expect(docs).toBe(' │  rp-docs    idle 1h  │')
  })
  test('without figures nothing is drawn: the sheet stays as it was', () => {
    expect(layout(BUSY, view({ rows: 64 })).rows.map(r => r.text())).toEqual(SHEET.a80)
  })
  test('rows never pass the width', () => {
    for (const width of [12, 20, 30, 40, 48, 60, 80, 120])
      for (const r of rowsOf(METERED, width)) expect(cellLen(r.text()) <= width).toBe(true)
  })
})

describe('colour thresholds', () => {
  test('green below 50, yellow from 50, red from 80, the context meter and plan usage alike', () => {
    expect([0, 49, 49.9, 50, 79, 79.9, 80, 100].map(p => usageTone(p).c)).toEqual([
      'ok',
      'ok',
      'ok',
      'wait',
      'wait',
      'wait',
      'fail',
      'fail',
    ])
  })

  test('cells: any use lights one, five at 81 and up', () => {
    expect([0, 1, 20, 21, 50, 80, 81, 100].map(p => filledCells(p))).toEqual([0, 1, 1, 2, 3, 4, 5, 5])
  })

  test('meter parts: the lit dots and percent take the tone, the rest are dim', () => {
    const { full, pct } = meterParts(ctx(55))
    expect(full.map(p => p.t).join('')).toBe(`  ${dots(3)} ${dots(2)} 55%`)
    expect(full.map(p => p.s)).toEqual([{}, { c: 'wait' }, {}, { dim: true }, { c: 'wait' }])
    expect(pct.map(p => p.t).join('')).toBe('  55%')
    expect(pct[1]!.s).toEqual({ c: 'wait' })
    expect(meterParts(undefined)).toEqual({ full: [], pct: [] })
  })

  for (const width of [40, 80]) {
    test(`${width} cols: each meter and header figure is coloured by its threshold`, () => {
      const r = rowsOf(METERED, width)
      expect(styleAt(r[3]!, '28%')).toEqual({ c: 'ok' })
      expect(styleAt(r[10]!, '55%')).toEqual({ c: 'wait' })
      expect(styleAt(r[12]!, '85%')).toEqual({ c: 'fail' })
      expect(styleAt(r[12]!, ON)).toEqual({ c: 'fail' })
      expect(styleAt(r[0]!, '5h')).toEqual({ dim: true })
      expect(styleAt(r[0]!, '5%')).toEqual({ c: 'ok' })
      expect(dotSegs(r[0]!)).toEqual([
        { t: ON, s: { c: 'ok' } },
        { t: dots(5), s: { dim: true } },
        { t: dots(2), s: { c: 'ok' } },
        { t: dots(4), s: { dim: true } },
      ])
    })
  }

  test('header: plan bars are green, yellow from 50% used, red from 80%; the lit dots and figure share the colour', () => {
    const r = rowsOf({ ...METERED, account: { fiveHour: 85, week: 50 } }, 80)[0]!
    expect(r.text().endsWith(`5h ${dots(6)} 85% · wk ${dots(3)} ${dots(3)} 50%`)).toBe(true)
    expect(dotSegs(r)).toEqual([
      { t: dots(6), s: { c: 'fail' } },
      { t: dots(3), s: { c: 'wait' } },
      { t: dots(3), s: { dim: true } },
    ])
    expect(styleAt(r, '85%')).toEqual({ c: 'fail' })
    expect(styleAt(r, '50%')).toEqual({ c: 'wait' })
    expect(styleAt(r, 'wk')).toEqual({ dim: true })
  })

  test('header: narrowing drops the bars, then the week', () => {
    const at = (w: number) => rowsOf(METERED, w)[0]!.text().trim()
    expect(at(39)).toBe('5h 5% · wk 18%')
    expect(at(40)).toBe(`5h ${dots(1)} ${dots(5)} 5% · wk ${dots(2)} ${dots(4)} 18%`)
    expect(at(30)).toBe('5h 5% · wk 18%')
    expect(at(26)).toBe('5h 5% · wk 18%')
    expect(at(14)).toBe('5h 5%')
    expect(
      accountParts({ fiveHour: 5 }, false)
        .map(p => p.t)
        .join(''),
    ).toBe('5h 5%')
  })

  test('header: a figure keeps the precision the engine sent', () => {
    expect(
      rowsOf({ ...METERED, account: { fiveHour: 23.5 } }, 80)[0]!
        .text()
        .endsWith(`5h ${dots(2)} ${dots(4)} 23.5%`),
    ).toBe(true)
  })
})

describe('the bar', () => {
  const drawn = (p: number, n: number) =>
    bar(p, n, usageTone(p))
      .map(x => x.t)
      .join('')

  test('session bar at 0, 2, 28, 50 and 100%: all dim, then lit dots grow; always nine cells', () => {
    expect([0, 2, 28, 50, 100].map(p => drawn(p, 5))).toEqual([
      dots(5),
      `${dots(1)} ${dots(4)}`,
      `${dots(2)} ${dots(3)}`,
      `${dots(3)} ${dots(2)}`,
      dots(5),
    ])
    for (let p = 0; p <= 100; p++) expect(cellLen(drawn(p, 5))).toBe(9)
  })

  test('header bar: eleven cells, one lit dot per sixth, any use lights one', () => {
    expect([0, 1, 50, 83, 100].map(p => drawn(p, 6))).toEqual([
      dots(6),
      `${dots(1)} ${dots(5)}`,
      `${dots(3)} ${dots(3)}`,
      `${dots(5)} ${dots(1)}`,
      dots(6),
    ])
    for (let p = 0; p <= 100; p++) expect(cellLen(drawn(p, 6))).toBe(11)
  })

  test('lit dots take the tone, the rest are dim, a plain space between, and nothing more draws past 100%', () => {
    expect(bar(0, 5, usageTone(0))).toEqual([{ t: dots(5), s: { dim: true } }])
    expect(bar(100, 5, usageTone(100))).toEqual([{ t: dots(5), s: { c: 'fail' } }])
    expect(bar(150, 5, usageTone(150)).map(x => x.t)).toEqual([dots(5)])
    expect(bar(50, 5, usageTone(50))).toEqual([
      { t: dots(3), s: { c: 'wait' } },
      { t: ' ', s: {} },
      { t: dots(2), s: { dim: true } },
    ])
  })

  test('the dots are one cell each, so the right border stays put', () => {
    expect([ON, OFF].map(cellLen)).toEqual([1, 1])
    expect(cellLen(clip(dots(5), 3))).toBe(3)
  })
})
