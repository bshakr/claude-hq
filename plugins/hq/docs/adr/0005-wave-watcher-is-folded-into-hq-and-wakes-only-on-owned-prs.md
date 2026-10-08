# wave-watcher is folded into HQ: HQ toasts and wakes on its owned PRs' transitions, and wave-watcher is deleted

- Status: accepted
- Date: 2026-10-08

## Context

[0001](0001-hq-is-one-session-scoped-pane-reading-watcher-state.md) said `/hq` replaces `/prs` and that wave-watcher would be retired once `/hq` worked. [0002](0002-a-session-owns-only-the-prs-it-created-pushed-or-has-checked-out.md) then kept wave-watcher alive in a narrowed role: it read HQ's publish file `~/.claude/hq/sessions/<sessionId>.json` and woke a session only for PRs listed in its `owned`.

What wave-watcher still did, as built: per session, every 60 s, `gh search prs --author=@me --state=open` plus one `gh pr view` per hit; a pane with six styles (classic, d1–d5) behind `/prs`; a toast in every session for every transition of any of the user's PRs; `$.prompt.submit` for owned PRs on CI going red, a merge with other open PRs in the repo, conflicts and falling behind, behind `/prs wake on|off` (default on); and a `wave:` status line counting owned PRs. HQ already sets one status entry, already knows which PRs a session owns, and already reads their state from the `pr-watch` files and its own `gh pr view` refresh. Two mods meant two GitHub pollers and two status entries for the same PRs.

## Decision

- **Kept, in HQ** (`hooks/data/wake.ts`): transition detection between ticks over HQ's owned PRs: CI passed or running to failed; open to merged, listing the other owned open PRs in that repo; mergeable or blocked to conflicting or behind. A PR seen for the first time, a stale row and a close without merge are not transitions, so the first tick after a start or reload is silent. The toast and prompt texts are wave-watcher's, prefixed `[hq]`; a merge with no other owned open PR toasts and does not wake.
- **Toasts** fire in the owning session only; there is no global PR list to toast from.
- **Waking**: one `$.prompt.submit` per tick with every wake line, unless `/hq wake off`. The toggle is HQ's `$.store` key `wake` (absent means on); wave-watcher's own stored value is not carried over.
- **Status line**: still one entry, HQ's. Its owned PRs are appended as `PRs 2 green · 1 red · …` (green, running, red, conflict, rebase, merged); with no owned PRs nothing is added, and an empty status clears the entry as before.
- **Dropped**: the wave pane and its six styles, `/prs`, the `gh search prs --author=@me` poller and its error status line, and the read of HQ's publish file (HQ's owned list is in memory).
- `plugins/wave-watcher` is deleted.

## Consequences

- Easier: one mod, one status entry and one source of PR state; no per-session 60 s search of every authored PR.
- Harder: CI, conflict and behind transitions are seen only from a `pr-ci-wait` / `pr-merge-wait` state file. An unwatched owned PR is re-read with `gh pr view --json title,url,state` every 2 minutes, which carries no checks or mergeability, so it can only produce the merged transition, up to 2 minutes late. A `gh pr merge` the session runs itself marks the PR merged on the next tick, so that session is woken about its other owned open PRs too.
- Owed: a session without HQ loaded, and a PR no session owns (created on the web, on a branch no session pushed or checked out), get no toast or wake at all.

## Alternatives considered

- **Keep wave-watcher with the owned filter (0002):** a second poller and status entry for PRs HQ already tracks.
- **Port its search poller into HQ:** reintroduces the global PR view that 0002 scoped away.
- **Keep the pane as an HQ view:** HQ's pull requests card already shows the owned PRs with their checks.
- **Toast every authored PR in every session:** the noise 0002 set out to remove; ownership now decides toasts too.
