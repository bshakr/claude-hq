import { expect, test } from 'claude-code/testing';
import { runJump } from '../../hooks/ui/jump';
import { layout } from '../../hooks/ui/layout';
import { drawPane } from '../../hooks/ui/pane';
import { BUSY, EMPTY, LONG, QUIET } from './fixtures';
const PROBE = 'hq-probe';
const props = (bodyColumns, bodyRows, isFocused = false) => ({
    title: 'hq', isFocused, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows }, view: {},
});
function probe(on, p) {
    on('ui.render', { component: 'Pane', requestId: PROBE }, ($, e) => draw($, e, p));
}
function draw($, e, p) {
    const l = layout(p.model, {
        width: e.props.bodyColumns, rows: e.props.scroll.bodyRows, focused: e.props.isFocused,
        cursor: p.cursor, expanded: p.expanded, scroll: 0, phase: 0,
    });
    p.last = l;
    return drawPane(l.rows, { el: $.ui.resolve(e), autoFocusKey: l.items[0], onAction: () => undefined });
}
test('the engine validates every state on terminal and desktop, with no background', async ($, on) => {
    const p = { model: BUSY, cursor: null, expanded: [] };
    probe(on, p);
    for (const surface of ['terminal', 'desktop']) {
        for (const [model, w, r, focused] of [
            [BUSY, 80, 58, false], [BUSY, 72, 58, true], [QUIET, 88, 58, true], [LONG, 80, 34, false], [EMPTY, 60, 20, true], [BUSY, 40, 10, true],
        ]) {
            p.model = model;
            p.expanded = ['a3', 'a1'];
            const ui = await $.ui.mount({ plugin: 'hq', surface, component: 'Pane', requestId: PROBE, props: props(w, r, focused) });
            const drawn = await ui.drawn();
            expect(drawn).toMatchObject({ type: 'Box' });
            expect(JSON.stringify(drawn).includes('backgroundColor')).toBe(false);
            const buttons = await ui.findAll({ type: 'Button' });
            const visible = p.last.items.filter(k => p.last.rows.some(row => row.head && row.item === k));
            for (const key of visible)
                expect(buttons.some(b => b.props.key === key || b.key === key)).toBe(true);
            if (focused)
                expect(buttons.filter(b => b.props.hotkey !== undefined).map(b => b.props.hotkey)).toEqual(['j', 'k']);
            await ui.unmount();
        }
    }
});
const run = (ran) => (_$, e) => {
    ran.push([...e.argv]);
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } };
};
test('a jump runs only its own commands: tmux switch then pane select, or open for a web URL', async () => {
    const l = layout(BUSY, { width: 80, rows: 58, focused: true, cursor: null, expanded: [], scroll: 0, phase: 0 });
    const jumpOf = (key) => {
        const a = l.actions[key];
        if (a?.kind !== 'jump')
            throw new Error(`${key} is not a jump`);
        return a.jump;
    };
    const ran = [];
    const ok = async (argv) => {
        ran.push(argv);
        return { exitCode: 0, stderr: '' };
    };
    expect(await runJump(jumpOf('flare'), ok)).toBe(undefined);
    expect(ran).toEqual([
        ['tmux', 'switch-client', '-t', 'ritualpass:@3.%6'],
        ['tmux', 'select-pane', '-t', '%6'],
    ]);
    ran.length = 0;
    await runJump(jumpOf('p:bshakr/monolense#212'), ok);
    expect(ran).toEqual([['open', 'https://github.com/bshakr/monolense/pull/212']]);
    ran.length = 0;
    await runJump(jumpOf('s:s-rp-admin'), ok);
    expect(ran[0]).toEqual(['tmux', 'switch-client', '-t', 'ritualpass:@4.%13']);
    // Agents expand and j/k move: none of them is a jump.
    for (const key of ['a:a3', 'j', 'k'])
        expect(l.actions[key]?.kind === 'jump').toBe(false);
    ran.length = 0;
    expect(await runJump({ kind: 'url', url: 'file:///etc/passwd' }, ok)).toBe('nothing to open for file:///etc/passwd');
    expect(ran).toEqual([]);
    // A failed switch stops before the pane select.
    const fails = async (argv) => {
        ran.push(argv);
        return { exitCode: 1, stderr: "can't find session: ritualpass" };
    };
    expect(await runJump(jumpOf('flare'), fails)).toBe("tmux switch-client failed: can't find session: ritualpass");
    expect(ran.length).toBe(1);
});
test('the plugin itself: /hq opens the pane, j and k are Buttons with hotkeys, pressing them runs nothing', async ($, on) => {
    const ran = [];
    on('process.run', run(ran));
    on('session.start', ($, e) => ({ cwd: e.cwd }));
    on('command.register', ($, e) => ({ value: { command: e.name } }));
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
    const before = ran.length;
    for (const surface of ['terminal', 'desktop']) {
        const ui = await $.ui.mount({ plugin: 'hq', surface, component: 'Pane', requestId: 'hq', props: props(80, 30, true) });
        const hot = (await ui.findAll({ type: 'Button' })).filter(b => b.props.hotkey !== undefined);
        expect(hot.map(b => b.props.hotkey)).toEqual(['j', 'k']);
        await ui.press({ key: 'j' });
        await ui.press({ key: 'k' });
        const text = JSON.stringify(await ui.drawn());
        expect(text.includes('this session')).toBe(true);
        expect(text.includes('backgroundColor')).toBe(false);
        await ui.unmount();
    }
    expect(ran.slice(before).filter(a => a[0] === 'tmux' || a[0] === 'open')).toEqual([]);
});
