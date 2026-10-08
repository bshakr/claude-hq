import { expect, test } from 'claude-code/testing'

import type { PrWatchState } from '../../hooks/model/types'
import { claimKey, deriveCi, deriveGallery, deriveMerge, prFromSources, prTone, stateFileName } from '../../hooks/data/prs'

const base: PrWatchState = {
  version: 1,
  repo: 'acme/app',
  number: 12,
  watcher: 'ci-wait',
  pid: 4242,
  updatedAt: '2026-10-08T10:00:00Z',
  headSha: 'abc',
  title: 'Ledger fix',
  url: 'https://github.com/acme/app/pull/12',
  state: 'OPEN',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  checks: [],
}
const yes = () => true
const no = () => false
const claim = { repo: 'acme/app', number: 12, claimedBy: 'main', claimedAt: 0 }
const run = (name: string) => ({ name, status: 'IN_PROGRESS', conclusion: null })
const ok = (name: string) => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' })
const bad = (name: string) => ({ name, status: 'COMPLETED', conclusion: 'FAILURE' })

test('state file: no checks yet is registering', () => {
  expect(deriveCi([])).toEqual({ kind: 'registering' })
})

test('state file: running counts done over total', () => {
  expect(deriveCi([ok('lint'), run('rspec'), run('build')])).toEqual({ kind: 'running', done: 1, total: 3, failed: 0 })
})

test('state file: failed names the first failing check', () => {
  expect(deriveCi([ok('lint'), bad('rspec'), run('build'), bad('e2e')])).toEqual({
    kind: 'failed',
    done: 3,
    total: 4,
    failed: 2,
    firstFailing: 'rspec',
  })
})

test('state file: gh-pr-checks style states are read too', () => {
  expect(
    deriveCi([
      { name: 'a', status: 'pass', conclusion: null },
      { name: 'b', status: 'fail', conclusion: null },
    ]),
  ).toEqual({ kind: 'failed', done: 2, total: 2, failed: 1, firstFailing: 'b' })
})

test('state file: passed', () => {
  expect(deriveCi([ok('lint'), ok('rspec'), { name: 'opt', status: 'COMPLETED', conclusion: 'SKIPPED' }])).toEqual({
    kind: 'passed',
    total: 3,
  })
})

test('state file: a skipped required check', () => {
  expect(deriveCi([ok('lint'), { name: 'deploy-gate', status: 'COMPLETED', conclusion: 'SKIPPED', required: true }])).toEqual({
    kind: 'skippedRequired',
    name: 'deploy-gate',
  })
})

test('state file: merge states', () => {
  expect(deriveMerge(base)).toBe('mergeable')
  expect(deriveMerge({ ...base, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })).toBe('conflicting')
  expect(deriveMerge({ ...base, mergeStateStatus: 'BEHIND' })).toBe('behind')
  expect(deriveMerge({ ...base, mergeStateStatus: 'BLOCKED' })).toBe('blocked')
  expect(deriveMerge({ ...base, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })).toBe('unknown')
  expect(deriveMerge({ ...base, state: 'MERGED' })).toBe('merged')
  expect(deriveMerge({ ...base, state: 'CLOSED' })).toBe('closed')
})

test('state file: gallery from the body, unknown without one', () => {
  expect(deriveGallery(undefined)).toBe('unknown')
  expect(deriveGallery('Gallery: https://claude.ai/artifact/abc')).toBe('linked')
  expect(deriveGallery('## Screenshots\nNo visual change: CSS diff empty')).toBe('no-visual-change')
  expect(deriveGallery('nothing')).toBe('none')
})

test('state file: watcher is none once the pid is dead or the watcher exited', () => {
  expect(prFromSources(claim, { ci: base }, yes).watcher).toBe('ci-wait')
  expect(prFromSources(claim, { ci: base }, no).watcher).toBe('none')
  expect(prFromSources(claim, { ci: { ...base, exited: { code: 0, at: '2026-10-08T10:05:00Z', reason: 'green' } } }, yes).watcher).toBe(
    'none',
  )
})

test('state file: merged PR row carries mergedAt from when it was first seen merged', () => {
  const pr = prFromSources({ ...claim, endedAt: 5_000 }, { ci: { ...base, state: 'MERGED' } }, no)
  expect(pr.merge).toBe('merged')
  expect(pr.mergedAt).toBe(5_000)
  expect(pr.polledAt).toBe(Date.parse('2026-10-08T10:00:00Z'))
})

