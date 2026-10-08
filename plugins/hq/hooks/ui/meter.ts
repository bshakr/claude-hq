// The context meter on a session's first line and the plan usage in the header (ADR 0007).
import type { AccountUsage, ContextUsage } from '../model/types'
import type { Row, Sty } from './row'
import { cellLen } from './text'

export type Part = { t: string; s: Sty }

export const METER_CELLS = 5
export const WARN_AT = 50
export const FAIL_AT = 80

const DIM: Sty = { dim: true }

/** As the user's status line colours by what remains: ≤20% left fails, ≤50% left warns, else quiet. */
export function usageTone(percent: number): Sty {
  if (percent >= FAIL_AT) return { c: 'fail' }
  if (percent >= WARN_AT) return { c: 'wait' }
  return DIM
}

/** Any use lights a cell, so 28% shows two of five. */
export function filledCells(percent: number, cells = METER_CELLS): number {
  return Math.max(0, Math.min(cells, Math.ceil((cells * percent) / 100)))
}

/** `▰▰▱▱▱ 28%` as parts, widest first, then `28%` alone; none without a figure. */
export function meterParts(ctx: ContextUsage | undefined): { full: Part[]; pct: Part[] } {
  if (!ctx) return { full: [], pct: [] }
  const tone = usageTone(ctx.percent)
  const on = filledCells(ctx.percent)
  const pct: Part[] = [{ t: '  ', s: {} }, { t: `${ctx.percent}%`, s: tone }]
  const full: Part[] = [{ t: '  ', s: {} }]
  if (on) full.push({ t: '▰'.repeat(on), s: tone })
  if (on < METER_CELLS) full.push({ t: '▱'.repeat(METER_CELLS - on), s: DIM })
  full.push({ t: ` ${ctx.percent}%`, s: tone })
  return { full, pct }
}

/** `5h 5% · wk 18%`, dim; a figure past WARN_AT or FAIL_AT takes that colour. */
export function accountParts(a: AccountUsage | undefined): Part[] {
  if (!a) return []
  const out: Part[] = []
  for (const [label, v] of [['5h', a.fiveHour], ['wk', a.week]] as const) {
    if (v === undefined) continue
    if (out.length) out.push({ t: ' · ', s: DIM })
    out.push({ t: `${label} `, s: DIM }, { t: `${v}%`, s: usageTone(v) })
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
