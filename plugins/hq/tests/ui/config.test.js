import { expect, test } from 'claude-code/testing';
import { resolveConfig } from '../../hooks/config';
import { layout } from '../../hooks/ui/layout';
import { drawPane } from '../../hooks/ui/pane';
import { BUSY } from './fixtures';
const MOCHA = { colorBroken: '#f38ba8', colorWaiting: '#f9e2af', colorWorking: '#89b4fa', colorDone: '#a6e3a1', colorAccent: '#94e2d5', colorDim: '#6c7086' };
const props = (isFocused) => ({ title: 'hq', isFocused, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} });
function host(on) {
    const h = { opens: [], store: new Map() };
    on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }));
    on('session.start', ($, e) => ({ cwd: e.cwd }));
    on('command.register', ($, e) => ({ value: { command: e.name } }));
    on('ui.panes', () => ({ value: [] }));
    on('ui.open', ($, e) => {
        h.opens.push(e.id);
        return { value: { isPlaced: true } };
    });
    on('store.get', ($, e) => ({ value: h.store.get(e.key) }));
    on('store.set', ($, e) => {
        h.store.set(e.key, e.value);
        return { value: undefined };
    });
    return h;
}
test('the engine accepts hex tokens on every coloured element, the dimmed running dot included', async ($, on) => {
    const tokens = resolveConfig(MOCHA).tokens;
    on('ui.render', { component: 'Pane', requestId: 'probe' }, ($, e) => {
        const l = layout(BUSY, { width: 80, rows: 58, focused: true, cursor: null, expanded: [], scroll: 0, phase: 1 });
        return drawPane(l.rows, { el: $.ui.resolve(e), tokens, onAction: () => undefined });
    });
    for (const surface of ['terminal', 'desktop']) {
        const ui = await $.ui.mount({ plugin: 'hq', surface, component: 'Pane', requestId: 'probe', props: props(true) });
        const json = JSON.stringify(await ui.drawn());
        expect(json.includes('ansi256(')).toBe(false);
        expect(/"color":"#89b4fa","dimColor":true/.test(json)).toBe(true);
        for (const hex of ['#f38ba8', '#f9e2af', '#94e2d5'])
            expect(json.includes(`"color":"${hex}"`)).toBe(true);
        await ui.unmount();
    }
});
test('the plugin paints with its configured colours and shows a bad one as a dim footer line', { options: { colorAccent: '#94e2d5', colorDone: 'mauve' } }, async ($, on) => {
    host(on);
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
    const ui = await $.ui.mount({ plugin: 'hq', surface: 'terminal', component: 'Pane', requestId: 'hq', props: props(true) });
    const json = JSON.stringify(await ui.drawn());
    expect(json.includes('"color":"#94e2d5"')).toBe(true);
    expect(json.includes('hq: ignored colour done (use #rrggbb, ansi256(N) or N)')).toBe(true);
    await ui.unmount();
});
test('autoOpen: the pane opens by itself once per session, never again on a second start', async ($, on) => {
    const h = host(on);
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
    expect(h.opens).toEqual(['hq']);
});
test('autoOpen off: the pane waits for /hq', { options: { autoOpen: false } }, async ($, on) => {
    const h = host(on);
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
    expect(h.opens).toEqual([]);
    await $.command.run({ command: 'hq', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } });
    expect(h.opens).toEqual(['hq']);
});
test('a -p run never opens the pane', async ($, on) => {
    const h = host(on);
    await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false });
    expect(h.opens).toEqual([]);
});
test('/hq summaries shows the config default, then on|off persists and wins over it', { options: { summaries: false } }, async ($, on) => {
    const h = host(on);
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
    const cmd = (args) => $.command.run({ command: 'hq', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } });
    expect(await cmd('summaries')).toMatchObject({ text: 'hq summaries are off.' });
    expect(await cmd('summaries on')).toMatchObject({ text: 'hq summaries on.' });
    expect(h.store.get('summaries')).toBe(true);
    expect(await cmd('summaries')).toMatchObject({ text: 'hq summaries are on.' });
    expect(await cmd('notify')).toMatchObject({ text: 'hq notifications are on.' });
});
test('/hq notify shows the config default when nothing is stored', { options: { notify: false } }, async ($, on) => {
    host(on);
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
    expect(await $.command.run({ command: 'hq', args: 'notify', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })).toMatchObject({ text: 'hq notifications are off.' });
});
