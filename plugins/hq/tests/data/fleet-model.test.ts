import { expect, test } from 'claude-code/testing'

import type { AgentVM, OtherSessionVM, PrVM } from '../../hooks/model/types'
import {
  buildFleet, groupByTmux, parseFirstPrompt, parsePsPids, parseRegistryRow, parseTitle, pickFlare, toSessionVM, transcriptPath,
} from '../../hooks/data/fleet'
import { buildModel, countsOf, fingerprint, statusTextOf } from '../../hooks/data/model'

const NOW = 10_000_000

function session(name: string, tmux: string, status: OtherSessionVM['status'], since: number, extra: Partial<OtherSessionVM> = {}): OtherSessionVM {
  return { sessionId: name, name, tmuxTarget: tmux, windowLabel: '', status, statusSince: since, jump: { kind: 'tmux', target: tmux }, ...extra }
}

test('fleet: registry row → session VM; shell reads as idle; stale publish ignored', () => {
  const row = parseRegistryRow(JSON.stringify({
    pid: 45327, sessionId: 's1', cwd: '/Users/me/code/monolense', tmux: 'monolense:@3.%7', name: 'monolense-bb',
    status: 'shell', statusUpdatedAt: NOW - 60_000,
  }))!
  const pub = { sessionId: 's1', pid: 45327, updatedAt: NOW - 5_000, agentsRunning: 2, prSummary: { total: 1, broken: 0, waiting: 1, inProgress: 0 } }
  expect(toSessionVM(row, 'BLO-1940-promote', pub, NOW)).toEqual({
    sessionId: 's1', name: 'monolense-bb', windowLabel: '@3 BLO-1940-promote', status: 'idle',
    tmuxTarget: 'monolense:@3.%7', jump: { kind: 'tmux', target: 'monolense:@3.%7' }, statusSince: NOW - 60_000,
    agentsRunning: 2, prSummary: pub.prSummary, detail: 'monolense · BLO-1940-promote',
  })
  expect(toSessionVM(row, undefined, { ...pub, updatedAt: NOW - 31_000 }, NOW).agentsRunning).toBe(undefined)
  expect(parseRegistryRow('{not json')).toBe(undefined)
  expect(parsePsPids('  38348\n45327\n')).toEqual(new Set([38348, 45327]))
})

test('fleet: grouped by tmux session, waiting groups first, longest wait first', () => {
  const groups = groupByTmux([
    session('home', 'bassemshaker:@0.%1', 'idle', NOW - 300_000),
    session('rp-admin', 'ritualpass:@4.%2', 'busy', NOW - 360_000),
    session('rp-mobile', 'ritualpass:@5.%3', 'waiting', NOW - 60_000),
    session('rp-api', 'ritualpass:@3.%6', 'waiting', NOW - 120_000),
    session('rota', 'rotamonster:@6.%9', 'idle', NOW - 10_000),
  ])
  expect(groups.map(g => g.tmuxSession)).toEqual(['ritualpass', 'rotamonster', 'bassemshaker'])
  expect(groups[0]!.sessions.map(s => s.name)).toEqual(['rp-api', 'rp-mobile', 'rp-admin'])
})

test('fleet: flare picks the longest-waiting other session', () => {
  const flare = pickFlare([
    session('rp-mobile', 'ritualpass:@5.%3', 'waiting', NOW - 60_000),
    session('rp-api', 'ritualpass:@3.%6', 'waiting', NOW - 120_000),
    session('idle', 'x:@1.%1', 'idle', NOW - 999_999),
  ])
  expect(flare).toEqual({
    text: 'rp-api is waiting for your input', sinceMs: NOW - 120_000, tmuxTarget: 'ritualpass:@3.%6',
    jump: { kind: 'tmux', target: 'ritualpass:@3.%6' },
  })
})

// The design sheet's render (a): 3 waiting on you, 2 broken, 3 in progress, 10 sessions.
function sheetA() {
  const agent = (id: string, status: AgentVM['status']): AgentVM => ({ id, title: id, status, background: true, startedAt: 0, toolCount: 0, files: [] })
  const pr = (number: number, p: Partial<PrVM>): PrVM => ({
    repo: 'acme/app', number, title: '', url: '', ci: { kind: 'passed', total: 7 }, merge: 'mergeable', gallery: 'none',
    watcher: 'ci-wait', claimedBy: 'main', ...p,
  })
  const agents = [agent('a1', 'failed'), agent('a2', 'waiting'), agent('a3', 'running'), agent('a4', 'completed'), agent('a5', 'completed')]
  const prs = [
    pr(212, { ci: { kind: 'failed', done: 9, total: 9, failed: 1, firstFailing: 'rspec' } }),
    pr(214, { ci: { kind: 'running', done: 5, total: 9, failed: 0 } }),
    pr(431, { repo: 'ritualpass/admin-web', merge: 'behind', watcher: 'merge-wait' }),
    pr(433, { repo: 'ritualpass/admin-web', watcher: 'merge-wait' }),
    pr(429, { repo: 'ritualpass/admin-web', merge: 'merged', watcher: 'none', mergedAt: NOW - 240_000 }),
    pr(522, { repo: 'ritualpass/api', watcher: 'none' }),
  ]
  const others = groupByTmux([
    session('rp-api', 'ritualpass:@3.%6', 'waiting', NOW - 120_000, { agentsRunning: 1, prSummary: { total: 1, broken: 0, waiting: 1, inProgress: 0 } }),
    session('rp-admin', 'ritualpass:@4.%2', 'busy', NOW - 360_000, { agentsRunning: 4, prSummary: { total: 2, broken: 0, waiting: 1, inProgress: 0 } }),
    ...['rp-docs', 'home', 'monolense-research', 'travel', 'rota', 'rota-research', 'finance'].map((n, i) =>
      session(n, `t${i}:@${i}.%${i}`, 'idle', NOW - 1_000_000)),
  ])
  return { agents, prs, others }
}

