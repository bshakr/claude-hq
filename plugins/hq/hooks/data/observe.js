import { emptyActivity, nowOf, onToolResult, onToolStart, todosOf, waitingOf } from './activity';
import { agentList, emptyAgents, onAgentResult, onHandback, onSubagentTool, onSubagentToolEnd } from './agents';
import { parseOwnership } from './claims';
import { buildModel, fingerprint } from './model';
export const TICK_MS = 2_000;
export const PUBLISH_MS = 5_000;
export const BRANCH_TTL_MS = 60_000;
const EMPTY = {
    now: 0,
    counts: { waiting: 0, broken: 0, inProgress: 0, sessions: 0 },
    current: { label: '', agents: [], prs: [] },
    others: [],
    statusText: '',
};
export const DIRS_MAX = 20;
// Module state: a hot reload starts it afresh and session.start restores it from $.store.
export const S = {
    sessionId: '',
    home: '',
    now: 0,
    label: '',
    goal: undefined,
    glosses: {},
    agents: emptyAgents(),
    cwd: '',
    claims: {},
    branches: {},
    pending: [],
    /** Directories the session's or its agents' commands moved into: candidates for checkout ownership. */
    dirs: [],
    activity: emptyActivity(),
    prs: [],
    others: [],
    model: EMPTY,
    fp: '',
    dirty: false,
    onChange: (() => { }),
};
/** Test seam: the kit's `$.tool.call` drops `agentId`, so subagent calls are fed in directly. */
export function pendingClaims() {
    return S.pending;
}
export function agentsState() {
    return S.agents;
}
export function activityState() {
    return S.activity;
}
export function rebuild() {
    const model = buildModel({
        now: S.now, label: S.label, ...(S.goal ? { goal: S.goal } : {}), glosses: S.glosses, agents: agentList(S.agents, S.cwd || undefined), prs: S.prs, others: S.others,
        activity: { now: nowOf(S.activity), todos: todosOf(S.activity), waiting: waitingOf(S.activity) },
    });
    S.model = model;
    const fp = fingerprint(model);
    if (fp === S.fp)
        return;
    S.fp = fp;
    try {
        S.onChange();
    }
    catch {
        // the pane's callback failing must not break the data layer
    }
}
export function str(v) {
    return typeof v === 'string' ? v : undefined;
}
export function tokensOf(usage) {
    if (!usage || typeof usage !== 'object')
        return undefined;
    const u = usage;
    const n = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
        .map(k => (typeof u[k] === 'number' ? u[k] : 0))
        .reduce((a, b) => a + b, 0);
    return n > 0 ? n : undefined;
}
export function storeKey(kind) {
    return `${kind}:${S.sessionId}`;
}
/** Observes a tool call before it runs: subagent progress, or the session's in-flight tool. */
export function beforeTool(e) {
    const agentId = str(e.agentId);
    const input = e;
    if (!agentId) {
        onToolStart(S.activity, input, S.now);
        rebuild();
        return;
    }
    const tool = String(e.tool);
    if (onSubagentTool(S.agents, agentId, input, S.home, S.now)) {
        if (tool === 'SubagentHandback')
            onHandback(S.agents, agentId, str(e.message) ?? '');
        rebuild();
    }
}
function addDir(dir, by) {
    if (S.dirs.some(d => d.dir === dir && d.by === by))
        return;
    S.dirs = [{ dir, by }, ...S.dirs].slice(0, DIRS_MAX);
}
/** Observes a tool call's result: Agent results, ownership facts, the session's own activity. */
export function afterTool(e, r) {
    const tool = String(e.tool);
    const agentId = str(e.agentId);
    let changed = false;
    if (!agentId) {
        onToolResult(S.activity, e, r.result, S.now);
        changed = true;
    }
    else if (onSubagentToolEnd(S.agents, agentId)) {
        changed = true;
    }
    if (tool === 'Agent' && !('deny' in r && r.deny !== undefined)) {
        const id = onAgentResult(S.agents, String(e.tool_use_id), r.result, r.isError === true, str(r.text), S.now);
        changed = changed || id !== undefined;
    }
    if (tool === 'Bash') {
        const command = str(e.command) ?? '';
        const result = (r.result ?? {});
        const facts = parseOwnership(command, str(result.stdout) ?? '', str(result.stderr) ?? '', result.gitOperation);
        const claimedBy = agentId ?? 'main';
        const agentRoot = agentId ? S.agents.byId[agentId]?.root : undefined;
        for (const d of facts.dirs)
            addDir(d, claimedBy);
        for (const c of facts.created)
            S.pending.push({ kind: 'created', repo: c.repo, number: c.number, claimedBy });
        for (const p of facts.pushed) {
            const dir = p.dir ?? agentRoot;
            S.pending.push({ kind: 'pushed', ...p, ...(dir ? { dir } : {}), claimedBy });
        }
        for (const m of facts.merged) {
            const dir = facts.dirs[facts.dirs.length - 1] ?? agentRoot;
            S.pending.push({ kind: 'merged', ...m, ...(dir ? { dir } : {}) });
        }
    }
    if (changed)
        rebuild();
}
