import { describe, expect, test } from 'claude-code/testing'

import {
  BUSY_REFRESH_MS,
  FAIL_BACKOFF_MS,
  GOAL_INPUT_MAX,
  dayOf,
  emptyDigest,
  goalDue,
  goalInput,
  goalText,
  ingest,
  ingestLines,
  jumpTitlesOf,
  parseGoalReply,
  parsePrStates,
  prKey,
  prStateQuery,
  prText,
  prsToLook,
  refreshGoal,
  todoProgress,
  utf8Bytes,
} from '../../hooks/data/context'
import type { Complete, Digest, GoalCache, PrState } from '../../hooks/data/context'
import { buildFleet, parseRegistryRow, selfTmux, toSessionVM } from '../../hooks/data/fleet'
import type { HqModel, OtherSessionVM } from '../../hooks/model/types'
import { layout } from '../../hooks/ui/layout'

const NOW = Date.parse('2026-10-08T20:00:00Z')
const MIN = 60_000

// The registry as it stood on 2026-10-08: a terminal front-end, the bg session it parked, a spare, and webapp-ui.
const REGISTRY = [
  {
    pid: 29637,
    sessionId: '21e093a4-f5f3',
    cwd: '/Users/me',
    kind: 'interactive',
    tmux: 'devbox-local:@0.%1',
    name: 'devbox-local-6c',
    status: 'idle',
    parkedJobId: '990b185e',
  },
  { pid: 32938, sessionId: '990b185e-a2a7', cwd: '/Users/me', kind: 'bg', name: 'HQ background color', jobId: '990b185e', status: 'busy' },
  {
    pid: 33267,
    sessionId: '79a80429-9416',
    cwd: '/Users/me',
    kind: 'bg',
    name: '79a80429',
    jobId: '79a80429',
    spare: true,
    status: 'idle',
  },
  {
    pid: 45327,
    sessionId: '1b6016a8-e12d',
    cwd: '/Users/me/code/webapp-ui',
    kind: 'interactive',
    tmux: 'webapp-ui:@3.%7',
    name: 'webapp-ui-bb',
    status: 'busy',
  },
].map(r => parseRegistryRow(JSON.stringify(r))!)
const ALIVE = new Set([29637, 32938, 33267, 45327])
const names = (f: ReturnType<typeof buildFleet>) => f.others.flatMap(g => g.sessions.map(s => s.sessionId))

describe('self pairing and spares', () => {
  test('HQ in the bg session: its parked front-end is self, the spare is hidden', () => {
    const f = buildFleet(REGISTRY, ALIVE, '990b185e-a2a7', new Map(), new Map(), NOW, 32938)
    expect(f.self?.pid).toBe(32938)
    expect(names(f)).toEqual(['1b6016a8-e12d'])
    expect(selfTmux(REGISTRY, f.self)).toBe('devbox-local:@0.%1')
  })

  test('HQ in the front-end: its bg session is self too', () => {
    const f = buildFleet(REGISTRY, ALIVE, '21e093a4-f5f3', new Map(), new Map(), NOW, 29637)
    expect(names(f)).toEqual(['1b6016a8-e12d'])
  })

  test('another pair stays listed; a genuine bg session without tmux is named by title, never by id', () => {
    const other = [
      ...REGISTRY,
      parseRegistryRow(
        JSON.stringify({
          pid: 50001,
          sessionId: 'aaaa1111-0000',
          cwd: '/Users/me/code/x',
          kind: 'bg',
          name: 'aaaa1111',
          jobId: 'aaaa1111',
          status: 'busy',
        }),
      )!,
    ]
    const f = buildFleet(
      other,
      new Set([...ALIVE, 50001]),
      '990b185e-a2a7',
      new Map(),
      new Map(),
      NOW,
      32938,
      new Map([['aaaa1111-0000', { title: 'Port the importer' }]]),
    )
    const s = f.others.flatMap(g => g.sessions).find(x => x.sessionId === 'aaaa1111-0000')!
    expect(s.name).toBe('Port the importer')
    const bare = toSessionVM(other[other.length - 1]!, undefined, undefined, NOW)
    expect(bare.name).toBe('x')
  })
})

