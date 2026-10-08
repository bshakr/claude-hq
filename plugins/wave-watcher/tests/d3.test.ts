import { describe, expect, test } from 'claude-code/testing'
import type { ElementTable, RenderElement } from 'claude-code'

import type { WaveRow } from '../types'
import { sortRows } from '../hooks/logic'
import { TOKENS, grid, skylineLines, skylineStatus, style } from '../hooks/styles/d3'
import type { Line } from '../hooks/styles/d3'
import type { PaneCtx } from '../hooks/styles/types'

const T0 = 1_000_000_000
const URL = (repo: string, n: number) => `https://github.com/${repo}/pull/${n}`

function pr(repo: string, number: number, title: string, over: Partial<WaveRow> = {}): WaveRow {
  return {
    url: URL(repo, number), repo, number, title, status: 'open', isDraft: false,
    ci: { kind: 'green' }, merge: 'mergeable', gallery: 'none', mergedAt: null, ...over,
  }
}

const MONO = 'bshakr/monolense'
const ADMIN = 'ritualpass/admin-web'
const NOW = T0 + 20_000

const WAVE = sortRows([
  pr(ADMIN, 409, 'Sidebar: collapse state persists', { status: 'merged', gallery: 'linked', mergedAt: NOW - 180_000 }),
  pr(ADMIN, 421, 'Stat cards: one-decimal trend deltas', { gallery: 'linked' }),
  pr(MONO, 185, 'Pipeline: retry classification on timeout', { ci: { kind: 'running', done: 4, total: 7 }, isDraft: true }),
  pr(ADMIN, 418, 'Members table: sticky header on scroll', { merge: 'needs rebase', gallery: 'linked' }),
  pr(MONO, 183, 'Ledger: reconcile partial refunds', { ci: { kind: 'red', failing: 'rspec' } }),
])
const QUIET = [
  pr(ADMIN, 421, 'Stat cards: one-decimal trend deltas', { gallery: 'linked' }),
  pr(MONO, 186, 'Docs: ADR for refund reconciliation', { gallery: 'no visual change' }),
  pr(ADMIN, 423, 'Schedule: empty state copy', { gallery: 'linked' }),
]

type Fx = Pick<PaneCtx, 'rows' | 'polledAt' | 'now' | 'error'>
const FIX: Record<'a' | 'b' | 'c' | 'd' | 'f', Fx> = {
  a: { rows: WAVE, polledAt: T0, now: NOW, error: null },
  b: { rows: QUIET, polledAt: T0, now: T0 + 40_000, error: null },
  c: { rows: [], polledAt: T0, now: T0 + 10_000, error: null },
  d: { rows: QUIET, polledAt: T0, now: T0 + 180_000, error: 'gh: error connecting to api.github.com' },
  f: { rows: [], polledAt: null, now: T0, error: null },
}

function ctx(fx: Fx, over: Partial<PaneCtx> = {}): PaneCtx {
  return {
    ...fx, isWaking: true, width: 72, bodyRows: 30, placement: 'dock', isFocused: false, tick: 0,
    el: fakeEl, surface: 'terminal', ...over,
  }
}

// Constructors that return plain data, so render() can be compared byte for byte without an engine.
const make = (type: string) => (props: Record<string, unknown>) => {
  const { children, ...rest } = props
  return { type, props: rest, children: [children].flat(Infinity).filter(c => c != null) }
}
const fakeEl = { Box: make('Box'), Text: make('Text') } as unknown as ElementTable

const text = (line: Line) => line.map(s => s.t).join('')
const textOf = (lines: Line[]) => lines.map(text)

