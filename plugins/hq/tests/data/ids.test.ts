import { describe, expect, test } from 'claude-code/testing'

import { doingText, shellPhrase } from '../../hooks/data/doing'
import {
  LOOKUP_RETRY_MS, LOOKUP_TTL_MS, adrTitle, briefBatch, briefDue, expandIds, findIds, glossOf, lookUpAdr, lookUpTicket, lookupDue, parseBriefReply,
  parseLinearShow,
} from '../../hooks/data/ids'
import type { Fs, GlossEntry } from '../../hooks/data/ids'
import { emptyAgents, onSpawn, onSubagentTool } from '../../hooks/data/agents'
import { parseTail } from '../../hooks/data/subagents'
import { goalInput, emptyDigest } from '../../hooks/data/context'
import { layout } from '../../hooks/ui/layout'
import type { HqModel } from '../../hooks/model/types'

const NOW = 1_800_000_000_000

describe('ids: parsing and expansion', () => {
  test('tickets and ADR numbers in any spelling, each once, in order', () => {
    expect(findIds('Finish ADR 0019 epic BLO-1936 work, then ADR-19 and BLO-1936 again; ADR 7, AB-1, ABCDEF-2, x-1'))
      .toEqual([
        { kind: 'adr', id: 'ADR 0019', num: '0019' },
        { kind: 'ticket', id: 'BLO-1936' },
        { kind: 'adr', id: 'ADR 0007', num: '0007' },
        { kind: 'ticket', id: 'AB-1' },
      ])
    expect(findIds('branch BLO-1940-promote')).toEqual([{ kind: 'ticket', id: 'BLO-1940' }])
  })

  test('the first occurrence of each glossed id is expanded; unknown ids and later repeats stay bare', () => {
    const g = { 'BLO-1947': 'withhold file from labels', 'ADR 0019': 'append-only raw bank data' }
    expect(expandIds('Fix batch BLO-1947', g)).toBe('Fix batch BLO-1947 (withhold file from labels)')
    expect(expandIds('Finish ADR-19 epic BLO-1936, BLO-1947 then BLO-1947', g))
      .toBe('Finish ADR-19 (append-only raw bank data) epic BLO-1936, BLO-1947 (withhold file from labels) then BLO-1947')
    expect(expandIds('BLO-1947 (already said)', g)).toBe('BLO-1947 (already said)')
    expect(expandIds('Fix batch BLO-1947', undefined)).toBe('Fix batch BLO-1947')
  })

  test('linear show, ADR headings, and the model reply', () => {
    expect(parseLinearShow('# BLO-1947: Evaluation: write a blind build\'s withhold file from a label set\n\nbody', 'BLO-1947'))
      .toBe('Evaluation: write a blind build\'s withhold file from a label set')
    expect(parseLinearShow('# BLO-1: other\n', 'BLO-1947')).toBeUndefined()
    expect(parseLinearShow('error: not found', 'BLO-1947')).toBeUndefined()
    expect(adrTitle('- Status: x\n# Raw bank data is append-only\n', '0019-raw.md')).toBe('Raw bank data is append-only')
    expect(adrTitle('no heading', '0019-append-only-raw-bank-data.md')).toBe('append only raw bank data')
    expect(parseBriefReply('```json\n{"1": "withhold file from labels.", "2": "one two three four five six"}\n```', ['1', '2', '3']))
      .toEqual({ '1': 'withhold file from labels', '2': 'one two three four five' })
    expect(glossOf({ title: 'Evaluation: write a blind build withhold file', fetchedAt: 1 })).toBe('Evaluation: write a blind build')
    expect(glossOf({ title: 'x y', brief: 'short', fetchedAt: 1 })).toBe('short')
  })
})

