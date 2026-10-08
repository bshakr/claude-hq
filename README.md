# claude-hq

**One pane for every Claude Code session on your machine, and the one that needs you.**

Run a few Claude Code sessions, each with its own subagents and pull requests, and it gets hard to tell which one is blocked on a permission prompt, which one's CI just went red, and which one is fine. HQ is a Claude Code mod that docks a pane beside your conversation and answers that at a glance.

<p align="center"><img src="docs/hq.png" alt="The HQ pane: one card for this session, one per other session, with what each is doing and which one needs you" width="560"></p>

```
 ◆ 1 waiting on you · 2 working                  5h 12% · wk 31%

 ╭─ this session ─────────────────────────────────────────────╮
 │                                                            │
 │  Retry flaky checkout webhooks           day 2  ▰▰▰▱▱ 41%  │
 │  ● fix the retry backoff                               3m  │
 │    Bash: npm test                                     40s  │
 │  todos 1/3 ━━━─────  ● Running the webhook specs           │
 │                                                            │
 ╰────────────────────────────────────────────────────────────╯

 ╭─ work ─────────────────────────────────────────────────────╮
 │  api               1 PR · day 1 · ◆ waiting 2m  ▰▰▰▰▱ 63%  │
 │  Migrating the orders table                                │
 │  ◆ asks: Bash: rails db:migrate                            │
 │                                                            │
 │  docs                                ● busy 6m  ▰▰▱▱▱ 22%  │
 │  ENG-123 (setup guide): drafting the install steps         │
 │  ● Check links                                 haiku · 1m  │
 ╰────────────────────────────────────────────────────────────╯

 ╭─ pull requests ────────────────────────────────────────────╮
 │  #212  Webhooks: retry with backoff        ▰▰▰▰▰▰▱▱▱▱ 5/9  │
 │        ci running · no gallery · ci-wait                   │
 ╰────────────────────────────────────────────────────────────╯
```

## What you get

- **This session at a glance.** What it is doing right now, its todo list, the background commands it waits on, and each subagent with its model, age and latest step.
- **Every other session.** A one-line goal and current step (summarised by Haiku), its day count, context fill, PR counts and running agents. Ticket and ADR ids get a few-word gloss.
- **"Asks: …" when a session waits on you.** A permission prompt, a question or a plan to approve shows on its card, and you get a desktop notification once per new wait.
- **One press to get there.** Click or Enter on a session brings its terminal forward. If HQ can't find the terminal, it copies the resume command instead.
- **Your PRs, with checks.** The PRs this session owns, with a checks bar and merge state. Click one to open it.
- **Wake on CI red, merge or conflict.** When an owned PR goes red, merges, conflicts or falls behind, HQ toasts and starts a turn in the owning session to triage it. It never merges or pushes.
- **Plan usage in the header.** Your 5-hour and weekly limits, next to the count of what needs you.

## Install

At the prompt of a Claude Code session in a terminal:

```
/plugin install hq --marketplace bshakr/claude-hq
```

Answer `y` to add the marketplace, then pick a scope (user scope is first; press Enter). The pane opens by itself at the start of each session on a wide terminal; type `/hq` to open it any time.

**Focus key (recommended).** Plugins can't ship keybindings, so add one yourself to `~/.claude/keybindings.json`. It moves the keys between the prompt and the pane:

```json
{
  "bindings": [
    { "context": "Chat", "bindings": { "ctrl+g": "abovePrompt:focus" } }
  ]
}
```

**PR watchers.** The plugin bundles `pr-ci-wait <pr>` (waits until every check settles) and `pr-merge-wait <pr>…` (waits until a PR merges, closes or conflicts). Claude Code puts them on the Bash tool's PATH, so Claude can run them in the background. Each poll writes a small state file under `~/.cache/pr-watch/`, and HQ reads those instead of polling GitHub itself. Sessions open before the install need a restart to see them.

## Requirements

| | Needed for | Without it |
| --- | --- | --- |
| Claude Code 2.1.295+ | the plugin API (function hooks, panes) | HQ does not load. The API is early access and may change. |
| `git` | repo, branch and PR ownership | no owned PRs |
| `gh`, logged in | PR titles, checks and merge state | PRs show with no state |
| `jq` | `pr-ci-wait` | no watcher state; HQ falls back to `gh` |
| `tmux` or a supported terminal | bringing a session forward | a press copies the resume command |
| `linear` CLI (optional) | glossing ticket ids | ids show bare |

Developed on macOS. Linux works for reading and for tmux, but opening a PR uses `open`, which is macOS only.

