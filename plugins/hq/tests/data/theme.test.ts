import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { MATCH_BG_USAGE, parseMatchBg, themeTarget, withBackground } from '../../hooks/data/theme'

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

  test('a custom theme is its own target; a built-in base carries over, auto and unknown read as dark', () => {
    expect(themeTarget('custom:mocha')).toEqual({ slug: 'mocha' })
    expect(themeTarget('light-ansi')).toEqual({ slug: 'hq', base: 'light-ansi' })
    expect(themeTarget('auto')).toEqual({ slug: 'hq', base: 'dark' })
    expect(themeTarget(undefined)).toEqual({ slug: 'hq', base: 'dark' })
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
    expect(JSON.parse(withBackground(undefined, { slug: 'hq', base: 'dark-ansi' }, '#fff')!)).toEqual({
      name: 'hq',
      base: 'dark-ansi',
      overrides: { composerSidebarBackground: '#fff' },
    })
    const old = JSON.stringify({ name: 'hq', base: 'dark', overrides: { claude: '#f5c2e7' } })
    expect(JSON.parse(withBackground(old, { slug: 'hq', base: 'light' }, '#fff')!)).toEqual({
      name: 'hq',
      base: 'light',
      overrides: { claude: '#f5c2e7', composerSidebarBackground: '#fff' },
    })
  })

  test('a file that is not a JSON object is left alone', () => {
    expect(withBackground('{oops', { slug: 'mocha' }, '#fff')).toBeUndefined()
    expect(withBackground('[]', { slug: 'mocha' }, '#fff')).toBeUndefined()
  })
})

function host(on: On, theme: string, files: Record<string, string>) {
  const h = { toasts: [] as string[] }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', ($, e) => {
    h.toasts.push(e.text)
    return { value: undefined }
  })
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('config.list', () => ({
    value: [{ key: 'theme', label: 'Theme', kind: 'choice' as const, value: theme, provider: ENGINE, isLocked: false }],
  }))
  on('fs.exists', ($, e) => ({ value: files[e.path] !== undefined }))
  on('fs.read', ($, e) => ({ value: files[e.path]! }))
  on('fs.write', ($, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  return h
}

const run = ($: Engine, args: string) =>
  $.command.run({ command: 'hq', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

test('/hq match-bg on a built-in theme writes hq.json and says to pick it once', { options: { autoOpen: false } }, async ($, on) => {
  const files: Record<string, string> = {}
  const h = host(on, 'dark-ansi', files)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await run($, 'match-bg #1e1e2e')
  expect(JSON.parse(files[`${HOME}/.claude/themes/hq.json`]!)).toEqual({
    name: 'hq',
    base: 'dark-ansi',
    overrides: { composerSidebarBackground: '#1e1e2e' },
  })
  expect(h.toasts).toEqual(['Side panel set to #1e1e2e in theme hq: pick "hq" in /theme once; later /hq match-bg runs apply live.'])
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
