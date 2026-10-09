import { expect, test } from 'claude-code/testing'

import type { AgentVM, OtherSessionVM, PrVM } from '../../hooks/model/types'
import {
  buildFleet,
  groupByTmux,
  parseFirstPrompt,
  parsePsPids,
  parseRegistryRow,
  parseTitle,
  pickFlare,
  toSessionVM,
  transcriptPath,
} from '../../hooks/data/fleet'
import { buildModel, countsOf, fingerprint, statusTextOf } from '../../hooks/data/model'

const NOW = 10_000_000

function session(
  name: string,
  tmux: string,
  status: OtherSessionVM['status'],
  since: number,
  extra: Partial<OtherSessionVM> = {},
): OtherSessionVM {
  return {
    sessionId: name,
    name,
    tmuxTarget: tmux,
    windowLabel: '',
    status,
    statusSince: since,
    jump: { kind: 'tmux', target: tmux },
    ...extra,
  }
}

test('fleet: registry row → session VM; shell reads as idle; stale publish ignored', () => {
  const row = parseRegistryRow(
    JSON.stringify({
      pid: 45327,
      sessionId: 's1',
      cwd: '/Users/me/code/webapp-ui',
      tmux: 'webapp-ui:@3.%7',
      name: 'webapp-ui-bb',
      status: 'shell',
      statusUpdatedAt: NOW - 60_000,
    }),
  )!
  const pub = {
    sessionId: 's1',
    pid: 45327,
    updatedAt: NOW - 5_000,
    agentsRunning: 2,
    prSummary: { total: 1, broken: 0, waiting: 1, inProgress: 0 },
  }
  expect(toSessionVM(row, 'ENG-1940-promote', pub, NOW)).toEqual({
    sessionId: 's1',
    name: 'webapp-ui-bb',
    windowLabel: '@3 ENG-1940-promote',
    status: 'idle',
    tmuxTarget: 'webapp-ui:@3.%7',
    jump: { kind: 'tmux', target: 'webapp-ui:@3.%7' },
    statusSince: NOW - 60_000,
    agentsRunning: 2,
    prSummary: pub.prSummary,
    detail: 'webapp-ui · ENG-1940-promote',
  })
  expect(toSessionVM(row, undefined, { ...pub, updatedAt: NOW - 31_000 }, NOW).agentsRunning).toBe(undefined)
  // Its published open PRs ride onto the card while the publish is fresh, and only then.
  const pr = {
    repo: 'acme/app',
    number: 7,
    title: 'Fix it',
    url: 'https://github.com/acme/app/pull/7',
    ci: { kind: 'failed' as const, done: 2, total: 2, failed: 1, firstFailing: 'api' },
    merge: 'mergeable' as const,
    gallery: 'none' as const,
    watcher: 'ci-wait' as const,
    claimedBy: 'main',
  }
  expect(toSessionVM(row, undefined, { ...pub, prs: [pr] }, NOW).prs).toEqual([pr])
  expect(toSessionVM(row, undefined, { ...pub, prs: [pr], updatedAt: NOW - 31_000 }, NOW).prs).toBe(undefined)
  expect('prs' in toSessionVM(row, undefined, { ...pub, prs: [] }, NOW)).toBe(false)
  expect(parseRegistryRow('{not json')).toBe(undefined)
  expect(parsePsPids('  38348\n45327\n')).toEqual(new Set([38348, 45327]))
})

test('fleet: grouped by tmux session, waiting groups first, longest wait first', () => {
  const groups = groupByTmux([
    session('home', 'devbox-local:@0.%1', 'idle', NOW - 300_000),
    session('st-admin', 'acme-store:@4.%2', 'busy', NOW - 360_000),
    session('st-mobile', 'acme-store:@5.%3', 'waiting', NOW - 60_000),
    session('st-api', 'acme-store:@3.%6', 'waiting', NOW - 120_000),
    session('rota', 'rota-roster:@6.%9', 'idle', NOW - 10_000),
  ])
  expect(groups.map(g => g.tmuxSession)).toEqual(['acme-store', 'rota-roster', 'devbox-local'])
  expect(groups[0]!.sessions.map(s => s.name)).toEqual(['st-api', 'st-mobile', 'st-admin'])
})

test('fleet: flare picks the longest-waiting other session', () => {
  const flare = pickFlare([
    session('st-mobile', 'acme-store:@5.%3', 'waiting', NOW - 60_000),
    session('st-api', 'acme-store:@3.%6', 'waiting', NOW - 120_000),
    session('idle', 'x:@1.%1', 'idle', NOW - 999_999),
  ])
  expect(flare).toEqual({
    text: 'st-api is waiting for your input',
    sinceMs: NOW - 120_000,
    tmuxTarget: 'acme-store:@3.%6',
    jump: { kind: 'tmux', target: 'acme-store:@3.%6' },
  })
})

