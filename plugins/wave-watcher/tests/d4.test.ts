import { describe, expect, mock, test } from 'claude-code/testing'
import type { ElementTable, On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import type { WaveRow } from '../types'
import {
  DEFAULT_COLOR,
  RASTER_KEY,
  encodeCells,
  isSafeCell,
  paperLines,
  rasterSize,
  style,
} from '../hooks/styles/d4'
import type { PaneCtx } from '../hooks/styles/types'

const NOW = 1_000_000_000
const RASTER = Symbol('raster')

const fakeEl = {
  Raster: (props: unknown) => ({ [RASTER]: true, props }),
} as unknown as ElementTable<'terminal'>

function row(repo: string, number: number, title: string, over: Partial<WaveRow> = {}): WaveRow {
  return {
    url: `https://github.com/${repo}/pull/${number}`,
    repo,
    number,
    title,
    status: 'open',
    isDraft: false,
    ci: { kind: 'green' },
    merge: 'mergeable',
    gallery: 'none',
    mergedAt: null,
    ...over,
  }
}

const MONO = 'bshakr/monolense'
const ADMIN = 'ritualpass/admin-web'

// Fixture (a), in the data layer's sort order.
const WAVE: WaveRow[] = [
  row(MONO, 183, 'Ledger: reconcile partial refunds', { ci: { kind: 'red', failing: 'rspec' } }),
  row(ADMIN, 418, 'Members table: sticky header on scroll', { merge: 'needs rebase', gallery: 'linked' }),
  row(MONO, 185, 'Pipeline: retry classification on timeout', { ci: { kind: 'running', done: 4, total: 7 }, isDraft: true }),
  row(ADMIN, 421, 'Stat cards: one-decimal trend deltas', { gallery: 'linked' }),
  row(ADMIN, 409, 'Sidebar: collapse state persists', { status: 'merged', merge: 'unknown', gallery: 'linked', mergedAt: NOW - 180_000 }),
]

const QUIET: WaveRow[] = [
  row(MONO, 186, 'Docs: ADR for refund reconciliation', { gallery: 'no visual change' }),
  row(ADMIN, 421, 'Stat cards: one-decimal trend deltas', { gallery: 'linked' }),
  row(ADMIN, 423, 'Schedule: empty state copy', { gallery: 'linked' }),
]

function ctx(over: Partial<PaneCtx> = {}): PaneCtx {
  return {
    rows: WAVE,
    polledAt: NOW - 20_000,
    now: NOW,
    error: null,
    isWaking: true,
    width: 72,
    bodyRows: 20,
    placement: 'dock',
    isFocused: false,
    tick: 0,
    el: fakeEl,
    surface: 'terminal',
    ...over,
  }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function decode(cells: string): number[] {
  const bytes: number[] = []
  for (let i = 0; i < cells.length; i += 4) {
    const q = [0, 1, 2, 3].map(k => B64.indexOf(cells[i + k] ?? '='))
    const n = ((q[0] ?? 0) << 18) | ((q[1] ?? 0) << 12) | (Math.max(0, q[2] ?? 0) << 6) | Math.max(0, q[3] ?? 0)
    bytes.push((n >> 16) & 255)
    if (cells[i + 2] !== '=') bytes.push((n >> 8) & 255)
    if (cells[i + 3] !== '=') bytes.push(n & 255)
  }
  const words: number[] = []
  for (let i = 0; i + 3 < bytes.length; i += 4) {
    words.push(((bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8) | ((bytes[i + 2] ?? 0) << 16) | ((bytes[i + 3] ?? 0) << 24)) >>> 0)
  }
  return words
}

type RasterOut = { props: { key: string; columns: number; rows: number; cells: string } }

function raster(c: PaneCtx): RasterOut {
  const out = style.render(c) as unknown as Record<symbol, unknown> & RasterOut
  expect(out[RASTER]).toBe(true)
  return out
}

/** The Raster decoded back to lines of text, checking every fg/bg on the way. */
function rasterText(out: RasterOut): string[] {
  const { columns, rows, cells } = out.props
  const words = decode(cells)
  expect(words.length).toBe(columns * rows * 3)
  const lines: string[] = []
  for (let y = 0; y < rows; y++) {
    let line = ''
    for (let x = 0; x < columns; x++) {
      const at = (y * columns + x) * 3
      expect(words[at + 1]).toBe(DEFAULT_COLOR)
      expect(words[at + 2]).toBe(DEFAULT_COLOR)
      line += String.fromCodePoint(words[at] ?? 0)
    }
    lines.push(line)
  }
  return lines
}

const trimmed = (lines: string[]) => lines.map(line => line.trimEnd())

// The sheet's renders, verbatim.
const SHEET_A_72 = [
  '4 open                                          polled 20s ago · wake on',
  '',
  '   bshakr/monolense ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄',
  '██ ├─ #183  Ledger: reconcile partial refunds            ✗ rspec',
  '░░ └─ #185  ◇ Pipeline: retry classification on timeout  ▓▓▓▓░░░ 4/7',
  '',
  '   ritualpass/admin-web ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄',
  '██ ├─ #418  Members table: sticky header on scroll       needs rebase',
  '   ├─ #421  Stat cards: one-decimal trend deltas         ✓ gallery',
  '   └─ #409  Sidebar: collapse state persists             merged 3m ago',
]
const SHEET_B_72 = [
  '3 open                                          polled 40s ago · wake on',
  '',
  '   ritualpass/admin-web ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄',
  '   ├─ #421  Stat cards: one-decimal trend deltas         ✓ gallery',
  '   └─ #423  Schedule: empty state copy                   ✓ gallery',
  '',
  '   bshakr/monolense ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄',
  '   └─ #186  Docs: ADR for refund reconciliation          ✓ no visual',
]
const SHEET_C_72 = [
  '0 open                                          polled 10s ago · wake on',
  '',
  '   no open pull requests',
  '   nothing merged in the last 30 min',
]
const SHEET_D_72 = [
  '3 open                                   last good poll 3m ago · wake on',
  '×  gh: error connecting to api.github.com',
  ...SHEET_B_72.slice(1),
]
const SHEET_F_72 = ['wave                                        first poll running · wake on', '', '   ░ waiting for the first poll']
const SHEET_E_60 = [
  '4 open                              polled 20s ago · wake on',
  '',
  '   bshakr/monolense ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄',
  '██ ├─ #183  Ledger: reconcile partial refunds  ✗ rspec',
  '░░ └─ #185  ◇ Pipeline: retry classification…  4/7',
  '',
  '   ritualpass/admin-web ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄',
  '██ ├─ #418  Members table: sticky header on …  needs rebase',
  '   ├─ #421  Stat cards: one-decimal trend de…  ✓ gallery',
  '   └─ #409  Sidebar: collapse state persists   merged 3m ago',
]

const FOOTER = '   gh every 60s · 0 model tokens'

/** The sheet's render, then blank rows, then the footer on the last row. */
function page(sheet: string[], rows: number): string[] {
  return [...sheet, ...Array<string>(rows - sheet.length - 1).fill(''), FOOTER]
}

describe('D4 Paper: the sheet renders, cell for cell, through the Raster', () => {
  test('(a) wave at 72', async () => {
    expect(trimmed(rasterText(raster(ctx())))).toEqual(page(SHEET_A_72, 20))
  })
  test('(b) quiet at 72', async () => {
    expect(trimmed(rasterText(raster(ctx({ rows: QUIET, polledAt: NOW - 40_000 }))))).toEqual(page(SHEET_B_72, 20))
  })
  test('(c) empty at 72', async () => {
    expect(trimmed(rasterText(raster(ctx({ rows: [], polledAt: NOW - 10_000 }))))).toEqual(page(SHEET_C_72, 20))
  })
  test('(d) gh error at 72 keeps the stale rows unchanged', async () => {
    const c = ctx({ rows: QUIET, polledAt: NOW - 180_000, error: 'gh: error connecting to api.github.com' })
    expect(trimmed(rasterText(raster(c)))).toEqual(page(SHEET_D_72, 20))
  })
  test('(f) first poll at 72', async () => {
    expect(trimmed(rasterText(raster(ctx({ rows: [], polledAt: null }))))).toEqual(page(SHEET_F_72, 20))
  })
  test('(e) wave at 60: the bar drops, only d/t remains', async () => {
    expect(trimmed(rasterText(raster(ctx({ width: 60 }))))).toEqual(page(SHEET_E_60, 20))
  })
  test('wake off reads wake off', async () => {
    expect(paperLines(ctx({ isWaking: false }), 72, null)[0]?.trimEnd()).toMatch(/polled 20s ago · wake off$/)
  })
})

describe('D4 Paper: Raster validity', () => {
  test('size always matches the body, clamped to 512 x 256', async () => {
    for (const width of [1, 20, 47, 48, 60, 66, 72, 85, 600]) {
      for (const bodyRows of [1, 5, 20, 256, 300]) {
        const out = raster(ctx({ width, bodyRows }))
        expect(out.props.key).toBe(RASTER_KEY)
        expect(out.props.columns).toBe(Math.min(512, width))
        expect(out.props.rows).toBe(Math.min(256, bodyRows))
        expect(decode(out.props.cells).length).toBe(out.props.columns * out.props.rows * 3)
      }
    }
  })

  test('no Raster while the body is unmeasured or invalid', async () => {
    for (const [width, bodyRows] of [[0, 20], [72, 0], [-1, 20], [72.5, 20], [Number.NaN, 20]] as const) {
      expect(rasterSize(ctx({ width, bodyRows }))).toBeNull()
    }
    expect(rasterSize(ctx({ surface: 'desktop' }))).toBeNull()
  })

  test('every cell is fg and bg 0x01000000 and a safe width-1 BMP code point, in every state', async () => {
    const hostile = [
      row(MONO, 1, 'Ship 🚀 rocket\tnow ✅ done ❤️', { ci: { kind: 'red', failing: '测试 check 🔥' } }),
      row('東京/repo', 2, '全角タイトル é zero​width', { merge: 'conflicting' }),
    ]
    const states: Partial<PaneCtx>[] = [
      {},
      { rows: QUIET },
      { rows: [] },
      { rows: [], polledAt: null },
      { rows: QUIET, error: 'gh: error 💥\nsecond line' },
      { rows: hostile },
      { rows: hostile, width: 30 },
    ]
    for (const over of states) {
      for (const width of [over.width ?? 60, 72, 85]) {
        const out = raster(ctx({ ...over, width }))
        const words = decode(out.props.cells)
        for (let i = 0; i < words.length; i += 3) {
          const cp = words[i] ?? 0
          expect(isSafeCell(cp)).toBe(true)
          expect(words[i + 1]).toBe(DEFAULT_COLOR)
          expect(words[i + 2]).toBe(DEFAULT_COLOR)
        }
      }
    }
  })

  test('encodeCells pads short lines with spaces', async () => {
    const words = decode(encodeCells(['ab'], 3, 2))
    expect(words.filter((_, i) => i % 3 === 0)).toEqual([0x61, 0x62, 0x20, 0x20, 0x20, 0x20])
  })
})

describe('D4 Paper: invariants', () => {
  test('P3 gutter: two solid on the needs-you rows, one shaded on the running row', async () => {
    const lines = paperLines(ctx(), 72, 20)
    expect(lines.filter(line => line.startsWith('██')).map(line => line.slice(6, 10))).toEqual(['#183', '#418'])
    expect(lines.filter(line => line.startsWith('░░')).map(line => line.slice(6, 10))).toEqual(['#185'])
  })

  test('C12 both problems sit in the first 8 body rows', async () => {
    const lines = paperLines(ctx(), 72, 20)
    expect(lines.findIndex(line => line.includes('✗ rspec'))).toBeLessThan(8)
    expect(lines.findIndex(line => line.includes('needs rebase'))).toBeLessThan(8)
  })

  test('C8 the fact field starts on one cell on every row, at 85, 72 and 60', async () => {
    for (const width of [85, 72, 60]) {
      const factStart = width - (width >= 66 ? 15 : 13)
      const rows = paperLines(ctx({ width }), width, 20).filter(line => /^.. [├└]─ #/.test(line))
      expect(rows.length).toBe(5)
      for (const line of rows) {
        expect(line[factStart - 1]).toBe(' ')
        expect(line[factStart - 2]).toBe(' ')
        expect(line[factStart]).not.toBe(' ')
      }
    }
  })

  test('C6 no line is wider than the body at any width', async () => {
    for (let width = 20; width <= 85; width++) {
      for (const rows of [WAVE, QUIET, []]) {
        for (const line of paperLines(ctx({ rows, width }), width, 20)) expect([...line].length).toBe(width)
      }
    }
  })

  test('C11 idle ticks draw byte-equal frames in (a) and (b)', async () => {
    for (const rows of [WAVE, QUIET]) {
      expect(raster(ctx({ rows, tick: 7 })).props.cells).toBe(raster(ctx({ rows, tick: 8 })).props.cells)
    }
  })

  test('C14 a PR going green to running moves no other row and leaves the header width alone', async () => {
    const before = paperLines(ctx(), 72, 20)
    const swapped = WAVE.map(r => (r.number === 421 ? { ...r, ci: { kind: 'running' as const, done: 1, total: 3 } } : r))
    const after = paperLines(ctx({ rows: swapped }), 72, 20)
    before.forEach((line, i) => {
      if (!line.includes('#421')) expect(after[i]).toBe(line)
    })
    expect(after.find(line => line.includes('#421'))?.startsWith('░░')).toBe(true)
  })

  test('P4 repos by worst row, merged last, └─ only on the last child', async () => {
    const lines = paperLines(ctx(), 72, 20).map(line => line.trimEnd())
    const trees = lines.filter(line => /^.. [├└]─/.test(line))
    expect(trees.filter(line => line.slice(3, 5) === '└─').map(line => line.slice(6, 10))).toEqual(['#185', '#409'])
    expect(trees.at(-1)).toContain('merged 3m ago')
  })

  test('C7 a long failing check keeps at least 8 cells, titles end in a single …', async () => {
    const rows = [row(MONO, 7, 'A very long title that will certainly need truncating at sixty columns', { ci: { kind: 'red', failing: 'build-and-test-everything' } })]
    for (const width of [60, 72, 85]) {
      const line = paperLines(ctx({ rows, width }), width, 20).find(l => l.includes('#7')) ?? ''
      expect(line).toMatch(/✗ build-an\S*…/)
      expect(line.split('…').length).toBe(3)
    }
  })

  test('P5 running bar at 66 and wider, numerals only below, numerals only above 8 checks', async () => {
    const running = (done: number, total: number) => [row(MONO, 9, 'Running', { ci: { kind: 'running', done, total } })]
    expect(paperLines(ctx({ rows: running(4, 7), width: 66 }), 66, 20).join('\n')).toContain('▓▓▓▓░░░ 4/7')
    expect(paperLines(ctx({ rows: running(4, 7), width: 65 }), 65, 20).join('\n')).not.toContain('▓')
    expect(paperLines(ctx({ rows: running(4, 9), width: 85 }), 85, 20).join('\n')).not.toContain('▓')
    expect(paperLines(ctx({ rows: running(4, 9), width: 85 }), 85, 20).join('\n')).toContain('4/9')
  })

  test('P6 30 PRs in 20 rows: every problem visible, calm rows collapsed per repo', async () => {
    const many: WaveRow[] = []
    for (let i = 0; i < 30; i++) {
      const repo = ['acme/api', 'acme/web', 'acme/docs'][i % 3] ?? 'acme/api'
      const problem = i % 7 === 0
      many.push(row(repo, 100 + i, `Change number ${i}`, problem ? { ci: { kind: 'red', failing: 'lint' } } : {}))
    }
    for (const width of [60, 72, 85]) {
      const lines = paperLines(ctx({ rows: many, width }), width, 20)
      expect(lines.length).toBe(20)
      for (const problem of many.filter(r => r.ci.kind === 'red')) {
        expect(lines.some(line => line.startsWith('██') && line.includes(`#${problem.number} `))).toBe(true)
      }
      expect(lines.some(line => /└─ \+\d+ green/.test(line))).toBe(true)
    }
  })

  test('zero colour, no motion: meta is not animated', async () => {
    expect(style.meta.id).toBe('d4')
    expect(style.meta.animated).toBeUndefined()
  })
})

// Engine round trip: the real validator must accept the Raster or the pane would close.
function engineBeneath(on: On) {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
}

function fakeGh(on: On) {
  const url = 'https://github.com/acme/app/pull/1'
  on('process.run', async ($, e) => {
    const stdout =
      e.argv[1] === 'search'
        ? JSON.stringify([{ number: 1, repository: { nameWithOwner: 'acme/app' }, title: 'One', url }])
        : JSON.stringify({
            number: 1, title: 'One', url, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
            statusCheckRollup: [{ __typename: 'CheckRun', name: 'rspec', status: 'COMPLETED', conclusion: 'FAILURE' }],
            body: '', headRefName: 'h', baseRefName: 'main',
          })
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

async function startD4($: Engine, on: On) {
  const clock = mock.clock(on, { now: 1_000 })
  on('store.get', ($, e) => ({ value: e.key === 'style' ? 'd4' : undefined }))
  on('store.set', () => ({ value: undefined }))
  engineBeneath(on)
  fakeGh(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.settle()
}

function mountProps(bodyColumns: number, bodyRows: number) {
  return { title: 'Wave', isFocused: false, bodyColumns, placement: 'dock' as const, scroll: { offset: 0, bodyRows }, view: {} }
}

test('the engine draws d4 as one Raster sized to the body', async ($, on) => {
  await startD4($, on)
  for (const [cols, rows] of [[60, 20], [85, 60], [85, 256], [512, 256]] as const) {
    const ui = await $.ui.mount({ plugin: 'wave-watcher', surface: 'terminal', component: 'Pane', requestId: 'wave', props: mountProps(cols, rows) })
    const found = await ui.find({ type: 'Raster', key: RASTER_KEY })
    expect(found?.props.columns).toBe(cols)
    expect(found?.props.rows).toBe(rows)
    const text = rasterText({ props: found?.props as RasterOut['props'] }).join('\n')
    expect(text).toContain('acme/app')
    expect(text).toMatch(/██ └─ #1 {2}One/)
    await ui.unmount()
  }
})

test('P7 off the terminal d4 falls back to Text with no colour props', async ($, on) => {
  await startD4($, on)
  const ui = await $.ui.mount({ plugin: 'wave-watcher', surface: 'desktop', component: 'Pane', requestId: 'wave', props: mountProps(72, 20) })
  expect(await ui.find({ type: 'Raster' })).toBeUndefined()
  const texts = await ui.findAll({ type: 'Text' })
  expect(texts.some(t => t.text.includes('acme/app'))).toBe(true)
  for (const t of texts) {
    for (const prop of ['color', 'backgroundColor', 'dimColor', 'bold']) expect(t.props[prop]).toBeUndefined()
  }
  await ui.unmount()
})

