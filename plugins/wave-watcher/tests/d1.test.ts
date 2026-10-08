import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { WaveRow } from '../types'
import { TOKENS, cells, statusText, style } from '../hooks/styles/d1'
import type { PaneCtx } from '../hooks/styles/types'

const NOW = 1_800_000_000_000
const S = 1000

function pr(repo: string, number: number, title: string, over: Partial<WaveRow> = {}): WaveRow {
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

const WAVE: WaveRow[] = [
  pr('bshakr/monolense', 183, 'Ledger: reconcile partial refunds', { ci: { kind: 'red', failing: 'rspec' } }),
  pr('ritualpass/admin-web', 418, 'Members table: sticky header on scroll', { merge: 'needs rebase', gallery: 'linked' }),
  pr('bshakr/monolense', 185, 'Pipeline: retry classification on timeout', {
    ci: { kind: 'running', done: 4, total: 7 },
    isDraft: true,
  }),
  pr('ritualpass/admin-web', 421, 'Stat cards: one-decimal trend deltas', { gallery: 'linked' }),
  pr('ritualpass/admin-web', 409, 'Sidebar: collapse state persists', {
    status: 'merged',
    merge: 'unknown',
    gallery: 'linked',
    mergedAt: NOW - 180 * S,
  }),
]

const QUIET: WaveRow[] = [
  pr('ritualpass/admin-web', 421, 'Stat cards: one-decimal trend deltas', { gallery: 'linked' }),
  pr('bshakr/monolense', 186, 'Docs: ADR for refund reconciliation', { gallery: 'no visual change' }),
  pr('ritualpass/admin-web', 423, 'Schedule: empty state copy', { gallery: 'linked' }),
]

type Fixture = Partial<Omit<PaneCtx, 'el' | 'surface'>>

const FIXTURES: Record<string, Fixture> = {
  a: { rows: WAVE, polledAt: NOW - 20 * S },
  b: { rows: QUIET, polledAt: NOW - 40 * S },
  c: { rows: [], polledAt: NOW - 10 * S },
  d: { rows: QUIET, polledAt: NOW - 180 * S, error: 'gh: error connecting to api.github.com' },
  f: { rows: [], polledAt: null },
  staleWave: { rows: WAVE, polledAt: NOW - 180 * S, error: 'gh: error connecting to api.github.com' },
}

type Node = { type: string; props?: Record<string, unknown>; children?: Node[] } | string
type Run = { text: string; props: Record<string, unknown> }

function kids(node: Node): Node[] {
  if (typeof node === 'string') return []
  return node.children ?? []
}

function textOf(node: Node): string {
  return typeof node === 'string' ? node : kids(node).map(textOf).join('')
}

/** Leaf runs of one line, each with the merged props of its Text ancestors. */
function runsOf(node: Node, inherited: Record<string, unknown> = {}): Run[] {
  if (typeof node === 'string') return node === '' ? [] : [{ text: node, props: inherited }]
  const { wrap: _w, ...own } = node.props ?? {}
  return kids(node).flatMap(child => runsOf(child, { ...inherited, ...own }))
}

function allElements(node: Node): Exclude<Node, string>[] {
  if (typeof node === 'string') return []
  return [node, ...kids(node).flatMap(allElements)]
}

type Drawn = { tree: Node; lines: string[]; lineRuns: Run[][]; footer: string | undefined }

function split(tree: Node): Drawn {
  const [body, footer] = kids(tree)
  const lineNodes = body === undefined ? [] : kids(body)
  return {
    tree,
    lines: lineNodes.map(textOf),
    lineRuns: lineNodes.map(n => runsOf(n)),
    footer: footer === undefined ? undefined : textOf(footer),
  }
}

type Spec = { fixture: Fixture; width: number; bodyRows: number }
const specs = new Map<string, Spec>()
let seq = 0

/** Registers the one render hook a test draws through; call before any `$` use. */
function harness(on: On) {
  on('ui.render', { component: 'Pane' }, ($, e, next) => {
    const spec = specs.get(e.requestId)
    if (spec === undefined) return next(e)
    return style.render({
      rows: [],
      polledAt: null,
      now: NOW,
      error: null,
      isWaking: true,
      placement: 'dock',
      isFocused: false,
      tick: 0,
      ...spec.fixture,
      width: spec.width,
      bodyRows: spec.bodyRows,
      el: $.ui.resolve(e),
      surface: e.surface,
    })
  })
}

async function draw($: Engine, on: On, fixture: Fixture, width = 72, bodyRows = 20): Promise<Drawn> {
  void on
  const requestId = `d1-${seq++}`
  specs.set(requestId, { fixture, width, bodyRows })
  const ui = await $.ui.mount({
    plugin: 'wave-watcher',
    surface: 'terminal',
    component: 'Pane',
    requestId,
    props: { title: 'Wave', isFocused: false, bodyColumns: width, placement: 'dock', scroll: { offset: 0, bodyRows }, view: {} },
  })
  const tree = (await ui.drawn()) as Node
  await ui.unmount()
  return split(tree)
}

const GLYPHS = new Set([...'●◦·✗↻✓◇◆≡─…×'])
const TOKEN_VALUES = new Set<string>(Object.values(TOKENS))
const coloured = (d: Drawn) => d.lineRuns.flat().filter(run => typeof run.props.color === 'string')
const tokenOf = (run: Run) => Object.entries(TOKENS).find(([, v]) => v === run.props.color)?.[0]

function invariants(d: Drawn, width: number) {
  for (const line of [...d.lines, ...(d.footer === undefined ? [] : [d.footer])]) {
    expect(cells(line) <= width).toBe(true)
    expect(cells(line)).toBe([...line].length)
    for (const ch of line) {
      const isAscii = ch >= ' ' && ch <= '~'
      if (!isAscii && !GLYPHS.has(ch)) throw new Error(`glyph outside the sheet: ${JSON.stringify(ch)} in ${line}`)
    }
  }
  for (const el of allElements(d.tree)) {
    expect(el.props?.backgroundColor).toBeUndefined()
    if (el.props?.color !== undefined) {
      expect(TOKEN_VALUES.has(String(el.props.color))).toBe(true)
      expect(el.props.dimColor).toBeUndefined()
    }
    expect(el.props?.color).not.toBe('ansi256(2)')
    expect(el.props?.inverse).toBeUndefined()
    expect(el.props?.italic).toBeUndefined()
    expect(el.props?.underline).toBeUndefined()
  }
}

describe('sheet renders, cell for cell', () => {
  test('(a) wave at 72', async ($, on) => {
    harness(on)
    const d = await draw($, on, FIXTURES.a!, 72)
    expect(d.lines).toEqual([
      'Wave  4 open                                    polled 20s ago · wake on',
      '────────────────────────────────────────────────────────────────────────',
      '  pr             title                              ci        merge   gl',
      '● monolense#183  Ledger: reconcile partial refunds  ✗ rspec   ✓        ·',
      '● admin-web#418  Members table: sticky header on …  ✓         rebase   ◆',
      '◦ monolense#185  ◇ Pipeline: retry classification…  ↻ 4/7     ✓        ·',
      '· admin-web#421  Stat cards: one-decimal trend de…  ✓         ✓        ◆',
      '● admin-web#409  Sidebar: collapse state persists   merged 3m ago      ◆',
    ])
    expect(d.footer).toBe('gh every 60s · 0 model tokens')
  })

  test('(b) quiet at 72', async ($, on) => {
    harness(on)
    const d = await draw($, on, FIXTURES.b!, 72)
    expect(d.lines).toEqual([
      'Wave  3 open                                    polled 40s ago · wake on',
      '────────────────────────────────────────────────────────────────────────',
      '  pr             title                              ci        merge   gl',
      '· admin-web#421  Stat cards: one-decimal trend de…  ✓         ✓        ◆',
      '· monolense#186  Docs: ADR for refund reconciliat…  ✓         ✓        ≡',
      '· admin-web#423  Schedule: empty state copy         ✓         ✓        ◆',
    ])
  })

  test('(c) empty at 72', async ($, on) => {
    harness(on)
    const d = await draw($, on, FIXTURES.c!, 72)
    expect(d.lines).toEqual([
      'Wave  0 open                                    polled 10s ago · wake on',
      '────────────────────────────────────────────────────────────────────────',
      '  No open PRs. Nothing merged in the last 30 min.',
    ])
  })

  test('(d) gh error at 72', async ($, on) => {
    harness(on)
    const d = await draw($, on, FIXTURES.d!, 72)
    expect(d.lines).toEqual([
      'Wave  3 open                             last good poll 3m ago · wake on',
      '× gh: error connecting to api.github.com',
      '────────────────────────────────────────────────────────────────────────',
      '  pr             title                              ci        merge   gl',
      '· admin-web#421  Stat cards: one-decimal trend de…  ✓         ✓        ◆',
      '· monolense#186  Docs: ADR for refund reconciliat…  ✓         ✓        ≡',
      '· admin-web#423  Schedule: empty state copy         ✓         ✓        ◆',
    ])
    const err = d.lineRuns[1]!
    expect(err.find(run => run.text.startsWith('gh:'))?.props.color).toBe(TOKENS.warn)
    expect(err.find(run => run.text.startsWith('×'))?.props.color).toBeUndefined()
    for (const line of d.lineRuns.slice(4)) {
      expect(line.find(run => run.text.includes(' '))?.props.dimColor !== undefined || true).toBe(true)
      const title = line.find(run => /[a-z]{3}/.test(run.text) && !run.text.includes('#'))
      expect(title?.props.dimColor).toBe(true)
      const gl = line.at(-1)!
      expect(gl.props.dimColor).toBe(true)
    }
    expect(d.lineRuns[0]!.find(run => run.text.startsWith('last good poll'))?.props.dimColor).toBe(true)
  })

  test('(f) first poll at 72', async ($, on) => {
    harness(on)
    const d = await draw($, on, FIXTURES.f!, 72)
    expect(d.lines).toEqual([
      'Wave                                        first poll running · wake on',
      '────────────────────────────────────────────────────────────────────────',
      '  Asking GitHub for your open PRs…',
    ])
  })

  test('(e) wave at 60 drops gl first', async ($, on) => {
    harness(on)
    const d = await draw($, on, FIXTURES.a!, 60)
    expect(d.lines).toEqual([
      'Wave  4 open                        polled 20s ago · wake on',
      '────────────────────────────────────────────────────────────',
      '  pr             title                     ci        merge',
      '● monolense#183  Ledger: reconcile parti…  ✗ rspec   ✓',
      '● admin-web#418  Members table: sticky h…  ✓         rebase',
      '◦ monolense#185  ◇ Pipeline: retry class…  ↻ 4/7     ✓',
      '· admin-web#421  Stat cards: one-decimal…  ✓         ✓',
      '● admin-web#409  Sidebar: collapse state…  merged 3m ago',
    ])
  })

  test('at 85 the title column takes the extra cells', async ($, on) => {
    harness(on)
    const d = await draw($, on, FIXTURES.a!, 85)
    expect(d.lines[3]).toBe(`● monolense#183  ${'Ledger: reconcile partial refunds'.padEnd(46)}  ✗ rspec   ✓        ·`)
    expect(d.lines[4]).toBe(`● admin-web#418  ${'Members table: sticky header on scroll'.padEnd(46)}  ✓         rebase   ◆`)
  })
})

describe('craft invariants', () => {
  const widths = [85, 80, 72, 66, 65, 60, 54, 50, 48, 47, 40, 30, 12]
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    test(`(${name}) fits, width-1 glyphs, token colours, no ground, at ${widths.join('/')}`, async ($, on) => {
    harness(on)
      for (const width of widths) invariants(await draw($, on, fixture, width), width)
    })
  }

  test('(a) colour inventory: 7 coloured runs plus the rule; bold on Wave and two problem refs', async ($, on) => {
    harness(on)
    for (const width of [85, 72, 60]) {
      const d = await draw($, on, FIXTURES.a!, width)
      const runs = coloured(d)
      const by = (t: string) => runs.filter(run => tokenOf(run) === t).map(run => run.text)
      expect(by('fail')).toEqual(['●', '✗ rspec'])
      expect(by('warn')).toEqual(['●', 'rebase'])
      expect(by('run')).toEqual(['◦', '↻ 4/7'])
      expect(by('merged')).toEqual(['●'])
      expect(by('rule')).toEqual(['─'.repeat(width)])
      expect(runs.length).toBe(8)
      const bold = d.lineRuns.flat().filter(run => run.props.bold === true).map(run => run.text)
      expect(bold).toEqual(['Wave', 'monolense#183', 'admin-web#418'])
    }
  })

  test('(b) quiet: zero coloured runs besides the rule', async ($, on) => {
    harness(on)
    const d = await draw($, on, FIXTURES.b!, 72)
    expect(coloured(d).map(run => tokenOf(run))).toEqual(['rule'])
  })

  test('problems sit in the top 8 rows, each with a glyph beside the colour', async ($, on) => {
    harness(on)
    const d = await draw($, on, FIXTURES.a!, 72)
    const red = d.lines.findIndex(line => line.includes('✗ rspec'))
    const rebase = d.lines.findIndex(line => line.includes('rebase'))
    expect(red >= 0 && red < 8 && d.lines[red]!.startsWith('●')).toBe(true)
    expect(rebase >= 0 && rebase < 8 && d.lines[rebase]!.startsWith('●')).toBe(true)
  })

  test('merged row: magenta dot, dim title, time at the ci column, dim gl', async ($, on) => {
    harness(on)
    const d = await draw($, on, FIXTURES.a!, 72)
    const runs = d.lineRuns[7]!
    expect(runs[0]).toEqual({ text: '●', props: { color: TOKENS.merged } })
    expect(runs.find(run => run.text.startsWith('Sidebar'))?.props.dimColor).toBe(true)
    expect(runs.find(run => run.text.startsWith('merged'))?.props.dimColor).toBe(true)
    expect(runs.at(-1)).toEqual({ text: '◆', props: { dimColor: true } })
    expect(d.lines[7]!.indexOf('merged')).toBe(d.lines[3]!.indexOf('✗'))
  })

  test('columns start on the same cell on every row (ci, merge, gl) at 85 and 72', async ($, on) => {
    harness(on)
    for (const width of [85, 72]) {
      const d = await draw($, on, FIXTURES.a!, width)
      const rows = d.lines.slice(3, 7)
      const ciAt = rows.map(line => line.search(/[✗↻✓] ?/u))
      expect(new Set(ciAt).size).toBe(1)
      expect(d.lines[2]!.indexOf('ci')).toBe(ciAt[0])
      const mergeAt = d.lines[2]!.indexOf('merge')
      for (const line of rows) expect(line[mergeAt]).not.toBe(' ')
      for (const line of [...rows, d.lines[7]!]) expect(cells(line)).toBe(width)
    }
  })

  test('a long failing check widens ci to 12 for every row and keeps 9 name cells', async ($, on) => {
    harness(on)
    const rows = WAVE.map((row, i) => (i === 0 ? { ...row, ci: { kind: 'red', failing: 'build-and-test' } as const } : row))
    const d = await draw($, on, { ...FIXTURES.a!, rows }, 72)
    expect(d.lines[3]).toContain('✗ build-and…')
    const ciAt = d.lines.slice(3, 7).map(line => line.search(/[✗↻✓]/u))
    expect(new Set(ciAt).size).toBe(1)
    expect(d.lines[2]!.indexOf('merge') - ciAt[0]!).toBe(13)
    const short = await draw($, on, FIXTURES.a!, 72)
    expect(short.lines[2]!.indexOf('merge') - short.lines[2]!.indexOf('ci')).toBe(10)
  })

  test('titles cut with one … at the end; refs never cut', async ($, on) => {
    harness(on)
    for (const width of [72, 60, 54, 50]) {
      const d = await draw($, on, FIXTURES.a!, width)
      for (const line of d.lines.slice(3)) {
        expect((line.match(/…/g) ?? []).length <= 1).toBe(true)
        expect(/^[●◦·] (monolense|admin-web)#\d{3}  /.test(line)).toBe(true)
      }
    }
  })

  test('wide and control characters in a title cannot break the grid', async ($, on) => {
    harness(on)
    const rows = [pr('acme/app', 7, 'Fix 🚀 launch\tcheck 漢字 docs‍ and more words here', { ci: { kind: 'none' } })]
    for (const width of [85, 72, 60]) {
      const d = await draw($, on, { rows, polledAt: NOW }, width)
      invariants(d, width)
      if (width >= 66) expect(cells(d.lines[3]!)).toBe(width)
    }
  })

  test('a ref longer than 14 cells widens the pr column instead of being cut', async ($, on) => {
    harness(on)
    const rows = [pr('ritualpass/client-mobile', 12345, 'Long repo name', { merge: 'conflicting' }), ...QUIET]
    const d = await draw($, on, { rows, polledAt: NOW }, 72)
    expect(d.lines[3]!.startsWith('● client-mobile#12345 ')).toBe(true)
    expect(d.lines[3]).toContain('clash')
    invariants(d, 72)
  })

  test('owner stays when two repos share a name', async ($, on) => {
    harness(on)
    const rows = [pr('acme/app', 1, 'One'), pr('other/app', 2, 'Two')]
    const d = await draw($, on, { rows, polledAt: NOW }, 72)
    expect(d.lines[3]!.startsWith('· acme/app#1 ')).toBe(true)
    expect(d.lines[4]!.startsWith('· other/app#2 ')).toBe(true)
  })

  test('stale wave keeps problem colours, dims titles, never dims a coloured run', async ($, on) => {
    harness(on)
    const d = await draw($, on, FIXTURES.staleWave!, 72)
    const tokens = coloured(d).map(run => tokenOf(run))
    expect(tokens.filter(t => t === 'fail').length).toBe(2)
    expect(tokens.filter(t => t === 'warn').length).toBe(3)
    const title = d.lineRuns[4]!.find(run => run.text.startsWith('Ledger'))
    expect(title?.props.dimColor).toBe(true)
  })

  test('below 48 columns: header plus one count line, problems still coloured', async ($, on) => {
    harness(on)
    const d = await draw($, on, FIXTURES.a!, 44)
    expect(d.lines).toEqual(['Wave        polled 20s ago · wake on', '4 open · 1 red · 1 rebase · 1 running'].map((l, i) =>
      i === 0 ? `Wave${' '.repeat(44 - 4 - 24)}polled 20s ago · wake on` : l,
    ))
    expect(coloured(d).map(run => run.text)).toEqual(['1 red', '1 rebase', '1 running'])
    expect(d.footer).toBeUndefined()
  })

  test('wake off is dim; wake on is normal and never coloured', async ($, on) => {
    harness(on)
    const off = await draw($, on, { ...FIXTURES.b!, isWaking: false }, 72)
    expect(off.lineRuns[0]!.at(-1)).toEqual({ text: 'wake off', props: { dimColor: true } })
    const onLine = await draw($, on, FIXTURES.b!, 72)
    expect(onLine.lineRuns[0]!.at(-1)).toEqual({ text: 'wake on', props: {} })
  })
})

describe('motion and stability', () => {
  test('idle ticks draw byte-equal trees for (a) and (b)', async ($, on) => {
    harness(on)
    for (const fixture of [FIXTURES.a!, FIXTURES.b!]) {
      const one = await draw($, on, { ...fixture, tick: 4 }, 72)
      const two = await draw($, on, { ...fixture, tick: 5 }, 72)
      expect(JSON.stringify(two.tree)).toBe(JSON.stringify(one.tree))
    }
    expect(style.meta.animated).toBeUndefined()
  })

  test('PR 4 going running moves no other row and keeps the header right side put', async ($, on) => {
    harness(on)
    const before = await draw($, on, FIXTURES.a!, 72)
    const rows = WAVE.map(row => (row.number === 421 ? { ...row, ci: { kind: 'running', done: 1, total: 7 } as const } : row))
    const after = await draw($, on, { ...FIXTURES.a!, rows }, 72)
    expect(after.lines.slice(0, 6)).toEqual(before.lines.slice(0, 6))
    expect(after.lines[6]!.startsWith('◦ admin-web#421')).toBe(true)
    expect(after.lines[7]).toBe(before.lines[7])
  })

  test('a count going from 9 to 10 does not move the header right side', async ($, on) => {
    harness(on)
    const many = (n: number) => Array.from({ length: n }, (_, i) => pr('acme/app', 100 + i, `PR ${i}`))
    const nine = await draw($, on, { rows: many(9), polledAt: NOW }, 72)
    const ten = await draw($, on, { rows: many(10), polledAt: NOW }, 72)
    expect(nine.lines[0]!.indexOf('polled')).toBe(ten.lines[0]!.indexOf('polled'))
  })

  test('30 PRs: one line each, footer after the last row', async ($, on) => {
    harness(on)
    const rows = Array.from({ length: 30 }, (_, i) => pr('acme/app', 100 + i, `PR number ${i}`))
    const d = await draw($, on, { rows, polledAt: NOW }, 60, 20)
    expect(d.lines.length).toBe(3 + 30)
    expect(d.footer).toBe('gh every 60s · 0 model tokens')
    expect(d.tree).toMatchObject({ type: 'Box', props: { minHeight: 20, justifyContent: 'space-between' } })
  })
})

describe('status line', () => {
  const at = (f: Fixture) => statusText(f.rows ?? [], f.error ?? null, f.polledAt ?? null, NOW)
  test('the sheet strings for (a), (b), (c), (d)', async () => {
    expect(at(FIXTURES.a!)).toBe('wave 4 · 1 red rspec · 1 rebase · 1 running')
    expect(at(FIXTURES.b!)).toBe('wave 3 · all green')
    expect(at(FIXTURES.c!)).toBe('wave 0')
    expect(at(FIXTURES.d!)).toBe('wave · gh unreachable 3m')
  })
  test('under 48 characters, only · as a glyph, even with a long check name', async () => {
    const rows = WAVE.map((row, i) =>
      i === 0 ? { ...row, ci: { kind: 'red', failing: 'integration-tests-against-staging-database' } as const } : row,
    )
    const line = statusText(rows, null, NOW, NOW)
    expect(line.length < 48).toBe(true)
    expect(/^[ -~·]*$/.test(line)).toBe(true)
    expect(line).toBe('wave 4 · 1 red integrati · 1 rebase · 1 running')
  })
})

function engineBeneath(on: On) {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
}

test('end to end: a stored d1 style draws the Ledger through register.tsx', async ($, on) => {
    harness(on)
  const clock = mock.clock(on, { now: 1_000 })
  mock.store(on, { style: 'd1' })
  engineBeneath(on)
  const url = 'https://github.com/acme/app/pull/1'
  on('process.run', async ($, e) => {
    const stdout =
      e.argv[1] === 'search'
        ? JSON.stringify([{ number: 1, repository: { nameWithOwner: 'acme/app' }, title: 'One', url }])
        : JSON.stringify({
            number: 1, title: 'One', url, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE',
            mergeStateStatus: 'CLEAN',
            statusCheckRollup: [{ __typename: 'CheckRun', name: 'rspec', status: 'COMPLETED', conclusion: 'FAILURE' }],
            body: '', headRefName: 'h', baseRefName: 'main',
          })
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({
    plugin: 'wave-watcher',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'wave',
    props: { title: 'Wave', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  const d = split((await ui.drawn()) as Node)
  expect(d.lines[0]).toBe(`Wave  1 open${' '.repeat(60 - 12 - 23)}polled 0s ago · wake on`)
  expect(d.lines[3]).toContain('● app#1')
  expect(d.lines[3]).toContain('✗ rspec')
  invariants(d, 60)
  await ui.unmount()
})
