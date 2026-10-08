import { promptSummary } from '../model/plain';
import { doingText } from './doing';
export function emptyActivity() {
    return { since: 0, idle: true, todos: [], tasks: [], list: 'todos', bg: [] };
}
const PROMPT_MAX = 200;
const str = (v) => (typeof v === 'string' ? v : undefined);
function oneLine(text) {
    const t = text.replace(/\s+/g, ' ').trim();
    return t.length > PROMPT_MAX ? t.slice(0, PROMPT_MAX) : t;
}
const STATUSES = new Set(['pending', 'in_progress', 'completed']);
function todoOf(o) {
    const status = str(o.status) ?? 'pending';
    if (!STATUSES.has(status))
        return undefined;
    const text = (status === 'in_progress' ? str(o.activeForm) : undefined) ?? str(o.content) ?? '';
    return text ? { text, status: status } : undefined;
}
/** A prompt entering: the user's or a plugin's. A task notification only settles its shell. */
export function onPrompt(s, text, origin, now) {
    if (origin === 'task-notification') {
        onNotification(s, text);
        return;
    }
    const t = oneLine(promptSummary(text));
    if (!t)
        return;
    s.prompt = t;
    s.since = now;
}
export function onTurnEnd(s, now) {
    s.idle = true;
    s.since = now;
    s.tool = undefined;
}
export function onToolStart(s, e, now) {
    s.tool = { id: String(e.tool_use_id ?? ''), text: doingText(e), since: now };
    s.idle = false;
}
/** A main-loop tool's result: todo lists, background shells, a stopped task. */
export function onToolResult(s, e, result, now) {
    if (s.tool && s.tool.id === String(e.tool_use_id ?? ''))
        s.tool = undefined;
    const r = (result && typeof result === 'object' ? result : {});
    switch (e.tool) {
        case 'TodoWrite': {
            const list = Array.isArray(r.newTodos) ? r.newTodos : Array.isArray(e.todos) ? e.todos : undefined;
            if (!list)
                return;
            s.todos = list.flatMap(t => (t && typeof t === 'object' ? [todoOf(t)].filter(x => x !== undefined) : []));
            s.list = 'todos';
            return;
        }
        case 'TaskCreate': {
            const task = r.task;
            const id = str(task?.id);
            const subject = str(task?.subject) ?? str(e.subject);
            if (!id || !subject)
                return;
            s.tasks = [...s.tasks.filter(t => t.id !== id), { id, text: subject, status: 'pending' }];
            s.list = 'tasks';
            return;
        }
        case 'TaskUpdate': {
            if (r.success === false)
                return;
            const id = str(e.taskId);
            const t = id ? s.tasks.find(x => x.id === id) : undefined;
            if (!t)
                return;
            const status = str(e.status);
            if (status === 'deleted')
                s.tasks = s.tasks.filter(x => x !== t);
            else if (status && STATUSES.has(status))
                t.status = status;
            const active = str(e.activeForm);
            const subject = str(e.subject);
            if (t.status === 'in_progress' && active)
                t.text = active;
            else if (subject)
                t.text = subject;
            s.list = 'tasks';
            return;
        }
        case 'TaskStop': {
            const id = str(r.task_id) ?? str(e.task_id) ?? str(e.shell_id);
            if (id)
                s.bg = s.bg.filter(b => b.taskId !== id);
            return;
        }
        case 'Bash': {
            const taskId = str(r.backgroundTaskId);
            if (!taskId || s.bg.some(b => b.taskId === taskId))
                return;
            const toolUseId = str(e.tool_use_id);
            s.bg.push({ taskId, ...(toolUseId ? { toolUseId } : {}), text: shellText(str(e.command) ?? '') || doingText(e), since: now });
            return;
        }
    }
}
/** A background command as the waiting row names it: past its `cd`, without redirects. */
export function shellText(command) {
    return command
        .replace(/^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*(?:&&|;)\s*/, '')
        .replace(/\s+\d*>.*$/, '')
        .replace(/\s+&\s*$/, '')
        .replace(/\s+/g, ' ')
        .trim();
}
/** `<task-notification>` text: the shell it names is done. */
export function onNotification(s, text) {
    const ids = [...text.matchAll(/<(task-id|tool-use-id)>\s*([^<\s]+)\s*<\/\1>/g)].map(m => m[2]);
    if (ids.length === 0)
        return;
    s.bg = s.bg.filter(b => !ids.includes(b.taskId) && !(b.toolUseId && ids.includes(b.toolUseId)));
}
export function nowOf(s) {
    if (s.prompt === undefined && !s.tool)
        return undefined;
    return {
        ...(s.prompt !== undefined ? { prompt: s.prompt } : {}),
        since: s.since,
        idle: s.idle && !s.tool,
        ...(s.tool ? { tool: { text: s.tool.text, since: s.tool.since } } : {}),
    };
}
export function todosOf(s) {
    const list = s.list === 'tasks' ? s.tasks : s.todos;
    return list.map(t => ({ text: t.text, status: t.status }));
}
export function waitingOf(s) {
    return s.bg.map(b => ({ text: b.text, since: b.since }));
}
