import type { WaveRow } from '../../types'
import { agoText } from '../logic'
import type { PaneCtx, PaneStyle } from './types'

/**
 * The only way colour enters this style. Palette indexes 0-15 are the terminal's own ANSI colours
 * (Catppuccin here). `ansi:red` would be the same colour, but the 2.1.293 element validator refuses
 * any `:` in a colour, so it closes the pane. `ok` is absent on purpose: green never takes colour.
 */
export const TOKENS = {
  fail: 'ansi256(1)',
  warn: 'ansi256(3)',
  run: 'ansi256(4)',
  merged: 'ansi256(5)',
  rule: 'ansi256(8)',
} as const
export type Token = keyof typeof TOKENS

/** One styled run of cells; a line is a list of runs drawn left to right. */
export type Seg = { t: string; color?: Token; dim?: true; bold?: true }
export type Line = Seg[]

const BLOCKS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const
const CHART_ROWS = 4
const INSET = 2
const FACT_W = 14
const MIN_REF = 13
const MIN_WIDTH = 48
const FOOTER = 'gh every 60s · 0 model tokens'

export type Kind = 'red' | 'conflict' | 'rebase' | 'unknown' | 'running' | 'calm' | 'merged'

export function kindOf(row: WaveRow): Kind {
  if (row.status === 'merged') return 'merged'
  if (row.ci.kind === 'red') return 'red'
  if (row.merge === 'conflicting') return 'conflict'
  if (row.merge === 'needs rebase') return 'rebase'
  if (row.merge === 'unknown') return 'unknown'
  if (row.ci.kind === 'running') return 'running'
  return 'calm'
}

const isProblem = (kind: Kind) => kind === 'red' || kind === 'conflict' || kind === 'rebase' || kind === 'unknown'

/** Bar height in eighths of the 4-row band. Running caps at 16 so it never reads as a problem tower. */
export function heightOf(row: WaveRow): number {
  const kind = kindOf(row)
  if (kind === 'red' || kind === 'conflict') return 32
  if (kind === 'rebase' || kind === 'unknown') return 24
  if (kind === 'merged') return 0
  if (kind === 'running' && row.ci.kind === 'running') {
    return Math.max(1, Math.min(16, Math.round((row.ci.done / row.ci.total) * 16)))
  }
  return 1
}

function barToken(kind: Kind): Token | undefined {
  if (kind === 'red' || kind === 'conflict') return 'fail'
  if (kind === 'rebase' || kind === 'unknown') return 'warn'
  if (kind === 'running') return 'run'
  return undefined
}

// Terminal cell width: wide East Asian and emoji count 2 (an over-estimate is safe: lines only get shorter).
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{1F000}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u
const ZERO = /[​-‏̀-ͯ︀-️]/u

export function cellLen(text: string): number {
  let n = 0
  for (const ch of text) n += ZERO.test(ch) ? 0 : WIDE.test(ch) ? 2 : 1
  return n
}

/** Cut to at most `max` cells, ending in a single `…` when cut. */
export function clip(text: string, max: number): string {
  if (max <= 0) return ''
  if (cellLen(text) <= max) return text
  let out = ''
  let used = 0
  for (const ch of text) {
    const w = ZERO.test(ch) ? 0 : WIDE.test(ch) ? 2 : 1
    if (used + w > max - 1) break
    out += ch
    used += w
  }
  return `${out}…`
}

const padEnd = (text: string, n: number) => text + ' '.repeat(Math.max(0, n - cellLen(text)))

/** `bw` and `gap` per the sheet's grid: gap 3 up to 8 bars, then 1, then 0 when 1 will not fit. */
export function grid(n: number, width: number): { bw: number; gap: number } {
  const avail = width - 2 * INSET
  const gap = n <= 8 ? 3 : n * 2 - 1 > avail ? 0 : 1
  const bw = Math.max(1, Math.min(8, Math.floor((avail - gap * (n - 1)) / Math.max(1, n))))
  return { bw, gap }
}

