// Broader context for a session card (ADR 0004): facts read from its transcript, and the goal summary built from them.
import type { TodoProgress } from '../model/types'
import { noteWaitLine } from './waiting'
import type { TranscriptWait } from './waiting'

export const GOAL_MODEL = 'haiku'
export const GOAL_INPUT_MAX = 6_000
export const BUSY_REFRESH_MS = 30 * 60_000
export const PROMPTS_REFRESH = 5
export const FAIL_BACKOFF_MS = 5 * 60_000
/** A delta larger than this is not read whole: the transcript is scanned sparsely instead. */
export const CHUNK_BYTES = 1_000_000
export const HEAD_BYTES = 262_144
// Human prompts are not in the sparse scan (an image prompt carries megabytes), so the tail window is wide.
export const TAIL_BYTES = 1_000_000
export const PR_REFRESH_MS = 10 * 60_000
export const PR_LOOKUP_MAX = 20

const PROMPTS_KEPT = 10
const REPLIES_KEPT = 3
const TITLES_KEPT = 12
const BRANCHES_KEPT = 10
const DEFAULT_BRANCHES = new Set(['main', 'master', 'HEAD', ''])

export interface Task {
  id: string
  text: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** What one transcript has said so far; serialisable so it can be tested and kept. */
export interface Digest extends TranscriptWait {
  /** Bytes of the file consumed, up to the last whole line. */
  offset: number
  carry: string
  firstTs?: number
  lastTs?: number
  firstPrompt?: string
  titles: string[]
  prs: { url: string; repo: string; number: number; ts: number }[]
  branches: string[]
  prompts: { text: string; ts: number }[]
  replies: string[]
  compact?: { text: string; ts: number }
  tasks: Task[]
  /** tool_use id of a TaskCreate whose result has not been seen. */
  pendingCreates: Record<string, string>
}

export function emptyDigest(): Digest {
  return { offset: 0, carry: '', titles: [], prs: [], branches: [], prompts: [], replies: [], tasks: [], pendingCreates: {} }
}

export function utf8Bytes(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

/** Feeds a chunk read at `d.offset`; only whole lines are parsed and counted as consumed. */
export function ingest(d: Digest, chunk: string): void {
  const text = d.carry + chunk
  const cut = text.lastIndexOf('\n')
  if (cut < 0) {
    d.carry = text
    return
  }
  const whole = text.slice(0, cut + 1)
  d.carry = text.slice(cut + 1)
  d.offset += utf8Bytes(whole)
  for (const line of whole.split('\n')) if (line) ingestLine(d, line)
}

/** Lines out of a sparse scan (grep output, a head or tail window): parsed, nothing consumed. */
export function ingestLines(d: Digest, text: string, dropFirst = false): void {
  const lines = text.split('\n')
  if (dropFirst) lines.shift()
  for (const line of lines) if (line.trim()) ingestLine(d, line)
}

const pushDistinct = (list: string[], v: string, max: number) => {
  if (!v || list[list.length - 1] === v) return
  const i = list.indexOf(v)
  if (i >= 0) list.splice(i, 1)
  list.push(v)
  if (list.length > max) list.shift()
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

function tsOf(v: Obj): number | undefined {
  const t = str(v.timestamp)
  const n = t ? Date.parse(t) : NaN
  return Number.isFinite(n) ? n : undefined
}

function textOf(content: unknown): { text: string; hasToolResult: boolean } {
  if (typeof content === 'string') return { text: content, hasToolResult: false }
  if (!Array.isArray(content)) return { text: '', hasToolResult: false }
  let hasToolResult = false
  const parts: string[] = []
  for (const b of content) {
    const o = obj(b)
    if (!o) continue
    if (o.type === 'tool_result') hasToolResult = true
    else if (o.type === 'text' && typeof o.text === 'string') parts.push(o.text)
  }
  return { text: parts.join('\n'), hasToolResult }
}

/** "1. Primary Request and Intent:" up to the next numbered heading, else the summary's opening. */
export function intentOf(summary: string): string {
  const m = /Primary Request and Intent:?\s*([\s\S]*?)(?:\n\s*2\.\s|$)/.exec(summary)
  const body = (m?.[1] ?? summary.replace(/^[\s\S]*?Summary:\s*/, '')).trim()
  return body.slice(0, 2_500)
}

const STATUSES = new Set(['pending', 'in_progress', 'completed'])

function onToolUse(d: Digest, block: Obj): void {
  const input = obj(block.input) ?? {}
  if (block.name === 'TodoWrite' && Array.isArray(input.todos)) {
    d.tasks = input.todos.flatMap((t, i) => {
      const o = obj(t)
      const status = str(o?.status)
      const text = (status === 'in_progress' ? str(o?.activeForm) : undefined) ?? str(o?.content)
      return o && text && status && STATUSES.has(status) ? [{ id: `todo-${i}`, text, status: status as Task['status'] }] : []
    })
  } else if (block.name === 'TaskCreate') {
    const id = str(block.id)
    const subject = str(input.subject)
    if (id && subject) d.pendingCreates[id] = subject
  } else if (block.name === 'TaskUpdate') {
    const t = d.tasks.find(x => x.id === str(input.taskId))
    if (!t) return
    const status = str(input.status)
    if (status === 'deleted') d.tasks = d.tasks.filter(x => x !== t)
    else if (status && STATUSES.has(status)) t.status = status as Task['status']
    const text = t.status === 'in_progress' ? str(input.activeForm) : str(input.subject)
    if (text) t.text = text
  }
}

export function ingestLine(d: Digest, line: string): void {
  // Most lines are tool traffic; parse only the kinds this reads.
  if (
    !line.includes('"type":"user"') && !line.includes('"type":"assistant"') && !line.includes('"type":"ai-title"') &&
    !line.includes('"type":"pr-link"') && !line.includes('"customTitle"') && !line.includes('"queued_command"')
  ) {
    const t = /"timestamp":"([^"]+)"/.exec(line)
    if (t) noteTs(d, Date.parse(t[1]!))
    return
  }
  let v: Obj
  try {
    v = JSON.parse(line) as Obj
  } catch {
    return
  }
  const ts = tsOf(v)
  if (ts !== undefined) noteTs(d, ts)
  const branch = str(v.gitBranch)
  if (branch && !DEFAULT_BRANCHES.has(branch)) pushDistinct(d.branches, branch, BRANCHES_KEPT)
  if (v.type === 'user' || v.type === 'assistant') noteWaitLine(d, v, ts)
  switch (v.type) {
    case 'ai-title':
    case 'custom-title': {
      const t = (str(v.aiTitle) ?? str(v.customTitle))?.trim()
      if (t) pushDistinct(d.titles, t, TITLES_KEPT)
      return
    }
    case 'pr-link': {
      const url = str(v.prUrl)
      const number = typeof v.prNumber === 'number' ? v.prNumber : undefined
      const repo = str(v.prRepository)
      if (!url || number === undefined || !repo || d.prs.some(p => p.url === url)) return
      d.prs.push({ url, repo, number, ts: ts ?? d.lastTs ?? 0 })
      return
    }
    case 'user': {
      if (v.isSidechain === true) return
      const msg = obj(v.message)
      const { text, hasToolResult } = textOf(msg?.content)
      if (v.isCompactSummary === true) {
        d.compact = { text: intentOf(text), ts: ts ?? d.lastTs ?? 0 }
        return
      }
      const result = obj(v.toolUseResult)
      const task = obj(result?.task)
      if (hasToolResult && task) {
        const id = str(task.id)
        const subject = str(task.subject)
        const use = Array.isArray(msg?.content) ? str(obj(msg.content[0])?.tool_use_id) : undefined
        const fromUse = use ? d.pendingCreates[use] : undefined
        if (use) delete d.pendingCreates[use]
        const t = subject ?? fromUse
        if (id && t && !d.tasks.some(x => x.id === id)) d.tasks.push({ id, text: t, status: 'pending' })
        return
      }
      if (hasToolResult || v.isMeta === true || obj(v.origin)?.kind === 'task-notification') return
      addPrompt(d, text, ts)
      return
    }
    case 'attachment': {
      // A prompt typed while the session was busy is queued, not written as a user line.
      const a = obj(v.attachment)
      if (a?.type === 'queued_command' && obj(a.origin)?.kind === 'human') addPrompt(d, str(a.prompt) ?? '', ts)
      return
    }
    case 'assistant': {
      if (v.isSidechain === true) return
      const msg = obj(v.message)
      const content = Array.isArray(msg?.content) ? msg.content : []
      for (const b of content) {
        const o = obj(b)
        if (o?.type === 'tool_use') onToolUse(d, o)
      }
      if (msg?.stop_reason !== 'end_turn') return
      const t = textOf(content).text.trim()
      if (!t) return
      d.replies.push(t.replace(/\s+/g, ' ').slice(0, 300))
      if (d.replies.length > REPLIES_KEPT) d.replies.shift()
      return
    }
  }
}

function addPrompt(d: Digest, text: string, ts: number | undefined): void {
  const p = text.trim()
  if (!p || p.startsWith('<') || p.startsWith('[Request interrupted')) return
  if (d.firstPrompt === undefined) d.firstPrompt = p.slice(0, 1_000)
  const entry = { text: p.replace(/\s+/g, ' ').slice(0, 200), ts: ts ?? d.lastTs ?? 0 }
  // A sparse scan and the tail window can both hold the same line.
  if (d.prompts.some(x => x.ts === entry.ts && x.text === entry.text)) return
  d.prompts.push(entry)
  if (d.prompts.length > PROMPTS_KEPT) d.prompts.shift()
}

function noteTs(d: Digest, ts: number): void {
  if (!Number.isFinite(ts)) return
  if (d.firstTs === undefined) d.firstTs = ts
  if (d.lastTs === undefined || ts > d.lastTs) d.lastTs = ts
}

/** Calendar day of the session, 1 on the day its transcript starts. */
export function dayOf(firstTs: number | undefined, now: number): number | undefined {
  if (firstTs === undefined || firstTs > now) return undefined
  const a = new Date(firstTs)
  const b = new Date(now)
  const days = Math.round(
    (Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86_400_000,
  )
  return days + 1
}

export function todoProgress(tasks: readonly Task[]): TodoProgress | undefined {
  if (tasks.length === 0) return undefined
  const active = tasks.find(t => t.status === 'in_progress')?.text
  return { done: tasks.filter(t => t.status === 'completed').length, total: tasks.length, ...(active ? { active } : {}) }
}

// ---------- PRs ----------

export type PrState = 'OPEN' | 'MERGED' | 'CLOSED'

export const prKey = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`

/** The PRs whose state is looked up: the most recently linked, at most PR_LOOKUP_MAX. */
export function prsToLook(d: Pick<Digest, 'prs'>): Digest['prs'] {
  return [...d.prs].sort((a, b) => b.ts - a.ts).slice(0, PR_LOOKUP_MAX)
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

/** "12 PRs merged, 1 open", or "3 PRs linked" while no state is known. */
export function prText(prs: Digest['prs'], states: ReadonlyMap<string, PrState>): string | undefined {
  if (prs.length === 0) return undefined
  const n = { MERGED: 0, OPEN: 0, CLOSED: 0, unknown: 0 }
  for (const p of prs) n[states.get(prKey(p.repo, p.number)) ?? 'unknown']++
  const parts: [number, string][] = [[n.MERGED, 'merged'], [n.OPEN, 'open'], [n.CLOSED, 'closed']]
  const known = parts.filter(([k]) => k > 0)
  if (known.length === 0) return `${plural(prs.length, 'PR')} linked`
  const [first, ...rest] = known
  const out = [`${plural(first![0], 'PR')} ${first![1]}`, ...rest.map(([k, w]) => `${k} ${w}`)]
  if (n.unknown) out.push(`${n.unknown} more linked`)
  return out.join(', ')
}

/** `gh api graphql` query for some PR numbers of one repo. */
export function prStateQuery(repo: string, numbers: readonly number[]): string | undefined {
  const [owner, name] = repo.split('/')
  if (!owner || !name || numbers.length === 0 || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) return undefined
  const fields = numbers.map(n => `p${n}: pullRequest(number: ${Math.trunc(n)}) { state title headRefName }`).join(' ')
  return `query { repository(owner: "${owner}", name: "${name}") { ${fields} } }`
}

export function parsePrStates(stdout: string): Map<number, { state: PrState; title?: string; branch?: string }> {
  const out = new Map<number, { state: PrState; title?: string; branch?: string }>()
  try {
    const repo = obj(obj(obj(JSON.parse(stdout))?.data)?.repository) ?? {}
    for (const [k, v] of Object.entries(repo)) {
      const o = obj(v)
      const state = str(o?.state)
      if (!o || !/^p\d+$/.test(k) || (state !== 'OPEN' && state !== 'MERGED' && state !== 'CLOSED')) continue
      out.set(Number(k.slice(1)), { state, ...(str(o.title) ? { title: str(o.title)! } : {}), ...(str(o.headRefName) ? { branch: str(o.headRefName)! } : {}) })
    }
  } catch {
    // partial or failed reply: nothing known
  }
  return out
}

// ---------- the goal summary ----------

export interface GoalCache {
  goal?: string
  step?: string
  /** When the summary was made. */
  at: number
  /** Timestamp of the compaction and of the newest prompt it saw. */
  compactTs?: number
  promptTs?: number
  failedAt?: number
}

export interface GoalExtras {
  prTitles?: readonly string[]
  /** Titles of the tickets and ADRs the session names, as "BLO-1947: <title>". */
  idTitles?: readonly string[]
}

const TICKET_RE = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g

/** The model's input, by priority, within GOAL_INPUT_MAX characters. */
export function goalInput(d: Digest, extras: GoalExtras = {}): string {
  const tickets = new Set<string>()
  for (const t of [...(extras.prTitles ?? []), ...d.branches]) for (const m of t.matchAll(TICKET_RE)) tickets.add(m[0])
  const prLines = [...(extras.prTitles ?? []).map(t => `- ${t}`), ...(tickets.size ? [`tickets: ${[...tickets].join(', ')}`] : [])]
  const sections: [string, string, number][] = [
    ['Latest compaction summary (intent)', d.compact?.text ?? '', 2_000],
    ['First request', d.firstPrompt ?? '', 1_000],
    ['Title history (oldest first)', d.titles.join(' → '), 600],
    ['Pull requests', prLines.join('\n'), 800],
    ['Tickets and ADRs referenced', (extras.idTitles ?? []).map(t => `- ${t}`).join('\n'), 600],
    ['Task list', d.tasks.map(t => `- [${t.status}] ${t.text}`).join('\n'), 400],
    ['Recent requests', d.prompts.slice(-5).map(p => `- ${p.text}`).join('\n'), 1_000],
    ['Latest replies', d.replies.map(r => `- ${r}`).join('\n'), 900],
  ]
  let left = GOAL_INPUT_MAX
  const out: string[] = []
  for (const [head, body, cap] of sections) {
    if (!body) continue
    const room = Math.min(cap, left - head.length - 4)
    if (room < 40) break
    const text = `## ${head}\n${body.slice(0, room)}`
    out.push(text)
    left -= text.length + 2
  }
  return out.join('\n\n')
}

