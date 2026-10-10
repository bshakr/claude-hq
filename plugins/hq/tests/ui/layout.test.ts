import { describe, expect, test } from 'claude-code/testing'

import type { AgentVM, HqModel } from '../../hooks/model/types'
import {
  FINISHED_ID,
  FINISHED_KEY,
  FOCUSED_HINT,
  UNFOCUSED_HINT,
  compactTokens,
  layout,
  morePrsId,
  morePrsKey,
  scrollFor,
  sessionPrKey,
} from '../../hooks/ui/layout'
import { caretItem, caretKey } from '../../hooks/ui/caret'
import type { View } from '../../hooks/ui/layout'
import type { Row } from '../../hooks/ui/row'
import { cellLen } from '../../hooks/ui/text'
import { ACTIVE, BUSY, EMPTY, KINDS, LONG, OTHER_PRS, QUIET, WITH_PRS } from './fixtures'
import * as SHEET from './sheet'

const view = (over: Partial<View> = {}): View => ({
  width: 80,
  rows: 64,
  focused: false,
  cursor: null,
  expanded: [],
  scroll: 0,
  phase: 0,
  ...over,
})
const lines = (m: HqModel, over: Partial<View> = {}) => layout(m, view(over)).rows.map(r => r.text())

function expectSheet(got: string[], want: string[]) {
  expect(got.length).toBe(want.length)
  want.forEach((line, i) => expect(`${i + 1}: ${got[i]}`).toBe(`${i + 1}: ${line}`))
}

describe('the sheet, cell for cell', () => {
  test('(a) busy, unfocused, 80 cols', () => expectSheet(lines(BUSY), SHEET.a80))
  test("(a') busy, focused, cursor on the flare", () => expectSheet(lines(BUSY, { focused: true, cursor: 'flare' }), SHEET.aFocusFlare))
  test('(b) quiet, unfocused', () => expectSheet(lines(QUIET), SHEET.b80))
  test("(b') quiet, focused, cursor on #433", () =>
    expectSheet(lines(QUIET, { focused: true, cursor: 'p:acme-store/admin-web#433' }), SHEET.bFocus433))
  test('(c) busy, focused, cursor on st-admin', () => expectSheet(lines(BUSY, { focused: true, cursor: 's:s-st-admin' }), SHEET.c80))
  test('(e) 40 cols', () => expectSheet(lines(BUSY, { width: 40 }), SHEET.e40))
  test('(e) 88 cols', () => expectSheet(lines(BUSY, { width: 88 }), SHEET.e88))
  test('(f) long list', () => expectSheet(lines(LONG), SHEET.f80))
  test('(f2) long list, focused, scrolled to the bottom', () =>
    expectSheet(lines(LONG, { focused: true, cursor: 's:s-blog-r', scroll: 99 }), SHEET.f2))
  test('(f3) long list on a 34-row pane', () => expectSheet(lines(LONG, { rows: 34 }), SHEET.f3))
  test("(g) other sessions' PRs, unfocused", () => expectSheet(lines(WITH_PRS, { rows: 40 }), SHEET.g80))
  test("(g') cursor on st-api's second PR", () =>
    expectSheet(lines(WITH_PRS, { rows: 40, focused: true, cursor: 's:s-st-api:p:acme-store/api#528' }), SHEET.g2))
  test('(k) agent kinds: main loop, subagents and a shell; another session busy on a subagent; an idle one', () =>
    expectSheet(lines(KINDS, { rows: 30, width: 72 }), SHEET.kinds72))
})

const MODELS = { BUSY, QUIET, LONG, EMPTY, ACTIVE, WITH_PRS }
const DATA_TEXT = [
  ...new Set(
    Object.values(MODELS).flatMap(m => [
      ...m.current.agents.flatMap(a => [a.title, a.outcome ?? '', a.now ?? '']),
      ...m.current.prs.map(p => p.title),
      m.current.now?.prompt ?? '',
      m.current.now?.tool?.text ?? '',
      ...(m.current.todos ?? []).map(t => t.text),
      ...(m.current.waiting ?? []).map(w => w.text),
    ]),
  ),
]
  .filter(Boolean)
  .sort((a, b) => b.length - a.length)
const GLYPHS = new Set([...'▌▐◆●○✻✢✓✗↑↓→·⏎⌃…─│╭╮╰╯┏┓┗┛┃├┤┣┫▰▱━−'])

describe('every state, every width', () => {
  test('rows fill the body exactly and never pass its width', () => {
    for (const m of Object.values(MODELS)) {
      for (const width of [12, 30, 40, 48, 60, 72, 80, 88, 120]) {
        for (const rows of [6, 12, 20, 34, 58]) {
          for (const focused of [false, true]) {
            const l = layout(m, view({ width, rows, focused, cursor: 'flare', expanded: ['a3', 'a1'] }))
            expect(l.rows.length).toBe(rows)
            for (const r of l.rows) expect(cellLen(r.text()) <= width).toBe(true)
          }
        }
      }
    }
  })

  test('only the card glyphs: no tree, rules, gutters or legend; no action words', () => {
    const fixtureText = JSON.stringify(MODELS)
    for (const m of Object.values(MODELS)) {
      for (const focused of [false, true]) {
        const cursor = focused ? 'a:a1' : null
        const text = lines(m, { focused, cursor, expanded: ['a3', 'a2'] }).join('\n')
        for (const ch of text) {
          if (ch.charCodeAt(0) < 128) continue
          expect(GLYPHS.has(ch) || fixtureText.includes(ch) ? ch : `stray ${ch}`).toBe(ch)
        }
        const chrome = DATA_TEXT.reduce((t, s) => t.split(s).join(''), text)
        expect(chrome.match(/\b(act|acts|retry|copy|arm|dismiss)\b/gi)).toBe(null)
        expect(chrome.includes('checks done / to go')).toBe(false)
        expect(/\d+ sessions?\b/.test(chrome)).toBe(false)
        expect(text.includes(focused ? FOCUSED_HINT : UNFOCUSED_HINT)).toBe(true)
      }
    }
    // Rows drop the background flag and tool counts; the expanded detail keeps them.
    const rows = lines(BUSY).join('\n')
    expect(/\bbg\b|\bfg\b|\d+ tools?\b/.test(rows)).toBe(false)
  })

  test('truncation ends in one …, names and refs never cut', () => {
    for (const width of [40, 60]) {
      const text = lines(BUSY, { width, rows: 90 }).join('\n')
      for (const keep of ['#212', '#214', '#431', '#433', '#429', '#522', 'st-api', 'webapp-ui-research', 'blog-research']) {
        expect(text.includes(keep)).toBe(true)
      }
      expect(text.includes('……')).toBe(false)
    }
  })

  test('a card shrinks with the pane: its border spans the width at 40 and 80', () => {
    for (const width of [40, 80]) {
      const got = lines(BUSY, { width, rows: 90 })
      const tops = got.filter(l => l.startsWith(' ╭─ '))
      expect(tops.map(l => l.slice(4).split(' ')[0])).toEqual([
        'this',
        'acme-store',
        'devbox-local',
        'webapp-ui',
        'photo-site',
        'blog-engine',
        'finance',
      ])
      for (const l of got.filter(t => /^ [╭│╰├]/.test(t))) {
        expect(cellLen(l)).toBe(width - 1)
        expect(/[╮│╯┤]$/.test(l)).toBe(true)
      }
    }
  })
})

