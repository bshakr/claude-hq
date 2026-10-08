import { atom, read, update } from 'claude-code'
import type { Register, Timer } from 'claude-code'

import type { WaveRow } from '../types'
import {
  POLL_MS,
  detectTransitions,
  dropExpired,
  firstLine,
  ownedFrom,
  ownedRows,
  ownedTransitions,
  parseWake,
  repoOfUrl,
  rowFromPr,
  sortRows,
  statusLine,
  toastText,
  wakePrompt,
} from './logic'
import type { GhPr, GhSearchHit } from './logic'
import { DEFAULT_STYLE, STYLES, styleById } from './styles/index'

const PANE = 'wave'
const COMMAND = 'prs'
const VIEW_FIELDS =
  'number,title,url,state,isDraft,mergeable,mergeStateStatus,statusCheckRollup,body,headRefName,baseRefName'
const PARALLEL = 6

const rows = atom({ plugin: 'wave-watcher', key: 'rows' } as const, [])
const polledAt = atom({ plugin: 'wave-watcher', key: 'polledAt' } as const, null)
const error = atom({ plugin: 'wave-watcher', key: 'error' } as const, null)
const wake = atom({ plugin: 'wave-watcher', key: 'wake' } as const, true)
const now = atom({ plugin: 'wave-watcher', key: 'now' } as const, 0)
const styleId = atom({ plugin: 'wave-watcher', key: 'style' } as const, DEFAULT_STYLE)
const tick = atom({ plugin: 'wave-watcher', key: 'tick' } as const, 0)

const HELP = [
  '/prs              open the PR pane',
  '/prs refresh      poll GitHub now',
  '/prs wake on      wake the session on CI red, merges, conflicts and rebases (default)',
  '/prs wake off     toasts only, never start a turn',
  '/prs style        list pane styles',
  '/prs style <id>   switch the pane style',
  '/prs help         this list',
].join('\n')

function styleList(active: string): string {
  const lines = STYLES.map(
    one => `${one.meta.id === active ? '*' : ' '} ${one.meta.id.padEnd(8)} ${one.meta.name}: ${one.meta.tagline}`,
  )
  return ['Pane styles (* active):', ...lines].join('\n')
}

type Gh<T> = { ok: true; value: T } | { ok: false; error: string }

async function inBatches<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += PARALLEL) {
    out.push(...(await Promise.all(items.slice(i, i + PARALLEL).map(fn))))
  }
  return out
}

