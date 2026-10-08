// The session's own main loop: last prompt, in-flight tool, todo list, background shells.
import type { ActivityState, BgShell, TaskTodo } from '../../types'
import type { NowVM, TodoVM, WaitingVM } from '../model/types'
import { promptSummary } from '../model/plain'
import { doingText } from './doing'

export type { ActivityState, BgShell, TaskTodo }

export function emptyActivity(): ActivityState {
  return { since: 0, idle: true, todos: [], tasks: [], list: 'todos', bg: [] }
}

const PROMPT_MAX = 200

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

function oneLine(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > PROMPT_MAX ? t.slice(0, PROMPT_MAX) : t
}

const STATUSES = new Set(['pending', 'in_progress', 'completed'])

function todoOf(o: Record<string, unknown>): TodoVM | undefined {
  const status = str(o.status) ?? 'pending'
  if (!STATUSES.has(status)) return undefined
  const text = (status === 'in_progress' ? str(o.activeForm) : undefined) ?? str(o.content) ?? ''
  return text ? { text, status: status as TodoVM['status'] } : undefined
}

/** A prompt entering: the user's or a plugin's. A task notification only settles its shell. */
export function onPrompt(s: ActivityState, text: string, origin: string | undefined, now: number): void {
  if (origin === 'task-notification') {
    onNotification(s, text)
    return
  }
  const t = oneLine(promptSummary(text))
  if (!t) return
  s.prompt = t
  s.since = now
}

export function onTurnEnd(s: ActivityState, now: number): void {
  s.idle = true
  s.since = now
  s.tool = undefined
}

export function onToolStart(s: ActivityState, e: { tool: string } & Record<string, unknown>, now: number): void {
  s.tool = { id: String(e.tool_use_id ?? ''), text: doingText(e), since: now }
  s.idle = false
}

/** A main-loop tool's result: todo lists, background shells, a stopped task. */
export function onToolResult(s: ActivityState, e: { tool: string } & Record<string, unknown>, result: unknown, now: number): void {
  if (s.tool && s.tool.id === String(e.tool_use_id ?? '')) s.tool = undefined
  const r = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>
  switch (e.tool) {
    case 'TodoWrite': {
      const list = Array.isArray(r.newTodos) ? r.newTodos : Array.isArray(e.todos) ? e.todos : undefined
      if (!list) return
      s.todos = list.flatMap(t => (t && typeof t === 'object' ? [todoOf(t as Record<string, unknown>)].filter(x => x !== undefined) : []))
      s.list = 'todos'
      return
    }
    case 'TaskCreate': {
      const task = r.task as { id?: unknown; subject?: unknown } | undefined
      const id = str(task?.id)
      const subject = str(task?.subject) ?? str(e.subject)
      if (!id || !subject) return
      s.tasks = [...s.tasks.filter(t => t.id !== id), { id, text: subject, status: 'pending' }]
      s.list = 'tasks'
      return
    }
    case 'TaskUpdate': {
      if (r.success === false) return
      const id = str(e.taskId)
      const t = id ? s.tasks.find(x => x.id === id) : undefined
      if (!t) return
      const status = str(e.status)
      if (status === 'deleted') s.tasks = s.tasks.filter(x => x !== t)
      else if (status && STATUSES.has(status)) t.status = status as TodoVM['status']
      const active = str(e.activeForm)
      const subject = str(e.subject)
      if (t.status === 'in_progress' && active) t.text = active
      else if (subject) t.text = subject
      s.list = 'tasks'
      return
    }
    case 'TaskStop': {
      const id = str(r.task_id) ?? str(e.task_id) ?? str(e.shell_id)
      if (id) s.bg = s.bg.filter(b => b.taskId !== id)
      return
    }
    case 'Bash': {
      const taskId = str(r.backgroundTaskId)
      if (!taskId || s.bg.some(b => b.taskId === taskId)) return
      const toolUseId = str(e.tool_use_id)
      s.bg.push({ taskId, ...(toolUseId ? { toolUseId } : {}), text: shellText(str(e.command) ?? '') || doingText(e), since: now })
      return
    }
  }
}

/** A background command as the waiting row names it: past its `cd`, without redirects. */
export function shellText(command: string): string {
  return command
    .replace(/^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*(?:&&|;)\s*/, '')
    .replace(/\s+\d*>.*$/, '')
    .replace(/\s+&\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Each `<task-notification>`'s task and tool-use ids, with its `<status>` when it has one. */
export function notificationsOf(text: string): { id: string; status?: string }[] {
  const out: { id: string; status?: string }[] = []
  for (const block of text.split('<task-notification>').slice(1)) {
    const status = /<status>\s*([^<\s]+)\s*<\/status>/.exec(block)?.[1]
    for (const m of block.matchAll(/<(task-id|tool-use-id)>\s*([^<\s]+)\s*<\/\1>/g)) out.push({ id: m[2]!, ...(status ? { status } : {}) })
  }
  return out
}

/** `<task-notification>` text: the shell it names is done. */
export function onNotification(s: ActivityState, text: string): void {
  const ids = notificationsOf(text).map(n => n.id)
  if (ids.length === 0) return
  s.bg = s.bg.filter(b => !ids.includes(b.taskId) && !(b.toolUseId && ids.includes(b.toolUseId)))
}

export function nowOf(s: ActivityState): NowVM | undefined {
  if (s.prompt === undefined && !s.tool) return undefined
  return {
    ...(s.prompt !== undefined ? { prompt: s.prompt } : {}),
    since: s.since,
    idle: s.idle && !s.tool,
    ...(s.tool ? { tool: { text: s.tool.text, since: s.tool.since } } : {}),
  }
}

export function todosOf(s: ActivityState): TodoVM[] {
  const list = s.list === 'tasks' ? s.tasks : s.todos
  return list.map(t => ({ text: t.text, status: t.status }))
}

export function waitingOf(s: ActivityState): WaitingVM[] {
  return s.bg.map(b => ({ text: b.text, since: b.since }))
}
