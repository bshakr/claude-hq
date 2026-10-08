export const WINDOW_DEFAULT = 200_000;
export const WINDOW_1M = 1_000_000;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
/** Input + cache-read + cache-write tokens of one assistant `message`; output is not part of the window it was answered over. */
export function sampleOf(message, ts) {
    const u = message?.usage;
    if (!u || typeof u !== 'object')
        return undefined;
    const o = u;
    const tokens = num(o.input_tokens) + num(o.cache_read_input_tokens) + num(o.cache_creation_input_tokens);
    const model = typeof message.model === 'string' ? message.model : undefined;
    // Error and interrupt placeholders carry a zeroed usage.
    if (tokens <= 0 || model === '<synthetic>')
        return undefined;
    return { tokens, ...(model ? { model } : {}), ts };
}
/** Keeps the newest sample: a sparse scan can feed lines out of order. */
export function newer(prev, next) {
    if (!next)
        return prev;
    return !prev || next.ts >= prev.ts ? next : prev;
}
const family = (m) => /opus|sonnet|haiku|fable/i.exec(m ?? '')?.[0].toLowerCase();
/**
 * The window a session's figure is measured against when the engine did not say:
 * 1M when its model id or its model setting names `[1m]` (the setting only when it is the
 * same model family the transcript shows), or when it already used more than 200k; else 200k.
 */
export function windowFor(sample, settingModel) {
    if (/\[1m\]/i.test(sample.model ?? ''))
        return WINDOW_1M;
    if (sample.tokens > WINDOW_DEFAULT)
        return WINDOW_1M;
    if (settingModel && /\[1m\]/i.test(settingModel)) {
        const f = family(settingModel);
        if (!f || !sample.model || f === family(sample.model))
            return WINDOW_1M;
    }
    return WINDOW_DEFAULT;
}
export function percentOf(tokens, window) {
    return Math.max(0, Math.min(100, Math.round((100 * tokens) / window)));
}
/** A session's fill from its transcript sample. */
export function derived(sample, settingModel) {
    if (!sample)
        return undefined;
    const window = windowFor(sample, settingModel);
    return { percent: percentOf(sample.tokens, window), window, tokens: sample.tokens, ...(sample.model ? { model: sample.model } : {}), source: 'transcript' };
}
/** What the engine reports for this session, in the shape others read. */
export function live(context, model) {
    const percent = context.percent ?? (context.tokens !== undefined && context.window > 0 ? percentOf(context.tokens, context.window) : undefined);
    if (percent === undefined)
        return undefined;
    return {
        percent, window: context.window, ...(context.tokens !== undefined ? { tokens: context.tokens } : {}), ...(model ? { model } : {}), source: 'live',
    };
}
/** A fresh publish from the session's own HQ wins over the transcript estimate. */
export function preferred(fresh, sample, settingModel) {
    return fresh?.context ?? derived(sample, settingModel);
}
/** The two windows the header shows, from the engine's rate limits. */
export function accountOf(limits) {
    const pick = (kind) => limits.find(l => l.kind === kind)?.percentUsed;
    const fiveHour = pick('five_hour');
    const week = pick('seven_day');
    if (fiveHour === undefined && week === undefined)
        return undefined;
    return { ...(fiveHour !== undefined ? { fiveHour } : {}), ...(week !== undefined ? { week } : {}) };
}
/** `model` out of a settings.json text. */
export function settingsModel(text) {
    if (!text)
        return undefined;
    try {
        const m = JSON.parse(text).model;
        return typeof m === 'string' && m ? m : undefined;
    }
    catch {
        return undefined;
    }
}
