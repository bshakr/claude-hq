import type { CiState, Gallery, MergeState, PrVM, PrWatchState, Watcher } from '../model/types'

export const MERGED_KEEP_MS = 30 * 60_000

import type { BranchClaim, OwnReason, OwnedState, StoredClaim } from '../../types'

export type { BranchClaim, OwnReason, OwnedState, StoredClaim }

export function claimKey(repo: string, number: number): string {
  return `${repo.toLowerCase()}#${number}`
}

export const WATCHERS = ['ci-wait', 'merge-wait'] as const

export function stateFileName(repo: string, number: number, watcher: (typeof WATCHERS)[number]): string {
  return `${repo.toLowerCase().replace('/', '__')}__${number}.${watcher}.json`
}

/** The PR's two watcher files, either or both absent. */
export interface PrFiles {
  ci?: PrWatchState
  merge?: PrWatchState
}

const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'PASS'])
const SKIPPED = new Set(['SKIPPED', 'SKIPPING'])
// ACTION_REQUIRED and STARTUP_FAILURE never turn green on their own either.
const FAILED = new Set(['FAILURE', 'FAIL', 'ERROR', 'CANCELLED', 'CANCEL', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'])
const DONE = new Set(['COMPLETED'])

type Outcome = 'pending' | 'passed' | 'skipped' | 'failed'

// The writer may emit statusCheckRollup style (status + conclusion) or `gh pr checks`
// style (state / bucket in `status`, conclusion null); both are read.
export function checkOutcome(check: { status: string; conclusion: string | null }): Outcome {
  const conclusion = (check.conclusion ?? '').toUpperCase()
  const status = (check.status ?? '').toUpperCase()
  for (const word of [conclusion, status]) {
    if (FAILED.has(word)) return 'failed'
    if (SKIPPED.has(word)) return 'skipped'
    if (PASSED.has(word)) return 'passed'
  }
  if (DONE.has(status)) return 'passed'
  return 'pending'
}

export function deriveCi(checks: PrWatchState['checks'] | undefined): CiState {
  const list = checks ?? []
  if (list.length === 0) return { kind: 'registering' }
  const outcomes = list.map(checkOutcome)
  const total = list.length
  const done = outcomes.filter(o => o !== 'pending').length
  const failed = outcomes.filter(o => o === 'failed').length
  const firstFail = outcomes.indexOf('failed')
  if (firstFail >= 0) return { kind: 'failed', done, total, failed, firstFailing: list[firstFail]!.name }
  const skippedRequired = list.find((c, i) => c.required === true && outcomes[i] === 'skipped')
  if (skippedRequired) return { kind: 'skippedRequired', name: skippedRequired.name }
  if (done < total) return { kind: 'running', done, total, failed: 0 }
  return { kind: 'passed', total }
}

export function deriveMerge(state: Pick<PrWatchState, 'state' | 'mergeable' | 'mergeStateStatus'>): MergeState {
  if (state.state === 'MERGED') return 'merged'
  if (state.state === 'CLOSED') return 'closed'
  const mergeable = (state.mergeable ?? '').toUpperCase()
  const mss = (state.mergeStateStatus ?? '').toUpperCase()
  if (mergeable === 'CONFLICTING' || mss === 'DIRTY') return 'conflicting'
  if (mss === 'BEHIND') return 'behind'
  if (mss === 'BLOCKED') return 'blocked'
  if (mergeable === 'MERGEABLE' || mss === 'CLEAN' || mss === 'HAS_HOOKS' || mss === 'UNSTABLE') return 'mergeable'
  return 'unknown'
}

export function deriveGallery(body: string | undefined): Gallery {
  if (body === undefined) return 'unknown'
  if (/claude\.ai\/(code\/)?artifact\//.test(body)) return 'linked'
  if (/^\s*No visual change:/m.test(body)) return 'no-visual-change'
  return 'none'
}

export function parseStateFile(text: string): PrWatchState | undefined {
  try {
    const v = JSON.parse(text) as PrWatchState
    if (!v || typeof v !== 'object' || typeof v.number !== 'number' || !Array.isArray(v.checks)) return undefined
    return v
  } catch {
    return undefined
  }
}

function newer(a: PrWatchState | undefined, b: PrWatchState | undefined): PrWatchState | undefined {
  if (!a || !b) return a ?? b
  return Date.parse(b.updatedAt) > Date.parse(a.updatedAt) ? b : a
}

const SETTLED = new Set<CiState['kind']>(['passed', 'failed', 'skippedRequired'])

/**
 * Builds a PR row from its claim and watcher files: checks from ci-wait, merge state from
 * merge-wait (ci-wait carries no `mergeable`), title/url/body/state from the newer file.
 */
export function prFromSources(claim: StoredClaim, files: PrFiles, isAlive: (pid: number) => boolean): PrVM {
  const latest = newer(files.ci, files.merge)
  const url = latest?.url ?? claim.url ?? `https://github.com/${claim.repo}/pull/${claim.number}`
  const title = latest?.title ?? claim.title ?? ''
  if (!latest) {
    const merge: MergeState = claim.ghState === 'MERGED' ? 'merged' : claim.ghState === 'CLOSED' ? 'closed' : 'unknown'
    return {
      repo: claim.repo,
      number: claim.number,
      title,
      url,
      ci: { kind: 'none' },
      merge,
      gallery: 'unknown',
      watcher: 'none',
      claimedBy: claim.claimedBy,
      ...(merge === 'merged' && claim.endedAt !== undefined ? { mergedAt: claim.endedAt } : {}),
    }
  }
  const ci: CiState = files.ci ? deriveCi(files.ci.checks) : { kind: 'none' }
  const mergeSource = files.merge ?? files.ci!
  // A watcher that exited before the merge leaves OPEN behind; a later GitHub read wins.
  const ghEnded = claim.ghState === 'MERGED' || claim.ghState === 'CLOSED'
  const ghNewer = claim.checkedAt !== undefined && claim.checkedAt > Date.parse(latest.updatedAt)
  const state = ghEnded && ghNewer ? (claim.ghState as PrWatchState['state']) : latest.state
  const merge = deriveMerge({ ...mergeSource, state })
  const live = (f: PrWatchState | undefined) => f !== undefined && !f.exited && isAlive(f.pid)
  const watcher: Watcher =
    live(files.ci) && live(files.merge)
      ? SETTLED.has(ci.kind)
        ? 'merge-wait'
        : 'ci-wait'
      : live(files.ci)
        ? 'ci-wait'
        : live(files.merge)
          ? 'merge-wait'
          : 'none'
  const polledAt = Math.max(...[files.ci, files.merge].map(f => (f ? Date.parse(f.updatedAt) : NaN)).filter(Number.isFinite))
  const body = latest.body ?? files.ci?.body ?? files.merge?.body
  const stale = files.ci?.stale === true || files.merge?.stale === true
  return {
    repo: claim.repo,
    number: claim.number,
    title,
    url,
    ci,
    merge,
    gallery: deriveGallery(body),
    watcher,
    claimedBy: claim.claimedBy,
    ...(Number.isFinite(polledAt) ? { polledAt } : {}),
    ...(merge === 'merged' && claim.endedAt !== undefined ? { mergedAt: claim.endedAt } : {}),
    ...(stale ? { stale: true } : {}),
  }
}

export function isEnded(merge: MergeState): boolean {
  return merge === 'merged' || merge === 'closed'
}

export type PrTone = 'broken' | 'waiting' | 'progress' | 'quiet' | 'done'

export function prTone(pr: PrVM): PrTone {
  if (isEnded(pr.merge)) return 'done'
  if (pr.ci.kind === 'failed' || pr.merge === 'conflicting') return 'broken'
  // A stale row shows last-known values, which must not read as healthy or progressing.
  if (pr.stale) return 'waiting'
  if (pr.watcher === 'none' || pr.merge === 'behind' || pr.ci.kind === 'skippedRequired') return 'waiting'
  if (pr.ci.kind === 'running' || pr.ci.kind === 'registering') return 'progress'
  // GitHub reports BLOCKED while required checks run too; only a finished PR is blocked on him.
  if (pr.merge === 'blocked') return 'waiting'
  return 'quiet'
}
