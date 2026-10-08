// What a tool call is doing, in plain words: shared by an agent's "doing" line and the session's "now" line.

type ToolInput = { tool: string } & Record<string, unknown>

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined)

function one(text: string, n: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

const baseName = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path

function hostOf(url: string): string {
  const m = /^[a-z]+:\/\/([^/]+)/i.exec(url)
  return m ? m[1]! : url
}

const TESTS =
  /(^|\s|\/)(rspec|jest|vitest|pytest|mocha|ava)(\s|$)|\b(bun|npm|pnpm|yarn|go|cargo|deno|mix) test\b|\bnpx (jest|vitest|playwright test)\b|\bclaude plugin test\b|\brails test\b/

/** Words of a command past `cd …&&`, `env`/assignments, `timeout N`, and a leading `!`. */
function lead(command: string): string[] {
  const words = command
    .trim()
    .replace(/^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*(?:&&|;)\s*/, '')
    .split(/\s+/)
    .filter(Boolean)
  while (
    words.length &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!) || ['env', 'time', 'nohup', '!', 'command', 'exec'].includes(words[0]!))
  )
    words.shift()
  if (words[0] === 'timeout') words.splice(0, words[1] && /^\d/.test(words[1]) ? 2 : 1)
  return words
}

/** What one simple command does, in plain words; undefined when it is not a known shape. */
function phrase(command: string): string | undefined {
  const w = lead(command)
  const p = w[0] ? baseName(w[0]) : undefined
  const sub = w[1]
  const text = w.join(' ')
  if (!p) return undefined
  if (/^(pr-ci-wait)$/.test(p) || (p === 'gh' && sub === 'pr' && w[2] === 'checks') || (p === 'gh' && sub === 'run' && w[2] === 'watch'))
    return 'checking CI'
  if (p === 'pr-merge-wait') return 'waiting for a merge'
  if (TESTS.test(` ${text} `) || (p === 'bundle' && w.includes('rspec'))) return 'running tests'
  if (p === 'tsc' || (p === 'npx' && w.includes('tsc'))) return 'type-checking'
  if (/lint/.test(p) || /\blint\b/.test(text)) return 'linting'
  if (/^(npm|pnpm|yarn|bun)$/.test(p) && /^(i|install|add|ci)$/.test(sub ?? '')) return 'installing packages'
  if (/^(npm|pnpm|yarn|bun)$/.test(p) && /build/.test(text)) return 'building'
  if (p === 'git') {
    const git: Record<string, string> = {
      status: 'checking git status',
      diff: 'reading a diff',
      log: 'reading git history',
      show: 'reading a commit',
      commit: 'committing',
      push: 'pushing',
      pull: 'pulling',
      fetch: 'fetching from git',
      rebase: 'rebasing',
      merge: 'merging a branch',
      checkout: 'switching branch',
      switch: 'switching branch',
      worktree: 'managing worktrees',
      add: 'staging changes',
      stash: 'stashing changes',
      branch: 'checking branches',
    }
    return git[sub ?? ''] ?? 'running git'
  }
  if (p === 'gh') {
    if (sub === 'pr' && w[2] === 'create') return 'opening a PR'
    if (sub === 'pr' && w[2] === 'merge') return 'merging a PR'
    if (sub === 'pr') return 'reading PRs'
    if (sub === 'run') return 'checking CI'
    return 'querying GitHub'
  }
  if (p === 'linear') return 'reading Linear'
  if (p === 'codex') return 'asking Codex'
  if (p === 'curl' || p === 'wget') {
    const u = w.find(x => /^['"]?https?:\/\//.test(x))
    return u ? `fetching ${hostOf(u.replace(/^['"]/, ''))}` : 'fetching a URL'
  }
  if (p === 'sleep') return 'waiting'
  if (/^(ls|cat|head|tail|less|wc|stat|file|tree)$/.test(p) || (p === 'sed' && sub === '-n')) return 'reading files'
  if (/^(grep|rg|ag|find|fd)$/.test(p)) return 'searching files'
  if (/^(rm|mv|cp|mkdir|touch|ln|chmod)$/.test(p)) return 'moving files around'
  if (/^(python3?|node|ruby|bun|deno|tsx|ts-node)$/.test(p)) return 'running a script'
  if (p === 'docker') return 'running docker'
  if (p === 'make') return 'running make'
  return undefined
}

/** What a waited-on condition is about: "CI", "tests", a file name, a host. */
function thingOf(cond: string): string | undefined {
  const w = lead(cond.replace(/^[[\s]+|[\]\s]+$/g, ''))
  const p = w[0] ? baseName(w[0]) : undefined
  if (!p) return undefined
  if (p === 'pr-ci-wait' || (p === 'gh' && (w[1] === 'run' || w.includes('checks')))) return 'CI'
  if (p === 'gh' && w[1] === 'pr') return 'the PR'
  if (TESTS.test(` ${w.join(' ')} `)) return 'tests'
  if (p === 'curl' || p === 'wget' || p === 'nc') {
    const u = w.find(x => /^['"]?https?:\/\//.test(x))
    return u ? hostOf(u.replace(/^['"]/, '')) : 'a server'
  }
  if (p === 'test' || p === '-f' || p === '-e' || p === '-d' || p === '-s' || p === 'ls') {
    const f = w
      .slice(1)
      .reverse()
      .find(x => !x.startsWith('-'))
    return f ? baseName(f.replace(/^['"]|['"]$/g, '')) : 'a file'
  }
  if (p === 'grep' || p === 'rg') {
    const f = w[w.length - 1]
    return f && !f.startsWith('-') && w.length > 2 ? baseName(f.replace(/^['"]|['"]$/g, '')) : 'a match'
  }
  if (p === 'pgrep' || p === 'kill' || p === 'ps') return 'a process'
  if (p === 'git') return 'git'
  return undefined
}

/** Plain words for a Bash command with no description; never the command itself. */
export function shellPhrase(command: string): string {
  const c = command.trim()
  const loop = /^(?:cd\s+\S+\s*(?:&&|;)\s*)?(until|while)\s+([\s\S]*?);\s*do\b/.exec(c)
  if (loop) {
    const thing = thingOf(loop[2]!)
    return thing ? `waiting for ${thing}` : 'waiting'
  }
  if (/^(?:cd\s+\S+\s*(?:&&|;)\s*)?for\s+\S+\s+in\b/.test(c) && /\bsleep\b/.test(c)) return 'waiting'
  // A chain reads as its most telling part: the first known shape that is not a `cd` or a sleep.
  const parts = c.split(/\s*(?:&&|\|\||;|\|)\s*/).filter(Boolean)
  for (const part of parts) {
    if (/^cd\s/.test(part) || /^(echo|printf|true|export|set|source|\.)\b/.test(part)) continue
    const ph = phrase(part)
    if (ph && ph !== 'waiting') return ph
  }
  if (parts.some(x => phrase(x) === 'waiting')) return 'waiting'
  return 'running a command'
}

/** Never the raw shell command: a Bash call reads as its own description. */
export function doingText(e: ToolInput): string {
  const tool = String(e.tool)
  const file = str(e.file_path) ?? str(e.notebook_path)
  switch (tool) {
    case 'Bash': {
      const d = str(e.description)
      if (d) return one(d, 80)
      return shellPhrase(str(e.command) ?? '')
    }
    case 'Read':
      return file ? `reading ${baseName(file)}` : 'reading'
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return file ? `editing ${baseName(file)}` : 'editing'
    case 'Write':
      return file ? `writing ${baseName(file)}` : 'writing'
    case 'Grep': {
      const p = str(e.pattern)
      return p ? `searching for "${one(p, 30)}"` : 'searching'
    }
    case 'Glob': {
      const p = str(e.pattern)
      return p ? `finding ${one(p, 30)}` : 'finding files'
    }
    case 'WebFetch': {
      const u = str(e.url)
      return u ? `fetching ${hostOf(u)}` : 'fetching a page'
    }
    case 'WebSearch': {
      const q = str(e.query)
      return q ? `searching the web for "${one(q, 30)}"` : 'searching the web'
    }
    case 'Agent': {
      const d = str(e.description)
      return d ? `starting agent: ${one(d, 60)}` : 'starting an agent'
    }
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return 'updating the todo list'
    case 'Skill': {
      const s = str(e.skill)
      return s ? `using skill ${s}` : 'using a skill'
    }
    case 'SubagentHandback':
      return 'reporting back'
    case 'TaskStop':
      return 'stopping a task'
    case 'SendMessage':
      return 'sending a message'
    case 'Monitor':
      return 'watching a process'
    case 'ToolSearch':
      return 'loading tools'
    default:
      // Never the tool's own name: internal and MCP names mean nothing on the doing line.
      return file ? `working on ${baseName(file)}` : 'working'
  }
}
