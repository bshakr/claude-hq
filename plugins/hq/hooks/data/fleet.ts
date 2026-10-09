// Other Claude sessions on this machine, from ~/.claude/sessions/<pid>.json.
import type {
  ContextUsage,
  Flare,
  Jump,
  OtherAgentVM,
  OtherSessionVM,
  PublishedSession,
  TermEnv,
  TmuxGroupVM,
  TodoProgress,
  WaitVM,
} from '../model/types'
import { isRealWait } from './waiting'

export const PUBLISH_FRESH_MS = 30_000

/** One `~/.claude/sessions/<pid>.json`, the fields this layer reads. */
export interface RegistryRow {
  pid: number
  sessionId: string
  cwd: string
  tmux?: string
  name?: string
  status?: string
  waitingFor?: string
  statusUpdatedAt?: number
  updatedAt?: number
  kind?: string
  /** An unclaimed background helper the daemon keeps warm; never a session of its own. */
  spare?: boolean
  jobId?: string
  /** On an interactive front-end: the `jobId` of the background session it drives. */
  parkedJobId?: string
}

export function parseRegistryRow(text: string): RegistryRow | undefined {
  try {
    const v = JSON.parse(text) as Partial<RegistryRow>
    if (typeof v.pid !== 'number' || typeof v.sessionId !== 'string') return undefined
    return { ...v, cwd: typeof v.cwd === 'string' ? v.cwd : '' } as RegistryRow
  } catch {
    return undefined
  }
}

export function parsePublished(text: string): PublishedSession | undefined {
  try {
    const v = JSON.parse(text) as PublishedSession
    if (typeof v.sessionId !== 'string' || typeof v.updatedAt !== 'number') return undefined
    return v
  } catch {
    return undefined
  }
}

/** Live pids out of `ps -o pid= -p a,b,c` output. */
export function parsePsPids(stdout: string): Set<number> {
  const out = new Set<number>()
  for (const line of stdout.split('\n')) {
    const n = Number(line.trim().split(/\s+/)[0])
    if (Number.isInteger(n) && n > 0) out.add(n)
  }
  return out
}

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export function splitTmux(target: string | undefined): { session: string; window?: string } {
  if (!target) return { session: '' }
  const [session, rest] = target.split(':', 2)
  const window = rest?.split('.')[0]
  return { session: session ?? '', ...(window ? { window } : {}) }
}

/** ~/.claude/sessions status → the pane's three; `shell` and anything unknown read as idle. */
export function mapStatus(status: string | undefined): OtherSessionVM['status'] {
  if (status === 'busy') return 'busy'
  if (status === 'waiting') return 'waiting'
  return 'idle'
}

/** The summary lines a card shows under its name (ADR 0004). */
export interface SessionContext {
  goal?: string
  day?: number
  step?: string
  prText?: string
  todos?: TodoProgress
  glosses?: Record<string, string>
  context?: ContextUsage
}

/** What a session is about, from its transcript: the AI title (or a /rename), else its first prompt. */
export interface SessionTopic {
  title?: string
  firstPrompt?: string
}

const DEFAULT_BRANCHES = new Set(['main', 'master'])

/** "<repo or worktree> · <branch>" (branch left out on main), then the session's published doing line; none when it would only repeat the tmux group. */
export function detailOf(row: RegistryRow, branch: string | undefined, doing: string | undefined): string | undefined {
  const place = basename(row.cwd)
  const where = [place, branch && branch !== place && !DEFAULT_BRANCHES.has(branch) ? branch : undefined].filter(Boolean).join(' · ')
  if (!doing && where === splitTmux(row.tmux).session) return undefined
  const text = [where, doing].filter(Boolean).join(' · ')
  return text || undefined
}