// ---------- transcript fixtures ----------

const line = (v: Record<string, unknown>) => `${JSON.stringify(v)}\n`
const at = (min: number) => new Date(NOW - 3 * 86_400_000 + min * MIN).toISOString()
const prompt = (text: string, min: number) =>
  line({ type: 'user', message: { role: 'user', content: text }, timestamp: at(min), gitBranch: 'main' })
const reply = (text: string, min: number) =>
  line({
    type: 'assistant',
    message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] },
    timestamp: at(min),
  })
const title = (t: string) => line({ type: 'ai-title', aiTitle: t })
const prLink = (n: number, min: number) =>
  line({
    type: 'pr-link',
    prNumber: n,
    prUrl: `https://github.com/acmeco/webapp-ui/pull/${n}`,
    prRepository: 'acmeco/webapp-ui',
    timestamp: at(min),
  })

function neverCompacted(): Digest {
  const d = emptyDigest()
  ingest(
    d,
    [
      line({ type: 'user', isMeta: true, message: { content: 'Stop hook feedback: CI pending' }, timestamp: at(0) }),
      prompt('Rebuild the classification pipeline as v2 with a kind stage', 1),
      title('Pipeline v2 kickoff'),
      line({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
        timestamp: at(2),
        gitBranch: 'ENG-1941-kind-stage',
      }),
      line({
        type: 'user',
        origin: { kind: 'task-notification' },
        message: { content: '<task-notification>done</task-notification>' },
        timestamp: at(3),
      }),
      reply('Opened the foundation PR.', 4),
      line({
        type: 'attachment',
        attachment: { type: 'queued_command', prompt: 'ok merged', origin: { kind: 'human' } },
        timestamp: at(4),
      }),
      line({
        type: 'attachment',
        attachment: { type: 'queued_command', prompt: '<agent-message>report</agent-message>', origin: { kind: 'agent' } },
        timestamp: at(4),
      }),
      prLink(270, 5),
      prLink(270, 6),
      prLink(271, 7),
      title('269 merged whats next'),
    ].join(''),
  )
  return d
}

describe('transcript digest', () => {
  test('jump titles: the newest /rename title leads, the newest AI title follows; the card keeps the newest of either', () => {
    const d = emptyDigest()
    ingest(d, title('First AI') + line({ type: 'custom-title', customTitle: 'Renamed' }) + title('Second AI'))
    expect(jumpTitlesOf(d)).toEqual(['Renamed', 'Second AI'])
    expect(goalText(undefined, d)).toBe('Second AI')
    const ai = emptyDigest()
    ingest(ai, title('Only AI'))
    expect(jumpTitlesOf(ai)).toEqual(['Only AI'])
    expect(jumpTitlesOf(emptyDigest())).toEqual([])
  })

  test('a never-compacted session: first prompt, distinct titles, PRs deduped, meta and notifications skipped', () => {
    const d = neverCompacted()
    expect(d.firstPrompt).toBe('Rebuild the classification pipeline as v2 with a kind stage')
    expect(d.prompts.map(p => p.text)).toEqual(['Rebuild the classification pipeline as v2 with a kind stage', 'ok merged'])
    expect(d.titles).toEqual(['Pipeline v2 kickoff', '269 merged whats next'])
    expect(d.prs.map(p => p.number)).toEqual([270, 271])
    expect(d.branches).toEqual(['ENG-1941-kind-stage'])
    expect(d.replies).toEqual(['Opened the foundation PR.'])
    expect(d.compact).toBe(undefined)
    expect(dayOf(d.firstTs, NOW)).toBe(4)
  })

  test('incremental: a partial line waits for its end; offset counts bytes, not characters', () => {
    const d = emptyDigest()
    const a = prompt('café ✓ first', 1)
    ingest(d, a.slice(0, 20))
    expect(d.offset).toBe(0)
    ingest(d, a.slice(20))
    expect(d.offset).toBe(utf8Bytes(a))
    expect(utf8Bytes(a)).toBeGreaterThan(a.length)
    expect(d.firstPrompt).toBe('café ✓ first')
  })

  test('the compaction summary keeps its Primary Request and Intent part', () => {
    const d = neverCompacted()
    ingest(
      d,
      line({
        type: 'user',
        isCompactSummary: true,
        timestamp: at(50),
        message: {
          content:
            'This session is being continued.\n\nSummary:\n1. Primary Request and Intent:\n   Finish epic ENG-4810: v2 pipeline.\n\n2. Key Technical Concepts:\n   - rails',
        },
      }),
    )
    expect(d.compact?.text).toBe('Finish epic ENG-4810: v2 pipeline.')
    expect(d.prompts.length).toBe(2)
  })

  test('sparse scan lines (head, grep, tail) parse without consuming bytes; a cut first line is dropped', () => {
    const d = emptyDigest()
    ingestLines(d, `{"type":"ai-t${title('Half').slice(14)}${title('Whole')}`, true)
    expect(d.titles).toEqual(['Whole'])
    expect(d.offset).toBe(0)
  })
})

