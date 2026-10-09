import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { MATCH_BG_USAGE, baseFor, notAFile, parseMatchBg, themeTarget, withBackground } from '../../hooks/data/theme'

const HOME = '/home/u'
const ENGINE = { plugin: 'engine', tier: 'core' } as const

describe('parsing', () => {
  test('a #rrggbb or #rgb colour, usage for anything else, undefined for another subcommand', () => {
    expect(parseMatchBg('match-bg #1e1e2e')).toBe('#1e1e2e')
    expect(parseMatchBg(' match-bg  #FFF ')).toBe('#FFF')
    for (const args of ['match-bg', 'match-bg 1e1e2e', 'match-bg #12345', 'match-bg red', 'match-bg #fff #000'])
      expect(parseMatchBg(args)).toBe('usage')
    expect(parseMatchBg('wake on')).toBeUndefined()
  })

  test('a custom theme is its own target; an explicit built-in base carries over', () => {
    expect(themeTarget('custom:mocha', '#fff')).toEqual({ slug: 'mocha' })
    expect(themeTarget('light-ansi', '#000')).toEqual({ slug: 'hq-light-ansi', base: 'light-ansi' })
    expect(themeTarget('dark', '#ffffff')).toEqual({ slug: 'hq-dark', base: 'dark' })
  })

  test('auto and unknown settings take light or dark from the colour', () => {
    expect(themeTarget('auto', '#fdf6e3')).toEqual({ slug: 'hq-light', base: 'light' })
    expect(themeTarget('auto', '#1e1e2e')).toEqual({ slug: 'hq-dark', base: 'dark' })
    expect(themeTarget(undefined, '#FFF')).toEqual({ slug: 'hq-light', base: 'light' })
    expect(baseFor('#777')).toBe('dark')
    expect(baseFor('#999')).toBe('light')
  })

  test('plugin, traversal and safe-mode slugs are refused', () => {
    for (const slug of ['catppuccin:mocha', '../settings', 'a/b', 'a\\b', '..', 'mocha (disabled in safe mode)'])
      expect(themeTarget(`custom:${slug}`, '#000')).toEqual({ refuse: notAFile(slug) })
  })
})

describe('the theme file', () => {
  test('a custom theme keeps its name, base and other overrides', () => {
    const text = JSON.stringify({ name: 'Mocha', base: 'light', overrides: { claude: '#f5c2e7', composerSidebarBackground: '#000' } })
    expect(JSON.parse(withBackground(text, { slug: 'mocha' }, '#1e1e2e')!)).toEqual({
      name: 'Mocha',
      base: 'light',
      overrides: { claude: '#f5c2e7', composerSidebarBackground: '#1e1e2e' },
    })
  })

  test("hq's own theme takes the current base and keeps overrides already there", () => {
    expect(JSON.parse(withBackground(undefined, { slug: 'hq-dark-ansi', base: 'dark-ansi' }, '#fff')!)).toEqual({
      name: 'hq-dark-ansi',
      base: 'dark-ansi',
      overrides: { composerSidebarBackground: '#fff' },
    })
    const old = JSON.stringify({ name: 'hq-light', base: 'dark', overrides: { claude: '#f5c2e7' } })
    expect(JSON.parse(withBackground(old, { slug: 'hq-light', base: 'light' }, '#fff')!)).toEqual({
      name: 'hq-light',
      base: 'light',
      overrides: { claude: '#f5c2e7', composerSidebarBackground: '#fff' },
    })
  })

  test('overrides that are an array are replaced by an object', () => {
    const text = JSON.stringify({ name: 'Mocha', base: 'dark', overrides: ['#000'] })
    expect(JSON.parse(withBackground(text, { slug: 'mocha' }, '#fff')!).overrides).toEqual({ composerSidebarBackground: '#fff' })
  })

  test('a file that is not a JSON object is left alone', () => {
    expect(withBackground('{oops', { slug: 'mocha' }, '#fff')).toBeUndefined()
    expect(withBackground('[]', { slug: 'mocha' }, '#fff')).toBeUndefined()
  })
})

function host(
  on: On,
  theme: string,
  files: Record<string, string>,
  opts: { home?: string; configDir?: string; writeFails?: boolean; noThemeRow?: boolean } = {},
) {
  const h = { toasts: [] as string[] }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', ($, e) => {
    h.toasts.push(e.text)
    return { value: undefined }
  })
  on('env.get', ($, e) => ({
    value: e.name === 'HOME' ? ('home' in opts ? opts.home : HOME) : e.name === 'CLAUDE_CONFIG_DIR' ? opts.configDir : undefined,
  }))
  on('config.list', () => ({
    value: opts.noThemeRow
      ? []
      : [{ key: 'theme', label: 'Theme', kind: 'choice' as const, value: theme, provider: ENGINE, isLocked: false }],
  }))
  on('fs.exists', ($, e) => ({ value: files[e.path] !== undefined }))
  on('fs.read', ($, e) => ({ value: files[e.path]! }))
  on('fs.write', ($, e) => {
    if (opts.writeFails) return { deny: 'EACCES: permission denied' }
    files[e.path] = e.text
    return { value: undefined }
  })
  return h
}

