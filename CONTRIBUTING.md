# Contributing

The plugin lives in `plugins/hq`: `hooks/register.tsx` is the entry point, `hooks/data` reads sessions, transcripts and PRs, `hooks/ui` draws the pane, and `tests` holds the specs.

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

## Releasing

1. Bump `version` in `plugins/hq/.claude-plugin/plugin.json`. Installed copies compare it with their own to offer an update. `.claude-plugin/marketplace.json` carries no version.
2. Add a `## X.Y.Z` section at the top of `CHANGELOG.md`.
3. Commit both and push to `main`.
4. Tag from a clean checkout of that commit:

   ```sh
   claude plugin tag --push plugins/hq
   ```

   It checks plugin.json against the marketplace entry, then creates and pushes `hq--vX.Y.Z`. The `release` workflow checks that the tag matches plugin.json and publishes a GitHub release tagged `vX.Y.Z` whose notes are that version's CHANGELOG section. The "what's new" button in HQ opens that release page.
