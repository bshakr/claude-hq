import type { RenderNode } from 'claude-code'

import type { WaveRow } from '../../types'
import { agoText } from '../logic'
import { TOKENS, cellLen, clip, grid, heightOf, kindOf, skylineStatus } from './d3'
import type { Kind, Token } from './d3'
import type { PaneCtx, PaneStyle } from './types'

export { TOKENS } from './d3'

/** One styled run of cells. `href` makes it a Link (OSC 8 on the terminal). */
export type Seg = { t: string; color?: Token; dim?: true; bold?: true; href?: string }
/** A Link holding several styled runs (a tree row's `#n  title`). */
export type Group = { href: string; segs: Seg[] }
export type Part = Seg | Group
export type Line = Part[]

const BLOCKS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const
const CHART_ROWS = 4
const INSET = 2
const FACT_W = 14
const MIN_WIDTH = 48
const FOOTER = 'gh every 60s · 0 model tokens'

const isProblem = (kind: Kind) => kind === 'red' || kind === 'conflict' || kind === 'rebase' || kind === 'unknown'

function barToken(kind: Kind): Token | undefined {
  if (kind === 'red' || kind === 'conflict') return 'fail'
  if (kind === 'rebase' || kind === 'unknown') return 'warn'
  if (kind === 'running') return 'run'
  return undefined
}

export const isGroup = (part: Part): part is Group => 'segs' in part
export const textOfPart = (part: Part) => (isGroup(part) ? part.segs.map(s => s.t).join('') : part.t)

type Cell = { ch: string; color?: Token; dim?: true; href?: string }

/** Neighbouring cells of one style and one link merge into a run; trailing blanks are dropped. */
function runs(cells: readonly Cell[]): Line {
  let end = cells.length
  while (end > 0 && cells[end - 1]?.ch === ' ') end--
  const out: Seg[] = []
  for (const cell of cells.slice(0, end)) {
    const plain = cell.ch === ' '
    const color = plain ? undefined : cell.color
    const dim = plain ? undefined : cell.dim
    const href = plain ? undefined : cell.href
    const last = out[out.length - 1]
    if (last && last.color === color && last.dim === dim && last.href === href) {
      last.t += cell.ch
    } else {
      const seg: Seg = { t: cell.ch }
      if (color) seg.color = color
      if (dim) seg.dim = dim
      if (href) seg.href = href
      out.push(seg)
    }
  }
  return out
}

function headerParts(ctx: PaneCtx, open: number): { left: string; when: string; wake: Seg } {
  const { polledAt, error } = ctx
  const ago = agoText(polledAt, Math.max(ctx.now, polledAt ?? 0))
  const left = polledAt === null && ctx.rows.length === 0 ? 'wave' : `${open} open`
  const when =
    polledAt === null
      ? error !== null ? 'first poll failed' : 'first poll running'
      : error !== null ? ago.replace(/^polled /, 'last good poll ') : ago
  const wake: Seg = ctx.isWaking ? { t: 'wake on' } : { t: 'wake off', dim: true }
  return { left, when, wake }
}

function headerLine(ctx: PaneCtx, open: number): Line {
  const { left, when, wake } = headerParts(ctx, open)
  const space = Math.max(1, ctx.width - cellLen(left) - cellLen(`${when} · ${wake.t}`))
  return [{ t: left + ' '.repeat(space) }, { t: `${when} ·`, dim: true }, { t: ' ' }, wake]
}