type Run = { col: number; t: string; tok: string }
const runsOf = (r: Row): Run[] =>
  r
    .segs()
    .filter(s => s.t.trim() && s.t !== '│' && (s.s.c || s.s.bold || s.s.dim))
    .map(s => ({ col: s.col, t: s.t.trimEnd(), tok: [s.s.bold ? 'bold' : '', s.s.c ?? (s.s.dim ? 'dim' : '')].filter(Boolean).join('+') }))
// A heavy run holds a corner or side, so the todo bar's ━ is not taken for one.
const BORDER = /^[╭╮╰╯│─├┤]+$|^━*[┏┓┗┛┃┣┫][━┏┓┗┛┃┣┫]*$/
const coloured = (rows: Row[]) => rows.flatMap(r => r.segs().filter(s => s.s.c && s.t.trim() && !BORDER.test(s.t)))
const borderTone = (rows: Row[], title: string) => rows.find(r => r.text().startsWith(` ╭─ ${title}`))!.cells[1]!.s.c

describe('colour', () => {
  test('header: no sentence of counts; the flare under it still says who needs you', () => {
    expect(lines(BUSY)[0]).toBe('')
    expect(lines(QUIET)[0]).toBe('')
    expect(lines(BUSY, { focused: true })[0]).toBe('▌')
    expect(lines(BUSY)[2]!.startsWith(' ◆ st-api is waiting for your input')).toBe(true)
  })

  test('card borders: dim normally, yellow when something needs you, red when broken', () => {
    const rows = layout(BUSY, view({ rows: 90 })).rows
    expect(borderTone(rows, 'this session')).toBe('fail')
    expect(borderTone(rows, 'acme-store')).toBe('wait')
    expect(borderTone(rows, 'devbox-local')).toBe('rule')
    const long = layout(LONG, view({ rows: 90 })).rows
    expect(borderTone(long, 'finance')).toBe('fail')
    const quiet = layout(QUIET, view()).rows
    for (const r of quiet.filter(x => x.text().startsWith(' ╭─ '))) expect(r.cells[1]!.s.c).toBe('rule')
  })

  test('the #212 and #214 check bars', () => {
    const rows = layout(BUSY, view({ rows: 90 })).rows
    const row = (ref: string) => rows.find(r => r.text().includes(ref))!
    expect(runsOf(row('#212')).slice(-3)).toEqual([
      { col: 62, t: '▰▰▰▰▰▰▰▰▰', tok: 'dim' },
      { col: 71, t: '▰', tok: 'fail' },
      { col: 73, t: '9/9', tok: 'fail' },
    ])
    expect(runsOf(row('#214')).slice(-3)).toEqual([
      { col: 62, t: '▰▰▰▰▰▰', tok: 'run' },
      { col: 68, t: '▱▱▱▱', tok: 'dim' },
      { col: 73, t: '5/9', tok: 'run' },
    ])
    const facts = (ref: string) => rows[rows.indexOf(row(ref)) + 1]!
    expect(runsOf(facts('#212'))[0]).toEqual({ col: 10, t: '✗ rspec failed', tok: 'fail' })
    expect(runsOf(facts('#431'))).toContainEqual({ col: 22, t: '↑ behind main', tok: 'wait' })
    expect(runsOf(facts('#522'))).toContainEqual({ col: 22, t: 'no watcher', tok: 'wait' })
  })

  test("quiet has no coloured cell but the borders and this session's title; focus adds only ▌ and ▐", () => {
    expect(coloured(layout(QUIET, view()).rows).map(s => `${s.t}=${s.s.c}`)).toEqual(['this session=accent'])
    const focused = layout(QUIET, view({ focused: true, cursor: 'p:acme-store/admin-web#433' }))
    expect(coloured(focused.rows).map(s => `${s.t}=${s.s.c}`)).toEqual(['▌=accent', 'this session=accent', '▐=accent'])
  })

  test('unfocused draws no cursor even with one remembered', () => {
    const text = lines(BUSY, { cursor: 'flare' }).join('\n')
    expect(text.includes('▐')).toBe(false)
    expect(text.includes('▌')).toBe(false)
  })

  test('no background colour on any cell', () => {
    for (const r of layout(BUSY, view()).rows) for (const s of r.segs()) expect('bg' in s.s).toBe(false)
  })
})

