import { describe, expect, test } from 'claude-code/testing';
import { FOCUSED_HINT, UNFOCUSED_HINT, layout, scrollFor } from '../../hooks/ui/layout';
import { cellLen } from '../../hooks/ui/text';
import { ACTIVE, BUSY, EMPTY, LONG, QUIET } from './fixtures';
import * as SHEET from './sheet';
const view = (over = {}) => ({
    width: 80, rows: 64, focused: false, cursor: null, expanded: [], scroll: 0, phase: 0, ...over,
});
const lines = (m, over = {}) => layout(m, view(over)).rows.map(r => r.text());
function expectSheet(got, want) {
    expect(got.length).toBe(want.length);
    want.forEach((line, i) => expect(`${i + 1}: ${got[i]}`).toBe(`${i + 1}: ${line}`));
}
describe('the sheet, cell for cell', () => {
    test('(a) busy, unfocused, 80 cols', () => expectSheet(lines(BUSY), SHEET.a80));
    test("(a') busy, focused, cursor on the flare", () => expectSheet(lines(BUSY, { focused: true, cursor: 'flare' }), SHEET.aFocusFlare));
    test('(b) quiet, unfocused', () => expectSheet(lines(QUIET), SHEET.b80));
    test("(b') quiet, focused, cursor on #433", () => expectSheet(lines(QUIET, { focused: true, cursor: 'p:ritualpass/admin-web#433' }), SHEET.bFocus433));
    test('(c) busy, focused, cursor on rp-admin', () => expectSheet(lines(BUSY, { focused: true, cursor: 's:s-rp-admin' }), SHEET.c80));
    test('(e) 40 cols', () => expectSheet(lines(BUSY, { width: 40 }), SHEET.e40));
    test('(e) 88 cols', () => expectSheet(lines(BUSY, { width: 88 }), SHEET.e88));
    test('(f) long list', () => expectSheet(lines(LONG), SHEET.f80));
    test('(f2) long list, focused, scrolled to the bottom', () => expectSheet(lines(LONG, { focused: true, cursor: 's:s-rota-r', scroll: 99 }), SHEET.f2));
    test('(f3) long list on a 34-row pane', () => expectSheet(lines(LONG, { rows: 34 }), SHEET.f3));
});
const MODELS = { BUSY, QUIET, LONG, EMPTY, ACTIVE };
const DATA_TEXT = [...new Set(Object.values(MODELS).flatMap(m => [
        ...m.current.agents.flatMap(a => [a.title, a.outcome ?? '', a.now ?? '']),
        ...m.current.prs.map(p => p.title),
        m.current.now?.prompt ?? '', m.current.now?.tool?.text ?? '',
        ...(m.current.todos ?? []).map(t => t.text), ...(m.current.waiting ?? []).map(w => w.text),
    ]))].filter(Boolean).sort((a, b) => b.length - a.length);