/** D3's skyline, bars in the data layer's order; each bar and its `#n` label link to the PR. */
function chartLines(ctx: PaneCtx): Line[] {
  const { rows, width } = ctx
  const n = rows.length
  const { bw, gap } = grid(n, width)
  const lastCell = width - INSET - 1
  const band: Cell[][] = Array.from({ length: CHART_ROWS }, () => [])
  const base: Cell[] = []
  for (let x = INSET; x <= lastCell; x++) base[x] = { ch: ctx.polledAt === null ? '╌' : '─', color: 'rule' }
  const labels: Cell[] = []
  let labelEnd = 0

  rows.forEach((row, i) => {
    const x0 = INSET + i * (bw + gap)
    if (x0 + bw - 1 > lastCell) return
    const kind = kindOf(row)
    const h = heightOf(row)
    const color = barToken(kind)
    const dim = kind === 'calm' ? true : undefined
    const href = row.url
    for (let dx = 0; dx < bw; dx++) {
      for (let r = 0; r < CHART_ROWS; r++) {
        const fill = Math.max(0, Math.min(8, h - r * 8))
        if (fill > 0) band[r]![x0 + dx] = { ch: BLOCKS[fill]!, color, dim, href }
      }
      if (kind === 'merged') base[x0 + dx] = { ch: '╌', color: 'rule' }
    }
    // The travelling bump: one cell an eighth taller, phase = tick mod bw. A presence signal, not progress.
    if (kind === 'running') {
      const r = Math.floor(h / 8)
      if (r < CHART_ROWS) band[r]![x0 + (ctx.tick % bw)] = { ch: BLOCKS[(h % 8) + 1]!, color, href }
    }
    const label = `#${row.number}`
    if (label.length <= bw + gap - 1 || isProblem(kind)) {
      const at = x0 + Math.max(0, Math.floor((bw - label.length) / 2))
      if (at >= labelEnd && at + label.length <= width) {
        for (const [k, ch] of [...label].entries()) labels[at + k] = { ch, dim: true, href }
        labelEnd = at + label.length + 1
      }
    }
  })

  const dense = (cells: Cell[]) => Array.from(cells, cell => cell ?? { ch: ' ' })
  return [...band.reverse().map(r => runs(dense(r))), runs(dense(base)), runs(dense(labels))]
}

// D4's ordering: needs-you before running before calm, merged last within a repo.
const SEVERITY: Record<Kind, number> = { red: 0, conflict: 1, rebase: 1, unknown: 2, running: 3, calm: 4, merged: 6 }
const severity = (row: WaveRow) => SEVERITY[kindOf(row)] + (kindOf(row) === 'calm' && row.ci.kind !== 'green' ? 1 : 0)

export type RepoGroup = { repo: string; rows: WaveRow[] }

/** Repos by worst row, then more rows, then data order; rows by severity, stable. */
export function groupByRepo(rows: readonly WaveRow[]): RepoGroup[] {
  const groups = new Map<string, WaveRow[]>()
  for (const row of rows) {
    const list = groups.get(row.repo)
    if (list) list.push(row)
    else groups.set(row.repo, [row])
  }
  return [...groups.entries()]
    .map(([repo, list], i) => {
      const sorted = list.map((row, j) => ({ row, j })).sort((a, b) => severity(a.row) - severity(b.row) || a.j - b.j)
      return { group: { repo, rows: sorted.map(one => one.row) }, i }
    })
    .sort(
      (a, b) =>
        Math.min(...a.group.rows.map(severity)) - Math.min(...b.group.rows.map(severity)) ||
        b.group.rows.length - a.group.rows.length ||
        a.i - b.i,
    )
    .map(one => one.group)
}

function factOf(row: WaveRow, kind: Kind, now: number): Seg {
  switch (kind) {
    case 'red':
      return { t: `✗ ${clip(row.ci.kind === 'red' ? row.ci.failing : '', FACT_W - 2)}`, color: 'fail' }
    case 'conflict':
      return { t: '✗ conflict', color: 'fail' }
    case 'rebase':
      return { t: '↑ rebase', color: 'warn' }
    case 'unknown':
      return { t: '· unknown', color: 'warn' }
    case 'running':
      return { t: row.ci.kind === 'running' ? `↻ ${row.ci.done}/${row.ci.total}` : '↻', color: 'run' }
    case 'merged': {
      if (row.mergedAt === null) return { t: 'merged', dim: true }
      const full = agoText(row.mergedAt, Math.max(now, row.mergedAt)).replace(/^polled /, 'merged ')
      return { t: full.length <= FACT_W ? full : full.replace(/ ago$/, ''), dim: true }
    }
    case 'calm':
      if (row.ci.kind !== 'green') return { t: '· no checks', dim: true }
      if (row.gallery === 'linked') return { t: '✓ gallery' }
      if (row.gallery === 'no visual change') return { t: '✓ no visual' }
      return { t: '· no gallery', dim: true }
  }
}

function headingLine(repo: string, width: number): Line {
  const name = clip(repo, width - 5)
  return [{ t: `   ${name} ` }, { t: '┄'.repeat(Math.max(0, width - 4 - cellLen(name))), color: 'rule' }]
}

