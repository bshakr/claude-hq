import { atom, read, update } from 'claude-code';
import { SUMMARIES_KEY, config, effective, resolveConfig, setConfig } from './config';
import { currentModel, installData } from './data/index';
import { NOTIFY_STORE_KEY, parseNotifyArg } from './data/notify';
import { WAKE_KEY, parseWake } from './data/wake';
import { pressJump } from './ui/jump';
import { layout, scrollFor } from './ui/layout';
import { drawPane } from './ui/pane';
export const PANE = 'hq';
const COMMAND = 'hq';
export const IDLE_REDRAW_MS = 30_000;
const rev = atom({ plugin: 'hq', key: 'rev' }, 0);
const cursor = atom({ plugin: 'hq', key: 'cursor' }, null);
const expanded = atom({ plugin: 'hq', key: 'expanded' }, []);
const scroll = atom({ plugin: 'hq', key: 'scroll' }, 0);
const phase = atom({ plugin: 'hq', key: 'phase' }, 0);
const autoOpened = atom({ plugin: 'hq', key: 'autoOpened' }, false);
const HELP = [
    '/hq          open the pane (⌃g moves the keys between it and the prompt)',
    '/hq close    close the pane',
    '/hq wake on  wake this session on its own PRs going red, merging, conflicting or behind (default)',
    '/hq wake off toasts only, never start a turn',
    '/hq notify on|off   a notification when another session starts waiting on you',
    '/hq summaries on|off  Haiku goal lines and id glosses on cards',
    '  wake, notify and summaries default to the plugin config; a toggle here overrides it on this machine.',
    '/hq help     this list',
    '',
    'In the pane: j/k or Tab move, Enter or a click opens a PR or brings a session forward,',
    'Enter on an agent expands it, on +N finished shows the rest. Esc returns the keys to the prompt.',
].join('\n');
/** Motion only while something visibly runs: the session's own turn, a running agent, checks in progress, a busy session. */
export function hasMotion(m) {
    return ((m.current.now !== undefined && !m.current.now.idle) ||
        (m.current.waiting?.length ?? 0) > 0 ||
        m.current.agents.some(a => a.status === 'running') ||
        m.current.prs.some(p => p.ci.kind === 'running' && p.ci.done < p.ci.total) ||
        m.others.some(g => g.sessions.some(s => s.status === 'busy')));
}
// Module state: a hot reload starts it afresh; session.start re-reads whether the pane is up.
let refresh;
let syncMotion;
let last;
let isPaneOpen = false;
async function startPane($, isInteractive) {
    let motion;
    let slow;
    syncMotion = async () => {
        const m = currentModel();
        const want = isPaneOpen && hasMotion(m);
        if (want && motion === undefined)
            motion = $.clock.every(2000, () => void update($, phase, n => n + 1));
        else if (!want && motion !== undefined) {
            motion.cancel();
            motion = undefined;
        }
        // Idle, nothing animates; the "now" row's age still moves.
        const wantSlow = isPaneOpen && !want && m.current.now?.idle === true;
        if (wantSlow && slow === undefined)
            slow = $.clock.every(IDLE_REDRAW_MS, () => void update($, rev, n => n + 1));
        else if (!wantSlow && slow !== undefined) {
            slow.cancel();
            slow = undefined;
        }
    };
    refresh = async () => {
        const m = currentModel();
        $.ui.status(m.statusText ? m.statusText : undefined);
        await update($, rev, n => n + 1);
        await syncMotion?.();
    };
    try {
        isPaneOpen = (await $.ui.panes()).some(pane => pane.id === PANE);
    }
    catch {
        isPaneOpen = false;
    }
    await refresh();
    // Once per session: a reload or /clear must not reopen a pane the person closed.
    if (isInteractive && config().autoOpen && !isPaneOpen && !(await read($, autoOpened))) {
        await update($, autoOpened, () => true);
        try {
            isPaneOpen = (await $.ui.open({ id: PANE, title: 'hq' })).isPlaced;
            await syncMotion?.();
        }
        catch {
            // no pane on this surface; /hq still opens it
        }
    }
    try {
        await $.command.register({
            name: COMMAND,
            description: 'Pane of what needs you: agents, PRs and other sessions',
            argumentHint: '[close | wake on|off | notify on|off | summaries on|off | help]',
            immediate: true,
        });
    }
    catch (thrown) {
        $.ui.log(`hq: /${COMMAND} was not registered (${thrown instanceof Error ? thrown.message : String(thrown)})`);
    }
}
/** What a press does. Jumps run host commands; everything else only moves /hq's own view. */
export async function act($, key, action, last) {
    switch (action.kind) {
        case 'jump': {
            const pressed = await pressJump(action.jump, {
                run: (argv, init) => $.process.run(argv, { timeoutMs: 3000, ...init }),
                copy: text => $.ui.copy({ text }).then(r => r.isCopied),
                toast: text => $.ui.toast(text),
            });
            if (!pressed)
                return;
            await update($, cursor, () => key);
            return;
        }
        case 'toggle': {
            await update($, expanded, list => (list.includes(action.id) ? list.filter(id => id !== action.id) : [...list, action.id]));
            await update($, cursor, () => key);
            return;
        }
        case 'move': {
            if (!last || last.items.length === 0)
                return;
            let at = 0;
            await update($, cursor, current => {
                const i = current === null ? -1 : last.items.indexOf(current);
                at = i < 0 ? (action.dir > 0 ? 0 : last.items.length - 1) : Math.min(last.items.length - 1, Math.max(0, i + action.dir));
                return last.items[at] ?? null;
            });
            const target = last.items[at];
            if (target === undefined)
                return;
            const s = scrollFor(last, target, last.scroll);
            if (s !== last.scroll)
                await update($, scroll, () => s);
            // The target's Button may arrive with the next drawing; focus waits for it.
            await $.ui.focus({ requestId: PANE, key: target });
            return;
        }
        case 'scroll': {
            if (!last)
                return;
            const max = Math.max(0, last.bodyLen - last.region);
            const page = Math.max(1, last.region - 2);
            await update($, scroll, () => Math.min(max, Math.max(0, last.scroll + action.dir * page)));
            return;
        }
    }
}
function press($, key, action) {
    void act($, key, action, last);
}
export const register = (on, options) => {
    setConfig(resolveConfig(options));
    installData(on, () => void refresh?.());
    // The data layer owns the unmatched session.start; the pane's start runs under a matcher per session kind.
    on('session.start', { isInteractive: true }, async ($, e, next) => {
        await startPane($, true);
        return next(e);
    });
    on('session.start', { isInteractive: false }, async ($, e, next) => {
        await startPane($, false);
        return next(e);
    });
    on('command.run', { command: COMMAND }, async ($, e) => {
        const args = e.args.trim();
        if (args === '' || args === 'open') {
            const opened = await $.ui.open({ id: PANE, title: 'hq' });
            isPaneOpen = true;
            await syncMotion?.();
            return { text: opened.isPlaced ? 'hq pane opened. ⌃g moves the keys to it.' : 'hq pane is waiting for room to draw.' };
        }
        if (args === 'close') {
            await $.ui.close({ id: PANE });
            isPaneOpen = false;
            await syncMotion?.();
            return { text: 'hq pane closed.' };
        }
        const notify = parseNotifyArg(args);
        if (notify === 'show')
            return { text: `hq notifications are ${effective(await $.store.get(NOTIFY_STORE_KEY), config().notify) ? 'on' : 'off'}.` };
        if (notify !== undefined) {
            await $.store.set(NOTIFY_STORE_KEY, notify);
            return { text: `hq notifications ${notify ? 'on' : 'off'}.` };
        }
        if (args === 'help')
            return { text: HELP };
        const summaries = /^summaries(?:\s+(on|off))?$/.exec(args);
        if (summaries) {
            if (summaries[1] === undefined)
                return { text: `hq summaries are ${effective(await $.store.get(SUMMARIES_KEY), config().summaries) ? 'on' : 'off'}.` };
            await $.store.set(SUMMARIES_KEY, summaries[1] === 'on');
            return { text: `hq summaries ${summaries[1]}.` };
        }
        const toggle = parseWake(args);
        if (toggle !== null) {
            await $.store.set(WAKE_KEY, toggle === 'on');
            return { text: `hq waking is ${toggle}.` };
        }
        return { text: `Unknown subcommand "${args}".\n${HELP}` };
    });
    on('ui.close', async ($, e, next) => {
        const closed = await next(e);
        if (e.id === PANE) {
            isPaneOpen = false;
            await syncMotion?.();
        }
        return closed;
    }).catch(($, e, next) => next(e));
    // Tab and clicks move the ring: the cursor row follows it.
    on('ui.focus', async ($, e, next) => {
        const moved = await next(e);
        if (e.requestId === PANE && moved.deny === undefined && e.element !== undefined && last?.items.includes(e.element)) {
            const key = e.element;
            await update($, cursor, () => key);
        }
        return moved;
    }).catch(($, e, next) => next(e));
    on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
        if (!isPaneOpen) {
            isPaneOpen = true;
            void syncMotion?.();
        }
        await read($, rev);
        const view = {
            width: e.props.bodyColumns,
            rows: e.props.scroll.bodyRows,
            focused: e.props.isFocused,
            cursor: await read($, cursor),
            expanded: await read($, expanded),
            scroll: await read($, scroll),
            phase: await read($, phase),
            ...(config().warning ? { warning: config().warning } : {}),
        };
        const l = layout(currentModel(), view);
        last = l;
        const shown = (key) => l.rows.some(r => r.head && r.item === key);
        const autoFocusKey = view.cursor !== null && shown(view.cursor) ? view.cursor : l.items.find(shown);
        return drawPane(l.rows, {
            el: $.ui.resolve(e),
            tokens: config().tokens,
            autoFocusKey,
            onAction: (key, action) => press($, key, action),
        });
    });
};
