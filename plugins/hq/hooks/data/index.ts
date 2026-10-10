import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { AccountUsage, HqModel, OtherAgentVM, PublishedSession, TermEnv, WaitVM } from '../model/types'
import { isLive, onSpawn, onSubagentStep, onTaskNotification, onTurnComplete, prune, reconcile, settleQuiet } from './agents'
import type { AgentsState, ListedAgent } from './agents'
import { emptyActivity, notificationsOf, onPrompt, onTurnEnd, todosOf, nowOf } from './activity'
import type { ActivityState } from './activity'
import { repoOfRemote } from './claims'
import {
  CHUNK_BYTES,
  GOAL_MODEL,
  HEAD_BYTES,
  PR_REFRESH_MS,
  TAIL_BYTES as DIGEST_TAIL_BYTES,
  dayOf,
  emptyDigest,
  goalDue,
  goalText,
  ingest,
  ingestLines,
  jumpTitlesOf,
  parsePrStates,
  prKey as prStateKey,
  prStateQuery,
  prText,
  prsToLook,
  refreshGoal,
  todoProgress,
} from './context'
import type { Digest, GoalCache, PrState } from './context'
import {
  PUBLISH_FRESH_MS,
  buildFleet,
  findSelf,
  isOtherRow,
  pairsOf,
  parsePsPids,
  parsePublished,
  parseRegistryRow,
  selfTmux,
  splitTmux,
  transcriptPath,
} from './fleet'
import type { RegistryRow, SessionContext, SessionTopic } from './fleet'
import {
  ADR_LOOKUPS_PER_TICK,
  GLOSS_MODEL,
  TICKET_LOOKUPS_PER_TICK,
  briefBatch,
  briefDue,
  findIds,
  glossOf,
  lookUpAdr,
  lookUpTicket,
  lookupDue as idLookupDue,
} from './ids'
import type { GlossEntry, IdRef } from './ids'
import { doingLine, prSummary } from './model'
import {
  OPEN_CALL_CAP_MS,
  OTHER_AGENTS_MAX,
  TAIL_BYTES,
  freshTranscripts,
  isRunning,
  longCall,
  otherAgents,
  parseMeta,
  parseTail,
  subagentsDir,
} from './subagents'
import type { AgentMeta, AgentTail, ListedFile, RunningAgent } from './subagents'
import { accountOf, live, preferred, sampleOf, settingsModel } from './usage'
import { BRANCH_TTL_MS, PUBLISH_MS, S, TICK_MS, afterTool, beforeTool, rebuild, storeKey, tokensOf } from './observe'
import { parsePsTerm } from './term'
import { MERGED_KEEP_MS, WATCHERS, claimKey, isEnded, parseStateFile, prFromSources, stateFileName } from './prs'
import type { BranchClaim, OwnedState, PrFiles, StoredClaim } from './prs'
import { W, installWaits, loopOf, onCallEnd, onCallStart, onLoopEnd, onMainAnswer, onPromptOrigin, otherWait, ownWait } from './waiting'
import { NOTIFIED_PRUNE_MS, NOTIFY_STORE_KEY, NOTIFY_TITLE, claimName, dueNotifications, notifyWaits } from './notify'
import { WAKE_KEY, newsOf } from './wake'
import { SUMMARIES_NOTICE, SUMMARIES_NOTICE_KEY, WAKE_NOTICE_KEY, noticeOnce, wakeNotice } from './notices'
import { SUMMARIES_KEY, config, effective } from '../config'

/** An owned PR with no live watcher is re-read from GitHub this often. */
export const REFRESH_MS = 120_000
/** An owned branch with no open PR yet is looked up after 2 min, then 10, then every 30; a push resets it. */
export const LOOKUP_BACKOFF_MS = [120_000, 600_000, 1_800_000] as const

export function lookupDue(b: Pick<BranchClaim, 'lookedAt' | 'misses'>, now: number): boolean {
  if (b.lookedAt === undefined) return true
  const wait = LOOKUP_BACKOFF_MS[Math.min(Math.max(0, (b.misses ?? 0) - 1), LOOKUP_BACKOFF_MS.length - 1)]!
  return now - b.lookedAt >= wait
}
/** A branch claim that never got a PR is dropped after this. */
export const BRANCH_KEEP_MS = 24 * 60 * 60_000
/** Lines a sparse scan of a large transcript keeps: titles, PR links, compactions, task-list calls. */
export const SPARSE_RE =
  '"type":"(ai-title|custom-title|pr-link)"|"isCompactSummary":true|"name":"(TaskCreate|TaskUpdate|TodoWrite)"|"toolUseResult":\\{"task"'
const DEFAULT_BRANCHES = new Set(['main', 'master'])
/** Ids per session looked up from its transcript (for the goal input) and from its shown lines. */
export const DIGEST_IDS_MAX = 6
export const VISIBLE_IDS_MAX = 10
/** How long a first goal summary waits for the ids it names to resolve. */
export const ID_WAIT_MS = 20_000

type IdState = { glosses: Record<string, string>; titles: string[]; pending: boolean }

const ownedAtom = atom({ plugin: 'hq', key: 'owned' } as const, { claims: [], branches: [] })
const activityAtom = atom({ plugin: 'hq', key: 'activity' } as const, emptyActivity())

export function currentModel(): HqModel {
  return S.model
}