function rowLine(row: WaveRow, tree: string, refW: number, ctx: PaneCtx): Line {
  const kind = kindOf(row)
  const isStale = ctx.error !== null
  const token = barToken(kind)
  const gutter: Seg = isProblem(kind) ? { t: '██', color: token } : kind === 'running' ? { t: '░░', color: token } : { t: '  ' }
  const ref: Seg = { t: `#${row.number}` }
  if (isStale) ref.dim = true
  else if (isProblem(kind)) ref.bold = true
  const titleW = Math.max(0, ctx.width - 6 - refW - 2 - 2 - FACT_W)
  const title = clip(`${row.isDraft ? '◇ ' : ''}${row.title}`, titleW)
  const fact = factOf(row, kind, ctx.now)
  if (isStale && fact.color === undefined) fact.dim = true
  const link: Group = { href: row.url, segs: [ref, { t: ' '.repeat(refW - cellLen(ref.t) + 2) }, { t: title, dim: true }] }
  return [
    gutter,
    { t: ' ' },
    { t: tree, color: 'rule' },
    { t: ' ' },
    link,
    { t: ' '.repeat(Math.max(0, titleW - cellLen(title)) + 2) },
    fact,
  ]
}

function treeLines(ctx: PaneCtx): Line[] {
  const refW = Math.max(...ctx.rows.map(row => `#${row.number}`.length))
  const out: Line[] = []
  groupByRepo(ctx.rows).forEach((group, g) => {
    if (g > 0) out.push([])
    out.push(headingLine(group.repo, ctx.width))
    group.rows.forEach((row, i) => out.push(rowLine(row, i === group.rows.length - 1 ? '└─' : '├─', refW, ctx)))
  })
  return out
}

/** The pane as styled lines, before elements: pure, so tests read cells directly. */
export function paperSkylineLines(ctx: PaneCtx): Line[] {
  const open = ctx.rows.filter(row => row.status === 'open').length
  const errorLine: Line[] =
    ctx.error === null ? [] : [[{ t: clip(`× ${ctx.error.split('\n')[0] ?? ''}`, ctx.width), color: 'warn' }]]

  if (ctx.width < MIN_WIDTH) {
    const { left, when, wake } = headerParts(ctx, open)
    return [[{ t: clip(`${left} · ${when} · ${wake.t}`, ctx.width) }], ...errorLine]
  }

  const lines: Line[] = [headerLine(ctx, open), ...errorLine, [], ...chartLines(ctx)]
  if (ctx.rows.length > 0) {
    lines.push([], ...treeLines(ctx))
  } else {
    const message = ctx.polledAt === null ? 'Listening for the first poll…' : 'No open PRs. The horizon is clear.'
    lines.push([{ t: `  ${message}`, dim: true }])
  }

  const fill = ctx.bodyRows - lines.length - 1
  for (let i = 0; i < Math.max(1, fill); i++) lines.push([])
  lines.push([{ t: FOOTER, dim: true }])
  return lines
}

function render(ctx: PaneCtx) {
  const { Box, Text, Link } = ctx.el
  const styled = (s: Seg): RenderNode => {
    if (s.color === undefined && !s.dim && !s.bold) return s.t
    const props: { color?: string; dimColor?: boolean; bold?: boolean } = {}
    if (s.color !== undefined) props.color = TOKENS[s.color]
    else if (s.dim) props.dimColor = true
    if (s.bold) props.bold = true
    return <Text {...props}>{s.t}</Text>
  }
  const part = (p: Part): RenderNode => {
    if (isGroup(p)) return <Link href={p.href}>{p.segs.map(styled)}</Link>
    return p.href === undefined ? styled(p) : <Link href={p.href}>{styled(p)}</Link>
  }
  return (
    <Box flexDirection="column">
      {paperSkylineLines(ctx).map(line =>
        line.length === 0 ? <Text> </Text> : <Text wrap="truncate">{line.map(part)}</Text>,
      )}
    </Box>
  )
}

export const style: PaneStyle = {
  meta: {
    id: 'd5',
    name: 'Skyline Paper',
    tagline: 'The skyline on top, PRs grouped by repo below; every PR links to GitHub',
    animated: true,
  },
  render,
  status: ({ rows, error, polledAt, now }) => skylineStatus(rows, error, polledAt, now),
}
