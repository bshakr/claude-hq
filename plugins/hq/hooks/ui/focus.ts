// Bringing a session's terminal forward, whatever hosts it. Pure: commands run through `Exec`.
import type { Jump } from '../model/types'

export type SessionJump = Extract<Jump, { kind: 'session' }>

export type Exec = (
  argv: string[],
  init?: { env?: Record<string, string> },
) => Promise<{ exitCode: number; stdout?: string; stderr: string }>

const ok = async (exec: Exec, argv: string[], init?: { env?: Record<string, string> }): Promise<boolean> => {
  try {
    return (await exec(argv, init)).exitCode === 0
  } catch {
    return false
  }
}

const said = async (exec: Exec, argv: string[], want: string): Promise<boolean> => {
  try {
    const r = await exec(argv)
    return r.exitCode === 0 && (r.stdout ?? '').trim() === want
  } catch {
    return false
  }
}

const ITERM_JXA = `function run(argv) {
  const app = Application('iTerm2')
  for (const w of app.windows()) for (const t of w.tabs()) for (const s of t.sessions()) {
    if (s.tty() === argv[0]) { s.select(); t.select(); w.select(); app.activate(); return 'ok' }
  }
  return 'none'
}`

const TERMINAL_JXA = `function run(argv) {
  const app = Application('Terminal')
  for (const w of app.windows()) for (const t of w.tabs()) {
    if (t.tty() === argv[0]) { w.selectedTab = t; w.index = 1; app.activate(); return 'ok' }
  }
  return 'none'
}`

// Ghostty exposes no tty or per-surface id to the process, so the pick is by cwd then title, in pickGhostty.
const GHOSTTY_LIST_JXA = `function run() {
  const app = Application('Ghostty')
  if (!app.running()) return '[]'
  return JSON.stringify(app.terminals().map(t => ({ id: t.id(), cwd: t.workingDirectory(), name: t.name() })))
}`

const GHOSTTY_FOCUS_JXA = `function run(argv) {
  const app = Application('Ghostty')
  for (const w of app.windows()) for (const tab of w.tabs()) for (const t of tab.terminals()) {
    if (t.id() !== argv[0]) continue
    try { app.selectTab(tab) } catch (e) {}
    app.focus(t); app.activate(); return 'ok'
  }
  return 'none'
}`

export interface GhosttyTerminal {
  id: string
  cwd?: string
  name?: string
}

const dir = (p: string) => p.replace(/\/+$/, '') || '/'
// Claude Code titles the tab "✳ <title>", or "◐"/"◑" while it works.
const bare = (name: string) => name.replace(/^[\u2733\u25D0\u25D1]\s*/, '').trim()

/** The one terminal in the session's cwd, narrowed by title when several share it; undefined when unsure. */
export function pickGhostty(terms: readonly GhosttyTerminal[], cwd: string, title?: string): string | undefined {
  const here = terms.filter(t => t.cwd && dir(t.cwd) === dir(cwd))
  if (here.length === 1) return here[0]!.id
  if (!title) return undefined
  const named = here.filter(t => t.name && bare(t.name) === title.trim())
  return named.length === 1 ? named[0]!.id : undefined
}

async function focusGhostty(j: SessionJump, exec: Exec): Promise<boolean> {
  let terms: GhosttyTerminal[]
  try {
    const r = await exec(['osascript', '-l', 'JavaScript', '-e', GHOSTTY_LIST_JXA])
    if (r.exitCode !== 0) return false
    terms = JSON.parse(r.stdout ?? '') as GhosttyTerminal[]
  } catch {
    return false
  }
  if (!Array.isArray(terms)) return false
  const id = pickGhostty(terms, j.cwd, j.title)
  return id ? said(exec, ['osascript', '-l', 'JavaScript', '-e', GHOSTTY_FOCUS_JXA, String(id)], 'ok') : false
}

export interface Strategy {
  name: string
  /** Whether this host can be what holds the session, from its env and tty alone. */
  applies(j: SessionJump): boolean
  /** Brings it forward; true only when the host said it did. */
  run(j: SessionJump, exec: Exec): Promise<boolean>
}

const env = (j: SessionJump, k: string) => j.term.env[k]
const bundle = (j: SessionJump) => env(j, '__CFBundleIdentifier')
// A multiplexer's panes inherit the outer terminal's env, which names the wrong pane.
const muxed = (j: SessionJump) => !!(j.tmux || env(j, 'TMUX') || env(j, 'ZELLIJ'))
// Supacode and cmux embed libghostty and may say TERM_PROGRAM=ghostty; their bundle id tells them apart.
const isGhostty = (j: SessionJump) => (bundle(j) ? bundle(j) === 'com.mitchellh.ghostty' : env(j, 'TERM_PROGRAM') === 'ghostty')
const isCursor = (j: SessionJump) =>
  !!env(j, 'CURSOR_TRACE_ID') || /todesktop/.test(bundle(j) ?? '') || /\/Cursor\.app\//.test(env(j, 'VSCODE_GIT_ASKPASS_NODE') ?? '')

/** `open -b` is macOS's; the bundle id is only ever in a macOS env, so this never runs elsewhere. */
async function activate(j: SessionJump, exec: Exec): Promise<boolean> {
  const id = bundle(j)
  return id ? ok(exec, ['open', '-b', id]) : false
}

