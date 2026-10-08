// Subagent transcript lines in the shape Claude Code writes to ~/.claude/projects/<cwd>/<sessionId>/subagents/agent-<id>.jsonl, trimmed to the keys HQ reads.

const line = (v: Record<string, unknown>) => `${JSON.stringify({ isSidechain: true, agentId: 'run1', sessionId: 'w1', ...v })}\n`

const assistant = (content: unknown[], stop_reason: string | null = null) =>
  line({ type: 'assistant', message: { role: 'assistant', type: 'message', model: 'claude-opus-5-5', content, stop_reason } })
const toolResult = (id: string, extra: Record<string, unknown> = {}) =>
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, ...extra })
const attachment = line({ type: 'attachment', attachment: { type: 'todo_reminder' } })

export const meta = (description: string, model: string) =>
  JSON.stringify({ agentType: 'general-purpose', description, toolUseId: 'toolu_01', spawnDepth: 1, requestShape: 'background', model })

const prompt = line({ type: 'user', message: { role: 'user', content: 'Implement the guard.' } })

/** Mid-work: a text block streamed with no stop reason, then a Bash call and its result, then an attachment. */
export const running =
  prompt +
  assistant([{ type: 'text', text: 'Running the specs now.' }]) +
  assistant([{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/app/models/card.rb' } }]) +
  toolResult('t1') +
  assistant([{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'bin/rspec spec/ledger', description: 'Run ledger specs' } }]) +
  toolResult('t2') +
  attachment

/** Ended through SubagentHandback: its result carries `toolEndsTurn`. */
export const handedBack =
  running +
  assistant([{ type: 'tool_use', id: 't3', name: 'SubagentHandback', input: { message: '**Done.** All green.' } }]) +
  toolResult('t3', { toolEndsTurn: true }) +
  attachment

/** Appended to `running`: a final text answer, `stop_reason: end_turn`. */
export const endTurn = assistant([{ type: 'text', text: 'All specs pass.' }], 'end_turn')

/** Handed back but its result not yet written: still running, reads as reporting back. */
export const handingBack = running + assistant([{ type: 'tool_use', id: 't3', name: 'SubagentHandback', input: { message: 'x' } }])

/** Appended to `running`: a call still open (no result yet), started at `at`. */
export const openCall = (at: number) =>
  line({
    type: 'assistant',
    timestamp: new Date(at).toISOString(),
    message: {
      role: 'assistant',
      type: 'message',
      model: 'claude-opus-5-5',
      stop_reason: null,
      content: [{ type: 'tool_use', id: 't9', name: 'Bash', input: { command: 'pr-ci-wait 275', description: 'Wait for CI on #275' } }],
    },
  })
