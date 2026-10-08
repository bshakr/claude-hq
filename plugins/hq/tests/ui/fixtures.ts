// The sheet's fixture (round2/sheet-unified-r3.md), as HqModels.
import type { AgentVM, HqModel, OtherSessionVM, PrVM, TmuxGroupVM } from '../../hooks/model/types'

export const NOW = 10_000_000_000
const S = 1000
const M = 60 * S
const H = 60 * M

const agent = (a: Partial<AgentVM> & Pick<AgentVM, 'id' | 'title' | 'status'>): AgentVM => ({
  background: true,
  startedAt: NOW - 5 * M,
  toolCount: 0,
  files: [],
  ...a,
})

export const AGENTS: AgentVM[] = [
  agent({
    id: 'a3',
    title: 'Adversarial review: refunds PR',
    status: 'completed',
    model: 'opus',
    startedAt: NOW - 3 * M - 580 * S,
    endedAt: NOW - 3 * M,
    toolCount: 41,
    outcome: '3 findings: 1 HIGH (refund rounding drops a cent on partial refunds), 2 LOW',
  }),
  agent({
    id: 'a4',
    parentId: 'a3',
    title: 'Find refund callers',
    status: 'completed',
    model: 'haiku',
    startedAt: NOW - 8 * M,
    endedAt: NOW - 5 * M,
    outcome: '4 callers, all in app/ledger',
  }),
  agent({
    id: 'a1',
    title: 'Implement ledger refund reconcile',
    status: 'waiting',
    model: 'claude-opus-5-5',
    startedAt: NOW - 14 * M - 20 * S,
    toolCount: 87,
    worktree: '.koh/ledger-refund-reconcile',
    files: ['app/ledger/reconcile.rb', 'app/ledger/refund.rb', 'spec/ledger/reconcile_spec.rb'],
  }),
  agent({
    id: 'a2',
    parentId: 'a1',
    title: 'Run ledger specs and report',
    status: 'running',
    model: 'sonnet',
    background: false,
    startedAt: NOW - 2 * M - 10 * S,
    toolCount: 12,
    now: 'Bash: bin/rspec spec/ledger --fail-fast',
    worktree: '.koh/ledger-refund-reconcile',
    files: ['spec/ledger/'],
  }),
  agent({
    id: 'a5',
    title: 'Capture screenshot pairs',
    status: 'failed',
    model: 'sonnet',
    startedAt: NOW - 7 * M - 30 * S,
    endedAt: NOW - 1 * M,
    toolCount: 23,
    now: 'port 3000 already in use',
    worktree: '~/code/webapp-ui',
  }),
]

const pr = (p: Partial<PrVM> & Pick<PrVM, 'repo' | 'number' | 'title'>): PrVM => ({
  url: `https://github.com/${p.repo}/pull/${p.number}`,
  ci: { kind: 'passed', total: 7 },
  merge: 'mergeable',
  gallery: 'none',
  watcher: 'ci-wait',
  claimedBy: 'main',
  ...p,
})

const MONO = 'acmeco/webapp-ui'
const ADMIN = 'acme-store/admin-web'
const API = 'acme-store/api'

export const PRS: PrVM[] = [
  pr({
    repo: ADMIN,
    number: 429,
    title: 'Sidebar: collapse state persists',
    merge: 'merged',
    mergedAt: NOW - 4 * M,
    gallery: 'linked',
    watcher: 'merge-wait',
  }),
  pr({
    repo: MONO,
    number: 212,
    title: 'Ledger: reconcile partial refunds',
    ci: { kind: 'failed', done: 9, total: 9, failed: 1, firstFailing: 'rspec' },
  }),
  pr({
    repo: MONO,
    number: 214,
    title: 'Pipeline: retry classification on timeout',
    ci: { kind: 'running', done: 5, total: 9, failed: 0 },
  }),
  pr({ repo: ADMIN, number: 433, title: 'Stat cards: one-decimal trend deltas', gallery: 'linked', watcher: 'merge-wait' }),
  pr({
    repo: ADMIN,
    number: 431,
    title: 'Members table: sticky header on scroll',
    merge: 'behind',
    gallery: 'linked',
    watcher: 'merge-wait',
  }),
  pr({
    repo: API,
    number: 522,
    title: 'Bookings: idempotent webhook replay',
    ci: { kind: 'passed', total: 6 },
    gallery: 'no-visual-change',
    watcher: 'none',
  }),
]

