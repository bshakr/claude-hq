import { describe, expect, test } from 'claude-code/testing'

import { buildFleet, parseRegistryRow } from '../../hooks/data/fleet'
import type { SessionContext } from '../../hooks/data/fleet'
import type { OtherAgentVM, TermEnv, WaitVM } from '../../hooks/model/types'

const NOW = Date.parse('2026-10-08T22:00:00Z')

// A terminal front-end in tmux group bassemshaker driving bg worker 990b185e, a spare, a third session, and an unpaired bg session.
const FRONT = { pid: 29637, sessionId: '21e093a4-f5f3', cwd: '/Users/me', kind: 'interactive', tmux: 'bassemshaker:@0.%1', name: 'bassemshaker-6c', status: 'idle', statusUpdatedAt: NOW - 60_000, parkedJobId: '990b185e' }
const WORKER = { pid: 32938, sessionId: '990b185e-a2a7', cwd: '/Users/me', kind: 'bg', name: 'HQ background color', jobId: '990b185e', status: 'busy', statusUpdatedAt: NOW - 5_000 }
const SPARE = { pid: 33267, sessionId: '79a80429-9416', cwd: '/Users/me', kind: 'bg', name: '79a80429', jobId: '79a80429', spare: true, status: 'idle' }
const THIRD = { pid: 45327, sessionId: '1b6016a8-e12d', cwd: '/Users/me/code/monolense', kind: 'interactive', tmux: 'monolense:@3.%7', name: 'monolense-bb', status: 'busy' }
const LONE = { pid: 50001, sessionId: 'aaaa1111-0000', cwd: '/Users/me/code/x', kind: 'bg', name: 'aaaa1111', jobId: 'aaaa1111', status: 'busy' }
const rows = (...r: object[]) => r.map(x => parseRegistryRow(JSON.stringify(x))!)
const REGISTRY = rows(FRONT, WORKER, SPARE, THIRD, LONE)
const ALL = new Set([29637, 32938, 33267, 45327, 50001])
const GHOSTTY: TermEnv = { env: { __CFBundleIdentifier: 'com.mitchellh.ghostty' } }

const agent: OtherAgentVM = { id: 'a1', title: 'Pair bg and terminal rows', startedAt: NOW - 30_000 }
const topics = new Map([[WORKER.sessionId, { title: 'Polish HQ dashboard layout and animations' }]])
const agents = new Map([[WORKER.sessionId, [agent]]])
const contexts = new Map<string, SessionContext>([[WORKER.sessionId, { goal: 'HQ dashboard polish', step: 'pairing rows' }]])
const terms = new Map([[29637, GHOSTTY], [32938, GHOSTTY], [50001, GHOSTTY]])

const fleetFrom = (selfId: string, selfPid: number, alive = ALL, waits = new Map<string, WaitVM>(), reg = REGISTRY) =>
  buildFleet(reg, alive, selfId, new Map(), new Map(), NOW, selfPid, topics, agents, contexts, waits, terms)
const cards = (f: ReturnType<typeof buildFleet>) => f.others.flatMap(g => g.sessions)

describe('a front-end and its bg worker are one card for every viewer', () => {
  test('seen from a third session: one card in the front-end group, worker content, front-end jump', () => {
    const f = fleetFrom(THIRD.sessionId, THIRD.pid)
    const paired = f.others.find(g => g.tmuxSession === 'bassemshaker')!.sessions
    expect(paired.length).toBe(1)
    const c = paired[0]!
    expect(c.sessionId).toBe(WORKER.sessionId)
    expect(c.name).toBe('HQ dashboard polish')
    expect(c.step).toBe('pairing rows')
    expect(c.agents).toEqual([agent])
    expect(c.tmuxTarget).toBe('bassemshaker:@0.%1')
    expect(c.status).toBe('busy')
    expect(c.statusSince).toBe(NOW - 5_000)
    expect(c.jump).toEqual({ kind: 'session', sessionId: FRONT.sessionId, cwd: '/Users/me', pid: 29637, term: GHOSTTY, tmux: 'bassemshaker:@0.%1' })
    expect(cards(f).some(s => s.sessionId === FRONT.sessionId)).toBe(false)
  })

  test('the busier half leads: a waiting front-end makes the card waiting', () => {
    const f = fleetFrom(THIRD.sessionId, THIRD.pid, ALL, new Map(), rows({ ...FRONT, status: 'waiting', waitingFor: 'permission' }, WORKER, THIRD))
    const c = cards(f).find(s => s.tmuxTarget === FRONT.tmux)!
    expect(c.status).toBe('waiting')
    expect(c.waitingFor).toBe('permission')
    expect(c.name).toBe('HQ dashboard polish')
  })

  test('seen from either member: still self, nothing of the pair listed', () => {
    for (const [id, pid] of [[FRONT.sessionId, FRONT.pid], [WORKER.sessionId, WORKER.pid]] as const) {
      const ids = cards(fleetFrom(id, pid)).map(s => s.sessionId).sort()
      expect(ids).toEqual([THIRD.sessionId, LONE.sessionId].sort())
    }
  })

  test('an unpaired bg session keeps its own card, no tmux, its attach jump', () => {
    const c = cards(fleetFrom(THIRD.sessionId, THIRD.pid)).find(s => s.sessionId === LONE.sessionId)!
    expect(c.tmuxTarget).toBe(undefined)
    expect(c.jump).toEqual({ kind: 'session', sessionId: LONE.sessionId, cwd: '/Users/me/code/x', pid: 50001, term: GHOSTTY, bg: true, jobId: 'aaaa1111' })
    expect(fleetFrom(THIRD.sessionId, THIRD.pid).others.find(g => g.tmuxSession === '')!.sessions.map(s => s.sessionId)).toEqual([LONE.sessionId])
  })

  test('a stale pair: the live half stands alone as before', () => {
    const noFront = cards(fleetFrom(THIRD.sessionId, THIRD.pid, new Set([32938, 45327, 50001])))
    const w = noFront.find(s => s.sessionId === WORKER.sessionId)!
    expect(w.tmuxTarget).toBe(undefined)
    expect(w.jump).toEqual({ kind: 'session', sessionId: WORKER.sessionId, cwd: '/Users/me', pid: 32938, term: GHOSTTY, bg: true, jobId: '990b185e' })

    const noWorker = cards(fleetFrom(THIRD.sessionId, THIRD.pid, new Set([29637, 45327, 50001])))
    const fr = noWorker.find(s => s.sessionId === FRONT.sessionId)!
    expect(fr.tmuxTarget).toBe('bassemshaker:@0.%1')
    expect(fr.status).toBe('idle')
    expect(noWorker.some(s => s.sessionId === WORKER.sessionId)).toBe(false)
  })
})
