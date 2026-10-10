// This session's subagents, reduced from agent.spawn, tool.call and turn.complete events.
import { summaryLine } from '../model/plain'
import type { AgentStatus, AgentVM } from '../model/types'
import { doingText } from './doing'

export const FINISHED_KEEP_MS = 30 * 60_000
const FINISHED_MAX = 8
const FILES_MAX = 5
/** A notified agent with no tool call for this long has ended, whatever the engine lists. */
export const QUIET_END_MS = 10 * 60_000
const PRUNED_MAX = 50

export interface AgentRecord extends AgentVM {
  /** The Agent tool call that started it; matches the tool result to the agent. */
  toolUseId?: string
  /** Absolute root of the worktree it works in, for relative file names. */
  root?: string
  /** Consecutive `$.agent.list()` reads that did not list this live agent. */
  missing?: number
  /** Its own TodoWrite list, when it keeps one. */
  todos?: { text: string; status: string }[]
  /** Its last tool call. */
  lastToolAt?: number
  /** A `<task-notification>` naming it arrived. */
  notifiedAt?: number
}

export interface AgentsState {
  byId: Record<string, AgentRecord>
  /** tool_use_id → agentId */
  byToolUse: Record<string, string>
  /** Ids pruned while the engine still lists them (ended agents stay resumable); adopted again only as running. */
  pruned?: string[]
}

export function emptyAgents(): AgentsState {
  return { byId: {}, byToolUse: {}, pruned: [] }
}

function finish(a: AgentRecord, status: AgentStatus, now: number): void {
  a.status = status
  a.endedAt = a.endedAt ?? now
  if (status !== 'failed') delete a.now
  delete a.callSince
}

export function firstLine(text: string | undefined): string | undefined {
  return summaryLine(text)
}

const LIVE: ReadonlySet<AgentStatus> = new Set(['running', 'waiting', 'pending'])
export function isLive(a: Pick<AgentVM, 'status'>): boolean {
  return LIVE.has(a.status)
}

/** Worktree root and its display form from a path: `.koh/<name>` or `.claude/worktrees/<name>`. */
export function worktreeOf(path: string): { root: string; label: string } | undefined {
  const m = /^(.*?)\/(\.koh|\.claude\/worktrees)\/([^/]+)/.exec(path)
  if (!m) return undefined
  return { root: `${m[1]}/${m[2]}/${m[3]}`, label: `${m[2]}/${m[3]}` }
}