const sess = (s: Partial<OtherSessionVM> & Pick<OtherSessionVM, 'sessionId' | 'name'>, tmux: string, win = '@1'): OtherSessionVM => ({
  windowLabel: `${win} ${s.name}`,
  status: 'idle',
  tmuxTarget: `${tmux}:${win}.%${s.sessionId.length + 3}`,
  jump: { kind: 'tmux', target: `${tmux}:${win}.%${s.sessionId.length + 3}` },
  ...s,
})

const group = (tmuxSession: string, sessions: OtherSessionVM[]): TmuxGroupVM => ({ tmuxSession, sessions })

export const OTHERS_BUSY: TmuxGroupVM[] = [
  group('acme-store', [
    sess(
      {
        sessionId: 's-st-api',
        name: 'st-api',
        status: 'waiting',
        statusSince: NOW - 2 * M,
        waitingFor: 'input needed',
        agentsRunning: 1,
        prSummary: { total: 1, broken: 0, waiting: 1, inProgress: 0 },
      },
      'acme-store',
      '@3',
    ),
    sess(
      {
        sessionId: 's-st-admin',
        name: 'st-admin',
        status: 'busy',
        statusSince: NOW - 6 * M,
        agentsRunning: 4,
        prSummary: { total: 2, broken: 0, waiting: 1, inProgress: 0 },
      },
      'acme-store',
      '@4',
    ),
    sess({ sessionId: 's-st-docs', name: 'st-docs', statusSince: NOW - 1 * H }, 'acme-store', '@5'),
  ]),
  group('devbox-local', [sess({ sessionId: 's-home', name: 'home', statusSince: NOW - 5 * M }, 'devbox-local')]),
  group('webapp-ui', [sess({ sessionId: 's-mono-r', name: 'webapp-ui-research', statusSince: NOW - 22 * M }, 'webapp-ui', '@2')]),
  group('travel-map', [
    sess(
      { sessionId: 's-travel', name: 'travel', statusSince: NOW - 40 * M, prSummary: { total: 1, broken: 0, waiting: 0, inProgress: 0 } },
      'travel-map',
    ),
  ]),
  group('rota-roster', [
    sess({ sessionId: 's-rota', name: 'rota', statusSince: NOW - 3 * H }, 'rota-roster'),
    sess({ sessionId: 's-rota-r', name: 'rota-research', statusSince: NOW - 3 * H }, 'rota-roster', '@2'),
  ]),
  group('finance', [sess({ sessionId: 's-fin', name: 'finance', statusSince: NOW - 49 * H }, 'finance')]),
]

const LABEL = 'webapp-ui:@1 · webapp-ui-bb · opus · idle'

/** (a) busy */
export const BUSY: HqModel = {
  now: NOW,
  counts: { waiting: 3, broken: 2, inProgress: 3, sessions: 10 },
  flare: {
    text: 'st-api is waiting for your input',
    sinceMs: NOW - 2 * M,
    tmuxTarget: 'acme-store:@3.%6',
    jump: { kind: 'tmux', target: 'acme-store:@3.%6' },
  },
  current: { label: LABEL, agents: AGENTS, prs: PRS },
  others: OTHERS_BUSY,
  statusText: 'hq: st-api waiting 2m · PRs 1 red',
}

const quietOthers = OTHERS_BUSY.map(g => ({
  ...g,
  sessions: g.sessions.map(s => {
    const { waitingFor: _w, agentsRunning: _a, ...rest } = s
    return {
      ...rest,
      status: 'idle' as const,
      statusSince: s.name === 'st-api' ? NOW - 1 * M : s.name === 'st-admin' ? NOW - 3 * M : s.statusSince,
      ...(s.prSummary ? { prSummary: { total: s.prSummary.total, broken: 0, waiting: 0, inProgress: 0 } } : {}),
    }
  }),
}))

