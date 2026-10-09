import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import { SUMMARIES_KEY, config, effective, resolveConfig, setConfig } from './config'
import { currentModel, installData } from './data/index'
import { NOTIFY_STORE_KEY, parseNotifyArg } from './data/notify'
import { LATEST_KEY, MANIFEST_URL, headerNotice, installOf, knownMarketplacesPath, manifestVersion, runUpdate } from './data/update'
import type { HeaderNotice, Install } from './data/update'
import { MATCH_BG_USAGE, notAFile, parseMatchBg, themePath, themeTarget, withBackground } from './data/theme'
import { WAKE_KEY, parseWake } from './data/wake'
import type { HqModel } from './model/types'
import { caretItem, caretKey, pressedItem, ringMove } from './ui/caret'
import { pressJump } from './ui/jump'
import { layout, scrollFor } from './ui/layout'
import type { Layout } from './ui/layout'
import { drawPane } from './ui/pane'
import type { Action } from './ui/row'

export const PANE = 'hq'
const COMMAND = 'hq'
export const IDLE_REDRAW_MS = 30_000

const rev = atom({ plugin: 'hq', key: 'rev' } as const, 0)
const cursor = atom({ plugin: 'hq', key: 'cursor' } as const, null)
const expanded = atom({ plugin: 'hq', key: 'expanded' } as const, [])
const scroll = atom({ plugin: 'hq', key: 'scroll' } as const, 0)
const phase = atom({ plugin: 'hq', key: 'phase' } as const, 0)
const autoOpened = atom({ plugin: 'hq', key: 'autoOpened' } as const, false)
export const NARROW_TOAST = 'HQ is ready · /hq opens the pane'
export const HELP = [
  '/hq          open the pane',
  '/hq close    close the pane',
  '/hq wake on  wake this session on its own PRs going red, merging, conflicting or behind (default)',
  '/hq wake off toasts only, never start a turn',
  '/hq notify on|off   a notification when another session starts waiting on you',
  '/hq summaries on|off  Haiku goal lines and id glosses on cards',
  '  wake, notify and summaries default to the plugin config; a toggle here overrides it on this machine.',
  '/hq reset    forget those toggles, so the plugin config applies again',
  '/hq update   update HQ from the plugin store (then /reload-plugins)',
  '/hq match-bg <#hex>  paint the side panel your terminal background colour',
  '/hq help     this list',
  '',
  'ctrl+x tab moves the keys from the prompt to the pane, Esc moves them back. For a chord of your own,',
  'bind abovePrompt:focus in ~/.claude/keybindings.json.',
  'In the pane: j/k or Tab move, Enter or a click opens a PR or brings a session forward,',
  'Enter on an agent expands it, on +N finished shows the rest.',
].join('\n')

/** Motion only while something visibly runs: the session's own turn, a running agent, checks in progress, a busy session. */
export function hasMotion(m: HqModel): boolean {
  return (
    (m.current.now !== undefined && !m.current.now.idle) ||
    (m.current.waiting?.length ?? 0) > 0 ||
    m.current.agents.some(a => a.status === 'running') ||
    m.current.prs.some(p => p.ci.kind === 'running' && p.ci.done < p.ci.total) ||
    m.others.some(g => g.sessions.some(s => s.status === 'busy'))
  )
}

// Module state: a hot reload starts it afresh; session.start re-reads whether the pane is up.
let refresh: (() => Promise<void>) | undefined
let syncMotion: (() => Promise<void>) | undefined
let last: Layout | undefined
let isPaneOpen = false
let notice: HeaderNotice | undefined
let install: Install | undefined
let updateTimer: Timer | undefined
const UPDATE_RECHECK_MS = 60 * 60_000

/** The plugin-store install this module runs from; undefined under --plugin-dir or a local marketplace. */
async function readInstall($: EngineInterface): Promise<Install | undefined> {
  const root = $.plugin.root
  const known = knownMarketplacesPath(root)
  const text = async (path: string) => {
    try {
      return await $.fs.read(path)
    } catch {
      return undefined
    }
  }
  return installOf(root, manifestVersion(await text(`${root}/.claude-plugin/plugin.json`)), known ? await text(known) : undefined)
}

