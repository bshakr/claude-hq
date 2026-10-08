import { describe, expect, test } from 'claude-code/testing'
import type { ElementTable, RenderElement } from 'claude-code'

import type { WaveRow } from '../types'
import { sortRows } from '../hooks/logic'
import { skylineStatus } from '../hooks/styles/d3'
import { TOKENS, groupByRepo, isGroup, paperSkylineLines, style, textOfPart } from '../hooks/styles/d5'
import type { Line, Seg } from '../hooks/styles/d5'
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
const REPOS = [MONO, ADMIN, 'ritualpass/api', 'ritualpass/client-web']
const THIRTY = sortRows(Array.from({ length: 30 }, (_, i) => {
  const over: Partial<WaveRow> =
    i === 0 ? { ci: { kind: 'red', failing: 'build-and-test' } }
    : i === 1 ? { merge: 'needs rebase' }
    : i === 2 ? { merge: 'conflicting' }
    : i === 3 ? { ci: { kind: 'running', done: 12, total: 14 } }
    : i === 4 ? { ci: { kind: 'running', done: 2, total: 9 } }
    : i === 5 ? { status: 'merged', mergedAt: NOW - 60_000 }
    : i % 7 === 0 ? { gallery: 'linked' } : {}
  return pr(REPOS[i % 4]!, 100 + i * 37, `Change number ${i + 1}: a fairly long title to force truncation`, over)
}))

type Fx = Pick<PaneCtx, 'rows' | 'polledAt' | 'now' | 'error'>
const FIX = {
  a: { rows: WAVE, polledAt: T0, now: NOW, error: null },
  b: { rows: QUIET, polledAt: T0, now: T0 + 40_000, error: null },
  c: { rows: [], polledAt: T0, now: T0 + 10_000, error: null },
  d: { rows: QUIET, polledAt: T0, now: T0 + 180_000, error: 'gh: error connecting to api.github.com' },
  f: { rows: [], polledAt: null, now: T0, error: null },
  thirty: { rows: THIRTY, polledAt: T0, now: NOW, error: null },
} satisfies Record<string, Fx>
const STATES = Object.values(FIX)
const WIDTHS = [85, 72, 60, 52, 48]

const make = (type: string) => (props: Record<string, unknown>) => {
  const { children, ...rest } = props
  return { type, props: rest, children: [children].flat(Infinity).filter(c => c != null) }
}
const fakeEl = { Box: make('Box'), Text: make('Text'), Link: make('Link') } as unknown as ElementTable

function ctx(fx: Fx, over: Partial<PaneCtx> = {}): PaneCtx {
  return {
    ...fx, isWaking: true, width: 72, bodyRows: 30, placement: 'dock', isFocused: false, tick: 0,
    el: fakeEl, surface: 'terminal', ...over,
  }
}

const text = (line: Line) => line.map(textOfPart).join('')
const textOf = (lines: Line[]) => lines.map(text)
/** Every styled run, a Link group's runs carrying the group's href. */
const flat = (line: Line): Seg[] => line.flatMap(p => (isGroup(p) ? p.segs.map(s => ({ ...s, href: p.href })) : [p]))

