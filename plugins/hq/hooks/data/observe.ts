// Data-layer state and the pure observers the hooks feed; index.ts wires them to events.
import type { AccountUsage, ContextUsage, HqModel, PrVM, TmuxGroupVM } from '../model/types'
import { emptyActivity, nowOf, onToolResult, onToolStart, todosOf, waitingOf } from './activity'
import type { ActivityState } from './activity'
import { agentList, emptyAgents, onAgentResult, onHandback, onSubagentTool, onSubagentToolEnd } from './agents'
import type { AgentsState } from './agents'
import { parseOwnership } from './claims'
import type { GitOperation } from './claims'
import { buildModel, fingerprint } from './model'
import type { BranchClaim, StoredClaim } from './prs'

export const TICK_MS = 2_000
export const PUBLISH_MS = 5_000
export const BRANCH_TTL_MS = 60_000

const EMPTY: HqModel = {
  now: 0,
  counts: { waiting: 0, broken: 0, inProgress: 0, sessions: 0 },
  current: { label: '', agents: [], prs: [] },
  others: [],
  statusText: '',
}

/** An ownership fact waiting for the tick to resolve its repo or branch. */
export type Pending =
  | { kind: 'created'; repo: string; number: number; claimedBy: string }
  | { kind: 'pushed'; repo?: string; branch?: string; dir?: string; claimedBy: string }
  | { kind: 'merged'; repo?: string; number: number; dir?: string }

export const DIRS_MAX = 20

// Module state: a hot reload starts it afresh and session.start restores it from $.store.
export const S = {
  sessionId: '',
  home: '',
  now: 0,
  label: '',
  goal: undefined as { text: string; day?: number } | undefined,
  glosses: {} as Record<string, string>,
  context: undefined as ContextUsage | undefined,
  account: undefined as AccountUsage | undefined,
  agents: emptyAgents() as AgentsState,
  cwd: '',
  claims: {} as Record<string, StoredClaim>,
  branches: {} as Record<string, BranchClaim>,
  pending: [] as Pending[],
  /** Directories the session's or its agents' commands moved into: candidates for checkout ownership. */
  dirs: [] as { dir: string; by: string }[],
  activity: emptyActivity() as ActivityState,
  prs: [] as PrVM[],
  others: [] as TmuxGroupVM[],
  model: EMPTY,
  fp: '',
  dirty: false,
  onChange: (() => {}) as () => void,
}

/** Test seam: the kit's `$.tool.call` drops `agentId`, so subagent calls are fed in directly. */
export function pendingClaims(): readonly Pending[] {
  return S.pending
}

export function agentsState(): AgentsState {
  return S.agents
}

export function activityState(): ActivityState {
  return S.activity
}

export function rebuild(): void {
  const model = buildModel({
    now: S.now, label: S.label, ...(S.goal ? { goal: S.goal } : {}), glosses: S.glosses,
    ...(S.context ? { context: S.context } : {}), ...(S.account ? { account: S.account } : {}), agents: agentList(S.agents, S.cwd || undefined), prs: S.prs, others: S.others,
    activity: { now: nowOf(S.activity), todos: todosOf(S.activity), waiting: waitingOf(S.activity) },
  })
  S.model = model
  const fp = fingerprint(model)
  if (fp === S.fp) return
  S.fp = fp
  try {
    S.onChange()
  } catch {
    // the pane's callback failing must not break the data layer
  }
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

export function tokensOf(usage: unknown): number | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const u = usage as Record<string, unknown>
  const n = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
    .map(k => (typeof u[k] === 'number' ? (u[k] as number) : 0))
    .reduce((a, b) => a + b, 0)
  return n > 0 ? n : undefined
}

export function storeKey(kind: 'owned' | 'agents'): string {
  return `${kind}:${S.sessionId}`
}

/** Observes a tool call before it runs: subagent progress, or the session's in-flight tool. */
export function beforeTool(e: Record<string, unknown>): void {
  const agentId = str(e.agentId)
  const input = e as { tool: string } & Record<string, unknown>
  if (!agentId) {
    onToolStart(S.activity, input, S.now)
    rebuild()
    return
  }
  const tool = String(e.tool)
  if (onSubagentTool(S.agents, agentId, input, S.home, S.now)) {
    if (tool === 'SubagentHandback') onHandback(S.agents, agentId, str(e.message) ?? '')
    rebuild()
  }
}

function addDir(dir: string, by: string): void {
  if (S.dirs.some(d => d.dir === dir && d.by === by)) return
  S.dirs = [{ dir, by }, ...S.dirs].slice(0, DIRS_MAX)
}

/** Observes a tool call's result: Agent results, ownership facts, the session's own activity. */
export function afterTool(e: Record<string, unknown>, r: Record<string, unknown>): void {
  const tool = String(e.tool)
  const agentId = str(e.agentId)
  let changed = false
  if (!agentId) {
    onToolResult(S.activity, e as { tool: string } & Record<string, unknown>, r.result, S.now)
    changed = true
  } else if (onSubagentToolEnd(S.agents, agentId)) {
    changed = true
  }
  if (tool === 'Agent' && !('deny' in r && r.deny !== undefined)) {
    const id = onAgentResult(S.agents, String(e.tool_use_id), r.result, r.isError === true, str(r.text), S.now)
    changed = changed || id !== undefined
  }
  if (tool === 'Bash') {
    const command = str(e.command) ?? ''
    const result = (r.result ?? {}) as { stdout?: unknown; stderr?: unknown; gitOperation?: GitOperation }
    const facts = parseOwnership(command, str(result.stdout) ?? '', str(result.stderr) ?? '', result.gitOperation)
    const claimedBy = agentId ?? 'main'
    const agentRoot = agentId ? S.agents.byId[agentId]?.root : undefined
    for (const d of facts.dirs) addDir(d, claimedBy)
    for (const c of facts.created) S.pending.push({ kind: 'created', repo: c.repo, number: c.number, claimedBy })
    for (const p of facts.pushed) {
      const dir = p.dir ?? agentRoot
      S.pending.push({ kind: 'pushed', ...p, ...(dir ? { dir } : {}), claimedBy })
    }
    for (const m of facts.merged) {
      const dir = facts.dirs[facts.dirs.length - 1] ?? agentRoot
      S.pending.push({ kind: 'merged', ...m, ...(dir ? { dir } : {}) })
    }
  }
  if (changed) rebuild()
}