describe('todos from the transcript', () => {
  test('TaskCreate takes its id from the result; TaskUpdate moves it; progress names the active item', () => {
    const d = emptyDigest()
    const use = (id: string, name: string, input: Record<string, unknown>) =>
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })
    const result = (id: string, task: Record<string, unknown>) =>
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, toolUseResult: { task } })
    ingest(
      d,
      [
        use('u1', 'TaskCreate', { subject: 'Implement ENG-4821 webhook retry', description: '' }),
        result('u1', { id: '1', subject: 'Implement ENG-4821 webhook retry' }),
        use('u2', 'TaskCreate', { subject: 'Write the ADR', description: '' }),
        result('u2', { id: '2' }),
        use('u3', 'TaskUpdate', { taskId: '1', status: 'in_progress', activeForm: 'Implementing ENG-4821 webhook retry' }),
        use('u4', 'TaskUpdate', { taskId: '2', status: 'completed' }),
      ].join(''),
    )
    expect(todoProgress(d.tasks)).toEqual({ done: 1, total: 2, active: 'Implementing ENG-4821 webhook retry' })
  })

  test('TodoWrite replaces the list; no list, no line', () => {
    const d = emptyDigest()
    expect(todoProgress(d.tasks)).toBe(undefined)
    ingest(
      d,
      line({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'x',
              name: 'TodoWrite',
              input: {
                todos: [
                  { content: 'a', status: 'completed', activeForm: 'A' },
                  { content: 'b', status: 'in_progress', activeForm: 'Doing b' },
                  { content: 'c', status: 'pending', activeForm: 'C' },
                ],
              },
            },
          ],
        },
      }),
    )
    expect(todoProgress(d.tasks)).toEqual({ done: 1, total: 3, active: 'Doing b' })
  })
})

describe('pr-link counting', () => {
  test('deduped by URL; merged first; unknown ones counted as linked', () => {
    const d = neverCompacted()
    expect(prText(d.prs, new Map())).toBe('2 PRs linked')
    const states = new Map<string, PrState>([[prKey('acmeco/webapp-ui', 270), 'MERGED']])
    expect(prText(d.prs, states)).toBe('1 PR merged, 1 more linked')
    states.set(prKey('acmeco/webapp-ui', 271), 'OPEN')
    // Open PRs are the card's own rows, not a count.
    expect(prText(d.prs, states)).toBe('1 PR merged')
    states.set(prKey('acmeco/webapp-ui', 270), 'OPEN')
    expect(prText(d.prs, states)).toBe(undefined)
    expect(prText([], states)).toBe(undefined)
  })

  test('at most 20 looked up, newest first; one GraphQL query per repo', () => {
    const prs = Array.from({ length: 30 }, (_, i) => ({ url: `u${i}`, repo: 'a/b', number: i, ts: i }))
    expect(prsToLook({ prs }).map(p => p.number)).toEqual(Array.from({ length: 20 }, (_, i) => 29 - i))
    expect(prStateQuery('a/b', [1, 2])).toBe(
      'query { repository(owner: "a", name: "b") { p1: pullRequest(number: 1) { state title headRefName } p2: pullRequest(number: 2) { state title headRefName } } }',
    )
    expect(prStateQuery('a/b"x', [1])).toBe(undefined)
    expect([...parsePrStates('{"data":{"repository":{"p1":{"state":"MERGED","title":"T","headRefName":"ENG-1-x"},"p2":null}}}')]).toEqual([
      [1, { state: 'MERGED', title: 'T', branch: 'ENG-1-x' }],
    ])
  })
})

