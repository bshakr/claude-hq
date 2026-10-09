import { describe, expect, test } from 'claude-code/testing'

import { jumpOf, parseRegistryRow } from '../../hooks/data/fleet'
import { parsePsTerm } from '../../hooks/data/term'
import type { HqModel, TermEnv } from '../../hooks/model/types'
import { pickGhostty, resumeCommand, resumeOnly, strategiesFor } from '../../hooks/ui/focus'
import type { Exec, SessionJump } from '../../hooks/ui/focus'
import { pressJump, runJump } from '../../hooks/ui/jump'
import { RESUME_HINT, layout } from '../../hooks/ui/layout'
import { EMPTY } from './fixtures'

const jump = (term: TermEnv, extra: Partial<SessionJump> = {}): SessionJump => ({
  kind: 'session',
  sessionId: 'sid-1',
  cwd: '/Users/me/code/app',
  pid: 4242,
  term,
  ...extra,
})

type Reply = { exitCode?: number; stdout?: string; throws?: boolean }

/** Answers by argv[0] (or "argv0 argv1"), a list answering successive calls; records every command and its env. */
function host(replies: Record<string, Reply | Reply[]> = {}) {
  const ran: { argv: string[]; env?: Record<string, string> }[] = []
  const exec: Exec = async (argv, init) => {
    ran.push({ argv, ...(init?.env ? { env: init.env } : {}) })
    const got = replies[`${argv[0]} ${argv[1]}`] ?? replies[argv[0]!] ?? {}
    const r = (Array.isArray(got) ? got.shift() : got) ?? {}
    if (r.throws) throw new Error(`spawn ${argv[0]} ENOENT`)
    return { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? '', stderr: '' }
  }
  return { exec, ran, argvs: () => ran.map(r => r.argv) }
}

describe('reading a session terminal', () => {
  test('ps eww lines: tty, allowlisted env only, no tty for ?? and ?', () => {
    const out = parsePsTerm(
      [
        '31106 ttys007  claude --resume x TERM=screen-256color TERM_PROGRAM=tmux TMUX=/private/tmp/tmux-501/default,31775,2 __CFBundleIdentifier=com.mitchellh.ghostty HOME=/Users/me',
        '33267 ??       claude bg-pty-host GHOSTTY_BIN_DIR=/Applications/Ghostty.app CLAUDE_CODE_SESSION_KIND=bg',
        '  501 pts/3    claude WEZTERM_PANE=12 WEZTERM_UNIX_SOCKET=/run/user/1000/wezterm/sock',
        '  777 ?        claude',
        'garbage',
      ].join('\n'),
    )
    expect(out.get(31106)).toEqual({
      tty: '/dev/ttys007',
      env: { TERM_PROGRAM: 'tmux', TMUX: '/private/tmp/tmux-501/default,31775,2', __CFBundleIdentifier: 'com.mitchellh.ghostty' },
    })
    expect(out.get(33267)).toEqual({ env: {} })
    expect(out.get(501)).toEqual({ tty: '/dev/pts/3', env: { WEZTERM_PANE: '12', WEZTERM_UNIX_SOCKET: '/run/user/1000/wezterm/sock' } })
    expect(out.get(777)).toEqual({ env: {} })
    expect(out.size).toBe(4)
  })

  test('registry row → jump: undetected keeps the tmux jump; detected carries pid, cwd, bg and job id', () => {
    const row = parseRegistryRow(JSON.stringify({ pid: 9, sessionId: 's', cwd: '/w', tmux: 'a:@1.%2' }))!
    expect(jumpOf(row, undefined)).toEqual({ kind: 'tmux', target: 'a:@1.%2' })
    expect(jumpOf({ ...row, tmux: undefined }, undefined)).toBe(undefined)
    const bg = parseRegistryRow(JSON.stringify({ pid: 9, sessionId: 's', cwd: '/w', kind: 'bg', jobId: 'ab12' }))!
    expect(jumpOf(bg, { env: {} })).toEqual({
      kind: 'session',
      sessionId: 's',
      cwd: '/w',
      pid: 9,
      term: { env: {} },
      bg: true,
      jobId: 'ab12',
    })
  })
})

