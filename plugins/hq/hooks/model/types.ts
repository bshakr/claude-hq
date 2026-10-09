// Contract between the data layer (hooks/data/*) and the pane (hooks/ui/*).
// The data layer produces a HqModel; the pane only renders it.

export type Tone = 'broken' | 'waiting' | 'progress' | 'done' | 'quiet'

export interface Counts {
  waiting: number
  broken: number
  inProgress: number
  sessions: number
}

/** A session's terminal, read from its process: tty and the env keys focus strategies use. */
export interface TermEnv {
  tty?: string
  env: Readonly<Record<string, string>>
}

/** Where Enter/click goes: focus a session's terminal (else copy its resume command), or open a web URL. */
export type Jump =
  | { kind: 'tmux'; target: string } // e.g. "acme-store:@3.%6"
  | { kind: 'url'; url: string }
  | {
      kind: 'session'
      sessionId: string
      cwd: string
      pid: number
      tmux?: string
      bg?: true
      jobId?: string
      openIn?: string
      term: TermEnv
    }

export interface Flare {
  text: string // "st-api is waiting for your input"
  sinceMs: number
  tmuxTarget: string
  jump: Jump
}

/** A tool call open this long renders as waiting (a spec run, `pr-ci-wait`). */
export const LONG_CALL_MS = 120_000

export type AgentStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'killed' | 'pending'

export interface AgentVM {
  id: string
  parentId?: string
  title: string // the Agent call's description
  status: AgentStatus
  model?: string // "opus" | "sonnet" | "haiku" | resolved id
  background: boolean
  startedAt: number
  endedAt?: number
  toolCount: number
  /** "doing" line: its latest tool call in plain words, or what it waits on, or the error. */
  now?: string
  /** Its own in-progress todo (activeForm) and the list's progress, when it keeps one. */
  todo?: { text: string; done: number; total: number }
  /** Start of its in-flight tool call; a long one renders as waiting. */
  callSince?: number
  /** Repo or worktree name, set only when it works somewhere other than the session. */
  place?: string
  /** "in" line: worktree and files touched, most recent first. */
  worktree?: string
  files: string[]
  /** one-line outcome once finished (first line of its result). */
  outcome?: string
  tokens?: number
}

export type CiState =
  | { kind: 'none' } // no state file yet
  | { kind: 'registering' } // watcher armed, checks not registered yet
  | { kind: 'running'; done: number; total: number; failed: number }
  | { kind: 'passed'; total: number }
  | { kind: 'failed'; done: number; total: number; failed: number; firstFailing: string }
  | { kind: 'skippedRequired'; name: string }

export type MergeState = 'mergeable' | 'conflicting' | 'behind' | 'blocked' | 'unknown' | 'merged' | 'closed'
export type Watcher = 'ci-wait' | 'merge-wait' | 'none'
export type Gallery = 'linked' | 'no-visual-change' | 'none' | 'unknown'

export interface PrVM {
  repo: string // "owner/name"
  number: number
  title: string
  url: string
  ci: CiState
  merge: MergeState
  gallery: Gallery
  watcher: Watcher
  /** epoch ms of the watcher's last poll, from its state file */
  polledAt?: number
  mergedAt?: number
  claimedBy: 'main' | string // agent id that first touched it
  /** a watcher's latest poll failed: values are the last good ones, not current */
  stale?: boolean
}

/** What a session waits on the user for; `turn` is the low-priority "your turn" after a reply. */
export type WaitKind = 'permission' | 'question' | 'plan' | 'turn'

export interface WaitVM {
  kind: WaitKind
  /** "Bash: rm -rf tmp/", a question's text, "approve the plan". */
  text: string
  /** A question's option labels. */
  options?: string[]
  since: number
}

export interface OtherSessionVM {
  sessionId: string
  name: string // session name or cwd basename
  tmuxTarget?: string // "webapp-ui:@3.%7"
  windowLabel: string // "@3 ENG-1940-promote"
  status: 'busy' | 'idle' | 'waiting'
  waitingFor?: string // "input needed", "dialog open"
  statusSince?: number
  /** dim second line: repo or worktree · branch (not main) · its published doing line */
  detail?: string
  /** from that session's own /hq publish file, when it runs /hq */
  agentsRunning?: number
  prSummary?: { total: number; broken: number; waiting: number; inProgress: number }
  /** The open PRs it owns, from its publish file. */
  prs?: PrVM[]
  /** Its running subagents, newest first: from its publish file, else its subagent transcripts. */
  agents?: OtherAgentVM[]
  jump?: Jump
  /** Calendar day of the session, 1 on the day its transcript starts. */
  day?: number
  /** Where the work is, from the goal summary. */
  step?: string
  /** "12 PRs merged, 1 open" over the PRs its transcript links. */
  prText?: string
  todos?: TodoProgress
  /** Brief glosses of the ticket ids and ADR numbers its lines name, by id ("ENG-1947", "ADR 0019"). */
  glosses?: Record<string, string>
  /** What it waits on the user for; a real wait (not `turn`) also makes `status` waiting. */
  wait?: WaitVM
  /** Its context window's fill. */
  context?: ContextUsage
  /** A background session no front-end is attached to. */
  background?: true
}

