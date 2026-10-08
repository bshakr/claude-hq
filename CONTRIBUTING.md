# Contributing

The plugin lives in `plugins/hq`: `hooks/register.tsx` is the entry point, `hooks/data` reads sessions, transcripts and PRs, `hooks/ui` draws the pane, `tests` holds the specs, and `docs/adr` records the decisions. Change a decision by writing a new ADR, not by editing an accepted one.

## Run it from your checkout

```sh
claude --plugin-dir plugins/hq
```

An interactive session watches the folder and reloads the hooks module when a file changes.

## Checks

Install the dev tools once with `npm ci` (Node 22 or newer, plus `shellcheck`), then run everything CI runs:

```sh
npm run check
```

or one at a time:

```sh
npm run typecheck      # tsc against the vendored engine types in types/
npm run lint           # eslint, then prettier --check (npm run format fixes formatting)
npm run check:types    # types/ was written by the installed Claude Code version
npm run check:scripts  # bash -n and shellcheck on plugins/hq/bin and scripts
npm run validate       # claude plugin validate, for the plugin and the marketplace file
npm test               # claude plugin test plugins/hq
```

`types/claude-code/index.d.ts` is the API declaration the engine writes beside a plugin it loads, vendored so a fresh clone type-checks without a session. After upgrading Claude Code, start `claude --plugin-dir plugins/hq` once, copy `plugins/hq/.claude-plugin/types/claude-code/index.d.ts` over it, and bump the version CI installs in `.github/workflows/ci.yml` to match its first line. Your editor reads the engine-written copy through `plugins/hq/tsconfig.json`.

The bundled `pr-ci-wait` and `pr-merge-wait` in `plugins/hq/bin` are plain bash, checked by `npm run check:scripts`.
