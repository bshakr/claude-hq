import { expect, mock, test } from 'claude-code/testing';
const HOME = '/home/u';
const SID = 'self-sid';
const NOW = 1_000_000;
function host(on, files, writes, usage) {
    on('session.start', ($, e) => ({ cwd: e.cwd }));
    on('env.get', ($, e) => ({ value: e.name === 'HOME' ? HOME : undefined }));
    on('session.id', () => ({ value: SID }));
    on('session.cwd', () => ({ value: `${HOME}/code/app` }));
    on('session.model', () => ({ value: 'claude-opus-5-5[1m]' }));
    on('session.usage', () => ({ value: usage() }));
    on('agent.list', () => ({ value: [] }));
    on('fs.list', ($, e) => {
        const prefix = `${e.path}/`;
        const names = Object.keys(files).filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'));
        if (names.length === 0)
            throw new Error(`ENOENT ${e.path}`);
        return { value: names.map(p => ({ name: p.slice(prefix.length), kind: 'file', size: files[p].length, mtimeMs: 0, isLink: false })) };
    });
    on('fs.read', ($, e) => {
        if (files[e.path] === undefined)
            throw new Error(`ENOENT ${e.path}`);
        return { value: files[e.path] };
    });
    on('fs.stat', ($, e) => {
        if (files[e.path] === undefined)
            throw new Error(`ENOENT ${e.path}`);
        return { value: { kind: 'file', size: files[e.path].length, mtimeMs: 0, isLink: false } };
    });
    on('fs.write', ($, e) => {
        writes[e.path] = e.text;
        return { value: undefined };
    });
    on('process.run', ($, e) => {
        const argv = [...e.argv];
        const ok = (stdout) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } });
        if (argv[0] === 'ps')
            return ok('100\n200\n300\n');
        if (argv[0] === 'git' && argv[1] === 'branch')
            return ok('main\n');
        if (argv[0] === 'tail') {
            const path = argv[argv.length - 1];
            const from = argv[2]?.startsWith('+') ? Number(argv[2].slice(1)) - 1 : 0;
            return ok((files[path] ?? '').slice(from));
        }
        return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } };
    });
}
const asst = (tokens, ts) => `${JSON.stringify({ type: 'assistant', timestamp: ts, message: { model: 'claude-opus-5-5', stop_reason: 'tool_use', content: [], usage: { input_tokens: 0, cache_read_input_tokens: tokens, cache_creation_input_tokens: 0, output_tokens: 7 } } })}\n`;
function fleet(files) {
    const row = (pid, sessionId, name, w) => JSON.stringify({ pid, sessionId, name, cwd: `${HOME}/code/x`, tmux: `work:${w}.%1`, status: 'idle' });
    files[`${HOME}/.claude/sessions/100.json`] = row(100, SID, 'self', '@1');
    files[`${HOME}/.claude/sessions/200.json`] = row(200, 'w1', 'with-hq', '@2');
    files[`${HOME}/.claude/sessions/300.json`] = row(300, 'w2', 'no-hq', '@3');
    // w1 runs HQ and publishes its live figure; its transcript says otherwise and must lose.
    files[`${HOME}/.claude/hq/sessions/w1.json`] = JSON.stringify({
        sessionId: 'w1', pid: 200, updatedAt: NOW - 1_000, agentsRunning: 0, prSummary: { total: 0, broken: 0, waiting: 0, inProgress: 0 },
        context: { percent: 61, window: 1_000_000, tokens: 610_000, source: 'live' },
    });
    files[`${HOME}/.claude/projects/-home-u-code-x/w1.jsonl`] = asst(20_000, '2026-10-08T10:00:00Z');
    // w2 has no HQ: 150k on a 200k window, as user settings name no 1M model.
    files[`${HOME}/.claude/projects/-home-u-code-x/w2.jsonl`] = asst(90_000, '2026-10-08T10:00:00Z') + asst(150_000, '2026-10-08T10:01:00Z');
    files[`${HOME}/.claude/settings.json`] = '{"model":"sonnet"}';
}
async function drawn($) {
    const ui = await $.ui.mount({
        plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq',
        props: { title: 'hq', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
    });
    const text = JSON.stringify(await ui.drawn());
    await ui.unmount();
    return text;
}
test('integration: this session publishes its live context and plan usage; others prefer a publish, else their transcript', async ($, on) => {
    const clock = mock.clock(on, { now: NOW });
    mock.store(on);
    const files = {};
    const writes = {};
    fleet(files);
    host(on, files, writes, () => ({
        startedAt: 0,
        context: { tokens: 280_000, window: 1_000_000, percent: 28 },
        rateLimits: [{ kind: 'five_hour', percentUsed: 5 }, { kind: 'seven_day', percentUsed: 18 }],
    }));
    await $.session.start({ cwd: `${HOME}/code/app`, surface: 'terminal', isInteractive: true });
    await clock.settle();
    await clock.advance(2_000);
    const mine = JSON.parse(writes[`${HOME}/.claude/hq/sessions/${SID}.json`]);
    expect(mine.context).toEqual({ percent: 28, window: 1_000_000, tokens: 280_000, model: 'claude-opus-5-5[1m]', source: 'live' });
    expect(mine.account).toEqual({ fiveHour: 5, week: 18 });
    const text = await drawn($);
    expect(text.includes('5h 5% · wk 18%') || (text.includes('5h ') && text.includes('wk '))).toBe(true);
    expect(text.includes('28%')).toBe(true);
    expect(text.includes('61%')).toBe(true);
    expect(text.includes('2%')).toBe(false);
    expect(text.includes('75%')).toBe(true);
});
test('integration: without an engine reading, the own card falls back to its transcript and plan usage to a fresh publish', async ($, on) => {
    const clock = mock.clock(on, { now: NOW });
    mock.store(on);
    const files = {};
    const writes = {};
    fleet(files);
    files[`${HOME}/.claude/hq/sessions/w1.json`] = JSON.stringify({
        ...JSON.parse(files[`${HOME}/.claude/hq/sessions/w1.json`]), account: { fiveHour: 55, week: 81 },
    });
    files[`${HOME}/.claude/projects/-home-u-code-app/${SID}.jsonl`] = asst(50_000, '2026-10-08T10:00:00Z');
    host(on, files, writes, () => ({ startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] }));
    await $.session.start({ cwd: `${HOME}/code/app`, surface: 'terminal', isInteractive: true });
    await clock.settle();
    await clock.advance(2_000);
    const mine = JSON.parse(writes[`${HOME}/.claude/hq/sessions/${SID}.json`]);
    // An estimate and a relayed figure are never republished.
    expect('context' in mine).toBe(false);
    expect('account' in mine).toBe(false);
    const text = await drawn($);
    expect(text.includes('25%')).toBe(true);
    expect(text.includes('55%')).toBe(true);
    expect(text.includes('81%')).toBe(true);
});
