# Each session card shows its context fill as a small meter, and the header shows the account's plan usage once

- Status: accepted
- Date: 2026-10-08

## Context

The founder's status line (`~/.claude/statusline.sh`) draws three 14-cell bars on coloured backgrounds: context used (`100 - .context_window.remaining_percentage`), 5-hour and weekly plan usage (`.rate_limits.five_hour.used_percentage`, `.rate_limits.seven_day.used_percentage`), coloured by what remains: red at 20% or less, yellow at 50% or less, else green. HQ lists many sessions, so the same figures need a much quieter form there.

Verified sources:

- **Live, this session only.** `$.session.usage()` answers `{ context: { tokens?, window, percent? }, rateLimits: [{ kind, percentUsed, resetsAt? }] }`, the status line's figures; the plain call is documented as free. `rateLimits` is empty off a subscription or before the first response. `$.session.model()` answers the main loop's model.
- **Other sessions, from disk.** The last main-thread assistant entry in `~/.claude/projects/<dir>/<sessionId>.jsonl` carries `message.usage`; input + cache read + cache write is the window the response was answered over (output excluded). The transcript does not record the window size: the model id has no `[1m]` (`claude-opus-5-5`), while `~/.claude/settings.json` holds `"model": "opus[1m]"`.
- **Plan usage** is account-wide and not on disk.

## Decision

- **Publish.** Each HQ writes its engine figure (`context`: percent, window, tokens, model, `source: "live"`) and its own plan reading (`account`: `fiveHour`, `week`) into `~/.claude/hq/sessions/<sessionId>.json`. Only its own readings: a transcript estimate or a figure relayed from another session is never republished.
- **Prefer.** A card uses a fresh publish (within 30 s, as for agents); otherwise the transcript estimate from the digest HQ already keeps ([0004](0004-a-session-card-names-its-goal-from-one-cached-haiku-summary.md)): the newest non-sidechain assistant usage, kept by timestamp so the sparse scan's out-of-order lines cannot regress it. `<synthetic>` and zero usages are skipped.
- **Window rule** for an estimate: 1M when the model id contains `[1m]`, or more than 200,000 tokens were used, or the model setting (user, then project, then project-local `settings.json`, last wins) contains `[1m]` and names the same family as the transcript's model; else 200,000. Percent is whole, rounded, clamped to 100.
- **Plan usage** comes from this session's engine reading, else the freshest published one.
- **Meter.** Right-aligned, last on a card's first line: `▰▰▱▱▱ 28%`, 5 cells, a cell lit for any use (`ceil(5 × percent / 100)`). Below 50% used it is dim; from 50% warn colour; from 80% fail colour, the status line's thresholds read as used. Empty cells stay dim; no labels, no backgrounds.
- **Header.** Right-aligned and dim: `5h 5% · wk 18%`; a figure takes warn or fail colour from 50% or 80%, and is drawn at the precision the engine sent (23.5 stays 23.5).
- **Narrow widths.** The meter's cells go first, then a card's PR facts, then its percent, then its status. The header keeps `5h` alone, then nothing.

## Consequences

- Easier: one glance shows which sessions are near compaction and how much plan is left, without a second status line.
- Harder: an estimate is only as fresh as the transcript's last response, and its window is inferred. A session whose model differs from its settings (`--model`, say) reads against the wrong window until its usage passes 200k, unless it runs HQ.
- Owed: sessions without HQ only ever show an estimate.

## Alternatives considered

- **Bars like the status line's:** too loud repeated on every card.
- **Always 200k for estimates:** every 1M session past 200k would read 100%.
- **Plan usage on every card:** it is account-wide, so one copy is enough.
- **Reading the window from the transcript:** it is not recorded there.