test('model: counts reproduce the sheet (3 waiting, 2 broken, 3 in progress, 10 sessions)', () => {
  expect(countsOf(sheetA())).toEqual({ waiting: 3, broken: 2, inProgress: 3, sessions: 10 })
})

test('model: status line names the one waiting session, counts otherwise, empty when quiet', () => {
  const m = buildModel({ now: NOW, label: 'monolense:@1 · BLO-1940-promote', ...sheetA() })
  expect(m.statusText).toBe('hq: rp-api waiting 2m · 2 broken · 3 in progress · PRs 3 green · 1 running · 1 red · 1 rebase · 1 merged')
  expect(m.flare?.text).toBe('rp-api is waiting for your input')
  expect(m.current.prs.map(p => p.number)).toEqual([212, 214, 431, 433, 429, 522])
  const two = [session('a', 'x:@1.%1', 'waiting', NOW - 1), session('b', 'x:@2.%2', 'waiting', NOW - 2)]
  expect(statusTextOf({ waiting: 2, broken: 0, inProgress: 4, sessions: 3 }, two, NOW)).toBe('hq: 2 waiting · 4 in progress')
  expect(statusTextOf({ waiting: 0, broken: 0, inProgress: 0, sessions: 1 }, [], NOW)).toBe('')
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
    { pid: 200, sessionId: 'w', cwd: '/w', tmux: 'rp:@3.%6', name: 'rp-api', status: 'waiting', statusUpdatedAt: NOW - 5 },
    { pid: 300, sessionId: 'dead', cwd: '/d', tmux: 'rp:@9.%9', name: 'gone', status: 'waiting', statusUpdatedAt: 1 },
    { pid: 400, sessionId: 'b', cwd: '/b', tmux: 'rp:@4.%2', name: 'rp-admin', status: 'busy', statusUpdatedAt: NOW - 9 },
  ]
  const fleet = buildFleet(rows, new Set([100, 200, 400]), 'me', new Map([['/w', 'BLO-1']]), new Map(), NOW)
  expect(fleet.self?.pid).toBe(100)
  expect(fleet.others.map(g => [g.tmuxSession, g.sessions.map(s => s.name)])).toEqual([['rp', ['rp-api', 'rp-admin']]])
  expect(fleet.others[0]!.sessions[0]!.windowLabel).toBe('@3 BLO-1')
  expect(pickFlare(fleet.others.flatMap(g => g.sessions))?.text).toBe('rp-api is waiting for your input')
})

test('fleet: after /clear the session id changes but the pid does not: self is still found and never listed', () => {
  const rows = [
    { pid: 100, sessionId: 'after-clear', cwd: '/x', tmux: 'work:@1.%1', name: 'home-b9', status: 'busy' },
    { pid: 200, sessionId: 'w', cwd: '/w', tmux: 'rp:@3.%6', name: 'rp-api', status: 'waiting', statusUpdatedAt: NOW - 5 },
  ]
  const fleet = buildFleet(rows, new Set([100, 200]), 'before-clear', new Map(), new Map(), NOW, 100)
  expect(fleet.self?.sessionId).toBe('after-clear')
  expect(fleet.others.flatMap(g => g.sessions.map(s => s.name))).toEqual(['rp-api'])
})

test('fleet: a session is named by its AI title, else its first prompt, else the registry name; detail under it', () => {
  const row = parseRegistryRow(JSON.stringify({
    pid: 1, sessionId: 's1', cwd: '/Users/me/code/monolense/.koh/BLO-1', tmux: 'm:@3.%7', name: 'monolense-bb', status: 'busy',
  }))!
  const pub = { sessionId: 's1', pid: 1, updatedAt: NOW, agentsRunning: 0, prSummary: { total: 0, broken: 0, waiting: 0, inProgress: 0 }, doing: '3/7 · Rewriting PR claim rules' }
  const titled = toSessionVM(row, 'BLO-1', pub, NOW, { title: 'HQ background color' })
  expect(titled.name).toBe('HQ background color')
  expect(titled.detail).toBe('BLO-1 · 3/7 · Rewriting PR claim rules')
  expect(toSessionVM(row, 'main', undefined, NOW, { firstPrompt: 'Fix the ledger' })).toMatchObject({ name: 'Fix the ledger', detail: 'BLO-1' })
  expect(toSessionVM(row, undefined, undefined, NOW).name).toBe('monolense-bb')

  const grep = '"aiTitle":"Old title"\n"aiTitle":"HQ \\"background\\" color"\n'
  expect(parseTitle(grep)).toBe('HQ "background" color')
  expect(parseTitle('')).toBe(undefined)
  expect(parseFirstPrompt(JSON.stringify({ type: 'user', message: { content: '<command-name>x</command-name>\nPlan the wave\nmore' } }))).toBe('Plan the wave')
  expect(parseFirstPrompt(JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'Ship BLO-1' }] } }))).toBe('Ship BLO-1')
  expect(transcriptPath('/Users/me', '/Users/me/code/x.y', 'sid')).toBe('/Users/me/.claude/projects/-Users-me-code-x-y/sid.jsonl')
})
