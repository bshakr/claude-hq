import { agoText, firstLine } from '../logic'
import type { WaveRow } from '../../types'
import type { PaneCtx, PaneStyle } from './types'

// The only way colour enters this style. Palette indices 1-5 resolve through the terminal's
// own theme; the plugin validator refuses `ansi:` names (no colon in its colour pattern).
export const TOKENS = {
  fail: 'ansi256(1)',
  warn: 'ansi256(3)',
  run: 'ansi256(4)',
  ok: 'ansi256(2)',
  merged: 'ansi256(5)',
} as const

type Token = keyof typeof TOKENS

/** One styled stretch of a line. A coloured run is never dim (craft rule 7). */
export type Run = { t: string; color?: Token; dim?: boolean; bold?: boolean }
export type Line = Run[]

const FACT = 18
const STACK_BELOW = 52
const BAR = '▎'

const plain = (t: string): Run => ({ t })
const dim = (t: string): Run => ({ t, dim: true })
const tok = (color: Token, t: string): Run => ({ t, color })

function cellOf(code: number): number {
  if ((code >= 0x300 && code <= 0x36f) || (code >= 0x200b && code <= 0x200f) || (code >= 0xfe00 && code <= 0xfe0f)) return 0
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
    return 2
  return 1
}

/** Terminal cells a string takes (PR titles can carry CJK or emoji). */
export function cells(text: string): number {
  let n = 0
  for (const ch of text) n += cellOf(ch.codePointAt(0) ?? 0)
  return n
}

/** Cut to `max` cells, ending in a single `…` when anything was cut. */
function cut(text: string, max: number): string {
  if (cells(text) <= max) return text
  if (max <= 0) return ''
  let out = ''
  let used = 0
  for (const ch of text) {
    const w = cellOf(ch.codePointAt(0) ?? 0)
    if (used + w > max - 1) break
    out += ch
    used += w
  }
  return `${out}…`
}

const lineCells = (line: Line) => line.reduce((n, r) => n + cells(r.t), 0)

/** Safety net for very narrow panes: no line may exceed the body width. */
function clamp(line: Line, width: number): Line {
  if (lineCells(line) <= width) return line
  const out: Line = []
  let room = width
  for (const run of line) {
    const w = cells(run.t)
    if (w < room) {
      out.push(run)
      room -= w
      continue
    }
    out.push({ ...run, t: cut(run.t, room) })
    break
  }
  return out
}

function refsFor(rows: readonly WaveRow[]): (row: WaveRow) => string {
  const byShort = new Map<string, Set<string>>()
  for (const row of rows) {
    const short = row.repo.split('/')[1] ?? row.repo
    const seen = byShort.get(short) ?? new Set<string>()
    seen.add(row.repo)
    byShort.set(short, seen)
  }
  return row => {
    const short = row.repo.split('/')[1] ?? row.repo
    const name = (byShort.get(short)?.size ?? 0) > 1 ? row.repo : short
    return `${name}#${row.number}`
  }
}

/** Needs the founder: red CI, conflicts, behind main, or GitHub has not decided (unless CI is still running). */
export function isActionable(row: WaveRow): boolean {
  if (row.status !== 'open') return false
  if (row.ci.kind === 'red') return true
  if (row.merge === 'conflicting' || row.merge === 'needs rebase') return true
  return row.merge === 'unknown' && row.ci.kind !== 'running'
}

export function groupsOf(rows: readonly WaveRow[]) {
  const open = rows.filter(row => row.status === 'open')
  const needs = open.filter(isActionable)
  const inFlight = open.filter(row => !isActionable(row) && row.ci.kind === 'running')
  const ready = open.filter(row => !isActionable(row) && row.ci.kind !== 'running')
  const landed = rows.filter(row => row.status === 'merged')
  return { open, needs, inFlight, ready, landed }
}

function galleryWord(row: WaveRow): string {
  if (row.gallery === 'linked') return 'linked'
  if (row.gallery === 'no visual change') return 'marked no visual change'
  return 'not linked'
}

type Clause = { runs: Run[]; drop: number }