// The sheet's renders, verbatim (trailing blanks trimmed as the sheet prints them).
const SHEET = {
  a72: [
    '4 open                                          polled 20s ago · wake on',
    '',
    '  ████████',
    '  ████████   ████████',
    '  ████████   ████████   ▂▁▁▁▁▁▁▁',
    '  ████████   ████████   ████████   ▁▁▁▁▁▁▁▁',
    '  ────────────────────────────────────────────╌╌╌╌╌╌╌╌────────────────',
    '     1          2          3          4          5',
    '',
    ' 1  monolense#183  Ledger: reconcile partial refunds             ✗ rspec',
    ' 2  admin-web#418  Members table: sticky header on scroll       ↑ rebase',
    ' 3  monolense#185  ◇ Pipeline: retry classification on t…          ↻ 4/7',
    ' 4  admin-web#421  Stat cards: one-decimal trend deltas                ◆',
    ' 5  admin-web#409  Sidebar: collapse state persists        merged 3m ago',
  ],
  b72: [
    '3 open                                          polled 40s ago · wake on',
    '', '', '', '',
    '  ▁▁▁▁▁▁▁▁   ▁▁▁▁▁▁▁▁   ▁▁▁▁▁▁▁▁',
    '  ────────────────────────────────────────────────────────────────────',
    '     1          2          3',
    '',
    ' 1  admin-web#421  Stat cards: one-decimal trend deltas                ◆',
    ' 2  monolense#186  Docs: ADR for refund reconciliation                 ≡',
    ' 3  admin-web#423  Schedule: empty state copy                          ◆',
  ],
  c72: [
    '0 open                                          polled 10s ago · wake on',
    '', '', '', '', '',
    '  ────────────────────────────────────────────────────────────────────',
    '',
    '  No open PRs. The horizon is clear.',
  ],
  d72: [
    '3 open                                   last good poll 3m ago · wake on',
    '× gh: error connecting to api.github.com',
    '', '', '', '',
    '  ▁▁▁▁▁▁▁▁   ▁▁▁▁▁▁▁▁   ▁▁▁▁▁▁▁▁',
    '  ────────────────────────────────────────────────────────────────────',
    '     1          2          3',
    '',
    ' 1  admin-web#421  Stat cards: one-decimal trend deltas                ◆',
    ' 2  monolense#186  Docs: ADR for refund reconciliation                 ≡',
    ' 3  admin-web#423  Schedule: empty state copy                          ◆',
  ],
  f72: [
    'wave                                        first poll running · wake on',
    '', '', '', '', '',
    '  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
    '',
    '  Listening for the first poll…',
  ],
  a60: [
    '4 open                              polled 20s ago · wake on',
    '',
    '  ████████',
    '  ████████   ████████',
    '  ████████   ████████   ▂▁▁▁▁▁▁▁',
    '  ████████   ████████   ████████   ▁▁▁▁▁▁▁▁',
    '  ────────────────────────────────────────────╌╌╌╌╌╌╌╌────',
    '     1          2          3          4          5',
    '',
    ' 1  monolense#183  Ledger: reconcile partial…        ✗ rspec',
    ' 2  admin-web#418  Members table: sticky hea…       ↑ rebase',
    ' 3  monolense#185  ◇ Pipeline: retry classif…          ↻ 4/7',
    ' 4  admin-web#421  Stat cards: one-decimal t…              ◆',
    ' 5  admin-web#409  Sidebar: collapse state p…  merged 3m ago',
  ],
  motion1: [
    '  ████████',
    '  ████████   ████████',
    '  ████████   ████████   ▁▂▁▁▁▁▁▁',
    '  ████████   ████████   ████████   ▁▁▁▁▁▁▁▁',
  ],
}

const GLYPHS = new Set([...'█▁▂▃▄▅▆▇─╌✗↑↻◆≡·◇×…'])
const FOOTER = 'gh every 60s · 0 model tokens'

describe('D3 Skyline renders the sheet cell for cell', () => {
  for (const [name, fx, width] of [
    ['a72', FIX.a, 72], ['b72', FIX.b, 72], ['c72', FIX.c, 72], ['d72', FIX.d, 72], ['f72', FIX.f, 72], ['a60', FIX.a, 60],
  ] as const) {
    test(`${name}`, async () => {
      const lines = textOf(skylineLines(ctx(fx, { width })))
      const want = SHEET[name]
      expect(lines.slice(0, want.length)).toEqual([...want])
      expect(lines.at(-1)).toBe(FOOTER)
      expect(lines.length).toBe(30)
    })
  }

  test('motion frame t+1s moves the bump one cell right', async () => {
    expect(textOf(skylineLines(ctx(FIX.a, { tick: 1 }))).slice(2, 6)).toEqual(SHEET.motion1)
  })

  test('the footer follows the content when the pane is shorter than the tree', async () => {
    const lines = textOf(skylineLines(ctx(FIX.a, { bodyRows: 8 })))
    expect(lines.slice(-2)).toEqual(['', FOOTER])
    expect(lines.length).toBe(16)
  })
})