const GLYPHS = new Set([...'▌▶◆●◦○✓✗↑↓→·⏎⌃…─│╭╮╰╯▰▱◷━']);
describe('every state, every width', () => {
    test('rows fill the body exactly and never pass its width', () => {
        for (const m of Object.values(MODELS)) {
            for (const width of [12, 30, 40, 48, 60, 72, 80, 88, 120]) {
                for (const rows of [6, 12, 20, 34, 58]) {
                    for (const focused of [false, true]) {
                        const l = layout(m, view({ width, rows, focused, cursor: 'flare', expanded: ['a3', 'a1'] }));
                        expect(l.rows.length).toBe(rows);
                        for (const r of l.rows)
                            expect(cellLen(r.text()) <= width).toBe(true);
                    }
                }
            }
        }
    });
    test('only the card glyphs: no tree, rules, gutters or legend; no action words', () => {
        const fixtureText = JSON.stringify(MODELS);
        for (const m of Object.values(MODELS)) {
            for (const focused of [false, true]) {
                const text = lines(m, { focused, expanded: ['a3', 'a2'] }).join('\n');
                for (const ch of text) {
                    if (ch.charCodeAt(0) < 128)
                        continue;
                    expect(GLYPHS.has(ch) || fixtureText.includes(ch) ? ch : `stray ${ch}`).toBe(ch);
                }
                const chrome = DATA_TEXT.reduce((t, s) => t.split(s).join(''), text);
                expect(chrome.match(/\b(act|acts|retry|copy|arm|dismiss)\b/gi)).toBe(null);
                expect(chrome.includes('checks done / to go')).toBe(false);
                expect(/\d+ sessions?\b/.test(chrome)).toBe(false);
                expect(text.includes(focused ? FOCUSED_HINT : UNFOCUSED_HINT)).toBe(true);
            }
        }
        // Rows drop the background flag and tool counts; the expanded detail keeps them.
        const rows = lines(BUSY).join('\n');
        expect(/\bbg\b|\bfg\b|\d+ tools?\b/.test(rows)).toBe(false);
    });
    test('truncation ends in one …, names and refs never cut', () => {
        for (const width of [40, 60]) {
            const text = lines(BUSY, { width, rows: 90 }).join('\n');
            for (const keep of ['#212', '#214', '#431', '#433', '#429', '#522', 'rp-api', 'monolense-research', 'rota-research']) {
                expect(text.includes(keep)).toBe(true);
            }
            expect(text.includes('……')).toBe(false);
        }
    });
    test('a card shrinks with the pane: its border spans the width at 40 and 80', () => {
        for (const width of [40, 80]) {
            const got = lines(BUSY, { width, rows: 90 });
            const tops = got.filter(l => l.startsWith(' ╭─ '));
            expect(tops.map(l => l.slice(4).split(' ')[0])).toEqual([
                'this', 'ritualpass', 'bassemshaker', 'monolense', 'travel-map', 'rotamonster', 'finance', 'pull',
            ]);
            for (const l of got.filter(t => /^ [╭│╰]/.test(t))) {
                expect(cellLen(l)).toBe(width - 1);
                expect(/[╮│╯]$/.test(l)).toBe(true);
            }
        }
    });
});
const runsOf = (r) => r.segs()
    .filter(s => s.t.trim() && s.t !== '│' && (s.s.c || s.s.bold || s.s.dim))
    .map(s => ({ col: s.col, t: s.t.trimEnd(), tok: [s.s.bold ? 'bold' : '', s.s.c ?? (s.s.dim ? 'dim' : '')].filter(Boolean).join('+') }));