const SHEET = {
  a72: [
    '4 open                                          polled 20s ago · wake on',
    '',
    '  ████████',
    '  ████████   ████████',
    '  ████████   ████████   ▂▁▁▁▁▁▁▁',
    '  ████████   ████████   ████████   ▁▁▁▁▁▁▁▁',
    '  ────────────────────────────────────────────╌╌╌╌╌╌╌╌────────────────',
    '    #183       #418       #185       #421       #409',
    '',
    '   bshakr/monolense ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄',
    '██ ├─ #183  Ledger: reconcile partial refunds             ✗ rspec',
    '░░ └─ #185  ◇ Pipeline: retry classification on timeout   ↻ 4/7',
    '',
    '   ritualpass/admin-web ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄',
    '██ ├─ #418  Members table: sticky header on scroll        ↑ rebase',
    '   ├─ #421  Stat cards: one-decimal trend deltas          ✓ gallery',
    '   └─ #409  Sidebar: collapse state persists              merged 3m ago',
  ],
  b72: [
    '3 open                                          polled 40s ago · wake on',
    '', '', '', '',
    '  ▁▁▁▁▁▁▁▁   ▁▁▁▁▁▁▁▁   ▁▁▁▁▁▁▁▁',
    '  ────────────────────────────────────────────────────────────────────',
    '    #421       #186       #423',
    '',
    '   ritualpass/admin-web ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄',
    '   ├─ #421  Stat cards: one-decimal trend deltas          ✓ gallery',
    '   └─ #423  Schedule: empty state copy                    ✓ gallery',
    '',
    '   bshakr/monolense ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄',
    '   └─ #186  Docs: ADR for refund reconciliation           ✓ no visual',
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
    '    #421       #186       #423',
    '',
    '   ritualpass/admin-web ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄',
    '   ├─ #421  Stat cards: one-decimal trend deltas          ✓ gallery',
    '   └─ #423  Schedule: empty state copy                    ✓ gallery',
    '',
    '   bshakr/monolense ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄',
    '   └─ #186  Docs: ADR for refund reconciliation           ✓ no visual',
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
    '    #183       #418       #185       #421       #409',
    '',
    '   bshakr/monolense ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄',
    '██ ├─ #183  Ledger: reconcile partial refun…  ✗ rspec',
    '░░ └─ #185  ◇ Pipeline: retry classificatio…  ↻ 4/7',
    '',
    '   ritualpass/admin-web ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄',
    '██ ├─ #418  Members table: sticky header on…  ↑ rebase',
    '   ├─ #421  Stat cards: one-decimal trend d…  ✓ gallery',
    '   └─ #409  Sidebar: collapse state persists  merged 3m ago',
  ],
}

const GLYPHS = new Set([...'█░▁▂▃▄▅▆▇─╌┄├└✗↑↻✓◇·×…'])
const FOOTER = 'gh every 60s · 0 model tokens'

describe('D5 Skyline Paper renders the sheet cell for cell', () => {
  for (const [name, fx, width] of [
    ['a72', FIX.a, 72], ['b72', FIX.b, 72], ['c72', FIX.c, 72], ['d72', FIX.d, 72], ['f72', FIX.f, 72], ['a60', FIX.a, 60],
  ] as const) {
    test(name, () => {
      const lines = textOf(paperSkylineLines(ctx(fx, { width })))
      const want = SHEET[name]
      expect(lines.slice(0, want.length)).toEqual([...want])
      expect(lines.slice(want.length, -1).every(line => line === '')).toBe(true)
      expect(lines.at(-1)).toBe(FOOTER)
      expect(lines.length).toBe(30)
    })
  }

  test('a tree taller than the pane: the footer follows the content', () => {
    const lines = textOf(paperSkylineLines(ctx(FIX.a, { bodyRows: 8 })))
    expect(lines.slice(-2)).toEqual(['', FOOTER])
    expect(lines.length).toBe(SHEET.a72.length + 2)
  })
})