describe('goal summary', () => {
  const answering = (text: string) => {
    const calls: string[] = []
    const fn: Complete = async req => {
      calls.push(req.prompt)
      return { isAnswered: true, text }
    }
    return { fn, calls }
  }
  const OK = '```json\n{"goal": "Pipeline v2 rearchitecture for the classifier", "step": "stage 4 of 7: kind stage"}\n```'

  test('never compacted: the input carries the first request, title history, PRs, tickets, prompts and replies', () => {
    const d = neverCompacted()
    const input = goalInput(d, { prTitles: ['ENG-1940 evaluation report'] })
    const order = [
      '## First request',
      '## Title history',
      'Pipeline v2 kickoff → 269 merged whats next',
      '## Pull requests',
      'tickets: ENG-1940, ENG-1941',
      '## Recent requests',
      '## Latest replies',
    ]
    let last = -1
    for (const part of order) {
      const i = input.indexOf(part)
      expect(i).toBeGreaterThan(last)
      last = i
    }
    expect(input.includes('Compaction')).toBe(false)
  })

  test('bounded: never more than 6k characters, the compaction first', () => {
    const d = neverCompacted()
    d.compact = { text: 'x'.repeat(10_000), ts: 1 }
    d.firstPrompt = 'y'.repeat(10_000)
    for (let i = 0; i < 10; i++) d.prompts.push({ text: 'z'.repeat(200), ts: i })
    const input = goalInput(d)
    expect(input.length).toBeLessThanOrEqual(GOAL_INPUT_MAX)
    expect(input.startsWith('## Latest compaction summary')).toBe(true)
  })

  test('reply parsing: fenced JSON, word caps, junk rejected', () => {
    expect(parseGoalReply(OK)).toEqual({ goal: 'Pipeline v2 rearchitecture for the classifier', step: 'stage 4 of 7: kind stage' })
    expect(parseGoalReply('{"goal":"one two three four five six seven"}')).toEqual({ goal: 'one two three four five six' })
    expect(parseGoalReply('no json')).toBe(undefined)
    expect(parseGoalReply('{"step":"x"}')).toBe(undefined)
  })

  test('refresh rules: first sight, 5 new prompts, a new compaction, 30 min busy with new content; never idle', async () => {
    const d = neverCompacted()
    const { fn, calls } = answering(OK)
    expect(goalDue(undefined, emptyDigest(), true, NOW)).toBe(false)
    expect(goalDue(undefined, d, false, NOW)).toBe(true)
    let c: GoalCache = await refreshGoal(d, undefined, {}, NOW, fn)
    expect(calls.length).toBe(1)
    expect(c.goal).toBe('Pipeline v2 rearchitecture for the classifier')

    // idle, nothing new, hours later: not due
    expect(goalDue(c, d, false, NOW + 5 * 60 * MIN)).toBe(false)
    // four new prompts: not yet; the fifth: due
    const promptAt = (i: number) => ({ text: `p${i}`, ts: NOW + i * MIN })
    for (let i = 1; i <= 4; i++) d.prompts.push(promptAt(i))
    expect(goalDue(c, d, false, NOW + 10 * MIN)).toBe(false)
    d.prompts.push(promptAt(5))
    expect(goalDue(c, d, false, NOW + 10 * MIN)).toBe(true)
    c = await refreshGoal(d, c, {}, NOW + 10 * MIN, fn)
    expect(goalDue(c, d, false, NOW + 11 * MIN)).toBe(false)

    // busy: due after 30 min only when the transcript moved since
    d.lastTs = NOW + 5 * MIN
    expect(goalDue(c, d, true, NOW + 10 * MIN + BUSY_REFRESH_MS)).toBe(false)
    d.lastTs = NOW + 20 * MIN
    expect(goalDue(c, d, true, NOW + 10 * MIN + BUSY_REFRESH_MS - 1)).toBe(false)
    expect(goalDue(c, d, true, NOW + 10 * MIN + BUSY_REFRESH_MS)).toBe(true)
    expect(goalDue(c, d, false, NOW + 10 * MIN + BUSY_REFRESH_MS)).toBe(false)

    // a compaction newer than the summary: due at once
    d.compact = { text: 'Finish epic', ts: NOW + 12 * MIN }
    expect(goalDue(c, d, false, NOW + 12 * MIN)).toBe(true)
  })

  test('a failure keeps the old goal and backs off; nothing cached falls back to the AI title', async () => {
    const d = neverCompacted()
    const failing: Complete = async () => ({ isAnswered: false })
    const none = await refreshGoal(d, undefined, {}, NOW, failing)
    expect(none.goal).toBe(undefined)
    expect(goalText(none, d)).toBe('269 merged whats next')
    expect(goalDue(none, d, true, NOW + FAIL_BACKOFF_MS - 1)).toBe(false)
    expect(goalDue(none, d, true, NOW + FAIL_BACKOFF_MS)).toBe(true)
    // idle with nothing new since the failure: no retry
    expect(goalDue(none, d, false, NOW + FAIL_BACKOFF_MS)).toBe(false)
    d.lastTs = NOW + MIN
    expect(goalDue(none, d, false, NOW + FAIL_BACKOFF_MS)).toBe(true)

    const kept = await refreshGoal(d, { goal: 'Old goal', at: 1 }, {}, NOW, async () => {
      throw new Error('down')
    })
    expect(kept.goal).toBe('Old goal')
    expect(kept.failedAt).toBe(NOW)
    expect(goalText(undefined, emptyDigest())).toBe(undefined)
  })
})

