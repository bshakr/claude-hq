# /hq is one session-scoped, show-and-jump pane that reads the PR watchers' state files instead of polling GitHub

- Status: accepted; the "PR ownership is auto-claim" bullet is superseded by [0002](0002-a-session-owns-only-the-prs-it-created-pushed-or-has-checked-out.md), the "Name and shape" layout by [0003](0003-hq-draws-each-group-as-a-rounded-card.md)
- Date: 2026-10-08

## Context

The command-centre mod was previously `/prs` (the wave-watcher). `pr-ci-wait` and `pr-merge-wait` ([bshakr/agent-skills](https://github.com/bshakr/agent-skills)) already cost zero tokens while waiting and wake the session once. Their gaps were visibility, manual arming and surviving a restart, not efficiency.

The founder runs the same setup on a work Mac (Nory) and a personal Mac, with the main Claude session fullscreen.

Design round: round 1 directions (Skyline Paper, Inbox, Switchboard, Atlas) in the [gallery](https://claude.ai/artifact/PAATQWdCePZUvi9juQpKNq); the chosen direction is the [Unified round 3 mockup](https://claude.ai/artifact/2f8KzKZ9cHmoSZhPreVqed).

## Decision

- **Name and shape.** `/hq` replaces `/prs`. One unified scrolling pane, no tabs: a pinned header with counts and a "needs you" flare line; this session's agents first, each with three detail lines (task / now / in); this session's PRs, each with a 10-cell checks bar whose length is finished checks / total; other Claude sessions on this machine, compact, grouped by tmux session; the legend follows the content. The user's own `statusline.sh` stays; `/hq` adds one plain status line.
- **Colour.** Red = broken, yellow = waiting on you, blue = in progress.
- **Show and jump only.** Enter or click opens a PR URL or switches tmux (`tmux switch-client`). The pane takes no actions.
- **Focus.** `ctrl+g` is bound to `abovePrompt:focus` in `~/.claude/keybindings.json` (`ctrl+d` is reserved for exit and cannot be rebound).
- **PR ownership is auto-claim.** A session owns the PRs it or its subagents create or act on via `gh`, `pr-ci-wait` or `pr-merge-wait`. There is no global watcher.
- **One poller.** `pr-ci-wait` / `pr-merge-wait` stay the only GitHub pollers and write a per-PR state file, `~/.cache/pr-watch/<owner>__<repo>__<n>.json` ([bshakr/agent-skills#12](https://github.com/bshakr/agent-skills/pull/12)). `/hq` only reads those files, plus at most one `gh pr view` per claim for title and URL.
- **Fleet data.** Other sessions come from Claude Code's `~/.claude/sessions/<pid>.json` registry (tmux target, status, waitingFor). Each `/hq` instance publishes `~/.claude/hq/sessions/<sessionId>.json` (subagent count, PR summary) so the others can show it.
- **Scope is one machine.** The mod is installed on both Macs; each instance shows only its own machine.

## Consequences

- Easier: one place to see what needs the founder; no extra GitHub polling or token cost; PRs are tracked without manual arming.
- Harder: `/hq` depends on the undocumented session registry and on an engine theme key, either of which may change between Claude Code releases. j/k navigation inside a pane is constrained by the engine (Client elements only get keys after a click).
- Owed: the build decides between Button-row navigation and a Client element; the state-file change lands with [bshakr/agent-skills#12](https://github.com/bshakr/agent-skills/pull/12); wave-watcher is retired once `/hq` works.

## Alternatives considered

- **Skyline checks chart** (round 1): bar height only re-encoded colour.
- **Switchboard** (round 1): rejected by the founder in the design round.
- **`/hq` polling GitHub itself:** the existing scripts were already efficient; the gaps were visibility, arming and restart survival, which a state file closes without a second poller.
- **A global PR watcher:** auto-claim scopes PRs to the session that touched them.
- **Actions in the pane:** rejected; the pane is show-and-jump only.
- **Cross-machine view:** rejected; each machine is scoped to itself.
- **Fleet in a tmux popup:** deferred; the founder runs the main Claude session fullscreen, so the fleet lives inside Claude Code.
- **`ctrl+d` for focus:** reserved for exit and cannot be rebound.