const run = ($: Engine, args: string) =>
  $.command.run({ command: 'hq', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

test('/hq match-bg on a built-in theme writes hq-<base>.json and says to pick it once', { options: { autoOpen: false } }, async ($, on) => {
  const files: Record<string, string> = {}
  const h = host(on, 'dark-ansi', files)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await run($, 'match-bg #1e1e2e')
  expect(JSON.parse(files[`${HOME}/.claude/themes/hq-dark-ansi.json`]!)).toEqual({
    name: 'hq-dark-ansi',
    base: 'dark-ansi',
    overrides: { composerSidebarBackground: '#1e1e2e' },
  })
  expect(h.toasts).toEqual([
    'Side panel set to #1e1e2e in theme hq-dark-ansi: pick it in /theme once; later runs apply live in every session.',
  ])
})

test('/hq match-bg on a custom theme updates that file in place', { options: { autoOpen: false } }, async ($, on) => {
  const path = `${HOME}/.claude/themes/mocha.json`
  const files: Record<string, string> = { [path]: JSON.stringify({ name: 'Mocha', base: 'dark', overrides: { claude: '#f5c2e7' } }) }
  const h = host(on, 'custom:mocha', files)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await run($, 'match-bg #11111b')
  expect(JSON.parse(files[path]!).overrides).toEqual({ claude: '#f5c2e7', composerSidebarBackground: '#11111b' })
  expect(h.toasts).toEqual(['Side panel set to #11111b in theme mocha.'])
})

test('/hq match-bg without a colour toasts the usage and writes nothing', { options: { autoOpen: false } }, async ($, on) => {
  const files: Record<string, string> = {}
  const h = host(on, 'dark', files)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await run($, 'match-bg')
  expect(files).toEqual({})
  expect(h.toasts).toEqual([MATCH_BG_USAGE])
})

test('/hq match-bg refuses a custom theme with no file and writes nothing', { options: { autoOpen: false } }, async ($, on) => {
  const files: Record<string, string> = {}
  const h = host(on, 'custom:mocha', files)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await run($, 'match-bg #11111b')
  expect(files).toEqual({})
  expect(h.toasts).toEqual([notAFile('mocha')])
})

test('/hq match-bg refuses a plugin theme and writes nothing', { options: { autoOpen: false } }, async ($, on) => {
  const files: Record<string, string> = {}
  const h = host(on, 'custom:catppuccin:mocha', files)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await run($, 'match-bg #11111b')
  expect(files).toEqual({})
  expect(h.toasts).toEqual([notAFile('catppuccin:mocha')])
})

test('/hq match-bg toasts a failed write', { options: { autoOpen: false } }, async ($, on) => {
  const files: Record<string, string> = {}
  const h = host(on, 'dark', files, { writeFails: true })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await run($, 'match-bg #1e1e2e')
  expect(files).toEqual({})
  expect(h.toasts).toHaveLength(1)
  expect(h.toasts[0]).toMatch(/^hq: match-bg failed: .*EACCES/)
})

test('/hq match-bg refuses without CLAUDE_CONFIG_DIR or HOME', { options: { autoOpen: false } }, async ($, on) => {
  const files: Record<string, string> = {}
  const h = host(on, 'dark', files, { home: undefined })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await run($, 'match-bg #1e1e2e')
  expect(files).toEqual({})
  expect(h.toasts).toEqual(['hq: neither CLAUDE_CONFIG_DIR nor HOME is set, so there is no themes folder to write to.'])
})

test('/hq match-bg writes under CLAUDE_CONFIG_DIR when it is set', { options: { autoOpen: false } }, async ($, on) => {
  const files: Record<string, string> = {}
  host(on, 'dark', files, { configDir: '/cfg' })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await run($, 'match-bg #1e1e2e')
  expect(Object.keys(files)).toEqual(['/cfg/themes/hq-dark.json'])
})

test('/hq match-bg refuses when no theme row is listed', { options: { autoOpen: false } }, async ($, on) => {
  const files: Record<string, string> = {}
  const h = host(on, 'dark', files, { noThemeRow: true })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await run($, 'match-bg #1e1e2e')
  expect(files).toEqual({})
  expect(h.toasts).toEqual(['hq: no theme setting is visible here, so match-bg cannot tell which theme to change.'])
})
