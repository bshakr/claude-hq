import { expect, test } from 'claude-code/testing'

import { emptyActivity, nowOf, onPrompt, onToolResult, onToolStart, onTurnEnd, todosOf, waitingOf } from '../../hooks/data/activity'
import { doingLine } from '../../hooks/data/model'

test('now: the prompt, then the in-flight tool in plain words, cleared on its result; idle after the turn', () => {
  const s = emptyActivity()
  onPrompt(s, 'Fix the stale PR list\nmore detail', 'composer', 1_000)
  s.idle = false
  onToolStart(s, { tool: 'Bash', tool_use_id: 't1', command: 'gh pr checks 276', description: 'Check CI on 276' }, 2_000)
  expect(nowOf(s)).toEqual({
    prompt: 'Fix the stale PR list more detail',
    since: 1_000,
    idle: false,
    tool: { text: 'Check CI on 276', since: 2_000 },
  })
  onToolResult(s, { tool: 'Bash', tool_use_id: 't1', command: 'gh pr checks 276' }, { stdout: '' }, 3_000)
  expect(nowOf(s)?.tool).toBe(undefined)
  onTurnEnd(s, 4_000)
  expect(nowOf(s)).toEqual({ prompt: 'Fix the stale PR list more detail', since: 4_000, idle: true })
})

test('todos: TodoWrite results replace the list; TaskCreate and TaskUpdate keep their own', () => {
  const s = emptyActivity()
  onToolResult(
    s,
    { tool: 'TodoWrite', tool_use_id: 'x', todos: [] },
    {
      oldTodos: [],
      newTodos: [
        { content: 'Read', status: 'completed', activeForm: 'Reading' },
        { content: 'Write', status: 'in_progress', activeForm: 'Writing the layout' },
        { content: 'Test', status: 'pending', activeForm: 'Testing' },
      ],
    },
    1,
  )
  expect(todosOf(s)).toEqual([
    { text: 'Read', status: 'completed' },
    { text: 'Writing the layout', status: 'in_progress' },
    { text: 'Test', status: 'pending' },
  ])
  expect(doingLine({ todos: todosOf(s) })).toBe('1/3 · Writing the layout')

  onToolResult(s, { tool: 'TaskCreate', tool_use_id: 'c1', subject: 'Ship', description: 'd' }, { task: { id: '1', subject: 'Ship' } }, 2)
  onToolResult(
    s,
    { tool: 'TaskCreate', tool_use_id: 'c2', subject: 'Review', description: 'd' },
    { task: { id: '2', subject: 'Review' } },
    2,
  )
  onToolResult(
    s,
    { tool: 'TaskUpdate', tool_use_id: 'u1', taskId: '1', status: 'in_progress', activeForm: 'Shipping' },
    { success: true, taskId: '1', updatedFields: ['status'] },
    3,
  )
  expect(todosOf(s)).toEqual([
    { text: 'Shipping', status: 'in_progress' },
    { text: 'Review', status: 'pending' },
  ])
  onToolResult(
    s,
    { tool: 'TaskUpdate', tool_use_id: 'u2', taskId: '2', status: 'deleted' },
    { success: true, taskId: '2', updatedFields: ['status'] },
    4,
  )
  expect(todosOf(s).length).toBe(1)
})

test('waiting: a background Bash waits until its notification, TaskStop, or never for a foreground one', () => {
  const s = emptyActivity()
  onToolResult(
    s,
    { tool: 'Bash', tool_use_id: 'b1', command: 'cd ~/code/m && pr-ci-wait 276 > /tmp/log 2>&1', run_in_background: true },
    { stdout: '', backgroundTaskId: 'bg1' },
    10,
  )
  onToolResult(
    s,
    { tool: 'Bash', tool_use_id: 'b2', command: 'pr-merge-wait 276', run_in_background: true },
    { stdout: '', backgroundTaskId: 'bg2' },
    20,
  )
  onToolResult(s, { tool: 'Bash', tool_use_id: 'b3', command: 'ls' }, { stdout: 'x' }, 30)
  expect(waitingOf(s)).toEqual([
    { text: 'pr-ci-wait 276', since: 10 },
    { text: 'pr-merge-wait 276', since: 20 },
  ])
  onPrompt(s, '<task-notification>\n<task-id>bg1</task-id>\n<status>completed</status>\n</task-notification>', 'task-notification', 40)
  expect(waitingOf(s).map(w => w.text)).toEqual(['pr-merge-wait 276'])
  expect(nowOf(s)).toBe(undefined)
  onToolResult(
    s,
    { tool: 'TaskStop', tool_use_id: 's1', task_id: 'bg2' },
    { message: 'stopped', task_id: 'bg2', task_type: 'local_bash' },
    50,
  )
  expect(waitingOf(s)).toEqual([])
})

test('now: a subagent hand-back or a plugin message reads as what it says, never as raw tags', () => {
  const s = emptyActivity()
  const handBack = [
    '<agent-message from="a08a1f">',
    '[Subagent hand-back] The text below is the final report of a subagent. The report follows:',
    '  **Status line fixed, and the gates are green.** Next I would tidy the legend.',
    '</agent-message>',
  ].join('\n')
  onPrompt(s, handBack, 'agent-message', 1)
  expect(nowOf(s)?.prompt).toBe('agent reported: Status line fixed, and the gates are green.')
  onPrompt(s, '<agent-message from="b1">\n[Subagent hand-back]\n## Done\nAll `three` specs pass.', undefined, 2)
  expect(nowOf(s)?.prompt).toBe('agent reported: All three specs pass.')
  onPrompt(s, 'The wave-watcher plugin sent a message:\n[wave-watcher] acmeco/webapp-ui#273 merged. Rebase #275?\nmore', 'plugin', 3)
  expect(nowOf(s)?.prompt).toBe('wave-watcher: acmeco/webapp-ui#273 merged. Rebase #275?')
  onPrompt(s, '<system-reminder>note</system-reminder> Ship <b>it</b>', 'composer', 4)
  expect(nowOf(s)?.prompt).toBe('note Ship it')
})