/** The sheet's sentence set, as clauses; `drop` orders what goes first when the line is too narrow (0 never). */
function sentence(row: WaveRow, check: string): Clause[] {
  const out: Clause[] = []
  if (row.ci.kind === 'red') {
    if (row.merge === 'needs rebase') {
      out.push({ runs: [tok('fail', `${check} is failing`), plain(', and it '), tok('warn', 'needs a rebase'), plain('.')], drop: 0 })
    } else if (row.merge === 'conflicting') {
      out.push({ runs: [tok('fail', `${check} is failing`), plain('.')], drop: 0 })
      out.push({ runs: [plain(' '), tok('fail', 'Has conflicts with main'), plain('.')], drop: 0 })
    } else {
      out.push({ runs: [tok('fail', `${check} is failing`), plain('.')], drop: 0 })
      if (row.merge === 'mergeable') out.push({ runs: [plain(' Merge is clear once it passes.')], drop: 1 })
    }
  } else if (row.merge === 'conflicting') {
    out.push({ runs: [tok('fail', 'Has conflicts with main'), plain('.')], drop: 0 })
    out.push({ runs: [plain(' Resolve before merging.')], drop: 1 })
  } else if (row.merge === 'needs rebase') {
    out.push({ runs: [plain('Behind main, '), tok('warn', 'needs a rebase'), plain('.')], drop: 0 })
    if (row.ci.kind === 'green') out.push({ runs: [plain(` CI green, gallery ${galleryWord(row)}.`)], drop: 1 })
  } else {
    out.push({ runs: [plain('GitHub '), tok('warn', 'has not computed mergeability yet'), plain('.')], drop: 0 })
  }
  if (row.isDraft) out.push({ runs: [plain(' Still a draft.')], drop: 2 })
  return out
}

function sentenceLine(row: WaveRow, room: number): Run[] {
  const failing = row.ci.kind === 'red' ? row.ci.failing : ''
  let clauses = sentence(row, failing)
  const fits = (list: Clause[]) => list.reduce((n, c) => n + lineCells(c.runs), 0) <= room
  for (const level of [1, 2]) {
    if (fits(clauses)) break
    clauses = clauses.filter(c => c.drop === 0 || c.drop > level)
  }
  if (!fits(clauses) && row.ci.kind === 'red') {
    const over = clauses.reduce((n, c) => n + lineCells(c.runs), 0) - room
    // The check name keeps at least 8 cells before its `…` (craft rule 12).
    clauses = sentence(row, cut(failing, Math.max(9, cells(failing) - over))).filter(c => c.drop === 0)
  }
  return clauses.flatMap(c => c.runs)
}

function heading(name: string, count: number, width: number, isPrimary: boolean): Line {
  const n = String(count)
  const gap = Math.max(1, width - cells(name) - n.length)
  return [isPrimary ? { t: name, bold: true } : dim(name), plain(' '.repeat(gap)), dim(n)]
}

function actionable(row: WaveRow, ref: string, width: number): Line[] {
  const bar = tok(row.ci.kind === 'red' || row.merge === 'conflicting' ? 'fail' : 'warn', BAR)
  const titleRoom = width - 3 - cells(ref) - 3
  const head: Line = [plain(' '), bar, plain(' '), { t: ref, bold: true }]
  if (titleRoom > 1) head.push(plain(' · '), plain(cut(row.title, titleRoom)))
  return [head, [plain(' '), bar, plain(' '), ...sentenceLine(row, width - 3)]]
}

function factOf(row: WaveRow, now: number): Run[] {
  if (row.status === 'merged') {
    if (row.mergedAt === null) return [tok('merged', 'merged')]
    const ago = agoText(row.mergedAt, Math.max(now, row.mergedAt)).replace(/^polled /, '')
    return [tok('merged', 'merged'), dim(` ${ago}`)]
  }
  if (row.ci.kind === 'running') {
    const count = tok('run', `${row.ci.done}/${row.ci.total} checks`)
    const full = [dim('draft · '), count]
    return row.isDraft && lineCells(full) <= FACT ? full : [count]
  }
  if (row.gallery === 'linked') return [dim('gallery '), plain('◆')]
  if (row.gallery === 'no visual change') return [dim('no visual change')]
  return [dim('no gallery')]
}

function quietItem(row: WaveRow, ref: string, width: number, now: number): Line[] {
  const draft = row.isDraft && row.status === 'open' && row.ci.kind !== 'running' ? 'draft · ' : ''
  const fact = factOf(row, now)
  const left: Line = [plain('   '), dim(ref)]
  const stacked = width < STACK_BELOW
  const titleRoom = (stacked ? width : width - FACT - 2) - 3 - cells(ref) - 3 - draft.length
  if (titleRoom > 1) {
    left.push(dim(' · '))
    if (draft) left.push(dim(draft))
    left.push(dim(cut(row.title, titleRoom)))
  }
  if (stacked) return [left, [plain('   '), ...fact]]
  const pad = width - FACT - lineCells(left) + (FACT - lineCells(fact))
  return [[...left, plain(' '.repeat(Math.max(1, pad))), ...fact]]
}

