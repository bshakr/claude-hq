import type { RenderNode } from 'claude-code'

import type { WaveRow } from '../../types'
import { agoText } from '../logic'
import type { PaneCtx, PaneStyle } from './types'

// The only way colour enters this style. The engine's plugin-tree validator
// refuses `ansi:<name>` (no colon allowed) and bare names resolve to no colour,
// so palette slots 0-15 go through ansi256(n), which the terminal maps to its
// own theme. `ok` (green) is deliberately absent: in Ledger green is the absence of colour.
export const TOKENS = {
  fail: 'ansi256(1)',
  warn: 'ansi256(3)',
  run: 'ansi256(4)',
  merged: 'ansi256(5)',
  rule: 'ansi256(8)',
} as const

type Token = keyof typeof TOKENS
type Tone = Token | 'plain' | 'dim' | 'bold'
type Run = { text: string; tone: Tone }
type Line = Run[]

const GL_MIN_WIDTH = 66
const COMPACT_BELOW = 48
const TITLE_FLOOR = 12
const PR_MIN = 14
const CI_NARROW = 9
const CI_WIDE = 12
const MERGE = 7
const GL = 3
const FOOTER = 'gh every 60s · 0 model tokens'

// Cell width of one code point. Titles are user text, so wide and zero-width
// characters must be measured, not counted as UTF-16 units.
function cpWidth(cp: number): number {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0x200d
  ) {
    return 0
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f000 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2
  }
  return 1
}

export function cells(text: string): number {
  let n = 0
  for (const ch of text) n += cpWidth(ch.codePointAt(0) ?? 0)
  return n
}

/** Wide glyphs become `·` and control/zero-width ones vanish, so every cell is width 1. */
function clean(text: string): string {
  let out = ''
  for (const ch of text.replace(/[\t\n\r]+/g, ' ')) {
    const w = cpWidth(ch.codePointAt(0) ?? 0)
    if (w === 1) out += ch
    else if (w === 2) out += '·'
  }
  return out
}

/** At most `max` cells; a cut ends in a single `…`. */
function clip(text: string, max: number): string {
  if (max <= 0) return ''
  if (cells(text) <= max) return text
  let out = ''
  let used = 0
  for (const ch of text) {
    const w = cpWidth(ch.codePointAt(0) ?? 0)
    if (used + w > max - 1) break
    out += ch
    used += w
  }
  return `${out}…`
}

function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - cells(text)))
}

function fit(text: string, width: number): string {
  return pad(clip(text, width), width)
}

function lineCells(line: Line): number {
  return line.reduce((n, run) => n + cells(run.text), 0)
}

/** Safety net: a line never exceeds the body width. */
function clipLine(line: Line, max: number): Line {
  if (lineCells(line) <= max) return line
  const out: Line = []
  let left = max
  for (const run of line) {
    const w = cells(run.text)
    if (w < left) {
      out.push(run)
      left -= w
      continue
    }
    out.push({ text: clip(run.text, left), tone: run.tone })
    if (w > left) break
    left = 0
  }
  return out.filter(run => run.text !== '')
}

const span = (text: string, tone: Tone = 'plain'): Run => ({ text, tone })

function ago(from: number | null, now: number): string {
  return agoText(from, Math.max(now, from ?? 0)).replace(/^polled /, '')
}

function displayRepos(rows: readonly WaveRow[]): Map<string, string> {
  const owners = new Map<string, Set<string>>()
  for (const row of rows) {
    const name = row.repo.split('/').pop() ?? row.repo
    owners.set(name, (owners.get(name) ?? new Set()).add(row.repo))
  }
  const shown = new Map<string, string>()
  for (const row of rows) {
    const name = row.repo.split('/').pop() ?? row.repo
    shown.set(row.repo, (owners.get(name)?.size ?? 0) > 1 ? row.repo : name)
  }
  return shown
}

type Severity = 'fail' | 'warn' | 'run' | 'merged' | 'calm'

function severity(row: WaveRow): Severity {
  if (row.status === 'merged') return 'merged'
  if (row.ci.kind === 'red' || row.merge === 'conflicting') return 'fail'
  if (row.merge === 'needs rebase' || row.merge === 'unknown') return 'warn'
  if (row.ci.kind === 'running') return 'run'
  return 'calm'
}

