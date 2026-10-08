# claude-hq

**HQ** is a [Claude Code](https://claude.com/claude-code) plugin that puts one pane beside your conversation showing every Claude Code session on the machine, and what needs you:

- **This session**: what it is doing now, its todo list, and the subagents it is running (model, age, status).
- **Other sessions**: each one's goal and current step, its own agents and todos, and how long it has been going. Click a session (or press Enter on it) to switch to its tmux pane.
- **Owned PRs**: the pull requests this session created, pushed or has checked out, with CI and merge state. Click one to open it.
- **Needs you**: the header counts what is broken (failed agents, red or conflicting PRs) and what is waiting on you (sessions waiting for input, PRs that are behind or blocked).

HQ only reads and shows. A press opens a PR in the browser or switches tmux; it never types into another session, merges, or pushes.

## Screenshots

_Coming soon._

## Install

At the prompt of a Claude Code session in a terminal:

```
/plugin install hq --marketplace bshakr/claude-hq
```

Answer `y` to add the marketplace, then pick a scope (user scope is first; press Enter). Then type `/hq` to open the pane, `/hq close` to close it, `/hq help` for the keys.

### Focus key (recommended)

The pane's buttons sit in the same focus ring as the band above the prompt. Bind a key to reach it in `~/.claude/keybindings.json`:

```json
{
  "bindings": [
    { "context": "Chat", "bindings": { "ctrl+g": "abovePrompt:focus" } }
  ]
}
```

The pane's own hint says `⌃g focus`; if `ctrl+g` already does something for you, pick another key. Plugins cannot ship keybindings, so this step is manual.

### PR watchers (bundled)

The plugin ships two shell scripts in [`plugins/hq/bin/`](plugins/hq/bin):

- `pr-ci-wait <pr>`: polls a PR until every check settles, then exits once with the result.
- `pr-merge-wait <pr> [<pr> ...]`: waits until a PR merges, closes, or starts conflicting.

Claude Code puts an enabled plugin's `bin/` folder on the Bash tool's PATH, so once HQ is installed Claude can run them directly (best with `run_in_background`, which costs no tokens while waiting). The PATH is captured when a session starts: restart sessions that were open before the install. Each poll writes `~/.cache/pr-watch/<owner>__<repo>__<n>.<watcher>.json`, and HQ reads those files instead of polling GitHub itself. HQ reads only that default location, so leave `PR_WATCH_STATE_DIR` unset.

To use them from your own shell as well:

```sh
ln -s "$(claude plugin list --json | jq -r '.[] | select(.id | startswith("hq@")) | .installPath')"/bin/pr-* ~/.local/bin/
```

## Requirements

| Tool | Needed for | Without it |
| --- | --- | --- |
| Claude Code 2.1.295 or newer | the plugin API (function hooks, panes) | does not load. The API is marked early access and may change between releases. |
| `git` | which repo and branch a session is on, PR ownership | no owned PRs |
| `gh`, logged in | PR titles and states (`gh pr view`, `gh pr list`, `gh api graphql`) | PRs show as linked, with no state |
| `grep`, `head`, `tail`, `ps` | reading transcripts, checking which sessions are alive | required (present on macOS and Linux) |
| `jq` | `pr-ci-wait` (required), `pr-merge-wait` state files (optional) | no watcher state; HQ falls back to `gh` |
| `tmux` | switching to another session's pane | sessions show, but a press does nothing |
| `linear` CLI | a few words of title beside Linear ticket ids | ids show bare |
| `perl` | a hard timeout on each `gh` call in `pr-merge-wait` | calls are unbounded |

**macOS and Linux.** HQ is developed on macOS. Opening a PR uses `open`, which is macOS-only; on Linux, clicking a PR currently fails with a short message (switching tmux works). Everything else is portable.

## How it works

Each session's HQ reads Claude Code's own local files: the session registry in `~/.claude/sessions/`, transcripts in `~/.claude/projects/`, and subagent transcripts beside them. It also publishes a short summary of its own session to `~/.claude/hq/sessions/<sessionId>.json` for the other sessions' panes to read, and removes it when it is stale.

A session **owns** only the PRs it created, pushed, or has checked out; PRs another session is driving do not show up as yours. The decisions, with their reasons and trade-offs, are recorded as ADRs:

- [0001: HQ is one session-scoped pane reading watcher state](plugins/hq/docs/adr/0001-hq-is-one-session-scoped-pane-reading-watcher-state.md)
- [0002: a session owns only the PRs it created, pushed or has checked out](plugins/hq/docs/adr/0002-a-session-owns-only-the-prs-it-created-pushed-or-has-checked-out.md)
- [0003: HQ draws each group as a rounded card](plugins/hq/docs/adr/0003-hq-draws-each-group-as-a-rounded-card.md)
- [0004: a session card names its goal from one cached Haiku summary](plugins/hq/docs/adr/0004-a-session-card-names-its-goal-from-one-cached-haiku-summary.md)

## Privacy

- HQ reads your local Claude Code transcripts for every session on the machine. Nothing leaves the machine except the two model calls below and `gh` / `linear` calls you are already logged in for.
- **Goal line.** To name each session's goal, HQ sends at most 6,000 characters drawn from that session's transcript (first prompt, title history, latest compaction summary, PR titles, task subjects, the last few prompts and replies) to Claude Haiku through your own Claude account, the same way Claude Code makes its own calls. It refreshes only when a session moved: on a compaction, after 5 new prompts, or every 30 minutes while busy.
- **Id glosses.** Titles of the Linear tickets and ADRs a session mentions are sent, in small batches, to Haiku for a few-word brief.
- **No off switch yet.** There is no setting to turn the model calls off; that is a known gap. Uninstalling or disabling the plugin (`/plugin`) stops them.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

[MIT](LICENSE) © Bassem Shaker
