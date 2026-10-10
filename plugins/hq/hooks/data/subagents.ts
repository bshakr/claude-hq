// Another session's subagents, read from Claude Code's own files when that session does not publish them.
import { LONG_CALL_MS } from '../model/types'
import type { OtherAgentVM } from '../model/types'

export { LONG_CALL_MS }
import { doingText } from './doing'
import { sampleOf } from './usage'

/** A transcript untouched this long is not running, whatever its last line says. */
export const AGENT_FRESH_MS = 120_000
/** Bytes read from the end of a transcript; one tool result line can run to a few hundred KB. */
export const TAIL_BYTES = 262_144
export const OTHER_AGENTS_MAX = 3
/** An open call older than this, with its session not busy, is a dead agent rather than a long call. */
export const OPEN_CALL_CAP_MS = 2 * 60 * 60_000

/** `~/.claude/projects/<cwd, non-alphanumerics as ->/<sessionId>/subagents`. */
export function subagentsDir(home: string, cwd: string, sessionId: string): string {
  return `${home}/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, '-')}/${sessionId}/subagents`
}

export interface AgentMeta {
  description?: string
  model?: string
}

export function parseMeta(text: string): AgentMeta {
  try {
    const v = JSON.parse(text) as Record<string, unknown>
    return {
      ...(typeof v.description === 'string' ? { description: v.description } : {}),
      ...(typeof v.model === 'string' ? { model: v.model } : {}),
    }
  } catch {
    return {}
  }
}

export interface AgentTail {
  /** The agent handed back (`toolEndsTurn` on the SubagentHandback result) or ended its turn in text (`stop_reason: end_turn`). */
  ended: boolean
  doing?: string
  /** The oldest tool call with no result yet: the agent is inside it, however old the file is. */
  open?: { text: string; since?: number }
  /** Its latest response's context size and model. */
  tokens?: number
  model?: string
}

type Entry = {
  type?: string
  timestamp?: string
  toolEndsTurn?: boolean
  message?: { stop_reason?: string | null; content?: unknown; usage?: unknown; model?: unknown }
}

/** The end of a subagent transcript; `cut` drops the first line, which a byte tail splits. */
export function parseTail(text: string, cut: boolean): AgentTail {
  const lines = text.split('\n')
  if (cut) lines.shift()
  let last: Entry | undefined
  let doing: string | undefined
  let sample: ReturnType<typeof sampleOf>
  const open = new Map<string, { text: string; since?: number }>()
  for (const line of lines) {
    if (!line.trim()) continue
    let v: Entry
    try {
      v = JSON.parse(line) as Entry
    } catch {
      continue
    }
    if (v.type !== 'user' && v.type !== 'assistant') continue
    last = v
    if (v.type === 'assistant') sample = sampleOf(v.message, 0) ?? sample
    if (!Array.isArray(v.message?.content)) continue
    for (const b of v.message!.content as Record<string, unknown>[]) {
      if (v.type === 'user') {
        if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') open.delete(b.tool_use_id)
        continue
      }
      if (b?.type !== 'tool_use' || typeof b.name !== 'string') continue
      const input = b.input && typeof b.input === 'object' ? (b.input as Record<string, unknown>) : {}
      doing = doingText({ ...input, tool: b.name })
      const at = v.timestamp ? Date.parse(v.timestamp) : NaN
      if (typeof b.id === 'string') open.set(b.id, { text: doing, ...(Number.isFinite(at) ? { since: at } : {}) })
    }
  }
  const stop = last?.type === 'assistant' ? last.message?.stop_reason : undefined
  const ended = last?.toolEndsTurn === true || (typeof stop === 'string' && stop !== 'tool_use')
  const first = ended ? undefined : [...open.values()][0]
  return {
    ended,
    ...(doing ? { doing } : {}),
    ...(first ? { open: first } : {}),
    ...(sample ? { tokens: sample.tokens, ...(sample.model ? { model: sample.model } : {}) } : {}),
  }
}

export interface ListedFile {
  name: string
  kind: string
  size: number
  mtimeMs: number
}

/** Transcripts that may be running: touched within `maxAgeMs`, newest first. */
export function freshTranscripts(entries: readonly ListedFile[], now: number, maxAgeMs = AGENT_FRESH_MS): ListedFile[] {
  return entries
    .filter(e => e.kind === 'file' && /^agent-[A-Za-z0-9]+\.jsonl$/.test(e.name) && now - e.mtimeMs < maxAgeMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
}

export interface RunningAgent {
  id: string
  meta: AgentMeta
  startedAt: number
  tail: AgentTail
  /** Transcript mtime: the open call's start when its entry has no timestamp. */
  mtimeMs?: number
}

/**
 * Whether a tail still runs: not ended, and either written within AGENT_FRESH_MS or inside an open call.
 * An open call past OPEN_CALL_CAP_MS counts as ended unless the parent session is busy.
 */
export function isRunning(tail: AgentTail, mtimeMs: number, now: number, parentBusy: boolean): boolean {
  if (tail.ended) return false
  if (now - mtimeMs < AGENT_FRESH_MS) return true
  if (!tail.open) return false
  const since = tail.open.since ?? mtimeMs
  return parentBusy || now - since < OPEN_CALL_CAP_MS
}

/** This session's agent inside one call for LONG_CALL_MS or more, as another session's pane shows it. */
export function longCall(a: { status: string; callSince?: number; now?: string }, now: number): OtherAgentVM['waiting'] {
  if (a.status !== 'running' || a.callSince === undefined || now - a.callSince < LONG_CALL_MS) return undefined
  return { text: a.now ?? 'working', since: a.callSince }
}

/** Running agents, newest started first, as the pane's rows; a call open past LONG_CALL_MS is `waiting`. */
export function otherAgents(running: readonly RunningAgent[], now = 0): OtherAgentVM[] {
  return running
    .filter(a => !a.tail.ended)
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(a => {
      const o = a.tail.open
      const since = o ? (o.since ?? a.mtimeMs) : undefined
      const waiting = o && since !== undefined && now - since >= LONG_CALL_MS ? { text: o.text, since } : undefined
      const model = a.meta.model ?? a.tail.model
      return {
        id: a.id,
        title: a.meta.description || a.id,
        startedAt: a.startedAt,
        ...(model ? { model } : {}),
        ...(a.tail.tokens ? { tokens: a.tail.tokens } : {}),
        ...(a.tail.doing ? { doing: a.tail.doing } : {}),
        ...(waiting ? { waiting } : {}),
      }
    })
}
