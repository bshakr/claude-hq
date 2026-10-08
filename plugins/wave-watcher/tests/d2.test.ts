import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { TOKENS, cells, statusText, style } from '../hooks/styles/d2'
import type { PaneCtx } from '../hooks/styles/types'
import type { WaveRow } from '../types'

type Node = { type: string; props: Record<string, unknown> }

const el = {
  Box: (p: Record<string, unknown>) => ({ type: 'Box', props: p }),
  Text: (p: Record<string, unknown>) => ({ type: 'Text', props: p }),
} as unknown as PaneCtx['el']

const NOW = 10_000_000

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
  pr('bshakr/monolense', 185, 'Pipeline: retry classification on timeout', { ci: { kind: 'running', done: 4, total: 7 }, isDraft: true }),
  pr('ritualpass/admin-web', 421, 'Stat cards: one-decimal trend deltas', { gallery: 'linked' }),
  pr('ritualpass/admin-web', 409, 'Sidebar: collapse state persists', { status: 'merged', merge: 'unknown', gallery: 'linked', mergedAt: NOW - 180_000 }),
]
const QUIET: WaveRow[] = [
  pr('ritualpass/admin-web', 421, 'Stat cards: one-decimal trend deltas', { gallery: 'linked' }),
  pr('bshakr/monolense', 186, 'Docs: ADR for refund reconciliation', { gallery: 'no visual change' }),
  pr('ritualpass/admin-web', 423, 'Schedule: empty state copy', { gallery: 'linked' }),
]

function ctx(over: Partial<PaneCtx>): PaneCtx {
  return {
    rows: [], polledAt: NOW - 20_000, now: NOW, error: null, isWaking: true, width: 72, bodyRows: 30,
    placement: 'dock', isFocused: false, tick: 0, el, surface: 'terminal', ...over,
  }
}

const STATES = {
  a: ctx({ rows: WAVE }),
  b: ctx({ rows: QUIET, polledAt: NOW - 40_000 }),
  c: ctx({ polledAt: NOW - 10_000 }),
  d: ctx({ rows: QUIET, polledAt: NOW - 180_000, error: 'gh: error connecting to api.github.com' }),
  f: ctx({ polledAt: null }),
}

function childrenOf(node: Node): unknown[] {
  const kids = node.props.children
  return (Array.isArray(kids) ? kids : [kids]).flat(Infinity).filter(k => k !== undefined && k !== null && k !== false)
}

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  return childrenOf(node as Node).map(textOf).join('')
}

function allNodes(node: unknown, out: Node[] = []): Node[] {
  if (typeof node !== 'object' || node === null) return out
  out.push(node as Node)
  for (const kid of childrenOf(node as Node)) allNodes(kid, out)
  return out
}

function draw(c: PaneCtx) {
  const tree = style.render(c) as unknown as Node
  const lines = childrenOf(tree).map(textOf)
  return { tree, lines, nodes: allNodes(tree) }
}

const shown = (c: PaneCtx) => draw(c).lines.map(line => line.trimEnd()).join('\n')

const RENDER_A_72 = `4 open · polled 20s ago · wake on

Needs you                                                              2
 ▎ monolense#183 · Ledger: reconcile partial refunds
 ▎ rspec is failing. Merge is clear once it passes.

 ▎ admin-web#418 · Members table: sticky header on scroll
 ▎ Behind main, needs a rebase. CI green, gallery linked.

In flight                                                              1
   monolense#185 · Pipeline: retry classification o…  draft · 4/7 checks

Ready                                                                  1
   admin-web#421 · Stat cards: one-decimal trend de…           gallery ◆

Landed                                                                 1
   admin-web#409 · Sidebar: collapse state persists        merged 3m ago`

const RENDER_B_72 = `3 open · polled 40s ago · wake on

✓ Nothing needs you.

Ready                                                                  3
   admin-web#421 · Stat cards: one-decimal trend de…           gallery ◆
   monolense#186 · Docs: ADR for refund reconciliat…    no visual change
   admin-web#423 · Schedule: empty state copy                  gallery ◆`

const RENDER_C_72 = `0 open · polled 10s ago · wake on

Nothing open.

No PRs merged in the last 30 min either.`

const RENDER_D_72 = `3 open · last good poll 3m ago · wake on
gh: error connecting to api.github.com · showing the last good poll

Ready                                                                  3
   admin-web#421 · Stat cards: one-decimal trend de…           gallery ◆
   monolense#186 · Docs: ADR for refund reconciliat…    no visual change
   admin-web#423 · Schedule: empty state copy                  gallery ◆`

const RENDER_F_72 = `first poll running · wake on

Checking GitHub for your open PRs…`