describe('ids: ADR resolution from a repo', () => {
  const tree: Record<string, { name: string; kind: string }[]> = {
    '/r/docs/adr': [{ name: '0004-a-card-names-its-goal.md', kind: 'file' }, { name: '0019-append-only-raw-bank-data.md', kind: 'file' }],
    '/r/design': [{ name: 'pricing', kind: 'directory' }],
    '/r/design/pricing/adr': [{ name: '0031-seat-pricing.md', kind: 'file' }],
  }
  const files: Record<string, string> = {
    '/r/docs/adr/0019-append-only-raw-bank-data.md': '# Raw bank data is append-only and never rewritten\n\n- Status: accepted\n',
    '/r/design/pricing/adr/0031-seat-pricing.md': 'no heading here',
  }
  const fs: Fs = { list: async d => tree[d], read: async p => files[p] }

  test('docs/adr by heading, design/<topic>/adr by slug, a missing number fails', async () => {
    expect((await lookUpAdr('/r', '0019', undefined, NOW, fs)).title).toBe('Raw bank data is append-only and never rewritten')
    expect((await lookUpAdr('/r', '0031', undefined, NOW, fs)).title).toBe('seat pricing')
    expect(await lookUpAdr('/r', '0099', undefined, NOW, fs)).toEqual({ failedAt: NOW })
    expect(await lookUpAdr('/nowhere', '0019', undefined, NOW, fs)).toEqual({ failedAt: NOW })
  })
})

describe('ids: cache and refresh', () => {
  const linear = (title: string | undefined) => {
    const calls: string[][] = []
    const run = async (argv: string[]) => {
      calls.push(argv)
      return title === undefined ? { exitCode: 1, stdout: '' } : { exitCode: 0, stdout: `# ${argv[3]}: ${title}\n` }
    }
    return { calls, run }
  }

  test('due on first sight, after 24 h, and 30 min after a failure', () => {
    expect(lookupDue(undefined, NOW)).toBe(true)
    const ok: GlossEntry = { title: 't', fetchedAt: NOW }
    expect(lookupDue(ok, NOW + LOOKUP_TTL_MS - 1)).toBe(false)
    expect(lookupDue(ok, NOW + LOOKUP_TTL_MS)).toBe(true)
    const failed: GlossEntry = { failedAt: NOW }
    expect(lookupDue(failed, NOW + LOOKUP_RETRY_MS - 1)).toBe(false)
    expect(lookupDue(failed, NOW + LOOKUP_RETRY_MS)).toBe(true)
    // A failed refresh keeps the old title and waits 30 min, not 24 h.
    const stale: GlossEntry = { title: 't', fetchedAt: NOW, failedAt: NOW + LOOKUP_TTL_MS }
    expect(lookupDue(stale, NOW + LOOKUP_TTL_MS + 1)).toBe(false)
    expect(lookupDue(stale, NOW + LOOKUP_TTL_MS + LOOKUP_RETRY_MS)).toBe(true)
  })

  test('a ticket lookup runs linear issue show; a failure keeps the old title; a rename drops the old brief', async () => {
    const { calls, run } = linear('Write the withhold file')
    const e = await lookUpTicket('BLO-1947', undefined, NOW, run)
    expect(calls).toEqual([['linear', 'issue', 'show', 'BLO-1947']])
    expect(e).toEqual({ title: 'Write the withhold file', fetchedAt: NOW })
    const failed = await lookUpTicket('BLO-1947', { ...e, brief: 'withhold file' }, NOW + 1, linear(undefined).run)
    expect(failed).toEqual({ title: 'Write the withhold file', brief: 'withhold file', fetchedAt: NOW, failedAt: NOW + 1 })
    expect(glossOf(failed)).toBe('withhold file')
    const same = await lookUpTicket('BLO-1947', { ...e, brief: 'withhold file' }, NOW + 2, run)
    expect(same.brief).toBe('withhold file')
    const renamed = await lookUpTicket('BLO-1947', { ...e, brief: 'withhold file' }, NOW + 2, linear('Something else').run)
    expect(renamed).toEqual({ title: 'Something else', fetchedAt: NOW + 2 })
  })

  test('briefs: one call for every title without one; a missed key falls back to the first words and retries after 30 min', async () => {
    const entries = new Map<string, GlossEntry>([
      ['gloss:BLO-1947', { title: 'Evaluation: write a blind build\'s withhold file from a label set', fetchedAt: NOW }],
      ['gloss:adr:/r:0019', { title: 'Raw bank data is append-only and never rewritten', fetchedAt: NOW }],
      ['gloss:BLO-1', { title: 'has one', brief: 'has one', fetchedAt: NOW }],
      ['gloss:BLO-2', { failedAt: NOW }],
    ])
    const asked: string[] = []
    const got = await briefBatch(entries, NOW, async req => {
      asked.push(req.prompt)
      return { isAnswered: true, text: '{"1": "withhold file from labels"}' }
    })
    expect(asked).toEqual(['1: Evaluation: write a blind build\'s withhold file from a label set\n2: Raw bank data is append-only and never rewritten'])
    expect(got.get('gloss:BLO-1947')!.brief).toBe('withhold file from labels')
    const missed = got.get('gloss:adr:/r:0019')!
    expect(missed.briefFailedAt).toBe(NOW)
    expect(glossOf(missed)).toBe('Raw bank data is append-only')
    expect(briefDue(missed, NOW + LOOKUP_RETRY_MS - 1)).toBe(false)
    expect(briefDue(missed, NOW + LOOKUP_RETRY_MS)).toBe(true)
    // A thrown call backs every key off.
    const thrown = await briefBatch(new Map([['k', { title: 'a b c', fetchedAt: NOW }]]), NOW, async () => {
      throw new Error('offline')
    })
    expect(thrown.get('k')).toEqual({ title: 'a b c', fetchedAt: NOW, briefFailedAt: NOW })
  })

  test('resolved titles reach the goal summary input', () => {
    const d = emptyDigest()
    d.firstPrompt = 'Finish ADR 0019 epic BLO-1936 work'
    const text = goalInput(d, { idTitles: ['BLO-1936: Raw bank import epic', 'ADR 0019: Raw bank data is append-only'] })
    expect(text.includes('## Tickets and ADRs referenced\n- BLO-1936: Raw bank import epic\n- ADR 0019: Raw bank data is append-only')).toBe(true)
  })
})