export const STRATEGIES: readonly Strategy[] = [
  {
    // A background session with no front-end has no pane to focus; open one in the viewer's tmux session.
    name: 'tmux attach',
    applies: j => !!j.bg && !!j.jobId && !!j.openIn,
    run: (j, exec) => ok(exec, ['tmux', 'new-window', '-t', `${j.openIn}:`, '-c', j.cwd, '-n', j.jobId!, 'claude', 'attach', j.jobId!]),
  },
  {
    name: 'tmux',
    applies: j => !!j.tmux,
    run: async (j, exec) => {
      if (!(await ok(exec, ['tmux', 'switch-client', '-t', j.tmux!]))) return false
      const pane = /(%\d+)$/.exec(j.tmux!)
      if (pane) await ok(exec, ['tmux', 'select-pane', '-t', pane[1]!])
      await activate(j, exec)
      return true
    },
  },
  {
    name: 'zellij',
    applies: j => !j.tmux && !!env(j, 'ZELLIJ_PANE_ID') && !!env(j, 'ZELLIJ_SESSION_NAME'),
    run: async (j, exec) => {
      const done = await ok(exec, [
        'zellij',
        '--session',
        env(j, 'ZELLIJ_SESSION_NAME')!,
        'action',
        'focus-pane-id',
        `terminal_${env(j, 'ZELLIJ_PANE_ID')}`,
      ])
      if (done) await activate(j, exec)
      return done
    },
  },
  {
    name: 'supacode',
    applies: j => !muxed(j) && !!(env(j, 'SUPACODE_WORKTREE_ID') && env(j, 'SUPACODE_TAB_ID') && env(j, 'SUPACODE_SURFACE_ID')),
    run: async (j, exec) => {
      const done = await ok(exec, [
        'supacode',
        'surface',
        'focus',
        '-w',
        env(j, 'SUPACODE_WORKTREE_ID')!,
        '-t',
        env(j, 'SUPACODE_TAB_ID')!,
        '-s',
        env(j, 'SUPACODE_SURFACE_ID')!,
        '--timeout',
        '2',
      ])
      if (done) await activate(j, exec)
      return done
    },
  },
  {
    name: 'wezterm',
    applies: j => !muxed(j) && !!env(j, 'WEZTERM_PANE'),
    run: async (j, exec) => {
      const sock = env(j, 'WEZTERM_UNIX_SOCKET')
      const done = await ok(
        exec,
        ['wezterm', 'cli', 'activate-pane', '--pane-id', env(j, 'WEZTERM_PANE')!],
        sock ? { env: { WEZTERM_UNIX_SOCKET: sock } } : undefined,
      )
      if (done) await activate(j, exec)
      return done
    },
  },
  {
    name: 'kitty',
    applies: j => !muxed(j) && !!env(j, 'KITTY_WINDOW_ID'),
    run: async (j, exec) => {
      const to = env(j, 'KITTY_LISTEN_ON')
      const done = await ok(exec, [
        'kitten',
        '@',
        ...(to ? ['--to', to] : []),
        'focus-window',
        '--match',
        `id:${env(j, 'KITTY_WINDOW_ID')}`,
      ])
      if (done) await activate(j, exec)
      return done
    },
  },
  {
    name: 'iTerm2',
    applies: j => !muxed(j) && !!j.term.tty && (env(j, 'TERM_PROGRAM') === 'iTerm.app' || bundle(j) === 'com.googlecode.iterm2'),
    run: (j, exec) => said(exec, ['osascript', '-l', 'JavaScript', '-e', ITERM_JXA, j.term.tty!], 'ok'),
  },
  {
    name: 'Terminal',
    applies: j => !muxed(j) && !!j.term.tty && (env(j, 'TERM_PROGRAM') === 'Apple_Terminal' || bundle(j) === 'com.apple.Terminal'),
    run: (j, exec) => said(exec, ['osascript', '-l', 'JavaScript', '-e', TERMINAL_JXA, j.term.tty!], 'ok'),
  },
  {
    name: 'cmux',
    applies: j => !muxed(j) && !!env(j, 'CMUX_PANE_ID'),
    run: async (j, exec) => {
      let help: string
      try {
        help = (await exec(['cmux', '--help'])).stdout ?? ''
      } catch {
        return false
      }
      if (!help.includes('focus-pane')) return false
      const done = await ok(exec, ['cmux', 'focus-pane', '--pane', env(j, 'CMUX_PANE_ID')!])
      if (done) await activate(j, exec)
      return done
    },
  },
  {
    name: 'Ghostty',
    applies: j => !muxed(j) && !!j.cwd && isGhostty(j),
    run: focusGhostty,
  },
  {
    name: 'editor',
    applies: j => !muxed(j) && env(j, 'TERM_PROGRAM') === 'vscode' && !!j.cwd,
    // Without -r: a folder already open in a window focuses that window instead of replacing another's.
    run: (j, exec) => ok(exec, [isCursor(j) ? 'cursor' : 'code', j.cwd]),
  },
  {
    name: 'app',
    applies: j => !muxed(j) && !!bundle(j),
    run: activate,
  },
]

/** The strategies worth trying for a session, in order; a background session can only be attached. */
export function strategiesFor(j: SessionJump): Strategy[] {
  return STRATEGIES.filter(s => (s.name === 'tmux attach') === !!j.bg && s.applies(j))
}

/** Enter can only copy the resume command. */
export const resumeOnly = (j: Jump): boolean => j.kind === 'session' && strategiesFor(j).length === 0

const quote = (s: string) => (/^[\w@%+=:,./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

/** A live background session is attached to; anything else is resumed in its own directory. */
export function resumeCommand(j: SessionJump): string {
  if (j.bg && j.jobId) return `claude attach ${quote(j.jobId)}`
  return `${j.cwd ? `cd ${quote(j.cwd)} && ` : ''}claude --resume ${quote(j.sessionId)}`
}
