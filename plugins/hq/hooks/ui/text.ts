// Terminal cell width: wide East Asian and emoji count 2 (an over-estimate is safe: lines only get shorter).
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{1F000}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u
const ZERO = /[​-‏̀-ͯ︀-️]/u

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