describe('doing line: never a raw shell command', () => {
  const LOOP = 'until gh pr checks 277 --required | grep -q pass; do sleep 30; done'

  test('shapes map to plain words', () => {
    expect(shellPhrase(LOOP)).toBe('waiting for CI')
    expect(shellPhrase('while ! curl -s http://localhost:3000/up; do sleep 2; done')).toBe('waiting for localhost:3000')
    expect(shellPhrase('until [ -f /tmp/claude-hq/done.txt ]; do sleep 5; done')).toBe('waiting for done.txt')
    expect(shellPhrase('until foo; do sleep 1; done')).toBe('waiting')
    expect(shellPhrase('sleep 60')).toBe('waiting')
    expect(shellPhrase('cd /repo && bundle exec rspec spec/ledger')).toBe('running tests')
    expect(shellPhrase('bun test tests/x.test.ts')).toBe('running tests')
    expect(shellPhrase('npx jest --watch=false')).toBe('running tests')
    expect(shellPhrase('claude plugin test hq')).toBe('running tests')
    expect(shellPhrase('pr-ci-wait 277')).toBe('checking CI')
    expect(shellPhrase('gh pr checks 277')).toBe('checking CI')
    expect(shellPhrase('pr-merge-wait 277')).toBe('waiting for a merge')
    expect(shellPhrase('git push -u origin HEAD')).toBe('pushing')
    expect(shellPhrase('cd /x && echo hi && sleep 3 && git status')).toBe('checking git status')
    expect(shellPhrase('weird-tool --flag')).toBe('running a command')
    expect(shellPhrase('')).toBe('running a command')
  })

  test('the description wins when there is one', () => {
    expect(doingText({ tool: 'Bash', command: LOOP, description: 'Wait for CI on #277' })).toBe('Wait for CI on #277')
    expect(doingText({ tool: 'Bash', command: LOOP })).toBe('waiting for CI')
  })

  test('transcript-only path: a subagent tail with the loop and no description', () => {
    const line = (v: Record<string, unknown>) => `${JSON.stringify(v)}\n`
    const tail =
      line({ type: 'user', message: { role: 'user', content: 'Wait for CI.' } }) +
      line({ type: 'assistant', timestamp: new Date(NOW).toISOString(), message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: LOOP } }] } })
    const t = parseTail(tail, false)
    expect(t.doing).toBe('waiting for CI')
    expect(t.open?.text).toBe('waiting for CI')
    expect(JSON.stringify(t).includes('until')).toBe(false)
  })

  test('live path: this session\'s agent running the loop', () => {
    const s = emptyAgents()
    onSpawn(s, { toolUseId: 'tu1', description: 'Fix batch BLO-1947', background: true }, 'a1', 'opus', NOW)
    onSubagentTool(s, 'a1', { tool: 'Bash', command: LOOP }, '/home/u', NOW)
    expect(s.byId.a1!.now).toBe('waiting for CI')
  })
})