describe('targets', () => {
  test('one Button per actionable row, each with its jump or expansion', () => {
    const l = layout(BUSY, view({ focused: true, rows: 120 }))
    expect(l.items).toEqual([
      'flare',
      'a:a5',
      'a:a1',
      'a:a2',
      'a:a3',
      'a:a4',
      'p:acmeco/webapp-ui#212',
      'p:acmeco/webapp-ui#214',
      'p:acme-store/admin-web#431',
      'p:acme-store/admin-web#433',
      'p:acme-store/admin-web#429',
      'p:acme-store/api#522',
      's:s-st-api',
      's:s-st-admin',
      's:s-st-docs',
      's:s-home',
      's:s-mono-r',
      's:s-photos',
      's:s-blog',
      's:s-blog-r',
      's:s-fin',
    ])
    const buttons = l.rows.flatMap(r => r.buttons)
    const shown = l.items.filter(k => l.rows.some(r => r.head && r.item === k))
    for (const key of shown) {
      expect(buttons.filter(b => b.key === key).length).toBe(1)
      // Its caret presses the same thing.
      expect(buttons.filter(b => b.key === caretKey(key)).map(b => b.action)).toEqual([l.actions[key]!])
    }
    expect(buttons.map(b => b.key).filter(k => !l.items.includes(k) && caretItem(k) === undefined)).toEqual(['j', 'k'])
    expect(l.actions.flare).toEqual({ kind: 'jump', jump: { kind: 'tmux', target: 'acme-store:@3.%6' } })
    expect(l.actions['p:acmeco/webapp-ui#212']).toEqual({
      kind: 'jump',
      jump: { kind: 'url', url: 'https://github.com/acmeco/webapp-ui/pull/212' },
    })
    expect(l.actions['s:s-st-admin']).toEqual({ kind: 'jump', jump: { kind: 'tmux', target: 'acme-store:@4.%13' } })
    expect(l.actions['a:a3']).toEqual({ kind: 'toggle', id: 'a3' })
    const all = layout(BUSY, view({ rows: 90 }))
    const hrefs = all.rows.flatMap(r =>
      r
        .segs()
        .filter(s => s.s.href)
        .map(s => `${s.t}=${s.s.href}`),
    )
    expect(hrefs).toContain('#212=https://github.com/acmeco/webapp-ui/pull/212')
    expect(hrefs.length).toBe(BUSY.current.prs.length)
  })

  test('every line of an item, border cells included, shares its key so hover lights the whole item', () => {
    const rows = layout(ACTIVE, view({ rows: 90 })).rows
    // The agents divider between them belongs to no item.
    const group = rows.filter(r => r.item === 's:s-st-admin')
    expect(group.length).toBe(5)
    expect(group.every(r => r.text().startsWith(' │') && r.text().endsWith('│'))).toBe(true)
    expect(group.filter(r => r.head).length).toBe(1)
  })

  test('a session without a jump is drawn but is not a target', () => {
    const m: HqModel = {
      ...QUIET,
      others: [{ tmuxSession: 'x', sessions: [{ sessionId: 'nojump', name: 'loose', windowLabel: '', status: 'idle' }] }],
    }
    const l = layout(m, view())
    expect(l.items.includes('s:nojump')).toBe(false)
    expect(lines(m).some(t => t.startsWith(' │  loose'))).toBe(true)
  })

  test('expanding an agent adds its detail lines under it', () => {
    const closed = lines(BUSY)
    const open = lines(BUSY, { expanded: ['a3'] })
    expect(open.length).toBe(closed.length)
    const at = open.findIndex(t => t.includes('Adversarial review'))
    // Nothing the header already says: no model, elapsed, tool or token counts.
    expect(open[at + 1]!.startsWith(' │    result  3 findings: 1 HIGH')).toBe(true)
    expect(open.some(t => /│ {4}(agent|doing) |\d+ tools\b|tokens/.test(t))).toBe(false)
    const running = lines(BUSY, { expanded: ['a2'] })
    const r = running.findIndex(t => t.includes('✢ Run ledger specs'))
    expect(running[r + 1]!.includes('Bash: bin/rspec')).toBe(true)
    expect(running[r + 2]!.includes('in      .koh/ledger-refund-reconcile')).toBe(true)
    expect(running.filter(t => t.includes('bin/rspec')).length).toBe(1)
  })

  test('no pull requests, no section; there is no pull requests card', () => {
    const m: HqModel = { ...QUIET, current: { ...QUIET.current, prs: [] } }
    expect(lines(m, { rows: 90 }).some(l => l.includes('pull requests'))).toBe(false)
    const got = lines(QUIET, { rows: 90 })
    expect(got.some(l => l.includes('╭─ pull requests'))).toBe(false)
    const div = got.findIndex(l => l.startsWith(' ├─ pull requests '))
    expect(div > got.findIndex(l => l.startsWith(' ╭─ this session'))).toBe(true)
    expect(div < got.findIndex(l => l.includes('── other sessions'))).toBe(true)
    expect(got[div + 2]!.startsWith(' │  #433  Stat cards')).toBe(true)
  })
})

describe('scrolling and motion', () => {
  test('the below indicator counts lit items, the above one appears once scrolled', () => {
    const top = lines(LONG, { rows: 34 })
    expect(top[32]).toBe(' ↓ 43 rows below   ✗ 1 broken   ◆ 3 waiting on you')
    const mid = lines(LONG, { rows: 34, scroll: 10 })
    expect(mid[3]!.startsWith(' ↑ 10 rows above   ✗ 1 broken')).toBe(true)
    expect(mid[32]!.startsWith(' ↓ 33 rows below')).toBe(true)
  })

  test('scrollFor keeps the cursor row inside the window', () => {
    const l = layout(LONG, view({ rows: 34 }))
    const key = 's:s-blog-r'
    const s = scrollFor(l, key, 0)
    const line = l.itemLine[key]!
    expect(line >= s && line < s + l.region).toBe(true)
    expect(scrollFor(l, 'a:a5', s)).toBe(Math.min(s, l.itemLine['a:a5']!))
  })

  test('busy: one changed cell per running thing per phase; quiet: none', () => {
    const changed = (m: HqModel) => {
      const a = layout(m, view({ phase: 0, rows: 90 })).rows
      const b = layout(m, view({ phase: 1, rows: 90 })).rows
      let n = 0
      a.forEach((r, i) =>
        r.cells.forEach((c, j) => {
          const d = b[i]!.cells[j]!
          if (c.ch !== d.ch || JSON.stringify(c.s) !== JSON.stringify(d.s)) n++
        }),
      )
      return n
    }
    // a2's breath, #214's next check, st-admin's breath.
    expect(changed(BUSY)).toBe(3)
    expect(changed(QUIET)).toBe(0)
  })
})

