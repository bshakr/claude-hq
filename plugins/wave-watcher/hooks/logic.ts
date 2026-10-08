import type { WaveCi, WaveGallery, WaveMerge, WaveRow, WaveTransition } from '../types'

export const POLL_MS = 60_000
export const MERGED_KEEP_MS = 30 * 60_000

/** One entry of gh's statusCheckRollup: a CheckRun or a legacy StatusContext. */
export type GhCheck = {
  __typename?: string
  name?: string
  context?: string
  status?: string
  conclusion?: string
  state?: string
}

export type GhSearchHit = {
  number: number
  repository: { nameWithOwner: string }
  title: string
  url: string
}

export type GhPr = {
  number: number
  title: string
  url: string
  state: string
  isDraft: boolean
  mergeable: string
  mergeStateStatus: string
  statusCheckRollup: GhCheck[] | null
  body: string
  headRefName: string
  baseRefName: string
}

const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
// ACTION_REQUIRED and STARTUP_FAILURE never turn green on their own either.
const FAILED = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])

function outcome(check: GhCheck): 'pending' | 'passed' | 'failed' | 'other' {
  if (check.state !== undefined && check.status === undefined) {
    if (check.state === 'PENDING' || check.state === 'EXPECTED') return 'pending'
    return PASSED.has(check.state) ? 'passed' : FAILED.has(check.state) ? 'failed' : 'other'
  }
  if (check.status !== 'COMPLETED') return 'pending'
  const conclusion = check.conclusion ?? ''
  return PASSED.has(conclusion) ? 'passed' : FAILED.has(conclusion) ? 'failed' : 'other'
}

export function deriveCi(checks: readonly GhCheck[] | null | undefined): WaveCi {
  const list = checks ?? []
  if (list.length === 0) return { kind: 'none' }
  const failed = list.find(check => outcome(check) === 'failed')
  if (failed) return { kind: 'red', failing: failed.name ?? failed.context ?? 'unnamed check' }
  const done = list.filter(check => outcome(check) !== 'pending').length
  if (done < list.length) return { kind: 'running', done, total: list.length }
  return { kind: 'green' }
}

export function deriveMerge(mergeable: string, mergeStateStatus: string): WaveMerge {
  if (mergeable === 'CONFLICTING') return 'conflicting'
  if (mergeStateStatus === 'BEHIND') return 'needs rebase'
  if (mergeable === 'MERGEABLE') return 'mergeable'
  return 'unknown'
}

