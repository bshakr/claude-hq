# A session card says what the session waits on you for, captured by that session's own HQ, and HQ notifies once per new wait

- Status: accepted
- Date: 2026-10-08

## Context

"N waiting on you" counted sessions whose registry row said `waiting`, and the card said only "waiting". [0001](0001-hq-is-one-session-scoped-pane-reading-watcher-state.md) lists a `waitingFor` field in the registry. On Claude Code 2.1.295, `~/.claude/sessions/<pid>.json` carries `status` `"idle"` or `"busy"` and `statusUpdatedAt`, no `waitingFor`, and a pending permission prompt is written nowhere on disk.

What is available:

- In the session itself, the mod API raises `classic.PermissionRequest` (`tool_name`, `tool_input`, `agent_id` in a subagent) when a permission dialog is about to show. It carries no `tool_use_id`. It fires inside `tool.call`'s `next(e)`, which resolves once the call was allowed and ran, or was denied.
- An `AskUserQuestion` call's input is `{questions: [{question, header, multiSelect, options: [{label, description}]}]}`. In the transcript it is an assistant `tool_use` named `AskUserQuestion`, open until a user `tool_result` with its id.
- `$.ui.notify(text, {title})` sends a native notification on the person's notification channel and answers `{isSent, channel}`.

## Decision

- **Capture.** Each HQ records its own open waits: a permission prompt from `classic.PermissionRequest` (text `<tool>: <target>`, the target being the command's first line, a file's base name, a URL's host, or a pattern; `ExitPlanMode` is "approve the plan"), and a question from the `AskUserQuestion` call itself (the first question, its option labels). A request is matched to the in-flight call of the same tool, loop and target. A wait clears when its call settles, when its loop's turn completes, or, for the main loop, when the user submits a prompt (`composer` or `bridge` origin).
- **Publish.** `~/.claude/hq/sessions/<sessionId>.json` gains `waiting: {kind, text, options?, since}`, oldest open wait first, else `{kind: "turn", text: "your turn"}` while idle after a prompt. A change of wait publishes on the next tick instead of waiting for the 5 s cadence.
- **Read.** A session with a fresh publish file is believed. Otherwise its transcript digest ([0004](0004-a-session-card-names-its-goal-from-one-cached-haiku-summary.md)) tracks an open `AskUserQuestion`, and a session whose last assistant line ended the turn (`stop_reason: "end_turn"`) and whose registry status is not busy is "your turn". The digest drops an open question before reading a large transcript's tail, since its answer may sit in the unread middle. Permission prompts of sessions without HQ are not visible.
- **Show.** A permission, question or plan wait makes the session `waiting` (since the wait began): it counts in "N waiting on you", turns its card yellow, leads the flare (`<name> asks: <text>`) and gets a line `◆ asks: <text>` with the options dimmed after it, the text clipped before the options. The line is a Button running the session's existing jump. "your turn" replaces "idle" on the status and stays dim.
- **Notify.** When another session newly enters a real wait, HQ calls `$.ui.notify("<session name>: <text>", {title: "Claude needs you"})`, once per `sessionId:since`. A wait first seen more than 10 minutes after it began is not sent. Across HQ instances one wins by `mkdir ~/.claude/hq/notified/<key>` (atomic); claim directories older than a day are removed. `/hq notify on|off` stores the setting in `$.store` (`notify`, default on); waits seen while off are not replayed.

- **As built (question replies).** A main-loop reply that ends the turn on a question is a `question` wait too: the last sentence ending in "?" in its final paragraph, outside code, URLs, quotes and headers, clipped to 130 characters. Live from `turn.complete`'s `answer`, from the transcript's last `end_turn` text otherwise; a new user prompt or the session going busy clears it.

## Consequences

- Easier: a card says what is being asked, and a new ask reaches the person once even with several HQ sessions open.
- Harder: capture lives in module state, so a reload while a dialog is up forgets it until the next one; a request matched to the wrong one of two identical parallel calls clears early. Detection for sessions without HQ depends on the undocumented transcript format.
- Owed: permission prompts of sessions without HQ; a jump for sessions outside tmux (in progress on another branch).

## Alternatives considered

- **Registry `waitingFor`:** not written on this build.
- **`classic.Notification`:** carries only a message string; `PermissionRequest` has the tool and input.
- **A store lease for notify dedupe:** whether concurrent instances share `$.store` writes is unverified (0004); `mkdir` is atomic on one machine.
- **Renaming "idle" everywhere to "your turn":** idle without a finished reply (a fresh session, an interrupt) is not a turn handed back.
