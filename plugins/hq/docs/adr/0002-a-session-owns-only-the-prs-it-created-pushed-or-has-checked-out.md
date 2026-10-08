# A session owns only the PRs it created, pushed or has checked out, and wave-watcher wakes only that session

- Status: accepted; the "Other sessions" naming by `aiTitle` is superseded by [0004](0004-a-session-card-names-its-goal-from-one-cached-haiku-summary.md)
- Date: 2026-10-08

## Context

[0001](0001-hq-is-one-session-scoped-pane-reading-watcher-state.md) made PR ownership auto-claim: any `gh pr view/checks/edit/merge/comment/diff`, `pr-ci-wait` or `pr-merge-wait` that named a PR claimed it. Two failures followed on 2026-10-08:

- wave-watcher runs once per session, polls `gh search prs --author=@me`, and called `$.prompt.submit` on transitions of any of the user's PRs, so a session in `~` was woken for bshakr/monolense merges another session was driving.
- HQ showed bshakr/monolense#275 as open with "no checks · unknown" after it merged. The stored claim had `ghState: "OPEN"` and `looked: true`, and `~/.cache/pr-watch/` held no file for #275. A claim without a watcher file took its state from one `gh pr view` at claim time and was never read again, so a merge without a running watcher was never seen. The same store showed #273, #274 and #275 claimed at one instant and an unrelated #1 claimed, which is what reading-as-claiming produces.

Subagent tool calls are visible to the mod: `tool.call`'s input is `ToolCallEnvelope & AgentLoop`, whose `agentId` is present in a subagent's loop and absent on the main loop.

## Decision

- **Ownership.** A session owns a PR when (a) it or one of its subagents created it (`gh pr create`: the URL in its output, or the URL in the Bash result's `gitOperation.pr` when its `action` is `"created"`) or pushed its head branch (`git push`: `gitOperation.push.branch`, else the `To <remote>` and `src -> dst` lines of the push output, else the branch checked out where it ran); or (b) the session's cwd, a subagent's worktree, or a directory a command `cd`'d into or pushed from with `git -C` is a checkout of the PR's repo on the PR's head branch (`main` and `master` excluded). Viewing, checking, commenting on, merging or waiting on a PR claims nothing.
- **Branch to PR.** A pushed or checked-out branch is resolved with `gh pr list --head <branch> --state open`, at most every 2 minutes per branch until an open PR is found; a pushed branch with no PR after 24 hours is dropped (a branch still checked out is claimed again on the next tick). Ownership is acquired, not held: checking out `main` after a merge keeps the PR owned until the existing 30-minute drop after it ended.
- **Freshness.** Watchers stay the poller while one runs for a PR. An owned, unended PR with no live watcher is re-read with `gh pr view` every 2 minutes, and a GitHub read newer than a watcher file's `updatedAt` overrides that file's OPEN with MERGED or CLOSED. A `gh pr merge` this session runs ends the PR at once from `gitOperation.pr`. This replaces 0001's "at most one `gh pr view` per claim".
- **One source of truth.** HQ keeps ownership in `$.state` (`hq.owned`, declared in its contract, so a reload keeps it) and `$.store` under `owned:<sessionId>`, a new key so the old auto-claims are not restored. HQ publishes it as `owned` in `~/.claude/hq/sessions/<sessionId>.json`.
- **wave-watcher wakes only owners.** Every session still toasts every transition; `$.prompt.submit` fires only for transitions on PRs listed in this session's published `owned`, and the merged prompt's "other open PRs in that repo" lists only owned PRs. No file or no owner means toast only.
- **The pane.** "current session" shows `now` (last prompt, in-flight tool in plain words, idle after the turn), `todos` (TodoWrite or TaskCreate/TaskUpdate, at most three items) and `waiting` (background Bash calls until their task notification or TaskStop) above agents, all main-loop only. An agent's detail is one `doing` line: its own in-progress todo with progress, else its Bash call's `description`, else a verb for the file tool; the `in <path>` line is gone and a worktree other than the session's is named on the agent's header row. "pull requests" is a top-level section after "other sessions" and lists only owned PRs. (As built 2026-10-08: these sit in one "this session" card, todos as one progress line with the active item, and the pull requests card appears only when there are owned PRs; see ADR 0001.)
- **Other sessions.** Self is found by session id, else by the pid its registry row had, so a `/clear` (new session id, same pid) neither lists this session among the others nor leaves its old publish file: the id is re-read every tick and the old file removed. Each other session is named by the newest `aiTitle` in its transcript (`~/.claude/projects/<cwd>/<sessionId>.jsonl`), else its first prompt, else the registry name, with a dim line of repo or worktree, branch when not main, and its published `doing` (todo progress or current work).

## Consequences

- Easier: a PR wakes the one session working on it; reading a PR in a scratch session costs nothing; a merge with no watcher running reaches HQ within about 2 minutes.
- Harder: HQ now calls GitHub itself (one `gh pr view` per unwatched owned PR and one `gh pr list` per unresolved branch, every 2 minutes), so it is no longer read-only towards GitHub. wave-watcher depends on HQ's publish file; without HQ loaded it only toasts. Session titles depend on the undocumented transcript format.
- Owed: a PR created entirely outside this session (another tool, the web) on a branch this session never pushed or checked out is not owned.

## Alternatives considered

- **Keep auto-claim on any `gh pr` verb:** reading a PR is not working on it; it caused the wrong wakes.
- **wave-watcher reads `hq.owned` through a plugin dependency:** couples the two mods' load order for no gain; the publish file already exists and missing HQ degrades to toast-only.
- **Ownership held only while the branch is checked out:** a `git checkout main` after a merge would drop the PR at the moment its merge needs to wake the owner.
- **A global PR poller:** wave-watcher already polls per session; the gap was ownership and freshness, not polling.