describe('layout: glossed ids', () => {
  const model = (glosses: Record<string, string> | undefined): HqModel => ({
    now: NOW,
    counts: { waiting: 0, broken: 0, inProgress: 1, sessions: 2 },
    current: {
      label: '', goal: { text: 'Finish ADR 0019 epic BLO-1936 work', day: 2 }, agents: [
        { id: 'a1', title: 'Fix batch BLO-1947', status: 'running', background: true, startedAt: NOW - 60_000, toolCount: 1, now: 'reading BLO-1947 notes', files: [] },
      ], prs: [],
      ...(glosses ? { glosses } : {}),
    },
    others: [{
      tmuxSession: 'monolense', sessions: [{
        sessionId: 'm1', name: 'Finish ADR 0019 epic BLO-1936 work', windowLabel: '@1', status: 'idle', step: 'BLO-1947 fix batch under review',
        agents: [{ id: 'o1', title: 'Fix batch BLO-1947', startedAt: NOW - 60_000, doing: 'waiting for CI' }],
        ...(glosses ? { glosses } : {}),
      }],
    }],
    statusText: '',
  })
  const G = { 'ADR 0019': 'append-only raw bank data', 'BLO-1936': 'raw bank import', 'BLO-1947': 'withhold file from labels' }
  const draw = (m: HqModel, width: number) =>
    layout(m, { width, rows: 40, focused: false, cursor: null, expanded: [], scroll: 0, phase: 0 }).rows.map(r => r.text())

  test('wide: every id on goal, step, agent title and doing lines is glossed once per line', () => {
    const got = draw(model(G), 120)
    expect(got.some(l => l.includes('Finish ADR 0019 (append-only raw bank data) epic BLO-1936 (raw bank import) work'))).toBe(true)
    expect(got.filter(l => l.includes('Fix batch BLO-1947 (withhold file from labels)')).length).toBe(2)
    expect(got.some(l => l.includes('reading BLO-1947 (withhold file from labels) notes'))).toBe(true)
    expect(got.some(l => l.includes('BLO-1947 (withhold file from labels) fix batch under review'))).toBe(true)
  })

  test('narrow: the expanded line is clipped with …; without glosses the ids stay bare', () => {
    const got = draw(model(G), 40)
    const goal = got[4]!
    expect(goal.includes('Finish ADR 0…  day 2 · ◷ waiting')).toBe(true)
    expect(goal.length).toBeLessThanOrEqual(40)
    const bare = draw(model(undefined), 120)
    expect(bare.some(l => l.includes('Fix batch BLO-1947') && !l.includes('('))).toBe(true)
  })
})