const BORDER = /^[╭╮╰╯│─]+$/;
const coloured = (rows) => rows.flatMap(r => r.segs().filter(s => s.s.c && s.t.trim() && !BORDER.test(s.t)));
const borderTone = (rows, title) => rows.find(r => r.text().startsWith(` ╭─ ${title}`)).cells[1].s.c;
describe('colour', () => {
    test('header: one sentence, counts only when non-zero, coloured by what they mean', () => {
        const rows = layout(BUSY, view()).rows;
        expect(rows[0].text()).toBe(' ◆ 3 waiting on you · 2 broken · 3 working');
        expect(runsOf(rows[0]).filter(r => r.tok !== 'dim')).toEqual([
            { col: 1, t: '◆', tok: 'wait' }, { col: 3, t: '3 waiting on you', tok: 'wait' }, { col: 22, t: '2 broken', tok: 'fail' },
        ]);
        expect(lines(QUIET)[0]).toBe(' ○ nothing needs you');
        const working = { ...QUIET, counts: { waiting: 0, broken: 0, inProgress: 1, sessions: 4 } };
        expect(lines(working)[0]).toBe(' ● 1 working · nothing needs you');
        const broken = { ...QUIET, counts: { waiting: 0, broken: 1, inProgress: 0, sessions: 4 } };
        expect(lines(broken)[0]).toBe(' ✗ 1 broken');
    });
    test('card borders: dim normally, yellow when something needs you, red when broken', () => {
        const rows = layout(BUSY, view({ rows: 90 })).rows;
        expect(borderTone(rows, 'this session')).toBe('fail');
        expect(borderTone(rows, 'ritualpass')).toBe('wait');
        expect(borderTone(rows, 'bassemshaker')).toBe('rule');
        expect(borderTone(rows, 'pull requests')).toBe('fail');
        const long = layout(LONG, view({ rows: 90 })).rows;
        expect(borderTone(long, 'finance')).toBe('fail');
        const quiet = layout(QUIET, view()).rows;
        for (const r of quiet.filter(x => x.text().startsWith(' ╭─ ')))
            expect(r.cells[1].s.c).toBe('rule');
    });
    test('the #212 and #214 check bars', () => {
        const rows = layout(BUSY, view({ rows: 90 })).rows;
        const row = (ref) => rows.find(r => r.text().includes(ref));
        expect(runsOf(row('#212')).slice(-3)).toEqual([
            { col: 62, t: '▰▰▰▰▰▰▰▰▰', tok: 'dim' }, { col: 71, t: '▰', tok: 'fail' }, { col: 73, t: '9/9', tok: 'fail' },
        ]);
        expect(runsOf(row('#214')).slice(-3)).toEqual([
            { col: 62, t: '▰▰▰▰▰▰', tok: 'run' }, { col: 68, t: '▱▱▱▱', tok: 'dim' }, { col: 73, t: '5/9', tok: 'run' },
        ]);
        const facts = (ref) => rows[rows.indexOf(row(ref)) + 1];
        expect(runsOf(facts('#212'))[0]).toEqual({ col: 10, t: '✗ rspec failed', tok: 'fail' });
        expect(runsOf(facts('#431'))).toContainEqual({ col: 22, t: '↑ behind main', tok: 'wait' });
        expect(runsOf(facts('#522'))).toContainEqual({ col: 41, t: 'no watcher', tok: 'wait' });
    });
    test('quiet has no coloured cell but the borders; focus adds only ▌ and ▶', () => {
        expect(coloured(layout(QUIET, view()).rows).length).toBe(0);
        const focused = layout(QUIET, view({ focused: true, cursor: 'p:ritualpass/admin-web#433' }));
        expect(coloured(focused.rows).map(s => `${s.t}=${s.s.c}`)).toEqual(['▌=accent', '▶=accent']);
    });
    test('unfocused draws no cursor even with one remembered', () => {
        const text = lines(BUSY, { cursor: 'flare' }).join('\n');
        expect(text.includes('▶')).toBe(false);
        expect(text.includes('▌')).toBe(false);
    });
    test('no background colour on any cell', () => {
        for (const r of layout(BUSY, view()).rows)
            for (const s of r.segs())
                expect('bg' in s.s).toBe(false);
    });
});
describe('targets', () => {
    test('one Button per actionable row, each with its jump or expansion', () => {
        const l = layout(BUSY, view({ focused: true, rows: 120 }));
        expect(l.items).toEqual([
            'flare', 'a:a5', 'a:a1', 'a:a2', 'a:a3', 'a:a4',
            's:s-rp-api', 's:s-rp-admin', 's:s-rp-docs', 's:s-home', 's:s-mono-r', 's:s-travel', 's:s-rota', 's:s-rota-r', 's:s-fin',
            'p:bshakr/monolense#212', 'p:bshakr/monolense#214',
            'p:ritualpass/admin-web#431', 'p:ritualpass/admin-web#433', 'p:ritualpass/admin-web#429',
            'p:ritualpass/api#522',
        ]);
        const buttons = l.rows.flatMap(r => r.buttons);
        const shown = l.items.filter(k => l.rows.some(r => r.head && r.item === k));
        for (const key of shown)
            expect(buttons.filter(b => b.key === key).length).toBe(1);
        expect(buttons.map(b => b.key).filter(k => !l.items.includes(k))).toEqual(['j', 'k']);
        expect(l.actions.flare).toEqual({ kind: 'jump', jump: { kind: 'tmux', target: 'ritualpass:@3.%6' } });
        expect(l.actions['p:bshakr/monolense#212']).toEqual({ kind: 'jump', jump: { kind: 'url', url: 'https://github.com/bshakr/monolense/pull/212' } });
        expect(l.actions['s:s-rp-admin']).toEqual({ kind: 'jump', jump: { kind: 'tmux', target: 'ritualpass:@4.%13' } });
        expect(l.actions['a:a3']).toEqual({ kind: 'toggle', id: 'a3' });
        const all = layout(BUSY, view({ rows: 90 }));
        const hrefs = all.rows.flatMap(r => r.segs().filter(s => s.s.href).map(s => `${s.t}=${s.s.href}`));
        expect(hrefs).toContain('#212=https://github.com/bshakr/monolense/pull/212');
        expect(hrefs.length).toBe(BUSY.current.prs.length);
    });
    test('every line of an item, border cells included, shares its key so hover lights the whole item', () => {
        const rows = layout(ACTIVE, view({ rows: 90 })).rows;
        const at = rows.findIndex(r => r.text().includes('rp-admin'));
        const group = rows.slice(at).filter((r, i, all) => all.slice(0, i + 1).every(x => x.item === 's:s-rp-admin'));
        expect(group.length).toBe(7);
        expect(group.every(r => r.text().startsWith(' │') && r.text().endsWith('│'))).toBe(true);
        expect(group.filter(r => r.head).length).toBe(1);
    });
    test('a session without a jump is drawn but is not a target', () => {
        const m = {
            ...QUIET,
            others: [{ tmuxSession: 'x', sessions: [{ sessionId: 'nojump', name: 'loose', windowLabel: '', status: 'idle' }] }],
        };
        const l = layout(m, view());
        expect(l.items.includes('s:nojump')).toBe(false);
        expect(lines(m).some(t => t.startsWith(' │  loose'))).toBe(true);
    });
    test('expanding an agent adds its detail lines under it', () => {
        const closed = lines(BUSY);
        const open = lines(BUSY, { expanded: ['a3'] });
        expect(open.length).toBe(closed.length);
        const at = open.findIndex(t => t.includes('Adversarial review'));
        expect(open[at + 1]).toBe(' │    agent   opus · background · 9m 40s · 41 tools                           │');
        expect(open[at + 2].startsWith(' │    result  3 findings: 1 HIGH')).toBe(true);
    });
    test('no pull requests, no card', () => {
        const m = { ...QUIET, current: { ...QUIET.current, prs: [] } };
        expect(lines(m, { rows: 90 }).some(l => l.includes('pull requests'))).toBe(false);
        expect(lines(QUIET, { rows: 90 }).some(l => l.includes('╭─ pull requests'))).toBe(true);
    });
});
describe('scrolling and motion', () => {
    test('the below indicator counts lit items, the above one appears once scrolled', () => {
        const top = lines(LONG, { rows: 34 });
        expect(top[32]).toBe(' ↓ 42 rows below   ✗ 1 broken   ◆ 2 waiting on you');
        const mid = lines(LONG, { rows: 34, scroll: 10 });
        expect(mid[3].startsWith(' ↑ 10 rows above   ✗ 1 broken')).toBe(true);
        expect(mid[32].startsWith(' ↓ 32 rows below')).toBe(true);
    });
    test('scrollFor keeps the cursor row inside the window', () => {
        const l = layout(LONG, view({ rows: 34 }));
        const key = 's:s-rota-r';
        const s = scrollFor(l, key, 0);
        const line = l.itemLine[key];
        expect(line >= s && line < s + l.region).toBe(true);
        expect(scrollFor(l, 'a:a5', s)).toBe(Math.min(s, l.itemLine['a:a5']));
    });
    test('busy: one changed cell per running thing per phase; quiet: none', () => {
        const changed = (m) => {
            const a = layout(m, view({ phase: 0, rows: 90 })).rows;
            const b = layout(m, view({ phase: 1, rows: 90 })).rows;
            let n = 0;
            a.forEach((r, i) => r.cells.forEach((c, j) => {
                const d = b[i].cells[j];
                if (c.ch !== d.ch || JSON.stringify(c.s) !== JSON.stringify(d.s))
                    n++;
            }));
            return n;
        };
        // a2's breath, #214's next check, rp-admin's breath.
        expect(changed(BUSY)).toBe(3);
        expect(changed(QUIET)).toBe(0);
    });
});
describe('this session: one card for now, todos, waiting and agents', () => {
    test('now, todos and waiting open the card; agents follow after a blank; no sub-heading or rule', () => {
        const got = lines(ACTIVE);
        expect(got.slice(4, 22)).toEqual([
            ' ╭─ this session ─────────────────────────────────────────────────────────────╮',
            ' │                                                                            │',
            ' │  ● Fix the stale PR list in hq and scope wave-watcher wakes to the o…  2m  │',
            ' │    Check CI on 276                                                     4s  │',
            ' │  todos 2/5 ━━━─────  ● Rewriting the layout                                │',
            ' │  ◷ pr-ci-wait 276                                                      3m  │',
            ' │                                                                            │',
            ' │  ✗ Capture screenshot pairs                               sonnet · 6m 30s  │',
            ' │    port 3000 already in use · failed 1m ago                                │',
            ' │  ◷ Implement ledger refund reconcile                       opus · 14m 20s  │',
            ' │    waiting on Run ledger specs and report                                  │',
            ' │    ● Run ledger specs and report     ledger-refund-rec… · sonnet · 2m 10s  │',
            ' │      Running ledger specs                                             3/7  │',
            ' │                                                                            │',
            ' │  ✓ Adversarial review: refunds PR → 3 findings: 1 HIGH (refund r…  3m ago  │',
            ' │    ✓ Find refund callers → 4 callers, all in app/ledger            5m ago  │',
            ' │                                                                            │',
            ' ╰────────────────────────────────────────────────────────────────────────────╯',
        ]);
        const at = (t) => got.findIndex(l => l.includes(t));
        expect(at('╭─ ritualpass') < at('╭─ pull requests')).toBe(true);
        expect(got.some(l => /agents|[└├┄]/.test(l))).toBe(false);
    });
    test('colours: blue for the running turn, the todo bar and the background wait; never yellow', () => {
        const rows = layout(ACTIVE, view()).rows;
        const toks = coloured(rows.slice(6, 10)).map(x => `${x.t}=${x.s.c}`);
        expect(toks).toEqual(['●=run', '━━━=run', '●=run', '◷=run']);
    });
    test('idle after the turn: dim, reads idle, no tool line', () => {
        const m = { ...ACTIVE, current: { ...ACTIVE.current, now: { prompt: 'Ship it', since: ACTIVE.now - 60_000, idle: true }, todos: undefined, waiting: undefined } };
        const rows = layout(m, view()).rows;
        expect(rows[6].text()).toBe(' │  ○ idle · Ship it                                                      1m  │');
        expect(coloured([rows[6]])).toEqual([]);
        expect(rows[7].text()).toBe(' │                                                                            │');
        expect(rows[8].text().startsWith(' │  ✗ Capture screenshot pairs')).toBe(true);
    });
    test('an empty session says so', () => {
        expect(lines(EMPTY)[4]).toBe(' │  nothing running                                                           │');
    });
    test('an agent inside one long call reads ◷ with what it waits on and the call\'s age', () => {
        const agent = (callAgo) => ({
            id: 'lc', title: 'Watch CI', status: 'running', background: true, startedAt: QUIET.now - 20 * 60_000,
            toolCount: 4, files: [], now: 'Wait for CI on #275', callSince: QUIET.now - callAgo,
        });
        const draw = (callAgo) => lines({ ...QUIET, current: { ...QUIET.current, agents: [agent(callAgo)] } });
        const long = draw(7 * 60_000);
        const at = long.findIndex(l => l.includes('Watch CI'));
        expect(long[at].startsWith(' │  ◷ Watch CI')).toBe(true);
        expect(long[at + 1].startsWith(' │    waiting · Wait for CI on #275 · 7m ')).toBe(true);
        const short = draw(30_000);
        expect(short[at].startsWith(' │  ● Watch CI')).toBe(true);
        expect(short[at + 1].startsWith(' │    Wait for CI on #275 ')).toBe(true);
    });
    test('a finished agent with a markdown report shows its first sentence as plain text', () => {
        const m = {
            ...QUIET,
            current: {
                ...QUIET.current,
                agents: [{
                        id: 'md', title: 'Scope PR ownership', status: 'completed', background: true, startedAt: QUIET.now - 60_000,
                        endedAt: QUIET.now - 30_000, toolCount: 3, files: [],
                        outcome: '**Brief and all four add-ons are done.** HQ now shows `todos`.',
                    }],
            },
        };
        const row = lines(m).find(l => l.includes('Scope PR ownership'));
        expect(row.includes('✓ Scope PR ownership → Brief and all four add-ons are done.')).toBe(true);
        expect(row.includes('30s ago')).toBe(true);
        expect(/[*`]/.test(row)).toBe(false);
    });
});
describe('other sessions: one card per tmux group', () => {
    test('sessions of one group share a card, a blank between them; detail and agents sit under each', () => {
        const got = lines(ACTIVE, { rows: 90 });
        const at = got.findIndex(l => l.includes('╭─ ritualpass'));
        expect(got.slice(at, at + 15)).toEqual([
            ' ╭─ ritualpass ───────────────────────────────────────────────────────────────╮',
            ' │  rp-api                           1 agent · 1 PR needs you · ◆ waiting 2m  │',
            ' │  api · BLO-12 · 3/7 · Rewriting PR claim rules                             │',
            ' │                                                                            │',
            ' │  rp-admin                                 1 of 2 PRs need you · ● busy 6m  │',
            ' │  ● Implement BLO-1941 card pairing guard                       opus · 12m  │',
            ' │    Run ledger specs                                                        │',
            ' │  ● Review the members table PR                               sonnet · 20m  │',
            ' │  ● Capture screenshot pairs                                           25m  │',
            ' │    editing gallery.html                                                    │',
            ' │    +1 more                                                                 │',
            ' │                                                                            │',
            ' │  rp-docs                                                          idle 1h  │',
            ' ╰────────────────────────────────────────────────────────────────────────────╯',
            '',
        ]);
    });
    test('another session\'s agent inside a long call reads ◷ waiting', () => {
        const other = lines({
            ...ACTIVE,
            others: ACTIVE.others.map(g => ({ ...g, sessions: g.sessions.map(x => x.agents ? { ...x, agents: [{ ...x.agents[0], waiting: { text: 'Run the spec suite', since: ACTIVE.now - 9 * 60_000 } }] } : x) })),
        }, { rows: 90 });
        const at = other.findIndex(l => l.includes('◷ Implement BLO-1941'));
        expect(other[at + 1].startsWith(' │    waiting · Run the spec suite · 9m')).toBe(true);
    });
});