export function shortPath(path: string, root: string | undefined, home: string | undefined): string {
  if (root && path.startsWith(`${root}/`)) return path.slice(root.length + 1)
  if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`
  return path
}

function cdOf(command: string): string | undefined {
  const m = /^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*(?:&&|;)/.exec(command)
  return m ? m[1]!.replace(/^["']|["']$/g, '') : undefined
}

type ToolInput = { tool: string } & Record<string, unknown>

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

export interface SpawnFacts {
  toolUseId: string
  description: string
  model?: string
  background: boolean
  parentAgentId?: string
  cwd?: string
}

/** Records a started subagent (agent.spawn after `next` resolved its id and model). */
export function onSpawn(s: AgentsState, f: SpawnFacts, agentId: string, resolvedModel: string | undefined, now: number) {
  const prev = s.byId[agentId]
  const wt = f.cwd ? worktreeOf(f.cwd) : undefined
  const rec: AgentRecord = {
    id: agentId,
    title: f.description,
    status: 'running',
    background: f.background,
    startedAt: prev?.startedAt ?? now,
    toolCount: prev?.toolCount ?? 0,
    files: prev?.files ?? [],
    toolUseId: f.toolUseId,
    ...(f.parentAgentId ? { parentId: f.parentAgentId } : {}),
    ...((resolvedModel ?? f.model) ? { model: resolvedModel ?? f.model } : {}),
    ...(wt ? { worktree: wt.label, root: wt.root } : f.cwd ? { worktree: f.cwd, root: f.cwd } : {}),
  }
  s.byId[agentId] = rec
  s.byToolUse[f.toolUseId] = agentId
  const parent = f.parentAgentId ? s.byId[f.parentAgentId] : undefined
  if (parent && !f.background && isLive(parent)) {
    parent.status = 'waiting'
    parent.now = `waiting on its child: ${f.description}`
  }
}

/** A subagent's own tool call (e.agentId set). Unknown ids (forks, workflows) are ignored. */
export function onSubagentTool(s: AgentsState, agentId: string, e: ToolInput, home: string | undefined, now?: number): boolean {
  const a = s.byId[agentId]
  if (!a) return false
  a.toolCount += 1
  // A foreground child parks it as `waiting` on that child instead.
  if (now !== undefined && e.tool !== 'Agent') a.callSince = now
  else delete a.callSince
  if (now !== undefined) a.lastToolAt = now
  const file = str(e.file_path) ?? str(e.notebook_path)
  const cmdCwd = e.tool === 'Bash' ? cdOf(str(e.command) ?? '') : undefined
  const wt = (file && worktreeOf(file)) || (cmdCwd && worktreeOf(cmdCwd)) || undefined
  if (wt) {
    a.worktree = wt.label
    a.root = wt.root
  } else if (!a.worktree && cmdCwd) {
    a.worktree = shortPath(cmdCwd, undefined, home)
    a.root = cmdCwd
  }
  // A foreground child's Agent call parks this agent; anything else means it is working.
  if (e.tool !== 'Agent' && a.status === 'waiting') a.status = 'running'
  a.now = doingText(e)
  if (e.tool === 'TodoWrite' && Array.isArray(e.todos)) a.todos = todoItems(e.todos)
  if (file && EDITS.has(String(e.tool))) {
    const short = shortPath(file, a.root, home)
    a.files = [short, ...a.files.filter(f => f !== short)].slice(0, FILES_MAX)
  }
  return true
}

/** A subagent's model response: its context size now, and the model when the spawn did not name one. */
export function onSubagentStep(s: AgentsState, agentId: string, tokens: number | undefined, model: string | undefined): boolean {
  const a = s.byId[agentId]
  if (!a || !isLive(a) || tokens === undefined) return false
  a.tokens = tokens
  if (model && !a.model) a.model = model
  return true
}

/** A subagent's tool call returned. */
export function onSubagentToolEnd(s: AgentsState, agentId: string): boolean {
  const a = s.byId[agentId]
  if (!a || a.callSince === undefined) return false
  delete a.callSince
  return true
}

/** TodoWrite items as `{ text, status }`, the in-progress one by its activeForm. */
export function todoItems(list: readonly unknown[]): { text: string; status: string }[] {
  const out: { text: string; status: string }[] = []
  for (const t of list) {
    if (!t || typeof t !== 'object') continue
    const o = t as Record<string, unknown>
    const status = str(o.status) ?? 'pending'
    const text = (status === 'in_progress' ? str(o.activeForm) : undefined) ?? str(o.content) ?? ''
    if (text) out.push({ text, status })
  }
  return out
}

type AgentResult =
  | {
      status: 'completed'
      agentId: string
      resolvedModel?: string
      totalToolUseCount: number
      totalDurationMs?: number
      totalTokens: number
      content: { type: string; text: string }[]
      worktreePath?: string
    }
  | { status: 'async_launched'; agentId: string; resolvedModel?: string }
  | { status: 'remote_launched' }

/** The Agent tool's own result (seen by the caller's tool.call hook). */
export function onAgentResult(
  s: AgentsState,
  toolUseId: string,
  result: unknown,
  isError: boolean,
  errorText: string | undefined,
  now: number,
): string | undefined {
  const r = result as AgentResult | undefined
  const id = (r && 'agentId' in r ? r.agentId : undefined) ?? s.byToolUse[toolUseId]
  const a = id ? s.byId[id] : undefined
  if (!a) return undefined
  if (isError || !r) {
    finish(a, 'failed', now)
    a.now = firstLine(errorText) ?? 'failed'
  } else if (r.status === 'completed') {
    finish(a, 'completed', now)
    a.toolCount = Math.max(a.toolCount, r.totalToolUseCount)
    a.tokens = r.totalTokens
    if (r.resolvedModel) a.model = r.resolvedModel
    a.outcome = firstLine(r.content.map(c => c.text).join('\n')) ?? a.outcome
    if (r.worktreePath) {
      const wt = worktreeOf(r.worktreePath)
      a.worktree = wt?.label ?? r.worktreePath
    }
  } else if (r.status === 'async_launched' && r.resolvedModel) {
    a.model = r.resolvedModel
  }
  wakeParent(s, a)
  return a.id
}

function wakeParent(s: AgentsState, child: AgentRecord) {
  const parent = child.parentId ? s.byId[child.parentId] : undefined
  if (parent && parent.status === 'waiting' && parent.now?.startsWith('waiting on its child')) {
    parent.status = 'running'
    parent.now = undefined
  }
}

/** A subagent's turn ended: the last word on a background agent. */
export function onTurnComplete(
  s: AgentsState,
  agentId: string,
  reason: string,
  answer: string,
  tokens: number | undefined,
  now: number,
): boolean {
  const a = s.byId[agentId]
  if (!a) return false
  if (a.status === 'completed' || a.status === 'failed' || a.status === 'killed') return true
  const status: AgentStatus = reason === 'error' || reason === 'refusal' ? 'failed' : reason === 'aborted' ? 'killed' : 'completed'
  finish(a, status, now)
  const line = firstLine(answer)
  if (status === 'failed') a.now = line ?? a.now
  else if (!a.outcome) a.outcome = line
  if (tokens !== undefined && a.tokens === undefined) a.tokens = tokens
  wakeParent(s, a)
  return true
}

/** The subagent's hand-back report: its outcome, even when the turn's answer is empty. */
export function onHandback(s: AgentsState, agentId: string, message: string): void {
  const a = s.byId[agentId]
  if (a) a.outcome = firstLine(message) ?? a.outcome
}

const FINAL: Record<string, AgentStatus> = { completed: 'completed', failed: 'failed', killed: 'killed', stopped: 'killed' }

/** `<task-notification>`s naming an agent (by id or its Agent call's id): a final status ends it, any marks it notified. */
export function onTaskNotification(s: AgentsState, notes: readonly { id: string; status?: string }[], now: number): boolean {
  let changed = false
  for (const n of notes) {
    const a = s.byId[n.id] ?? s.byId[s.byToolUse[n.id] ?? '']
    if (!a || !isLive(a)) continue
    a.notifiedAt = now
    const final = n.status ? FINAL[n.status] : undefined
    if (final) {
      finish(a, final, now)
      wakeParent(s, a)
    }
    changed = true
  }
  return changed
}

/** Backstop for a lost end signal: notified, and no tool call for QUIET_END_MS. */
export function settleQuiet(s: AgentsState, now: number): boolean {
  let changed = false
  for (const a of Object.values(s.byId)) {
    if (!isLive(a) || a.notifiedAt === undefined || now - (a.lastToolAt ?? a.startedAt) < QUIET_END_MS) continue
    finish(a, 'completed', now)
    wakeParent(s, a)
    changed = true
  }
  return changed
}

export interface ListedAgent {
  id: string
  description: string
  type: string
  status: string
  parentId?: string
}

/** A subagent between turns has handed back; only a teammate idles waiting for a message. */
function mapStatus(status: string, type: string): AgentStatus {
  if (status === 'idle') return type === 'teammate' ? 'waiting' : 'completed'
  if (['pending', 'running', 'waiting', 'completed', 'failed', 'killed'].includes(status)) return status as AgentStatus
  return 'running'
}

/** Reconciles with `$.agent.list()`: adopts agents missed (a reload), takes the engine's status. */
export function reconcile(s: AgentsState, listed: readonly ListedAgent[], now: number): void {
  const seen = new Set<string>()
  for (const l of listed) {
    seen.add(l.id)
    const a = s.byId[l.id]
    const status = mapStatus(l.status, l.type)
    if (!a) {
      // A pruned id comes back only when it truly runs again (a message resumed it).
      if (!isLive({ status }) || (status !== 'running' && s.pruned?.includes(l.id))) continue
      s.byId[l.id] = {
        id: l.id,
        title: l.description,
        status,
        background: true,
        startedAt: now,
        toolCount: 0,
        files: [],
        ...(l.parentId ? { parentId: l.parentId } : {}),
      }
      continue
    }
    a.missing = 0
    if (!isLive(a)) continue
    if (!isLive({ status })) {
      finish(a, status, now)
      wakeParent(s, a)
    } else if (status === 'waiting' || a.status !== 'waiting') {
      a.status = status
    }
  }
  // A live record the engine no longer lists ended unseen (its turn.complete fell in a reload gap, or a resume).
  for (const a of Object.values(s.byId)) {
    if (seen.has(a.id) || !isLive(a)) continue
    a.missing = (a.missing ?? 0) + 1
    if (a.missing >= 2) finish(a, 'completed', now)
  }
}

/** Drops finished agents past 30 min, keeping the newest few. */
export function prune(s: AgentsState, now: number): void {
  const finished = Object.values(s.byId)
    .filter(a => !isLive(a))
    .sort((x, y) => (y.endedAt ?? 0) - (x.endedAt ?? 0))
  finished.forEach((a, i) => {
    if (i >= FINISHED_MAX || now - (a.endedAt ?? now) > FINISHED_KEEP_MS) {
      delete s.byId[a.id]
      if (a.toolUseId) delete s.byToolUse[a.toolUseId]
      s.pruned = [a.id, ...(s.pruned ?? []).filter(id => id !== a.id)].slice(0, PRUNED_MAX)
    }
  })
}

const RANK: Record<AgentStatus, number> = { failed: 0, running: 1, waiting: 1, pending: 1, completed: 2, killed: 2 }

function placeOf(root: string | undefined, sessionRoot: string | undefined): string | undefined {
  if (!root) return undefined
  const name = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p
  const wt = worktreeOf(root)
  if (wt) return sessionRoot && (sessionRoot === wt.root || sessionRoot.startsWith(`${wt.root}/`)) ? undefined : name(wt.root)
  if (sessionRoot && (root === sessionRoot || root.startsWith(`${sessionRoot}/`))) return undefined
  return name(root)
}

/** Failed first, live by start, finished newest first; `root`/`toolUseId` stripped. */
export function agentList(s: AgentsState, sessionRoot?: string): AgentVM[] {
  return Object.values(s.byId)
    .sort((x, y) => {
      const r = RANK[x.status] - RANK[y.status]
      if (r !== 0) return r
      if (RANK[x.status] === 2) return (y.endedAt ?? 0) - (x.endedAt ?? 0) || x.id.localeCompare(y.id)
      return x.startedAt - y.startedAt || x.id.localeCompare(y.id)
    })
    .map(({ root, toolUseId: _t, missing: _m, lastToolAt: _l, notifiedAt: _n, todos, ...vm }) => {
      const place = placeOf(root, sessionRoot)
      const current = todos?.find(t => t.status === 'in_progress')
      const todo =
        current && todos ? { text: current.text, done: todos.filter(t => t.status === 'completed').length, total: todos.length } : undefined
      return { ...vm, ...(place ? { place } : {}), ...(todo ? { todo } : {}) }
    })
}
