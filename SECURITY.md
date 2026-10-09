# Security

## Reporting a vulnerability

Report it privately through GitHub: [Security → Report a vulnerability](https://github.com/bshakr/claude-hq/security/advisories/new) on `bshakr/claude-hq`. Please do not open a public issue for it.

Say what an attacker can do, the steps to reproduce it, and the HQ and Claude Code versions (`claude plugin list`, `claude --version`). You will get a reply in the advisory thread; a fix ships as a new release, with the advisory published once it is out.

## Scope

The code in this repo: the plugin in `plugins/hq`, the `pr-ci-wait` and `pr-merge-wait` scripts in `plugins/hq/bin`, and the marketplace file. What it touches on your machine:

- reads Claude Code's local session files under `~/.claude/`
- writes its own session summaries to `~/.claude/hq/sessions/`, and a theme file under `~/.claude/themes/` when you run `/hq match-bg`
- runs `git`, `gh`, `tmux`, `linear`, `open` and `osascript`
- sends a session's prompts and titles to Haiku through your Claude account when `summaries` is on
- fetches its published `plugin.json` from raw.githubusercontent.com once a day when `updateCheck` is on

Bugs in Claude Code itself, `gh`, `tmux` or your terminal belong to those projects.

## Supported versions

The latest release only. Fixes are not backported.
