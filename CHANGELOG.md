# Changelog

Each release has a section headed `## X.Y.Z`; the release workflow publishes that section as the GitHub release notes.

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