export const GOAL_SYSTEM =
  'You label a coding session on a dashboard. Reply with JSON only, no prose: ' +
  '{"goal": "<the overall goal of the session, at most 6 words>", "step": "<where the work is now, at most 8 words>"}. ' +
  'The goal is what the whole session is for, not the latest request.'

const words = (s: string, n: number) => s.trim().split(/\s+/).slice(0, n).join(' ').replace(/[.;,]+$/, '')

export function parseGoalReply(text: string): { goal: string; step?: string } | undefined {
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return undefined
  try {
    const v = obj(JSON.parse(m[0]))
    const goal = str(v?.goal)?.trim()
    if (!goal) return undefined
    const step = str(v?.step)?.trim()
    return { goal: words(goal, 6), ...(step ? { step: words(step, 8) } : {}) }
  } catch {
    return undefined
  }
}

export function hasContent(d: Digest): boolean {
  return d.compact !== undefined || d.firstPrompt !== undefined || d.titles.length > 0
}

/** A refresh is due on a new compaction, on PROMPTS_REFRESH new prompts, or every BUSY_REFRESH_MS while busy with new content. */
export function goalDue(c: GoalCache | undefined, d: Digest, busy: boolean, now: number): boolean {
  if (!hasContent(d)) return false
  if (c?.failedAt !== undefined && now - c.failedAt < FAIL_BACKOFF_MS) return false
  if (!c) return true
  if (c.goal === undefined) return c.failedAt === undefined || busy || (d.lastTs ?? 0) > c.failedAt
  if (d.compact && d.compact.ts > (c.compactTs ?? 0)) return true
  if (d.prompts.filter(p => p.ts > (c.promptTs ?? 0)).length >= PROMPTS_REFRESH) return true
  return busy && now - c.at >= BUSY_REFRESH_MS && (d.lastTs ?? 0) > c.at
}