const RENDER_E_60 = `4 open · polled 20s ago · wake on

Needs you                                                  2
 ▎ monolense#183 · Ledger: reconcile partial refunds
 ▎ rspec is failing. Merge is clear once it passes.

 ▎ admin-web#418 · Members table: sticky header on scroll
 ▎ Behind main, needs a rebase. CI green, gallery linked.

In flight                                                  1
   monolense#185 · Pipeline: retry clas…  draft · 4/7 checks

Ready                                                      1
   admin-web#421 · Stat cards: one-deci…           gallery ◆

Landed                                                     1
   admin-web#409 · Sidebar: collapse st…       merged 3m ago`

const ALLOWED = new Set(['▎', '·', '✓', '◆', '…'])
const TOKEN_VALUES = new Set<string>(Object.values(TOKENS))

function colourCounts(c: PaneCtx): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const node of draw(c).nodes) {
    const color = node.props.color
    if (typeof color === 'string') counts[color] = (counts[color] ?? 0) + 1
  }
  return counts
}

describe('d2 Triage: sheet renders, cell for cell', () => {
  test('(a) wave at 72', async () => expect(shown(STATES.a)).toBe(RENDER_A_72))
  test('(b) quiet at 72', async () => expect(shown(STATES.b)).toBe(RENDER_B_72))
  test('(c) empty at 72', async () => expect(shown(STATES.c)).toBe(RENDER_C_72))
  test('(d) gh error at 72', async () => expect(shown(STATES.d)).toBe(RENDER_D_72))
  test('(f) first poll at 72', async () => expect(shown(STATES.f)).toBe(RENDER_F_72))
  test('(e) wave at 60', async () => expect(shown({ ...STATES.a, width: 60 })).toBe(RENDER_E_60))
})

describe('d2 Triage: invariants in every state at 85, 72, 60, 52, 51', () => {
  for (const [name, base] of Object.entries(STATES)) {
    for (const width of [85, 72, 60, 52, 51]) {
      test(`(${name}) at ${width}`, async () => {
        const { lines, nodes } = draw({ ...base, width })
        for (const line of lines) {
          expect(cells(line)).toBeLessThanOrEqual(width)
          for (const ch of line) {
            if (ch.charCodeAt(0) > 0x7e) expect(ALLOWED.has(ch)).toBe(true)
          }
          expect(line.split('…').length).toBeLessThanOrEqual(2)
        }
        for (const node of nodes) {
          expect(node.props.backgroundColor).toBeUndefined()
          expect(node.props.inverse).toBeUndefined()
          expect(node.props.italic).toBeUndefined()
          expect(node.props.underline).toBeUndefined()
          if (node.props.color !== undefined) {
            expect(TOKEN_VALUES.has(String(node.props.color))).toBe(true)
            expect(node.props.dimColor).toBeUndefined()
          }
        }
      })
    }
  }
})