describe('D3 Skyline invariants', () => {
  const allStates = Object.values(FIX)

  test('no line exceeds ctx.width at 48 to 85, every state, and only listed glyphs appear', async () => {
    for (const fx of allStates) {
      for (let width = 48; width <= 85; width++) {
        for (const line of skylineLines(ctx(fx, { width }))) {
          const s = text(line)
          expect([...s].length).toBeLessThanOrEqual(width)
          for (const ch of s) {
            if (ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) < 0x7f) continue
            if (!GLYPHS.has(ch)) throw new Error(`glyph ${JSON.stringify(ch)} outside the sheet's vocabulary at ${width}`)
          }
          expect(s.includes('️')).toBe(false)
        }
      }
    }
  })

  test('below 48 columns only the count line (and error) draw, never wider than the pane', async () => {
    for (const width of [20, 30, 47]) {
      const lines = textOf(skylineLines(ctx(FIX.d, { width })))
      expect(lines.length).toBe(2)
      for (const s of lines) expect([...s].length).toBeLessThanOrEqual(width)
    }
    expect(textOf(skylineLines(ctx(FIX.a, { width: 47 })))).toEqual(['4 open · polled 20s ago · wake on'])
  })

  test('colour inventory in (a): exactly the sheet list, nothing dim and coloured, no background', async () => {
    const lines = skylineLines(ctx(FIX.a))
    const coloured = lines.flatMap((line, y) => line.filter(s => s.color).map(s => `${y}:${s.color}:${s.t}`))
    expect(coloured).toEqual([
      '2:fail:████████',
      '3:fail:████████', '3:warn:████████',
      '4:fail:████████', '4:warn:████████', '4:run:▂▁▁▁▁▁▁▁',
      '5:fail:████████', '5:warn:████████', '5:run:████████',
      '6:rule:────────────────────────────────────────────╌╌╌╌╌╌╌╌────────────────',
      '7:merged:5',
      '9:fail:✗ rspec', '10:warn:↑ rebase', '11:run:↻ 4/7',
    ])
    expect(lines.flat().some(s => s.color && s.dim)).toBe(false)
    const tree = JSON.stringify(style.render(ctx(FIX.a)))
    expect(tree.includes('backgroundColor')).toBe(false)
    const colours = [...tree.matchAll(/"color":"([^"]+)"/g)].map(m => m[1])
    for (const c of colours) expect(Object.values(TOKENS)).toContain(c)
    expect(tree.includes('ansi256(2)')).toBe(false)
  })

  test('quiet (b) has zero coloured cells besides the rule baseline, and three dim ▁ runs', async () => {
    const lines = skylineLines(ctx(FIX.b))
    const coloured = lines.flat().filter(s => s.color)
    expect(coloured.map(s => s.color)).toEqual(['rule'])
    expect(lines[5]!.filter(s => s.t === '▁▁▁▁▁▁▁▁' && s.dim).length).toBe(3)
  })

  test('bold only on problem refs (2 in (a)), and none in the stale error state', async () => {
    const bold = (fx: Fx) => skylineLines(ctx(fx)).flat().filter(s => s.bold).map(s => s.t)
    expect(bold(FIX.a)).toEqual(['monolense#183', 'admin-web#418'])
    expect(bold({ ...FIX.a, error: 'gh: boom' })).toEqual([])
  })

  test('(d): error line in warn, stale refs dim, problem colours kept', async () => {
    const lines = skylineLines(ctx({ ...FIX.a, error: 'gh: boom' }))
    expect(lines[1]).toEqual([{ t: '× gh: boom', color: 'warn' }])
    const legend = lines.slice(10, 15)
    for (const line of legend) expect(line[1]!.dim).toBe(true)
    expect(legend.map(line => line.at(-1)!.color)).toEqual(['fail', 'warn', 'run', undefined, undefined])
  })

  test('wake off is dim and never coloured', async () => {
    const head = skylineLines(ctx(FIX.b, { isWaking: false }))[0]!
    expect(head.at(-1)).toEqual({ t: 'wake off', dim: true })
  })

  test('the problem rows sit in the top 8 body rows of the chart: bars 1 and 2 are towers', async () => {
    const lines = textOf(skylineLines(ctx(FIX.a)))
    expect(lines[2]!.slice(2, 10)).toBe('████████')
    expect(lines[3]!.slice(13, 21)).toBe('████████')
  })

  test('bar heights: running never above 16 eighths, problems never under 24', async () => {
    const at = (row: WaveRow) => textOf(skylineLines(ctx({ ...FIX.a, rows: [row] }))).slice(2, 6)
    const full = pr(MONO, 1, 't', { ci: { kind: 'running', done: 99, total: 100 } })
    expect(at(full)).toEqual(['', '  ▁', '  ████████', '  ████████'])
    const none = pr(MONO, 2, 't', { ci: { kind: 'running', done: 0, total: 9 } })
    expect(at(none)).toEqual(['', '', '', '  ▂▁▁▁▁▁▁▁'])
    expect(at(pr(MONO, 3, 't', { merge: 'conflicting' }))).toEqual(Array(4).fill('  ████████'))
    expect(at(pr(MONO, 4, 't', { merge: 'unknown' }))).toEqual(['', '  ████████', '  ████████', '  ████████'])
  })

  test('30 PRs at 60 columns: bw 1, gap 0, chart inside cells 2..57, numerals only on problems', async () => {
    expect(grid(30, 60)).toEqual({ bw: 1, gap: 0 })
    expect(grid(5, 72)).toEqual({ bw: 8, gap: 3 })
    expect(grid(5, 60)).toEqual({ bw: 8, gap: 3 })
    const rows = sortRows(Array.from({ length: 30 }, (_, i) =>
      pr(MONO, i + 1, `PR ${i + 1}`, i === 4 ? { ci: { kind: 'red', failing: 'build-and-test' } } : {})))
    const lines = textOf(skylineLines(ctx({ ...FIX.a, rows }, { width: 60 })))
    expect(lines[5]).toBe(`  █${'▁'.repeat(29)}`)
    expect(lines[7]).toBe('  1')
    expect(lines[9]).toContain('✗ build-and-t…')
  })
})

