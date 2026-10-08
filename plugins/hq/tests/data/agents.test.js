import { expect, test } from 'claude-code/testing';
import { agentList, emptyAgents, onAgentResult, onHandback, onSpawn, onSubagentTool, onTaskNotification, onTurnComplete, prune, reconcile, settleQuiet, } from '../../hooks/data/agents';
import { S, afterTool, agentsState, beforeTool, pendingClaims } from '../../hooks/data/observe';
const HOME = '/Users/me';
const KOH = `${HOME}/code/app/.koh/ledger-fix`;
test('agents: spawn, tool calls, foreground completion', () => {
    const s = emptyAgents();
    onSpawn(s, { toolUseId: 'tu1', description: 'Implement ledger fix', model: 'opus', background: false }, 'a1', 'claude-opus-5-5', 1_000);
    expect(s.byId.a1).toMatchObject({ status: 'running', model: 'claude-opus-5-5', background: false, startedAt: 1_000, toolCount: 0 });
    onSubagentTool(s, 'a1', { tool: 'Read', file_path: `${KOH}/app/ledger.rb` }, HOME);
    onSubagentTool(s, 'a1', { tool: 'Edit', file_path: `${KOH}/app/ledger.rb` }, HOME);
    onSubagentTool(s, 'a1', { tool: 'Write', file_path: `${KOH}/spec/ledger_spec.rb` }, HOME);
    onSubagentTool(s, 'a1', { tool: 'Edit', file_path: `${KOH}/app/ledger.rb` }, HOME);
    onSubagentTool(s, 'a1', { tool: 'Bash', command: `cd ${KOH} && bin/rspec spec/ledger_spec.rb --fail-fast --format documentation` }, HOME);
    const a = s.byId.a1;
    expect(a.toolCount).toBe(5);
    expect(a.worktree).toBe('.koh/ledger-fix');
    expect(a.files).toEqual(['app/ledger.rb', 'spec/ledger_spec.rb']);
    expect(a.now).toBe('running tests');
    onAgentResult(s, 'tu1', {
        status: 'completed', agentId: 'a1', resolvedModel: 'claude-opus-5-5', totalToolUseCount: 7, totalDurationMs: 9_000,
        totalTokens: 52_000, content: [{ type: 'text', text: '\nFixed the refund rounding; 3 specs added.\nmore' }], usage: {},
        prompt: 'x',
    }, false, undefined, 10_000);
    expect(s.byId.a1).toMatchObject({
        status: 'completed', endedAt: 10_000, toolCount: 7, tokens: 52_000, outcome: 'Fixed the refund rounding; 3 specs added.',
    });
});
test('agents: nested child parks the parent, completion wakes it', () => {
    const s = emptyAgents();
    onSpawn(s, { toolUseId: 'tu1', description: 'Parent', background: true }, 'p', 'opus', 1);
    onSubagentTool(s, 'p', { tool: 'Agent', description: 'Run specs' }, HOME);
    onSpawn(s, { toolUseId: 'tu2', description: 'Run specs', background: false, parentAgentId: 'p' }, 'c', 'sonnet', 2);
    expect(s.byId.p).toMatchObject({ status: 'waiting', now: 'waiting on its child: Run specs' });
    expect(s.byId.c).toMatchObject({ parentId: 'p', status: 'running' });
    onSubagentTool(s, 'c', { tool: 'Bash', command: 'bin/rspec' }, HOME);
    expect(s.byId.p.toolCount).toBe(1);
    expect(s.byId.c.toolCount).toBe(1);
    onAgentResult(s, 'tu2', { status: 'completed', agentId: 'c', totalToolUseCount: 1, totalTokens: 10, content: [{ type: 'text', text: 'green' }] }, false, undefined, 3);
    expect(s.byId.p.status).toBe('running');
    expect(s.byId.c.outcome).toBe('green');
});
test('agents: background completion via turn.complete, handback, failure and kill', () => {
    const s = emptyAgents();
    onSpawn(s, { toolUseId: 'tu1', description: 'Review', background: true }, 'b', undefined, 1);
    onAgentResult(s, 'tu1', { status: 'async_launched', agentId: 'b', resolvedModel: 'claude-sonnet' }, false, undefined, 2);
    expect(s.byId.b).toMatchObject({ status: 'running', model: 'claude-sonnet' });
    onHandback(s, 'b', 'Report: 2 findings\n...');
    onTurnComplete(s, 'b', 'answer', '', 900, 5);
    expect(s.byId.b).toMatchObject({ status: 'completed', outcome: 'Report: 2 findings', tokens: 900, endedAt: 5 });
    onSpawn(s, { toolUseId: 'tu2', description: 'Capture', background: true }, 'f', 'sonnet', 1);
    onTurnComplete(s, 'f', 'error', 'port 3000 already in use', undefined, 6);
    expect(s.byId.f).toMatchObject({ status: 'failed', now: 'port 3000 already in use' });
    onSpawn(s, { toolUseId: 'tu3', description: 'Stopped', background: true }, 'k', 'sonnet', 1);
    onTurnComplete(s, 'k', 'aborted', '', undefined, 7);
    expect(s.byId.k.status).toBe('killed');
    expect(agentList(s).map(a => a.id)).toEqual(['f', 'k', 'b']);
    expect('root' in agentList(s)[0]).toBe(false);
});
test('agents: unknown agent ids (forks, workflows) are ignored; list adopts missed agents', () => {
    const s = emptyAgents();
    expect(onSubagentTool(s, 'ghost', { tool: 'Bash', command: 'ls' }, HOME)).toBe(false);
    reconcile(s, [{ id: 'x', description: 'Adopted', type: 'general-purpose', status: 'running', parentId: 'y' }], 50);
    expect(s.byId.x).toMatchObject({ title: 'Adopted', status: 'running', parentId: 'y', startedAt: 50 });
    reconcile(s, [{ id: 'x', description: 'Adopted', type: 'general-purpose', status: 'completed' }], 60);
    expect(s.byId.x).toMatchObject({ status: 'completed', endedAt: 60 });
    prune(s, 60 + 31 * 60_000);
    expect(s.byId.x).toBe(undefined);
});
test('agents: a subagent creating a PR or pushing its branch owns it for that agent; its waiter claims nothing', () => {
    const s = agentsState();
    onSpawn(s, { toolUseId: 'tu9', description: 'Ship', background: true }, 'ship1', 'opus', 1);
    const push = { tool: 'Bash', agentId: 'ship1', tool_use_id: 't0', command: `cd ${KOH} && git push -u origin ledger-fix` };
    beforeTool(push);
    afterTool(push, { result: { stdout: '', stderr: 'To github.com:acme/app.git\n * [new branch]      ledger-fix -> ledger-fix\n' } });
    const call = { tool: 'Bash', agentId: 'ship1', tool_use_id: 't', command: `cd ${KOH} && gh pr create --fill` };
    beforeTool(call);
    afterTool(call, { result: { stdout: 'https://github.com/acme/app/pull/88\n', stderr: '', interrupted: false } });
    afterTool({ tool: 'Bash', agentId: 'ship1', tool_use_id: 't2', command: 'pr-ci-wait 88' }, { result: { stdout: '' } });
    afterTool({ tool: 'Bash', agentId: 'ship1', tool_use_id: 't3', command: 'gh pr view 90 -R acme/app' }, { result: { stdout: '' } });
    const mine = pendingClaims().filter(p => p.kind !== 'merged' && p.claimedBy === 'ship1');
    expect(mine).toEqual([
        { kind: 'pushed', repo: 'acme/app', branch: 'ledger-fix', dir: KOH, claimedBy: 'ship1' },
        { kind: 'created', repo: 'acme/app', number: 88, claimedBy: 'ship1' },
    ]);
    expect(s.byId.ship1.toolCount).toBe(2);
});
test('agents: the doing line is plain words, and a todo list wins with its progress', () => {
    const s = emptyAgents();
    onSpawn(s, { toolUseId: 'tu5', description: 'Fix', background: true, cwd: `${HOME}/code/other` }, 'd1', 'opus', 1);
    onSubagentTool(s, 'd1', { tool: 'Bash', command: 'head -2 x.ts; sed -n 60,85p x.ts', description: 'Read the poll code' }, HOME);
    expect(s.byId.d1.now).toBe('Read the poll code');
    onSubagentTool(s, 'd1', { tool: 'Bash', command: 'cd /x && bin/rspec spec' }, HOME);
    expect(s.byId.d1.now).toBe('running tests');
    onSubagentTool(s, 'd1', { tool: 'Read', file_path: `${KOH}/hooks/data/claims.ts` }, HOME);
    expect(s.byId.d1.now).toBe('reading claims.ts');
    onSubagentTool(s, 'd1', { tool: 'Edit', file_path: `${KOH}/hooks/ui/layout.ts` }, HOME);
    expect(s.byId.d1.now).toBe('editing layout.ts');
    onSubagentTool(s, 'd1', {
        tool: 'TodoWrite',
        todos: [
            { content: 'a', status: 'completed', activeForm: 'A-ing' },
            { content: 'b', status: 'completed', activeForm: 'B-ing' },
            { content: 'c', status: 'in_progress', activeForm: 'Rewriting claims' },
            { content: 'd', status: 'pending', activeForm: 'D-ing' },
        ],
    }, HOME);
    const [vm] = agentList(s, `${HOME}/code/app`);
    expect(vm.todo).toEqual({ text: 'Rewriting claims', done: 2, total: 4 });
    expect(vm.place).toBe('ledger-fix');
    expect(agentList(s, KOH)[0].place).toBe(undefined);
});
test('agents: a live agent the engine stops listing is closed after two reads', () => {
    const s = emptyAgents();
    onSpawn(s, { toolUseId: 'tu1', description: 'Lost in a reload', background: true }, 'z', 'opus', 1);
    reconcile(s, [], 10);
    expect(s.byId.z.status).toBe('running');
    reconcile(s, [], 20);
    expect(s.byId.z).toMatchObject({ status: 'completed', endedAt: 20 });
    expect('missing' in agentList(s)[0]).toBe(false);
});
test('agents: a subagent\'s open call carries its start until the result lands; a foreground child does not', () => {
    const s = agentsState();
    onSpawn(s, { toolUseId: 'tuw', description: 'Wait for CI', background: true }, 'w1', 'opus', 1);
    S.now = 5_000;
    const wait = { tool: 'Bash', agentId: 'w1', tool_use_id: 'tw', command: 'pr-ci-wait 275', description: 'Wait for CI on #275' };
    beforeTool(wait);
    expect(s.byId.w1.callSince).toBe(5_000);
    expect(agentList(s).find(a => a.id === 'w1').callSince).toBe(5_000);
    S.now = 600_000;
    afterTool(wait, { result: { stdout: '' } });
    expect(s.byId.w1.callSince).toBe(undefined);
    beforeTool({ tool: 'Agent', agentId: 'w1', tool_use_id: 'tc', description: 'child' });
    expect(s.byId.w1.callSince).toBe(undefined);
});
test('agents: a directory a subagent cds into is attributed to that agent, the main loop\'s to main', () => {
    const s = agentsState();
    onSpawn(s, { toolUseId: 'tud', description: 'Dirs', background: true }, 'd1', 'opus', 1);
    afterTool({ tool: 'Bash', agentId: 'd1', tool_use_id: 'x1', command: `cd ${KOH} && git status` }, { result: { stdout: '' } });
    afterTool({ tool: 'Bash', tool_use_id: 'x2', command: `cd ${HOME}/code/other && ls` }, { result: { stdout: '' } });
    expect(S.dirs.slice(0, 2)).toEqual([{ dir: `${HOME}/code/other`, by: 'main' }, { dir: KOH, by: 'd1' }]);
});
test('agents: a handed-back agent pruned after 30 min is not re-adopted as live from the engine list', () => {
    const s = emptyAgents();
    onSpawn(s, { toolUseId: 'tuP', description: 'Package for open source', background: true }, 'pk', 'opus', 1_000);
    onTurnComplete(s, 'pk', 'answer', 'Packaged.', 2_000_000, 540_000);
    const listed = (status) => [{ id: 'pk', description: 'Package for open source', type: 'general-purpose', status }];
    reconcile(s, listed('idle'), 600_000);
    prune(s, 540_000 + 30 * 60_000 + 1_000);
    expect(s.byId.pk).toBe(undefined);
    for (const status of ['idle', 'waiting', 'completed']) {
        reconcile(s, listed(status), 540_000 + 30 * 60_000 + 3_000);
        expect(agentList(s).filter(a => a.id === 'pk' && (a.status === 'running' || a.status === 'waiting'))).toEqual([]);
    }
    reconcile(s, listed('running'), 540_000 + 30 * 60_000 + 5_000);
    expect(s.byId.pk.status).toBe('running');
});
test('agents: a live subagent the engine lists as idle has ended; a teammate waiting for a message has not', () => {
    const s = emptyAgents();
    onSpawn(s, { toolUseId: 'tu1', description: 'Handed back', background: true }, 'h', 'opus', 1);
    onSpawn(s, { toolUseId: 'tu2', description: 'Teammate', background: true }, 't', 'opus', 1);
    reconcile(s, [
        { id: 'h', description: 'Handed back', type: 'general-purpose', status: 'idle' },
        { id: 't', description: 'Teammate', type: 'teammate', status: 'idle' },
    ], 50);
    expect(s.byId.h).toMatchObject({ status: 'completed', endedAt: 50 });
    expect(s.byId.t.status).toBe('waiting');
    reconcile(s, [{ id: 'new', description: 'Ended unseen', type: 'general-purpose', status: 'idle' }], 60);
    expect(s.byId.new).toBe(undefined);
});
test('agents: a task notification with a final status ends the agent; a quiet notified agent ends after 10 min', () => {
    const s = emptyAgents();
    onSpawn(s, { toolUseId: 'tuA', description: 'A', background: true }, 'a', 'opus', 1);
    onSpawn(s, { toolUseId: 'tuB', description: 'B', background: true }, 'b', 'opus', 1);
    onSubagentTool(s, 'a', { tool: 'SubagentHandback', message: 'Done.' }, HOME, 100);
    expect(onTaskNotification(s, [{ id: 'a', status: 'completed' }], 200)).toBe(true);
    expect(s.byId.a).toMatchObject({ status: 'completed', endedAt: 200 });
    expect(s.byId.a.now).toBe(undefined);
    onSubagentTool(s, 'b', { tool: 'Read', file_path: '/x/y.ts' }, HOME, 100);
    onTaskNotification(s, [{ id: 'tuB' }], 200);
    expect(settleQuiet(s, 100 + 9 * 60_000)).toBe(false);
    expect(s.byId.b.status).toBe('running');
    expect(settleQuiet(s, 100 + 10 * 60_000)).toBe(true);
    expect(s.byId.b).toMatchObject({ status: 'completed', endedAt: 100 + 10 * 60_000 });
    expect('lastToolAt' in agentList(s)[0]).toBe(false);
});
test('agents: internal tools never become doing text', () => {
    const s = emptyAgents();
    onSpawn(s, { toolUseId: 'tu1', description: 'X', background: true }, 'x', 'opus', 1);
    for (const tool of ['SubagentHandback', 'TaskStop', 'SendMessage', 'ToolSearch', 'Monitor', 'SomeNewTool']) {
        onSubagentTool(s, 'x', { tool }, HOME, 5);
        expect(s.byId.x.now).not.toContain(tool);
    }
    onTurnComplete(s, 'x', 'answer', 'ok', 2_411_391, 9);
    expect(s.byId.x.now).toBe(undefined);
});
