# HQ reads its defaults from the manifest's userConfig, and a /hq toggle overrides them per machine

- Status: accepted
- Date: 2026-10-08

## Context

HQ's colours were fixed terminal palette slots (`hooks/ui/pane.tsx` TOKENS), its Haiku calls (ADR 0004 goal lines, id glosses) had no switch, and wake and notify could only be changed by `/hq wake|notify` toggles kept in `$.store`. People with a themed terminal want their own colours; some want no model calls; some want different defaults without typing a command on every machine.

The engine gives a plugin's `register(on, options)` the values of the fields its manifest's `userConfig` declares, defaults filled in, validated against each field's `type` before the module loads (`PluginOptions` in the API types). Values live in settings.json `pluginConfigs[<key>].options`, keyed by the plugin's id: `hq@claude-hq` when installed from this repo's marketplace, `hq@inline` under `--plugin-dir`, where the bare `hq` is read too (checked in the 2.1.295 build's settings reader). Each field is a row in `/config`, and a change reloads the module. `PluginOptions` is a flat record of strings, numbers, booleans and string lists, so a nested `colors` object cannot be declared.

## Decision

- Ten flat fields in `plugin.json`: `colorBroken`, `colorWaiting`, `colorWorking`, `colorDone`, `colorAccent`, `colorDim` (strings), and `summaries`, `wake`, `notify`, `autoOpen` (booleans, all default `true`).
- Colour defaults are today's slots (`ansi256(1)` broken, `3` waiting, `4` working, `2` done, `6` accent, `8` dim). A value is `#rrggbb`, `ansi256(N)` or a bare `N` (0-255); anything else keeps its default and the pane shows one dim footer line naming the bad fields. `hooks/config.ts` resolves the options once per load; `drawPane` paints every token from the resolved palette, so the dots (dimmed pulse included), borders, meters, usage bars and the asks line all follow it.
- `summaries: false` makes no `$.model.complete` call: no goal or step summary, no id brief, and no ticket or ADR lookup. Cards fall back to the AI title or first prompt (as ADR 0004's fallback already did), ids show bare, and another session's published goal is ignored.
- Precedence: a boolean stored by `/hq wake|notify|summaries on|off` in `$.store` wins on that machine; with none stored, the config value applies. `/hq summaries` is new, alongside wake and notify.
- `autoOpen` opens the pane from `session.start` in interactive sessions, once per session (a `$.state` flag), so a reload or `/clear` does not reopen a pane closed by hand. The open is unasked, so the engine draws it from 144 columns (110 once the person opened it before) and keeps it waiting below that.

## Consequences

- Themes work without a fork; the default look is unchanged.
- A toggle once typed hides later config changes on that machine; there is no command to clear it yet.
- `/plugin install` now shows a screen that sets the ten fields; all have defaults, so pressing Enter through it keeps the defaults.
- `autoOpen` defaulting to true is new behaviour: HQ now opens itself where before it waited for `/hq`.
- Inside tmux, hex colours need `CLAUDE_CODE_TMUX_TRUECOLOR=1` or they are reduced to 256 (README).

## Alternatives considered

- **A nested `colors` object:** `PluginOptions` cannot hold one.
- **Config wins over the stored toggle:** a `/hq` toggle would then silently do nothing when the config disagrees.
- **Throwing on a bad colour:** the load would fail and the whole pane with it; one footer line costs a row.
- **A colour picker field (`options` list):** would rule out hex and arbitrary palette numbers.
