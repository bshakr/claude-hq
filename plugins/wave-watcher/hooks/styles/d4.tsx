import type { ElementTable, RenderElement } from 'claude-code'

import type { WaveRow } from '../../types'
import { agoText } from '../logic'
import type { PaneCtx, PaneStyle } from './types'

/** The terminal's own colour, for fg and bg of every cell; the only colour this style uses. */
export const DEFAULT_COLOR = 0x01000000
export const RASTER_KEY = 'paper'
export const MAX_COLUMNS = 512
export const MAX_ROWS = 256
const FALLBACK_WIDTH = 72
const NARROW = 48
const FOOTER = '   gh every 60s · 0 model tokens'

type Kind = 'red' | 'conflict' | 'rebase' | 'unknown' | 'running' | 'green' | 'none' | 'merged'

const SEVERITY: Record<Kind, number> = {
  red: 0,
  conflict: 1,
  rebase: 1,
  unknown: 2,
  running: 3,
  green: 4,
  none: 5,
  merged: 6,
}

function kindOf(row: WaveRow): Kind {
  if (row.status === 'merged') return 'merged'
  if (row.ci.kind === 'red') return 'red'
  if (row.merge === 'conflicting') return 'conflict'
  if (row.merge === 'needs rebase') return 'rebase'
  if (row.merge === 'unknown') return 'unknown'
  if (row.ci.kind === 'running') return 'running'
  return row.ci.kind === 'green' ? 'green' : 'none'
}

const severity = (row: WaveRow) => SEVERITY[kindOf(row)]
const needsYou = (row: WaveRow) => severity(row) <= SEVERITY.unknown

// The Raster refuses any cell that is not one printable width-1 BMP character and the
// pane closes, so GitHub text (emoji, CJK, tabs, combining marks) is filtered here.
const SAFE_RANGES: readonly (readonly [number, number])[] = [
  [0x20, 0x7e],
  [0xa1, 0xac],
  [0xae, 0x24f],
  [0x391, 0x3a9],
  [0x3b1, 0x3c9],
  [0x400, 0x45f],
  [0x2010, 0x2027],
  [0x2030, 0x203a],
  [0x20ac, 0x20ac],
  [0x2190, 0x2193],
  [0x2500, 0x25fc],
  [0x2713, 0x2713],
  [0x2717, 0x2717],
  [0x2800, 0x28ff],
]

export function isSafeCell(cp: number): boolean {
  return SAFE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)
}

function isZeroWidth(cp: number): boolean {
  return (
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x2060 && cp <= 0x2064) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0xfeff ||
    cp === 0xad
  )
}

/** One code point per cell: zero-width marks dropped, whitespace to a space, anything else unsafe to `?`. */
export function cellText(text: string): string {
  let out = ''
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0x3f
    if (isZeroWidth(cp)) continue
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d) out += ' '
    else out += isSafeCell(cp) ? ch : '?'
  }
  return out
}

/** Every string below is already cellText'd, so `.length` is its cell count. */
function clip(text: string, max: number): string {
  if (max <= 0) return ''
  if (text.length <= max) return text
  return max === 1 ? '…' : `${text.slice(0, max - 1)}…`
}

const pad = (text: string, width: number) => clip(text, width).padEnd(width)

function factOf(row: WaveRow, factWidth: number, now: number): string {
  const kind = kindOf(row)
  switch (kind) {
    case 'red':
      return `✗ ${clip(cellText(row.ci.kind === 'red' ? row.ci.failing : ''), factWidth - 2)}`
    case 'conflict':
      return 'conflicts'
    case 'rebase':
      return 'needs rebase'
    case 'unknown':
      return 'merge ?'
    case 'running': {
      if (row.ci.kind !== 'running') return ''
      const { done, total } = row.ci
      const ratio = `${done}/${total}`
      if (factWidth < 15 || total > 8) return ratio
      return `${'▓'.repeat(done)}${'░'.repeat(total - done)} ${ratio}`
    }
    case 'green':
      return row.gallery === 'linked' ? '✓ gallery' : row.gallery === 'no visual change' ? '✓ no visual' : '✓ no gallery'
    case 'none':
      return 'no checks'
    case 'merged': {
      if (row.mergedAt === null) return 'merged'
      const full = agoText(row.mergedAt, Math.max(now, row.mergedAt)).replace(/^polled /, 'merged ')
      if (full.length <= factWidth) return full
      const short = full.replace(/ ago$/, '')
      return short.length <= factWidth ? short : 'merged'
    }
  }
}

