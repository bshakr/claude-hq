# A press on a session tries each host that could hold it, in turn, then copies its resume command

- Status: accepted
- Date: 2026-10-08

## Context

Enter or a click on a session card only ran `tmux switch-client`, so a session outside tmux was drawn but could not be reached. Many people run Claude in a plain terminal tab, in an editor's terminal, in supacode, or as a background session. `~/.claude/sessions/<pid>.json` gives pid, cwd, kind and the tmux target, but no tty or terminal. The process does: `ps eww -o pid=,tty=,command= -p …` prints each pid's tty and environment on macOS and Linux.

## Decision

- The data tick reads new sessions' tty and environment in the one `ps` it already runs for liveness (`eww` only when a pid is new), keeps only an allowlist of keys (`hooks/data/term.ts`), and caches the result per pid until the process dies. Secrets in the rest of the environment are never kept.
- A detected session's jump is `{ kind: 'session', … }`. `hooks/ui/focus.ts` holds the strategies, each detected from env and tty alone and run with a 3 s timeout; the first that reports success wins (`hooks/ui/jump.ts`). A command that is missing, fails or times out is a miss, never an error.
- Order, multiplexers first because their panes inherit the outer terminal's env, which names the wrong pane:

| Strategy | Detected by | Runs | Verified |
| --- | --- | --- | --- |
| tmux | registry `tmux` target | `tmux switch-client -t`, `select-pane`, then `open -b <__CFBundleIdentifier>` | live on this Mac; switch-client works from outside tmux (it picks the latest client) |
| zellij | `ZELLIJ_PANE_ID`, `ZELLIJ_SESSION_NAME` | `zellij --session S action focus-pane-id terminal_N` | unverified |
| supacode | `SUPACODE_WORKTREE_ID/TAB_ID/SURFACE_ID` | `supacode surface focus -w -t -s` | CLI help on this Mac; not run against a live surface |
| WezTerm | `WEZTERM_PANE` | `wezterm cli activate-pane --pane-id N` | unverified (not installed) |
| kitty | `KITTY_WINDOW_ID` | `kitten @ [--to $KITTY_LISTEN_ON] focus-window --match id:N` (needs remote control) | unverified |
| iTerm2 | `TERM_PROGRAM=iTerm.app` and a tty | JXA: select the session whose `tty` matches | compiles; unverified (not installed) |
| Terminal | `TERM_PROGRAM=Apple_Terminal` and a tty | JXA: select the tab whose `tty` matches | compiles; not run (would launch Terminal and ask for Automation access) |
| cmux | `CMUX_PANE_ID` | `cmux focus-pane --pane X`, only when `cmux --help` lists it | unverified |
| editor | `TERM_PROGRAM=vscode` | `code <cwd>` or `cursor <cwd>`: raises the window holding that folder | unverified; `cursor` CLI present |
| app | `__CFBundleIdentifier` (Ghostty, Warp, Alacritty, …) | `open -b <id>`: raises the app, not the tab | Ghostty's id confirmed on this Mac |

- Fallback: a background session copies `claude attach <jobId>`; anything else copies `cd <cwd> && claude --resume <sessionId>`, through `$.ui.copy`, and the toast says so (or shows the command when nothing was copied). Only the fallback toasts. A card no strategy applies to shows a dim `↵ copies resume`.
- As built (2026-10-09): a background session with no front-end attached (its front-end exited, the worker lives on under the daemon) is grouped under `background`, not `no tmux`. When the viewer is in tmux, a press runs `tmux new-window -t <viewer's session>: -c <cwd> -n <jobId> claude attach <jobId>`; otherwise it copies `claude attach <jobId>` and the toast says to paste it in a terminal.

## Consequences

- Every live session is reachable; a terminal the chain does not know still gets its app raised when it sets a bundle id.
- Linux gets tmux, zellij, WezTerm, kitty, editors and the fallback; no window activation (`open -b` only runs when the env carries a macOS bundle id).
- iTerm2 and Terminal ask for Automation permission on first use; until granted, they fall through to raising the app.
- Ghostty cannot be targeted by tty, so a Ghostty session outside tmux raises Ghostty, not its tab.
- An undetected row (ps failed) keeps the old tmux-only jump; the next tick retries.

## Alternatives considered

- **`claude --resume` for background sessions:** it starts a second process on a session that is still running; `claude attach` opens the running one.
- **`code -r <cwd>`:** reuses the last active window, replacing another project's workspace.
- **Walking the parent chain to find the terminal app:** inside tmux the terminal is not an ancestor; the environment names it either way.
- **Detecting at press time:** the card needs to know beforehand whether to show the hint.