type Cell = { ch: string; color?: Token; dim?: true }

/** Merge neighbouring cells of one style into runs; trailing blanks are dropped. */
function runs(cells: readonly Cell[]): Line {
  let end = cells.length
  while (end > 0 && cells[end - 1]?.ch === ' ') end--
  const out: Line = []
  for (const cell of cells.slice(0, end)) {
    const plain = cell.ch === ' '
    const color = plain ? undefined : cell.color
    const dim = plain ? undefined : cell.dim
    const last = out[out.length - 1]
    if (last && last.color === color && last.dim === dim) {
      last.t += cell.ch
    } else {
      const seg: Seg = { t: cell.ch }
      if (color) seg.color = color
      if (dim) seg.dim = dim
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

function chartLines(ctx: PaneCtx): Line[] {
  const { rows, width } = ctx
  const n = rows.length
  const { bw, gap } = grid(n, width)
  const lastCell = width - INSET - 1
  const band: Cell[][] = Array.from({ length: CHART_ROWS }, () => [])
  const base: Cell[] = []
  for (let x = INSET; x <= lastCell; x++) base[x] = { ch: ctx.polledAt === null ? '╌' : '─', color: 'rule' }
  const numerals: Cell[] = []
  let numeralEnd = 0

  rows.forEach((row, i) => {
    const x0 = INSET + i * (bw + gap)
    if (x0 + bw - 1 > lastCell) return
    const kind = kindOf(row)
    const h = heightOf(row)
    const color = barToken(kind)
    const dim = kind === 'calm' ? true : undefined
    for (let dx = 0; dx < bw; dx++) {
      for (let r = 0; r < CHART_ROWS; r++) {
        const fill = Math.max(0, Math.min(8, h - r * 8))
        if (fill > 0) band[r]![x0 + dx] = { ch: BLOCKS[fill]!, color, dim }
      }
      if (kind === 'merged') base[x0 + dx] = { ch: '╌', color: 'rule' }
    }
    // The travelling bump: one cell an eighth taller, phase = tick mod bw. A presence signal, not progress.
    if (kind === 'running') {
      const r = Math.floor(h / 8)
      if (r < CHART_ROWS) band[r]![x0 + (ctx.tick % bw)] = { ch: BLOCKS[(h % 8) + 1]!, color }
    }
    if (n <= 9 || isProblem(kind)) {
      const label = String(i + 1)
      const at = x0 + Math.floor((bw - 1) / 2)
      if (at >= numeralEnd && at + label.length <= width) {
        ;[...label].forEach((ch, k) => {
          numerals[at + k] = kind === 'merged' ? { ch, color: 'merged' } : { ch, dim: true }
        })
        numeralEnd = at + label.length + 1
      }
    }
  })

  const dense = (cells: Cell[]) => Array.from(cells, cell => cell ?? { ch: ' ' })
  return [...band.reverse().map(r => runs(dense(r))), runs(dense(base)), runs(dense(numerals))]
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
      const ago = row.mergedAt === null ? '' : ` ${agoText(row.mergedAt, Math.max(now, row.mergedAt)).replace(/^polled /, '')}`
      return { t: `merged${ago}`, dim: true }
    }
    case 'calm':
      if (row.gallery === 'linked') return { t: '◆' }
      if (row.gallery === 'no visual change') return { t: '≡' }
      return { t: '·', dim: true }
  }
}

const shortRef = (row: WaveRow) => `${row.repo.split('/').pop() ?? row.repo}#${row.number}`

function legendLines(ctx: PaneCtx): Line[] {
  const { rows, width } = ctx
  const isStale = ctx.error !== null
  const refW = Math.max(MIN_REF, ...rows.map(row => cellLen(shortRef(row))))
  const titleW = Math.max(0, width - (4 + refW + 2) - 1 - FACT_W)
  return rows.map((row, i) => {
    const kind = kindOf(row)
    const fact = factOf(row, kind, ctx.now)
    const ref: Seg = { t: shortRef(row) }
    if (isStale) ref.dim = true
    else if (isProblem(kind)) ref.bold = true
    const title = clip(`${row.isDraft ? '◇ ' : ''}${row.title}`, titleW)
    if (isStale && fact.color === undefined) fact.dim = true
    return [
      { t: `${String(i + 1).padStart(2)}  `, dim: true },
      ref,
      { t: ' '.repeat(refW + 2 - cellLen(ref.t)) },
      { t: padEnd(title, titleW), dim: true },
      { t: ' ' + ' '.repeat(Math.max(0, FACT_W - cellLen(fact.t))) },
      fact,
    ]
  })
}

/** The pane as styled lines, before elements: pure, so tests read cells directly. */
export function skylineLines(ctx: PaneCtx): Line[] {
  const open = ctx.rows.filter(row => row.status === 'open').length
  const errorLine: Line[] =
    ctx.error === null ? [] : [[{ t: clip(`× ${ctx.error}`, ctx.width), color: 'warn' }]]

  if (ctx.width < MIN_WIDTH) {
    const { left, when, wake } = headerParts(ctx, open)
    return [[{ t: clip(`${left} · ${when} · ${wake.t}`, ctx.width) }], ...errorLine]
  }

  const lines: Line[] = [headerLine(ctx, open), ...errorLine, [], ...chartLines(ctx)]
  if (ctx.rows.length > 0) {
    lines.push([], ...legendLines(ctx))
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
  const { Box, Text } = ctx.el
  const seg = (s: Seg) => {
    if (s.color === undefined && !s.dim && !s.bold) return s.t
    const props: { color?: string; dimColor?: boolean; bold?: boolean } = {}
    if (s.color !== undefined) props.color = TOKENS[s.color]
    else if (s.dim) props.dimColor = true
    if (s.bold) props.bold = true
    return <Text {...props}>{s.t}</Text>
  }
  return (
    <Box flexDirection="column">
      {skylineLines(ctx).map(line =>
        line.length === 0 ? <Text> </Text> : <Text wrap="truncate">{line.map(seg)}</Text>,
      )}
    </Box>
  )
}

/** The sheet's status line. */
export function skylineStatus(
  rows: readonly WaveRow[],
  error: string | null,
  polledAt: number | null,
  now: number,
): string {
  if (error !== null) {
    const ago = polledAt === null ? '' : ` ${agoText(polledAt, Math.max(now, polledAt)).replace(/^polled | ago$/g, '')}`
    return `wave: gh unreachable${ago}`
  }
  const kinds = rows.map(row => [kindOf(row), row] as const)
  const count = (pick: (kind: Kind, row: WaveRow) => boolean) => kinds.filter(([k, r]) => pick(k, r)).length
  const parts: [number, string][] = [
    [count(k => k === 'red'), 'red'],
    [count(k => k === 'conflict'), 'conflict'],
    [count(k => k === 'rebase'), 'rebase'],
    [count(k => k === 'unknown'), 'unknown'],
    [count(k => k === 'running'), 'running'],
    [count((k, r) => k === 'calm' && r.ci.kind === 'green'), 'green'],
    [count((k, r) => k === 'calm' && r.ci.kind !== 'green'), 'no ci'],
  ]
  const shown = parts.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`)
  if (shown.length === 0) return polledAt === null ? 'wave: first poll' : 'wave: none open'
  let text = `wave: ${shown.join(' · ')}`
  while (text.length >= 48 && shown.length > 1) {
    shown.pop()
    text = `wave: ${shown.join(' · ')}`
  }
  return text
}

export const style: PaneStyle = {
  meta: {
    id: 'd3',
    name: 'Skyline',
    tagline: 'One bar per PR, height is urgency: calm is a flat horizon, trouble is a tower',
    animated: true,
  },
  render,
  status: ({ rows, error, polledAt, now }) => skylineStatus(rows, error, polledAt, now),
}