type Group = { repo: string; rows: WaveRow[] }

function groupByRepo(rows: readonly WaveRow[]): Group[] {
  const groups = new Map<string, WaveRow[]>()
  for (const row of rows) {
    const list = groups.get(row.repo)
    if (list) list.push(row)
    else groups.set(row.repo, [row])
  }
  const order = [...groups.keys()]
  return order
    .map(repo => {
      const list = groups.get(repo) ?? []
      // Stable sort: the data layer's order breaks ties.
      const sorted = list.map((row, i) => ({ row, i })).sort((a, b) => severity(a.row) - severity(b.row) || a.i - b.i)
      return { repo, rows: sorted.map(one => one.row) }
    })
    .map((group, i) => ({ group, i }))
    .sort(
      (a, b) =>
        Math.min(...a.group.rows.map(severity)) - Math.min(...b.group.rows.map(severity)) ||
        b.group.rows.length - a.group.rows.length ||
        a.i - b.i,
    )
    .map(one => one.group)
}

function headerLine(ctx: PaneCtx, width: number): string {
  const open = ctx.rows.filter(row => row.status === 'open').length
  const left = ctx.polledAt === null && ctx.rows.length === 0 ? 'wave' : `${open} open`
  const wake = `wake ${ctx.isWaking ? 'on' : 'off'}`
  let ago: string
  if (ctx.error !== null) {
    ago = ctx.polledAt === null ? 'no good poll yet' : agoText(ctx.polledAt, Math.max(ctx.now, ctx.polledAt)).replace(/^polled /, 'last good poll ')
  } else {
    ago = ctx.polledAt === null ? 'first poll running' : agoText(ctx.polledAt, Math.max(ctx.now, ctx.polledAt))
  }
  for (const right of [`${ago} · ${wake}`, ago]) {
    if (left.length + 1 + right.length <= width) return left + right.padStart(width - left.length)
  }
  return clip(left, width)
}

type Plan = { collapsed: Map<string, number>; folded: number; separators: boolean; footer: boolean }

function rowLine(row: WaveRow, tree: string, width: number, factWidth: number, now: number): string {
  const gutter = needsYou(row) ? '██' : kindOf(row) === 'running' ? '░░' : '  '
  const num = `#${row.number}`
  const lead = `${gutter} ${tree} ${num}  `
  const titleWidth = width - factWidth - 2 - lead.length
  const title = cellText(`${row.isDraft ? '◇ ' : ''}${row.title}`)
  return `${lead}${pad(title, titleWidth)}  ${pad(factOf(row, factWidth, now), factWidth)}`
}

function headingLine(repo: string, width: number): string {
  const name = clip(cellText(repo), width - 5)
  return `   ${name} ${'┄'.repeat(Math.max(0, width - 4 - name.length))}`
}

function groupLines(group: Group, collapse: number, width: number, factWidth: number, now: number): string[] {
  const shown = group.rows.slice(0, group.rows.length - collapse)
  const hidden = group.rows.slice(shown.length)
  const lines = [headingLine(group.repo, width)]
  shown.forEach((row, i) => {
    const last = i === shown.length - 1 && hidden.length === 0
    lines.push(rowLine(row, last ? '└─' : '├─', width, factWidth, now))
  })
  if (hidden.length > 0) {
    const label = hidden.every(row => kindOf(row) === 'green') ? 'green' : 'more'
    lines.push(clip(`   └─ +${hidden.length} ${label}`, width))
  }
  return lines
}