// The design sheet's render (a): 3 waiting on you, 2 broken, 3 in progress, 10 sessions.
function sheetA() {
  const agent = (id: string, status: AgentVM['status']): AgentVM => ({
    id,
    title: id,
    status,
    background: true,
    startedAt: 0,
    toolCount: 0,
    files: [],
  })
  const pr = (number: number, p: Partial<PrVM>): PrVM => ({
    repo: 'acme/app',
    number,
    title: '',
    url: '',
    ci: { kind: 'passed', total: 7 },
    merge: 'mergeable',
    gallery: 'none',
    watcher: 'ci-wait',
    claimedBy: 'main',
    ...p,
  })
  const agents = [agent('a1', 'failed'), agent('a2', 'waiting'), agent('a3', 'running'), agent('a4', 'completed'), agent('a5', 'completed')]
  const prs = [
    pr(212, { ci: { kind: 'failed', done: 9, total: 9, failed: 1, firstFailing: 'rspec' } }),
    pr(214, { ci: { kind: 'running', done: 5, total: 9, failed: 0 } }),
    pr(431, { repo: 'acme-store/admin-web', merge: 'behind', watcher: 'merge-wait' }),
    pr(433, { repo: 'acme-store/admin-web', watcher: 'merge-wait' }),
    pr(429, { repo: 'acme-store/admin-web', merge: 'merged', watcher: 'none', mergedAt: NOW - 240_000 }),
    pr(522, { repo: 'acme-store/api', watcher: 'none' }),
  ]
  const others = groupByTmux([
    session('st-api', 'acme-store:@3.%6', 'waiting', NOW - 120_000, {
      agentsRunning: 1,
      prSummary: { total: 1, broken: 0, waiting: 1, inProgress: 0 },
    }),
    session('st-admin', 'acme-store:@4.%2', 'busy', NOW - 360_000, {
      agentsRunning: 4,
      prSummary: { total: 2, broken: 0, waiting: 1, inProgress: 0 },
    }),
    ...['st-docs', 'home', 'webapp-ui-research', 'travel', 'rota', 'rota-research', 'finance'].map((n, i) =>
      session(n, `t${i}:@${i}.%${i}`, 'idle', NOW - 1_000_000),
    ),
  ])
  return { agents, prs, others }
}

test('model: counts reproduce the sheet (3 waiting, 2 broken, 3 in progress, 10 sessions)', () => {
  expect(countsOf(sheetA())).toEqual({ waiting: 3, broken: 2, inProgress: 3, sessions: 10 })
})

test("model: status line names the one waiting session, then this session's PRs, each counted once", () => {
  const m = buildModel({ now: NOW, label: 'webapp-ui:@1 · ENG-1940-promote', ...sheetA() })
  expect(m.statusText).toBe('hq: st-api waiting 2m · PRs 2 green · 1 running · 1 red · 1 rebase · 1 merged')
  expect(m.flare?.text).toBe('st-api is waiting for your input')
  expect(m.current.prs.map(p => p.number)).toEqual([212, 214, 431, 433, 429, 522])
  const two = [session('a', 'x:@1.%1', 'waiting', NOW - 1), session('b', 'x:@2.%2', 'waiting', NOW - 2)]
  expect(statusTextOf(two, NOW)).toBe('hq: 2 waiting, b first <1m')
  expect(statusTextOf([], NOW)).toBe('')
})

test("model: status line leaves out other sessions' PRs and this session's agents", () => {
  const red = { kind: 'failed', done: 1, total: 1, failed: 1, firstFailing: 'ci' } as const
  const others = groupByTmux([
    session('web', 'x:@1.%1', 'busy', NOW - 1, { prSummary: { total: 1, broken: 1, waiting: 0, inProgress: 0 } }),
  ])
  const failed: AgentVM = { id: 'a', title: 'a', status: 'failed', background: true, startedAt: 0, toolCount: 0, files: [] }
  const own: PrVM = {
    repo: 'acme/app',
    number: 1,
    title: '',
    url: '',
    ci: red,
    merge: 'behind',
    gallery: 'none',
    watcher: 'ci-wait',
    claimedBy: 'main',
  }
  const m = buildModel({ now: NOW, label: 'x', agents: [failed], prs: [own], others })
  expect(m.statusText).toBe('hq: PRs 1 red')
  expect(buildModel({ now: NOW, label: 'x', agents: [failed], prs: [], others }).statusText).toBe('')
})