describe('d2 Triage: colour, type and alignment', () => {
  test('(a) colour inventory: fail 3, warn 3, run 1, merged 1, nothing else', async () => {
    expect(colourCounts(STATES.a)).toEqual({ 'ansi256(1)': 3, 'ansi256(3)': 3, 'ansi256(4)': 1, 'ansi256(5)': 1 })
  })

  test('(b) quiet carries exactly one coloured cell, the ok tick', async () => {
    const coloured = draw(STATES.b).nodes.filter(n => n.props.color !== undefined)
    expect(coloured.map(n => [n.props.color, textOf(n)])).toEqual([['ansi256(2)', '✓']])
  })

  test('(d) error line is warn, stale rows add or drop no colour', async () => {
    const { nodes, lines } = draw(STATES.d)
    expect(colourCounts(STATES.d)).toEqual({ 'ansi256(3)': 1 })
    const warn = nodes.find(n => n.props.color === 'ansi256(3)')
    expect(warn && textOf(warn)).toBe('gh: error connecting to api.github.com · showing the last good poll')
    expect(lines.slice(3).every(line => line.trim() !== '')).toBe(true)
  })

  test('(d) with a red row keeps its bar and phrase colours, everything else dims', async () => {
    const c = ctx({ rows: WAVE, error: 'gh: error connecting to api.github.com' })
    expect(colourCounts(c)).toEqual({ 'ansi256(1)': 3, 'ansi256(3)': 4, 'ansi256(4)': 1, 'ansi256(5)': 1 })
    expect(draw(c).nodes.some(n => n.props.bold === true)).toBe(false)
  })

  test('bold only on the Needs you heading and actionable refs', async () => {
    const bold = draw(STATES.a).nodes.filter(n => n.props.bold === true).map(textOf)
    expect(bold).toEqual(['Needs you', 'monolense#183', 'admin-web#418'])
  })

  test('problems sit in the top 8 body rows, each behind a bar', async () => {
    const { lines } = draw(STATES.a)
    const red = lines.findIndex(l => l.includes('rspec is failing'))
    const rebase = lines.findIndex(l => l.includes('needs a rebase'))
    expect(red).toBeGreaterThan(-1)
    expect(red).toBeLessThan(8)
    expect(rebase).toBeLessThan(8)
    expect(lines[red]?.startsWith(' ▎ ')).toBe(true)
    expect(lines[rebase]?.startsWith(' ▎ ')).toBe(true)
  })

  for (const width of [85, 72, 60]) {
    test(`headings and fact lines are exactly ${width} wide, facts end on the last cell`, async () => {
      const { lines } = draw({ ...STATES.a, width })
      const full = lines.filter(l => /^(Needs you|In flight|Ready|Landed) /.test(l) || l.startsWith('   '))
      expect(full.length).toBe(7)
      for (const line of full) expect(cells(line)).toBe(width)
      expect(lines.some(l => l.endsWith('draft · 4/7 checks'))).toBe(true)
      expect(lines.some(l => l.endsWith('merged 3m ago'))).toBe(true)
    })
  }

  test('below 52 the fact drops under the title as its own line', async () => {
    const { lines } = draw({ ...STATES.a, width: 50 })
    const at = lines.findIndex(l => l.startsWith('   monolense#185'))
    expect(lines[at + 1]).toBe('   draft · 4/7 checks')
  })

  test('the sentence drops its second clause when the line is too narrow, never truncates', async () => {
    const { lines } = draw({ ...STATES.a, width: 56 })
    expect(lines).toContain(' ▎ Behind main, needs a rebase.')
    expect(lines).toContain(' ▎ rspec is failing. Merge is clear once it passes.')
  })

  test('a long failing check keeps at least 8 cells before its …', async () => {
    const rows = [pr('bshakr/monolense', 1, 'x', { ci: { kind: 'red', failing: 'build-and-test-on-every-platform-matrix' } })]
    const line = draw(ctx({ rows, width: 52 })).lines[4] ?? ''
    expect(cells(line)).toBeLessThanOrEqual(52)
    expect(line).toMatch(/^ ▎ build-and-test.*… is failing\.$/)
  })

  test('two idle ticks draw byte-equal trees (no motion)', async () => {
    for (const base of [STATES.a, STATES.b]) {
      expect(JSON.stringify(draw({ ...base, tick: 7 }).tree)).toBe(JSON.stringify(draw({ ...base, tick: 8 }).tree))
    }
  })

  test('wake off is dim, wake on is plain', async () => {
    const off = draw({ ...STATES.a, isWaking: false }).nodes.find(n => textOf(n) === 'wake off')
    expect(off?.props.dimColor).toBe(true)
    expect(draw(STATES.a).nodes.some(n => n.type === 'Text' && n.props.dimColor === true && textOf(n) === 'wake on')).toBe(false)
  })

  test('a repo short name shared by two owners shows owner/repo', async () => {
    const rows = [pr('a/app', 1, 'One'), pr('b/app', 2, 'Two')]
    expect(shown(ctx({ rows }))).toContain('a/app#1 · One')
  })
})

describe('d2 Triage: status line text', () => {
  test('(a), (b), (c), (d), (f)', async () => {
    expect(statusText(STATES.a)).toBe('wave: 2 need you · 1 in flight · 1 ready')
    expect(statusText(STATES.b)).toBe('wave: nothing needs you')
    expect(statusText(STATES.c)).toBe('wave: nothing open')
    expect(statusText(STATES.d)).toBe('wave: gh unreachable, last poll 3m ago')
    expect(statusText(STATES.f)).toBe('wave: first poll running')
    for (const s of Object.values(STATES)) expect(statusText(s).length).toBeLessThan(48)
  })
})

const URL1 = 'https://github.com/acme/app/pull/1'

function fakeGh(on: On) {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', async ($, e) => {
    const stdout =
      e.argv[1] === 'search'
        ? JSON.stringify([{ number: 1, repository: { nameWithOwner: 'acme/app' }, title: 'One', url: URL1 }])
        : JSON.stringify({
            number: 1, title: 'One', url: URL1, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE',
            mergeStateStatus: 'CLEAN', statusCheckRollup: [{ __typename: 'CheckRun', name: 'rspec', status: 'COMPLETED', conclusion: 'FAILURE' }],
            body: '', headRefName: 'h', baseRefName: 'main',
          })
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

test('d2 validates on the real terminal and desktop tables', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  mock.store(on, { style: 'd2' })
  fakeGh(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.settle()
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'wave-watcher',
      surface,
      component: 'Pane',
      requestId: 'wave',
      props: { title: 'Wave', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
    })
    expect(await ui.find({ type: 'Text', text: 'Needs you' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /rspec is failing/ })).toBeDefined()
    await ui.unmount()
  }
})