describe('D5 widths and glyphs', () => {
  test('every state at 85/72/60/52/48: no line wider than ctx.width, only width-1 listed glyphs', () => {
    for (const fx of STATES) {
      for (const width of WIDTHS) {
        for (const line of paperSkylineLines(ctx(fx, { width }))) {
          const s = text(line)
          expect([...s].length).toBeLessThanOrEqual(width)
          for (const ch of s) {
            const cp = ch.codePointAt(0)!
            if (cp >= 0x20 && cp < 0x7f) continue
            if (!GLYPHS.has(ch)) throw new Error(`glyph ${JSON.stringify(ch)} outside the vocabulary at ${width}`)
          }
          expect(s.includes('️')).toBe(false)
        }
      }
    }
  })

  test('every width from 48 to 85: fact column starts on one cell for every row', () => {
    for (let width = 48; width <= 85; width++) {
      const lines = textOf(paperSkylineLines(ctx(FIX.thirty, { width })))
      const rows = lines.filter(line => /^.. [├└]─ #/.test(line))
      expect(rows.length).toBe(30)
      for (const line of rows) {
        const cells = [...line]
        expect(cells.length).toBeLessThanOrEqual(width)
        expect(cells.slice(width - 16, width - 14).join('')).toBe('  ')
        expect(cells[width - 14]).not.toBe(' ')
      }
    }
  })

  test('below 48 columns only the count line (and error) draw', () => {
    for (const width of [20, 30, 47]) {
      const lines = textOf(paperSkylineLines(ctx(FIX.d, { width })))
      expect(lines.length).toBe(2)
      for (const s of lines) expect([...s].length).toBeLessThanOrEqual(width)
    }
    expect(textOf(paperSkylineLines(ctx(FIX.a, { width: 47 })))).toEqual(['4 open · polled 20s ago · wake on'])
  })

  test('30 PRs at 60 columns: bw 1, gap 0, labels only on problems, never overlapping', () => {
    const lines = paperSkylineLines(ctx(FIX.thirty, { width: 60 }))
    const t = textOf(lines)
    expect(t[5]!.slice(0, 2)).toBe('  ')
    // 30 one-cell bars from cell 2, the merged one (sorted last) drawing nothing.
    expect([...t[5]!].length).toBe(31)
    expect([...t[6]!].length).toBe(58)
    const labels = flat(lines[7]!).filter(s => s.t.startsWith('#'))
    expect(labels.length).toBeGreaterThan(0)
    const problems = new Set(THIRTY.filter(r => r.ci.kind === 'red' || r.merge !== 'mergeable').map(r => r.url))
    for (const label of labels) expect(problems.has(label.href!)).toBe(true)
    expect([...t[7]!].length).toBeLessThanOrEqual(60)
    expect(t.find(line => /^.. [├└]─ #/.test(line))).toMatch(/^██ ├─ #\d+ /)
  })

  test('a failing check keeps at least 8 cells, then …', () => {
    const t = textOf(paperSkylineLines(ctx(FIX.thirty, { width: 60 })))
    expect(t.some(line => line.endsWith('✗ build-and-t…'))).toBe(true)
  })
})

describe('D5 organisation (D4 rules)', () => {
  test('(a): monolense first (worst row red), admin-web second; merged last in its repo', () => {
    expect(groupByRepo(WAVE).map(g => [g.repo, g.rows.map(r => r.number)])).toEqual([
      [MONO, [183, 185]],
      [ADMIN, [418, 421, 409]],
    ])
  })

  test('(b): ties on worst row go to the repo with more rows', () => {
    expect(groupByRepo(QUIET).map(g => g.repo)).toEqual([ADMIN, MONO])
  })

  test('a merged row never sits above an open row in its group', () => {
    for (const group of groupByRepo(THIRTY)) {
      const firstMerged = group.rows.findIndex(r => r.status === 'merged')
      if (firstMerged >= 0) expect(group.rows.slice(firstMerged).every(r => r.status === 'merged')).toBe(true)
    }
  })

  test('gutter: ██ on needs-you rows, ░░ on running rows, blank otherwise', () => {
    const t = textOf(paperSkylineLines(ctx(FIX.a)))
    expect(t.filter(l => l.startsWith('██')).length).toBe(2)
    expect(t.filter(l => l.startsWith('░░')).length).toBe(1)
    expect(textOf(paperSkylineLines(ctx(FIX.b))).some(l => /^[█░]/.test(l))).toBe(false)
  })
})

describe('D5 links', () => {
  const hrefsOf = (node: unknown, out: string[] = []): string[] => {
    if (node && typeof node === 'object') {
      const n = node as { type?: string; props?: { href?: string }; children?: unknown[] }
      if (n.type === 'Link') out.push(n.props!.href!)
      for (const child of n.children ?? []) hrefsOf(child, out)
    }
    return out
  }

  test('every tree row is one Link group whose href is the row url, holding #n and the title', () => {
    for (const fx of [FIX.a, FIX.b, FIX.d, FIX.thirty]) {
      for (const width of WIDTHS) {
        const lines = paperSkylineLines(ctx(fx, { width }))
        const groups = lines.flatMap(line => line.filter(isGroup))
        expect(groups.map(g => g.href).sort()).toEqual(fx.rows.map(r => r.url).sort())
        for (const g of groups) {
          const row = fx.rows.find(r => r.url === g.href)!
          expect(g.segs[0]!.t).toBe(`#${row.number}`)
        }
      }
    }
  })

  test('every bar run and every bar label links to its own PR', () => {
    const lines = paperSkylineLines(ctx(FIX.a))
    const chart = lines.slice(2, 8).flatMap(flat).filter(s => /[▁-█#]/.test(s.t))
    const urls = new Set(WAVE.map(r => r.url))
    for (const seg of chart) {
      expect(seg.href).toBeDefined()
      expect(urls.has(seg.href!)).toBe(true)
    }
    const labelOf = (s: Seg) => WAVE.find(r => r.url === s.href)!.number
    for (const label of flat(lines[7]!).filter(s => s.t.trim() !== '')) expect(label.t).toBe(`#${labelOf(label)}`)
  })

  test('adjacent same-colour bars at gap 0 stay separate links', () => {
    const rows = Array.from({ length: 30 }, (_, i) => pr(MONO, 500 + i, 't', { merge: 'conflicting' }))
    const top = flat(paperSkylineLines(ctx({ ...FIX.a, rows }, { width: 60 }))[2]!).filter(s => s.href)
    expect(top.length).toBe(30)
    expect(top.map(s => s.href)).toEqual(rows.map(r => r.url))
  })

  test('the drawn tree carries the same hrefs: every row url, and nothing else', () => {
    for (const fx of [FIX.a, FIX.thirty]) {
      const hrefs = hrefsOf(style.render(ctx(fx)))
      expect(new Set(hrefs)).toEqual(new Set(fx.rows.map(r => r.url)))
    }
    expect(hrefsOf(style.render(ctx(FIX.c)))).toEqual([])
  })

  test('a Link carries only href: no colour, no underline of its own', () => {
    const tree = JSON.stringify(style.render(ctx(FIX.a)))
    for (const m of tree.matchAll(/"type":"Link","props":(\{[^}]*\})/g)) expect(Object.keys(JSON.parse(m[1]!))).toEqual(['href'])
    expect(tree.includes('underline')).toBe(false)
  })
})

describe('D5 colour', () => {
  test('colour inventory in (a): bars, gutters and facts per problem/running, rule decoration, nothing else', () => {
    const lines = paperSkylineLines(ctx(FIX.a))
    const coloured = lines.flatMap((line, y) => flat(line).filter(s => s.color && s.color !== 'rule').map(s => `${y}:${s.color}:${s.t}`))
    expect(coloured).toEqual([
      '2:fail:████████',
      '3:fail:████████', '3:warn:████████',
      '4:fail:████████', '4:warn:████████', '4:run:▂▁▁▁▁▁▁▁',
      '5:fail:████████', '5:warn:████████', '5:run:████████',
      '10:fail:██', '10:fail:✗ rspec',
      '11:run:░░', '11:run:↻ 4/7',
      '14:warn:██', '14:warn:↑ rebase',
    ])
    const rule = lines.flatMap(line => flat(line).filter(s => s.color === 'rule').map(s => s.t))
    for (const t of rule) expect(/^[─╌┄├└]+$/.test(t)).toBe(true)
  })

  test('quiet (b): zero coloured cells besides rule decoration', () => {
    const segs = paperSkylineLines(ctx(FIX.b)).flatMap(flat)
    expect(segs.filter(s => s.color && s.color !== 'rule')).toEqual([])
    expect(segs.filter(s => s.bold)).toEqual([])
  })

  test('no dim with colour, no background, colours only from TOKENS, in every state and width', () => {
    for (const fx of STATES) {
      for (const width of WIDTHS) {
        const c = ctx(fx, { width })
        expect(paperSkylineLines(c).flatMap(flat).some(s => s.color && s.dim)).toBe(false)
        const tree = JSON.stringify(style.render(c))
        expect(tree.includes('backgroundColor')).toBe(false)
        for (const m of tree.matchAll(/"color":"([^"]+)"/g)) expect(Object.values(TOKENS)).toContain(m[1])
        expect(tree.includes('"dimColor":true,"color"') || /"color":"[^"]+","dimColor"/.test(tree)).toBe(false)
      }
    }
  })

  test('bold only on problem refs; none when stale', () => {
    const bold = (fx: Fx) => paperSkylineLines(ctx(fx)).flatMap(flat).filter(s => s.bold).map(s => s.t)
    expect(bold(FIX.a)).toEqual(['#183', '#418'])
    expect(bold({ ...FIX.a, error: 'gh: boom' })).toEqual([])
  })

  test('(d): error line in warn, refs dim, problem colours kept', () => {
    const lines = paperSkylineLines(ctx({ ...FIX.a, error: 'gh: boom' }))
    expect(lines[1]).toEqual([{ t: '× gh: boom', color: 'warn' }])
    const refs = lines.flatMap(line => line.filter(isGroup)).map(g => g.segs[0]!)
    expect(refs.every(r => r.dim === true && !r.bold)).toBe(true)
    const facts = lines.flatMap(flat).filter(s => s.color === 'fail' || s.color === 'warn' || s.color === 'run').map(s => s.t)
    expect(facts).toContain('✗ rspec')
    expect(facts).toContain('↑ rebase')
  })

  test('wake off is dim and never coloured', () => {
    expect(paperSkylineLines(ctx(FIX.b, { isWaking: false }))[0]!.at(-1)).toEqual({ t: 'wake off', dim: true })
  })
})

describe('D5 motion', () => {
  test('(a): exactly 2 cells change per tick, both in the running bar top row', () => {
    for (let tick = 0; tick < 10; tick++) {
      const a = textOf(paperSkylineLines(ctx(FIX.a, { tick })))
      const b = textOf(paperSkylineLines(ctx(FIX.a, { tick: tick + 1 })))
      const diff: string[] = []
      a.forEach((line, y) => {
        const ca = [...line]
        const cb = [...(b[y] ?? '')]
        for (let x = 0; x < Math.max(ca.length, cb.length); x++) if (ca[x] !== cb[x]) diff.push(`${y}:${x}`)
      })
      const p = tick % 8
      const q = (tick + 1) % 8
      expect(diff).toEqual([`4:${24 + Math.min(p, q)}`, `4:${24 + Math.max(p, q)}`])
    }
  })

  test('idle trees are byte-identical across ticks (no running PR)', () => {
    const idle = { ...FIX.a, rows: WAVE.filter(r => r.ci.kind !== 'running') }
    for (const fx of [FIX.b, FIX.c, FIX.d, FIX.f, idle]) {
      for (const width of WIDTHS) {
        const a = JSON.stringify(style.render(ctx(fx, { width, tick: 7 })))
        const b = JSON.stringify(style.render(ctx(fx, { width, tick: 8 })))
        expect(b).toBe(a)
      }
    }
  })

  test('meta: id d5, Skyline Paper, animated', () => {
    expect(style.meta).toMatchObject({ id: 'd5', name: 'Skyline Paper', animated: true })
  })
})

test('status line is D3\'s skylineStatus', () => {
  for (const fx of STATES) {
    expect(style.status!(fx)).toBe(skylineStatus(fx.rows, fx.error, fx.polledAt, fx.now))
  }
  expect(style.status!(FIX.a)).toBe('wave: 1 red · 1 rebase · 1 running · 1 green')
})

test('the engine validates every state (terminal and desktop), Links included', async ($, on) => {
  let current: Fx = FIX.a
  let width = 72
  let tick = 0
  on('ui.render', { component: 'Pane', requestId: 'd5-probe' }, ($, e) =>
    style.render({
      ...current, isWaking: true, width: e.props.bodyColumns, bodyRows: e.props.scroll.bodyRows,
      placement: e.props.placement, isFocused: e.props.isFocused, tick, el: $.ui.resolve(e), surface: e.surface,
    }),
  )
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const [fx, w] of [...STATES.map(fx => [fx, 72] as const), [FIX.thirty, 60], [FIX.thirty, 85]] as const) {
      current = fx
      width = w
      const ui = await $.ui.mount({
        plugin: 'wave-watcher', surface, component: 'Pane', requestId: 'd5-probe',
        props: { title: 'Wave', isFocused: false, bodyColumns: width, placement: 'dock', scroll: { offset: 0, bodyRows: 24 }, view: {} },
      })
      const drawn: RenderElement = await ui.drawn()
      expect(drawn).toMatchObject({ type: 'Box' })
      const json = JSON.stringify(drawn)
      expect(json.includes('backgroundColor')).toBe(false)
      for (const row of fx.rows) expect(json.includes(JSON.stringify(row.url))).toBe(true)
      tick += 1
      await ui.redraw()
      const again = JSON.stringify(await ui.drawn())
      // At 30 PRs bars are 1 cell wide, so the bump has nowhere to travel.
      const animates = fx === FIX.a
      if (animates) expect(again).not.toBe(json)
      else expect(again).toBe(json)
      await ui.unmount()
    }
  }
})