export function toSessionVM(
  row: RegistryRow,
  branch: string | undefined,
  published: PublishedSession | undefined,
  now: number,
  topic: SessionTopic = {},
  transcriptAgents?: readonly OtherAgentVM[],
  ctx: SessionContext = {},
  wait?: WaitVM,
  term?: TermEnv,
  openIn?: string,
): OtherSessionVM {
  const { window } = splitTmux(row.tmux)
  const real = isRealWait(wait)
  const name = ctx.goal || topic.title || topic.firstPrompt || nameOf(row) || basename(row.cwd) || 'session'
  const label = branch || basename(row.cwd)
  const status = real ? 'waiting' : mapStatus(row.status)
  const fresh = published && now - published.updatedAt < PUBLISH_FRESH_MS ? published : undefined
  const agents = fresh?.agents ?? transcriptAgents
  return {
    sessionId: row.sessionId,
    name,
    windowLabel: window ? `${window} ${label}` : label,
    status,
    ...(row.tmux ? { tmuxTarget: row.tmux } : {}),
    ...(j => (j ? { jump: j } : {}))(jumpOf(row, term, openIn)),
    ...(row.kind === 'bg' && !row.tmux ? { background: true as const } : {}),
    ...(real ? { waitingFor: wait.text, wait } : status === 'waiting' && row.waitingFor ? { waitingFor: row.waitingFor } : {}),
    ...(wait?.kind === 'turn' && status === 'idle' ? { wait } : {}),
    ...(real ? { statusSince: wait.since } : typeof row.statusUpdatedAt === 'number' ? { statusSince: row.statusUpdatedAt } : {}),
    ...(fresh ? { agentsRunning: fresh.agentsRunning, prSummary: fresh.prSummary } : {}),
    ...(fresh?.prs?.length ? { prs: fresh.prs } : {}),
    ...(!fresh && agents?.length ? { agentsRunning: agents.length } : {}),
    ...(agents?.length ? { agents: [...agents] } : {}),
    ...(d => (d ? { detail: d } : {}))(detailOf(row, branch, fresh?.doing)),
    ...(ctx.day ? { day: ctx.day } : {}),
    ...(ctx.step ? { step: ctx.step } : {}),
    ...(ctx.prText ? { prText: ctx.prText } : {}),
    ...(ctx.todos ? { todos: ctx.todos } : {}),
    ...(ctx.glosses && Object.keys(ctx.glosses).length ? { glosses: ctx.glosses } : {}),
    ...(ctx.context ? { context: ctx.context } : {}),
  }
}

/** A detected session focuses through ADR 0008's strategies; an undetected one keeps the plain tmux jump. */
export function jumpOf(row: RegistryRow, term: TermEnv | undefined, openIn?: string): Jump | undefined {
  if (!term) return row.tmux ? { kind: 'tmux', target: row.tmux } : undefined
  return {
    kind: 'session',
    sessionId: row.sessionId,
    cwd: row.cwd,
    pid: row.pid,
    term,
    ...(row.tmux ? { tmux: row.tmux } : {}),
    ...(row.kind === 'bg' ? { bg: true as const } : {}),
    ...(row.jobId ? { jobId: row.jobId } : {}),
    ...(row.kind === 'bg' && row.jobId && openIn ? { openIn } : {}),
  }
}

/** A registry name that is only the session or job id (a spare's, a fresh bg session's) names nothing. */
function nameOf(row: RegistryRow): string | undefined {
  const n = row.name?.trim()
  if (!n || n === row.jobId || row.sessionId.startsWith(n)) return undefined
  return n
}

const TITLE_RE = /"(?:aiTitle|customTitle)":"((?:[^"\\]|\\.)*)"/g

/** The newest AI or custom title in a transcript's grep output. */
export function parseTitle(text: string): string | undefined {
  let last: string | undefined
  for (const m of text.matchAll(TITLE_RE)) {
    try {
      last = JSON.parse(`"${m[1]}"`) as string
    } catch {
      // a cut line
    }
  }
  return last?.trim() || undefined
}