export type Complete = (req: { system: string; prompt: string }) => Promise<{ isAnswered: boolean; text?: string }>

/** One model call; a failure keeps the old summary and backs off. */
export async function refreshGoal(d: Digest, cache: GoalCache | undefined, extras: GoalExtras, now: number, complete: Complete): Promise<GoalCache> {
  const failed: GoalCache = { ...(cache ?? { at: 0 }), failedAt: now }
  let reply: { isAnswered: boolean; text?: string }
  try {
    reply = await complete({ system: GOAL_SYSTEM, prompt: goalInput(d, extras) })
  } catch {
    return failed
  }
  const g = reply.isAnswered && reply.text ? parseGoalReply(reply.text) : undefined
  if (!g) return failed
  const promptTs = d.prompts.length ? d.prompts[d.prompts.length - 1]!.ts : undefined
  return {
    goal: g.goal, ...(g.step ? { step: g.step } : {}), at: now,
    ...(d.compact ? { compactTs: d.compact.ts } : {}), ...(promptTs !== undefined ? { promptTs } : {}),
  }
}

/** The card's name: the summary's goal, else the newest title, else the first prompt's first line. */
export function goalText(c: GoalCache | undefined, d: Digest | undefined): string | undefined {
  if (c?.goal) return c.goal
  const title = d?.titles[d.titles.length - 1]
  if (title) return title
  const first = d?.firstPrompt?.split('\n').map(l => l.trim()).find(Boolean)
  return first ? (first.length > 80 ? `${first.slice(0, 79)}…` : first) : undefined
}