function header(ctx: PaneCtx, open: number, width: number, isCompact: boolean): Line {
  const left: Line = [span('Wave', 'bold')]
  if (ctx.polledAt !== null && !isCompact) left.push(span(`  ${open} open`))
  const when =
    ctx.polledAt === null
      ? ctx.error === null
        ? 'first poll running'
        : 'no good poll yet'
      : ctx.error === null
        ? `polled ${ago(ctx.polledAt, ctx.now)}`
        : `last good poll ${ago(ctx.polledAt, ctx.now)}`
  const wake = ctx.isWaking ? span('wake on') : span('wake off', 'dim')
  // Right side is right-aligned so a count change never moves it.
  const candidates: Line[] = [[span(when, 'dim'), span(' · ', 'dim'), wake], [wake]]
  for (const right of candidates) {
    for (const head of [left, left.slice(0, 1)]) {
      const gap = width - lineCells(head) - lineCells(right)
      if (gap >= 1) return [...head, span(' '.repeat(gap)), ...right]
    }
  }
  return clipLine(left.slice(0, 1), width)
}

function errorLine(error: string, width: number): Line {
  return clipLine([span('× '), span(clean(error), 'warn')], width)
}

function emptyText(ctx: PaneCtx): string {
  if (ctx.polledAt === null) {
    return ctx.error === null ? 'Asking GitHub for your open PRs…' : 'No answer from GitHub yet; retrying every 60s.'
  }
  return ctx.error === null ? 'No open PRs. Nothing merged in the last 30 min.' : 'No open PRs at the last good poll.'
}

type Grid = { pr: number; title: number; ci: number; hasGl: boolean }

function grid(rows: readonly WaveRow[], refs: readonly string[], width: number): Grid {
  const hasGl = width >= GL_MIN_WIDTH
  const pr = Math.max(PR_MIN, ...refs.map(cells))
  const isCiWide = rows.some(row => row.status === 'open' && row.ci.kind === 'red' && cells(clean(row.ci.failing)) > 7)
  const ci = isCiWide ? CI_WIDE : CI_NARROW
  const title = width - (2 + pr + 1 + 2 + ci + 1 + MERGE + (hasGl ? GL : 0))
  return { pr, title, ci, hasGl }
}

function columnHeader(g: Grid): Line {
  const merge = g.hasGl ? pad('merge', MERGE) + 'gl'.padStart(GL) : 'merge'
  return [span(`  ${pad('pr', g.pr + 1)}${pad('title', g.title)}  ${pad('ci', g.ci + 1)}${merge}`, 'dim')]
}

function ciCell(row: WaveRow, g: Grid): Run {
  switch (row.ci.kind) {
    case 'red':
      return span(`✗ ${clip(clean(row.ci.failing), g.ci - 2)}`, 'fail')
    case 'running':
      return span(clip(`↻ ${row.ci.done}/${row.ci.total}`, g.ci), 'run')
    case 'green':
      return span('✓', 'dim')
    case 'none':
      return span('·', 'dim')
  }
}

function mergeCell(row: WaveRow): Run {
  switch (row.merge) {
    case 'mergeable':
      return span('✓', 'dim')
    case 'needs rebase':
      return span('rebase', 'warn')
    case 'conflicting':
      return span('clash', 'fail')
    case 'unknown':
      return span('?', 'warn')
  }
}

const STATE_GLYPH: Record<Severity, Run> = {
  fail: span('●', 'fail'),
  warn: span('●', 'warn'),
  run: span('◦', 'run'),
  merged: span('●', 'merged'),
  calm: span('·', 'dim'),
}

function rowLine(row: WaveRow, ref: string, g: Grid, ctx: PaneCtx): Line {
  const sev = severity(row)
  const isMerged = row.status === 'merged'
  const isQuiet = isMerged || ctx.error !== null
  const title = (row.isDraft && !isMerged ? '◇ ' : '') + clean(row.title)
  const line: Line = [
    STATE_GLYPH[sev],
    span(' '),
    span(ref, sev === 'fail' || sev === 'warn' ? 'bold' : 'plain'),
    span(' '.repeat(g.pr + 1 - cells(ref))),
    span(fit(title, g.title), isQuiet ? 'dim' : 'plain'),
    span('  '),
  ]
  if (isMerged) {
    const text = `merged ${ago(row.mergedAt, ctx.now)}`
    const across = g.ci + 1 + MERGE
    line.push(span(g.hasGl ? fit(text, across) : clip(text, across), 'dim'))
  } else {
    const ci = ciCell(row, g)
    line.push(ci, span(' '.repeat(g.ci + 1 - cells(ci.text))))
    const merge = mergeCell(row)
    line.push(merge)
    if (g.hasGl) line.push(span(' '.repeat(MERGE - cells(merge.text))))
  }
  if (g.hasGl) {
    const glyph = row.gallery === 'linked' ? '◆' : row.gallery === 'no visual change' ? '≡' : '·'
    line.push(span(' '.repeat(GL - 1)), span(glyph, glyph === '·' || isQuiet ? 'dim' : 'plain'))
  }
  return line
}