/** First line of the first user prompt, from one transcript `"type":"user"` line. */
export function parseFirstPrompt(line: string): string | undefined {
  try {
    const v = JSON.parse(line) as { message?: { content?: unknown } }
    const c = v.message?.content
    const text =
      typeof c === 'string'
        ? c
        : Array.isArray(c)
          ? c
              .map(b =>
                b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '',
              )
              .join('\n')
          : ''
    const first = text
      .split('\n')
      .map(l => l.trim())
      .find(l => l && !l.startsWith('<'))
    return first ? (first.length > 80 ? `${first.slice(0, 79)}…` : first) : undefined
  } catch {
    return undefined
  }
}

/** `~/.claude/projects/<cwd, non-alphanumerics as ->/<sessionId>.jsonl`. */
export function transcriptPath(home: string, cwd: string, sessionId: string): string {
  return `${home}/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, '-')}/${sessionId}.jsonl`
}

function rank(s: OtherSessionVM): number {
  if (s.status === 'waiting') return 0
  if ((s.prSummary?.broken ?? 0) > 0) return 1
  if (s.status === 'busy') return 2
  return 3
}

/** Waiting first (longest wait first), then broken, busy, idle by recency. */
export function compareSessions(a: OtherSessionVM, b: OtherSessionVM): number {
  const r = rank(a) - rank(b)
  if (r !== 0) return r
  const since = (a.statusSince ?? 0) - (b.statusSince ?? 0)
  if (rank(a) === 0 && since !== 0) return since
  if (rank(a) !== 0 && since !== 0) return -since
  return a.name.localeCompare(b.name) || a.sessionId.localeCompare(b.sessionId)
}

export function groupByTmux(sessions: readonly OtherSessionVM[]): TmuxGroupVM[] {
  const groups = new Map<string, OtherSessionVM[]>()
  // tmux session names cannot contain ':', so this key never collides with one.
  const BG = ':bg'
  for (const s of [...sessions].sort(compareSessions)) {
    const key = s.background && !s.tmuxTarget ? BG : splitTmux(s.tmuxTarget).session
    const list = groups.get(key) ?? []
    list.push(s)
    groups.set(key, list)
  }
  // Map keeps insertion order, and sessions were sorted, so the group of the most urgent session leads.
  return [...groups].map(([key, list]) =>
    key === BG ? { tmuxSession: '', background: true as const, sessions: list } : { tmuxSession: key, sessions: list },
  )
}

/** The other session that has waited for input longest. */
export function pickFlare(sessions: readonly OtherSessionVM[]): Flare | undefined {
  const waiting = sessions.filter(s => s.status === 'waiting' && s.tmuxTarget).sort((a, b) => (a.statusSince ?? 0) - (b.statusSince ?? 0))
  const top = waiting[0]
  if (!top || !top.tmuxTarget) return undefined
  return {
    text: isRealWait(top.wait) ? `${top.name} asks: ${top.wait.text}` : `${top.name} is waiting for your input`,
    sinceMs: top.statusSince ?? 0,
    tmuxTarget: top.tmuxTarget,
    jump: { kind: 'tmux', target: top.tmuxTarget },
  }
}

/** This process's registry row: by session id, else by the pid it had (a /clear changes the id, not the pid). */
export function findSelf(rows: readonly RegistryRow[], selfId: string, selfPid: number | undefined): RegistryRow | undefined {
  return rows.find(r => r.sessionId === selfId) ?? (selfPid ? rows.find(r => r.pid === selfPid) : undefined)
}

/** The interactive front-end and the background session it drives are one session: front.parkedJobId === bg.jobId. */
export function isPaired(a: RegistryRow, b: RegistryRow): boolean {
  return (!!a.parkedJobId && a.parkedJobId === b.jobId) || (!!b.parkedJobId && b.parkedJobId === a.jobId)
}

/** Rows that are this session: its own and its paired front-end or background half. */
export function isSelfRow(r: RegistryRow, self: RegistryRow | undefined, selfId: string): boolean {
  return r.sessionId === selfId || (self !== undefined && (r === self || r.pid === self.pid || isPaired(r, self)))
}

