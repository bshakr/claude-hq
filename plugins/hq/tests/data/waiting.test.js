import { describe, expect, mock, test } from 'claude-code/testing';
import { emptyDigest, ingest } from '../../hooks/data/context';
import { buildFleet } from '../../hooks/data/fleet';
import { dueNotifications, notifyWaits, parseNotifyArg } from '../../hooks/data/notify';
import { W, onCallEnd, onCallStart, onLoopEnd, onPermissionRequest, otherWait, ownWait, permissionWait, resetWaits, } from '../../hooks/data/waiting';
const NOW = 1_000_000;
const QUESTION = {
    questions: [{
            question: 'Which date library should we use?', header: 'Library', multiSelect: false,
            options: [{ label: 'date-fns', description: 'small' }, { label: 'dayjs', description: 'tiny' }],
        }],
};
describe('a wait in plain words', () => {
    test('permission: tool and a short target', () => {
        expect(permissionWait('Bash', { command: 'rm -rf tmp/\necho done' }, NOW)).toEqual({ kind: 'permission', text: 'Bash: rm -rf tmp/', since: NOW });
        expect(permissionWait('Edit', { file_path: '/repo/app/ledger.rb', old_string: 'a', new_string: 'b' }, NOW).text).toBe('Edit: ledger.rb');
        expect(permissionWait('WebFetch', { url: 'https://docs.example.com/a/b', prompt: 'x' }, NOW).text).toBe('WebFetch: docs.example.com');
        expect(permissionWait('mcp__linear__list_issues', {}, NOW).text).toBe('linear list_issues');
    });
    test('question: the first question and its option labels; plan approval', () => {
        expect(permissionWait('AskUserQuestion', QUESTION, NOW)).toEqual({ kind: 'question', text: 'Which date library should we use?', options: ['date-fns', 'dayjs'], since: NOW });
        expect(permissionWait('ExitPlanMode', {}, NOW)).toEqual({ kind: 'plan', text: 'approve the plan', since: NOW });
    });
});
describe('capture and clear in this session', () => {
    test('a permission request opens a wait on its in-flight call; the call settling clears it', () => {
        resetWaits();
        onCallStart('t1', 'Bash', 'main', { command: 'ls' }, NOW);
        onCallStart('t2', 'Bash', 'main', { command: 'rm -rf tmp/' }, NOW);
        onPermissionRequest('Bash', { command: 'rm -rf tmp/' }, undefined, NOW + 5);
        expect(ownWait({ idle: false, since: 0 })).toEqual({ kind: 'permission', text: 'Bash: rm -rf tmp/', since: NOW + 5 });
        // The other Bash call finishing does not answer this dialog.
        onCallEnd('t1', 'Bash', 'main');
        expect(W.open.length).toBe(1);
        onCallEnd('t2', 'Bash', 'main');
        expect(ownWait({ idle: false, since: 0 })).toBe(undefined);
    });
    test('AskUserQuestion is a question from the call itself; its permission request does not double it', () => {
        resetWaits();
        onCallStart('q1', 'AskUserQuestion', 'main', QUESTION, NOW);
        onPermissionRequest('AskUserQuestion', QUESTION, undefined, NOW + 1);
        expect(W.open.length).toBe(1);
        expect(ownWait({ idle: false, since: 0 })?.kind).toBe('question');
        onCallEnd('q1', 'AskUserQuestion', 'main');
        expect(W.open.length).toBe(0);
    });
    test("a subagent's prompt is keyed by the loop of its in-flight call, so that call settling clears it", () => {
        resetWaits();
        onCallStart('s1', 'Bash', 'agent-a', { command: 'rm -rf tmp/' }, NOW);
        onPermissionRequest('Bash', { command: 'rm -rf tmp/' }, 'other-id-form', NOW);
        expect(W.open.map(o => o.loop)).toEqual(['agent-a']);
        onCallEnd('s1', 'Bash', 'agent-a');
        expect(W.open.length).toBe(0);
    });
    test("a subagent's prompt is cleared by its own turn ending, not the main loop's", () => {
        resetWaits();
        onPermissionRequest('Write', { file_path: '/x/notes.md' }, 'agent-1', NOW);
        onLoopEnd('main');
        expect(ownWait({ idle: true, since: NOW })?.text).toBe('Write: notes.md');
        onLoopEnd('agent-1');
        expect(ownWait({ idle: true, since: NOW, prompt: 'fix it' })).toEqual({ kind: 'turn', text: 'your turn', since: NOW });
        expect(ownWait({ idle: true, since: NOW })).toBe(undefined);
    });
});
const tLine = (v) => `${JSON.stringify({ timestamp: new Date(NOW).toISOString(), ...v })}\n`;
const askLine = tLine({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'AskUserQuestion', input: QUESTION }], stop_reason: 'tool_use' } });
const answerLine = tLine({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'dayjs' }] } });
const replyLine = tLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn' } });
describe('another session read from its transcript', () => {
    test('an AskUserQuestion with no result yet is an open question; its result closes it', () => {
        const d = emptyDigest();
        ingest(d, askLine);
        expect(otherWait(undefined, d, 'busy', undefined)).toEqual({ kind: 'question', text: 'Which date library should we use?', options: ['date-fns', 'dayjs'], since: NOW });
        ingest(d, answerLine + replyLine);
        expect(d.ask).toBe(undefined);
        expect(otherWait(undefined, d, 'idle', NOW + 9)).toEqual({ kind: 'turn', text: 'your turn', since: NOW + 9 });
        expect(otherWait(undefined, d, 'busy', NOW + 9)).toBe(undefined);
    });
    test("a session's own published word wins over its transcript", () => {
        const d = emptyDigest();
        ingest(d, askLine);
        const pub = { sessionId: 'x', pid: 1, updatedAt: NOW, agentsRunning: 0, prSummary: { total: 0, broken: 0, waiting: 0, inProgress: 0 } };
        expect(otherWait(pub, d, 'busy', undefined)).toBe(undefined);
        const waiting = { kind: 'permission', text: 'Bash: rm -rf tmp/', since: NOW };
        expect(otherWait({ ...pub, waiting }, d, 'busy', undefined)).toEqual(waiting);
    });
    test('a real wait makes the card waiting, counts and leads the flare; your turn does not', () => {
        const row = (pid, sessionId, extra = {}) => ({ pid, sessionId, cwd: `/c/${sessionId}`, tmux: `t:@${pid}.%${pid}`, status: 'busy', statusUpdatedAt: NOW - 50, ...extra });
        const waits = new Map([
            ['a', { kind: 'permission', text: 'Bash: rm -rf tmp/', since: NOW - 10 }],
            ['b', { kind: 'turn', text: 'your turn', since: NOW - 20 }],
        ]);
        const fleet = buildFleet([row(1, 'self'), row(2, 'a'), row(3, 'b', { status: 'idle' })], new Set([1, 2, 3]), 'self', new Map(), new Map(), NOW, 1, new Map(), new Map(), new Map(), waits);
        const all = fleet.others.flatMap(g => g.sessions);
        const a = all.find(s => s.sessionId === 'a');
        const b = all.find(s => s.sessionId === 'b');
        expect([a.status, a.statusSince, a.waitingFor, a.wait?.kind]).toEqual(['waiting', NOW - 10, 'Bash: rm -rf tmp/', 'permission']);
        expect([b.status, b.wait?.kind]).toEqual(['idle', 'turn']);
    });
});
describe('notify', () => {
    const group = (sessions) => [{
            tmuxSession: 't', sessions: sessions.map(s => ({ ...s, windowLabel: '', status: s.wait && s.wait.kind !== 'turn' ? 'waiting' : 'idle' })),
        }];
    test('once per wait, never for this session, never for your turn or a stale wait', async () => {
        const perm = { kind: 'permission', text: 'Bash: rm -rf tmp/', since: NOW - 1_000 };
        const others = group([
            { sessionId: 'a', name: 'Refund reconcile', wait: perm },
            { sessionId: 'self', name: 'me', wait: perm },
            { sessionId: 'b', name: 'docs', wait: { kind: 'turn', text: 'your turn', since: NOW } },
            { sessionId: 'c', name: 'old', wait: { ...perm, since: NOW - 3_600_000 } },
        ]);
        const seen = new Set();
        const sent = [];
        const claimed = new Set();
        const deps = {
            enabled: async () => true,
            claim: async (k) => (claimed.has(k) ? false : (claimed.add(k), true)),
            send: async (t) => void sent.push(t),
        };
        expect(dueNotifications(others, seen, 'self', NOW).map(d => d.text)).toEqual(['Refund reconcile: Bash: rm -rf tmp/']);
        await notifyWaits(dueNotifications(others, seen, 'self', NOW), seen, deps);
        await notifyWaits(dueNotifications(others, seen, 'self', NOW), seen, deps);
        // Another instance with its own memory loses the claim.
        await notifyWaits(dueNotifications(others, new Set(), 'self', NOW), new Set(), deps);
        expect(sent).toEqual(['Refund reconcile: Bash: rm -rf tmp/']);
        // A new wait from the same session is news again.
        const again = group([{ sessionId: 'a', name: 'Refund reconcile', wait: { ...perm, since: NOW } }]);
        await notifyWaits(dueNotifications(again, seen, 'self', NOW), seen, deps);
        expect(sent.length).toBe(2);
    });
    test('off: nothing is sent, and turning it back on does not replay', async () => {
        const others = group([{ sessionId: 'a', name: 'x', wait: { kind: 'question', text: 'Ship it?', since: NOW } }]);
        const seen = new Set();
        const sent = [];
        let on = false;
        const deps = { enabled: async () => on, claim: async () => true, send: async (t) => void sent.push(t) };
        await notifyWaits(dueNotifications(others, seen, 'self', NOW), seen, deps);
        on = true;
        await notifyWaits(dueNotifications(others, seen, 'self', NOW), seen, deps);
        expect(sent).toEqual([]);
        expect([parseNotifyArg('notify on'), parseNotifyArg('notify off'), parseNotifyArg('notify'), parseNotifyArg('close')]).toEqual([true, false, 'show', undefined]);
    });
});
// ---------- the plugin end to end ----------
const HOME = '/home/u';
const SID = 'self-sid';
function host(on, files, writes, ran, notes) {
    const madeDirs = new Set();
    on('session.start', ($, e) => ({ cwd: e.cwd }));
    on('env.get', ($, e) => ({ value: e.name === 'HOME' ? HOME : undefined }));
    on('session.id', () => ({ value: SID }));
    on('session.cwd', () => ({ value: `${HOME}/code/app` }));
    on('agent.list', () => ({ value: [] }));
    on('command.register', ($, e) => ({ value: { command: e.name } }));
    on('fs.list', ($, e) => {
        const prefix = `${e.path}/`;
        const names = Object.keys(files).filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'));
        if (names.length === 0)
            throw new Error(`ENOENT ${e.path}`);
        return { value: names.map(p => ({ name: p.slice(prefix.length), kind: 'file', size: files[p].length, mtimeMs: 0, isLink: false })) };
    });
    on('fs.read', ($, e) => {
        const text = files[e.path];
        if (text === undefined)
            throw new Error(`ENOENT ${e.path}`);
        return { value: text };
    });
    on('fs.stat', ($, e) => {
        const text = files[e.path];
        if (text === undefined)
            throw new Error(`ENOENT ${e.path}`);
        return { value: { kind: 'file', size: text.length, mtimeMs: 0, isLink: false } };
    });
    on('fs.write', ($, e) => {
        writes[e.path] = e.text;
        return { value: undefined };
    });
    on('process.run', ($, e) => {
        const argv = [...e.argv];
        ran.push(argv);
        const res = (exitCode, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } });
        if (argv[0] === 'ps')
            return res(0, argv[argv.length - 1].split(',').map(p => `${p}\n`).join(''));
        if (argv[0] === 'tail') {
            const path = argv[argv.length - 1];
            const from = argv[2]?.startsWith('+') ? Number(argv[2].slice(1)) - 1 : 0;
            return res(0, (files[path] ?? '').slice(from));
        }
        if (argv[0] === 'mkdir' && argv[1] !== '-p') {
            if (madeDirs.has(argv[1]))
                return res(1);
            madeDirs.add(argv[1]);
            return res(0);
        }
        if (argv[0] === 'mkdir' || argv[0] === 'find')
            return res(0);
        return res(1);
    });
    on('ui.notify', ($, e) => {
        notes.push({ text: e.text, ...(e.title ? { title: e.title } : {}) });
        return { value: { isSent: true, channel: 'terminal_bell' } };
    });
}
const regRow = (pid, extra) => JSON.stringify({ pid, cwd: `${HOME}/code/x`, ...extra });
test('integration: a permission prompt here is published as waiting and cleared when answered', async ($, on) => {
    resetWaits();
    const clock = mock.clock(on, { now: NOW });
    mock.store(on);
    const files = { [`${HOME}/.claude/sessions/100.json`]: regRow(100, { sessionId: SID, status: 'busy' }) };
    const writes = {};
    host(on, files, writes, [], []);
    on('classic.PermissionRequest', () => ({}));
    let release = () => { };
    on('tool.call', () => new Promise(resolve => {
        release = () => resolve({ result: { stdout: '', stderr: '', interrupted: false } });
    }));
    await $.session.start({ cwd: `${HOME}/code/app`, surface: 'terminal', isInteractive: true });
    await clock.settle();
    const pub = () => JSON.parse(writes[`${HOME}/.claude/hq/sessions/${SID}.json`]);
    expect(pub().waiting).toBe(undefined);
    const call = $.tool.call({ tool: 'Bash', command: 'rm -rf tmp/' });
    await clock.advance(10);
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm -rf tmp/' } });
    await clock.advance(2_000);
    expect(pub().waiting).toEqual({ kind: 'permission', text: 'Bash: rm -rf tmp/', since: NOW + 10 });
    release();
    await call;
    await clock.advance(2_000);
    expect(pub().waiting).toBe(undefined);
});
test('integration: another session waiting is notified once, by name; /hq notify off silences it', async ($, on) => {
    resetWaits();
    const clock = mock.clock(on, { now: NOW });
    mock.store(on);
    const transcript = `${HOME}/.claude/projects/-home-u-code-x/q1.jsonl`;
    const files = {
        [`${HOME}/.claude/sessions/100.json`]: regRow(100, { sessionId: SID, status: 'busy' }),
        [`${HOME}/.claude/sessions/200.json`]: regRow(200, { sessionId: 'p1', name: 'refunds', tmux: 'rp:@2.%2', status: 'busy' }),
        [`${HOME}/.claude/hq/sessions/p1.json`]: JSON.stringify({
            sessionId: 'p1', pid: 200, updatedAt: NOW, agentsRunning: 0, prSummary: { total: 0, broken: 0, waiting: 0, inProgress: 0 },
            waiting: { kind: 'permission', text: 'Bash: rm -rf tmp/', since: NOW - 1_000 },
        }),
        [`${HOME}/.claude/sessions/300.json`]: regRow(300, { sessionId: 'q1', name: 'dates', tmux: 'rp:@3.%3', status: 'busy' }),
        [transcript]: askLine,
    };
    const notes = [];
    host(on, files, {}, [], notes);
    await $.session.start({ cwd: `${HOME}/code/app`, surface: 'terminal', isInteractive: true });
    await clock.settle();
    await clock.advance(2_000);
    await clock.advance(2_000);
    expect(notes.sort((a, b) => a.text.localeCompare(b.text))).toEqual([
        { text: 'dates: Which date library should we use?', title: 'Claude needs you' },
        { text: 'refunds: Bash: rm -rf tmp/', title: 'Claude needs you' },
    ]);
    const said = await $.command.run({ command: 'hq', args: 'notify off' });
    expect(said.text).toBe('hq notifications off.');
    files[`${HOME}/.claude/hq/sessions/p1.json`] = files[`${HOME}/.claude/hq/sessions/p1.json`].replace(`"since":${NOW - 1_000}`, `"since":${NOW + 3_000}`);
    await clock.advance(2_000);
    expect(notes.length).toBe(2);
});