export const register: Register = on => {
  // The engine refuses `$` being passed or stored, so these are closures built
  // in session.start that other hooks reach through.
  let pollNow: (() => Promise<void>) | undefined
  let syncAnim: (() => Promise<void>) | undefined
  let refreshStatus: (() => Promise<void>) | undefined
  let isPaneOpen = false

  on('session.start', async ($, e, next) => {
    const storedWake = await $.store.get('wake')
    await update($, wake, () => storedWake !== false)
    const storedStyle = await $.store.get('style')
    const initialStyle =
      typeof storedStyle === 'string' && styleById(storedStyle) ? storedStyle : DEFAULT_STYLE
    await update($, styleId, () => initialStyle)

    const gh = async <T,>(argv: string[]): Promise<Gh<T>> => {
      try {
        const ran = await $.process.run(['gh', ...argv], { timeoutMs: 30_000 })
        if (ran.exitCode !== 0) {
          return { ok: false, error: `gh failed: ${firstLine(ran.stderr) || `exit ${ran.exitCode}`}` }
        }
        return { ok: true, value: JSON.parse(ran.stdout) as T }
      } catch (thrown) {
        const message = thrown instanceof Error ? thrown.message : String(thrown)
        return { ok: false, error: `gh failed: ${firstLine(message)}` }
      }
    }

    // Asked on every call: a /clear moves the session to a new id without a fresh session.start.
    const ownedPrs = async (): Promise<Set<string> | null> => {
      try {
        const home = (await $.env.get('HOME')) ?? ''
        const sessionId = await $.session.id()
        return ownedFrom(await $.fs.read(`${home}/.claude/hq/sessions/${sessionId}.json`))
      } catch {
        return null
      }
    }

    const pollOnce = async (): Promise<void> => {
      const at = await $.clock.now()
      const search = await gh<GhSearchHit[]>([
        'search', 'prs', '--author=@me', '--state=open',
        '--json', 'number,repository,title,url', '--limit', '30',
      ])
      if (!search.ok) {
        await update($, error, () => search.error)
        await refreshStatus?.()
        return
      }

      const hasPolled = (await read($, polledAt)) !== null
      const previous = await read($, rows)
      const byUrl = new Map(previous.map(row => [row.url, row]))
      const openUrls = new Set(search.value.map(hit => hit.url))
      let lastError: string | null = null

      const view = async (url: string, repo: string, number: number): Promise<WaveRow | null | undefined> => {
        const got = await gh<GhPr>(['pr', 'view', String(number), '-R', repo, '--json', VIEW_FIELDS])
        if (!got.ok) {
          lastError = got.error
          return byUrl.get(url)
        }
        return rowFromPr(got.value, repo, at, byUrl.get(url))
      }

      const open = await inBatches(search.value, hit =>
        view(hit.url, hit.repository.nameWithOwner, hit.number),
      )
      // Left the open list since last poll: one re-check tells merged from closed.
      const vanished = previous.filter(row => row.status === 'open' && !openUrls.has(row.url))
      const rechecked = await inBatches(vanished, row =>
        view(row.url, row.repo || repoOfUrl(row.url), row.number),
      )
      const keptMerged = previous.filter(row => row.status === 'merged' && !openUrls.has(row.url))

      const all = [...open, ...rechecked, ...keptMerged].filter((row): row is WaveRow => row != null)
      const nextRows = sortRows(dropExpired(all, at))
      const transitions = detectTransitions(hasPolled ? previous : null, nextRows)

      await update($, rows, () => nextRows)
      await update($, polledAt, () => at)
      await update($, now, () => at)
      await update($, error, () => lastError)
      await refreshStatus?.()
      await syncAnim?.()

      for (const transition of transitions) $.ui.toast(toastText(transition), { timeoutMs: 8000 })
      // Every session toasts; only the session that owns a PR (HQ's ADR 0002) is woken for it.
      const prompt = transitions.length > 0 ? wakePrompt(ownedTransitions(transitions, (await ownedPrs()) ?? new Set())) : null
      if (prompt !== null && (await read($, wake))) {
        void $.prompt.submit({ text: prompt })
      }
    }

    let isPolling = false
    const poll = async (): Promise<void> => {
      if (isPolling) return
      isPolling = true
      try {
        await pollOnce()
      } finally {
        isPolling = false
      }
    }
    pollNow = poll

    refreshStatus = async () => {
      const mine = ownedRows(await read($, rows), await ownedPrs())
      const error_ = await read($, error)
      if (mine === null || (mine.length === 0 && error_ === null)) {
        $.ui.status(undefined)
        return
      }
      const active = styleById(await read($, styleId))
      const ctx = {
        rows: mine,
        polledAt: await read($, polledAt),
        error: error_,
        now: await read($, now),
      }
      $.ui.status(active?.status ? active.status(ctx) : statusLine(ctx.rows, ctx.error))
    }

    let anim: Timer | undefined
    syncAnim = async () => {
      const wantsMotion =
        isPaneOpen &&
        styleById(await read($, styleId))?.meta.animated === true &&
        (await read($, rows)).some(row => row.status === 'open' && row.ci.kind === 'running')
      if (wantsMotion && anim === undefined) {
        anim = $.clock.every(1000, () => void update($, tick, n => n + 1))
      } else if (!wantsMotion && anim !== undefined) {
        anim.cancel()
        anim = undefined
      }
    }

    // Polling starts before the command is registered so a refused name never stops it.
    $.clock.every(POLL_MS, () => void poll())
    // Only the 1 s timer moves `tick`, so the two never coincide into a 2-step jump.
    $.clock.every(10_000, () => {
      void $.clock.now().then(t => update($, now, () => t))
      void syncAnim?.()
      // HQ republishes ownership between polls, and a /clear changes whose file applies.
      void refreshStatus?.()
    })
    // A hot reload re-runs this with the pane still up; the engine's record says so.
    try {
      isPaneOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
    } catch {
      isPaneOpen = false
    }
    void poll()

    try {
      await $.command.register({
        name: COMMAND,
        description: 'Pane of your open PRs: CI, merge, rebase and gallery state',
        argumentHint: '[refresh | wake on|off | style [id] | help]',
        immediate: true,
      })
    } catch (thrown) {
      const message = thrown instanceof Error ? thrown.message : String(thrown)
      $.ui.log(`wave-watcher: /${COMMAND} was not registered (${firstLine(message)}); polling continues.`)
    }

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const args = e.args.trim()
    if (args === '') {
      const opened = await $.ui.open({ id: PANE, title: 'Wave' })
      isPaneOpen = true
      await syncAnim?.()
      return { text: opened.isPlaced ? 'PR pane opened.' : 'PR pane is waiting for room to draw.' }
    }
    if (args === 'refresh') {
      if (pollNow === undefined) return { text: 'wave-watcher has not started yet.' }
      void pollNow()
      return { text: 'Polling GitHub now.' }
    }
    if (args === 'help') return { text: HELP }
    if (args === 'style') return { text: styleList(await read($, styleId)) }
    const styleArg = /^style\s+(\S+)$/.exec(args)
    if (styleArg) {
      const id = styleArg[1] ?? ''
      const chosen = styleById(id)
      if (chosen === undefined) {
        return { text: `Unknown style "${id}"; nothing changed.\n${styleList(await read($, styleId))}` }
      }
      await $.store.set('style', id)
      await update($, styleId, () => id)
      await refreshStatus?.()
      await syncAnim?.()
      return { text: `Pane style is now ${chosen.meta.id} (${chosen.meta.name}).` }
    }
    const toggle = parseWake(args)
    if (toggle !== null) {
      await $.store.set('wake', toggle === 'on')
      await update($, wake, () => toggle === 'on')
      return { text: `wave-watcher waking is ${toggle}.` }
    }
    return { text: `Unknown subcommand "${args}".\n${HELP}` }
  })

  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE) {
      isPaneOpen = false
      await syncAnim?.()
    }
    return closed
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (!isPaneOpen) {
      isPaneOpen = true
      void syncAnim?.()
    }
    const active = styleById(await read($, styleId)) ?? styleById(DEFAULT_STYLE)
    if (active === undefined) throw new Error(`wave-watcher: no "${DEFAULT_STYLE}" style registered`)
    return active.render({
      rows: await read($, rows),
      polledAt: await read($, polledAt),
      now: await read($, now),
      error: await read($, error),
      isWaking: await read($, wake),
      width: e.props.bodyColumns,
      bodyRows: e.props.scroll.bodyRows,
      placement: e.props.placement,
      isFocused: e.props.isFocused,
      tick: await read($, tick),
      el: $.ui.resolve(e),
      surface: e.surface,
    })
  })
}