describe('the strategy chain', () => {
  test('tmux: switch the client, select the pane, raise the outer app; the stale outer pane env is ignored', async () => {
    const h = host()
    const j = jump(
      { tty: '/dev/ttys007', env: { TMUX: '/tmp/t,1,2', WEZTERM_PANE: '3', __CFBundleIdentifier: 'com.mitchellh.ghostty' } },
      { tmux: 'mono:@3.%7' },
    )
    expect(strategiesFor(j).map(s => s.name)).toEqual(['tmux'])
    expect(await runJump(j, h.exec)).toBe(undefined)
    expect(h.argvs()).toEqual([
      ['tmux', 'switch-client', '-t', 'mono:@3.%7'],
      ['tmux', 'select-pane', '-t', '%7'],
      ['open', '-b', 'com.mitchellh.ghostty'],
    ])
  })

  test('a failed tmux switch falls back to the resume command, never to the outer pane', async () => {
    const h = host({ 'tmux switch-client': { exitCode: 1 } })
    const j = jump({ env: { TMUX: 'x', WEZTERM_PANE: '3' } }, { tmux: 'gone:@1.%1' })
    expect(await runJump(j, h.exec)).toEqual({ resume: 'cd /Users/me/code/app && claude --resume sid-1', tried: ['tmux'] })
    expect(h.argvs()).toEqual([['tmux', 'switch-client', '-t', 'gone:@1.%1']])
  })

  test('zellij focuses the pane in its session', async () => {
    const h = host()
    expect(await runJump(jump({ env: { ZELLIJ: '0', ZELLIJ_PANE_ID: '4', ZELLIJ_SESSION_NAME: 'work' } }), h.exec)).toBe(undefined)
    expect(h.argvs()).toEqual([['zellij', '--session', 'work', 'action', 'focus-pane-id', 'terminal_4']])
  })

  test('supacode focuses the surface by its three ids, then raises the app', async () => {
    const h = host()
    const env = { SUPACODE_WORKTREE_ID: 'w', SUPACODE_TAB_ID: 't', SUPACODE_SURFACE_ID: 's', __CFBundleIdentifier: 'app.supacode' }
    expect(await runJump(jump({ tty: '/dev/ttys1', env }), h.exec)).toBe(undefined)
    expect(h.argvs()).toEqual([
      ['supacode', 'surface', 'focus', '-w', 'w', '-t', 't', '-s', 's', '--timeout', '2'],
      ['open', '-b', 'app.supacode'],
    ])
  })

  test('wezterm activates the pane on the socket the session runs under', async () => {
    const h = host()
    expect(await runJump(jump({ env: { WEZTERM_PANE: '12', WEZTERM_UNIX_SOCKET: '/sock' } }), h.exec)).toBe(undefined)
    expect(h.ran).toEqual([{ argv: ['wezterm', 'cli', 'activate-pane', '--pane-id', '12'], env: { WEZTERM_UNIX_SOCKET: '/sock' } }])
  })

  test('kitty focuses the window through its listen address', async () => {
    const h = host()
    expect(await runJump(jump({ env: { KITTY_WINDOW_ID: '5', KITTY_LISTEN_ON: 'unix:/tmp/kitty' } }), h.exec)).toBe(undefined)
    expect(h.argvs()).toEqual([['kitten', '@', '--to', 'unix:/tmp/kitty', 'focus-window', '--match', 'id:5']])
  })

  test('iTerm2 and Terminal select the session whose tty matches; "none" from the script is a miss', async () => {
    const iterm = host({ osascript: { stdout: 'ok\n' } })
    expect(await runJump(jump({ tty: '/dev/ttys003', env: { TERM_PROGRAM: 'iTerm.app' } }), iterm.exec)).toBe(undefined)
    expect(iterm.argvs()[0]!.slice(0, 3)).toEqual(['osascript', '-l', 'JavaScript'])
    expect(iterm.argvs()[0]![5]).toBe('/dev/ttys003')
    expect(iterm.argvs()[0]![4]).toContain("Application('iTerm2')")

    const terminal = host({ osascript: { stdout: 'none' } })
    const j = jump({ tty: '/dev/ttys004', env: { TERM_PROGRAM: 'Apple_Terminal', __CFBundleIdentifier: 'com.apple.Terminal' } })
    expect(strategiesFor(j).map(s => s.name)).toEqual(['Terminal', 'app'])
    expect(await runJump(j, terminal.exec)).toBe(undefined)
    expect(terminal.argvs()[0]![4]).toContain("Application('Terminal')")
    expect(terminal.argvs()[1]).toEqual(['open', '-b', 'com.apple.Terminal'])
  })

  test('cmux runs focus-pane only when its help lists it, else the app is raised', async () => {
    const env = { CMUX_PANE_ID: 'p9', __CFBundleIdentifier: 'com.cmuxterm.app' }
    const has = host({ 'cmux --help': { stdout: 'commands: focus-pane, list' } })
    expect(await runJump(jump({ env }), has.exec)).toBe(undefined)
    expect(has.argvs()).toEqual([
      ['cmux', '--help'],
      ['cmux', 'focus-pane', '--pane', 'p9'],
      ['open', '-b', 'com.cmuxterm.app'],
    ])
    const lacks = host({ 'cmux --help': { stdout: 'commands: list' } })
    expect(await runJump(jump({ env }), lacks.exec)).toBe(undefined)
    expect(lacks.argvs()).toEqual([
      ['cmux', '--help'],
      ['open', '-b', 'com.cmuxterm.app'],
    ])
  })

  test('VS Code and Cursor open the session folder in their own CLI', async () => {
    const code = host()
    await runJump(jump({ env: { TERM_PROGRAM: 'vscode' } }), code.exec)
    expect(code.argvs()).toEqual([['code', '/Users/me/code/app']])
    const cursor = host()
    await runJump(
      jump({ env: { TERM_PROGRAM: 'vscode', VSCODE_GIT_ASKPASS_NODE: '/Applications/Cursor.app/Contents/Frameworks/x' } }),
      cursor.exec,
    )
    expect(cursor.argvs()).toEqual([['cursor', '/Users/me/code/app']])
  })

  test('any other macOS app is raised by bundle id', async () => {
    const h = host()
    const j = jump({ tty: '/dev/ttys9', env: { __CFBundleIdentifier: 'com.example.term' } })
    expect(strategiesFor(j).map(s => s.name)).toEqual(['app'])
    expect(await runJump(j, h.exec)).toBe(undefined)
    expect(h.argvs()).toEqual([['open', '-b', 'com.example.term']])
  })

  test('the jump carries the titles Claude Code may have written as the terminal title', () => {
    const row = parseRegistryRow(JSON.stringify({ pid: 9, sessionId: 's', cwd: '/w' }))!
    expect(jumpOf(row, { env: {} }, undefined, ['Fix login', 'AI login fix'])).toEqual({
      kind: 'session',
      sessionId: 's',
      cwd: '/w',
      pid: 9,
      term: { env: {} },
      titles: ['Fix login', 'AI login fix'],
    })
  })

  test('Ghostty: TERM_PROGRAM or its bundle id selects it; Supacode and cmux, which embed it, do not', () => {
    const names = (env: Record<string, string>) => strategiesFor(jump({ env })).map(s => s.name)
    expect(names({ __CFBundleIdentifier: 'com.mitchellh.ghostty' })).toEqual(['Ghostty', 'app'])
    expect(names({ TERM_PROGRAM: 'ghostty' })).toEqual(['Ghostty'])
    expect(names({ TERM_PROGRAM: 'ghostty', __CFBundleIdentifier: 'com.cmuxterm.app' })).toEqual(['app'])
  })

  test('a missing binary or a timeout is a miss, never a throw: the chain ends at the resume command', async () => {
    const h = host({ wezterm: { throws: true }, open: { throws: true } })
    const j = jump({ env: { WEZTERM_PANE: '1', __CFBundleIdentifier: 'com.github.wez.wezterm' } })
    expect(await runJump(j, h.exec)).toEqual({ resume: 'cd /Users/me/code/app && claude --resume sid-1', tried: ['wezterm', 'app'] })
  })

  test('fallback: background sessions attach, unknown hosts resume; odd paths are quoted', async () => {
    const h = host()
    const bg = jump({ env: { __CFBundleIdentifier: 'com.mitchellh.ghostty' } }, { bg: true, jobId: '990b185e' })
    expect(resumeOnly(bg)).toBe(true)
    expect(await runJump(bg, h.exec)).toEqual({ resume: 'claude attach 990b185e', tried: [] })
    expect(h.ran).toEqual([])
    expect(resumeOnly(jump({ env: {} }))).toBe(true)
    expect(resumeOnly({ kind: 'tmux', target: 'a:@1.%1' })).toBe(false)
    expect(resumeCommand(jump({ env: {} }, { cwd: "/Users/me/my app's" }))).toBe(`cd '/Users/me/my app'\\''s' && claude --resume sid-1`)
  })
})