/** Rows shown as other sessions: alive, not this session, not a spare. */
export function isOtherRow(r: RegistryRow, self: RegistryRow | undefined, selfId: string, alive: ReadonlySet<number>): boolean {
  return !r.spare && alive.has(r.pid) && !isSelfRow(r, self, selfId)
}

/** The tmux pane this session is reached through: its own, else its paired front-end's. */
export function selfTmux(rows: readonly RegistryRow[], self: RegistryRow | undefined): string | undefined {
  if (!self) return undefined
  return self.tmux ?? rows.find(r => r !== self && isPaired(r, self) && r.tmux)?.tmux
}

/** Shown front-ends whose background worker is shown too, mapped to that worker: each pair draws as one card. */
export function pairsOf(rows: readonly RegistryRow[], shown: (r: RegistryRow) => boolean): Map<RegistryRow, RegistryRow> {
  const out = new Map<RegistryRow, RegistryRow>()
  const live = rows.filter(shown)
  for (const front of live) {
    if (!front.parkedJobId) continue
    const worker = live.find(r => r !== front && r.jobId === front.parkedJobId)
    if (worker) out.set(front, worker)
  }
  return out
}

const STATUS_RANK = { waiting: 0, busy: 1, idle: 2 } as const

/** One card for a pair: the worker's content (its transcript and publish carry the work), the front-end's tmux and jump, the busier half's status and wait. */
export function mergePair(front: OtherSessionVM, worker: OtherSessionVM): OtherSessionVM {
  const lead = STATUS_RANK[front.status] < STATUS_RANK[worker.status] ? front : worker
  const { status: _s, statusSince: _ss, waitingFor: _wf, wait: _w, jump: _j, ...content } = { ...front, ...worker }
  return {
    ...content,
    status: lead.status,
    ...(lead.statusSince !== undefined ? { statusSince: lead.statusSince } : {}),
    ...(lead.waitingFor !== undefined ? { waitingFor: lead.waitingFor } : {}),
    ...(lead.wait ? { wait: lead.wait } : {}),
    ...(j => (j ? { jump: j } : {}))(front.jump ?? worker.jump),
  }
}

export function buildFleet(
  rows: readonly RegistryRow[],
  alive: ReadonlySet<number>,
  selfId: string,
  branches: ReadonlyMap<string, string | undefined>,
  published: ReadonlyMap<string, PublishedSession>,
  now: number,
  selfPid?: number,
  topics: ReadonlyMap<string, SessionTopic> = new Map(),
  agents: ReadonlyMap<string, readonly OtherAgentVM[]> = new Map(),
  contexts: ReadonlyMap<string, SessionContext> = new Map(),
  waits: ReadonlyMap<string, WaitVM> = new Map(),
  terms: ReadonlyMap<number, TermEnv> = new Map(),
): { self?: RegistryRow; others: TmuxGroupVM[] } {
  const self = findSelf(rows, selfId, selfPid)
  const here = splitTmux(selfTmux(rows, self)).session || undefined
  const vm = (r: RegistryRow) =>
    toSessionVM(
      r,
      branches.get(r.cwd),
      published.get(r.sessionId),
      now,
      topics.get(r.sessionId),
      agents.get(r.sessionId),
      contexts.get(r.sessionId),
      waits.get(r.sessionId),
      terms.get(r.pid),
      here,
    )
  const pairs = pairsOf(rows, r => isOtherRow(r, self, selfId, alive))
  const workers = new Set(pairs.values())
  const others = rows
    .filter(r => isOtherRow(r, self, selfId, alive) && !workers.has(r))
    .map(r => {
      const worker = pairs.get(r)
      return worker ? mergePair(vm(r), vm({ ...worker, tmux: r.tmux })) : vm(r)
    })
  return { ...(self ? { self } : {}), others: groupByTmux(others) }
}