function bodyLines(groups: Group[], plan: Plan, width: number, now: number): string[] {
  const factWidth = width >= 66 ? 15 : 13
  const kept = groups.slice(0, groups.length - plan.folded)
  const folded = groups.slice(kept.length)
  const out: string[] = []
  kept.forEach((group, i) => {
    if (i > 0 && plan.separators) out.push('')
    out.push(...groupLines(group, plan.collapsed.get(group.repo) ?? 0, width, factWidth, now))
  })
  if (folded.length > 0) {
    if (plan.separators && out.length > 0) out.push('')
    const allGreen = folded.every(group => group.rows.every(row => kindOf(row) === 'green'))
    const noun = folded.length === 1 ? 'repo' : 'repos'
    out.push(clip(`   +${folded.length} ${allGreen ? `${noun} all green` : `quiet ${noun}`}`, width))
  }
  return out
}

/** Collapse steps, calmest first: one row at a time from the bottom of a repo; problems never. */
function collapseOrder(groups: Group[]): string[] {
  const steps: { repo: string; sev: number; depth: number; g: number }[] = []
  groups.forEach((group, g) => {
    const calm = group.rows.filter(row => !needsYou(row))
    // Problems sort to the top of a group, so the calm rows are its tail.
    calm.forEach((row, i) => steps.push({ repo: group.repo, sev: severity(row), depth: calm.length - i, g }))
  })
  // Calm rows are severity-ascending within a repo, so this takes each repo bottom-up.
  steps.sort((a, b) => b.sev - a.sev || b.g - a.g || a.depth - b.depth)
  return steps.map(step => step.repo)
}

function treeLines(ctx: PaneCtx, groups: Group[], width: number, budget: number | null): { lines: string[]; footer: boolean } {
  const plan: Plan = { collapsed: new Map(), folded: 0, separators: true, footer: true }
  const fits = (lines: string[]) => budget === null || lines.length + (plan.footer ? 1 : 0) <= budget
  let lines = bodyLines(groups, plan, width, ctx.now)
  if (fits(lines)) return { lines, footer: plan.footer }
  plan.footer = false
  if (fits(lines)) return { lines, footer: false }
  for (const repo of collapseOrder(groups)) {
    plan.collapsed.set(repo, (plan.collapsed.get(repo) ?? 0) + 1)
    lines = bodyLines(groups, plan, width, ctx.now)
    if (fits(lines)) return { lines, footer: false }
  }
  // Fold whole problem-free repos from the bottom; a problem repo is never folded.
  while (plan.folded < groups.length) {
    const next = groups[groups.length - 1 - plan.folded]
    if (next === undefined || next.rows.some(needsYou)) break
    plan.folded += 1
    lines = bodyLines(groups, plan, width, ctx.now)
    if (fits(lines)) return { lines, footer: false }
  }
  plan.separators = false
  lines = bodyLines(groups, plan, width, ctx.now)
  if (fits(lines) || budget === null) return { lines, footer: false }
  const keep = Math.max(0, budget - 1)
  return { lines: [...lines.slice(0, keep), clip(`   … +${lines.length - keep} more lines`, width)], footer: false }
}

function narrowLines(ctx: PaneCtx, width: number): string[] {
  const now = ctx.now
  const problems = ctx.rows.filter(needsYou)
  const out = problems.map(row => clip(`██ #${row.number} ${factOf(row, 13, now)}`, width))
  const calm = ctx.rows.length - problems.length
  if (calm > 0) out.push(clip(`   +${calm} calm`, width))
  return out
}

/**
 * The pane as plain lines, each exactly `width` cells (null `rows`: as many lines as needed).
 * Exported for tests; `render` packs these into the Raster or the Text fallback.
 */