function headerLines(ctx: PaneCtx, openCount: number): Line[] {
  const { polledAt, error, now, isWaking } = ctx
  const wake = isWaking ? plain('wake on') : dim('wake off')
  const sep = dim(' · ')
  const lines: Line[] = []
  if (polledAt === null) {
    lines.push([dim(error === null ? 'first poll running' : 'first poll failed'), sep, wake])
  } else {
    const ago = agoText(polledAt, Math.max(now, polledAt))
    const when = error === null ? ago : ago.replace(/^polled/, 'last good poll')
    lines.push([plain(`${openCount} open`), sep, dim(when), sep, wake])
  }
  if (error !== null) {
    const message = firstLine(error) || error
    const suffix = ' · showing the last good poll'
    const room = ctx.width
    const text =
      ctx.rows.length > 0 && cells(message) + suffix.length <= room ? `${message}${suffix}` : cut(message, room)
    lines.push([tok('warn', text)])
  }
  return lines
}

/** Stale rows (gh error): everything uncoloured goes dim, colours stay exactly as they were. */
function stale(line: Line): Line {
  return line.map(run => (run.color === undefined && run.t.trim() !== '' ? { t: run.t, dim: true } : run))
}

export function lines(ctx: PaneCtx): Line[] {
  const width = Math.max(1, ctx.width)
  const { rows, polledAt, error, now } = ctx
  const g = groupsOf(rows)
  const refOf = refsFor(rows)
  const head = headerLines(ctx, g.open.length)
  const body: Line[][] = []

  if (polledAt === null && rows.length === 0) {
    body.push([[dim(error === null ? 'Checking GitHub for your open PRs…' : 'Trying again on the next poll.')]])
  } else {
    if (g.open.length === 0) {
      body.push([[plain('Nothing open.')]])
      if (g.landed.length === 0) body.push([[dim('No PRs merged in the last 30 min either.')]])
    } else if (g.needs.length === 0 && error === null) {
      body.push([[tok('ok', '✓'), plain(' Nothing needs you.')]])
    }
    if (g.needs.length > 0) {
      const items = g.needs.map(row => actionable(row, refOf(row), width))
      const section: Line[] = [heading('Needs you', g.needs.length, width, true)]
      items.forEach((item, i) => {
        if (i > 0) section.push([])
        section.push(...item)
      })
      body.push(section)
    }
    const quiet: [string, WaveRow[]][] = [
      ['In flight', g.inFlight],
      ['Ready', g.ready],
      ['Landed', g.landed],
    ]
    for (const [name, list] of quiet) {
      if (list.length === 0) continue
      body.push([heading(name, list.length, width, false), ...list.flatMap(row => quietItem(row, refOf(row), width, now))])
    }
  }

  const out: Line[] = [...head]
  for (const section of body) {
    out.push([])
    out.push(...(error === null ? section : section.map(stale)))
  }
  return out.map(line => clamp(line, width))
}

/** The sheet's status line. */
export function statusText(ctx: Pick<PaneCtx, 'rows' | 'polledAt' | 'error' | 'now'>): string {
  const { rows, polledAt, error, now } = ctx
  if (error !== null) {
    if (polledAt === null) return 'wave: gh unreachable, no poll yet'
    return `wave: gh unreachable, last poll ${agoText(polledAt, Math.max(now, polledAt)).replace(/^polled /, '')}`
  }
  if (polledAt === null) return 'wave: first poll running'
  const g = groupsOf(rows)
  if (g.open.length === 0) return 'wave: nothing open'
  if (g.needs.length === 0) return 'wave: nothing needs you'
  const parts = [`${g.needs.length} ${g.needs.length === 1 ? 'needs' : 'need'} you`]
  if (g.inFlight.length > 0) parts.push(`${g.inFlight.length} in flight`)
  if (g.ready.length > 0) parts.push(`${g.ready.length} ready`)
  return `wave: ${parts.join(' · ')}`
}

function render(ctx: PaneCtx) {
  const { Box, Text } = ctx.el
  return (
    <Box flexDirection="column">
      {lines(ctx).map(line =>
        line.length === 0 ? (
          <Text> </Text>
        ) : (
          <Text wrap="truncate">
            {line.map(run =>
              run.color !== undefined ? (
                <Text color={TOKENS[run.color]}>{run.t}</Text>
              ) : run.bold ? (
                <Text bold>{run.t}</Text>
              ) : run.dim ? (
                <Text dimColor>{run.t}</Text>
              ) : (
                run.t
              ),
            )}
          </Text>
        ),
      )}
    </Box>
  )
}

export const style: PaneStyle = {
  meta: {
    id: 'd2',
    name: 'Triage',
    tagline: 'Sorts PRs into what you do next and writes each problem as one sentence',
  },
  render,
  status: statusText,
}