Running Claude Code inside tmux? Set CLAUDE_CODE_TMUX_TRUECOLOR=1 so hex colours aren't reduced to 256.

## What counts as yours

A session owns only the PRs it created, pushed, or has checked out. A PR another session is driving shows on that session's card, not in your list, and only its owner gets woken when it changes. Other sessions are grouped by tmux session, the ones waiting on you first.

## Privacy

- HQ reads Claude Code's local files: the session registry, transcripts and subagent transcripts under `~/.claude/`. Each HQ writes a short summary of its own session to `~/.claude/hq/sessions/` for the others to read.
- **Goal line:** up to 6,000 characters from a session's transcript (first prompt, titles, the latest compaction summary, task subjects, recent prompts) go to Haiku through your own Claude account. It refreshes only when the session moved: a compaction, 5 new prompts, or every 30 minutes while busy.
- **Glosses:** ticket and ADR titles go to Haiku in batches of up to 12.
- No telemetry. Nothing else leaves the machine, apart from the `gh` and `linear` calls you are already logged in for. Set `summaries` to `false` (or run `/hq summaries off`) to stop every model call; see [Configuration](#configuration).

## Configuration

HQ reads its defaults from the plugin's settings. Change them in `/config` (each field is a row there) or in `~/.claude/settings.json` under `pluginConfigs`, keyed by how the plugin was loaded:

- installed with `/plugin install hq --marketplace bshakr/claude-hq`: `pluginConfigs["hq@claude-hq"].options`
- run from a checkout with `claude --plugin-dir plugins/hq`: `pluginConfigs["hq@inline"].options` (a bare `"hq"` key is read too)

A change reloads HQ with the new values.

| Field | Default | Does |
| --- | --- | --- |
| `colorBroken` | `ansi256(1)` | failed checks, broken PRs, conflicts |
| `colorWaiting` | `ansi256(3)` | a session or agent waiting on you, the asks line |
| `colorWorking` | `ansi256(4)` | running dots and their dim pulse, checks in progress, busy sessions |
| `colorDone` | `ansi256(2)` | passed checks, merged PRs, plan usage bars |
| `colorAccent` | `ansi256(6)` | the focus bar and the cursor marker |
| `colorDim` | `ansi256(8)` | borders of quiet cards and rules |
| `summaries` | `true` | Haiku goal lines and id glosses; off makes no model calls, cards show the AI title or first prompt and ids show bare |
| `wake` | `true` | default for `/hq wake` |
| `notify` | `true` | default for `/hq notify` |
| `autoOpen` | `true` | open the pane by itself once per session (unasked, it is drawn from 144 columns, or 110 once you have opened it with `/hq`) |

Colours take `#rrggbb`, `ansi256(N)` or a bare palette number `N` (0-255). The defaults are your terminal's own palette slots, so HQ follows your terminal theme. An invalid colour keeps its default and the pane's footer shows one dim line naming it.

`/hq wake`, `/hq notify` and `/hq summaries` on or off are kept per machine and win over these settings on that machine.

Catppuccin Mocha:

```json
{
  "pluginConfigs": {
    "hq@claude-hq": {
      "options": {
        "colorBroken": "#f38ba8",
        "colorWaiting": "#f9e2af",
        "colorWorking": "#89b4fa",
        "colorDone": "#a6e3a1",
        "colorAccent": "#94e2d5",
        "colorDim": "#6c7086"
      }
    }
  }
}
```

## Works with

A press tries each host that could hold the session, in this order, then falls back to copying `claude --resume` (or `claude attach` for a background session).

| Host | Status |
| --- | --- |
| tmux | verified |
| supacode | verified |
| Terminal.app | scripts compile; not run on a real machine |
| zellij, WezTerm, kitty, iTerm2, cmux, VS Code, Cursor | untested |
| Ghostty and other apps | untested; raises the app, not the tab |

iTerm2 and Terminal.app ask for Automation permission the first time.

## Commands

| Command | Does |
| --- | --- |
| `/hq` | open the pane |
| `/hq close` | close the pane |
| `/hq wake on` / `off` | start a turn when an owned PR goes red, merges, conflicts or falls behind (on by default); off means toasts only |
| `/hq notify on` / `off` | a desktop notification when another session starts waiting on you; `/hq notify` shows the setting |
| `/hq summaries on` / `off` | Haiku goal lines and id glosses on cards; `/hq summaries` shows the setting |
| `/hq help` | the list above |

In the pane: `j`/`k` or Tab to move, Enter or click to open, Enter on an agent to expand it, Esc to go back to the prompt.

## Contributing

Issues and PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for running it from a checkout and the checks.

## License

[MIT](LICENSE)
