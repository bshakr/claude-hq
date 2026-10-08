import { expect, mock, test } from 'claude-code/testing';
import * as SUB from './subagent-fixtures';
const HOME = '/home/u';
const SID = 'self-sid';
function fakeHost(on, fx) {
    on('session.start', ($, e) => ({ cwd: e.cwd }));
    on('env.get', ($, e) => ({ value: e.name === 'HOME' ? HOME : undefined }));
    on('session.id', () => ({ value: fx.sid }));
    on('session.cwd', () => ({ value: `${HOME}/code/app` }));
    on('agent.list', () => ({ value: [] }));
    on('fs.list', ($, e) => {
        const prefix = `${e.path}/`;
        const names = Object.keys(fx.files).filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'));
        if (names.length === 0)
            throw new Error(`ENOENT ${e.path}`);
        return { value: names.map(p => ({ name: p.slice(prefix.length), kind: 'file', size: fx.files[p].length, mtimeMs: fx.mtimes[p] ?? 0, isLink: false })) };
    });
    on('fs.read', ($, e) => {
        const text = fx.files[e.path];
        if (text === undefined)
            throw new Error(`ENOENT ${e.path}`);
        return { value: text };
    });
    on('fs.stat', ($, e) => {
        const text = fx.files[e.path];
        if (text === undefined)
            throw new Error(`ENOENT ${e.path}`);
        return { value: { kind: 'file', size: text.length, mtimeMs: fx.mtimes[e.path] ?? 0, isLink: false } };
    });
    on('fs.write', ($, e) => {
        fx.writes[e.path] = e.text;
        return { value: undefined };
    });
    on('process.run', ($, e) => {
        const argv = [...e.argv];
        const ok = (stdout) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } });
        if (argv[0] === 'ps') {
            fx.ps++;
            const asked = argv[argv.length - 1].split(',').map(Number);
            return ok(asked.filter(p => fx.alive.includes(p)).map(p => `${p}\n`).join(''));
        }
        if (argv[0] === 'git' && argv[1] === 'remote')
            return ok('git@github.com:acme/app.git\n');
        if (argv[0] === 'git' && argv[1] === 'branch')
            return ok(`${fx.branch}\n`);
        if (argv[0] === 'gh' && argv[1] === 'api') {
            fx.gh.push(argv);
            return ok(JSON.stringify({ data: { repository: { p270: { state: 'MERGED', title: 'BLO-1940 evaluation report', headRefName: 'BLO-1940-x' }, p271: { state: 'OPEN', title: 'BLO-1941 kind stage', headRefName: 'BLO-1941-y' } } } }));
        }
        if (argv[0] === 'gh') {
            fx.gh.push(argv);
            if (argv[2] === 'list') {
                const n = fx.heads[argv[argv.indexOf('--head') + 1]];
                return ok(JSON.stringify(n ? [{ number: n, title: `PR ${n}`, url: `https://github.com/acme/app/pull/${n}`, state: 'OPEN' }] : []));
            }
            const n = Number(argv[3]);
            return ok(JSON.stringify({ title: `PR ${n}`, url: `https://github.com/acme/app/pull/${n}`, state: fx.states[n] ?? 'OPEN' }));
        }
        if (argv[0] === 'tail') {
            const path = argv[argv.length - 1];
            fx.tails.push(path);
            const from = argv[2]?.startsWith('+') ? Number(argv[2].slice(1)) - 1 : 0;
            return ok((fx.files[path] ?? '').slice(from));
        }
        if (argv[0] === 'linear') {
            fx.ran.push(argv);
            const t = fx.linear[argv[3]];
            if (t === 'hang')
                return new Promise(() => { });
            return t ? ok(`# ${argv[3]}: ${t}\n\nbody\n`) : { value: { exitCode: 1, stdout: '', stderr: 'not found', isStdoutTruncated: false, isStderrTruncated: false } };
        }
        if (argv[0] === 'rm') {
            fx.ran.push(argv);
            return ok('');
        }
        return { value: { exitCode: 1, stdout: '', stderr: 'unexpected', isStdoutTruncated: false, isStderrTruncated: false } };
    });
    on('tool.call', ($, e) => {
        const out = fx.bash[String(e.command)] ?? {};
        return { result: { stdout: out.stdout ?? '', stderr: out.stderr ?? '', interrupted: false } };
    });
}
function fakeStore(on, map) {
    on('store.get', ($, e) => ({ value: map.get(e.key) }));
    on('store.set', ($, e) => {
        map.set(e.key, JSON.parse(JSON.stringify(e.value)));
        return { value: undefined };
    });
}
function registry(fx) {
    const row = (pid, extra) => JSON.stringify({ pid, cwd: `${HOME}/code/x`, ...extra });
    fx.files[`${HOME}/.claude/sessions/100.json`] = row(100, { sessionId: SID, tmux: 'work:@1.%1', status: 'busy' });
    fx.files[`${HOME}/.claude/sessions/100.abc.key`] = 'k';
    fx.files[`${HOME}/.claude/sessions/200.json`] = row(200, { sessionId: 'w1', name: 'rp-api', tmux: 'ritualpass:@3.%6', status: 'waiting', waitingFor: 'input needed', statusUpdatedAt: 1_000_000 - 120_000 });
    fx.files[`${HOME}/.claude/sessions/300.json`] = row(300, { sessionId: 'dead', name: 'gone', tmux: 'ritualpass:@9.%9', status: 'waiting', statusUpdatedAt: 1 });
    fx.files[`${HOME}/.claude/sessions/400.json`] = row(400, { sessionId: 'b1', name: 'rp-admin', tmux: 'ritualpass:@4.%2', status: 'busy', statusUpdatedAt: 1_000_000 - 60_000 });
    fx.files[`${HOME}/.claude/hq/sessions/b1.json`] = JSON.stringify({ sessionId: 'b1', pid: 400, updatedAt: 1_000_000 - 1_000, agentsRunning: 3, prSummary: { total: 2, broken: 1, waiting: 0, inProgress: 1 } });
    fx.alive.push(100, 200, 400);
}
const newFake = () => ({
    files: {}, alive: [], gh: [], ps: 0, writes: {}, sid: SID, branch: 'main', heads: {}, states: {}, bash: {}, ran: [], mtimes: {}, tails: [], linear: {},
});
const pubOf = (fx, sid = SID) => JSON.parse(fx.writes[`${HOME}/.claude/hq/sessions/${sid}.json`]);
test('integration: publishes this session from its own registry row, one ps per tick', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 });
    mock.store(on);
    const fx = newFake();
    registry(fx);
    fakeHost(on, fx);
    await $.session.start({ cwd: `${HOME}/code/app`, surface: 'terminal', isInteractive: true });
    await clock.settle();
    const published = pubOf(fx);
    expect(Object.keys(published).sort()).toEqual(['agents', 'agentsRunning', 'owned', 'pid', 'prSummary', 'sessionId', 'updatedAt']);
    expect(published).toEqual({
        sessionId: SID, pid: 100, updatedAt: 1_000_000, agentsRunning: 0,
        prSummary: { total: 0, broken: 0, waiting: 0, inProgress: 0 }, agents: [], owned: [],
    });
    expect(fx.ps).toBe(1);
    // on main: no branch to own, no GitHub call
    expect(fx.gh).toEqual([]);
});
test('integration: viewing or waiting on a PR does not own it; creating one does', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 });
    const store = new Map();
    fakeStore(on, store);
    const fx = newFake();
    registry(fx);
    fakeHost(on, fx);
    fx.bash['gh pr create --fill'] = { stdout: 'https://github.com/acme/app/pull/77\n' };
    await $.session.start({ cwd: `${HOME}/code/app`, surface: 'terminal', isInteractive: true });
    await clock.settle();
    await $.tool.call({ tool: 'Bash', command: 'gh pr view 12' });
    await $.tool.call({ tool: 'Bash', command: 'pr-ci-wait 12 --repo acme/app' });
    await $.tool.call({ tool: 'Bash', command: 'gh pr checks 13 -R acme/app' });
    await clock.advance(5_000);
    expect(pubOf(fx).owned).toEqual([]);
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' });
    await clock.advance(5_000);
    expect(pubOf(fx).owned).toEqual([{ repo: 'acme/app', number: 77 }]);
    const owned = store.get(`owned:${SID}`);
    expect(owned.claims.map(c => [c.number, c.reason])).toEqual([[77, 'created']]);
});
test('integration: ownership kept in the store comes back on a cold start', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 });
    const store = new Map();
    store.set(`owned:${SID}`, { claims: [{ repo: 'acme/app', number: 40, claimedBy: 'main', claimedAt: 1, reason: 'created' }], branches: [] });
    fakeStore(on, store);
    const fx = newFake();
    registry(fx);
    fakeHost(on, fx);
    await $.session.start({ cwd: `${HOME}/code/app`, surface: 'terminal', isInteractive: true });
    await clock.settle();
    expect(pubOf(fx).owned).toEqual([{ repo: 'acme/app', number: 40 }]);
});
test('integration: a pushed branch owns its open PR once GitHub has one', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 });
    mock.store(on);
    const fx = newFake();
    registry(fx);
    fakeHost(on, fx);
    const push = 'git push -u origin feat-x';
    fx.bash[push] = { stderr: 'To github.com:acme/app.git\n * [new branch]      feat-x -> feat-x\n' };
    await $.session.start({ cwd: `${HOME}/code/app`, surface: 'terminal', isInteractive: true });
    await clock.settle();
    await $.tool.call({ tool: 'Bash', command: push });
    await clock.advance(2_000);
    expect(fx.gh.filter(a => a[2] === 'list').length).toBe(1);
    expect(pubOf(fx).owned).toEqual([]);
    fx.heads['feat-x'] = 31;
    await clock.advance(60_000);
    expect(fx.gh.filter(a => a[2] === 'list').length).toBe(1);
    await clock.advance(60_000);
    await clock.advance(5_000);
    expect(pubOf(fx).owned).toEqual([{ repo: 'acme/app', number: 31 }]);
});
test('integration: the branch checked out in the session cwd owns its PR; an unwatched PR is re-read until it merges', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 });
    const store = new Map();
    fakeStore(on, store);
    const fx = newFake();
    fx.branch = 'BLO-1940';
    fx.heads['BLO-1940'] = 275;
    registry(fx);
    fakeHost(on, fx);
    await $.session.start({ cwd: `${HOME}/code/app`, surface: 'terminal', isInteractive: true });
    await clock.settle();
    expect(fx.gh).toEqual([
        ['gh', 'pr', 'list', '-R', 'acme/app', '--head', 'BLO-1940', '--state', 'open', '--json', 'number,title,url,state', '--limit', '1'],
    ]);
    expect(pubOf(fx).owned).toEqual([{ repo: 'acme/app', number: 275 }]);
    expect(pubOf(fx).prSummary).toEqual({ total: 1, broken: 0, waiting: 1, inProgress: 0 });
    // No watcher file: GitHub is re-read every 2 minutes, and the merge is seen.
    fx.states[275] = 'MERGED';
    await clock.advance(60_000);
    expect(fx.gh.length).toBe(1);
    await clock.advance(62_000);
    expect(fx.gh.at(-1)).toEqual(['gh', 'pr', 'view', '275', '-R', 'acme/app', '--json', 'title,url,state']);
    await clock.advance(5_000);
    expect(pubOf(fx).prSummary).toEqual({ total: 0, broken: 0, waiting: 0, inProgress: 0 });
    const stored = store.get(`owned:${SID}`);
    expect(stored.claims.map(c => [c.number, c.ghState, c.endedAt !== undefined])).toEqual([[275, 'MERGED', true]]);
    // Ended: never re-read.
    const calls = fx.gh.length;
    await clock.advance(300_000);
    expect(fx.gh.length).toBe(calls);
});
test('integration: after /clear the new session id is published, the old file removed, and self is not an other session', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 });
    mock.store(on);
    const fx = newFake();
    registry(fx);
    fakeHost(on, fx);
    await $.session.start({ cwd: `${HOME}/code/app`, surface: 'terminal', isInteractive: true });
    await clock.settle();
    expect(pubOf(fx).pid).toBe(100);
    fx.sid = 'after-clear';
    fx.files[`${HOME}/.claude/sessions/100.json`] = JSON.stringify({ pid: 100, sessionId: 'after-clear', cwd: `${HOME}/code/x`, tmux: 'work:@1.%1', status: 'busy', name: 'home-b9' });
    await clock.advance(2_000);
    expect(pubOf(fx, 'after-clear')).toMatchObject({ sessionId: 'after-clear', pid: 100 });
    expect(fx.ran).toEqual([['rm', '-f', `${HOME}/.claude/hq/sessions/${SID}.json`]]);
});
test('integration: a session without HQ shows its running subagents from their transcripts, each tailed once while unchanged', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 });
    mock.store(on);
    const fx = newFake();
    registry(fx);
    fakeHost(on, fx);
    const dir = `${HOME}/.claude/projects/-home-u-code-x/w1/subagents`;
    const put = (name, text, mtime) => {
        fx.files[`${dir}/${name}`] = text;
        fx.mtimes[`${dir}/${name}`] = mtime;
    };
    put('agent-run1.meta.json', SUB.meta('Implement BLO-1941 card pairing guard', 'opus'), 1_000_000 - 12 * 60_000);
    put('agent-run1.jsonl', SUB.running, 1_000_000 - 5_000);
    put('agent-done1.meta.json', SUB.meta('Review PR a', 'opus'), 1_000_000 - 30 * 60_000);
    put('agent-done1.jsonl', SUB.handedBack, 1_000_000 - 10_000);
    put('agent-old1.meta.json', SUB.meta('Old work', 'sonnet'), 1_000_000 - 90 * 60_000);
    put('agent-old1.jsonl', SUB.running, 1_000_000 - 10 * 60_000);
    await $.session.start({ cwd: `${HOME}/code/app`, surface: 'terminal', isInteractive: true });
    await clock.settle();
    const pane = async () => {
        const ui = await $.ui.mount({
            plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq',
            props: { title: 'hq', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
        });
        const text = JSON.stringify(await ui.drawn());
        await ui.unmount();
        return text;
    };
    const drawn = await pane();
    expect(drawn.includes('Implement BLO-1941 card pairing guard')).toBe(true);
    expect(drawn.includes('Run ledger specs')).toBe(true);
    expect(drawn.includes('opus · 12m')).toBe(true);
    expect(drawn.includes('Review PR a')).toBe(false);
    expect(drawn.includes('Old work')).toBe(false);
    // b1 publishes a count without a list: the count stays.
    expect(drawn.includes('3 agents')).toBe(true);
    // The stale transcript is tailed once, to see whether it sits inside a call; then each only when it changes.
    expect([...fx.tails].sort()).toEqual([`${dir}/agent-done1.jsonl`, `${dir}/agent-old1.jsonl`, `${dir}/agent-run1.jsonl`]);
    await clock.advance(2_000);
    expect(fx.tails.length).toBe(3);
    // A transcript past 2 h is a candidate only while its session is busy; it is tailed once across the flips.
    put('agent-ancient.jsonl', SUB.running, 1_000_000 - 3 * 60 * 60_000);
    const w1 = `${HOME}/.claude/sessions/200.json`;
    const status = (st) => { fx.files[w1] = fx.files[w1].replace(/"status":"\w+"/, `"status":"${st}"`); };
    status('busy');
    await clock.advance(2_000);
    expect(fx.tails.length).toBe(4);
    status('waiting');
    await clock.advance(2_000);
    status('busy');
    await clock.advance(2_000);
    expect(fx.tails.length).toBe(4);
    status('waiting');
    fx.files[`${dir}/agent-run1.jsonl`] = SUB.running + SUB.endTurn;
    fx.mtimes[`${dir}/agent-run1.jsonl`] = 1_000_000 + 1_000;
    await clock.advance(2_000);
    expect(fx.tails.length).toBe(5);
    expect((await pane()).includes('Implement BLO-1941 card pairing guard')).toBe(false);
});
test('integration: another session\'s agent inside one long call stays listed as waiting, however old its file', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 });
    mock.store(on);
    const fx = newFake();
    registry(fx);
    fakeHost(on, fx);
    const dir = `${HOME}/.claude/projects/-home-u-code-x/w1/subagents`;
    const started = 1_000_000 - 7 * 60_000;
    fx.files[`${dir}/agent-ci1.meta.json`] = SUB.meta('Watch CI for #275', 'sonnet');
    fx.mtimes[`${dir}/agent-ci1.meta.json`] = 1_000_000 - 20 * 60_000;
    fx.files[`${dir}/agent-ci1.jsonl`] = SUB.running + SUB.openCall(started);
    fx.mtimes[`${dir}/agent-ci1.jsonl`] = started;
    await $.session.start({ cwd: `${HOME}/code/app`, surface: 'terminal', isInteractive: true });
    await clock.settle();
    const ui = await $.ui.mount({
        plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq',
        props: { title: 'hq', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
    });
    const drawn = JSON.stringify(await ui.drawn());
    await ui.unmount();
    expect(drawn.includes('Watch CI for #275')).toBe(true);
    expect(drawn.includes('waiting · Wait for CI on #275 · 7m')).toBe(true);
    expect(drawn.includes('◷')).toBe(true);
});
test('integration: a tick writes the store only when a value changed', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 });
    const store = new Map();
    let sets = 0;
    on('store.get', ($, e) => ({ value: store.get(e.key) }));
    on('store.set', ($, e) => {
        sets++;
        store.set(e.key, JSON.parse(JSON.stringify(e.value)));
        return { value: undefined };
    });
    const fx = newFake();
    registry(fx);
    fakeHost(on, fx);
    await $.session.start({ cwd: `${HOME}/code/app`, surface: 'terminal', isInteractive: true });
    await clock.settle();
    await $.tool.call({ tool: 'Bash', command: 'ls' });
    await clock.advance(2_000);
    const after = sets;
    for (let i = 0; i < 5; i++) {
        await $.tool.call({ tool: 'Bash', command: 'ls' });
        await clock.advance(2_000);
    }
    expect(sets).toBe(after);
    fx.bash['gh pr create --fill'] = { stdout: 'https://github.com/acme/app/pull/77\n' };
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' });
    await clock.advance(2_000);
    expect(sets).toBe(after + 1);
});
test('integration: a branch with no PR is looked up after 2, 10, then 30 minutes; a push resets it', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 });
    mock.store(on);
    const fx = newFake();
    registry(fx);
    fakeHost(on, fx);
    fx.branch = 'feat-y';
    await $.session.start({ cwd: `${HOME}/code/app`, surface: 'terminal', isInteractive: true });
    await clock.settle();
    const lists = () => fx.gh.filter(a => a[2] === 'list').length;
    expect(lists()).toBe(1);
    await clock.advance(120_000);
    expect(lists()).toBe(2);
    await clock.advance(540_000);
    expect(lists()).toBe(2);
    await clock.advance(62_000);
    expect(lists()).toBe(3);
    await clock.advance(1_740_000);
    expect(lists()).toBe(3);
    await clock.advance(62_000);
    expect(lists()).toBe(4);
    await clock.advance(1_800_000);
    expect(lists()).toBe(5);
    const push = 'git push origin feat-y';
    fx.bash[push] = { stderr: 'To github.com:acme/app.git\n   abc..def  feat-y -> feat-y\n' };
    await $.tool.call({ tool: 'Bash', command: push });
    await clock.advance(2_000);
    expect(lists()).toBe(6);
    await clock.advance(120_000);
    expect(lists()).toBe(7);
});
test('integration: another session card carries its goal, day and PR counts; the model is asked once, again only after 5 new prompts', async ($, on) => {
    const clock = mock.clock(on, { now: Date.parse('2026-10-08T12:00:00Z') });
    const store = new Map();
    fakeStore(on, store);
    const fx = newFake();
    registry(fx);
    fakeHost(on, fx);
    const asked = [];
    on('model.complete', ($, e) => {
        asked.push(e.prompt);
        return { value: { isAnswered: true, text: '{"goal":"Pipeline v2 rearchitecture","step":"stage 4 of 7: kind stage"}', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } };
    });
    const path = `${HOME}/.claude/projects/-home-u-code-x/w1.jsonl`;
    const line = (v) => `${JSON.stringify(v)}\n`;
    const prompt = (t, ts) => line({ type: 'user', message: { content: t }, timestamp: ts });
    fx.files[path] = [
        prompt('Rebuild the pipeline as v2', '2026-10-06T09:00:00Z'),
        line({ type: 'ai-title', aiTitle: '269 merged whats next' }),
        line({ type: 'pr-link', prNumber: 270, prUrl: 'https://github.com/acme/app/pull/270', prRepository: 'acme/app', timestamp: '2026-10-07T09:00:00Z' }),
        line({ type: 'pr-link', prNumber: 271, prUrl: 'https://github.com/acme/app/pull/271', prRepository: 'acme/app', timestamp: '2026-10-08T09:00:00Z' }),
        line({ type: 'pr-link', prNumber: 271, prUrl: 'https://github.com/acme/app/pull/271', prRepository: 'acme/app', timestamp: '2026-10-08T09:01:00Z' }),
    ].join('');
    await $.session.start({ cwd: `${HOME}/code/app`, surface: 'terminal', isInteractive: true });
    await clock.settle();
    await clock.advance(2_000);
    await clock.advance(2_000);
    const pane = async () => {
        const ui = await $.ui.mount({
            plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq',
            props: { title: 'hq', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
        });
        const text = JSON.stringify(await ui.drawn());
        await ui.unmount();
        return text;
    };
    const drawn = await pane();
    expect(asked.length).toBe(1);
    expect(asked[0].includes('Rebuild the pipeline as v2')).toBe(true);
    expect(drawn.includes('Pipeline v2 rearchitecture')).toBe(true);
    expect(drawn.includes('day 3')).toBe(true);
    expect(drawn.includes('stage 4 of 7: kind stage · 1 PR merged, 1 open')).toBe(true);
    expect(fx.gh.filter(a => a[1] === 'api').length).toBe(1);
    expect(store.get('goal:w1').goal).toBe('Pipeline v2 rearchitecture');
    // Idle and unchanged for an hour: no call. Four new prompts: none. The fifth: one.
    await clock.advance(60 * 60_000);
    expect(asked.length).toBe(1);
    for (let i = 1; i <= 4; i++)
        fx.files[path] += prompt(`next ${i}`, `2026-10-08T13:0${i}:00Z`);
    await clock.advance(2_000);
    expect(asked.length).toBe(1);
    fx.files[path] += prompt('next 5', '2026-10-08T13:05:00Z');
    await clock.advance(2_000);
    await clock.advance(2_000);
    expect(asked.length).toBe(2);
    // Only the appended bytes were read after the first pass.
    expect(fx.tails.filter(p => p === path).length).toBeGreaterThan(1);
});
test('integration: ids on a card are glossed from linear and the repo\'s ADRs; a hung lookup never stalls the tick', async ($, on) => {
    const clock = mock.clock(on, { now: Date.parse('2026-10-08T12:00:00Z') });
    const store = new Map();
    fakeStore(on, store);
    const fx = newFake();
    registry(fx);
    fakeHost(on, fx);
    fx.linear = { 'BLO-1936': 'Raw bank import: keep every statement line', 'BLO-1947': 'hang' };
    fx.files[`${HOME}/code/x/docs/adr/0019-append-only-raw-bank-data.md`] = '# Raw bank data is append-only\n';
    const asked = [];
    on('model.complete', ($, e) => {
        asked.push({ system: e.system ?? '', prompt: e.prompt });
        const text = (e.system ?? '').includes('shorten titles')
            ? JSON.stringify(Object.fromEntries(e.prompt.split('\n').map(l => [l.split(':')[0], l.includes('Raw bank import') ? 'raw bank import' : 'append-only bank data'])))
            : '{"goal":"Finish ADR 0019 epic BLO-1936 work","step":"Fix batch BLO-1947 in review"}';
        return { value: { isAnswered: true, text, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } };
    });
    const path = `${HOME}/.claude/projects/-home-u-code-x/w1.jsonl`;
    fx.files[path] = `${JSON.stringify({ type: 'user', message: { content: 'Finish ADR 0019 epic BLO-1936 work, then BLO-1947' }, timestamp: '2026-10-08T09:00:00Z' })}\n`;
    await $.session.start({ cwd: `${HOME}/code/app`, surface: 'terminal', isInteractive: true });
    await clock.settle();
    // BLO-1947 never answers: the goal waits ID_WAIT_MS for it, then goes ahead with what resolved.
    for (let i = 0; i < 4; i++)
        await clock.advance(2_000);
    expect(asked.filter(a => !a.system.includes('shorten titles')).length).toBe(0);
    for (let i = 0; i < 10; i++)
        await clock.advance(2_000);
    const pane = async () => {
        const ui = await $.ui.mount({
            plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq',
            props: { title: 'hq', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
        });
        const text = JSON.stringify(await ui.drawn());
        await ui.unmount();
        return text;
    };
    const drawn = await pane();
    expect(drawn.includes('Finish ADR 0019 (append-only bank data) epic BLO-1936 (raw bank import) work')).toBe(true);
    // BLO-1947 still hangs: bare, and asked once only.
    expect(drawn.includes('Fix batch BLO-1947 in review')).toBe(true);
    expect(fx.ran.filter(a => a[0] === 'linear' && a[3] === 'BLO-1947').length).toBe(1);
    expect(fx.ran.filter(a => a[0] === 'linear' && a[3] === 'BLO-1936').length).toBe(1);
    // The goal waited for the titles it could get, then saw them; one brief call covered both.
    const goals = asked.filter(a => !a.system.includes('shorten titles'));
    expect(goals.length).toBe(1);
    expect(goals[0].prompt.includes('BLO-1936: Raw bank import: keep every statement line')).toBe(true);
    expect(asked.filter(a => a.system.includes('shorten titles')).length).toBe(1);
    expect(store.get('gloss:BLO-1936').brief).toBe('raw bank import');
    expect(store.get(`gloss:adr:${HOME}/code/x:0019`).title).toBe('Raw bank data is append-only');
});
