import type {
  AccountUsage,
  AgentVM,
  ContextUsage,
  Counts,
  HqModel,
  NowVM,
  OtherSessionVM,
  PrVM,
  PublishedSession,
  TmuxGroupVM,
  TodoVM,
  WaitingVM,
} from '../model/types'
import { isLive } from './agents'
import { pickFlare } from './fleet'
import { prTone } from './prs'
import type { PrTone } from './prs'
import { withPrStatus } from './wake'

export interface ModelInputs {
  now: number
  label: string
  agents: AgentVM[]
  prs: PrVM[]
  others: TmuxGroupVM[]
  activity?: { now?: NowVM; todos?: TodoVM[]; waiting?: WaitingVM[] }
  goal?: { text: string; day?: number; step?: string }
  /** This session's repo or folder name, the card's title once it has a goal. */
  title?: string
  glosses?: Record<string, string>
  context?: ContextUsage
  account?: AccountUsage
}

/** "3/7 · Rewriting PR claim rules", or the last prompt while there is no list. */
export function doingLine(activity: ModelInputs['activity']): string | undefined {
  const todos = activity?.todos ?? []
  const current = todos.find(t => t.status === 'in_progress')
  if (todos.length > 0 && current) {
    return `${todos.filter(t => t.status === 'completed').length}/${todos.length} · ${current.text}`
  }
  const now = activity?.now
  if (!now || now.idle) return undefined
  return now.tool?.text ?? now.prompt
}

export function prSummary(prs: readonly PrVM[]): PublishedSession['prSummary'] {
  const open = prs.filter(p => prTone(p) !== 'done')
  const tones = open.map(prTone)
  return {
    total: open.length,
    broken: tones.filter(t => t === 'broken').length,
    waiting: tones.filter(t => t === 'waiting').length,
    inProgress: tones.filter(t => t === 'progress').length,
  }
}

/**
 * waiting = other sessions waiting for input + own PRs waiting on him (no watcher, behind,
 * skipped-required, blocked); broken = own failed agents + own red/conflicting PRs + other
 * sessions' published broken PRs; inProgress = own live agents + own PRs with checks running.
 */
export function countsOf(inputs: Pick<ModelInputs, 'agents' | 'prs' | 'others'>): Counts {
  const others = inputs.others.flatMap(g => g.sessions)
  const pr = prSummary(inputs.prs)
  return {
    waiting: others.filter(s => s.status === 'waiting').length + pr.waiting,
    broken:
      inputs.agents.filter(a => a.status === 'failed').length + pr.broken + others.reduce((n, s) => n + (s.prSummary?.broken ?? 0), 0),
    inProgress: inputs.agents.filter(isLive).length + pr.inProgress,
    sessions: others.length + 1,
  }
}

export function ageText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return '<1m'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

export function statusTextOf(counts: Counts, waitingOthers: readonly OtherSessionVM[], now: number): string {
  const parts: string[] = []
  const longest = [...waitingOthers].sort((a, b) => (a.statusSince ?? 0) - (b.statusSince ?? 0))[0]
  if (waitingOthers.length === 1 && longest) {
    parts.push(
      longest.statusSince !== undefined ? `${longest.name} waiting ${ageText(now - longest.statusSince)}` : `${longest.name} waiting`,
    )
  } else if (waitingOthers.length > 1) {
    parts.push(`${waitingOthers.length} waiting`)
  }
  if (counts.broken > 0) parts.push(`${counts.broken} broken`)
  if (counts.inProgress > 0) parts.push(`${counts.inProgress} in progress`)
  return parts.length === 0 ? '' : `hq: ${parts.join(' · ')}`
}

const TONE_RANK: Record<PrTone, number> = { broken: 0, waiting: 1, progress: 2, quiet: 3, done: 4 }

/** Repos worst first, PRs worst first inside a repo; merged/closed last. */
export function sortPrs(prs: readonly PrVM[]): PrVM[] {
  const worst = new Map<string, number>()
  for (const p of prs) worst.set(p.repo, Math.min(worst.get(p.repo) ?? 9, TONE_RANK[prTone(p)]))
  return [...prs].sort(
    (a, b) =>
      (worst.get(a.repo) ?? 9) - (worst.get(b.repo) ?? 9) ||
      a.repo.localeCompare(b.repo) ||
      TONE_RANK[prTone(a)] - TONE_RANK[prTone(b)] ||
      a.number - b.number,
  )
}

export function buildModel(inputs: ModelInputs): HqModel {
  const counts = countsOf(inputs)
  const sessions = inputs.others.flatMap(g => g.sessions)
  const flare = pickFlare(sessions)
  return {
    now: inputs.now,
    counts,
    ...(flare ? { flare } : {}),
    current: {
      label: inputs.label,
      ...(inputs.title ? { title: inputs.title } : {}),
      ...(inputs.goal ? { goal: inputs.goal } : {}),
      ...(inputs.activity?.now ? { now: inputs.activity.now } : {}),
      ...(inputs.activity?.todos?.length ? { todos: inputs.activity.todos } : {}),
      ...(inputs.activity?.waiting?.length ? { waiting: inputs.activity.waiting } : {}),
      agents: inputs.agents,
      prs: sortPrs(inputs.prs),
      ...(inputs.glosses && Object.keys(inputs.glosses).length ? { glosses: inputs.glosses } : {}),
      ...(inputs.context ? { context: inputs.context } : {}),
    },
    others: inputs.others,
    ...(inputs.account ? { account: inputs.account } : {}),
    statusText: withPrStatus(
      statusTextOf(
        counts,
        sessions.filter(s => s.status === 'waiting'),
        inputs.now,
      ),
      inputs.prs,
    ),
  }
}

/** Stable serialisation without `now`, so a clock tick alone is no change. */
export function fingerprint(model: HqModel): string {
  const { now: _now, ...rest } = model
  return stableStringify(rest)
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj)
    .filter(k => obj[k] !== undefined)
    .sort()
    .map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`
}
