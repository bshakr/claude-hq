import { describe, expect, test } from 'claude-code/testing';
import { DEFAULT_TOKENS, effective, parseColor, resolveConfig } from '../../hooks/config';
import { layout } from '../../hooks/ui/layout';
import { EMPTY } from '../ui/fixtures';
describe('colours', () => {
    test('hex, ansi256(N) and a bare palette number parse; anything else does not', () => {
        expect(parseColor('#F38BA8')).toBe('#f38ba8');
        expect(parseColor(' ansi256(12) ')).toBe('ansi256(12)');
        expect(parseColor('208')).toBe('ansi256(208)');
        expect(parseColor('0')).toBe('ansi256(0)');
        for (const bad of ['256', '-1', '#f38ba', '#gggggg', 'red', 'ansi:red', 'ansi256(300)', 'rgb(1,2,3)', '1.5'])
            expect(parseColor(bad)).toBe(undefined);
    });
    test('no options: the terminal palette slots, every switch on, no warning', () => {
        const c = resolveConfig(undefined);
        expect(c.tokens).toEqual(DEFAULT_TOKENS);
        expect(c.tokens).toEqual({ fail: 'ansi256(1)', wait: 'ansi256(3)', run: 'ansi256(4)', ok: 'ansi256(2)', accent: 'ansi256(6)', rule: 'ansi256(8)' });
        expect([c.summaries, c.wake, c.notify, c.autoOpen]).toEqual([true, true, true, true]);
        expect(c.warning).toBe(undefined);
    });
    test('each colour field paints its token; a bad one keeps its default and is named in one warning', () => {
        const c = resolveConfig({ colorBroken: '#f38ba8', colorWaiting: 'yellow', colorWorking: '33', colorDone: 'ansi256(10)', colorAccent: '', colorDim: '#12345' });
        expect(c.tokens).toEqual({ fail: '#f38ba8', wait: 'ansi256(3)', run: 'ansi256(33)', ok: 'ansi256(10)', accent: 'ansi256(6)', rule: 'ansi256(8)' });
        expect(c.warning).toBe('hq: ignored colour waiting, dim (use #rrggbb, ansi256(N) or N)');
    });
    test('the switches read as given', () => {
        const c = resolveConfig({ summaries: false, wake: false, notify: false, autoOpen: false });
        expect([c.summaries, c.wake, c.notify, c.autoOpen]).toEqual([false, false, false, false]);
    });
});
test('a /hq toggle in the store beats the config; unset falls back to it', () => {
    expect(effective(undefined, false)).toBe(false);
    expect(effective(undefined, true)).toBe(true);
    expect(effective(true, false)).toBe(true);
    expect(effective(false, true)).toBe(false);
    expect(effective('yes', false)).toBe(false);
});
test('a config warning takes one dim row above the hint, and the body gives that row up', () => {
    const view = { width: 80, rows: 20, focused: false, cursor: null, expanded: [], scroll: 0, phase: 0 };
    const plain = layout(EMPTY, view);
    const warned = layout(EMPTY, { ...view, warning: 'hq: ignored colour dim (use #rrggbb, ansi256(N) or N)' });
    expect(warned.rows).toHaveLength(20);
    expect(warned.region).toBe(plain.region - 1);
    const segs = warned.rows[18].segs();
    expect(segs.map(s => s.t).join('').includes('hq: ignored colour dim')).toBe(true);
    expect(segs.filter(s => s.t.trim()).every(s => s.s.dim === true && s.s.c === undefined)).toBe(true);
    expect(plain.rows.some(r => r.segs().some(s => s.t.includes('ignored')))).toBe(false);
});
