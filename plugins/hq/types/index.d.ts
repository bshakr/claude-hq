/** Key of a pane row: `flare`, `finished`, `a:<agent id>`, `p:<repo>#<n>` or `s:<session id>`; null before any. */
export type HqCursor = string | null

export type OwnReason = 'created' | 'pushed' | 'checkout'

/** A PR this session owns, as kept in `$.state` and `$.store`. */
export interface StoredClaim {
  repo: string
  number: number
  claimedBy: string
  claimedAt: number
  reason?: OwnReason
  /** From `gh pr view` / `gh pr list` (or the state file). */
  title?: string
  url?: string
  ghState?: string
  /** When `ghState` was last read from GitHub; drives the refresh of unwatched PRs. */
  checkedAt?: number
  /** First time this layer saw it merged or closed; drives the 30 min drop. */
  endedAt?: number
}

/** A branch this session pushed or has checked out, owned until its open PR is found. */
export interface BranchClaim {
  repo: string
  branch: string
  claimedBy: string
  claimedAt: number
  reason: OwnReason
  lookedAt?: number
  /** `gh pr list --head` lookups that found no PR since the last push; spaces out the next one. */
  misses?: number
  /** The open PR found for it; the branch is then settled. */
  number?: number
}

/** Ownership as kept across a reload (`$.state`) and a restart (`$.store`). */
export interface OwnedState {
  claims: StoredClaim[]
  branches: BranchClaim[]
}

export interface BgShell {
  text: string
  since: number
  taskId: string
  toolUseId?: string
}

export interface TaskTodo {
  text: string
  status: 'pending' | 'in_progress' | 'completed'
  id: string
}

export interface ActivityState {
  prompt?: string
  since: number
  idle: boolean
  tool?: { id: string; text: string; since: number }
  /** From TodoWrite: the whole list each call. */
  todos: { text: string; status: 'pending' | 'in_progress' | 'completed' }[]
  /** From TaskCreate / TaskUpdate, by task id. */
  tasks: TaskTodo[]
  /** Which of the two lists was written last. */
  list: 'todos' | 'tasks'
  bg: BgShell[]
}

declare module 'claude-code' {
  interface PluginState {
    hq: {
      /** +1 whenever the data layer's model changes; the pane reads it to redraw. */
      rev: number
      /** Key of the row the cursor is on (`flare`, `a:<id>`, `p:<repo>#<n>`, `s:<sessionId>`). */
      cursor: HqCursor
      /** Agent ids shown expanded inline; `+finished` when the older finished agents are shown. */
      expanded: string[]
      /** First body row shown in the pane's window. */
      scroll: number
      /** Motion phase: +1 every 2 s while the pane is open and something runs. */
      phase: number
      /** PRs and branches this session owns (ADR 0002); kept here so a reload keeps them. */
      owned: OwnedState
      /** The main loop's last prompt, in-flight tool, todo list and background shells. */
      activity: ActivityState
    }
  }
}
