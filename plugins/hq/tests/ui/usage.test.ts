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
  '                                                    5h \ue0b6\ue0b4\uee01\uee01\uee01\uee02 5% · wk \ue0b6\ue0b4\uee01\uee01\uee01\uee02 18%',
  '',
  ' ╭─ claude-hq · this session ─────────────────────────────────────────────────╮',
  ' │  Session usage meters                          day 2 · idle  \ue0b6█\ue0b4\uee01\uee01\uee01\uee01\uee02 28%  │',
  ' │  Wiring the header bars                                                    │',
  ' ╰────────────────────────────────────────────────────────────────────────────╯',
  '',
  ' ── other sessions ────────────────────────────────────────────────────────────',
  '',
  ' ╭─ work ─────────────────────────────────────────────────────────────────────╮',
  ' │  rp-api                                   2 PRs · ✻ busy 6m  \ue0b6███\ue0b4\uee01\uee01\uee02 55%  │',
  ' │                                                                            │',
  ' │  rp-docs                                            idle 1h  \ue0b6█████\ue0b4\uee02 85%  │',
  ' │                                                                            │',
  ' │  fresh                                                            idle 1m  │',
  ' ╰────────────────────────────────────────────────────────────────────────────╯',
]

// Narrow: the session meters drop their bars before rp-api drops its PR count; rp-docs keeps its bar.
const M40 = [
  '            5h \ue0b6\ue0b4\uee01\uee01\uee01\uee02 5% · wk \ue0b6\ue0b4\uee01\uee01\uee01\uee02 18%',
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
  ' │  rp-docs    idle 1h  \ue0b6█████\ue0b4\uee02 85%  │',
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

// The Nerd Font pill caps and the progress outline's empty ends and middle.
const L = '\ue0b6'
const R = '\ue0b4'
const O0 = '\uee00'
const O = '\uee01'
const O2 = '\uee02'

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

  test('cells: any use lights one, eight at 88 and up', () => {
    expect([0, 1, 12, 13, 28, 50, 87, 88, 100].map(p => filledCells(p))).toEqual([0, 1, 1, 2, 3, 4, 7, 8, 8])
  })

  test('meter parts: the pill and percent take the tone, the outline stays dim', () => {
    const { full, pct } = meterParts(ctx(55))
    expect(full.map(p => p.t).join('')).toBe(`  ${L}███${R}${O}${O}${O2} 55%`)
    expect(full.map(p => p.s)).toEqual([{}, { c: 'wait' }, { dim: true }, { c: 'wait' }])
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
      expect(styleAt(r[12]!, L)).toEqual({ c: 'fail' })
      expect(styleAt(r[0]!, '5h')).toEqual({ dim: true })
      expect(styleAt(r[0]!, '5%')).toEqual({ c: 'ok' })
      expect(styleAt(r[0]!, L)).toEqual({ c: 'ok' })
      expect(styleAt(r[0]!, O)).toEqual({ dim: true })
    })
  }

  test('header: plan bars are green, yellow from 50% used, red from 80%; the pill and figure share the colour', () => {
    const r = rowsOf({ ...METERED, account: { fiveHour: 85, week: 50 } }, 80)[0]!
    expect(r.text().endsWith(`5h ${L}████${R} 85% · wk ${L}█${R}${O}${O}${O2} 50%`)).toBe(true)
    expect(styleAt(r, `${L}████${R}`)).toEqual({ c: 'fail' })
    expect(styleAt(r, '85%')).toEqual({ c: 'fail' })
    expect(styleAt(r, `${L}█${R}`)).toEqual({ c: 'wait' })
    expect(styleAt(r, '50%')).toEqual({ c: 'wait' })
    expect(styleAt(r, 'wk')).toEqual({ dim: true })
    expect(r.segs().some(x => x.s.c !== undefined && (x.t.includes(O) || x.t.includes(O2)))).toBe(false)
  })

  test('header: narrowing drops the bars, then the week', () => {
    const at = (w: number) => rowsOf(METERED, w)[0]!.text().trim()
    expect(at(30)).toBe(`5h ${L}${R}${O}${O}${O}${O2} 5% · wk ${L}${R}${O}${O}${O}${O2} 18%`)
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
        .endsWith(`5h ${L}${R}${O}${O}${O}${O2} 23.5%`),
    ).toBe(true)
  })
})

describe('the bar', () => {
  const drawn = (p: number, cells: number) =>
    bar(p, cells, usageTone(p))
      .map(x => x.t)
      .join('')

  test('session bar at 0, 2, 28, 50 and 100%: outline, a lone pill, then the pill grows; always eight cells', () => {
    expect([0, 2, 28, 50, 100].map(p => drawn(p, 8))).toEqual([
      `${O0}${O}${O}${O}${O}${O}${O}${O2}`,
      `${L}${R}${O}${O}${O}${O}${O}${O2}`,
      `${L}█${R}${O}${O}${O}${O}${O2}`,
      `${L}██${R}${O}${O}${O}${O2}`,
      `${L}██████${R}`,
    ])
    for (let p = 0; p <= 100; p++) expect(cellLen(drawn(p, 8))).toBe(8)
  })

  test("header bar: six cells; a pill one short of full leaves only the outline's right end", () => {
    expect([0, 1, 50, 83, 100].map(p => drawn(p, 6))).toEqual([
      `${O0}${O}${O}${O}${O}${O2}`,
      `${L}${R}${O}${O}${O}${O2}`,
      `${L}█${R}${O}${O}${O2}`,
      `${L}███${R}${O2}`,
      `${L}████${R}`,
    ])
    for (let p = 0; p <= 100; p++) expect(cellLen(drawn(p, 6))).toBe(6)
  })

  test('the pill takes the tone, the outline is dim, and nothing draws at 0% or past 100%', () => {
    expect(bar(0, 8, usageTone(0))).toEqual([{ t: `${O0}${O}${O}${O}${O}${O}${O}${O2}`, s: { dim: true } }])
    expect(bar(100, 8, usageTone(100))).toEqual([{ t: `${L}██████${R}`, s: { c: 'fail' } }])
    expect(bar(150, 8, usageTone(150)).map(x => x.t)).toEqual([`${L}██████${R}`])
  })

  test('the Nerd Font glyphs are one cell each, so the right border stays put', () => {
    expect([L, R, O0, O, O2].map(cellLen)).toEqual([1, 1, 1, 1, 1])
    expect(cellLen(clip(`${L}██${R}`, 3))).toBe(3)
  })
})