function summary(rows: readonly WaveRow[]): Line {
  const open = rows.filter(row => row.status === 'open')
  const line: Line = [span(`${open.length} open`)]
  const facts: [number, string, Token][] = [
    [open.filter(row => row.ci.kind === 'red').length, 'red', 'fail'],
    [open.filter(row => row.merge === 'conflicting').length, 'clash', 'fail'],
    [open.filter(row => row.merge === 'needs rebase').length, 'rebase', 'warn'],
    [open.filter(row => row.ci.kind === 'running').length, 'running', 'run'],
  ]
  for (const [n, label, tone] of facts) {
    if (n > 0) line.push(span(' · ', 'dim'), span(`${n} ${label}`, tone))
  }
  return line
}

function bodyLines(ctx: PaneCtx, width: number): { lines: Line[]; hasFooter: boolean } {
  const rows = ctx.rows
  const open = rows.filter(row => row.status === 'open').length
  const names = displayRepos(rows)
  const refs = rows.map(row => `${names.get(row.repo) ?? row.repo}#${row.number}`)
  const g = grid(rows, refs, width)
  const isCompact = width < COMPACT_BELOW || g.title < TITLE_FLOOR

  const lines: Line[] = [header(ctx, open, width, isCompact)]
  if (ctx.error !== null) lines.push(errorLine(ctx.error, width))
  if (isCompact) {
    lines.push(rows.length === 0 ? [span(emptyText(ctx), 'dim')] : summary(rows))
    return { lines, hasFooter: false }
  }
  lines.push([span('─'.repeat(width), 'rule')])
  if (rows.length === 0) {
    lines.push([span(`  ${emptyText(ctx)}`, 'dim')])
  } else {
    lines.push(columnHeader(g))
    rows.forEach((row, i) => lines.push(rowLine(row, refs[i] ?? '', g, ctx)))
  }
  return { lines, hasFooter: true }
}

function render(ctx: PaneCtx) {
  const { Box, Text } = ctx.el
  const width = Math.max(1, Math.floor(ctx.width))

  const node = (run: Run): RenderNode => {
    if (run.tone === 'plain') return run.text
    if (run.tone === 'dim') return <Text dimColor>{run.text}</Text>
    if (run.tone === 'bold') return <Text bold>{run.text}</Text>
    return <Text color={TOKENS[run.tone]}>{run.text}</Text>
  }
  const draw = (line: Line) => <Text wrap="truncate">{clipLine(line, width).map(node)}</Text>

  const { lines, hasFooter } = bodyLines(ctx, width)
  return (
    <Box flexDirection="column" minHeight={Math.max(1, ctx.bodyRows)} justifyContent="space-between">
      <Box flexDirection="column">{lines.map(draw)}</Box>
      {hasFooter && draw([span(FOOTER, 'dim')])}
    </Box>
  )
}

/** The sheet's status line. */
export function statusText(rows: readonly WaveRow[], error: string | null, polledAt: number | null, now: number): string {
  const MAX = 47
  if (error !== null) return polledAt === null ? 'wave · gh unreachable' : `wave · gh unreachable ${ago(polledAt, now).replace(/ ago$/, '')}`
  const open = rows.filter(row => row.status === 'open')
  if (open.length === 0) return 'wave 0'
  const red = open.filter(row => row.ci.kind === 'red')
  const first = red[0]
  const name = first?.ci.kind === 'red' ? clean(first.ci.failing).replace(/·/g, '') : ''
  const rest: string[] = []
  const count = (n: number, label: string) => {
    if (n > 0) rest.push(`${n} ${label}`)
  }
  count(open.filter(row => row.merge === 'conflicting').length, 'conflict')
  count(open.filter(row => row.merge === 'needs rebase').length, 'rebase')
  count(open.filter(row => row.ci.kind === 'running').length, 'running')
  const isAllGreen = open.every(row => row.ci.kind === 'green' && row.merge === 'mergeable')
  const build = (checkName: string) => {
    const parts = [`wave ${open.length}`]
    if (red.length > 0) parts.push(checkName === '' ? `${red.length} red` : `${red.length} red ${checkName}`)
    parts.push(...rest)
    if (isAllGreen) parts.push('all green')
    return parts.join(' · ')
  }
  const full = build(name)
  if (full.length <= MAX) return full
  // Cut the check name first (no ellipsis: the status line allows only `·`).
  const room = name.length - (full.length - MAX)
  const cut = build(room >= 3 ? name.slice(0, room) : '')
  return cut.length <= MAX ? cut : cut.slice(0, MAX).trimEnd()
}

export const style: PaneStyle = {
  meta: {
    id: 'd1',
    name: 'Ledger',
    tagline: 'One row per PR, facts in fixed columns, colour only in the cell that is wrong',
  },
  render,
  status: ({ rows, error, polledAt, now }) => statusText(rows, error, polledAt, now),
}
