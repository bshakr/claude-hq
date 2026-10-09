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

/** The theme file to write: the custom one in use, else `hq-<base>` on the current built-in base (`auto` reads as dark).
 * The base stays in the name because other mods tell light from dark by the theme's name. */
export function themeTarget(setting: unknown): { slug: string; base?: string } {
  if (typeof setting === 'string' && setting.startsWith('custom:')) return { slug: setting.slice('custom:'.length) }
  const base = typeof setting === 'string' && BASES.includes(setting) ? setting : 'dark'
  return { slug: `hq-${base}`, base }
}

export const themePath = (home: string, slug: string) => `${home}/.claude/themes/${slug}.json`

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
  const overrides = typeof theme.overrides === 'object' && theme.overrides !== null ? theme.overrides : {}
  const next =
    target.base === undefined ? { name: target.slug, base: 'dark', ...theme } : { ...theme, name: target.slug, base: target.base }
  return JSON.stringify({ ...next, overrides: { ...overrides, [SIDEBAR_KEY]: hex } }, null, 2) + '\n'
}
