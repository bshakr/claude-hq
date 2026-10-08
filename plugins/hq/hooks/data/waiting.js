export const WAIT_TEXT_MAX = 160;
const MAIN = 'main';
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : undefined);
const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
function one(text, n) {
    const t = text.replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
const baseName = (path) => path.replace(/\/+$/, '').split('/').pop() || path;
export const isRealWait = (w) => w !== undefined && w.kind !== 'turn';
/** `mcp__linear__list_issues` → `linear list_issues`; built-in names as they are. */
export function toolLabel(tool) {
    const m = /^mcp__(.+?)__(.+)$/.exec(tool);
    return m ? `${m[1]} ${m[2]}` : tool;
}
/** The thing a permission prompt is about: a command, a file name, a host, a pattern. */
export function permissionTarget(tool, input) {
    const i = obj(input) ?? {};
    if (tool === 'Bash')
        return str(i.command)?.split('\n')[0];
    const path = str(i.file_path) ?? str(i.notebook_path) ?? str(i.path);
    if (path)
        return baseName(path);
    const url = str(i.url);
    if (url)
        return /^[a-z]+:\/\/([^/]+)/i.exec(url)?.[1] ?? url;
    return str(i.pattern) ?? str(i.query) ?? str(i.command) ?? str(i.description);
}
export function questionWait(input, now) {
    const qs = obj(input)?.questions;
    if (!Array.isArray(qs))
        return undefined;
    const q = obj(qs[0]);
    const text = str(q?.question);
    if (!q || !text)
        return undefined;
    const options = Array.isArray(q.options) ? q.options.flatMap(o => str(obj(o)?.label) ?? []) : [];
    const more = qs.length > 1 ? ` (+${qs.length - 1} more)` : '';
    return { kind: 'question', text: `${one(text, WAIT_TEXT_MAX)}${more}`, ...(options.length ? { options } : {}), since: now };
}
/** The wait a permission dialog for `tool` puts the user in. */
export function permissionWait(tool, input, now) {
    if (tool === 'AskUserQuestion')
        return questionWait(input, now) ?? { kind: 'question', text: 'a question', since: now };
    if (tool === 'ExitPlanMode')
        return { kind: 'plan', text: 'approve the plan', since: now };
    const target = permissionTarget(tool, input);
    return { kind: 'permission', text: one(target ? `${toolLabel(tool)}: ${target}` : toolLabel(tool), WAIT_TEXT_MAX), since: now };
}
// Module state: a reload while a dialog is up forgets it until the next one.
export const W = { open: [], inflight: [], rev: 0 };
export function resetWaits() {
    W.open = [];
    W.inflight = [];
    W.rev++;
}
function openWait(o) {
    W.open = W.open.filter(x => !(o.toolUseId !== undefined && x.toolUseId === o.toolUseId));
    W.open.push(o);
    W.rev++;
}
function closeWaits(pred) {
    const before = W.open.length;
    W.open = W.open.filter(o => !pred(o));
    if (W.open.length !== before)
        W.rev++;
}
export function onCallStart(id, tool, loop, input, now) {
    W.inflight.push({ id, tool, loop, ...((t => (t ? { target: t } : {}))(permissionTarget(tool, input))) });
    if (tool === 'AskUserQuestion') {
        const wait = questionWait(input, now);
        if (wait)
            openWait({ wait, loop, tool, toolUseId: id });
    }
}
/** A call settled (ran, denied or failed): its wait, or an unmatched one of the same tool in its loop, is over. */
export function onCallEnd(id, tool, loop) {
    W.inflight = W.inflight.filter(f => f.id !== id);
    closeWaits(o => o.toolUseId === id || (o.toolUseId === undefined && o.loop === loop && o.tool === tool));
}
/** PermissionRequest carries no tool_use_id: it is matched to the in-flight call of that tool and target. */
export function onPermissionRequest(tool, input, agentId, now) {
    const asked = agentId ?? MAIN;
    const target = permissionTarget(tool, input);
    // agent_id here and agentId on tool.call are not documented as one id: the loop comes from the matched call.
    const cands = W.inflight.filter(f => f.tool === tool).reverse();
    const hit = cands.find(f => f.loop === asked && f.target === target) ?? cands.find(f => f.target === target) ?? cands.find(f => f.loop === asked);
    if (hit && W.open.some(o => o.toolUseId === hit.id))
        return;
    openWait({ wait: permissionWait(tool, input, now), loop: hit?.loop ?? asked, tool, ...(hit ? { toolUseId: hit.id } : {}) });
}
export function onLoopEnd(loop) {
    closeWaits(o => o.loop === loop);
}
/** What this session publishes: its oldest open wait, else "your turn" once a turn has ended. */
export function ownWait(activity) {
    const real = [...W.open].sort((a, b) => a.wait.since - b.wait.since)[0];
    if (real)
        return real.wait;
    if (activity.idle && activity.prompt !== undefined && activity.since > 0)
        return { kind: 'turn', text: 'your turn', since: activity.since };
    return undefined;
}
const HUMAN = new Set(['composer', 'bridge']);
/** The user typing means no dialog holds the main loop; a background task's notice does not. */
export function onPromptOrigin(kind) {
    if (kind === undefined || HUMAN.has(kind))
        onLoopEnd(MAIN);
}
export const loopOf = (agentId) => (typeof agentId === 'string' && agentId ? agentId : MAIN);
/** tool.call, turn.complete and prompt.submit are hooked once, in index.ts, which calls the observers above. */
export function installWaits(on) {
    on('classic.PermissionRequest', async ($, e, next) => {
        try {
            onPermissionRequest(e.tool_name, e.tool_input, e.agent_id, await $.clock.now());
        }
        catch {
            // observation only
        }
        return next(e);
    }).catch(($, e, next) => next(e));
}
/** One parsed main-loop transcript line. */
export function noteWaitLine(d, v, ts) {
    if (v.isSidechain === true)
        return;
    const msg = obj(v.message);
    const content = Array.isArray(msg?.content) ? msg.content : [];
    if (v.type === 'assistant') {
        for (const b of content) {
            const o = obj(b);
            if (o?.type !== 'tool_use' || o.name !== 'AskUserQuestion' || typeof o.id !== 'string')
                continue;
            const wait = questionWait(o.input, ts ?? 0);
            if (wait)
                d.ask = { id: o.id, wait };
        }
        d.turnEnded = msg?.stop_reason === 'end_turn';
        return;
    }
    if (v.type !== 'user' || v.isMeta === true)
        return;
    for (const b of content) {
        const o = obj(b);
        if (o?.type === 'tool_result' && d.ask && o.tool_use_id === d.ask.id)
            delete d.ask;
    }
    d.turnEnded = false;
}
/** Another session's wait: its HQ's own word when it publishes, else its transcript's open question, else "your turn" when idle after a reply. */
export function otherWait(pub, t, status, statusSince) {
    if (pub)
        return pub.waiting;
    if (t?.ask)
        return t.ask.wait;
    if (status !== 'busy' && status !== 'waiting' && t?.turnEnded)
        return { kind: 'turn', text: 'your turn', since: statusSince ?? 0 };
    return undefined;
}
