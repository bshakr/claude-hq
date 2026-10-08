import { describe, expect, test } from 'claude-code/testing'

import type { WaveRow } from '../types'
import {
  MERGED_KEEP_MS,
  deriveCi,
  deriveGallery,
  deriveMerge,
  detectTransitions,
  dropExpired,
  rowFromPr,
  sortRows,
  stateLine,
  statusLine,
  wakePrompt,
} from '../hooks/logic'

const run = (name: string, status: string, conclusion = '') => ({
  __typename: 'CheckRun',
  name,
  status,
  conclusion,
})

function row(number: number, over: Partial<WaveRow> = {}): WaveRow {
  return {
    url: `https://github.com/acme/app/pull/${number}`,
    repo: 'acme/app',
    number,
    title: `PR ${number}`,
    status: 'open',
    isDraft: false,
    ci: { kind: 'green' },
    merge: 'mergeable',
    gallery: 'none',
    mergedAt: null,
    ...over,
  }
}

describe('CI derivation', () => {
  test('all success, neutral or skipped is green', async () => {
    expect(
      deriveCi([run('a', 'COMPLETED', 'SUCCESS'), run('b', 'COMPLETED', 'NEUTRAL'), run('c', 'COMPLETED', 'SKIPPED')]),
    ).toEqual({ kind: 'green' })
  })

  test('a failure is red and names the first failing check, even while others run', async () => {
    expect(
      deriveCi([run('lint', 'COMPLETED', 'SUCCESS'), run('rspec', 'COMPLETED', 'FAILURE'), run('e2e', 'IN_PROGRESS'), run('x', 'COMPLETED', 'TIMED_OUT')]),
    ).toEqual({ kind: 'red', failing: 'rspec' })
    expect(deriveCi([run('deploy', 'COMPLETED', 'CANCELLED')])).toEqual({ kind: 'red', failing: 'deploy' })
  })

  test('a legacy status context in ERROR is red under its context name', async () => {
    expect(deriveCi([{ __typename: 'StatusContext', context: 'ci/circle', state: 'ERROR' }])).toEqual({
      kind: 'red',
      failing: 'ci/circle',
    })
  })

  test('pending checks are running with done/total', async () => {
    expect(
      deriveCi([run('a', 'COMPLETED', 'SUCCESS'), run('b', 'IN_PROGRESS'), run('c', 'QUEUED'), { context: 'd', state: 'PENDING' }]),
    ).toEqual({ kind: 'running', done: 1, total: 4 })
  })

  test('no checks is none', async () => {
    expect(deriveCi([])).toEqual({ kind: 'none' })
    expect(deriveCi(null)).toEqual({ kind: 'none' })
  })
})

describe('merge derivation', () => {
  test('conflicting beats behind, behind is needs rebase', async () => {
    expect(deriveMerge('CONFLICTING', 'BEHIND')).toBe('conflicting')
    expect(deriveMerge('MERGEABLE', 'BEHIND')).toBe('needs rebase')
    expect(deriveMerge('MERGEABLE', 'CLEAN')).toBe('mergeable')
    expect(deriveMerge('UNKNOWN', 'UNKNOWN')).toBe('unknown')
  })
})

describe('gallery detection', () => {
  test('artifact links in either spelling are linked', async () => {
    expect(deriveGallery('## Screenshots\nhttps://claude.ai/artifact/FmTfup59LioFHGdPCKPfKf')).toBe('linked')
    expect(deriveGallery('see https://claude.ai/code/artifact/123e4567-e89b')).toBe('linked')
  })

  test('a line starting "No visual change:" counts', async () => {
    expect(deriveGallery('## Screenshots\nNo visual change: built CSS identical')).toBe('no visual change')
    expect(deriveGallery('We said No visual change: inline')).toBe('none')
  })

  test('other claude.ai links and empty bodies are none', async () => {
    expect(deriveGallery('https://claude.ai/chat/abc')).toBe('none')
    expect(deriveGallery('')).toBe('none')
  })
})

describe('rows', () => {
  test('a closed unmerged PR is dropped, a merged one keeps its first-seen time', async () => {
    const pr = {
      number: 9, title: 't', url: 'https://github.com/acme/app/pull/9', state: 'CLOSED', isDraft: false,
      mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', statusCheckRollup: [], body: '', headRefName: 'h', baseRefName: 'main',
    }
    expect(rowFromPr(pr, 'acme/app', 1000)).toBe(null)
    expect(rowFromPr({ ...pr, state: 'MERGED' }, 'acme/app', 1000)?.mergedAt).toBe(1000)
    expect(rowFromPr({ ...pr, state: 'MERGED' }, 'acme/app', 5000, row(9, { status: 'merged', mergedAt: 1000 }))?.mergedAt).toBe(1000)
  })

  test('sort: red, then conflicting/rebase, running, green, merged', async () => {
    const sorted = sortRows([
      row(1, { status: 'merged', mergedAt: 0 }),
      row(2),
      row(3, { ci: { kind: 'running', done: 1, total: 2 } }),
      row(4, { merge: 'needs rebase' }),
      row(5, { ci: { kind: 'red', failing: 'rspec' } }),
    ])
    expect(sorted.map(r => r.number)).toEqual([5, 4, 3, 2, 1])
  })

  test('merged rows drop after 30 minutes', async () => {
    const kept = dropExpired([row(1, { status: 'merged', mergedAt: 0 }), row(2)], MERGED_KEEP_MS)
    expect(kept.map(r => r.number)).toEqual([2])
  })

  test('state and status lines', async () => {
    expect(stateLine(row(1, { ci: { kind: 'red', failing: 'rspec' }, merge: 'needs rebase' }))).toBe(
      'CI red: rspec · needs rebase · gallery none',
    )
    expect(statusLine([row(1), row(2), row(3, { ci: { kind: 'red', failing: 'x' } }), row(4, { merge: 'needs rebase' })], null)).toBe(
      'wave: 3 green · 1 red · 1 rebase',
    )
    expect(statusLine([], null)).toBe(undefined)
    expect(statusLine([row(1)], 'gh failed: auth')).toBe('wave: gh failed: auth')
  })
})