describe('Ghostty', () => {
  const ghostty = { env: { TERM_PROGRAM: 'ghostty', __CFBundleIdentifier: 'com.mitchellh.ghostty' } }
  const list = (...t: object[]) => ({ stdout: JSON.stringify(t) + '\n' })

  test('pick: the one terminal in the cwd; several narrowed by title, tolerant of the status glyph and a trailing slash', () => {
    const terms = [
      { id: 'A', cwd: '/Users/me/code/app/', name: '✳ Fix login' },
      { id: 'B', cwd: '/Users/me/code/app', name: '◐ Ship the release' },
      { id: 'C', cwd: '/Users/me/code/other', name: '✳ Fix login' },
    ]
    expect(pickGhostty(terms.slice(1), '/Users/me/code/app/')).toBe('B')
    expect(pickGhostty(terms, '/Users/me/code/app', ['Fix login'])).toBe('A')
    expect(pickGhostty(terms, '/Users/me/code/app', ['Ship the release'])).toBe('B')
    expect(pickGhostty([...terms, { id: 'D', cwd: '/Users/me/code/app', name: 'Fix login' }], '/Users/me/code/app', ['Fix login'])).toBe(
      undefined,
    )
    expect(pickGhostty(terms, '/Users/me/code/app')).toBe(undefined)
    expect(pickGhostty(terms, '/nowhere', ['Fix login'])).toBe(undefined)
  })

  test('pick: the /rename title or the AI title matches, since the rename may be kept off the terminal title', () => {
    const terms = [
      { id: 'A', cwd: '/w', name: '✳ AI login fix' },
      { id: 'B', cwd: '/w', name: '✳ Other' },
    ]
    expect(pickGhostty(terms, '/w', ['Fix login', 'AI login fix'])).toBe('A')
    expect(pickGhostty([...terms, { id: 'C', cwd: '/w', name: '◐ Fix login' }], '/w', ['Fix login', 'AI login fix'])).toBe('C')
  })

  test('pick: cwds compare NFC on both sides', () => {
    const nfd = '/Users/me/cafe\u0301'
    expect(pickGhostty([{ id: 'A', cwd: nfd }], '/Users/me/caf\u00e9')).toBe('A')
    expect(pickGhostty([{ id: 'A', cwd: '/Users/me/caf\u00e9' }], nfd)).toBe('A')
  })

  test('pick: a lone tab in the cwd titled by another Claude session is refused; a plain shell is accepted', () => {
    expect(pickGhostty([{ id: 'A', cwd: '/w', name: '✳ Someone else' }], '/w', ['Fix login'])).toBe(undefined)
    expect(pickGhostty([{ id: 'A', cwd: '/w', name: '◑ Fix login' }], '/w', ['Fix login'])).toBe('A')
    expect(pickGhostty([{ id: 'A', cwd: '/w', name: 'zsh' }], '/w', ['Fix login'])).toBe('A')
    expect(pickGhostty([{ id: 'A', cwd: '/w', name: '✳ Someone else' }], '/w')).toBe('A')
  })

  test('the list script reads each property once for all terminals and resolves cwds to their realpath', async () => {
    const h = host({ osascript: { stdout: '[]' } })
    await runJump(jump(ghostty), h.exec)
    const script = h.argvs()[0]![4]!
    expect(script).toContain('app.terminals.id()')
    expect(script).toContain('app.terminals.workingDirectory()')
    expect(script).toContain('app.terminals.name()')
    expect(script).toContain('$.realpath(')
    expect(script).not.toMatch(/\.map\(t => /)
  })

  test('the focus script resolves the terminal from app.terminals, which holds the quick terminal no window lists', async () => {
    const h = host({ osascript: [list({ id: 'T1', cwd: '/Users/me/code/app', name: 'zsh' }), { stdout: 'ok' }] })
    await runJump(jump(ghostty), h.exec)
    const script = h.argvs()[1]![4]!
    expect(script).toContain('app.terminals')
    expect(script).toContain('app.focus(t)')
    expect(script).not.toContain('windows()')
  })

  test('a unique cwd match is focused by id', async () => {
    const h = host({
      osascript: [list({ id: 'T1', cwd: '/Users/me/code/app', name: 'zsh' }, { id: 'T2', cwd: '/tmp', name: 'zsh' }), { stdout: 'ok\n' }],
    })
    expect(await runJump(jump(ghostty), h.exec)).toBe(undefined)
    expect(h.argvs()).toHaveLength(2)
    expect(h.argvs()[0]!.slice(0, 3)).toEqual(['osascript', '-l', 'JavaScript'])
    expect(h.argvs()[0]![4]).toContain("Application('Ghostty')")
    expect(h.argvs()[1]![5]).toBe('T1')
  })

  test('several terminals in the cwd: the title picks one', async () => {
    const h = host({
      osascript: [
        list({ id: 'T1', cwd: '/Users/me/code/app', name: '✳ Other work' }, { id: 'T2', cwd: '/Users/me/code/app', name: '◑ Fix login' }),
        { stdout: 'ok' },
      ],
    })
    expect(await runJump(jump(ghostty, { titles: ['Fix login'] }), h.exec)).toBe(undefined)
    expect(h.argvs()[1]![5]).toBe('T2')
  })

  test('ambiguous, unmatched, a broken reply or a script error: no focus, Ghostty is raised by bundle id instead', async () => {
    const two = list({ id: 'T1', cwd: '/Users/me/code/app', name: '✳ A' }, { id: 'T2', cwd: '/Users/me/code/app', name: '✳ A' })
    for (const reply of [
      two,
      list({ id: 'T9', cwd: '/elsewhere', name: 'x' }),
      { stdout: 'not json' },
      { exitCode: 1 },
      { throws: true },
    ]) {
      const h = host({ osascript: reply })
      expect(await runJump(jump(ghostty, { titles: ['A'] }), h.exec)).toBe(undefined)
      expect(h.argvs()).toHaveLength(2)
      expect(h.argvs()[1]).toEqual(['open', '-b', 'com.mitchellh.ghostty'])
    }
  })

  test('the focus script finding nothing falls through to the app', async () => {
    const h = host({ osascript: [list({ id: 'T1', cwd: '/Users/me/code/app' }), { stdout: 'none' }] })
    expect(await runJump(jump(ghostty), h.exec)).toBe(undefined)
    expect(h.argvs()[2]).toEqual(['open', '-b', 'com.mitchellh.ghostty'])
  })

  test('without a bundle id a miss ends at the resume command', async () => {
    const h = host({ osascript: { exitCode: 1 } })
    expect(await runJump(jump({ env: { TERM_PROGRAM: 'ghostty' } }), h.exec)).toEqual({
      resume: 'cd /Users/me/code/app && claude --resume sid-1',
      tried: ['Ghostty'],
    })
  })

  test('tmux inside Ghostty uses tmux, never the Ghostty script', () => {
    expect(strategiesFor(jump({ env: { ...ghostty.env, TMUX: '/tmp/t,1,2' } }, { tmux: 'a:@1.%2' })).map(s => s.name)).toEqual(['tmux'])
    expect(strategiesFor(jump({ env: { ...ghostty.env, TMUX: '/tmp/t,1,2' } })).map(s => s.name)).toEqual([])
  })
})

describe('a background session with no front-end', () => {
  const bg = (extra: Partial<SessionJump> = {}) =>
    jump({ env: { __CFBundleIdentifier: 'com.mitchellh.ghostty' } }, { cwd: '/Users/me', bg: true, jobId: '990b185e', ...extra })

  test('attaches in a new window of the viewer’s tmux session', async () => {
    const h = host()
    const j = bg({ openIn: 'workbench' })
    expect(resumeOnly(j)).toBe(false)
    expect(await runJump(j, h.exec)).toBe(undefined)
    expect(h.argvs()).toEqual([
      ['tmux', 'new-window', '-t', 'workbench:', '-c', '/Users/me', '-n', '990b185e', 'claude', 'attach', '990b185e'],
    ])
  })

  test('tmux refusing falls back to copying the attach command, with what to do with it', async () => {
    const h = host({ 'tmux new-window': { exitCode: 1 } })
    const copied: string[] = []
    const toasts: string[] = []
    const io = { run: h.exec, copy: async (t: string) => (copied.push(t), true), toast: (t: string) => void toasts.push(t) }
    expect(await pressJump(bg({ openIn: 'workbench' }), io)).toBe(true)
    expect(copied).toEqual(['claude attach 990b185e'])
    expect(toasts).toEqual(['hq: copied claude attach 990b185e; paste it in a terminal to open the background session'])
  })

  test('the card is titled background and offers no copy hint when it can open', () => {
    const view = { width: 60, rows: 30, focused: true, cursor: null, expanded: [], scroll: 0, phase: 0 }
    const m = (j: SessionJump): HqModel => ({
      ...EMPTY,
      others: [
        {
          tmuxSession: '',
          background: true,
          sessions: [{ sessionId: 'w', name: 'HQ work', windowLabel: '', status: 'idle', background: true, jump: j }],
        },
      ],
    })
    const text = (j: SessionJump) =>
      layout(m(j), view)
        .rows.map(r => r.cells.map(c => c.ch).join(''))
        .join('\n')
    expect(text(bg({ openIn: 'workbench' }))).toContain('background')
    expect(text(bg({ openIn: 'workbench' }))).not.toContain('no tmux')
    expect(text(bg({ openIn: 'workbench' }))).not.toContain(RESUME_HINT)
    expect(text(bg())).toContain(RESUME_HINT)
  })
})

describe('the card and the press', () => {
  const model = (term: TermEnv): HqModel => ({
    ...EMPTY,
    others: [
      { tmuxSession: '', sessions: [{ sessionId: 'x', name: 'loose', windowLabel: '', status: 'idle', detail: 'app', jump: jump(term) }] },
    ],
  })
  const view = { width: 60, rows: 30, focused: true, cursor: null, expanded: [], scroll: 0, phase: 0 }
  const text = (m: HqModel) =>
    layout(m, view)
      .rows.map(r => r.cells.map(c => c.ch).join(''))
      .join('\n')

  test('a card that can only copy its resume command says so; one with a host does not', () => {
    const l = layout(model({ env: {} }), view)
    expect(l.items.includes('s:x')).toBe(true)
    expect(text(model({ env: {} }))).toContain(RESUME_HINT)
    expect(text(model({ env: { __CFBundleIdentifier: 'com.mitchellh.ghostty' } }))).not.toContain(RESUME_HINT)
  })

  test('pressing a resume-only card copies the command and toasts it; nothing runs', async () => {
    const h = host()
    const copied: string[] = []
    const toasts: string[] = []
    const io = { run: h.exec, copy: async (t: string) => (copied.push(t), true), toast: (t: string) => void toasts.push(t) }
    expect(await pressJump(jump({ env: {} }), io)).toBe(true)
    expect(h.ran).toEqual([])
    expect(copied).toEqual(['cd /Users/me/code/app && claude --resume sid-1'])
    expect(toasts).toEqual(['hq: copied resume command: cd /Users/me/code/app && claude --resume sid-1'])
    // No clipboard: the toast carries the command instead.
    toasts.length = 0
    await pressJump(jump({ env: {} }), {
      ...io,
      copy: async () => {
        throw new Error('no clipboard')
      },
    })
    expect(toasts).toEqual(["hq: can't focus it; run cd /Users/me/code/app && claude --resume sid-1"])
    // A focused session toasts nothing.
    toasts.length = 0
    expect(await pressJump(jump({ env: { __CFBundleIdentifier: 'com.mitchellh.ghostty' } }), io)).toBe(true)
    expect(toasts).toEqual([])
  })
})