export function deriveGallery(body: string | null | undefined): WaveGallery {
  const text = body ?? ''
  if (/claude\.ai\/(code\/)?artifact\//.test(text)) return 'linked'
  if (/^\s*No visual change:/m.test(text)) return 'no visual change'
  return 'none'
}

export function repoOfUrl(url: string): string {
  const match = /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(url)
  return match?.[1] ?? ''
}

/** A row from `gh pr view`; null when the PR is closed unmerged. */
export function rowFromPr(pr: GhPr, repo: string, now: number, previous?: WaveRow): WaveRow | null {
  if (pr.state === 'CLOSED') return null
  const isMerged = pr.state === 'MERGED'
  return {
    url: pr.url,
    repo,
    number: pr.number,
    title: pr.title,
    status: isMerged ? 'merged' : 'open',
    isDraft: pr.isDraft,
    ci: deriveCi(pr.statusCheckRollup),
    merge: isMerged ? 'unknown' : deriveMerge(pr.mergeable, pr.mergeStateStatus),
    gallery: deriveGallery(pr.body),
    mergedAt: isMerged ? (previous?.mergedAt ?? now) : null,
  }
}

function rank(row: WaveRow): number {
  if (row.status === 'merged') return 5
  if (row.ci.kind === 'red') return 0
  if (row.merge === 'conflicting' || row.merge === 'needs rebase') return 1
  if (row.ci.kind === 'running') return 2
  if (row.ci.kind === 'green') return 3
  return 4
}

export function sortRows(rows: readonly WaveRow[]): WaveRow[] {
  return [...rows].sort(
    (a, b) => rank(a) - rank(b) || a.repo.localeCompare(b.repo) || a.number - b.number,
  )
}

export function dropExpired(rows: readonly WaveRow[], now: number): WaveRow[] {
  return rows.filter(row => row.mergedAt === null || now - row.mergedAt < MERGED_KEEP_MS)
}

export type Dot = 'green' | 'red' | 'amber' | 'grey'

export function dotOf(row: WaveRow): Dot {
  if (row.status === 'merged') return 'grey'
  if (row.ci.kind === 'red' || row.merge === 'conflicting') return 'red'
  if (row.ci.kind === 'running' || row.merge === 'needs rebase') return 'amber'
  if (row.ci.kind === 'green') return 'green'
  return 'grey'
}

export function ciText(ci: WaveCi): string {
  switch (ci.kind) {
    case 'green':
      return 'CI green'
    case 'red':
      return `CI red: ${ci.failing}`
    case 'running':
      return `CI running ${ci.done}/${ci.total}`
    case 'none':
      return 'CI none'
  }
}

export function stateLine(row: WaveRow): string {
  if (row.status === 'merged') return `merged · gallery ${row.gallery}`
  const parts = [ciText(row.ci), row.merge, `gallery ${row.gallery}`]
  if (row.isDraft) parts.unshift('draft')
  return parts.join(' · ')
}

export function truncate(text: string, max: number): string {
  if (max <= 1) return text.slice(0, Math.max(0, max))
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

export function statusLine(rows: readonly WaveRow[], error: string | null): string | undefined {
  if (error !== null) return `wave: ${error}`
  if (rows.length === 0) return undefined
  const open = rows.filter(row => row.status === 'open')
  const counts: [number, string][] = [
    [open.filter(row => row.ci.kind === 'green').length, 'green'],
    [open.filter(row => row.ci.kind === 'running').length, 'running'],
    [open.filter(row => row.ci.kind === 'red').length, 'red'],
    [open.filter(row => row.merge === 'conflicting').length, 'conflict'],
    [open.filter(row => row.merge === 'needs rebase').length, 'rebase'],
    [rows.length - open.length, 'merged'],
  ]
  const shown = counts.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`)
  return `wave: ${shown.length > 0 ? shown.join(' · ') : `${open.length} open`}`
}

/** Transitions between two snapshots; `previous` null means first poll, so none. */
export function detectTransitions(
  previous: readonly WaveRow[] | null,
  next: readonly WaveRow[],
): WaveTransition[] {
  if (previous === null) return []
  const before = new Map(previous.map(row => [row.url, row]))
  const found: WaveTransition[] = []
  for (const row of next) {
    const old = before.get(row.url)
    if (!old) continue
    if (old.status === 'open' && row.status === 'merged') {
      const others = next
        .filter(o => o.repo === row.repo && o.status === 'open' && o.url !== row.url)
        .map(o => o.number)
      found.push({ kind: 'merged', row, others })
      continue
    }
    if (row.status !== 'open') continue
    if (row.ci.kind === 'red' && (old.ci.kind === 'green' || old.ci.kind === 'running')) {
      found.push({ kind: 'ci-red', row, failing: row.ci.failing })
    }
    if ((row.merge === 'conflicting' || row.merge === 'needs rebase') && old.merge === 'mergeable') {
      found.push({ kind: row.merge, row })
    }
  }
  return found
}

function ref(row: WaveRow): string {
  return `${row.repo}#${row.number}`
}

export function toastText(t: WaveTransition): string {
  switch (t.kind) {
    case 'ci-red':
      return `${ref(t.row)} CI went red: ${t.failing}`
    case 'merged':
      return `${ref(t.row)} merged`
    case 'conflicting':
      return `${ref(t.row)} has merge conflicts`
    case 'needs rebase':
      return `${ref(t.row)} needs a rebase`
  }
}

function promptLine(t: WaveTransition): string | null {
  switch (t.kind) {
    case 'ci-red':
      return `${ref(t.row)} CI went red (failing check: ${t.failing}). Triage: read the failing log and report; do not merge or push without asking.`
    case 'merged':
      // Nothing to rebase means nothing to ask the model; the toast covers it.
      if (t.others.length === 0) return null
      return `${ref(t.row)} merged. Other open PRs in that repo: ${t.others.map(n => `#${n}`).join(', ')} — check whether they need a rebase and report; do not push without asking.`
    case 'conflicting':
      return `${ref(t.row)} now has merge conflicts with its base. Check what conflicts and report; do not push without asking.`
    case 'needs rebase':
      return `${ref(t.row)} is behind its base and needs a rebase. Check whether it rebases cleanly and report; do not push without asking.`
  }
}

export function prKey(repo: string, number: number): string {
  return `${repo.toLowerCase()}#${number}`
}

/** PR keys this session owns, from HQ's published `~/.claude/hq/sessions/<sessionId>.json`. */
export function ownedFrom(text: string | undefined): Set<string> {
  const out = new Set<string>()
  if (!text) return out
  try {
    const v = JSON.parse(text) as { owned?: unknown }
    if (!Array.isArray(v.owned)) return out
    for (const o of v.owned) {
      const r = o as { repo?: unknown; number?: unknown }
      if (typeof r.repo === 'string' && typeof r.number === 'number') out.add(prKey(r.repo, r.number))
    }
  } catch {
    // unreadable: owns nothing
  }
  return out
}

/** The transitions that may wake this session: its own PRs, with "other open PRs" limited to its own too. */
export function ownedTransitions(transitions: readonly WaveTransition[], owned: ReadonlySet<string>): WaveTransition[] {
  const mine = (repo: string, n: number) => owned.has(prKey(repo, n))
  return transitions
    .filter(t => mine(t.row.repo, t.row.number))
    .map(t => (t.kind === 'merged' ? { ...t, others: t.others.filter(n => mine(t.row.repo, n)) } : t))
}

/** The rows the status line counts: this session's own. null clears the line (no HQ file, or none owned). */
export function ownedRows(rows: readonly WaveRow[], owned: ReadonlySet<string> | null): WaveRow[] | null {
  if (owned === null || owned.size === 0) return null
  return rows.filter(row => owned.has(prKey(row.repo, row.number)))
}

/** All of one poll's transitions as one prompt, or null when none should wake. */
export function wakePrompt(transitions: readonly WaveTransition[]): string | null {
  const lines = transitions.map(promptLine).filter((line): line is string => line !== null)
  if (lines.length === 0) return null
  if (lines.length === 1) return `[wave-watcher] ${lines[0]}`
  return ['[wave-watcher] Several PRs changed:', ...lines.map(line => `- ${line}`)].join('\n')
}

export function firstLine(text: string): string {
  return text.split('\n').find(line => line.trim() !== '')?.trim() ?? ''
}

export function parseWake(args: string): 'on' | 'off' | null {
  const match = /^wake\s+(on|off)$/.exec(args.trim())
  return match ? (match[1] as 'on' | 'off') : null
}

export function agoText(polledAt: number | null, now: number): string {
  if (polledAt === null) return 'not polled yet'
  const seconds = Math.max(0, Math.round((now - polledAt) / 1000))
  return seconds < 120 ? `polled ${seconds}s ago` : `polled ${Math.round(seconds / 60)}m ago`
}
