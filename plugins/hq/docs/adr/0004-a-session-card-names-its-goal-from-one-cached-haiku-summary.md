# A session card names its goal from one cached Haiku summary of the session's transcript, refreshed only when the session moved

- Status: accepted
- Date: 2026-10-08

## Context

An other-session card was named by the newest `ai-title` in its transcript ([0002](0002-a-session-owns-only-the-prs-it-created-pushed-or-has-checked-out.md)). That title is rewritten from the latest prompt, so a multi-day session showed "269 merged whats next", which says nothing outside that session. The transcript (`~/.claude/projects/<cwd, non-alphanumerics as ->/<sessionId>.jsonl`, 6.3 MB for monolense) also holds `pr-link` entries (`prNumber`, `prUrl`, `prRepository`, `timestamp`), compaction summaries (`isCompactSummary`, whose text opens with "1. Primary Request and Intent:"), `gitBranch` on most entries, user prompts, prompts typed while busy as `queued_command` attachments with `origin.kind: "human"`, and assistant replies (`stop_reason: "end_turn"`). Many sessions never compact. Every `~/.claude/tasks/session-<id8>/` directory on this machine was empty, so task lists come from `TaskCreate`/`TaskUpdate`/`TodoWrite` calls in the transcript or from the session's own HQ publish file.

Two registry facts from the same day: a terminal front-end (`kind: "interactive"`) and the background session it drives (`kind: "bg"`) are paired by `parkedJobId` on the front-end equalling `jobId` on the background row; an unclaimed warm helper carries `spare: true` and a `name` equal to its id.

## Decision

- **Card lines.** Line 1: goal, then `day N` (calendar days since the transcript's first timestamp) and status. Line 2: the summary's step and the PR counts, else the old repo/branch detail. Line 3: `todos done/total` and the in-progress item, only when a list exists. Then agents as before. The "this session" card opens with the goal and day.
- **One model call.** `$.model.complete` with `model: "haiku"` (the types document the alias as resolved like `--model`), `effort: "low"`, `maxTokens: 200`, `timeoutMs: 30000`, asking for JSON `{goal ≤6 words, step ≤8 words}`.
- **Input, by priority, at most 6,000 characters:** the latest compaction's intent part; the first real prompt; the distinct `ai-title` history in order; PR titles and ticket ids from PR titles and branch names; task subjects; the last 5 prompts; the first 300 characters of the last 3 replies. Each section is capped and the budget is filled in that order.
- **Refresh rule.** A summary is made on first sight, on a compaction newer than the cached one, after 5 prompts newer than the cached one, or every 30 minutes while the session is busy and its transcript moved since. Never while idle with nothing new. A failure keeps the old value and waits 5 minutes, and is retried only while busy or after new content; with nothing cached the card shows the newest AI title, else the first prompt.
- **Cache and sharing.** `$.store` key `goal:<sessionId>`; the store persists across sessions, and whether concurrently running instances see each other's writes was not verified. Before calling, an instance re-reads the key and writes a `failedAt` lease, which bounds duplicate calls where writes are shared; only one call runs at a time per instance, and the tick never awaits it. A session running HQ publishes its own goal in `~/.claude/hq/sessions/<sessionId>.json`, and others use that while fresh instead of calling.
- **Reading transcripts.** First sight of a transcript over 1 MB is a sparse scan: the first 256 KB, one `grep` for titles, PR links, compactions and task calls, one `grep -o` for `gitBranch`, and the last 1 MB. After that only the appended bytes are read (`tail -c +offset`), whole lines only.
- **PR counts.** Deduplicated by URL. Merged or closed from a `pr-watch` state file is final; the rest of the 20 most recently linked PRs are read with one `gh api graphql` call per repo, at most every 10 minutes, and open ones are re-read on that cadence. PRs not looked up count as "linked".
- **Self and spares.** Rows paired with this session by `parkedJobId`/`jobId` are this session (its tmux target comes from the front-end); `spare: true` rows are hidden; a name that is only the session or job id is ignored.

## Consequences

- Easier: a card says what a session is for and where it is; the cost is bounded to one Haiku call of at most 6,000 input characters per session per compaction, per 5 prompts, or per 30 busy minutes.
- Harder: HQ now spends model tokens and makes GraphQL calls; it depends further on the undocumented transcript and registry formats (`pr-link`, `queued_command`, `parkedJobId`, `spare`).
- Owed: prompts older than the last 1 MB of a large transcript are not seen until new ones arrive; task lists for sessions without HQ and without task calls in the transcript are not shown.

## As built (2026-10-08): ids are glossed

Ticket ids (`[A-Z]{2,5}-\d+`) and ADR numbers (`ADR 0019`, `ADR-19`) on goal, step and agent lines carry a gloss of at most 5 words after their first occurrence per line. Ticket titles come from `linear issue show <id>` (at most 3 per tick, never awaited), ADR titles from `<repo toplevel>/docs/adr/NNNN-*.md` or `design/*/adr/` (first `# ` heading, else the slug). Titles are cached in `$.store` as `gloss:<id>` or `gloss:adr:<root>:<NNNN>`, refreshed after 24 h, retried 30 min after a failure, and compressed by one batched Haiku call per tick; without its answer the gloss is the title's first 5 words. Resolved titles also enter the goal input, and a goal summary waits up to 20 s for them.

## Alternatives considered

- **Keep the AI title:** it tracks the latest prompt, not the goal.
- **The compaction summary alone:** many sessions never compact.
- **Summarise on every poll or on every new prompt:** cost grows with activity for no visible change.
- **`gh pr view` per PR:** up to 20 calls per session where one GraphQL call per repo does.
- **Read the whole transcript each poll:** multi-MB files, and `$.fs.read` refuses over 4 MiB.
