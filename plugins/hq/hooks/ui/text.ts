// Terminal cell width: wide East Asian and emoji count 2 (an over-estimate is safe: lines only get shorter).
// Private Use glyphs (the meters' Nerd Font caps) draw one cell, so the range skips U+E000–U+F8FF.
const WIDE =
  /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\u8C48-\uDFFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]|[\u{1F000}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u
// eslint-disable-next-line no-misleading-character-class -- ranges of combining marks, matched one code point at a time
const ZERO = /[\u200B-\u200F\u0300-\u036F\uFE00-\uFE0F]/u

export const charWidth = (ch: string) => (ZERO.test(ch) ? 0 : WIDE.test(ch) ? 2 : 1)

export function cellLen(text: string): number {
  let n = 0
  for (const ch of text) n += charWidth(ch)
  return n
}

/** Cut to at most `max` cells, ending in a single `…` when cut. */
export function clip(text: string, max: number): string {
  if (max <= 0) return ''
  if (cellLen(text) <= max) return text
  let out = ''
  let used = 0
  for (const ch of text) {
    const w = charWidth(ch)
    if (used + w > max - 1) break
    out += ch
    used += w
  }
  return `${out}…`
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** "45s", "6m 30s", "2h 5m" — an agent's elapsed time. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

/** "40s", "2m", "1h", "2d" — an age. */
export function age(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

/** Greedy word wrap to `w` cells; a word longer than `w` is clipped. */
export function wrap(text: string, w: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word
    if (cellLen(next) <= w) line = next
    else {
      if (line) out.push(line)
      line = clip(word, w)
    }
  }
  if (line) out.push(line)
  return out
}

/**
 * Word wrap for the cursor row: the first line in `first` cells, the rest in `rest`,
 * at most `max` lines, the last one clipped with `…` when text remains.
 */
export function wrapCapped(text: string, first: number, rest: number, max: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const out: string[] = []
  let i = 0
  while (i < words.length && out.length < max) {
    const w = out.length === 0 ? first : rest
    if (w <= 0) break
    if (out.length === max - 1) {
      out.push(clip(words.slice(i).join(' '), w))
      break
    }
    let line = clip(words[i++]!, w)
    while (i < words.length && cellLen(`${line} ${words[i]}`) <= w) line = `${line} ${words[i++]}`
    out.push(line)
  }
  return out
}
