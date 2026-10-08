import { describe, expect, test } from 'claude-code/testing';
import { emptyDigest, ingest, ingestLines } from '../../hooks/data/context';
import { toSessionVM, parseRegistryRow } from '../../hooks/data/fleet';
import { accountOf, derived, live, percentOf, preferred, sampleOf, settingsModel, windowFor } from '../../hooks/data/usage';
const asst = (ts, usage, extra = {}, model = 'claude-opus-5-5') => JSON.stringify({
    type: 'assistant', timestamp: ts, ...extra,
    message: { model, role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'text', text: 'x' }], usage: { output_tokens: 900, ...usage } },
});
const U = (input, read, write) => ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write });
describe('transcript derivation', () => {
    test('the last main-thread response counts input, cache read and cache write; output is left out', () => {
        expect(sampleOf({ model: 'm', usage: { ...U(2, 261_031, 1_437), output_tokens: 5_000 } }, 1)).toEqual({ tokens: 262_470, model: 'm', ts: 1 });
    });
    test('synthetic and empty usages are not a reading', () => {
        expect(sampleOf({ model: '<synthetic>', usage: U(0, 0, 0) }, 1)).toBeUndefined();
        expect(sampleOf({ model: 'm' }, 1)).toBeUndefined();
    });
    test('the digest keeps the newest main-thread usage; a subagent line never counts', () => {
        const d = emptyDigest();
        ingest(d, [
            asst('2026-10-08T10:00:00Z', U(2, 40_000, 1_000)),
            asst('2026-10-08T10:01:00Z', U(2, 55_000, 500)),
            asst('2026-10-08T10:02:00Z', U(9, 900_000, 0), { isSidechain: true }),
            JSON.stringify({ type: 'user', timestamp: '2026-10-08T10:03:00Z', message: { content: 'next' } }),
            '',
        ].join('\n'));
        expect(d.usage).toEqual({ tokens: 55_502, model: 'claude-opus-5-5', ts: Date.parse('2026-10-08T10:01:00Z') });
    });
    test('a sparse scan fed out of order still keeps the newest; a cut first tail line is dropped', () => {
        const d = emptyDigest();
        ingestLines(d, asst('2026-10-08T12:00:00Z', U(1, 300_000, 0)));
        ingestLines(d, ['{"cut', asst('2026-10-08T11:00:00Z', U(1, 10_000, 0))].join('\n'), true);
        expect(d.usage?.tokens).toBe(300_001);
        ingestLines(d, ['{"cut', asst('2026-10-08T13:00:00Z', U(1, 20_000, 0))].join('\n'), true);
        expect(d.usage?.tokens).toBe(20_001);
    });
    test('appended bytes move the reading forward', () => {
        const d = emptyDigest();
        ingest(d, `${asst('2026-10-08T10:00:00Z', U(1, 1_000, 0))}\n`);
        ingest(d, `${asst('2026-10-08T10:05:00Z', U(1, 150_000, 0))}\n`);
        expect(derived(d.usage)?.percent).toBe(75);
    });
});
describe('window rule', () => {
    test('a [1m] model id is 1M', () => expect(windowFor({ tokens: 10, model: 'claude-opus-5-5[1m]' })).toBe(1_000_000));
    test('more than 200k used proves 1M', () => {
        expect(windowFor({ tokens: 200_001, model: 'claude-opus-5-5' })).toBe(1_000_000);
        expect(windowFor({ tokens: 200_000, model: 'claude-opus-5-5' })).toBe(200_000);
    });
    test('a [1m] setting of the same family is 1M; another family is not', () => {
        expect(windowFor({ tokens: 10, model: 'claude-opus-5-5' }, 'opus[1m]')).toBe(1_000_000);
        expect(windowFor({ tokens: 10, model: 'claude-haiku-4-5' }, 'opus[1m]')).toBe(200_000);
        expect(windowFor({ tokens: 10 }, 'opus[1m]')).toBe(1_000_000);
    });
    test('otherwise 200k', () => {
        expect(windowFor({ tokens: 10, model: 'claude-opus-5-5' })).toBe(200_000);
        expect(windowFor({ tokens: 10, model: 'claude-opus-5-5' }, 'sonnet')).toBe(200_000);
    });
    test('percent is whole and clamped', () => {
        expect(percentOf(262_470, 1_000_000)).toBe(26);
        expect(percentOf(150_000, 200_000)).toBe(75);
        expect(percentOf(250_000, 200_000)).toBe(100);
    });
    test('settings.json model', () => {
        expect(settingsModel('{"model":"opus[1m]","env":{}}')).toBe('opus[1m]');
        expect(settingsModel('{}')).toBeUndefined();
        expect(settingsModel('not json')).toBeUndefined();
    });
});
describe('publish and prefer', () => {
    const pub = (context) => ({
        sessionId: 'b1', pid: 1, updatedAt: 0, agentsRunning: 0, prSummary: { total: 0, broken: 0, waiting: 0, inProgress: 0 }, ...(context ? { context } : {}),
    });
    const sample = { tokens: 150_000, model: 'claude-opus-5-5', ts: 1 };
    test('the engine figure is published as it is', () => {
        expect(live({ tokens: 280_000, window: 1_000_000, percent: 28 }, 'claude-opus-5-5[1m]')).toEqual({
            percent: 28, window: 1_000_000, tokens: 280_000, model: 'claude-opus-5-5[1m]', source: 'live',
        });
        expect(live({ window: 200_000 }, 'm')).toBeUndefined();
    });
    test("a fresh publish wins over the transcript; without one the transcript stands", () => {
        const own = live({ tokens: 280_000, window: 1_000_000, percent: 28 }, 'm');
        expect(preferred(pub(own), sample)).toEqual(own);
        expect(preferred(pub(), sample)).toEqual({ percent: 75, window: 200_000, tokens: 150_000, model: 'claude-opus-5-5', source: 'transcript' });
        expect(preferred(undefined, sample, 'opus[1m]')?.percent).toBe(15);
        expect(preferred(undefined, undefined)).toBeUndefined();
    });
    test('the card carries the figure', () => {
        const row = parseRegistryRow(JSON.stringify({ pid: 1, sessionId: 'b1', cwd: '/w/app', status: 'busy' }));
        const ctx = derived(sample);
        expect(toSessionVM(row, undefined, undefined, 0, {}, undefined, { context: ctx }).context).toEqual(ctx);
        expect('context' in toSessionVM(row, undefined, undefined, 0)).toBe(false);
    });
    test('plan usage reads five_hour and seven_day; other windows are ignored', () => {
        expect(accountOf([{ kind: 'five_hour', percentUsed: 5 }, { kind: 'seven_day', percentUsed: 18.5 }, { kind: 'spend_limit', percentUsed: 90 }])).toEqual({ fiveHour: 5, week: 18.5 });
        expect(accountOf([{ kind: 'seven_day', percentUsed: 1 }])).toEqual({ week: 1 });
        expect(accountOf([])).toBeUndefined();
    });
});
