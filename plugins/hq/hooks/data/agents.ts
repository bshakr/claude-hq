// This session's subagents, reduced from agent.spawn, tool.call and turn.complete events.
import { summaryLine } from '../model/plain'
import type { AgentStatus, AgentVM } from '../model/types'
import { doingText } from './doing'

export const FINISHED_KEEP_MS = 30 * 60_000
const FINISHED_MAX = 8
const FILES_MAX = 5

export interface AgentRecord extends AgentVM {
  /** The Agent tool call that started it; matches the tool result to the agent. */
  toolUseId?: string
  /** Absolute root of the worktree it works in, for relative file names. */
  root?: string
  /** Consecutive `$.agent.list()` reads that did not list this live agent. */
  missing?: number
  /** Its own TodoWrite list, when it keeps one. */
  todos?: { text: string; status: string }[]
}

export interface AgentsState {
  byId: Record<string, AgentRecord>
  /** tool_use_id → agentId */
  byToolUse: Record<string, string>
}

export function emptyAgents(): AgentsState {
  return { byId: {}, byToolUse: {} }
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
    ...(resolvedModel ?? f.model ? { model: resolvedModel ?? f.model } : {}),
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
    a.status = 'failed'
    a.endedAt = now
    a.now = firstLine(errorText) ?? 'failed'
  } else if (r.status === 'completed') {
    a.status = 'completed'
    a.endedAt = now
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
  a.status = reason === 'error' || reason === 'refusal' ? 'failed' : reason === 'aborted' ? 'killed' : 'completed'
  a.endedAt = now
  const line = firstLine(answer)
  if (a.status === 'failed') a.now = line ?? a.now
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

export interface ListedAgent {
  id: string
  description: string
  type: string
  status: string
  parentId?: string
}

function mapStatus(status: string): AgentStatus {
  if (status === 'idle') return 'waiting'
  if (['pending', 'running', 'waiting', 'completed', 'failed', 'killed'].includes(status)) return status as AgentStatus
  return 'running'
}

/** Reconciles with `$.agent.list()`: adopts agents missed (a reload), takes the engine's status. */
export function reconcile(s: AgentsState, listed: readonly ListedAgent[], now: number): void {
  const seen = new Set<string>()
  for (const l of listed) {
    seen.add(l.id)
    const a = s.byId[l.id]
    const status = mapStatus(l.status)
    if (!a) {
      s.byId[l.id] = {
        id: l.id, title: l.description, status, background: true, startedAt: now, toolCount: 0, files: [],
        ...(l.parentId ? { parentId: l.parentId } : {}),
        ...(isLive({ status }) ? {} : { endedAt: now }),
      }
      continue
    }
    a.missing = 0
    if (!isLive(a)) continue
    if (!isLive({ status })) {
      a.status = status
      a.endedAt = a.endedAt ?? now
    } else if (status === 'waiting' || a.status !== 'waiting') {
      a.status = status
    }
  }
  // A live record the engine no longer lists ended unseen (its turn.complete fell in a reload gap, or a resume).
  for (const a of Object.values(s.byId)) {
    if (seen.has(a.id) || !isLive(a)) continue
    a.missing = (a.missing ?? 0) + 1
    if (a.missing >= 2) {
      a.status = 'completed'
      a.endedAt = now
    }
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
    .map(({ root, toolUseId: _t, missing: _m, todos, ...vm }) => {
      const place = placeOf(root, sessionRoot)
      const current = todos?.find(t => t.status === 'in_progress')
      const todo = current && todos
        ? { text: current.text, done: todos.filter(t => t.status === 'completed').length, total: todos.length }
        : undefined
      return { ...vm, ...(place ? { place } : {}), ...(todo ? { todo } : {}) }
    })
}