describe('this session: one card for now, todos, waiting and agents', () => {
  test('now, todos and waiting open the card; agents follow under their divider', () => {
    const got = lines(ACTIVE)
    expect(got.slice(4, 21)).toEqual([
      ' ╭─ this session ─────────────────────────────────────────────────────────────╮',
      ' │  ✻ Fix the stale PR list in hq and scope wave-watcher wakes to the o…  2m  │',
      ' │    Check CI on 276                                                     4s  │',
      ' │    $ pr-ci-wait 276                                                    3m  │',
      ' │  todos 2/5 ━━━─────  ● Rewriting the layout                                │',
      ' │                                                                            │',
      ' ├─ agents ───────────────────────────────────────────────────────────────────┤',
      ' │  ✗ Capture screenshot pairs                               sonnet · 6m 30s  │',
      ' │    port 3000 already in use · failed 1m ago                                │',
      ' │  ✢ Implement ledger refund reconcile                       opus · 14m 20s  │',
      ' │    waiting on Run ledger specs and report                                  │',
      ' │    ✢ Run ledger specs and report     ledger-refund-rec… · sonnet · 2m 10s  │',
      ' │      Running ledger specs                                             3/7  │',
      ' │                                                                            │',
      ' │  ✓ Adversarial review: refunds PR → 3 findings: 1 HIGH (refund r…  3m ago  │',
      ' │    ✓ Find refund callers → 4 callers, all in app/ledger            5m ago  │',
      ' ├─ pull requests ────────────────────────────────────────────────────────────┤',
    ])
    const at = (t: string) => got.findIndex(l => l.includes(t))
    expect(at('├─ pull requests') < at('── other sessions')).toBe(true)
    expect(got.some(l => /[└┄]/.test(l))).toBe(false)
  })

  test('colours: blue for the running turn and the todo bar, a dim background shell; never yellow', () => {
    const rows = layout(ACTIVE, view()).rows
    const toks = coloured(rows.slice(5, 9)).map(x => `${x.t}=${x.s.c}`)
    expect(toks).toEqual(['✻=run', '━━━=run', '●=run'])
    expect(rows[7]!.segs().find(x => x.t === '$')!.s).toEqual({ dim: true })
  })

  test('idle after the turn: dim, reads idle, no tool line', () => {
    const quiet = ACTIVE.current.agents.filter(a => a.status !== 'running' && a.status !== 'waiting')
    const m = {
      ...ACTIVE,
      current: {
        ...ACTIVE.current,
        agents: quiet,
        now: { prompt: 'Ship it', since: ACTIVE.now - 60_000, idle: true },
        todos: undefined,
        waiting: undefined,
      },
    }
    const rows = layout(m, view()).rows
    expect(rows[5]!.text()).toBe(' │  ✻ idle · Ship it                                                      1m  │')
    expect(coloured([rows[5]!])).toEqual([])
    expect(rows[6]!.text()).toBe(' │                                                                            │')
    expect(rows[7]!.text()).toBe(' ├─ agents ───────────────────────────────────────────────────────────────────┤')
    expect(rows[8]!.text().startsWith(' │  ✗ Capture screenshot pairs')).toBe(true)
  })

  test('an empty session says so', () => {
    expect(lines(EMPTY)[3]).toBe(' │  nothing running                                                           │')
  })

  test("an agent inside one long call holds its glyph steady and reads what it waits on and the call's age", () => {
    const agent = (callAgo: number) => ({
      id: 'lc',
      title: 'Watch CI',
      status: 'running' as const,
      background: true,
      startedAt: QUIET.now - 20 * 60_000,
      toolCount: 4,
      files: [],
      now: 'Wait for CI on #275',
      callSince: QUIET.now - callAgo,
    })
    const m = (callAgo: number) => ({ ...QUIET, current: { ...QUIET.current, agents: [agent(callAgo)] } })
    const draw = (callAgo: number) => lines(m(callAgo))
    // Phase 1 is the pulse's dim step: only a working agent takes it.
    const glyph = (callAgo: number) =>
      layout(m(callAgo), view({ phase: 1 }))
        .rows.flatMap(r => r.segs())
        .find(x => x.t === '✢')!.s
    const long = draw(7 * 60_000)
    const at = long.findIndex(l => l.includes('Watch CI'))
    expect(long[at]!.startsWith(' │  ✢ Watch CI')).toBe(true)
    expect(long[at + 1]!.startsWith(' │    waiting · Wait for CI on #275 · 7m ')).toBe(true)
    expect(glyph(7 * 60_000)).toEqual({ c: 'run' })
    const short = draw(30_000)
    expect(short[at]!.startsWith(' │  ✢ Watch CI')).toBe(true)
    expect(short[at + 1]!.startsWith(' │    Wait for CI on #275 ')).toBe(true)
    expect(glyph(30_000)).toEqual({ c: 'run', dim: true })
  })

  test('a finished agent with a markdown report shows its first sentence as plain text', () => {
    const m: HqModel = {
      ...QUIET,
      current: {
        ...QUIET.current,
        agents: [
          {
            id: 'md',
            title: 'Scope PR ownership',
            status: 'completed',
            background: true,
            startedAt: QUIET.now - 60_000,
            endedAt: QUIET.now - 30_000,
            toolCount: 3,
            files: [],
            outcome: '**Brief and all four add-ons are done.** HQ now shows `todos`.',
          },
        ],
      },
    }
    const row = lines(m).find(l => l.includes('Scope PR ownership'))!
    expect(row.includes('✓ Scope PR ownership → Brief and all four add-ons are done.')).toBe(true)
    expect(row.includes('30s ago')).toBe(true)
    expect(/[*`]/.test(row)).toBe(false)
  })
})

describe('other sessions: one card per tmux group', () => {
  test('sessions of one group share a card, a blank between them, a bare rule after one with sections', () => {
    const got = lines(ACTIVE, { rows: 90 })
    const at = got.findIndex(l => l.includes('╭─ acme-store'))
    expect(got.slice(at, at + 15)).toEqual([
      ' ╭─ acme-store ───────────────────────────────────────────────────────────────╮',
      ' │  st-api                           1 agent · 1 PR needs you · ◆ waiting 2m  │',
      ' │  api · ENG-12 · 3/7 · Rewriting PR claim rules                             │',
      ' │                                                                            │',
      ' │  st-admin                                 1 of 2 PRs need you · ✻ busy 6m  │',
      ' │                                                                            │',
      ' ├─ agents ───────────────────────────────────────────────────────────────────┤',
      ' │  ✢ Implement ENG-1941 card pairing guard                       opus · 12m  │',
      ' │  ✢ Review the members table PR                               sonnet · 20m  │',
      ' │  ✢ Capture screenshot pairs                                           25m  │',
      ' │    +1 more                                                                 │',
      ' ├────────────────────────────────────────────────────────────────────────────┤',
      ' │  st-docs                                                          idle 1h  │',
      ' ╰────────────────────────────────────────────────────────────────────────────╯',
      '',
    ])
  })

  test("another session's agent inside a long call keeps one line, its glyph steady", () => {
    const m: HqModel = {
      ...ACTIVE,
      others: ACTIVE.others.map(g => ({
        ...g,
        sessions: g.sessions.map(x =>
          x.agents ? { ...x, agents: [{ ...x.agents[0]!, waiting: { text: 'Run the spec suite', since: ACTIVE.now - 9 * 60_000 } }] } : x,
        ),
      })),
    }
    const other = lines(m, { rows: 90 })
    const at = other.findIndex(l => l.includes('✢ Implement ENG-1941'))
    expect(other[at + 1]).toMatch(/^ (│ {4}\+\d+ more|[├╰]─)/)
    expect(other.some(l => l.includes('Run the spec suite'))).toBe(false)
    // Phase 1 is the pulse's dim step: only a working agent takes it.
    const glyph = layout(m, view({ rows: 90, phase: 1 }))
      .rows.filter(r => r.text().includes('Implement ENG-1941'))
      .flatMap(r => r.segs())
      .find(x => x.t === '✢')!.s
    expect(glyph).toEqual({ c: 'opus' })
  })

  test("another session's agents are one line each; this session's keep their detail line", () => {
    const got = lines(KINDS, { rows: 30, width: 72 })
    const mine = got.findIndex(l => l.includes('✢ Implement ledger refund reconcile'))
    expect(got[mine + 1]!.startsWith(' │    Edit app/ledger/refund.rb')).toBe(true)
    const theirs = got.findIndex(l => l.includes('✢ Adversarial review: candidate build'))
    expect(got[theirs + 1]!.startsWith(' ╰─')).toBe(true)
    expect(got.some(l => l.includes('reading pipeline.rb'))).toBe(false)
  })
})

describe('this session: finished agents, the waiting now line, the goal line', () => {
  const fin = (id: string, minsAgo: number): AgentVM => ({
    id,
    title: `Finished ${id}`,
    status: 'completed',
    background: true,
    startedAt: BUSY.now - 20 * 60_000,
    endedAt: BUSY.now - minsAgo * 60_000,
    toolCount: 3,
    files: [],
    outcome: `outcome ${id}`,
  })
  const FIN: HqModel = { ...BUSY, current: { ...BUSY.current, agents: [...BUSY.current.agents, fin('f1', 1), fin('f2', 7), fin('f3', 9)] } }

  test('only the newest finished agent shows, then one dim +N finished row that toggles the rest', () => {
    const closed = layout(FIN, view({ rows: 90 }))
    const got = closed.rows.map(r => r.text())
    const at = got.findIndex(l => l.includes('✓ Finished f1'))
    expect(got[at + 1]).toBe(' │    +3 finished                                                             │')
    expect(got.some(l => l.includes('Finished f2') || l.includes('Adversarial review'))).toBe(false)
    expect(closed.items.includes(FINISHED_KEY)).toBe(true)
    expect(closed.actions[FINISHED_KEY]).toEqual({ kind: 'toggle', id: FINISHED_ID })
    expect(closed.rows[at + 1]!.cells[6]!.s.dim).toBe(true)
    const open = lines(FIN, { rows: 90, expanded: [FINISHED_ID] })
    const o = open.findIndex(l => l.includes('✓ Finished f1'))
    expect(open[o + 1]!.includes('− 3 finished')).toBe(true)
    const rest = ['✓ Adversarial review', '✓ Find refund callers', '✓ Finished f2', '✓ Finished f3']
    rest.forEach((t, i) => expect(open[o + 2 + i]!.includes(t)).toBe(true))
  })

  test('one finished agent needs no toggle row', () => {
    expect(lines(BUSY, { rows: 90 }).some(l => l.includes('finished'))).toBe(false)
  })

  test('idle with agents running reads waiting on N agents, timed by the longest-running one', () => {
    const m = { ...BUSY, current: { ...BUSY.current, now: { prompt: 'agent reported: done', since: BUSY.now - 60_000, idle: true } } }
    const got = lines(m)
    expect(got[5]).toBe(' │  ✻ waiting on 1 agent                                             14m 20s  │')
    // Waiting, not working: the main glyph keeps its colour through the pulse.
    expect(
      layout(m, view({ phase: 1 }))
        .rows[5]!.segs()
        .find(x => x.t === '✻')!.s,
    ).toEqual({ c: 'run' })
    expect(got.some(l => l.includes('idle ·'))).toBe(false)
    const waitsOnly = {
      ...QUIET,
      current: {
        ...QUIET.current,
        now: { since: QUIET.now, idle: true },
        waiting: [{ text: 'pr-ci-wait 276', since: QUIET.now - 3 * 60_000 }],
      },
    }
    expect(lines(waitsOnly)[3]!.includes('✻ waiting on 1 background task')).toBe(true)
    expect(lines(waitsOnly)[4]!.includes('  $ pr-ci-wait 276')).toBe(true)
  })

  test('without a goal the context meter rides on the now line, not a line of its own', () => {
    const m: HqModel = { ...ACTIVE, current: { ...ACTIVE.current, context: { percent: 36, window: 1_000_000, source: 'live' } } }
    const got = lines(m)
    expect(got[4]!.startsWith(' ╭─ this session')).toBe(true)
    expect(got[5]!.startsWith(' │  ✻ Fix the stale PR list')).toBe(true)
    expect(got[5]!.endsWith('2m  ● ● ● ● ● 36%  │')).toBe(true)
    expect(got.filter(l => l.includes('36%')).length).toBe(1)
  })

  test('with a goal the card takes the repo name, the goal line carries day, status and meter, the step sits under it', () => {
    const m: HqModel = {
      ...ACTIVE,
      current: {
        ...ACTIVE.current,
        title: 'claude-hq',
        goal: { text: 'Ship the HQ layout fixes', day: 3, step: 'Rewriting the agent rows' },
        context: { percent: 36, window: 1_000_000, source: 'live' },
      },
    }
    const got = lines(m)
    expect(got[4]!.startsWith(' ╭─ claude-hq · this session ─')).toBe(true)
    expect(got[5]).toBe(' │  Ship the HQ layout fixes                   day 3 · ✻ busy  ● ● ● ● ● 36%  │')
    expect(got[6]).toBe(' │  Rewriting the agent rows                                                  │')
    expect(got[7]!.startsWith(' │  ✻ Fix the stale PR list')).toBe(true)
    expect(got[7]!.endsWith('2m  │')).toBe(true)
    const noGoal = lines({ ...m, current: { ...m.current, goal: undefined } })
    expect(noGoal[4]!.startsWith(' ╭─ this session')).toBe(true)
  })

  test('working agent glyphs keep one glyph and step colour between full and dim', () => {
    for (const m of [BUSY, ACTIVE]) {
      const a = layout(m, view({ phase: 0, rows: 90 })).rows
      const b = layout(m, view({ phase: 1, rows: 90 })).rows
      let stepped = 0
      a.forEach((r, i) =>
        r.cells.forEach((c, j) => {
          const d = b[i]!.cells[j]!
          if ('✻✢●'.includes(c.ch) || '✻✢●'.includes(d.ch)) {
            expect(d.ch).toBe(c.ch)
            if (c.s.c !== undefined && c.s.c === d.s.c && !c.s.dim && d.s.dim) stepped++
          }
        }),
      )
      expect(stepped).toBeGreaterThan(0)
      expect(b.some(r => r.text().includes('◦ Run') || r.text().includes('◦ busy'))).toBe(false)
    }
  })
})

describe('focus: the cursor card is heavy, the cursor row bold and whole', () => {
  const tops = (m: HqModel, over: Partial<View>) => lines(m, { rows: 120, ...over }).filter(l => /^ [╭┏]/.test(l))

  test('heavy lines only on the card holding the cursor, and only while the pane is focused', () => {
    const on = tops(BUSY, { focused: true, cursor: 'a:a1' })
    expect(on.filter(l => l.startsWith(' ┏━'))).toEqual([on[0]!])
    expect(on[0]!.startsWith(' ┏━ this session ')).toBe(true)
    const pr = tops(BUSY, { focused: true, cursor: 'p:acmeco/webapp-ui#212' })
    expect(pr.filter(l => l.startsWith(' ┏━')).map(l => l.slice(4).split(' ')[0])).toEqual(['this'])
    const rows = layout(BUSY, view({ rows: 120, focused: true, cursor: 's:s-st-admin' })).rows
    const top = rows.find(r => r.text().startsWith(' ┏━ acme-store'))!
    // The card keeps its status colour: st-api waits on the person.
    expect(top.cells[1]!.s.c).toBe('wait')
    expect(lines(BUSY, { rows: 120, cursor: 'a:a1' }).some(l => /[┏┓┗┛┃]/.test(l))).toBe(false)
    expect(lines(BUSY, { rows: 120, focused: true, cursor: 'flare' }).some(l => /[┏┓┗┛┃]/.test(l))).toBe(false)
  })

  test('the cursor row alone takes the caret and bold; its card-mates keep their style', () => {
    const rows = layout(BUSY, view({ rows: 120, focused: true, cursor: 'a:a1' })).rows
    const marked = rows.filter(r => r.text().includes('▐'))
    expect(marked.length).toBe(1)
    expect(marked[0]!.text().includes('▐ ✢ Implement ledger refund reconcile')).toBe(true)
    // Every glyph on these rows is one cell, so a string index is a cell index.
    const titleOf = (r: Row, t: string) => r.cells[r.text().indexOf(t)]!.s
    expect(titleOf(marked[0]!, 'Implement')).toEqual({ bold: true, btn: 'a:a1' })
    // The agent glyph keeps its model's colour.
    expect(marked[0]!.cells[4]!.s.c).toBe('opus')
    const sibling = rows.find(r => r.text().includes('Run ledger specs and report') && r.head)!
    expect(titleOf(sibling, 'Run ledger').bold).toBe(undefined)
    const finished = rows.find(r => r.text().includes('Adversarial review'))!
    expect(titleOf(finished, 'Adversarial').dim).toBe(true)
  })

  test('the cursor moves between agents of one card: the card stays heavy, caret and bold follow', () => {
    for (const [cursor, title] of [
      ['a:a1', 'Implement ledger'],
      ['a:a2', 'Run ledger specs'],
      ['a:a3', 'Adversarial review'],
    ] as const) {
      const got = lines(BUSY, { rows: 120, focused: true, cursor })
      expect(got.filter(l => l.startsWith(' ┏━')).length).toBe(1)
      expect(got.find(l => l.startsWith(' ┏━'))!.includes('this session')).toBe(true)
      const caret = got.filter(l => l.includes('▐'))
      expect(caret.length).toBe(1)
      expect(caret[0]!.includes(title)).toBe(true)
    }
    // A finished agent under the cursor is drawn at full strength, not dim.
    const fin = layout(BUSY, view({ rows: 120, focused: true, cursor: 'a:a3' })).rows.find(r => r.text().includes('▐'))!
    expect(fin.buttons.find(b => b.key === 'a:a3')!.dim).toBe(undefined)
  })

  const LONG_TITLE = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')
  const longAgent: AgentVM = {
    id: 'big',
    title: LONG_TITLE,
    status: 'running',
    background: true,
    startedAt: BUSY.now - 60_000,
    toolCount: 1,
    files: [],
    now: 'working',
  }
  const BIG: HqModel = { ...QUIET, current: { ...QUIET.current, agents: [longAgent] } }

  test('the cursor row shows its whole text, wrapped under itself, at most three lines', () => {
    const rest = lines(BIG, { cursor: 'a:big' })
    const at0 = rest.findIndex(l => l.includes('word0'))
    expect(rest[at0]!.includes('…')).toBe(true)
    expect(rest[at0 + 1]!.includes('working')).toBe(true)

    const l = layout(BIG, view({ focused: true, cursor: 'a:big' }))
    const got = l.rows.map(r => r.text())
    const at = got.findIndex(t => t.includes('word0'))
    const wrapped = got.slice(at, at + 3)
    expect(wrapped[0]!.includes('▐ ✢ word0')).toBe(true)
    // Continuations sit at the title's column, inside the heavy card.
    for (const t of wrapped.slice(1)) expect(/^ ┃ {4}word\d+/.test(t)).toBe(true)
    expect(wrapped[2]!.endsWith('…  ┃')).toBe(true)
    expect(got[at + 3]!.includes('working')).toBe(true)
    // Every grown line belongs to the item; only the first is its head and holds its one Button.
    const grown = l.rows.slice(at, at + 4)
    expect(grown.every(r => r.item === 'a:big')).toBe(true)
    expect(grown.filter(r => r.head).length).toBe(1)
    expect(l.rows.flatMap(r => r.buttons).filter(b => b.key === 'a:big').length).toBe(1)
    // Items after it still map to their own first line.
    const pr = 'p:acme-store/admin-web#433'
    expect(l.rows[l.itemLine[pr]! + 2]!.text().includes('#433')).toBe(true)
    expect(got.filter(t => /[┏┃┗]/.test(t)).every(t => cellLen(t) === 79)).toBe(true)
  })

  test('a session and a PR under the cursor wrap the same way', () => {
    const name = 'a very long session name that keeps going well past the width of the card it sits in'
    const m: HqModel = {
      ...QUIET,
      others: [
        {
          tmuxSession: 'x',
          sessions: [{ sessionId: 'n', name, windowLabel: '', status: 'idle', jump: { kind: 'tmux', target: 'x:@1.%1' } }],
        },
      ],
    }
    const got = lines(m, { width: 60, focused: true, cursor: 's:n' })
    const at = got.findIndex(t => t.includes('▐ a very long'))
    expect(got[at + 1]!.startsWith(' ┃  ')).toBe(true)
    expect(got.join(' ').includes('the card it sits in')).toBe(true)
    const pr = lines(QUIET, { width: 48, focused: true, cursor: 'p:acme-store/admin-web#433' })
    const p = pr.findIndex(t => t.includes('#433'))
    expect(pr[p + 1]!.includes('trend deltas')).toBe(true)
  })
})

describe('this session stands apart', () => {
  test('its title is the accent, bold, with a dim · this session; a divider then the other cards', () => {
    const m: HqModel = { ...BUSY, current: { ...BUSY.current, title: 'claude-hq', goal: { text: 'Ship it' } } }
    const rows = layout(m, view()).rows
    const top = rows.findIndex(r => r.text().startsWith(' ╭─ claude-hq · this session ─'))
    expect(top).toBe(2 + 2)
    expect(rows[top]!.cells[4]!.s).toEqual({ c: 'accent', bold: true })
    expect(rows[top]!.cells[4 + 'claude-hq'.length + 1]!.s).toEqual({ dim: true })
    const bottom = rows.findIndex((r, i) => i > top && r.text().startsWith(' ╰'))
    expect(rows[bottom + 1]!.text()).toBe('')
    expect(rows[bottom + 2]!.text()).toBe(` ── other sessions ${'─'.repeat(60)}`)
    expect(rows[bottom + 2]!.cells[1]!.s).toEqual({ dim: true })
    expect(rows[bottom + 3]!.text()).toBe('')
    expect(rows[bottom + 4]!.text().startsWith(' ╭─ acme-store')).toBe(true)
    // No padding rows: the goal opens the card, its last line closes it.
    expect(rows[top + 1]!.text().startsWith(' │  Ship it')).toBe(true)
    expect(/^ │ +│$/.test(rows[bottom - 1]!.text())).toBe(false)
  })

  test('the suffix goes before the name is cut; the fallback title takes no suffix', () => {
    const m: HqModel = { ...BUSY, current: { ...BUSY.current, title: 'claude-hq-with-a-long-name', goal: { text: 'Ship it' } } }
    expect(lines(m, { width: 40 }).some(l => l.startsWith(' ╭─ claude-hq-with-a-long-name ─'))).toBe(true)
    expect(lines(m, { width: 80 }).some(l => l.startsWith(' ╭─ claude-hq-with-a-long-name · this session ─'))).toBe(true)
    expect(lines(BUSY).some(l => l.includes('this session · this session'))).toBe(false)
  })

  test('no other sessions, no divider', () => {
    const m: HqModel = { ...QUIET, others: [] }
    expect(lines(m, { rows: 90 }).some(l => l.includes('other sessions'))).toBe(false)
    expect(lines(QUIET, { rows: 90 }).some(l => l.includes('other sessions'))).toBe(true)
  })

  test('heavy box lines are one cell wide', () => {
    expect(cellLen('┏━┓┃┗┛')).toBe(6)
  })
})

describe("sections and another session's PRs", () => {
  const st = WITH_PRS.others[0]!.sessions[0]!
  const key = (n: number) =>
    sessionPrKey(
      st,
      OTHER_PRS.find(p => p.number === n)!,
    )
  const prLines = (got: string[]) => {
    const at = got.findIndex(l => l.startsWith(' │  st-api'))
    return got
      .slice(at)
      .filter(l => /^ [│┃]▐? *(#\d+|[+−] ?\d+ more)/.test(l))
      .slice(0, 5)
  }

  test('one line per open PR: number, title, status, most urgent first; merged left out', () => {
    const got = prLines(lines(WITH_PRS, { rows: 40 }))
    expect(got.slice(0, 4).map(l => l.slice(4, 8))).toEqual(['#527', '#528', '#531', '+1 m'])
    expect(got[0]!.includes('Refunds: partial refund')).toBe(true)
    expect(got[0]!.endsWith('✗ apps/api failed  │')).toBe(true)
    expect(got[1]!.endsWith('✗ conflicts  │')).toBe(true)
    expect(got[2]!.endsWith('ci running  │')).toBe(true)
    expect(lines(WITH_PRS, { rows: 40, expanded: [morePrsId(st)] }).some(l => l.includes('#520'))).toBe(false)
    const rows = layout(WITH_PRS, view({ rows: 40 })).rows
    const tokOf = (t: string) => {
      const r = rows.find(x => x.text().includes(t))!
      return r.cells[r.text().indexOf(t)]!.s.c
    }
    expect(tokOf('✗ apps/api failed')).toBe('fail')
    expect(tokOf('✗ conflicts')).toBe('fail')
    expect(tokOf('ci running')).toBe('run')
  })

  test('three rows, then a dim +N more PRs that toggles the rest like +N finished', () => {
    const closed = layout(WITH_PRS, view({ rows: 40, focused: true }))
    expect(closed.items.includes(morePrsKey(st))).toBe(true)
    expect(closed.actions[morePrsKey(st)]).toEqual({ kind: 'toggle', id: morePrsId(st) })
    const more = closed.rows.find(r => r.item === morePrsKey(st))!
    expect(more.text()).toBe(' │  +1 more PR                                                                │')
    expect(more.cells[4]!.s.dim).toBe(true)
    expect(closed.items.includes(key(530))).toBe(false)
    const open = prLines(lines(WITH_PRS, { rows: 40, expanded: [morePrsId(st)] }))
    expect(open.map(l => l.slice(4, 9))).toEqual(['#527 ', '#528 ', '#531 ', '#530 ', '− 1 m'])
  })

  test('pressing a PR row opens its URL; each row and the toggle is a cursor stop, dividers are not', () => {
    const l = layout(WITH_PRS, view({ rows: 40, focused: true }))
    const url = { kind: 'jump', jump: { kind: 'url', url: 'https://github.com/acme-store/api/pull/528' } }
    expect(l.actions[key(528)]).toEqual(url)
    const row = l.rows.find(r => r.head && r.item === key(528))!
    expect(row.buttons.map(b => [b.key, b.action])).toEqual([
      [key(528), url],
      [caretKey(key(528)), url],
    ])
    const at = l.items.indexOf('s:s-st-api')
    expect(l.items.slice(at, at + 5)).toEqual(['s:s-st-api', key(527), key(528), key(531), morePrsKey(st)])
    for (const r of l.rows.filter(x => /^ [├┣]/.test(x.text()))) {
      expect(r.item).toBe(undefined)
      expect(r.buttons).toEqual([])
    }
  })

  test('the cursor on a PR row: heavy card, accent ▐, bold title wrapped whole', () => {
    const l = layout(WITH_PRS, view({ rows: 40, focused: true, cursor: key(527) }))
    const got = l.rows.map(r => r.text())
    expect(got.some(t => t.startsWith(' ┏━ acme-store'))).toBe(true)
    const at = got.findIndex(t => t.startsWith(' ┃▐ #527'))
    expect(l.rows[at]!.cells[2]!.s.c).toBe('accent')
    expect(got[at]!.endsWith('✗ apps/api failed  ┃')).toBe(true)
    expect(got[at]!.includes('…')).toBe(false)
    expect(got[at + 1]).toBe(' ┃        split                                                               ┃')
    const title = l.rows[at]!.cells[got[at]!.indexOf('Refunds')]!.s
    expect(title.bold).toBe(true)
    expect(l.rows[at + 1]!.item).toBe(key(527))
  })

  test('a PR another session also shows keeps its own key per card', () => {
    const shared = OTHER_PRS[0]!
    const m: HqModel = { ...WITH_PRS, current: { ...WITH_PRS.current, prs: [shared] } }
    const l = layout(m, view({ rows: 40, focused: true }))
    expect(l.items.includes('p:acme-store/api#530')).toBe(true)
    expect(l.items.includes(key(530))).toBe(false)
  })

  test('the second line no longer counts open PRs; a session without PRs is drawn as before', () => {
    const plain = lines(WITH_PRS, { rows: 40 })
    const fin = plain.findIndex(t => t.startsWith(' ╭─ finance'))
    expect(plain.slice(fin, fin + 3)).toEqual([
      ' ╭─ finance ──────────────────────────────────────────────────────────────────╮',
      ' │  finance                                                          idle 2d  │',
      ' ╰────────────────────────────────────────────────────────────────────────────╯',
    ])
    expect(plain.some(t => /\d+ open\b/.test(t))).toBe(false)
  })

  test('a section is drawn only with rows; none at all leaves the plain card', () => {
    const bare: HqModel = { ...WITH_PRS, current: { ...WITH_PRS.current, agents: [], prs: [] } }
    const got = lines(bare, { rows: 40 })
    const top = got.findIndex(t => t.startsWith(' ╭─ this session'))
    expect(got.slice(top, top + 3)).toEqual([
      ' ╭─ this session ─────────────────────────────────────────────────────────────╮',
      ' │  nothing running                                                           │',
      ' ╰────────────────────────────────────────────────────────────────────────────╯',
    ])
    const agentsOnly = lines({ ...WITH_PRS, current: { ...WITH_PRS.current, prs: [] } }, { rows: 40 })
    expect(agentsOnly.filter(t => t.startsWith(' ├─ agents ')).length).toBe(1)
    expect(agentsOnly.filter(t => t.startsWith(' ├─ pull requests ')).length).toBe(2)
    const st2 = lines({ ...WITH_PRS, others: [{ tmuxSession: 'x', sessions: [{ ...st, prs: [] }] }] }, { rows: 40 })
    expect(st2.filter(t => t.startsWith(' ├─ pull requests ')).length).toBe(1)
  })

  test('T-junctions are one cell wide, light at rest and heavy on the cursor card, in the border colour', () => {
    expect(cellLen('├┤┣┫')).toBe(4)
    const rest = layout(WITH_PRS, view({ rows: 40 })).rows
    const div = rest.find(r => r.text().startsWith(' ├─ pull requests'))!
    expect(cellLen(div.text())).toBe(79)
    expect(div.text().endsWith('─┤')).toBe(true)
    expect(div.cells[1]!.s.c).toBe('fail')
    expect(div.cells[4]!.s).toEqual({ dim: true })
    const heavy = lines(WITH_PRS, { rows: 40, focused: true, cursor: key(528) })
    expect(heavy.some(t => t.startsWith(' ┣━ pull requests ━') && t.endsWith('━┫'))).toBe(true)
  })

  test('the border takes the worst of the session and its rows: a red PR alone turns it red', () => {
    const tone = (m: HqModel, title: string) =>
      layout(m, view({ rows: 40 })).rows.find(r => r.text().startsWith(` ╭─ ${title}`))!.cells[1]!.s.c
    const calm = { ...st, prSummary: undefined, status: 'idle' as const, prs: [OTHER_PRS[0]!] }
    const red = { ...calm, prs: [OTHER_PRS[2]!] }
    expect(tone({ ...WITH_PRS, others: [{ tmuxSession: 'x', sessions: [calm] }] }, 'x')).toBe('rule')
    expect(tone({ ...WITH_PRS, others: [{ tmuxSession: 'x', sessions: [red] }] }, 'x')).toBe('fail')
    const agentsOk = WITH_PRS.current.agents
    // Its agents still run, so the card is at work; nothing running leaves the quiet rule.
    expect(tone({ ...WITH_PRS, current: { ...WITH_PRS.current, agents: agentsOk, prs: [] } }, 'this session')).toBe('run')
    expect(tone({ ...WITH_PRS, current: { ...WITH_PRS.current, agents: [], prs: [] } }, 'this session')).toBe('rule')
    expect(tone(WITH_PRS, 'this session')).toBe('fail')
  })

  test('a busy card takes the working colour: this session running a turn, another session busy; broken and waiting still win', () => {
    const tone = (m: HqModel, title: string) =>
      layout(m, view({ rows: 40 })).rows.find(r => r.text().startsWith(` ╭─ ${title}`))!.cells[1]!.s.c
    const idle = { ...st, prSummary: undefined, status: 'idle' as const, prs: [], agents: undefined }
    const busy = { ...idle, status: 'busy' as const }
    const quiet: HqModel = { ...WITH_PRS, current: { ...WITH_PRS.current, agents: [], prs: [] } }
    const turn = { prompt: 'Ship it', since: WITH_PRS.now - 60_000, idle: false }
    expect(tone({ ...quiet, current: { ...quiet.current, now: { ...turn, idle: true } } }, 'this session')).toBe('rule')
    expect(tone({ ...quiet, current: { ...quiet.current, now: turn } }, 'this session')).toBe('run')
    const shell = { ...quiet.current, now: { ...turn, idle: true }, waiting: [{ text: 'pr-ci-wait 7', since: WITH_PRS.now - 60_000 }] }
    expect(tone({ ...quiet, current: shell }, 'this session')).toBe('run')
    expect(tone({ ...quiet, others: [{ tmuxSession: 'x', sessions: [idle] }] }, 'x')).toBe('rule')
    expect(tone({ ...quiet, others: [{ tmuxSession: 'x', sessions: [busy] }] }, 'x')).toBe('run')
    expect(
      tone({ ...quiet, others: [{ tmuxSession: 'x', sessions: [busy, { ...idle, sessionId: 'w', status: 'waiting' as const }] }] }, 'x'),
    ).toBe('wait')
    expect(tone({ ...quiet, others: [{ tmuxSession: 'x', sessions: [{ ...busy, prs: [OTHER_PRS[2]!] }] }] }, 'x')).toBe('fail')
  })
})

describe('agent kinds: main loop, subagents, background shells', () => {
  test('glyph colours: each agent in its model colour, the shell dim, the main loop pulsing while it works', () => {
    const glyphs = (phase: number) =>
      layout(KINDS, view({ rows: 30, width: 72, phase }))
        .rows.flatMap(r => r.segs())
        .filter(x => ['✻', '✢', '$'].includes(x.t))
        .map(x => `${x.t}=${x.s.c ?? ''}${x.s.dim ? ' dim' : ''}`)
    expect(glyphs(0)).toEqual(['✻=fable', '$= dim', '✢=opus', '✢=sonnet', '✻=fable', '✢=opus'])
    expect(glyphs(1)).toEqual(['✻=fable dim', '$= dim', '✢=opus dim', '✢=sonnet dim', '✻=fable dim', '✢=opus dim'])
  })

  test('an unknown or missing model takes the working colour; facts narrow from tokens to model to time', () => {
    const agent = (model?: string): AgentVM => ({
      id: 'u',
      title: 'Find callers',
      status: 'running',
      background: true,
      startedAt: KINDS.now - 60_000,
      toolCount: 0,
      files: [],
      tokens: 48_200,
      ...(model ? { model } : {}),
    })
    const m = (a: AgentVM): HqModel => ({ ...KINDS, current: { ...KINDS.current, agents: [a] }, others: [] })
    const head = (a: AgentVM, width = 72) => layout(m(a), view({ width })).rows.find(r => r.text().includes('Find callers'))!
    expect(
      head(agent('gpt-x'))
        .segs()
        .find(x => x.t === '✢')!.s.c,
    ).toBe('run')
    expect(head(agent()).text().endsWith('48k · 1m 0s  │')).toBe(true)
    expect(head(agent('claude-haiku-4-5')).text().endsWith('haiku · 48k · 1m 0s  │')).toBe(true)
    expect(head(agent('claude-haiku-4-5'), 38).text().endsWith('haiku · 1m 0s  │')).toBe(true)
    expect(head(agent('claude-haiku-4-5'), 30).text().endsWith('1m 0s  │')).toBe(true)
  })

  test('token counts read compact', () => {
    expect([850, 8_400, 10_000, 48_200, 999_400, 1_000_000, 1_250_000].map(compactTokens)).toEqual([
      '850',
      '8.4k',
      '10k',
      '48k',
      '999k',
      '1M',
      '1.3M',
    ])
  })
})
