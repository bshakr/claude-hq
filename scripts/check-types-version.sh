#!/usr/bin/env bash
# Fails when the vendored API types were written by a different Claude Code than the one installed.
set -euo pipefail
vendored=$(sed -n '1s/^\/\/ Written by Claude Code \(.*\)\.$/\1/p' types/claude-code/index.d.ts)
installed=$(claude --version | awk '{print $1}')
if [[ "$vendored" != "$installed" ]]; then
  echo "types/claude-code is from Claude Code $vendored but $installed is installed; refresh it (CONTRIBUTING.md)" >&2
  exit 1
fi
echo "types/claude-code matches Claude Code $installed"
