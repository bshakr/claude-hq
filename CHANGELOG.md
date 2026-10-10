# Changelog

Each release has a section headed `## X.Y.Z`; the release workflow publishes that section as the GitHub release notes.

## 0.1.5

- Meters are small dots again (`•••··`), lit in green, yellow from 50% or red from 80%; the rounded pill is gone.

## 0.1.4

- Agents get their own glyphs: the main agent is `✻` and each subagent `✢`, coloured by model (fable, opus, sonnet, haiku; each colour is configurable), with model, context size and run time on the right. Background shells show as a dim `$` under the main agent.
- A busy session's card takes the working border colour. A session whose main loop is idle while its subagents run counts as busy, not "your turn".
- Other sessions' cards list their running subagents, one line each.
- Meters are a rounded pill growing inside an outline track (needs a Nerd Font), green, yellow from 50%, red from 80%.
- A blank row separates a card's top lines from its first section.

## 0.1.3

- Pressing a session that runs in Ghostty (1.3 or later) brings forward its own tab, quick terminal included, instead of only raising Ghostty. The first press asks once for permission to control Ghostty. When several tabs share the session's folder and none carries its title, Ghostty is raised as before.

## 0.1.2

- `/hq match-bg <#hex>` paints Claude Code's side panel your terminal background colour, so the pane no longer sits on a grey or brown block. It updates your custom theme, or writes an `hq-<base>` theme to pick once in `/theme`.
- "Your turn" on another session counts from its last reply, not from the session's last heartbeat.
- PR rows no longer show a "gallery linked / no gallery" fact, and the PR watchers no longer fetch PR bodies.

## 0.1.1

- Hovering a row reads like the keyboard cursor: its title turns bold, a PR title underlined too, instead of the light inverted block. Other Buttons in the pane no longer invert under the pointer either.

## 0.1.0

First release.

- One pane for every Claude Code session on the machine: a card per session with its goal, what it is doing, its context fill, its agents and its open PRs with CI state.
- A session waiting on you turns its card yellow and sends one desktop notification.
- Enter or a click brings a session's terminal forward (tmux, supported terminal apps, background sessions), or copies its resume command.
- Wakes a session when a PR it owns goes red, merges, conflicts or falls behind.
- `pr-ci-wait` and `pr-merge-wait` on the Bash tool's PATH.
- Plan usage in the header and a status line naming the session waiting on you.
- A dim header line when a newer HQ is out, and `/hq update` to install it.
