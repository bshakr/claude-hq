import type { PluginOptions } from 'claude-code'

import type { Tok } from './ui/row'

/** The default palette: terminal slots, so HQ follows the terminal's own theme. */
export const DEFAULT_TOKENS: Readonly<Record<Tok, string>> = {
  fail: 'ansi256(1)',
  wait: 'ansi256(3)',
  run: 'ansi256(4)',
  ok: 'ansi256(2)',
  accent: 'ansi256(6)',
  rule: 'ansi256(8)',
}

/** userConfig field → the token it paints. */
export const COLOR_FIELDS: ReadonlyArray<readonly [field: string, name: string, tok: Tok]> = [
  ['colorBroken', 'broken', 'fail'],
  ['colorWaiting', 'waiting', 'wait'],
  ['colorWorking', 'working', 'run'],
  ['colorDone', 'done', 'ok'],
  ['colorAccent', 'accent', 'accent'],
  ['colorDim', 'dim', 'rule'],
]

export const SUMMARIES_KEY = 'summaries'

export type HqConfig = {
  tokens: Readonly<Record<Tok, string>>
  /** One line naming the colours that were ignored; undefined when all parsed. */
  warning?: string
  summaries: boolean
  wake: boolean
  notify: boolean
  autoOpen: boolean
  updateCheck: boolean
}

/** `#rrggbb`, `ansi256(N)` or a bare `N` (0-255) to what Text's `color` takes; undefined when none of them. */
export function parseColor(raw: string): string | undefined {
  const v = raw.trim()
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase()
  const m = /^(?:ansi256\(\s*(\d{1,3})\s*\)|(\d{1,3}))$/i.exec(v)
  const n = m ? Number(m[1] ?? m[2]) : NaN
  return n >= 0 && n <= 255 ? `ansi256(${n})` : undefined
}

const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback)

/** Options as `register` receives them to HQ's settings; never throws, a bad colour keeps its default. */
export function resolveConfig(options: PluginOptions | undefined): HqConfig {
  const o: Record<string, unknown> = options ?? {}
  const tokens: Record<Tok, string> = { ...DEFAULT_TOKENS }
  const bad: string[] = []
  for (const [field, name, tok] of COLOR_FIELDS) {
    const raw = o[field]
    if (raw === undefined || raw === '') continue
    const color = typeof raw === 'string' ? parseColor(raw) : undefined
    if (color === undefined) bad.push(name)
    else tokens[tok] = color
  }
  return {
    tokens,
    ...(bad.length ? { warning: `hq: ignored colour ${bad.join(', ')} (use #rrggbb, ansi256(N) or N)` } : {}),
    summaries: bool(o.summaries, true),
    wake: bool(o.wake, true),
    notify: bool(o.notify, true),
    autoOpen: bool(o.autoOpen, true),
    updateCheck: bool(o.updateCheck, true),
  }
}

/** A /hq toggle kept in $.store wins over the config default. */
export function effective(stored: unknown, fallback: boolean): boolean {
  return typeof stored === 'boolean' ? stored : fallback
}

let current: HqConfig = resolveConfig(undefined)

export function setConfig(c: HqConfig): void {
  current = c
}

export function config(): HqConfig {
  return current
}