/** Sets the side panel colour in the custom theme in use, else in hq's own theme for the person to pick once. */
async function matchBackground($: EngineInterface, hex: string): Promise<string> {
  try {
    const row = (await $.config.list()).find(r => r.key === 'theme')
    if (!row) return 'hq: no theme setting is visible here, so match-bg cannot tell which theme to change.'
    const target = themeTarget(row.value, hex)
    if ('refuse' in target) return target.refuse
    // Claude Code reads themes from $CLAUDE_CONFIG_DIR/themes when that is set.
    const home = await $.env.get('HOME')
    const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) || (home ? `${home}/.claude` : undefined)
    if (!configDir) return 'hq: neither CLAUDE_CONFIG_DIR nor HOME is set, so there is no themes folder to write to.'
    const path = themePath(configDir, target.slug)
    const exists = await $.fs.exists(path)
    if (!exists && target.base === undefined) return notAFile(target.slug)
    const current = exists ? await $.fs.read(path) : undefined
    const text = withBackground(typeof current === 'string' ? current : undefined, target, hex)
    if (text === undefined) return `hq: ${path} is not a theme JSON object; left as it was.`
    await $.fs.write(path, text)
    return target.base === undefined
      ? `Side panel set to ${hex} in theme ${target.slug}.`
      : `Side panel set to ${hex} in theme ${target.slug}: pick it in /theme once; later runs apply live in every session.`
  } catch (thrown) {
    return `hq: match-bg failed: ${thrown instanceof Error ? thrown.message : String(thrown)}`
  }
}

