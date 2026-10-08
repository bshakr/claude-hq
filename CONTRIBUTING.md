# Contributing

The plugin lives in `plugins/hq`: `hooks/register.tsx` is the entry point, `hooks/data` reads sessions, transcripts and PRs, `hooks/ui` draws the pane, `tests` holds the specs, and `docs/adr` records the decisions. Change a decision by writing a new ADR, not by editing an accepted one.

## Run it from your checkout

```sh
claude --plugin-dir plugins/hq
```

An interactive session watches the folder and reloads the hooks module when a file changes.

## Checks

All of these must pass before a PR:

```sh
claude plugin validate plugins/hq   # manifest and hooks module, as the engine reads them
claude plugin validate .            # the marketplace file
claude plugin test plugins/hq       # every *.test.ts under plugins/hq
tsc -p plugins/hq                   # type-check
```

`tsc` needs the API types the engine writes to `plugins/hq/.claude-plugin/types/` (git-ignored) when an interactive session loads the plugin from your folder, so start `claude --plugin-dir plugins/hq` once before type-checking. CI runs `validate` and `test` only, as no command writes those types without a loaded session.

The bundled `pr-ci-wait` and `pr-merge-wait` in `plugins/hq/bin` are plain bash: check them with `bash -n` and, if you have it, `shellcheck`.