test('no state file: title and url from the claim, ci none, watcher none, waiting on him', () => {
  const pr = prFromSources({ ...claim, title: 'From gh', url: 'https://github.com/acme/app/pull/12' }, {}, yes)
  expect(pr).toEqual({
    repo: 'acme/app',
    number: 12,
    title: 'From gh',
    url: 'https://github.com/acme/app/pull/12',
    ci: { kind: 'none' },
    merge: 'unknown',
    gallery: 'unknown',
    watcher: 'none',
    claimedBy: 'main',
  })
  expect(prTone(pr)).toBe('waiting')
})

test('tones: blocked while checks run is progress, not waiting', () => {
  const running = prFromSources(claim, { ci: { ...base, mergeStateStatus: 'BLOCKED', checks: [run('rspec')] } }, yes)
  expect(prTone(running)).toBe('progress')
  const done = prFromSources(claim, { ci: { ...base, mergeStateStatus: 'BLOCKED', checks: [ok('rspec')] } }, yes)
  expect(prTone(done)).toBe('waiting')
  expect(prTone(prFromSources(claim, { ci: { ...base, checks: [bad('rspec')] } }, yes))).toBe('broken')
})

test('state file name', () => {
  expect(stateFileName('Acme/App', 12, 'ci-wait')).toBe('acme__app__12.ci-wait.json')
  expect(stateFileName('acme/app', 12, 'merge-wait')).toBe('acme__app__12.merge-wait.json')
})

const ciFile: PrWatchState = {
  ...base,
  watcher: 'ci-wait',
  pid: 1,
  updatedAt: '2026-10-08T10:00:00Z',
  mergeable: undefined,
  mergeStateStatus: undefined,
  checks: [ok('lint'), ok('rspec')],
  title: 'Old title',
}
const mergeFile: PrWatchState = {
  ...base,
  watcher: 'merge-wait',
  pid: 2,
  updatedAt: '2026-10-08T10:01:00Z',
  checks: [],
  title: 'New title',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'BEHIND',
  body: 'https://claude.ai/artifact/x',
}

test('two files: checks from ci-wait, merge from merge-wait, title from the newer, settled CI prefers merge-wait', () => {
  const pr = prFromSources(claim, { ci: ciFile, merge: mergeFile }, yes)
  expect(pr).toMatchObject({
    ci: { kind: 'passed', total: 2 },
    merge: 'behind',
    title: 'New title',
    gallery: 'linked',
    watcher: 'merge-wait',
    polledAt: Date.parse('2026-10-08T10:01:00Z'),
  })
  expect(pr.stale).toBe(undefined)
  const running = prFromSources(claim, { ci: { ...ciFile, checks: [run('rspec')] }, merge: mergeFile }, yes)
  expect(running.watcher).toBe('ci-wait')
  expect(prFromSources(claim, { ci: ciFile, merge: mergeFile }, pid => pid === 1).watcher).toBe('ci-wait')
})

test('one stale file: last values kept, row flagged and never healthy', () => {
  const pr = prFromSources(
    claim,
    { ci: { ...ciFile, stale: true, lastOkAt: '2026-10-08T09:58:00Z' }, merge: { ...mergeFile, mergeStateStatus: 'CLEAN' } },
    yes,
  )
  expect(pr).toMatchObject({ ci: { kind: 'passed', total: 2 }, merge: 'mergeable', stale: true })
  expect(prTone(pr)).toBe('waiting')
  expect(prTone({ ...pr, stale: undefined })).toBe('quiet')
})

test('missing one of the two files', () => {
  const onlyMerge = prFromSources(claim, { merge: mergeFile }, yes)
  expect(onlyMerge).toMatchObject({ ci: { kind: 'none' }, merge: 'behind', watcher: 'merge-wait' })
  const onlyCi = prFromSources(claim, { ci: ciFile }, yes)
  expect(onlyCi).toMatchObject({ ci: { kind: 'passed', total: 2 }, merge: 'unknown', watcher: 'ci-wait' })
})

test('case normalisation: one claim per PR whatever the repo spelling', () => {
  expect(claimKey('Acme/App', 12)).toBe(claimKey('acme/app', 12))
})
