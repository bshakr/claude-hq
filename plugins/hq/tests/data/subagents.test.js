import { expect, test } from 'claude-code/testing';
import { buildFleet, toSessionVM } from '../../hooks/data/fleet';
import { AGENT_FRESH_MS, LONG_CALL_MS, OPEN_CALL_CAP_MS, freshTranscripts, isRunning, longCall, otherAgents, parseMeta, parseTail, subagentsDir } from '../../hooks/data/subagents';
import { plainText, summaryLine } from '../../hooks/model/plain';
import * as SUB from './subagent-fixtures';
const T0 = Date.parse('2026-10-08T12:00:00.000Z');
test('subagents: the transcript dir follows the projects naming', () => {
    expect(subagentsDir('/Users/b', '/Users/b/code/monolense', 'sid')).toBe('/Users/b/.claude/projects/-Users-b-code-monolense/sid/subagents');
    expect(subagentsDir('/h', '/h/.supacode/repos/a_b', 's')).toBe('/h/.claude/projects/-h--supacode-repos-a-b/s/subagents');
});
test('subagents: end of agent is a toolEndsTurn result or an end_turn answer; a streamed text block is not', () => {
    expect(parseTail(SUB.running, false)).toEqual({ ended: false, doing: 'Run ledger specs' });
    expect(parseTail(SUB.handedBack, false).ended).toBe(true);
    expect(parseTail(SUB.running + SUB.endTurn, false).ended).toBe(true);
    expect(parseTail(SUB.handingBack, false)).toEqual({ ended: false, doing: 'reporting back', open: { text: 'reporting back' } });
    // A mid-turn text entry (stop_reason null) after a tool result keeps it running.
    expect(parseTail(SUB.running.split('\n').slice(0, 2).join('\n'), false).ended).toBe(false);
});
test('subagents: a byte tail drops its cut first line; a file tool reads as verb and basename', () => {
    const cut = SUB.running.slice(SUB.running.indexOf('"type":"assistant"') - 20);
    expect(parseTail(cut, true)).toEqual({ ended: false, doing: 'Run ledger specs' });
    const read = SUB.running.split('\n').slice(0, 3).join('\n');
    expect(parseTail(read, false).doing).toBe('reading card.rb');
    expect(parseTail('', false)).toEqual({ ended: false });
});
test('subagents: only fresh transcripts are tailed; running ones listed newest first', () => {
    const now = 10_000_000;
    const files = [
        { name: 'agent-a.jsonl', kind: 'file', size: 9, mtimeMs: now - 1_000 },
        { name: 'agent-a.meta.json', kind: 'file', size: 9, mtimeMs: now - 1_000 },
        { name: 'agent-b.jsonl', kind: 'file', size: 9, mtimeMs: now - AGENT_FRESH_MS - 1 },
        { name: 'agent-c.jsonl', kind: 'file', size: 9, mtimeMs: now - 5_000 },
        { name: 'notes', kind: 'dir', size: 0, mtimeMs: now },
    ];
    expect(freshTranscripts(files, now).map(f => f.name)).toEqual(['agent-a.jsonl', 'agent-c.jsonl']);
    expect(parseMeta(SUB.meta('Do X', 'opus'))).toEqual({ description: 'Do X', model: 'opus' });
    expect(parseMeta('{bad')).toEqual({});
    const got = otherAgents([
        { id: 'old', meta: { description: 'Old' }, startedAt: 1, tail: { ended: false } },
        { id: 'gone', meta: { description: 'Gone' }, startedAt: 3, tail: { ended: true } },
        { id: 'new', meta: { description: 'New', model: 'sonnet' }, startedAt: 2, tail: { ended: false, doing: 'editing a.ts' } },
    ]);
    expect(got).toEqual([
        { id: 'new', title: 'New', model: 'sonnet', startedAt: 2, doing: 'editing a.ts' },
        { id: 'old', title: 'Old', startedAt: 1 },
    ]);
});
const row = (extra = {}) => ({
    pid: 7, sessionId: 'm1', cwd: '/Users/b/code/monolense', tmux: 'monolense:@2.%3', status: 'busy', ...extra,
});
const agent = { id: 'x', title: 'Implement guard', model: 'opus', startedAt: 5 };
test('fleet: a fresh publish with agents wins; otherwise the transcripts give the list and the count', () => {
    const now = 100_000;
    const pub = {
        sessionId: 'm1', pid: 7, updatedAt: now - 1_000, agentsRunning: 5,
        prSummary: { total: 0, broken: 0, waiting: 0, inProgress: 0 }, agents: [{ ...agent, id: 'p' }],
    };
    expect(toSessionVM(row(), undefined, pub, now, {}, [agent])).toMatchObject({ agentsRunning: 5, agents: [{ id: 'p' }] });
    expect(toSessionVM(row(), undefined, undefined, now, {}, [agent])).toMatchObject({ agentsRunning: 1, agents: [agent] });
    const bare = toSessionVM(row(), undefined, undefined, now, {}, []);
    expect(bare.agents).toBe(undefined);
    expect(bare.agentsRunning).toBe(undefined);
    const groups = buildFleet([row()], new Set([7]), 'self', new Map(), new Map(), now, undefined, new Map(), new Map([['m1', [agent]]]));
    expect(groups.others[0].sessions[0].agents).toEqual([agent]);
});
test('fleet: the dim line is dropped when it only repeats the tmux group, kept when it adds a branch or doing', () => {
    expect(toSessionVM(row(), undefined, undefined, 0).detail).toBe(undefined);
    expect(toSessionVM(row(), 'main', undefined, 0).detail).toBe(undefined);
    expect(toSessionVM(row(), 'BLO-1941-guard', undefined, 0).detail).toBe('monolense · BLO-1941-guard');
    expect(toSessionVM(row({ cwd: '/Users/b/code/monolense/.koh/BLO-7' }), undefined, undefined, 0).detail).toBe('BLO-7');
    const pub = { sessionId: 'm1', pid: 7, updatedAt: 0, agentsRunning: 0, prSummary: { total: 0, broken: 0, waiting: 0, inProgress: 0 }, doing: '2/4 · Ship' };
    expect(toSessionVM(row(), undefined, pub, 1).detail).toBe('monolense · 2/4 · Ship');
});
test('plain text: markdown is stripped and the first sentence kept', () => {
    expect(summaryLine('**Brief and all four add-ons are done.** HQ now shows todos.\n\nMore')).toBe('Brief and all four add-ons are done.');
    expect(summaryLine('**Brief and all four add-ons are done; HQ now/todos')).toBe('Brief and all four add-ons are done; HQ now/todos');
    expect(summaryLine('## Report\n\n- Fixed `firstLine` in [agents.ts](hooks/data/agents.ts). Then tests.')).toBe('Fixed firstLine in agents.ts.');
    expect(summaryLine('# Only a heading')).toBe('Only a heading');
    expect(summaryLine('1. *Scoped* the __PR__ ~~list~~ to snake_case_name')).toBe('Scoped the PR list to snake_case_name');
    expect(summaryLine('Fixed the refund rounding; 3 specs added.\nmore')).toBe('Fixed the refund rounding; 3 specs added.');
    expect(summaryLine('Bumped to v2.1 e.g. for node 20. Then shipped')).toBe('Bumped to v2.1 e.g. for node 20.');
    expect(summaryLine('\n\n')).toBe(undefined);
    expect(plainText('> quoted **bold** `x * y`')).toBe('quoted bold x * y');
});
test('subagents: an open tool call keeps a stale transcript running; a result or an end_turn closes it', () => {
    const tail = parseTail(SUB.running + SUB.openCall(T0), false);
    expect(tail).toEqual({ ended: false, doing: 'Wait for CI on #275', open: { text: 'Wait for CI on #275', since: T0 } });
    const mtime = T0;
    // Ten minutes into the call the file has not moved: still running.
    expect(isRunning(tail, mtime, T0 + 10 * 60_000, false)).toBe(true);
    // No open call and a stale file: ended, as before.
    expect(isRunning(parseTail(SUB.running, false), mtime, T0 + 10 * 60_000, false)).toBe(false);
    expect(isRunning(parseTail(SUB.running, false), mtime, T0 + 10_000, false)).toBe(true);
    // Its result lands: closed.
    const closed = SUB.running + SUB.openCall(T0) + JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't9' }] } }) + '\n';
    expect(parseTail(closed, false).open).toBe(undefined);
    expect(parseTail(SUB.running + SUB.openCall(T0) + SUB.endTurn, false)).toMatchObject({ ended: true });
    expect(parseTail(SUB.running + SUB.openCall(T0) + SUB.endTurn, false).open).toBe(undefined);
});
test('subagents: an open call past 2 h counts as ended unless its session is busy', () => {
    const tail = parseTail(SUB.running + SUB.openCall(T0), false);
    const late = T0 + OPEN_CALL_CAP_MS + 1;
    expect(isRunning(tail, T0, late, false)).toBe(false);
    expect(isRunning(tail, T0, late, true)).toBe(true);
    expect(isRunning(tail, T0, T0 + OPEN_CALL_CAP_MS - 1, false)).toBe(true);
});
test('subagents: a call open past LONG_CALL_MS is waiting, with its start; a short one is not', () => {
    const tail = parseTail(SUB.running + SUB.openCall(T0), false);
    const run = { id: 'w', meta: { description: 'Ship it' }, startedAt: 1, tail, mtimeMs: T0 };
    expect(otherAgents([run], T0 + LONG_CALL_MS - 1)[0].waiting).toBe(undefined);
    expect(otherAgents([run], T0 + 7 * 60_000)[0]).toEqual({
        id: 'w', title: 'Ship it', startedAt: 1, doing: 'Wait for CI on #275', waiting: { text: 'Wait for CI on #275', since: T0 },
    });
    // No timestamp on the entry: the transcript mtime stands in.
    const bare = { ...run, tail: { ended: false, open: { text: 'x' } } };
    expect(otherAgents([bare], T0 + LONG_CALL_MS)[0].waiting).toEqual({ text: 'x', since: T0 });
});
test('subagents: this session\'s agent in one long call publishes as waiting; parked on a child does not', () => {
    expect(longCall({ status: 'running', callSince: T0, now: 'Run specs' }, T0 + LONG_CALL_MS)).toEqual({ text: 'Run specs', since: T0 });
    expect(longCall({ status: 'running', callSince: T0, now: 'Run specs' }, T0 + LONG_CALL_MS - 1)).toBe(undefined);
    expect(longCall({ status: 'waiting', callSince: T0 }, T0 + LONG_CALL_MS)).toBe(undefined);
    expect(longCall({ status: 'running' }, T0 + LONG_CALL_MS)).toBe(undefined);
});