async function checkUpdate($: EngineInterface): Promise<void> {
  // "Updated to" holds for the whole load; only an "available" line is re-checked.
  if (notice?.kind === 'updated') return
  const trafficOff = Boolean(await $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'))
  const next = await headerNotice(
    install,
    { enabled: config().updateCheck, trafficOff },
    {
      now: await $.clock.now(),
      get: key => $.store.get(key),
      set: (key, value) => $.store.set(key, value),
      fetchManifest: async () => {
        const r = await $.http.fetch(MANIFEST_URL)
        return r.ok ? r.text : undefined
      },
    },
  )
  if (next?.kind !== notice?.kind || next?.version !== notice?.version) {
    notice = next
    await refresh?.()
  }
}

async function startUpdates($: EngineInterface): Promise<void> {
  if (updateTimer !== undefined) return
  install = await readInstall($)
  if (install === undefined) return
  updateTimer = $.clock.every(UPDATE_RECHECK_MS, () => void checkUpdate($).catch(() => undefined))
  await checkUpdate($)
}

async function startPane($: EngineInterface, isInteractive: boolean): Promise<void> {
  let motion: Timer | undefined
  let slow: Timer | undefined
  syncMotion = async () => {
    const m = currentModel()
    const want = isPaneOpen && hasMotion(m)
    if (want && motion === undefined) motion = $.clock.every(2000, () => void update($, phase, n => n + 1))
    else if (!want && motion !== undefined) {
      motion.cancel()
      motion = undefined
    }
    // Idle, nothing animates; the "now" row's age still moves.
    const wantSlow = isPaneOpen && !want && m.current.now?.idle === true
    if (wantSlow && slow === undefined) slow = $.clock.every(IDLE_REDRAW_MS, () => void update($, rev, n => n + 1))
    else if (!wantSlow && slow !== undefined) {
      slow.cancel()
      slow = undefined
    }
  }
  refresh = async () => {
    const m = currentModel()
    $.ui.status(m.statusText ? m.statusText : undefined)
    await update($, rev, n => n + 1)
    await syncMotion?.()
  }
  try {
    isPaneOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
  } catch {
    isPaneOpen = false
  }
  await refresh()

  // Once per session: a reload or /clear must not reopen a pane the person closed.
  if (isInteractive && config().autoOpen && !isPaneOpen && !(await read($, autoOpened))) {
    await update($, autoOpened, () => true)
    try {
      isPaneOpen = (await $.ui.open({ id: PANE, title: 'hq' })).isPlaced
      await syncMotion?.()
      if (!isPaneOpen) $.ui.toast(NARROW_TOAST)
    } catch {
      // no pane on this surface; /hq still opens it
    }
  }

  if (isInteractive) void startUpdates($).catch(() => undefined)

  try {
    await $.command.register({
      name: COMMAND,
      description: 'Pane of what needs you: agents, PRs and other sessions',
      argumentHint: '[close | wake on|off | notify on|off | summaries on|off | update | match-bg <#hex> | help]',
      immediate: true,
    })
  } catch (thrown) {
    $.ui.log(`hq: /${COMMAND} was not registered (${thrown instanceof Error ? thrown.message : String(thrown)})`)
  }
}

/** The cursor goes to a pressed item and the ring to its caret: a click on a title may have sent the ring past it. */
async function follow($: EngineInterface, key: string, last: Layout | undefined): Promise<void> {
  const item = pressedItem(last, key)
  await update($, cursor, () => item)
  if (last?.items.includes(item)) await $.ui.focus({ requestId: PANE, key: caretKey(item) })
}

/** What a press does. Jumps run host commands; everything else only moves /hq's own view. */
export async function act($: EngineInterface, key: string, action: Action, last: Layout | undefined): Promise<void> {
  switch (action.kind) {
    case 'jump': {
      const pressed = await pressJump(action.jump, {
        run: (argv, init) => $.process.run(argv, { timeoutMs: 3000, ...init }),
        copy: text => $.ui.copy({ text }).then(r => r.isCopied),
        toast: text => $.ui.toast(text),
      })
      if (!pressed) return
      await follow($, key, last)
      return
    }
    case 'toggle': {
      await update($, expanded, list => (list.includes(action.id) ? list.filter(id => id !== action.id) : [...list, action.id]))
      await follow($, key, last)
      return
    }
    case 'move': {
      if (!last || last.items.length === 0) return
      let at = 0
      await update($, cursor, current => {
        const i = current === null ? -1 : last.items.indexOf(current)
        at = i < 0 ? (action.dir > 0 ? 0 : last.items.length - 1) : Math.min(last.items.length - 1, Math.max(0, i + action.dir))
        return last.items[at] ?? null
      })
      const target = last.items[at]
      if (target === undefined) return
      const s = scrollFor(last, target, last.scroll)
      if (s !== last.scroll) await update($, scroll, () => s)
      // The target's caret may arrive with the next drawing; focus waits for it.
      await $.ui.focus({ requestId: PANE, key: caretKey(target) })
      return
    }
    case 'scroll': {
      if (!last) return
      const max = Math.max(0, last.bodyLen - last.region)
      const page = Math.max(1, last.region - 2)
      await update($, scroll, () => Math.min(max, Math.max(0, last.scroll + action.dir * page)))
      return
    }
  }
}

function press($: EngineInterface, key: string, action: Action): void {
  void act($, key, action, last)
}

export const register: Register = (on, options) => {
  setConfig(resolveConfig(options))
  installData(on, () => void refresh?.())

  // The data layer owns the unmatched session.start; the pane's start runs under a matcher per session kind.
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    await startPane($, true)
    return next(e)
  })
  on('session.start', { isInteractive: false }, async ($, e, next) => {
    await startPane($, false)
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const args = e.args.trim()
    if (args === '' || args === 'open') {
      const opened = await $.ui.open({ id: PANE, title: 'hq' })
      isPaneOpen = true
      await syncMotion?.()
      return {
        text: opened.isPlaced
          ? 'hq pane opened. ctrl+x tab moves the keys to it, or bind your own chord to abovePrompt:focus.'
          : 'hq pane is waiting for room to draw.',
      }
    }
    if (args === 'close') {
      await $.ui.close({ id: PANE })
      isPaneOpen = false
      await syncMotion?.()
      return { text: 'hq pane closed.' }
    }
    const notify = parseNotifyArg(args)
    if (notify === 'show')
      return { text: `hq notifications are ${effective(await $.store.get(NOTIFY_STORE_KEY), config().notify) ? 'on' : 'off'}.` }
    if (notify !== undefined) {
      await $.store.set(NOTIFY_STORE_KEY, notify)
      return { text: `hq notifications ${notify ? 'on' : 'off'}.` }
    }
    if (args === 'help') return { text: HELP }
    if (args === 'update') {
      const latest = await $.store.get(LATEST_KEY)
      const said = await runUpdate(
        install ?? (await readInstall($)),
        argv => $.process.run(argv, { timeoutMs: 180_000 }),
        typeof latest === 'string' ? latest : undefined,
      )
      $.ui.toast(said, { timeoutMs: 12_000 })
      return {}
    }
    if (args === 'reset') {
      for (const key of [WAKE_KEY, NOTIFY_STORE_KEY, SUMMARIES_KEY]) await $.store.delete(key)
      const c = config()
      const word = (isOn: boolean) => (isOn ? 'on' : 'off')
      return {
        text: `hq toggles reset to the plugin config: wake ${word(c.wake)}, notify ${word(c.notify)}, summaries ${word(c.summaries)}.`,
      }
    }
    const bg = parseMatchBg(args)
    if (bg !== undefined) {
      $.ui.toast(bg === 'usage' ? MATCH_BG_USAGE : await matchBackground($, bg))
      return {}
    }
    const summaries = /^summaries(?:\s+(on|off))?$/.exec(args)
    if (summaries) {
      if (summaries[1] === undefined)
        return { text: `hq summaries are ${effective(await $.store.get(SUMMARIES_KEY), config().summaries) ? 'on' : 'off'}.` }
      await $.store.set(SUMMARIES_KEY, summaries[1] === 'on')
      return { text: `hq summaries ${summaries[1]}.` }
    }
    const toggle = parseWake(args)
    if (toggle !== null) {
      await $.store.set(WAKE_KEY, toggle === 'on')
      return { text: `hq waking is ${toggle}.` }
    }
    return { text: `Unknown subcommand "${args}".\n${HELP}` }
  })

  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE) {
      isPaneOpen = false
      await syncMotion?.()
    }
    return closed
  }).catch(($, e, next) => next(e))

  // Tab, arrows and clicks move the ring. It rests only on carets; the cursor row follows it.
  on('ui.focus', async ($, e, next) => {
    if (e.requestId !== PANE || e.element === undefined || !last) return next(e)
    const move = ringMove(last, await read($, cursor), e)
    if (move && 'scrollTo' in move) {
      // The ring stays put until the item is scrolled in and its caret drawn.
      const target = move.scrollTo
      await update($, cursor, () => target)
      const s = scrollFor(last, target, last.scroll)
      if (s !== last.scroll) await update($, scroll, () => s)
      void $.ui.focus({ requestId: PANE, key: caretKey(target) })
      return {}
    }
    const to = move ? { ...e, element: move.caret } : e
    const moved = await next(to)
    const item = to.element === undefined ? undefined : caretItem(to.element)
    if (moved.deny === undefined && item !== undefined && last.items.includes(item)) await update($, cursor, () => item)
    return moved
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (!isPaneOpen) {
      isPaneOpen = true
      void syncMotion?.()
    }
    await read($, rev)
    const view = {
      width: e.props.bodyColumns,
      rows: e.props.scroll.bodyRows,
      focused: e.props.isFocused,
      cursor: await read($, cursor),
      expanded: await read($, expanded),
      scroll: await read($, scroll),
      phase: await read($, phase),
      ...(config().warning ? { warning: config().warning } : {}),
      ...(notice ? { notice } : {}),
    }
    const l = layout(currentModel(), view)
    last = l
    const shown = (key: string) => l.rows.some(r => r.head && r.item === key)
    const start = view.cursor !== null && shown(view.cursor) ? view.cursor : l.items.find(shown)
    return drawPane(l.rows, {
      el: $.ui.resolve(e),
      tokens: config().tokens,
      ...(start !== undefined ? { autoFocusKey: caretKey(start) } : {}),
      onAction: (key, action) => press($, key, action),
    })
  })
}
