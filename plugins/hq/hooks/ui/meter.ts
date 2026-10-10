// The context meter on a session's first line and the plan usage in the header.
import type { AccountUsage, ContextUsage } from '../model/types'
import type { Row, Sty } from './row'
import { cellLen } from './text'

export type Part = { t: string; s: Sty }

export const METER_CELLS = 5
export const USAGE_CELLS = 6
export const WARN_AT = 50
export const FAIL_AT = 80

const DIM: Sty = { dim: true }

/** As the user's status line colours by what remains: green, yellow from WARN_AT, red from FAIL_AT. */
export function usageTone(percent: number): Sty {
  return { c: percent >= FAIL_AT ? 'fail' : percent >= WARN_AT ? 'wait' : 'ok' }
}

/** Any use lights a cell, so 28% shows two of five. */
export function filledCells(percent: number, cells = METER_CELLS): number {
  return Math.max(0, Math.min(cells, Math.ceil((cells * percent) / 100)))
}

/** `● ● ● ● ●`: lit dots in the tone, the rest the same dot dimmed, a space apart; `2 * dots - 1` cells at every fill level. */
export function bar(percent: number, dots: number, tone: Sty): Part[] {
  const on = filledCells(percent, dots)
  const run = (n: number) => Array(n).fill('●').join(' ')
  const out: Part[] = []
  if (on) out.push({ t: run(on), s: tone })
  if (on && on < dots) out.push({ t: ' ', s: {} })
  if (on < dots) out.push({ t: run(dots - on), s: DIM })
  return out
}

/** The bar and percent as parts, widest first, then the percent alone; none without a figure. */
export function meterParts(ctx: ContextUsage | undefined): { full: Part[]; pct: Part[] } {
  if (!ctx) return { full: [], pct: [] }
  const tone = usageTone(ctx.percent)
  const pct: Part[] = [
    { t: '  ', s: {} },
    { t: `${ctx.percent}%`, s: tone },
  ]
  const full: Part[] = [{ t: '  ', s: {} }, ...bar(ctx.percent, METER_CELLS, tone), { t: ` ${ctx.percent}%`, s: tone }]
  return { full, pct }
}

/** `5h <bar> 10% · wk <bar> 20%`; `bars: false` drops the bars. */
export function accountParts(a: AccountUsage | undefined, bars = true): Part[] {
  if (!a) return []
  const out: Part[] = []
  for (const [label, v] of [
    ['5h', a.fiveHour],
    ['wk', a.week],
  ] as const) {
    if (v === undefined) continue
    if (out.length) out.push({ t: ' · ', s: DIM })
    const tone = usageTone(v)
    out.push({ t: `${label} `, s: DIM })
    if (bars) out.push(...bar(v, USAGE_CELLS, tone), { t: ' ', s: {} })
    out.push({ t: `${v}%`, s: tone })
  }
  return out
}

export const partsWidth = (parts: readonly Part[]) => parts.reduce((n, p) => n + cellLen(p.t), 0)

/** Parts ending at the last cell; skipped when they would start before `minCol`. */
export function putRight(r: Row, parts: readonly Part[], minCol = 0): boolean {
  let c = r.W - partsWidth(parts)
  if (!parts.length || c < minCol) return false
  for (const p of parts) c = r.put(c, p.t, p.s)
  return true
}