describe('transitions', () => {
  test('nothing on the first poll', async () => {
    expect(detectTransitions(null, [row(1, { ci: { kind: 'red', failing: 'rspec' } })])).toEqual([])
  })

  test('CI going red is one transition naming the check', async () => {
    const found = detectTransitions([row(1, { ci: { kind: 'running', done: 1, total: 3 } })], [row(1, { ci: { kind: 'red', failing: 'rspec' } })])
    expect(found.map(t => t.kind)).toEqual(['ci-red'])
    expect(wakePrompt(found)).toBe(
      '[wave-watcher] acme/app#1 CI went red (failing check: rspec). Triage: read the failing log and report; do not merge or push without asking.',
    )
  })

  test('staying red, or going green, is not a transition and never wakes', async () => {
    const red = row(1, { ci: { kind: 'red', failing: 'rspec' } })
    expect(detectTransitions([red], [red])).toEqual([])
    const green = detectTransitions([row(1, { ci: { kind: 'running', done: 0, total: 1 } })], [row(1)])
    expect(green).toEqual([])
    expect(wakePrompt(green)).toBe(null)
  })

  test('merged lists the other open PRs in that repo', async () => {
    const found = detectTransitions(
      [row(169), row(172), row(173)],
      [row(169, { status: 'merged', mergedAt: 5 }), row(172), row(173), row(1, { repo: 'other/repo', url: 'https://github.com/other/repo/pull/1' })],
    )
    expect(found.map(t => t.kind)).toEqual(['merged'])
    expect(wakePrompt(found)).toBe(
      '[wave-watcher] acme/app#169 merged. Other open PRs in that repo: #172, #173 — check whether they need a rebase and report; do not push without asking.',
    )
  })

  test('going behind or conflicting is a transition', async () => {
    const found = detectTransitions([row(1), row(2)], [row(1, { merge: 'needs rebase' }), row(2, { merge: 'conflicting' })])
    expect(found.map(t => t.kind)).toEqual(['needs rebase', 'conflicting'])
  })

  test('all transitions of one poll batch into one prompt', async () => {
    const found = detectTransitions(
      [row(1), row(2), row(3)],
      [row(1, { status: 'merged', mergedAt: 1 }), row(2, { ci: { kind: 'red', failing: 'rspec' } }), row(3, { merge: 'needs rebase' })],
    )
    expect(found.length).toBe(3)
    const prompt = wakePrompt(found) ?? ''
    expect(prompt.startsWith('[wave-watcher] Several PRs changed:')).toBe(true)
    expect(prompt.split('\n').length).toBe(4)
    expect(prompt).toContain('acme/app#1 merged. Other open PRs in that repo: #2, #3')
    expect(prompt).toContain('acme/app#2 CI went red (failing check: rspec)')
  })

  test('a merge with no other open PRs in the repo toasts but does not wake', async () => {
    const found = detectTransitions([row(1)], [row(1, { status: 'merged', mergedAt: 1 })])
    expect(found.map(t => t.kind)).toEqual(['merged'])
    expect(wakePrompt(found)).toBe(null)
  })

  test('unknown to conflicting is not a transition', async () => {
    expect(detectTransitions([row(1, { merge: 'unknown' })], [row(1, { merge: 'conflicting' })])).toEqual([])
  })

  test('mergeable to conflicting is a transition', async () => {
    expect(detectTransitions([row(1)], [row(1, { merge: 'conflicting' })]).map(t => t.kind)).toEqual(['conflicting'])
  })

  test('mergeable to needs rebase is a transition', async () => {
    expect(detectTransitions([row(1)], [row(1, { merge: 'needs rebase' })]).map(t => t.kind)).toEqual(['needs rebase'])
  })

  test('none to red is not a transition', async () => {
    expect(detectTransitions([row(1, { ci: { kind: 'none' } })], [row(1, { ci: { kind: 'red', failing: 'rspec' } })])).toEqual([])
  })

  test('running to red is a transition', async () => {
    expect(detectTransitions([row(1, { ci: { kind: 'running', done: 1, total: 2 } })], [row(1, { ci: { kind: 'red', failing: 'rspec' } })]).map(t => t.kind)).toEqual(['ci-red'])
  })

  test('green to red is a transition', async () => {
    expect(detectTransitions([row(1)], [row(1, { ci: { kind: 'red', failing: 'rspec' } })]).map(t => t.kind)).toEqual(['ci-red'])
  })
})