test('model: fingerprint ignores the clock and key order', () => {
  const a = buildModel({ now: NOW, label: 'x', ...sheetA() })
  const b = buildModel({ now: NOW + 1_000, label: 'x', ...sheetA() })
  expect(fingerprint(a)).toBe(fingerprint(b))
  const c = buildModel({ now: NOW, label: 'y', ...sheetA() })
  expect(fingerprint(a) === fingerprint(c)).toBe(false)
})

test('fleet: dead pids and this session are skipped; self row found', () => {
  const rows = [
    { pid: 100, sessionId: 'me', cwd: '/x', tmux: 'work:@1.%1', status: 'busy' },
    { pid: 200, sessionId: 'w', cwd: '/w', tmux: 'rp:@3.%6', name: 'st-api', status: 'waiting', statusUpdatedAt: NOW - 5 },
    { pid: 300, sessionId: 'dead', cwd: '/d', tmux: 'rp:@9.%9', name: 'gone', status: 'waiting', statusUpdatedAt: 1 },
    { pid: 400, sessionId: 'b', cwd: '/b', tmux: 'rp:@4.%2', name: 'st-admin', status: 'busy', statusUpdatedAt: NOW - 9 },
  ]
  const fleet = buildFleet(rows, new Set([100, 200, 400]), 'me', new Map([['/w', 'ENG-1']]), new Map(), NOW)
  expect(fleet.self?.pid).toBe(100)
  expect(fleet.others.map(g => [g.tmuxSession, g.sessions.map(s => s.name)])).toEqual([['rp', ['st-api', 'st-admin']]])
  expect(fleet.others[0]!.sessions[0]!.windowLabel).toBe('@3 ENG-1')
  expect(pickFlare(fleet.others.flatMap(g => g.sessions))?.text).toBe('st-api is waiting for your input')
})

test('fleet: after /clear the session id changes but the pid does not: self is still found and never listed', () => {
  const rows = [
    { pid: 100, sessionId: 'after-clear', cwd: '/x', tmux: 'work:@1.%1', name: 'home-b9', status: 'busy' },
    { pid: 200, sessionId: 'w', cwd: '/w', tmux: 'rp:@3.%6', name: 'st-api', status: 'waiting', statusUpdatedAt: NOW - 5 },
  ]
  const fleet = buildFleet(rows, new Set([100, 200]), 'before-clear', new Map(), new Map(), NOW, 100)
  expect(fleet.self?.sessionId).toBe('after-clear')
  expect(fleet.others.flatMap(g => g.sessions.map(s => s.name))).toEqual(['st-api'])
})

test('fleet: a session is named by its AI title, else its first prompt, else the registry name; detail under it', () => {
  const row = parseRegistryRow(
    JSON.stringify({
      pid: 1,
      sessionId: 's1',
      cwd: '/Users/me/code/webapp-ui/.koh/ENG-1',
      tmux: 'm:@3.%7',
      name: 'webapp-ui-bb',
      status: 'busy',
    }),
  )!
  const pub = {
    sessionId: 's1',
    pid: 1,
    updatedAt: NOW,
    agentsRunning: 0,
    prSummary: { total: 0, broken: 0, waiting: 0, inProgress: 0 },
    doing: '3/7 · Rewriting PR claim rules',
  }
  const titled = toSessionVM(row, 'ENG-1', pub, NOW, { title: 'HQ background color' })
  expect(titled.name).toBe('HQ background color')
  expect(titled.detail).toBe('ENG-1 · 3/7 · Rewriting PR claim rules')
  expect(toSessionVM(row, 'main', undefined, NOW, { firstPrompt: 'Fix the ledger' })).toMatchObject({
    name: 'Fix the ledger',
    detail: 'ENG-1',
  })
  expect(toSessionVM(row, undefined, undefined, NOW).name).toBe('webapp-ui-bb')

  const grep = '"aiTitle":"Old title"\n"aiTitle":"HQ \\"background\\" color"\n'
  expect(parseTitle(grep)).toBe('HQ "background" color')
  expect(parseTitle('')).toBe(undefined)
  expect(
    parseFirstPrompt(JSON.stringify({ type: 'user', message: { content: '<command-name>x</command-name>\nPlan the wave\nmore' } })),
  ).toBe('Plan the wave')
  expect(parseFirstPrompt(JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'Ship ENG-1' }] } }))).toBe(
    'Ship ENG-1',
  )
  expect(transcriptPath('/Users/me', '/Users/me/code/x.y', 'sid')).toBe('/Users/me/.claude/projects/-Users-me-code-x-y/sid.jsonl')
})
