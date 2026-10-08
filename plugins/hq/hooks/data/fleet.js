import { isRealWait } from './waiting';
export const PUBLISH_FRESH_MS = 30_000;
export function parseRegistryRow(text) {
    try {
        const v = JSON.parse(text);
        if (typeof v.pid !== 'number' || typeof v.sessionId !== 'string')
            return undefined;
        return { ...v, cwd: typeof v.cwd === 'string' ? v.cwd : '' };
    }
    catch {
        return undefined;
    }
}
export function parsePublished(text) {
    try {
        const v = JSON.parse(text);
        if (typeof v.sessionId !== 'string' || typeof v.updatedAt !== 'number')
            return undefined;
        return v;
    }
    catch {
        return undefined;
    }
}
/** Live pids out of `ps -o pid= -p a,b,c` output. */
export function parsePsPids(stdout) {
    const out = new Set();
    for (const line of stdout.split('\n')) {
        const n = Number(line.trim().split(/\s+/)[0]);
        if (Number.isInteger(n) && n > 0)
            out.add(n);
    }
    return out;
}
function basename(path) {
    const parts = path.split('/').filter(Boolean);
    return parts[parts.length - 1] ?? path;
}
export function splitTmux(target) {
    if (!target)
        return { session: '' };
    const [session, rest] = target.split(':', 2);
    const window = rest?.split('.')[0];
    return { session: session ?? '', ...(window ? { window } : {}) };
}
/** ~/.claude/sessions status → the pane's three; `shell` and anything unknown read as idle. */
export function mapStatus(status) {
    if (status === 'busy')
        return 'busy';
    if (status === 'waiting')
        return 'waiting';
    return 'idle';
}
const DEFAULT_BRANCHES = new Set(['main', 'master']);
/** "<repo or worktree> · <branch>" (branch left out on main), then the session's published doing line; none when it would only repeat the tmux group. */
export function detailOf(row, branch, doing) {
    const place = basename(row.cwd);
    const where = [place, branch && branch !== place && !DEFAULT_BRANCHES.has(branch) ? branch : undefined].filter(Boolean).join(' · ');
    if (!doing && where === splitTmux(row.tmux).session)
        return undefined;
    const text = [where, doing].filter(Boolean).join(' · ');
    return text || undefined;
}
export function toSessionVM(row, branch, published, now, topic = {}, transcriptAgents, ctx = {}, wait) {
    const { window } = splitTmux(row.tmux);
    const real = isRealWait(wait);
    const name = ctx.goal || topic.title || topic.firstPrompt || nameOf(row) || basename(row.cwd) || 'session';
    const label = branch || basename(row.cwd);
    const status = real ? 'waiting' : mapStatus(row.status);
    const fresh = published && now - published.updatedAt < PUBLISH_FRESH_MS ? published : undefined;
    const agents = fresh?.agents ?? transcriptAgents;
    return {
        sessionId: row.sessionId,
        name,
        windowLabel: window ? `${window} ${label}` : label,
        status,
        ...(row.tmux ? { tmuxTarget: row.tmux, jump: { kind: 'tmux', target: row.tmux } } : {}),
        ...(real ? { waitingFor: wait.text, wait } : status === 'waiting' && row.waitingFor ? { waitingFor: row.waitingFor } : {}),
        ...(wait?.kind === 'turn' && status === 'idle' ? { wait } : {}),
        ...(real ? { statusSince: wait.since } : typeof row.statusUpdatedAt === 'number' ? { statusSince: row.statusUpdatedAt } : {}),
        ...(fresh ? { agentsRunning: fresh.agentsRunning, prSummary: fresh.prSummary } : {}),
        ...(!fresh && agents?.length ? { agentsRunning: agents.length } : {}),
        ...(agents?.length ? { agents: [...agents] } : {}),
        ...((d => (d ? { detail: d } : {}))(detailOf(row, branch, fresh?.doing))),
        ...(ctx.day ? { day: ctx.day } : {}),
        ...(ctx.step ? { step: ctx.step } : {}),
        ...(ctx.prText ? { prText: ctx.prText } : {}),
        ...(ctx.todos ? { todos: ctx.todos } : {}),
        ...(ctx.glosses && Object.keys(ctx.glosses).length ? { glosses: ctx.glosses } : {}),
    };
}
/** A registry name that is only the session or job id (a spare's, a fresh bg session's) names nothing. */
function nameOf(row) {
    const n = row.name?.trim();
    if (!n || n === row.jobId || row.sessionId.startsWith(n))
        return undefined;
    return n;
}
const TITLE_RE = /"(?:aiTitle|customTitle)":"((?:[^"\\]|\\.)*)"/g;
/** The newest AI or custom title in a transcript's grep output. */
export function parseTitle(text) {
    let last;
    for (const m of text.matchAll(TITLE_RE)) {
        try {
            last = JSON.parse(`"${m[1]}"`);
        }
        catch {
            // a cut line
        }
    }
    return last?.trim() || undefined;
}
/** First line of the first user prompt, from one transcript `"type":"user"` line. */
export function parseFirstPrompt(line) {
    try {
        const v = JSON.parse(line);
        const c = v.message?.content;
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : '')).join('\n') : '';
        const first = text.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('<'));
        return first ? (first.length > 80 ? `${first.slice(0, 79)}…` : first) : undefined;
    }
    catch {
        return undefined;
    }
}
/** `~/.claude/projects/<cwd, non-alphanumerics as ->/<sessionId>.jsonl`. */
export function transcriptPath(home, cwd, sessionId) {
    return `${home}/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, '-')}/${sessionId}.jsonl`;
}
function rank(s) {
    if (s.status === 'waiting')
        return 0;
    if ((s.prSummary?.broken ?? 0) > 0)
        return 1;
    if (s.status === 'busy')
        return 2;
    return 3;
}
/** Waiting first (longest wait first), then broken, busy, idle by recency. */
export function compareSessions(a, b) {
    const r = rank(a) - rank(b);
    if (r !== 0)
        return r;
    const since = (a.statusSince ?? 0) - (b.statusSince ?? 0);
    if (rank(a) === 0 && since !== 0)
        return since;
    if (rank(a) !== 0 && since !== 0)
        return -since;
    return a.name.localeCompare(b.name) || a.sessionId.localeCompare(b.sessionId);
}
export function groupByTmux(sessions) {
    const groups = new Map();
    for (const s of [...sessions].sort(compareSessions)) {
        const key = splitTmux(s.tmuxTarget).session;
        const list = groups.get(key) ?? [];
        list.push(s);
        groups.set(key, list);
    }
    // Map keeps insertion order, and sessions were sorted, so the group of the most urgent session leads.
    return [...groups].map(([tmuxSession, list]) => ({ tmuxSession, sessions: list }));
}
/** The other session that has waited for input longest. */
export function pickFlare(sessions) {
    const waiting = sessions
        .filter(s => s.status === 'waiting' && s.tmuxTarget)
        .sort((a, b) => (a.statusSince ?? 0) - (b.statusSince ?? 0));
    const top = waiting[0];
    if (!top || !top.tmuxTarget)
        return undefined;
    return {
        text: isRealWait(top.wait) ? `${top.name} asks: ${top.wait.text}` : `${top.name} is waiting for your input`,
        sinceMs: top.statusSince ?? 0,
        tmuxTarget: top.tmuxTarget,
        jump: { kind: 'tmux', target: top.tmuxTarget },
    };
}
/** This process's registry row: by session id, else by the pid it had (a /clear changes the id, not the pid). */
export function findSelf(rows, selfId, selfPid) {
    return rows.find(r => r.sessionId === selfId) ?? (selfPid ? rows.find(r => r.pid === selfPid) : undefined);
}
/** The interactive front-end and the background session it drives are one session: front.parkedJobId === bg.jobId. */
export function isPaired(a, b) {
    return (!!a.parkedJobId && a.parkedJobId === b.jobId) || (!!b.parkedJobId && b.parkedJobId === a.jobId);
}
/** Rows that are this session: its own and its paired front-end or background half. */
export function isSelfRow(r, self, selfId) {
    return r.sessionId === selfId || (self !== undefined && (r === self || r.pid === self.pid || isPaired(r, self)));
}
/** Rows shown as other sessions: alive, not this session, not a spare. */
export function isOtherRow(r, self, selfId, alive) {
    return !r.spare && alive.has(r.pid) && !isSelfRow(r, self, selfId);
}
/** The tmux pane this session is reached through: its own, else its paired front-end's. */
export function selfTmux(rows, self) {
    if (!self)
        return undefined;
    return self.tmux ?? rows.find(r => r !== self && isPaired(r, self) && r.tmux)?.tmux;
}
export function buildFleet(rows, alive, selfId, branches, published, now, selfPid, topics = new Map(), agents = new Map(), contexts = new Map(), waits = new Map()) {
    const self = findSelf(rows, selfId, selfPid);
    const others = rows
        .filter(r => isOtherRow(r, self, selfId, alive))
        .map(r => toSessionVM(r, branches.get(r.cwd), published.get(r.sessionId), now, topics.get(r.sessionId), agents.get(r.sessionId), contexts.get(r.sessionId), waits.get(r.sessionId)));
    return { ...(self ? { self } : {}), others: groupByTmux(others) };
}