describe('D3 Skyline motion', () => {
  const cellsDiffering = (a: string[], b: string[]) => {
    const out: string[] = []
    a.forEach((line, y) => {
      const ca = [...line]
      const cb = [...(b[y] ?? '')]
      for (let x = 0; x < Math.max(ca.length, cb.length); x++) if (ca[x] !== cb[x]) out.push(`${y}:${x}`)
    })
    return out
  }

  test('(a): exactly 2 cells change per tick, both in the running bar top row, wrapping at bw', async () => {
    for (let tick = 0; tick < 10; tick++) {
      const now = textOf(skylineLines(ctx(FIX.a, { tick })))
      const next = textOf(skylineLines(ctx(FIX.a, { tick: tick + 1 })))
      const p = tick % 8
      const q = (tick + 1) % 8
      expect(cellsDiffering(now, next)).toEqual([`4:${24 + Math.min(p, q)}`, `4:${24 + Math.max(p, q)}`])
    }
  })

  test('idle states return a byte-identical tree across ticks', async () => {
    for (const fx of [FIX.b, FIX.c, FIX.d, FIX.f]) {
      const a = JSON.stringify(style.render(ctx(fx, { tick: 7 })))
      const b = JSON.stringify(style.render(ctx(fx, { tick: 8 })))
      expect(b).toBe(a)
    }
  })

  test('a running PR hidden under a rebase tower does not animate', async () => {
    const rows = [pr(MONO, 1, 't', { merge: 'needs rebase', ci: { kind: 'running', done: 1, total: 3 } })]
    const a = JSON.stringify(style.render(ctx({ ...FIX.a, rows }, { tick: 1 })))
    const b = JSON.stringify(style.render(ctx({ ...FIX.a, rows }, { tick: 2 })))
    expect(b).toBe(a)
  })

  test('the style declares animated so register.tsx runs the 1 s tick', async () => {
    expect(style.meta).toMatchObject({ id: 'd3', name: 'Skyline', animated: true })
  })
})

test('status line per the sheet, under 48 chars, worst first', async () => {
  expect(skylineStatus(FIX.a.rows, null, FIX.a.polledAt, FIX.a.now)).toBe('wave: 1 red · 1 rebase · 1 running · 1 green')
  expect(skylineStatus(FIX.b.rows, null, FIX.b.polledAt, FIX.b.now)).toBe('wave: 3 green')
  expect(skylineStatus([], null, FIX.c.polledAt, FIX.c.now)).toBe('wave: none open')
  expect(skylineStatus(FIX.d.rows, FIX.d.error, FIX.d.polledAt, FIX.d.now)).toBe('wave: gh unreachable 3m')
  const many = Array.from({ length: 12 }, (_, i) => pr(MONO, i, 't', {
    ci: i % 2 ? { kind: 'red', failing: 'x' } : { kind: 'running', done: 1, total: 2 },
    merge: i % 3 ? 'mergeable' : 'conflicting',
  }))
  expect(skylineStatus(many, null, T0, NOW).length).toBeLessThan(48)
})

test('the engine validates every state of the drawn tree', async ($, on) => {
  let current: Fx = FIX.a
  let tick = 0
  on('ui.render', { component: 'Pane', requestId: 'd3-probe' }, ($, e) =>
    style.render({
      ...current, isWaking: true, width: e.props.bodyColumns, bodyRows: e.props.scroll.bodyRows,
      placement: e.props.placement, isFocused: e.props.isFocused, tick, el: $.ui.resolve(e), surface: e.surface,
    }),
  )
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const fx of Object.values(FIX)) {
      current = fx
      const ui = await $.ui.mount({
        plugin: 'wave-watcher', surface, component: 'Pane', requestId: 'd3-probe',
        props: { title: 'Wave', isFocused: false, bodyColumns: 72, placement: 'dock', scroll: { offset: 0, bodyRows: 24 }, view: {} },
      })
      const drawn: RenderElement = await ui.drawn()
      expect(drawn).toMatchObject({ type: 'Box' })
      expect(JSON.stringify(drawn).includes('backgroundColor')).toBe(false)
      tick += 1
      await ui.redraw()
      const again = await ui.drawn()
      if (fx !== FIX.a) expect(JSON.stringify(again)).toBe(JSON.stringify(drawn))
      else expect(JSON.stringify(again)).not.toBe(JSON.stringify(drawn))
      await ui.unmount()
    }
  }
})

