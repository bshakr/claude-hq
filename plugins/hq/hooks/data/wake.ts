import type { PrVM } from '../model/types'
import { claimKey, isEnded } from './prs'

/** `$.store` key of the `/hq wake on|off` toggle; absent means on. */
export const WAKE_KEY = 'wake'

export type PrTransition =
  | { kind: 'ci-red'; pr: PrVM; failing: string }
  | { kind: 'merged'; pr: PrVM; others: number[] }
  | { kind: 'conflicting' | 'behind'; pr: PrVM }

const RAN = new Set<PrVM['ci']['kind']>(['passed', 'running'])
const CLEAN = new Set<PrVM['merge']>(['mergeable', 'blocked'])

/**
 * Transitions of owned PRs between two ticks. A PR seen for the first time is never one,
 * so the first tick after a start or reload is silent; a stale row carries no news.
 */
export function detectTransitions(previous: readonly PrVM[], next: readonly PrVM[]): PrTransition[] {
  const before = new Map(previous.map(pr => [claimKey(pr.repo, pr.number), pr]))
  const found: PrTransition[] = []
  for (const pr of next) {
    const old = before.get(claimKey(pr.repo, pr.number))
    if (!old || pr.stale) continue
    if (!isEnded(old.merge) && pr.merge === 'merged') {
      const others = next
        .filter(o => o.repo.toLowerCase() === pr.repo.toLowerCase() && o.number !== pr.number && !isEnded(o.merge))
        .map(o => o.number)
      found.push({ kind: 'merged', pr, others })
      continue
    }
    if (isEnded(pr.merge)) continue
    if (pr.ci.kind === 'failed' && RAN.has(old.ci.kind)) found.push({ kind: 'ci-red', pr, failing: pr.ci.firstFailing })
    if ((pr.merge === 'conflicting' || pr.merge === 'behind') && CLEAN.has(old.merge)) found.push({ kind: pr.merge, pr })
  }
  return found
}

function ref(pr: PrVM): string {
  return `${pr.repo}#${pr.number}`
}

export function toastText(t: PrTransition): string {
  switch (t.kind) {
    case 'ci-red':
      return `${ref(t.pr)} CI went red: ${t.failing}`
    case 'merged':
      return `${ref(t.pr)} merged`
    case 'conflicting':
      return `${ref(t.pr)} has merge conflicts`
    case 'behind':
      return `${ref(t.pr)} needs a rebase`
  }
}

function promptLine(t: PrTransition): string | null {
  switch (t.kind) {
    case 'ci-red':
      return `${ref(t.pr)} CI went red (failing check: ${t.failing}). Triage: read the failing log and report; do not merge or push without asking.`
    case 'merged':
      // Nothing to rebase means nothing to ask the model; the toast covers it.
      if (t.others.length === 0) return null
      return `${ref(t.pr)} merged. Other owned open PRs in that repo: ${t.others.map(n => `#${n}`).join(', ')} — check whether they need a rebase and report; do not push without asking.`
    case 'conflicting':
      return `${ref(t.pr)} now has merge conflicts with its base. Check what conflicts and report; do not push without asking.`
    case 'behind':
      return `${ref(t.pr)} is behind its base and needs a rebase. Check whether it rebases cleanly and report; do not push without asking.`
  }
}

/** All of one tick's transitions as one prompt, or null when none should wake. */
export function wakePrompt(transitions: readonly PrTransition[]): string | null {
  const lines = transitions.map(promptLine).filter((line): line is string => line !== null)
  if (lines.length === 0) return null
  if (lines.length === 1) return `[hq] ${lines[0]}`
  return ['[hq] Several PRs changed:', ...lines.map(line => `- ${line}`)].join('\n')
}

export function parseWake(args: string): 'on' | 'off' | null {
  const match = /^wake\s+(on|off)$/.exec(args.trim())
  return match ? (match[1] as 'on' | 'off') : null
}

const BUCKETS = ['green', 'running', 'red', 'conflict', 'rebase', 'open', 'merged'] as const
export type Bucket = (typeof BUCKETS)[number]

/** One bucket per PR, the most urgent first, so a red PR that is also behind counts once. */
export function bucketOf(pr: PrVM): Bucket | undefined {
  if (pr.merge === 'merged') return 'merged'
  if (isEnded(pr.merge)) return undefined
  if (pr.ci.kind === 'failed') return 'red'
  if (pr.merge === 'conflicting') return 'conflict'
  if (pr.merge === 'behind') return 'rebase'
  if (pr.ci.kind === 'running' || pr.ci.kind === 'registering') return 'running'
  if (pr.ci.kind === 'passed') return 'green'
  return 'open'
}

/** The owned-PR part of the status line, e.g. "PRs 1 red · 2 green"; undefined with no owned PRs. */
export function prStatusPart(prs: readonly PrVM[]): string | undefined {
  const buckets = prs.map(bucketOf)
  const shown = BUCKETS.map(b => [buckets.filter(x => x === b).length, b] as const)
    .filter(([n]) => n > 0)
    .map(([n, b]) => `${n} ${b}`)
  return shown.length > 0 ? `PRs ${shown.join(' · ')}` : undefined
}

/** HQ's one status entry: its own parts, then the owned PRs'; '' clears it. */
export function withPrStatus(base: string, prs: readonly PrVM[]): string {
  const part = prStatusPart(prs)
  if (part === undefined) return base
  return base === '' ? `hq: ${part}` : `${base} · ${part}`
}

/** What one tick's owned-PR transitions say: a toast each, and at most one wake prompt with the first change that woke it. */
export function newsOf(previous: readonly PrVM[], next: readonly PrVM[]): { toasts: string[]; prompt: string | null; reason?: string } {
  const transitions = detectTransitions(previous, next)
  const prompt = wakePrompt(transitions)
  const first = transitions.find(t => promptLine(t) !== null)
  return { toasts: transitions.map(toastText), prompt, ...(prompt !== null && first ? { reason: toastText(first) } : {}) }
}
