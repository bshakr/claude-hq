// Another session's subagents, read from Claude Code's own files when that session does not publish them.
import { LONG_CALL_MS } from '../model/types';
export { LONG_CALL_MS };
import { doingText } from './doing';
/** A transcript untouched this long is not running, whatever its last line says. */
export const AGENT_FRESH_MS = 120_000;
/** Bytes read from the end of a transcript; one tool result line can run to a few hundred KB. */
export const TAIL_BYTES = 262_144;
export const OTHER_AGENTS_MAX = 3;
/** An open call older than this, with its session not busy, is a dead agent rather than a long call. */
export const OPEN_CALL_CAP_MS = 2 * 60 * 60_000;
/** `~/.claude/projects/<cwd, non-alphanumerics as ->/<sessionId>/subagents`. */
export function subagentsDir(home, cwd, sessionId) {
    return `${home}/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, '-')}/${sessionId}/subagents`;
}
export function parseMeta(text) {
    try {
        const v = JSON.parse(text);
        return {
            ...(typeof v.description === 'string' ? { description: v.description } : {}),
            ...(typeof v.model === 'string' ? { model: v.model } : {}),
        };
    }
    catch {
        return {};
    }
}
/** The end of a subagent transcript; `cut` drops the first line, which a byte tail splits. */
export function parseTail(text, cut) {
    const lines = text.split('\n');
    if (cut)
        lines.shift();
    let last;
    let doing;
    const open = new Map();
    for (const line of lines) {
        if (!line.trim())
            continue;
        let v;
        try {
            v = JSON.parse(line);
        }
        catch {
            continue;
        }
        if (v.type !== 'user' && v.type !== 'assistant')
            continue;
        last = v;
        if (!Array.isArray(v.message?.content))
            continue;
        for (const b of v.message.content) {
            if (v.type === 'user') {
                if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string')
                    open.delete(b.tool_use_id);
                continue;
            }
            if (b?.type !== 'tool_use' || typeof b.name !== 'string')
                continue;
            const input = b.input && typeof b.input === 'object' ? b.input : {};
            doing = doingText({ ...input, tool: b.name });
            const at = v.timestamp ? Date.parse(v.timestamp) : NaN;
            if (typeof b.id === 'string')
                open.set(b.id, { text: doing, ...(Number.isFinite(at) ? { since: at } : {}) });
        }
    }
    const stop = last?.type === 'assistant' ? last.message?.stop_reason : undefined;
    const ended = last?.toolEndsTurn === true || (typeof stop === 'string' && stop !== 'tool_use');
    const first = ended ? undefined : [...open.values()][0];
    return { ended, ...(doing ? { doing } : {}), ...(first ? { open: first } : {}) };
}
/** Transcripts that may be running: touched within `maxAgeMs`, newest first. */
export function freshTranscripts(entries, now, maxAgeMs = AGENT_FRESH_MS) {
    return entries
        .filter(e => e.kind === 'file' && /^agent-[A-Za-z0-9]+\.jsonl$/.test(e.name) && now - e.mtimeMs < maxAgeMs)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
}
/**
 * Whether a tail still runs: not ended, and either written within AGENT_FRESH_MS or inside an open call.
 * An open call past OPEN_CALL_CAP_MS counts as ended unless the parent session is busy.
 */
export function isRunning(tail, mtimeMs, now, parentBusy) {
    if (tail.ended)
        return false;
    if (now - mtimeMs < AGENT_FRESH_MS)
        return true;
    if (!tail.open)
        return false;
    const since = tail.open.since ?? mtimeMs;
    return parentBusy || now - since < OPEN_CALL_CAP_MS;
}
/** This session's agent inside one call for LONG_CALL_MS or more, as another session's pane shows it. */
export function longCall(a, now) {
    if (a.status !== 'running' || a.callSince === undefined || now - a.callSince < LONG_CALL_MS)
        return undefined;
    return { text: a.now ?? 'working', since: a.callSince };
}
/** Running agents, newest started first, as the pane's rows; a call open past LONG_CALL_MS is `waiting`. */
export function otherAgents(running, now = 0) {
    return running
        .filter(a => !a.tail.ended)
        .sort((a, b) => b.startedAt - a.startedAt)
        .map(a => {
        const o = a.tail.open;
        const since = o ? (o.since ?? a.mtimeMs) : undefined;
        const waiting = o && since !== undefined && now - since >= LONG_CALL_MS ? { text: o.text, since } : undefined;
        return {
            id: a.id,
            title: a.meta.description || a.id,
            startedAt: a.startedAt,
            ...(a.meta.model ? { model: a.meta.model } : {}),
            ...(a.tail.doing ? { doing: a.tail.doing } : {}),
            ...(waiting ? { waiting } : {}),
        };
    });
}