describe('the card', () => {
  test('goal, day and status; step and PR counts; todos; then agents', () => {
    const s: OtherSessionVM = {
      sessionId: 'm',
      name: 'Pipeline v2 rearchitecture',
      windowLabel: '',
      status: 'busy',
      statusSince: NOW - MIN,
      tmuxTarget: 'webapp-ui:@3.%7',
      jump: { kind: 'tmux', target: 'webapp-ui:@3.%7' },
      detail: 'webapp-ui',
      day: 3,
      step: 'stage 4 of 7: kind stage',
      prText: '12 PRs merged',
      todos: { done: 5, total: 9, active: 'Implement ENG-4821 webhook retry' },
      agents: [
        {
          id: 'a',
          title: 'Implement ENG-4821 webhook retry',
          model: 'opus',
          startedAt: NOW - 26_000,
          doing: 'Read rake spec patterns and report leaky spec',
        },
      ],
    }
    const m: HqModel = {
      now: NOW,
      counts: { waiting: 0, broken: 0, inProgress: 0, sessions: 1 },
      current: { label: '', goal: { text: 'HQ broader context', day: 1 }, agents: [], prs: [] },
      others: [{ tmuxSession: 'webapp-ui', sessions: [s] }],
      statusText: '',
    }
    const rows = layout(m, { width: 58, rows: 40, focused: false, cursor: null, expanded: [], scroll: 0, phase: 0 }).rows.map(r => r.text())
    const top = rows.findIndex(l => l.includes('╭─ webapp-ui'))
    expect(rows.slice(top, top + 9)).toEqual([
      ' ╭─ webapp-ui ──────────────────────────────────────────╮',
      ' │  Pipeline v2 rearchitecture       day 3 · ✻ busy 1m  │',
      ' │  stage 4 of 7: kind stage · 12 PRs merged            │',
      ' │  todos 5/9 ● Implement ENG-4821 webhook retry        │',
      ' │                                                      │',
      ' ├─ agents ─────────────────────────────────────────────┤',
      ' │  ✢ Implement ENG-4821 webhook retry      opus · 26s  │',
      ' │    Read rake spec patterns and report leaky spec     │',
      ' ╰──────────────────────────────────────────────────────╯',
    ])
    expect(rows.some(l => l.includes('HQ broader context') && l.includes('day 1'))).toBe(true)
  })
})
