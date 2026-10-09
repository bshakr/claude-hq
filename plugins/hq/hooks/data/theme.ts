// /hq match-bg: Claude Code fills the side panel with its theme's composerSidebarBackground.
export const SIDEBAR_KEY = 'composerSidebarBackground'
export const MATCH_BG_USAGE = 'Usage: /hq match-bg <#rrggbb>, your terminal background colour (#rgb works too).'

const BASES = ['dark', 'light', 'dark-daltonized', 'light-daltonized', 'dark-ansi', 'light-ansi']

/** The colour after `match-bg`; `usage` when it is missing or not `#rrggbb`/`#rgb`, undefined for another subcommand. */
export function parseMatchBg(args: string): string | 'usage' | undefined {
  const a = args.trim().split(/\s+/)
  if (a[0] !== 'match-bg') return undefined
  return a.length === 2 && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(a[1]!) ? a[1]! : 'usage'
}

/** Light when the colour's luminance is over half, so `auto` follows the terminal it was read from. */
export function baseFor(hex: string): 'light' | 'dark' {
  const h = hex.slice(1)
  const full = h.length === 3 ? [...h].map(c => c + c).join('') : h
  const [r, g, b] = [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16) / 255) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? 'light' : 'dark'
}

export const notAFile = (slug: string) =>
  `hq: theme ${slug} is not a file in your Claude themes folder; pick a built-in theme in /theme, then run /hq match-bg again.`

/** The theme file to write: the custom one in use, else `hq-<base>` on the current built-in base (`auto` and unknown follow the hex).
 * The base stays in the name because other mods tell light from dark by the theme's name. */
export function themeTarget(setting: unknown, hex: string): { slug: string; base?: string } | { refuse: string } {
  if (typeof setting === 'string' && setting.startsWith('custom:')) {
    const slug = setting.slice('custom:'.length)
    // Plugin themes (`plugin:file`) and the safe-mode label ("x (disabled in safe mode)") are not files we may write.
    return /^[\w.-]+$/.test(slug) && !slug.includes('..') ? { slug } : { refuse: notAFile(slug) }
  }
  const base = typeof setting === 'string' && BASES.includes(setting) ? setting : baseFor(hex)
  return { slug: `hq-${base}`, base }
}

export const themePath = (configDir: string, slug: string) => `${configDir}/themes/${slug}.json`

/** The theme file with the panel colour set, every other field and override kept; undefined when the file is not a JSON object. */
export function withBackground(text: string | undefined, target: { slug: string; base?: string }, hex: string): string | undefined {
  let theme: Record<string, unknown> = {}
  if (text !== undefined) {
    try {
      theme = JSON.parse(text) as Record<string, unknown>
    } catch {
      return undefined
    }
    if (typeof theme !== 'object' || theme === null || Array.isArray(theme)) return undefined
  }
  const o = theme.overrides
  const overrides = typeof o === 'object' && o !== null && !Array.isArray(o) ? o : {}
  const next =
    target.base === undefined ? { name: target.slug, base: 'dark', ...theme } : { ...theme, name: target.slug, base: target.base }
  return JSON.stringify({ ...next, overrides: { ...overrides, [SIDEBAR_KEY]: hex } }, null, 2) + '\n'
}
