// Which terminal holds a session, read from its process (ADR 0008).
import type { TermEnv } from '../model/types'

const KEYS = [
  'TERM_PROGRAM',
  '__CFBundleIdentifier',
  'TMUX',
  'ZELLIJ',
  'ZELLIJ_PANE_ID',
  'ZELLIJ_SESSION_NAME',
  'SUPACODE_WORKTREE_ID',
  'SUPACODE_TAB_ID',
  'SUPACODE_SURFACE_ID',
  'WEZTERM_PANE',
  'WEZTERM_UNIX_SOCKET',
  'KITTY_WINDOW_ID',
  'KITTY_LISTEN_ON',
  'ITERM_SESSION_ID',
  'CMUX_PANE_ID',
  'CURSOR_TRACE_ID',
  'VSCODE_GIT_ASKPASS_NODE',
]
const ENV_RE = new RegExp(`(?:^|\\s)(${KEYS.join('|')}|CMUX_[A-Z_]+)=(\\S+)`, 'g')

/** `ps eww -o pid=,tty=,command= -p …` → each pid's tty and allowlisted env; env values with spaces are cut at the first one. */
export function parsePsTerm(stdout: string): Map<number, TermEnv> {
  const out = new Map<number, TermEnv>()
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!m) continue
    const env: Record<string, string> = {}
    for (const e of m[3]!.matchAll(ENV_RE)) env[e[1]!] = e[2]!
    const tty = /^[?-]+$/.test(m[2]!) ? undefined : `/dev/${m[2]}`
    out.set(Number(m[1]), { ...(tty ? { tty } : {}), env })
  }
  return out
}