/** A session's context fill: live from its own HQ, else estimated from its transcript. */
export interface ContextUsage {
  /** Whole percent of `window`, 0 to 100. */
  percent: number
  window: number
  tokens?: number
  model?: string
  source: 'live' | 'transcript'
}

/** The account's rate-limit windows, percent used as the engine reports it. */
export interface AccountUsage {
  fiveHour?: number
  week?: number
}

/** A task list's progress and its in-progress item. */
export interface TodoProgress {
  done: number
  total: number
  active?: string
}

/** Another session's running subagent. */
export interface OtherAgentVM {
  id: string
  title: string
  model?: string
  startedAt: number
  /** Its latest tool call in plain words. */
  doing?: string
  /** A tool call still open after LONG_CALL_MS: what it runs and since when. */
  waiting?: { text: string; since: number }
}

export interface TmuxGroupVM {
  tmuxSession: string // "webapp-ui"
  /** Background sessions with no front-end, drawn apart from sessions outside tmux. */
  background?: true
  sessions: OtherSessionVM[]
}

/** The session's own main loop: what it was asked and is running now. */
export interface NowVM {
  /** The last user or plugin prompt. */
  prompt?: string
  since: number
  /** True once the turn completed. */
  idle: boolean
  /** The in-flight tool call, in plain words. */
  tool?: { text: string; since: number }
}

export interface TodoVM {
  text: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** A background shell the session started and has not heard back from. */
export interface WaitingVM {
  text: string
  since: number
}

export interface HqModel {
  now: number
  counts: Counts
  flare?: Flare
  current: {
    label: string // e.g. "webapp-ui:@1 · ENG-1940-promote"
    /** The session's goal summary and calendar day. */
    goal?: { text: string; day?: number; step?: string }
    /** Repo or folder name: the card's title once there is a goal. */
    title?: string
    now?: NowVM
    todos?: TodoVM[]
    waiting?: WaitingVM[]
    agents: AgentVM[]
    prs: PrVM[]
    /** Brief glosses of the ticket ids and ADR numbers its lines name, by id ("ENG-1947", "ADR 0019"). */
    glosses?: Record<string, string>
    context?: ContextUsage
  }
  others: TmuxGroupVM[]
  /** Plan usage, account-wide, shown once in the header. */
  account?: AccountUsage
  /** plain text for $.ui.status */
  statusText: string
}

/** What each session's /hq writes to ~/.claude/hq/sessions/<sessionId>.json for the others to read. */
export interface PublishedSession {
  sessionId: string
  pid: number
  updatedAt: number
  agentsRunning: number
  prSummary: { total: number; broken: number; waiting: number; inProgress: number }
  /** "3/7 · Rewriting PR claim rules": todo progress and the in-progress item, or the last prompt. */
  doing?: string
  /** Its running subagents, newest first, at most a few. */
  agents?: OtherAgentVM[]
  /** The PRs this session owns. */
  owned?: { repo: string; number: number }[]
  /** Its open owned PRs as its own pane draws them, so other cards can list and link them. */
  prs?: PrVM[]
  /** Its task list's progress, so others need not reconstruct it from the transcript. */
  todos?: TodoProgress
  /** Its own goal summary, so other sessions reuse it instead of asking the model again. */
  goal?: { goal?: string; step?: string; at: number }
  /** What it waits on the user for right now. */
  waiting?: WaitVM
  /** Its live context fill, as the engine reports it. */
  context?: ContextUsage
  /** The account's rate limits as this session last saw them. */
  account?: AccountUsage
}

/** Written by pr-ci-wait / pr-merge-wait to ~/.cache/pr-watch/<owner>__<repo>__<n>.<watcher>.json (owner/repo lowercased) each poll. */
export interface PrWatchState {
  version: 1
  repo: string
  number: number
  watcher: 'ci-wait' | 'merge-wait'
  pid: number
  updatedAt: string // ISO
  headSha: string
  title?: string
  url?: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  mergeable?: string // GitHub's mergeable
  mergeStateStatus?: string // GitHub's mergeStateStatus
  checks: { name: string; status: string; conclusion: string | null; required?: boolean }[]
  body?: string // for gallery detection; may be omitted
  exited?: { code: number; at: string; reason: string }
  /** true when the latest poll failed; the other fields are from the last good read */
  stale?: boolean
  lastOkAt?: string // ISO
}