/** (b) quiet */
export const QUIET: HqModel = {
  now: NOW,
  counts: { waiting: 0, broken: 0, inProgress: 0, sessions: 10 },
  current: {
    label: LABEL,
    agents: [],
    prs: [
      pr({ repo: ADMIN, number: 433, title: 'Stat cards: one-decimal trend deltas', gallery: 'linked', watcher: 'merge-wait' }),
      pr({
        repo: API,
        number: 522,
        title: 'Bookings: idempotent webhook replay',
        ci: { kind: 'passed', total: 6 },
        gallery: 'no-visual-change',
        watcher: 'merge-wait',
      }),
    ],
  },
  others: quietOthers,
  statusText: 'hq: nothing needs you',
}

/** (f) long list: 12 other sessions in 7 tmux sessions. */
export const LONG: HqModel = {
  ...BUSY,
  counts: { waiting: 4, broken: 3, inProgress: 4, sessions: 13 },
  others: [
    group('acme-store', [
      OTHERS_BUSY[0]!.sessions[0]!,
      sess({ sessionId: 's-st-mobile', name: 'st-mobile', status: 'waiting', statusSince: NOW - 1 * M }, 'acme-store', '@6'),
      OTHERS_BUSY[0]!.sessions[1]!,
      OTHERS_BUSY[0]!.sessions[2]!,
    ]),
    group('finance', [
      sess(
        {
          sessionId: 's-fin-tax',
          name: 'finance-tax',
          statusSince: NOW - 26 * H,
          prSummary: { total: 1, broken: 1, waiting: 0, inProgress: 0 },
        },
        'finance',
        '@2',
      ),
      sess({ sessionId: 's-fin', name: 'finance', statusSince: NOW - 49 * H }, 'finance'),
    ]),
    group('acmeai', [
      sess(
        {
          sessionId: 's-acme',
          name: 'acme-app',
          status: 'busy',
          statusSince: NOW - 12 * M,
          agentsRunning: 2,
          prSummary: { total: 2, broken: 0, waiting: 0, inProgress: 1 },
        },
        'acmeai',
      ),
    ]),
    ...OTHERS_BUSY.slice(1, 5),
  ],
  statusText: 'hq: 2 waiting, st-api first 2m',
}

/** Nothing at all: a fresh session before the first poll. */
export const EMPTY: HqModel = {
  now: NOW,
  counts: { waiting: 0, broken: 0, inProgress: 0, sessions: 0 },
  current: { label: '', agents: [], prs: [] },
  others: [],
  statusText: '',
}

/** BUSY with the session's own activity, an agent keeping a todo list in another worktree, and session detail lines. */
export const ACTIVE: HqModel = {
  ...BUSY,
  current: {
    ...BUSY.current,
    now: {
      prompt: 'Fix the stale PR list in hq and scope wave-watcher wakes to the owning session',
      since: NOW - 2 * M,
      idle: false,
      tool: { text: 'Check CI on 276', since: NOW - 4 * S },
    },
    todos: [
      { text: 'Read the claims code', status: 'completed' },
      { text: 'Rewrite ownership', status: 'completed' },
      { text: 'Rewriting the layout', status: 'in_progress' },
      { text: 'Write ADR 0002', status: 'pending' },
      { text: 'Run the gates', status: 'pending' },
    ],
    waiting: [{ text: 'pr-ci-wait 276', since: NOW - 3 * M }],
    agents: BUSY.current.agents.map(a =>
      a.id === 'a2' ? { ...a, place: 'ledger-refund-reconcile', todo: { text: 'Running ledger specs', done: 3, total: 7 } } : a,
    ),
  },
  others: BUSY.others.map(g => ({
    ...g,
    sessions: g.sessions.map(s =>
      s.sessionId === 's-st-api'
        ? { ...s, detail: 'api · ENG-12 · 3/7 · Rewriting PR claim rules' }
        : s.sessionId === 's-st-admin'
          ? {
              ...s,
              agents: [
                {
                  id: 'o1',
                  title: 'Implement ENG-1941 card pairing guard',
                  model: 'opus',
                  startedAt: NOW - 12 * M,
                  doing: 'Run ledger specs',
                },
                { id: 'o2', title: 'Review the members table PR', model: 'claude-sonnet-4-6', startedAt: NOW - 20 * M },
                { id: 'o3', title: 'Capture screenshot pairs', startedAt: NOW - 25 * M, doing: 'editing gallery.html' },
              ],
            }
          : s,
    ),
  })),
}