export function paperLines(ctx: PaneCtx, width: number, rows: number | null): string[] {
  const top = [headerLine(ctx, width)]
  if (ctx.error !== null) top.push(clip(`×  ${cellText(ctx.error.split('\n')[0] ?? '')}`, width))
  top.push('')
  let body: string[]
  let footer = false
  if (ctx.rows.length === 0) {
    if (ctx.polledAt === null) body = [ctx.error === null ? '   ░ waiting for the first poll' : '   ░ no poll has succeeded yet']
    else body = ['   no open pull requests', '   nothing merged in the last 30 min']
    footer = true
  } else if (width < NARROW) {
    body = narrowLines(ctx, width)
  } else {
    const tree = treeLines(ctx, groupByRepo(ctx.rows), width, rows === null ? null : rows - top.length)
    body = tree.lines
    footer = tree.footer
  }
  let lines = [...top, ...body].map(line => clip(line, width))
  if (rows === null) {
    if (footer) lines.push('', clip(FOOTER, width))
  } else {
    lines = lines.slice(0, rows)
    if (footer && lines.length < rows) {
      while (lines.length < rows - 1) lines.push('')
      lines.push(clip(FOOTER, width))
    }
    while (lines.length < rows) lines.push('')
  }
  return lines.map(line => line.padEnd(width))
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function base64(bytes: Uint8Array): string {
  const parts: string[] = []
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    parts.push(
      (B64[(n >> 18) & 63] ?? '') +
        (B64[(n >> 12) & 63] ?? '') +
        (b === undefined ? '=' : (B64[(n >> 6) & 63] ?? '')) +
        (c === undefined ? '=' : (B64[n & 63] ?? '')),
    )
  }
  return parts.join('')
}

/** Row-major little-endian u32 triplets, every fg and bg the terminal default. */
export function encodeCells(lines: readonly string[], columns: number, rows: number): string {
  const view = new DataView(new ArrayBuffer(columns * rows * 12))
  for (let y = 0; y < rows; y++) {
    const chars = [...(lines[y] ?? '')]
    for (let x = 0; x < columns; x++) {
      const cp = chars[x]?.codePointAt(0) ?? 0x20
      const at = (y * columns + x) * 12
      view.setUint32(at, isSafeCell(cp) ? cp : 0x3f, true)
      view.setUint32(at + 4, DEFAULT_COLOR, true)
      view.setUint32(at + 8, DEFAULT_COLOR, true)
    }
  }
  return base64(new Uint8Array(view.buffer))
}

/** The Raster's size, or null when it cannot be drawn validly this frame. */
export function rasterSize(ctx: PaneCtx): { columns: number; rows: number } | null {
  if (ctx.surface !== 'terminal') return null
  const { width, bodyRows } = ctx
  if (!Number.isInteger(width) || !Number.isInteger(bodyRows) || width <= 0 || bodyRows <= 0) return null
  return { columns: Math.min(MAX_COLUMNS, width), rows: Math.min(MAX_ROWS, bodyRows) }
}

function render(ctx: PaneCtx): RenderElement {
  const size = rasterSize(ctx)
  if (size !== null) {
    const { Raster } = ctx.el as ElementTable<'terminal'>
    const lines = paperLines(ctx, size.columns, size.rows)
    return Raster({ key: RASTER_KEY, columns: size.columns, rows: size.rows, cells: encodeCells(lines, size.columns, size.rows) })
  }
  const { Box, Text } = ctx.el
  const width = Number.isInteger(ctx.width) && ctx.width > 0 ? Math.min(MAX_COLUMNS, ctx.width) : FALLBACK_WIDTH
  const lines = paperLines(ctx, width, null)
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={`l${i}`} wrap="truncate">
          {line.trimEnd() === '' ? ' ' : line.trimEnd()}
        </Text>
      ))}
    </Box>
  )
}

export const style: PaneStyle = {
  meta: {
    id: 'd4',
    name: 'Paper',
    tagline: 'Printed on your terminal: no colour, grouped by repo, ink gutter marks what needs you',
  },
  render,
}