export function installData(on: On, onChange: () => void): void {
  S.onChange = onChange
  installWaits(on)

  on('session.start', async ($, e, next) => {
    try {
      await start($)
    } catch {
      // a failed start leaves the empty model; the pane still loads
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const now = await $.clock.now()
    const r = await next(e)
    try {
      const got = r as { agentId?: string; model?: string; deny?: string }
      if (!got.deny && got.agentId) {
        S.now = now
        onSpawn(
          S.agents,
          {
            toolUseId: e.tool_use_id,
            description: e.description,
            background: e.background,
            ...(e.model ? { model: e.model } : {}),
            ...(e.parentAgentId ? { parentAgentId: e.parentAgentId } : {}),
            ...(e.cwd ? { cwd: e.cwd } : {}),
          },
          got.agentId,
          got.model,
          now,
        )
        S.dirty = true
        rebuild()
      }
    } catch {
      // observation only
    }
    return r
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    try {
      S.now = await $.clock.now()
      beforeTool(input)
      onCallStart(e.tool_use_id, e.tool, loopOf(e.agentId), e, S.now)
    } catch {
      // observation only
    }
    let r: Awaited<ReturnType<typeof next>>
    try {
      r = await next(e)
    } finally {
      onCallEnd(e.tool_use_id, e.tool, loopOf(e.agentId))
    }
    try {
      S.now = await $.clock.now()
      afterTool(input, r as unknown as Record<string, unknown>)
      S.dirty = true
    } catch {
      // observation only
    }
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    try {
      onPromptOrigin(e.origin?.kind)
      S.now = await $.clock.now()
      onPrompt(S.activity, e.text, e.origin?.kind, S.now)
      if (e.origin?.kind === 'task-notification') onTaskNotification(S.agents, notificationsOf(e.text), S.now)
      if (S.activity.prompt !== undefined && e.origin?.kind !== 'task-notification') S.activity.idle = false
      S.dirty = true
      rebuild()
    } catch {
      // observation only
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    if (e.agentId && r?.usage) {
      try {
        const u = sampleOf({ usage: r.usage, model: r.usage.model }, 0)
        if (onSubagentStep(S.agents, e.agentId, u?.tokens, u?.model)) {
          S.dirty = true
          rebuild()
        }
      } catch {
        // observation only
      }
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    onLoopEnd(loopOf(e.agentId))
    if (!e.agentId) {
      try {
        S.now = await $.clock.now()
        onTurnEnd(S.activity, S.now)
        onMainAnswer(e.answer, e.reason, S.now)
        S.dirty = true
        rebuild()
      } catch {
        // observation only
      }
    }
    if (e.agentId) {
      try {
        S.now = await $.clock.now()
        if (onTurnComplete(S.agents, e.agentId, e.reason, e.answer, tokensOf(e.usage), S.now)) {
          S.dirty = true
          rebuild()
        }
      } catch {
        // observation only
      }
    }
    return next(e)
  })
}

let started = false

async function start($: EngineInterface): Promise<void> {
  S.sessionId = await $.session.id()
  S.home = (await $.env.get('HOME')) ?? ''
  S.now = await $.clock.now()
  // A second session.start in one load (/clear, resume) only re-reads the id; the tick runs once.
  if (started) return
  started = true
  const restore = (o: OwnedState | undefined) => {
    if (!o || !Array.isArray(o.claims) || !Array.isArray(o.branches)) return false
    for (const c of o.claims) if (c && typeof c.repo === 'string' && typeof c.number === 'number') S.claims[claimKey(c.repo, c.number)] = c
    for (const b of o.branches)
      if (b && typeof b.repo === 'string' && typeof b.branch === 'string') S.branches[branchKey(b.repo, b.branch)] = b
    return o.claims.length + o.branches.length > 0
  }
  if (!restore(await read($, ownedAtom))) restore((await $.store.get(storeKey('owned'))) as OwnedState | undefined)
  const act = (await read($, activityAtom)) as ActivityState | undefined
  if (act && Array.isArray(act.bg)) S.activity = { ...emptyActivity(), ...act }
  const storedAgents = (await $.store.get(storeKey('agents'))) as AgentsState | undefined
  if (storedAgents && typeof storedAgents === 'object' && storedAgents.byId) {
    S.agents = {
      byId: { ...storedAgents.byId, ...S.agents.byId },
      byToolUse: { ...storedAgents.byToolUse, ...S.agents.byToolUse },
      pruned: [...new Set([...(S.agents.pruned ?? []), ...(Array.isArray(storedAgents.pruned) ? storedAgents.pruned : [])])],
    }
  }

  const notice = (key: string, text: string) =>
    noticeOnce({ get: k => $.store.get(k), set: (k, v) => $.store.set(k, v), toast: t => $.ui.toast(t, { timeoutMs: 12_000 }) }, key, text)

  const repoCache = new Map<string, string | null>()
  const branchCache = new Map<string, { at: number; branch: string | undefined }>()
  const digests = new Map<string, { path: string; d: Digest }>()
  const goals = new Map<string, GoalCache | undefined>()
  const goalInflight = new Set<string>()
  const glossCache = new Map<string, GlossEntry | undefined>()
  const glossInflight = new Set<string>()
  const idWaitSince = new Map<string, number>()
  let briefInflight = false
  // Re-read each tick: a /hq summaries toggle takes effect without a reload.
  let summaries = config().summaries
  const budget = { ticket: 0, adr: 0 }
  const toplevels = new Map<string, string>()
  const prStates = new Map<string, { state: PrState; title?: string; at: number }>()
  const repoLooked = new Map<string, number>()
  const tails = new Map<string, { mtimeMs: number; size: number; tail: AgentTail }>()
  const metas = new Map<string, AgentMeta>()
  // Last values written to $.state / $.store; a tick writes only what changed.
  let written = { id: '', owned: '', activity: '', agents: '' }
  let publishedAt = 0
  let publishedId = ''
  let publishedWaitRev = -1
  const notified = new Set<string>()
  let notifying = false
  let prunedAt = 0
  let isTicking = false
  let selfPid: number | undefined
  // Per pid: a process's terminal does not change while it lives.
  const terms = new Map<number, TermEnv>()
  const settingsCache = new Map<string, { at: number; model: string | undefined }>()
  let ownAccount: AccountUsage | undefined

  const run = async (argv: string[], cwd?: string) => {
    try {
      return await $.process.run(argv, { timeoutMs: 15_000, ...(cwd ? { cwd } : {}) })
    } catch {
      return undefined
    }
  }
  const readText = async (path: string) => {
    try {
      return await $.fs.read(path)
    } catch {
      return undefined
    }
  }
  const expand = (p: string) => (p.startsWith('~') && S.home ? S.home + p.slice(1) : p)

  const repoForDir = async (dir: string): Promise<string | undefined> => {
    if (!repoCache.has(dir)) {
      const r = await run(['git', 'remote', 'get-url', 'origin'], dir)
      repoCache.set(dir, r && r.exitCode === 0 ? (repoOfRemote(r.stdout) ?? null) : null)
    }
    return repoCache.get(dir) ?? undefined
  }
  const branchOf = async (dir: string): Promise<string | undefined> => {
    const hit = branchCache.get(dir)
    if (hit && S.now - hit.at < BRANCH_TTL_MS) return hit.branch
    const r = await run(['git', 'branch', '--show-current'], dir)
    const branch = r && r.exitCode === 0 ? r.stdout.trim() || undefined : undefined
    branchCache.set(dir, { at: S.now, branch })
    return branch
  }

  const own = (repo: string, number: number, claimedBy: string, reason: StoredClaim['reason']) => {
    const key = claimKey(repo, number)
    if (S.claims[key]) return S.claims[key]!
    S.claims[key] = { repo, number, claimedBy, claimedAt: S.now, ...(reason ? { reason } : {}) }
    S.dirty = true
    return S.claims[key]!
  }
  const ownBranch = (repo: string, branch: string, claimedBy: string, reason: BranchClaim['reason']) => {
    if (DEFAULT_BRANCHES.has(branch)) return
    const key = branchKey(repo, branch)
    if (S.branches[key]) return
    S.branches[key] = { repo, branch, claimedBy, claimedAt: S.now, reason }
    S.dirty = true
  }

  const resolvePending = async (sessionCwd: string) => {
    const batch = S.pending.splice(0)
    for (const p of batch) {
      if (p.kind === 'created') {
        own(p.repo, p.number, p.claimedBy, 'created')
        continue
      }
      const dir = expand(p.dir ?? sessionCwd)
      const repo = p.repo ?? (await repoForDir(dir))
      if (!repo) continue
      if (p.kind === 'merged') {
        const claim = S.claims[claimKey(repo, p.number)]
        if (claim) {
          claim.ghState = 'MERGED'
          claim.checkedAt = S.now
          S.dirty = true
        }
        continue
      }
      const branch = p.branch ?? (await branchOf(dir))
      if (!branch) continue
      ownBranch(repo, branch, p.claimedBy, 'pushed')
      const pushed = S.branches[branchKey(repo, branch)]
      if (pushed && pushed.number === undefined && (pushed.misses || pushed.lookedAt !== undefined)) {
        delete pushed.misses
        delete pushed.lookedAt
        S.dirty = true
      }
    }
  }

  // Rule (b): the branch checked out where the session or one of its agents works.
  const claimCheckouts = async (sessionCwd: string) => {
    const dirs: [string, string][] = [[sessionCwd, 'main']]
    for (const a of Object.values(S.agents.byId)) if (a.root) dirs.push([a.root, a.id])
    for (const d of S.dirs) dirs.push([expand(d.dir), d.by])
    const seen = new Set<string>()
    for (const [dir, by] of dirs) {
      if (seen.has(dir)) continue
      seen.add(dir)
      const repo = await repoForDir(dir)
      const branch = repo ? await branchOf(dir) : undefined
      if (repo && branch) ownBranch(repo, branch, by, 'checkout')
    }
  }

  const lookUpBranches = async () => {
    for (const [key, b] of Object.entries(S.branches)) {
      if (b.number !== undefined) continue
      if (S.now - b.claimedAt > BRANCH_KEEP_MS) {
        delete S.branches[key]
        S.dirty = true
        continue
      }
      if (!lookupDue(b, S.now)) continue
      b.lookedAt = S.now
      S.dirty = true
      const r = await run([
        'gh',
        'pr',
        'list',
        '-R',
        b.repo,
        '--head',
        b.branch,
        '--state',
        'open',
        '--json',
        'number,title,url,state',
        '--limit',
        '1',
      ])
      if (!r || r.exitCode !== 0) continue
      try {
        const [hit] = JSON.parse(r.stdout) as { number?: number; title?: string; url?: string; state?: string }[]
        if (!hit || typeof hit.number !== 'number') {
          b.misses = (b.misses ?? 0) + 1
          continue
        }
        b.number = hit.number
        const claim = own(b.repo, hit.number, b.claimedBy, b.reason)
        if (hit.title) claim.title = hit.title
        if (hit.url) claim.url = hit.url
        if (hit.state) claim.ghState = hit.state
        claim.checkedAt = S.now
      } catch {
        // looked up again later
      }
    }
  }

  const readPrStates = async (): Promise<Map<string, PrFiles>> => {
    const files = new Map<string, PrFiles>()
    for (const [key, claim] of Object.entries(S.claims)) {
      const pair: PrFiles = {}
      for (const watcher of WATCHERS) {
        const text = await readText(`${S.home}/.cache/pr-watch/${stateFileName(claim.repo, claim.number, watcher)}`)
        const file = text === undefined ? undefined : parseStateFile(text)
        if (file) pair[watcher === 'ci-wait' ? 'ci' : 'merge'] = file
      }
      if (pair.ci || pair.merge) files.set(key, pair)
    }
    return files
  }

  // Watchers are the poller while they run; an owned PR without one is re-read here so a merge is seen.
  const refreshUnwatched = async (files: Map<string, PrFiles>, alive: ReadonlySet<number>) => {
    for (const [key, claim] of Object.entries(S.claims)) {
      if (claim.endedAt !== undefined) continue
      const pair = files.get(key)
      const watched = [pair?.ci, pair?.merge].some(f => f !== undefined && !f.exited && alive.has(f.pid))
      if (watched) continue
      if (claim.checkedAt !== undefined && S.now - claim.checkedAt < REFRESH_MS) continue
      claim.checkedAt = S.now
      S.dirty = true
      const r = await run(['gh', 'pr', 'view', String(claim.number), '-R', claim.repo, '--json', 'title,url,state'])
      if (!r || r.exitCode !== 0) continue
      try {
        const v = JSON.parse(r.stdout) as { title?: string; url?: string; state?: string }
        if (v.title) claim.title = v.title
        if (v.url) claim.url = v.url
        if (v.state) claim.ghState = v.state
      } catch {
        // keep what it had
      }
    }
  }

  // User, project, then local settings: the last that names a model wins.
  const settingModelFor = async (cwd: string): Promise<string | undefined> => {
    let model: string | undefined
    for (const path of [`${S.home}/.claude/settings.json`, `${cwd}/.claude/settings.json`, `${cwd}/.claude/settings.local.json`]) {
      let hit = settingsCache.get(path)
      if (!hit || S.now - hit.at >= BRANCH_TTL_MS) {
        hit = { at: S.now, model: settingsModel(await readText(path)) }
        settingsCache.set(path, hit)
      }
      model = hit.model ?? model
    }
    return model
  }

  // A transcript is read once in full (sparsely when large), then only the bytes appended since.
  const digestOf = async (sessionId: string, cwd: string): Promise<Digest | undefined> => {
    const path = transcriptPath(S.home, cwd, sessionId)
    let size: number
    try {
      size = (await $.fs.stat(path)).size
    } catch {
      return digests.get(sessionId)?.d
    }
    let hit = digests.get(sessionId)
    if (!hit || hit.path !== path || size < hit.d.offset) {
      hit = { path, d: emptyDigest() }
      digests.set(sessionId, hit)
    }
    const d = hit.d
    const delta = size - d.offset
    if (delta <= 0) return d
    if (delta > CHUNK_BYTES) {
      if (d.offset === 0) {
        const head = await run(['head', '-c', String(HEAD_BYTES), path])
        if (head && head.exitCode === 0) ingestLines(d, head.stdout.slice(0, head.stdout.lastIndexOf('\n') + 1))
      }
      const sparse = await run(['grep', '-E', SPARSE_RE, path])
      if (sparse && sparse.exitCode === 0) ingestLines(d, sparse.stdout)
      const br = await run(['grep', '-o', '-E', '"gitBranch":"[^"]*"', path])
      if (br && br.exitCode === 0)
        ingestLines(d, [...new Set(br.stdout.split('\n').filter(Boolean))].map(l => `{"type":"user","isMeta":true,${l}}`).join('\n'))
      const tail = await run(['tail', '-c', String(DIGEST_TAIL_BYTES), path])
      // A question seen in the head may have its answer in the unread middle.
      delete d.ask
      if (tail && tail.exitCode === 0) ingestLines(d, tail.stdout, size > DIGEST_TAIL_BYTES)
      d.offset = size
      d.carry = ''
      return d
    }
    const r = await run(['tail', '-c', `+${d.offset + 1}`, path])
    if (r && r.exitCode === 0 && !r.isStdoutTruncated) ingest(d, r.stdout)
    return d
  }

  // Merged and closed are final; an open PR is looked up again after PR_REFRESH_MS, one GraphQL call per repo.
  const lookUpPrStates = async (d: Digest) => {
    const due = new Map<string, number[]>()
    for (const p of prsToLook(d)) {
      const hit = prStates.get(prStateKey(p.repo, p.number))
      if (hit && (hit.state !== 'OPEN' || S.now - hit.at < PR_REFRESH_MS)) continue
      if (S.now - (repoLooked.get(p.repo) ?? 0) < PR_REFRESH_MS) continue
      due.set(p.repo, [...(due.get(p.repo) ?? []), p.number])
    }
    for (const [repo, numbers] of due) {
      repoLooked.set(repo, S.now)
      const ask: number[] = []
      for (const n of numbers) {
        let final: PrState | undefined
        for (const w of WATCHERS) {
          const f = parseStateFile((await readText(`${S.home}/.cache/pr-watch/${stateFileName(repo, n, w)}`)) ?? '')
          if (f && f.state !== 'OPEN') final = f.state
        }
        if (final) prStates.set(prStateKey(repo, n), { state: final, at: S.now })
        else ask.push(n)
      }
      const query = prStateQuery(repo, ask)
      if (!query) continue
      const r = await run(['gh', 'api', 'graphql', '-f', `query=${query}`])
      if (!r || r.exitCode !== 0) continue
      for (const [n, v] of parsePrStates(r.stdout)) prStates.set(prStateKey(repo, n), { ...v, at: S.now })
    }
  }

  const statesOf = (d: Digest) => {
    const m = new Map<string, PrState>()
    for (const p of d.prs) {
      const hit = prStates.get(prStateKey(p.repo, p.number))
      if (hit) m.set(prStateKey(p.repo, p.number), hit.state)
    }
    return m
  }

  const goalKey = (sid: string) => `goal:${sid}`

  // One model call at a time across sessions, never awaited by the tick.
  const maybeGoal = async (sid: string, d: Digest, busy: boolean, ids: IdState): Promise<GoalCache | undefined> => {
    if (!summaries) return undefined
    if (!goals.has(sid)) goals.set(sid, (await $.store.get(goalKey(sid))) as GoalCache | undefined)
    const c = goals.get(sid)
    // A summary waits a little for the ids it names, so it can say what they are.
    if (!ids.pending) idWaitSince.delete(sid)
    else if (!idWaitSince.has(sid)) idWaitSince.set(sid, S.now)
    const waiting = ids.pending && S.now - idWaitSince.get(sid)! < ID_WAIT_MS
    if (goalInflight.size > 0 || waiting || !goalDue(c, d, busy, S.now)) return c
    // Another HQ instance may have refreshed it; its write doubles as a lease.
    const stored = (await $.store.get(goalKey(sid))) as GoalCache | undefined
    if (stored && (stored.at > (c?.at ?? 0) || (stored.failedAt ?? 0) > (c?.failedAt ?? 0))) {
      goals.set(sid, stored)
      if (!goalDue(stored, d, busy, S.now)) return stored
    }
    const base = goals.get(sid)
    goalInflight.add(sid)
    await $.store.set(goalKey(sid), { ...(base ?? { at: 0 }), failedAt: S.now })
    const prTitles = d.prs.flatMap(p => prStates.get(prStateKey(p.repo, p.number))?.title ?? []).slice(-12)
    void notice(SUMMARIES_NOTICE_KEY, SUMMARIES_NOTICE)
    void refreshGoal(d, base, { prTitles, idTitles: ids.titles }, S.now, req =>
      $.model.complete({ model: GOAL_MODEL, system: req.system, prompt: req.prompt, maxTokens: 200, effort: 'low', timeoutMs: 30_000 }),
    )
      .then(async next => {
        goals.set(sid, next)
        await $.store.set(goalKey(sid), next)
        S.dirty = true
      })
      .catch(() => {})
      .finally(() => goalInflight.delete(sid))
    return base
  }

  // ---------- id glosses ----------

  const toplevelOf = async (cwd: string): Promise<string> => {
    const hit = toplevels.get(cwd)
    if (hit !== undefined) return hit
    const r = await run(['git', 'rev-parse', '--show-toplevel'], cwd)
    const top = (r && r.exitCode === 0 && r.stdout.trim()) || cwd
    toplevels.set(cwd, top)
    return top
  }
  const glossKey = (ref: IdRef, root: string) => (ref.kind === 'ticket' ? `gloss:${ref.id}` : `gloss:adr:${root}:${ref.num}`)
  const fsFor = {
    list: async (dir: string) => {
      try {
        return await $.fs.list(dir)
      } catch {
        return undefined
      }
    },
    read: readText,
  }

  // Lookups are launched, never awaited: the card shows the bare id until one lands.
  const launchLookup = (key: string, ref: IdRef, root: string) => {
    const prev = glossCache.get(key)
    glossInflight.add(key)
    const job = ref.kind === 'ticket' ? lookUpTicket(ref.id, prev, S.now, argv => run(argv)) : lookUpAdr(root, ref.num, prev, S.now, fsFor)
    void job
      .then(async next => {
        glossCache.set(key, next)
        S.dirty = true
        await $.store.set(key, next)
      })
      .catch(() => {})
      .finally(() => glossInflight.delete(key))
  }

  /** Glosses and titles of the ids in `texts`, at most `max`; due lookups are started within the tick's budget. */
  const idsOf = async (cwd: string, texts: readonly string[], max: number): Promise<IdState> => {
    const refs = findIds(texts.filter(Boolean).join('\n')).slice(0, max)
    const out: IdState = { glosses: {}, titles: [], pending: false }
    if (refs.length === 0 || !summaries) return out
    const root = refs.some(r => r.kind === 'adr') ? await toplevelOf(cwd) : cwd
    for (const ref of refs) {
      const key = glossKey(ref, root)
      if (!glossCache.has(key)) glossCache.set(key, (await $.store.get(key)) as GlossEntry | undefined)
      const e = glossCache.get(key)
      if (!glossInflight.has(key) && idLookupDue(e, S.now)) {
        const kind = ref.kind
        if (budget[kind] < (kind === 'ticket' ? TICKET_LOOKUPS_PER_TICK : ADR_LOOKUPS_PER_TICK)) {
          budget[kind]++
          launchLookup(key, ref, root)
        }
      }
      if (glossInflight.has(key) || e === undefined) out.pending = true
      const g = glossOf(e)
      if (g) out.glosses[ref.id] = g
      if (e?.title) out.titles.push(`${ref.id}: ${e.title}`)
    }
    return out
  }

  /** One batched model call for every title still without a brief. */
  const launchBriefs = () => {
    if (briefInflight || !summaries) return
    const due = new Map([...glossCache].filter((kv): kv is [string, GlossEntry] => briefDue(kv[1], S.now)))
    if (due.size === 0) return
    briefInflight = true
    void notice(SUMMARIES_NOTICE_KEY, SUMMARIES_NOTICE)
    void briefBatch(due, S.now, req =>
      $.model.complete({
        model: GLOSS_MODEL,
        system: req.system,
        prompt: req.prompt,
        maxTokens: req.maxTokens,
        effort: 'low',
        timeoutMs: 30_000,
      }),
    )
      .then(async got => {
        for (const [key, e] of got) {
          // A lookup that landed meanwhile wins.
          if (glossCache.get(key)?.title !== e.title) continue
          glossCache.set(key, e)
          await $.store.set(key, e)
        }
        S.dirty = true
      })
      .catch(() => {})
      .finally(() => {
        briefInflight = false
      })
  }

  /** The summary lines of one session's card. */
  const contextOf = async (
    sid: string,
    cwd: string,
    busy: boolean,
    pub: PublishedSession | undefined,
  ): Promise<{ ctx: SessionContext; topic: SessionTopic }> => {
    const d = await digestOf(sid, cwd)
    const fresh = pub && S.now - pub.updatedAt < PUBLISH_FRESH_MS ? pub : undefined
    if (!d) return { ctx: fresh?.context ? { context: fresh.context } : {}, topic: {} }
    await lookUpPrStates(d)
    const context = preferred(fresh, d.usage, await settingModelFor(cwd))
    const prTitles = d.prs.flatMap(p => prStates.get(prStateKey(p.repo, p.number))?.title ?? [])
    const ids = await idsOf(
      cwd,
      [d.firstPrompt ?? '', ...d.titles, ...d.prompts.slice(-5).map(p => p.text), ...prTitles, ...d.branches],
      DIGEST_IDS_MAX,
    )
    const cache = summaries && fresh?.goal?.goal ? fresh.goal : await maybeGoal(sid, d, busy, ids)
    const day = dayOf(d.firstTs, S.now)
    const prs = prText(d.prs, statesOf(d))
    const todos = fresh?.todos ?? todoProgress(d.tasks)
    const title = d.titles[d.titles.length - 1]
    const first = goalText(undefined, { ...d, titles: [] })
    const jumpTitles = jumpTitlesOf(d)
    return {
      topic: {
        ...(title ? { title } : {}),
        ...(first ? { firstPrompt: first } : {}),
        ...(jumpTitles.length ? { jumpTitles } : {}),
      },
      ctx: {
        ...(cache?.goal ? { goal: cache.goal } : {}),
        ...(day ? { day } : {}),
        ...(cache?.step ? { step: cache.step } : {}),
        ...(prs ? { prText: prs } : {}),
        ...(todos && todos.total > 0 ? { todos } : {}),
        ...(context ? { context } : {}),
      },
    }
  }

  // One listing per session per tick; a transcript is tailed again only when its mtime or size moved.
  const agentsOf = async (row: RegistryRow, seen: Set<string>): Promise<OtherAgentVM[]> => {
    const dir = subagentsDir(S.home, row.cwd, row.sessionId)
    let entries: ListedFile[]
    try {
      entries = await $.fs.list(dir)
    } catch {
      return []
    }
    const byName = new Map(entries.map(e => [e.name, e]))
    // Cached tails live as long as their files, so a busy/idle flip of the window does not re-tail them.
    for (const e of entries) if (e.name.startsWith('agent-')) seen.add(`${dir}/${e.name}`)
    const running: RunningAgent[] = []
    const busy = row.status === 'busy'
    for (const f of freshTranscripts(entries, S.now, busy ? Infinity : OPEN_CALL_CAP_MS)) {
      const path = `${dir}/${f.name}`
      seen.add(path)
      let hit = tails.get(path)
      if (!hit || hit.mtimeMs !== f.mtimeMs || hit.size !== f.size) {
        const r = await run(['tail', '-c', String(TAIL_BYTES), path])
        if (!r || r.exitCode !== 0) continue
        hit = { mtimeMs: f.mtimeMs, size: f.size, tail: parseTail(r.stdout, f.size > TAIL_BYTES) }
        tails.set(path, hit)
      }
      if (!isRunning(hit.tail, f.mtimeMs, S.now, busy)) continue
      const id = f.name.slice('agent-'.length, -'.jsonl'.length)
      const metaName = `agent-${id}.meta.json`
      const metaPath = `${dir}/${metaName}`
      seen.add(metaPath)
      let meta = metas.get(metaPath)
      if (!meta) {
        const text = await readText(metaPath)
        meta = text === undefined ? {} : parseMeta(text)
        if (text !== undefined) metas.set(metaPath, meta)
      }
      running.push({ id, meta, startedAt: byName.get(metaName)?.mtimeMs || f.mtimeMs, tail: hit.tail, mtimeMs: f.mtimeMs })
    }
    return otherAgents(running, S.now)
  }

  const readRegistry = async (): Promise<RegistryRow[]> => {
    const dir = `${S.home}/.claude/sessions`
    let entries: { name: string; kind: string }[]
    try {
      entries = await $.fs.list(dir)
    } catch {
      return []
    }
    const rows: RegistryRow[] = []
    for (const entry of entries) {
      if (entry.kind !== 'file' || !/^\d+\.json$/.test(entry.name)) continue
      const text = await readText(`${dir}/${entry.name}`)
      const row = text === undefined ? undefined : parseRegistryRow(text)
      if (row) rows.push(row)
    }
    return rows
  }

  const tickOnce = async () => {
    S.now = await $.clock.now()
    budget.ticket = 0
    budget.adr = 0
    summaries = effective(await $.store.get(SUMMARIES_KEY), config().summaries)
    const sid = await $.session.id()
    if (sid && sid !== S.sessionId) {
      S.sessionId = sid
      S.dirty = true
    }
    const sessionCwd = await $.session.cwd()
    S.cwd = sessionCwd
    await resolvePending(sessionCwd)
    await claimCheckouts(sessionCwd)
    const rows = await readRegistry()
    const self0 = findSelf(rows, S.sessionId, selfPid)
    if (self0) selfPid = self0.pid

    let files = await readPrStates()
    const pids = new Set<number>()
    for (const row of rows) if (row.pid !== selfPid) pids.add(row.pid)
    for (const pair of files.values()) {
      for (const f of [pair.ci, pair.merge]) if (f && typeof f.pid === 'number' && f.pid > 0) pids.add(f.pid)
    }
    let alive = new Set<number>()
    // Sessions not yet seen are read with their env in the same ps.
    const unread = rows.filter(r => !r.spare && pids.has(r.pid) && !terms.has(r.pid)).map(r => r.pid)
    if (pids.size > 0) {
      const r = await run(['ps', ...(unread.length ? ['eww', '-o', 'pid=,tty=,command='] : ['-o', 'pid=']), '-p', [...pids].join(',')])
      alive = r ? parsePsPids(r.stdout) : new Set()
      if (r && unread.length) {
        const found = parsePsTerm(r.stdout)
        for (const pid of unread) if (alive.has(pid)) terms.set(pid, found.get(pid) ?? { env: {} })
      }
    }
    for (const pid of terms.keys()) if (!alive.has(pid)) terms.delete(pid)

    const before = Object.keys(S.claims).length
    await lookUpBranches()
    if (Object.keys(S.claims).length !== before) files = await readPrStates()
    await refreshUnwatched(files, alive)

    for (const [key, claim] of Object.entries(S.claims)) {
      const pr = prFromSources(claim, files.get(key) ?? {}, pid => alive.has(pid))
      if (isEnded(pr.merge) && claim.endedAt === undefined) {
        claim.endedAt = S.now
        S.dirty = true
      }
      if (claim.endedAt !== undefined && S.now - claim.endedAt > MERGED_KEEP_MS) {
        delete S.claims[key]
        S.dirty = true
      }
    }
    const previousPrs = S.prs
    S.prs = Object.entries(S.claims).map(([key, claim]) => prFromSources(claim, files.get(key) ?? {}, pid => alive.has(pid)))
    const news = newsOf(previousPrs, S.prs)
    for (const text of news.toasts) $.ui.toast(text, { timeoutMs: 8000 })
    if (news.prompt !== null && effective(await $.store.get(WAKE_KEY), config().wake)) {
      $.prompt.submit({ text: news.prompt }).catch(() => undefined)
      if (news.reason !== undefined) await notice(WAKE_NOTICE_KEY, wakeNotice(news.reason))
    }

    const branches = new Map<string, string | undefined>()
    const published = new Map<string, PublishedSession>()
    const topicMap = new Map<string, SessionTopic>()
    const ctxMap = new Map<string, SessionContext>()
    const agentMap = new Map<string, OtherAgentVM[]>()
    const waits = new Map<string, WaitVM>()
    const seenFiles = new Set<string>()
    // A paired front-end's card shows its worker's content, so its own transcript is not read.
    const fronts = pairsOf(rows, r => isOtherRow(r, self0, S.sessionId, alive))
    for (const row of rows) {
      if (!isOtherRow(row, self0, S.sessionId, alive) || fronts.has(row)) continue
      if (row.cwd) branches.set(row.cwd, await branchOf(row.cwd))
      const pub = parsePublished((await readText(`${S.home}/.claude/hq/sessions/${row.sessionId}.json`)) ?? '')
      if (pub) published.set(row.sessionId, pub)
      const pubFresh = pub && S.now - pub.updatedAt < PUBLISH_FRESH_MS
      if (!(pubFresh && Array.isArray(pub.agents))) agentMap.set(row.sessionId, await agentsOf(row, seenFiles))
      const c = await contextOf(row.sessionId, row.cwd, row.status === 'busy', pub)
      topicMap.set(row.sessionId, c.topic)
      const shownAgents = (pubFresh && Array.isArray(pub.agents) ? pub.agents : agentMap.get(row.sessionId)) ?? []
      const seen = await idsOf(
        row.cwd,
        [
          c.ctx.goal ?? c.topic.title ?? c.topic.firstPrompt ?? row.name ?? '',
          c.ctx.step ?? '',
          pub?.doing ?? '',
          c.ctx.todos?.active ?? '',
          ...shownAgents.flatMap(a => [a.title, a.waiting?.text ?? a.doing ?? '']),
        ],
        VISIBLE_IDS_MAX,
      )
      ctxMap.set(row.sessionId, { ...c.ctx, glosses: seen.glosses })
      const wait = otherWait(pubFresh ? pub : undefined, digests.get(row.sessionId)?.d, row.status, row.statusUpdatedAt)
      if (wait) waits.set(row.sessionId, wait)
    }
    const shown = new Set([S.sessionId, ...ctxMap.keys()])
    for (const k of digests.keys()) if (!shown.has(k)) digests.delete(k)
    for (const k of tails.keys()) if (!seenFiles.has(k)) tails.delete(k)
    for (const k of metas.keys()) if (!seenFiles.has(k)) metas.delete(k)
    const fleet = buildFleet(rows, alive, S.sessionId, branches, published, S.now, selfPid, topicMap, agentMap, ctxMap, waits, terms)
    const self = fleet.self
    S.others = fleet.others
    if (!notifying) {
      notifying = true
      void notifyOthers().finally(() => {
        notifying = false
      })
    }

    const own = await contextOf(S.sessionId, sessionCwd, !S.activity.idle, undefined)
    // The engine's own figures, else the transcript estimate; plan usage from any fresh publish until this session has a reading.
    let liveContext = own.ctx.context
    let account = [...published.values()]
      .filter(p => p.account && S.now - p.updatedAt < PUBLISH_FRESH_MS)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]?.account
    try {
      const u = await $.session.usage()
      liveContext = live(u.context, await $.session.model()) ?? liveContext
      ownAccount = accountOf(u.rateLimits)
      account = ownAccount ?? account
    } catch {
      // an engine without the op: the estimate stands
    }
    if (JSON.stringify([liveContext, account]) !== JSON.stringify([S.context, S.account])) {
      S.context = liveContext
      S.account = account
      S.dirty = true
    }
    const ownGoal = own.ctx.goal ?? own.topic.title ?? own.topic.firstPrompt
    const ownIds = await idsOf(
      sessionCwd,
      [ownGoal ?? '', ...S.model.current.agents.flatMap(a => [a.title, a.todo?.text ?? a.now ?? ''])],
      VISIBLE_IDS_MAX,
    )
    if (JSON.stringify(ownIds.glosses) !== JSON.stringify(S.glosses)) {
      S.glosses = ownIds.glosses
      S.dirty = true
    }
    launchBriefs()
    const goal = ownGoal
      ? { text: ownGoal, ...(own.ctx.day ? { day: own.ctx.day } : {}), ...(own.ctx.step ? { step: own.ctx.step } : {}) }
      : undefined
    if (JSON.stringify(goal) !== JSON.stringify(S.goal)) {
      S.goal = goal
      S.dirty = true
    }

    const { session, window } = splitTmux(selfTmux(rows, self))
    const target = session ? `${session}${window ? `:${window}` : ''}` : ''
    const branch = await branchOf(sessionCwd)
    S.label = [target, branch].filter(Boolean).join(' · ')
    S.title = (await repoForDir(sessionCwd))?.split('/').pop() || sessionCwd.replace(/\/+$/, '').split('/').pop() || ''

    try {
      reconcile(S.agents, (await $.agent.list()) as ListedAgent[], S.now)
    } catch {
      // keep what the hooks recorded
    }
    if (settleQuiet(S.agents, S.now)) S.dirty = true
    prune(S.agents, S.now)
    rebuild()

    if (S.now - publishedAt >= PUBLISH_MS || publishedId !== S.sessionId || publishedWaitRev !== W.rev) {
      publishedWaitRev = W.rev
      if (publishedId && publishedId !== S.sessionId) await run(['rm', '-f', `${S.home}/.claude/hq/sessions/${publishedId}.json`])
      publishedAt = S.now
      publishedId = S.sessionId
      const doing = doingLine({ now: nowOf(S.activity), todos: todosOf(S.activity) })
      const mine: PublishedSession = {
        sessionId: S.sessionId,
        pid: self?.pid ?? 0,
        updatedAt: S.now,
        agentsRunning: Object.values(S.agents.byId).filter(isLive).length,
        prSummary: prSummary(S.prs),
        agents: S.model.current.agents
          .filter(isLive)
          .sort((a, b) => b.startedAt - a.startedAt)
          .slice(0, OTHER_AGENTS_MAX)
          .map(a => {
            const doing = a.todo?.text ?? a.now
            const waiting = longCall(a, S.now)
            return {
              id: a.id,
              title: a.title,
              startedAt: a.startedAt,
              ...(a.model ? { model: a.model } : {}),
              ...(a.tokens ? { tokens: a.tokens } : {}),
              ...(doing ? { doing } : {}),
              ...(waiting ? { waiting } : {}),
            }
          }),
        owned: Object.values(S.claims).map(c => ({ repo: c.repo, number: c.number })),
        prs: S.prs.filter(p => !isEnded(p.merge)),
        ...(doing ? { doing } : {}),
        ...(t => (t ? { todos: t } : {}))(todoProgress(todosOf(S.activity).map((x, i) => ({ id: String(i), ...x })))),
        ...(g => (g?.goal ? { goal: { goal: g.goal, ...(g.step ? { step: g.step } : {}), at: g.at } } : {}))(goals.get(S.sessionId)),
        ...(w => (w ? { waiting: w } : {}))(ownWait(S.activity)),
        ...(S.context?.source === 'live' ? { context: S.context } : {}),
        // Only its own reading, so a relayed figure never outlives its source.
        ...(ownAccount ? { account: ownAccount } : {}),
      }
      try {
        await $.fs.write(`${S.home}/.claude/hq/sessions/${S.sessionId}.json`, JSON.stringify(mine))
      } catch {
        // others just won't see this session's extras
      }
    }

    if (S.dirty) {
      S.dirty = false
      const ownedText = JSON.stringify({ claims: Object.values(S.claims), branches: Object.values(S.branches) })
      const activityText = JSON.stringify(S.activity)
      const agentsText = JSON.stringify(S.agents)
      const storeId = S.sessionId
      if (ownedText !== written.owned || storeId !== written.id) {
        const owned = JSON.parse(ownedText) as OwnedState
        await update($, ownedAtom, () => owned)
        await $.store.set(storeKey('owned'), owned)
      }
      if (activityText !== written.activity) {
        const activity = JSON.parse(activityText) as ActivityState
        await update($, activityAtom, () => activity)
      }
      if (agentsText !== written.agents || storeId !== written.id) await $.store.set(storeKey('agents'), JSON.parse(agentsText))
      written = { id: storeId, owned: ownedText, activity: activityText, agents: agentsText }
    }
  }

  const notifiedDir = () => `${S.home}/.claude/hq/notified`
  const notifyOthers = async () => {
    const due = dueNotifications(S.others, notified, S.sessionId, S.now)
    if (due.length === 0) return
    await run(['mkdir', '-p', notifiedDir()])
    if (S.now - prunedAt >= NOTIFIED_PRUNE_MS) {
      prunedAt = S.now
      await run(['find', notifiedDir(), '-mindepth', '1', '-maxdepth', '1', '-mmin', '+1440', '-exec', 'rmdir', '{}', '+'])
    }
    await notifyWaits(due, notified, {
      enabled: async () => effective(await $.store.get(NOTIFY_STORE_KEY), config().notify),
      claim: async key => (await run(['mkdir', `${notifiedDir()}/${claimName(key)}`]))?.exitCode === 0,
      send: async text => {
        await $.ui.notify(text, { title: NOTIFY_TITLE })
      },
    })
  }

  const tick = async () => {
    if (isTicking) return
    isTicking = true
    try {
      await tickOnce()
    } catch {
      // next tick retries
    } finally {
      isTicking = false
    }
  }

  $.clock.every(TICK_MS, () => void tick())
  rebuild()
  void tick()
}

export function branchKey(repo: string, branch: string): string {
  return `${repo.toLowerCase()}@${branch}`
}
