import { summaryLine } from '../model/plain'
import { LONG_CALL_MS } from '../model/types'
import type { AgentVM, CiState, HqModel, NowVM, OtherAgentVM, OtherSessionVM, PrVM, TmuxGroupVM, TodoVM, WaitingVM } from '../model/types'
import { resumeOnly } from './focus'
import { Row } from './row'
import type { Action, Sty, Tok } from './row'
import { expandIds } from '../data/ids'
import { age, cellLen, clip, elapsed, plural, wrap } from './text'

export type View = {
  width: number
  rows: number
  focused: boolean
  /** Key of the item the cursor is on (drawn only while focused). */
  cursor: string | null
  expanded: readonly string[]
  /** First body row shown. */
  scroll: number
  /** Motion phase, +1 every 2 s while something runs. */
  phase: number
}

export type Layout = {
  rows: Row[]
  /** Actionable items in j/k order, offscreen ones included. */
  items: string[]
  /** Body index of each item's first line (the flare is -1). */
  itemLine: Record<string, number>
  actions: Record<string, Action>
  region: number
  bodyLen: number
  scroll: number
}

export const UNFOCUSED_HINT = '⌃g focus · click a PR to open it, a session to switch to it'
export const FOCUSED_HINT = '⏎ open, switch or expand · ⌃g prompt'

const DIM: Sty = { dim: true }
const tok = (c: Tok, extra: Sty = {}): Sty => ({ c, ...extra })
const LIVE = new Set(['running', 'waiting', 'pending'])

export const agentKey = (a: AgentVM) => `a:${a.id}`
export const prKey = (p: PrVM) => `p:${p.repo}#${p.number}`
export const sessionKey = (s: OtherSessionVM) => `s:${s.sessionId}`

type Ctx = {
  W: number
  /** Width inside a card's border and padding. */
  IW: number
  now: number
  phase: number
  expanded: ReadonlySet<string>
  actions: Record<string, Action>
  /** Glosses of the ids in the card being drawn. */
  g?: Readonly<Record<string, string>>
}

/** Below this width a card drops its border and keeps its title. */
const FRAME_MIN = 20

/** Inner rows inside a rounded border, the title in the top edge, two cells of padding each side. */
function card(x: Ctx, title: string, tone: Tok, inner: Row[], padY: boolean): Row[] {
  const { W } = x
  if (W < FRAME_MIN) {
    const h = new Row(W)
    h.put(0, clip(title, W), { bold: true })
    return [h, ...inner.map(r => Object.assign(new Row(W).inset(2, r), { mark: 0 }))]
  }
  const edge = tok(tone)
  const top = new Row(W)
  top.put(1, '╭─', edge)
  const end = top.put(4, clip(title, W - 8), { bold: true })
  top.fill(end + 1, W - 2, '─', edge)
  top.put(W - 2, '╮', edge)
  const side = (r?: Row) => {
    const s = new Row(W)
    if (r) s.inset(4, r)
    s.put(1, '│', edge)
    s.put(W - 2, '│', edge)
    s.mark = 2
    return s
  }
  const bottom = new Row(W)
  bottom.put(1, '╰', edge)
  bottom.fill(2, W - 2, '─', edge)
  bottom.put(W - 2, '╯', edge)
  return [top, ...(padY ? [side()] : []), ...inner.map(side), ...(padY ? [side()] : []), bottom]
}

const worst = (tones: readonly Tok[]): Tok => (tones.includes('fail') ? 'fail' : tones.includes('wait') ? 'wait' : 'rule')

// ---------- header and flare ----------

function header(r: Row, m: HqModel, focused: boolean) {
  if (focused) r.put(0, '▌', tok('accent'))
  const { waiting, broken, inProgress } = m.counts
  const parts: [string, Sty][] = []
  if (waiting) parts.push([`${waiting} waiting on you`, tok('wait')])
  if (broken) parts.push([`${broken} broken`, tok('fail')])
  if (inProgress) parts.push([`${inProgress} working`, {}])
  if (!waiting && !broken) parts.push(['nothing needs you', DIM])
  const [glyph, gs]: [string, Sty] = waiting ? ['◆', tok('wait')] : broken ? ['✗', tok('fail')] : inProgress ? ['●', tok('run')] : ['○', DIM]
  let c = r.put(1, glyph, gs) + 1
  for (const [i, [t, s]] of parts.entries()) {
    if (i) c = r.put(c, ' · ', DIM)
    const shown = clip(t, r.W - c)
    c = r.put(c, shown, s)
    if (shown !== t) break
  }
}

const tmuxShort = (target: string) => target.replace(/\.%\d+$/, '')

function flareRow(r: Row, m: HqModel, actions: Record<string, Action>) {
  const f = m.flare
  if (!f) return
  r.gutter = 'wait'
  r.item = 'flare'
  r.head = true
  r.mark = 0
  actions.flare = { kind: 'jump', jump: f.jump }
  r.put(1, '◆', tok('wait'))
  const name = f.text.split(' ')[0] ?? ''
  const rest = f.text.slice(name.length).trim()
  const waitingOthers = m.others.flatMap(g => g.sessions).filter(s => s.status === 'waiting').length
  const more = Math.max(0, waitingOthers - 1)
  const ago = age(m.now - f.sinceMs)
  const moreText = more ? ` · +${more} more` : ''
  let right = `${tmuxShort(f.tmuxTarget)} ⏎`
  const fixed = 3 + cellLen(name) + 1 + 1 + cellLen(ago) + cellLen(moreText)
  if (r.W - fixed - cellLen(right) - 2 < 8) right = ''
  const room = r.W - fixed - (right ? cellLen(right) + 2 : 0)
  let c = r.put(3, name, tok('wait', { bold: true }))
  if (rest && room > 0) c = r.button(c + 1, clip(rest, room), { key: 'flare', action: actions.flare })
  else if (!rest) {
    // A flare with no words after the name: the name itself is the target.
    r.button(3, name, { key: 'flare', action: actions.flare }, tok('wait', { bold: true }))
  }
  c = r.put(c + 1, ago, DIM)
  if (moreText) c = r.put(c, moreText, DIM)
  if (right) r.right(right, DIM, c + 2)
}

// ---------- agents ----------

type Node = { a: AgentVM; kids: Node[] }

const rank = (a: AgentVM) => (a.status === 'failed' ? 0 : LIVE.has(a.status) ? 1 : 2)

function sortNodes(nodes: Node[]) {
  nodes.sort(
    (x, y) =>
      rank(x.a) - rank(y.a) ||
      (rank(x.a) === 2 ? (y.a.endedAt ?? 0) - (x.a.endedAt ?? 0) : x.a.startedAt - y.a.startedAt),
  )
  for (const n of nodes) sortNodes(n.kids)
}

export function agentTree(agents: readonly AgentVM[]): Node[] {
  const nodes = new Map<string, Node>()
  for (const a of agents) nodes.set(a.id, { a, kids: [] })
  const roots: Node[] = []
  for (const n of nodes.values()) {
    const parent = n.a.parentId !== undefined && n.a.parentId !== n.a.id ? nodes.get(n.a.parentId) : undefined
    if (parent) parent.kids.push(n)
    else roots.push(n)
  }
  // A parent cycle leaves nodes unreachable from the roots: lift them to the top.
  const seen = new Set<string>()
  const visit = (n: Node) => {
    if (seen.has(n.a.id)) return
    seen.add(n.a.id)
    n.kids.forEach(visit)
  }
  roots.forEach(visit)
  for (const n of nodes.values()) {
    if (!seen.has(n.a.id)) {
      for (const p of nodes.values()) p.kids = p.kids.filter(k => k !== n)
      roots.push(n)
      visit(n)
    }
  }
  sortNodes(roots)
  return roots
}

const shortModel = (m?: string) => {
  if (!m) return undefined
  const known = /opus|sonnet|haiku|fable/i.exec(m)
  return known ? known[0].toLowerCase() : clip(m, 12)
}

/** "waiting · <what> · 7m", the age kept when the text is clipped. */
function waitingLine(text: string, ms: number, room: number): string {
  const tail = ` · ${age(ms)}`
  return `${clip(`waiting · ${text}`, Math.max(8, room - cellLen(tail)))}${tail}`
}

/** Text left, a dim right part when the text keeps at least `keep` cells. */
function rightPart(r: Row, col: number, right: string, keep = 12): number {
  if (!right || r.W - col - cellLen(right) - 2 < keep) return r.W - col
  r.right(right, DIM)
  return r.W - col - cellLen(right) - 2
}

function agentRows(node: Node, depth: number, x: Ctx): Row[] {
  const { a } = node
  const { IW, now } = x
  const gl = (t: string) => expandIds(t, x.g)
  const key = agentKey(a)
  x.actions[key] = { kind: 'toggle', id: a.id }
  const gc = 2 * depth
  const tc = gc + 2
  const failed = a.status === 'failed'
  const live = LIVE.has(a.status)
  const mk = (head: boolean) => {
    const r = new Row(IW)
    r.item = key
    r.head = head || undefined
    return r
  }
  const r = mk(true)
  const out: Row[] = [r]
  r.gutter = failed ? 'fail' : live ? 'run' : undefined

  if (!failed && !live) {
    const killed = a.status === 'killed'
    r.put(gc, killed ? '✗' : '✓', DIM)
    const avail = rightPart(r, tc, a.endedAt !== undefined ? `${age(now - a.endedAt)} ago` : '')
    const outcome = summaryLine(a.outcome) ?? (killed ? 'stopped' : '')
    const full = gl(a.title)
    const title = outcome && cellLen(full) + 3 + 12 > avail ? clip(full, Math.max(8, avail - 3 - 12)) : clip(full, avail)
    let c = r.button(tc, title, { key, action: x.actions[key]!, dim: true }, DIM)
    if (outcome && avail - cellLen(title) - 3 >= 4) {
      c = r.put(c, ' → ', DIM)
      r.put(c, clip(outcome, avail - cellLen(title) - 3), DIM)
    }
  } else {
    const longCall = a.status === 'running' && a.callSince !== undefined && now - a.callSince >= LONG_CALL_MS
    const glyph = failed ? '✗' : a.status === 'waiting' || longCall ? '◷' : a.status === 'pending' ? '◦' : x.phase % 2 ? '◦' : '●'
    r.put(gc, glyph, tok(failed ? 'fail' : 'run'))
    const end = failed ? (a.endedAt ?? now) : now
    const parts = [shortModel(a.model), elapsed(end - a.startedAt)].filter(Boolean)
    let right = parts.join(' · ')
    if (a.place) {
      const placed = `${clip(a.place, 18)} · ${right}`
      if (IW - tc - cellLen(placed) - 2 >= 16) right = placed
    }
    if (IW - tc - cellLen(right) - 2 < 12) right = parts.slice(-1).join('')
    const room = rightPart(r, tc, right)
    r.button(tc, clip(gl(a.title), room), { key, action: x.actions[key]! }, failed ? { bold: true } : {})

    const d = mk(false)
    if (failed) {
      const tail = a.endedAt !== undefined ? ` · failed ${age(now - a.endedAt)} ago` : ''
      const c = d.put(tc, clip(gl(a.now ?? a.outcome ?? 'failed'), IW - tc - cellLen(tail)))
      if (tail) d.put(c, tail, DIM)
    } else if (longCall) {
      d.put(tc, waitingLine(gl(a.now ?? 'working'), now - a.callSince!, IW - tc), DIM)
    } else {
      const child = node.kids.find(k => LIVE.has(k.a.status))
      const progress = a.todo && a.status !== 'waiting' ? `${a.todo.done}/${a.todo.total}` : ''
      const text =
        a.status === 'waiting' && child
          ? `waiting on ${gl(child.a.title)}`
          : gl(a.todo?.text ?? a.now ?? (a.status === 'pending' ? 'starting' : 'working'))
      d.put(tc, clip(text, IW - tc - (progress ? cellLen(progress) + 2 : 0)), DIM)
      if (progress) d.right(progress, DIM)
    }
    out.push(d)
  }

  if (x.expanded.has(a.id)) {
    const textCol = tc + 8
    const tw = Math.max(8, IW - textCol)
    const field = (label: string, text: string, sty: Sty = {}) => {
      wrap(text, tw).forEach((line, i) => {
        const e = mk(false)
        if (i === 0) e.put(tc, label, DIM)
        e.put(textCol, line, sty)
        out.push(e)
      })
    }
    const end = a.endedAt ?? now
    field('agent', [shortModel(a.model), a.background ? 'background' : 'foreground', elapsed(end - a.startedAt), plural(a.toolCount, 'tool')].filter(Boolean).join(' · ') + (a.tokens ? ` · ${a.tokens} tokens` : ''))
    if ((a.todo || a.now) && !failed) field('doing', a.todo ? `${a.todo.text} · ${a.todo.done}/${a.todo.total}` : (a.now ?? ''))
    const where = [a.worktree, a.files.join(', ')].filter(Boolean).join(' · ')
    if (where) field('in', where, DIM)
    const result = summaryLine(a.outcome)
    if (result) field('result', result)
  }
  return out
}

/** Live and failed agents, then finished ones after a blank; children follow their parent, indented. */
function agentBlock(agents: readonly AgentVM[], x: Ctx): Row[] {
  const out: Row[] = []
  const roots = agentTree(agents)
  const walk = (n: Node, depth: number) => {
    out.push(...agentRows(n, Math.min(depth, 2), x))
    n.kids.forEach(k => walk(k, depth + 1))
  }
  roots.forEach((n, i) => {
    if (i > 0 && rank(n.a) === 2 && rank(roots[i - 1]!.a) !== 2) out.push(new Row(x.IW))
    walk(n, 0)
  })
  return out
}

// ---------- this session ----------

function nowRows(n: NowVM, x: Ctx): Row[] {
  const { IW, now } = x
  const r = new Row(IW)
  const room = rightPart(r, 2, age(now - n.since), 8)
  if (n.idle) {
    r.put(0, '○', DIM)
    r.put(2, clip(n.prompt ? `idle · ${n.prompt}` : 'idle', room), DIM)
  } else {
    r.put(0, x.phase % 2 ? '◦' : '●', tok('run'))
    r.put(2, clip(n.prompt ?? 'working', room))
  }
  const out = [r]
  if (n.tool && !n.idle) {
    const t = new Row(IW)
    const tr = rightPart(t, 2, elapsed(now - n.tool.since), 8)
    t.put(2, clip(n.tool.text, tr), DIM)
    out.push(t)
  }
  return out
}

function todoRow(todos: readonly TodoVM[], x: Ctx): Row {
  const { IW } = x
  const done = todos.filter(t => t.status === 'completed').length
  const bar = IW >= 40 ? 8 : 5
  const r = new Row(IW)
  let c = r.put(0, 'todos', DIM)
  c = r.put(c + 1, `${done}/${todos.length}`)
  const filled = Math.round((bar * done) / Math.max(1, todos.length))
  c = r.put(c + 1, '━'.repeat(filled), tok('run'))
  c = r.put(c, '─'.repeat(bar - filled), DIM)
  const active = todos.find(t => t.status === 'in_progress')
  const next = todos.find(t => t.status === 'pending')
  const room = IW - (c + 4)
  if (room < 6) return r
  if (active) {
    r.put(c + 2, '●', tok('run'))
    r.put(c + 4, clip(active.text, room))
  } else if (next) {
    r.put(c + 2, '○', DIM)
    r.put(c + 4, clip(next.text, room), DIM)
  } else r.put(c + 2, '✓ all done', DIM)
  return r
}

function waitingRows(list: readonly WaitingVM[], x: Ctx): Row[] {
  const { IW, now } = x
  return list.map(w => {
    const r = new Row(IW)
    r.put(0, '◷', tok('run'))
    r.put(2, clip(w.text, rightPart(r, 2, age(now - w.since), 8)))
    return r
  })
}

function sessionCard(m: HqModel, x0: Ctx): Row[] {
  const cur = m.current
  const x: Ctx = { ...x0, ...(cur.glosses ? { g: cur.glosses } : {}) }
  const inner: Row[] = []
  if (cur.goal) {
    const g = new Row(x.IW)
    g.put(0, clip(expandIds(cur.goal.text, x.g), rightPart(g, 0, cur.goal.day ? `day ${cur.goal.day}` : '', 8)), { bold: true })
    inner.push(g)
  }
  if (cur.now) inner.push(...nowRows(cur.now, x))
  if (cur.todos?.length) inner.push(todoRow(cur.todos, x))
  if (cur.waiting?.length) inner.push(...waitingRows(cur.waiting, x))
  if (inner.length && cur.agents.length) inner.push(new Row(x.IW))
  inner.push(...agentBlock(cur.agents, x))
  if (inner.length === 0) {
    const r = new Row(x.IW)
    r.put(0, 'nothing running', DIM)
    inner.push(r)
  }
  const tone = worst(cur.agents.filter(a => a.status === 'failed').map(() => 'fail' as const))
  return card(x, 'this session', tone, inner, true)
}

// ---------- other sessions ----------

const OTHER_AGENTS_SHOWN = 3

/** A session's running subagents under it: at most three, newest first, then "+N more". */
function otherAgentRows(s: OtherSessionVM, under: () => Row, x: Ctx): Row[] {
  const { IW, now } = x
  const gl = (t: string) => expandIds(t, s.glosses)
  const agents: readonly OtherAgentVM[] = s.agents ?? []
  if (agents.length === 0) return []
  const shown = agents.slice(0, OTHER_AGENTS_SHOWN)
  const more = Math.max(agents.length, s.agentsRunning ?? 0) - shown.length
  const out: Row[] = []
  for (const a of shown) {
    const r = under()
    r.put(0, a.waiting ? '◷' : '●', tok('run'))
    const room = rightPart(r, 2, [shortModel(a.model), age(now - a.startedAt)].filter(Boolean).join(' · '))
    r.put(2, clip(gl(a.title), room))
    out.push(r)
    const d = under()
    if (a.waiting) d.put(2, waitingLine(gl(a.waiting.text), now - a.waiting.since, IW - 2), DIM)
    else if (a.doing) d.put(2, clip(gl(a.doing), IW - 2), DIM)
    else continue
    out.push(d)
  }
  if (more > 0) {
    const r = under()
    r.put(2, `+${more} more`, DIM)
    out.push(r)
  }
  return out
}

/** On a card whose Enter can only copy the resume command (ADR 0008). */
export const RESUME_HINT = '↵ copies resume'

function sessionTone(s: OtherSessionVM): Tok {
  return (s.prSummary?.broken ?? 0) > 0 ? 'fail' : s.status === 'waiting' ? 'wait' : 'rule'
}

function otherRows(s: OtherSessionVM, x: Ctx): Row[] {
  const { IW, now } = x
  const key = sessionKey(s)
  const under = () => {
    const d = new Row(IW)
    if (s.jump) d.item = key
    return d
  }
  const r = under()
  r.head = s.jump ? true : undefined
  const broken = (s.prSummary?.broken ?? 0) > 0
  r.gutter = s.status === 'waiting' ? 'wait' : broken ? 'fail' : s.status === 'busy' ? 'run' : undefined

  type Part = { t: string; s: Sty }
  const since = s.statusSince !== undefined ? ` ${age(now - s.statusSince)}` : ''
  const status: Part[] =
    s.status === 'waiting'
      ? [{ t: '◆', s: tok('wait') }, { t: ` waiting${since}`, s: tok('wait') }]
      : s.status === 'busy'
        ? [{ t: x.phase % 2 ? '◦' : '●', s: tok('run') }, { t: ` busy${since}`, s: DIM }]
        : [{ t: `idle${since}`, s: DIM }]
  if (s.day) status.unshift({ t: `day ${s.day} · `, s: DIM })
  const ps = s.prSummary
  const prs: Part[] = []
  // A count published without its list still says how many run.
  if (s.agentsRunning && !s.agents?.length) prs.push({ t: `${plural(s.agentsRunning, 'agent')} · `, s: DIM })
  if (ps && ps.total > 0) {
    if (ps.broken) prs.push({ t: `✗ ${plural(ps.broken, 'PR')} red`, s: tok('fail') })
    else if (ps.waiting) {
      const t = ps.waiting === ps.total ? `${plural(ps.total, 'PR')} need${ps.total === 1 ? 's' : ''} you` : `${ps.waiting} of ${ps.total} PRs need you`
      prs.push({ t, s: tok('wait') })
    }
    else prs.push({ t: plural(ps.total, 'PR'), s: DIM })
    prs.push({ t: ' · ', s: DIM })
  }
  const width = (ps2: Part[]) => ps2.reduce((n, p) => n + cellLen(p.t), 0)
  const name = expandIds(s.name, s.glosses)
  const keep = Math.min(cellLen(name), 12)
  let right = [...prs, ...status]
  if (IW - width(right) - 2 < keep) right = status
  if (IW - width(right) - 2 < keep) right = []
  let col = IW - width(right)
  for (const p of right) col = r.put(col, p.t, p.s)
  const room = right.length ? IW - width(right) - 2 : IW
  const sty: Sty = s.status === 'waiting' ? { bold: true } : {}
  if (s.jump) {
    x.actions[key] = { kind: 'jump', jump: s.jump }
    r.button(0, clip(name, room), { key, action: x.actions[key] }, sty)
  } else r.put(0, clip(name, room), sty)
  const out = [r]
  const second = expandIds([s.step, s.prText].filter(Boolean).join(' · ') || s.detail || '', s.glosses)
  const hint = s.jump && resumeOnly(s.jump) && IW >= 32 ? RESUME_HINT : ''
  if (second || hint) {
    const d = under()
    d.put(0, clip(second, hint ? IW - cellLen(hint) - 2 : IW), DIM)
    if (hint) d.right(hint, DIM)
    out.push(d)
  }
  if (s.todos && s.todos.total > 0) {
    const t = under()
    let c = t.put(0, 'todos', DIM)
    c = t.put(c + 1, `${s.todos.done}/${s.todos.total}`)
    if (s.todos.active && IW - c - 3 >= 6) {
      t.put(c + 1, '●', tok('run'))
      t.put(c + 3, clip(expandIds(s.todos.active, s.glosses), IW - c - 3))
    }
    out.push(t)
  }
  out.push(...otherAgentRows(s, under, x))
  return out
}

function groupCard(group: TmuxGroupVM, x: Ctx): Row[] {
  const inner: Row[] = []
  group.sessions.forEach((s, i) => {
    if (i > 0) inner.push(new Row(x.IW))
    inner.push(...otherRows(s, x))
  })
  return card(x, group.tmuxSession || 'no tmux', worst(group.sessions.map(sessionTone)), inner, false)
}

// ---------- pull requests ----------

type PrKind = 'fail' | 'wait' | 'run' | 'calm' | 'gone'
const SEV: Record<PrKind, number> = { fail: 0, wait: 1, run: 2, calm: 3, gone: 4 }

export function prKind(p: PrVM): PrKind {
  if (p.merge === 'merged' || p.merge === 'closed') return 'gone'
  if (p.ci.kind === 'failed' || p.merge === 'conflicting') return 'fail'
  if (p.merge === 'behind' || p.merge === 'blocked' || p.watcher === 'none' || p.ci.kind === 'skippedRequired') return 'wait'
  if (p.ci.kind === 'running') return 'run'
  return 'calm'
}

export function groupPrs(prs: readonly PrVM[]): { repo: string; prs: PrVM[] }[] {
  const groups = new Map<string, PrVM[]>()
  for (const p of prs) {
    const list = groups.get(p.repo)
    if (list) list.push(p)
    else groups.set(p.repo, [p])
  }
  const worstOf = (list: PrVM[]) => Math.min(...list.map(p => SEV[prKind(p)]))
  return [...groups.entries()]
    .map(([repo, list], i) => ({
      repo,
      prs: list.map((p, j) => ({ p, j })).sort((a, b) => SEV[prKind(a.p)] - SEV[prKind(b.p)] || a.j - b.j).map(o => o.p),
      i,
    }))
    .sort((a, b) => worstOf(a.prs) - worstOf(b.prs) || a.i - b.i)
    .map(({ repo, prs }) => ({ repo, prs }))
}

function checkCounts(ci: CiState): { total: number; done: number; failed: number } | undefined {
  if (ci.kind === 'running' || ci.kind === 'failed') return ci.total > 0 ? ci : undefined
  if (ci.kind === 'passed') return ci.total > 0 ? { total: ci.total, done: ci.total, failed: 0 } : undefined
  return undefined
}

/** The checks bar and its count, right-aligned; answers the columns it took. */
function checkBar(r: Row, bar: number, ci: CiState, phase: number): number {
  const k = checkCounts(ci)
  const count = k ? `${k.done}/${k.total}` : '0/?'
  const col = r.W - cellLen(count) - 1 - bar
  if (!k) {
    r.put(col, '▱'.repeat(bar), DIM)
    r.put(col + bar + 1, count, DIM)
    return bar + 1 + cellLen(count)
  }
  const { total, done, failed } = k
  const filled = Math.min(bar, Math.round((bar * done) / total))
  const red = failed ? Math.min(filled || 1, Math.max(1, Math.round((bar * failed) / total))) : 0
  const ok = Math.max(0, filled - red)
  const running = done < total
  if (ok) r.put(col, '▰'.repeat(ok), running ? tok('run') : DIM)
  if (red) r.put(col + ok, '▰'.repeat(red), tok('fail'))
  const rest = bar - ok - red
  if (rest) {
    r.put(col + ok + red, '▱'.repeat(rest), DIM)
    // Motion: the next check to finish blinks dim/run; its glyph never changes.
    if (running && phase % 2) r.put(col + ok + red, '▱', tok('run'))
  }
  r.put(col + bar + 1, count, running ? tok('run') : failed ? tok('fail') : DIM)
  return bar + 1 + cellLen(count)
}

type Fact = [string, Sty]

function ciFact(ci: CiState): Fact {
  switch (ci.kind) {
    case 'failed':
      return [`✗ ${clip(ci.firstFailing, 16)} failed`, tok('fail')]
    case 'running':
      return ['ci running', tok('run')]
    case 'passed':
      return ['ci passed', DIM]
    case 'registering':
      return ['checks starting', tok('wait')]
    case 'skippedRequired':
      return [`✗ skipped ${clip(ci.name, 12)}`, tok('wait')]
    case 'none':
      return ['no checks', DIM]
  }
}

function mergeFact(p: PrVM): Fact | undefined {
  switch (p.merge) {
    case 'behind':
      return ['↑ behind main', tok('wait')]
    case 'conflicting':
      return ['✗ conflicts', tok('fail')]
    case 'blocked':
      return ['◆ blocked', tok('wait')]
    default:
      return undefined
  }
}

const GALLERY: Record<PrVM['gallery'], string> = {
  linked: 'gallery linked',
  'no-visual-change': 'no visual change',
  none: 'no gallery',
  unknown: '',
}

function prRows(p: PrVM, tcol: number, x: Ctx): Row[] {
  const { IW, now } = x
  const k = prKind(p)
  const key = prKey(p)
  x.actions[key] = { kind: 'jump', jump: { kind: 'url', url: p.url } }
  const r = new Row(IW)
  r.item = key
  r.head = true
  r.gutter = k === 'fail' ? 'fail' : k === 'wait' ? 'wait' : k === 'run' ? 'run' : undefined
  const ref = `#${p.number}`
  if (k === 'gone') {
    r.put(0, ref, { dim: true, href: p.url })
    const room = rightPart(r, tcol, p.merge === 'closed' ? 'closed' : p.mergedAt !== undefined ? `merged ${age(now - p.mergedAt)} ago` : 'merged', 8)
    r.button(tcol, clip(p.title, room), { key, action: x.actions[key]!, dim: true }, DIM)
    return [r]
  }
  const needs = k === 'fail' || k === 'wait'
  r.put(0, ref, needs ? { bold: true, href: p.url } : { href: p.url })
  const bar = IW >= 56 ? 10 : 6
  const barW = bar + 1 + 5
  const took = IW - tcol - barW - 2 >= 10 ? checkBar(r, bar, p.ci, x.phase) : 0
  r.button(tcol, clip(p.title, IW - tcol - (took ? took + 2 : 0)), { key, action: x.actions[key]! })

  const d = new Row(IW)
  d.item = key
  const facts: Fact[] = [ciFact(p.ci)]
  const merge = mergeFact(p)
  if (merge) facts.push(merge)
  if (GALLERY[p.gallery]) facts.push([GALLERY[p.gallery], DIM])
  if (p.watcher === 'none') facts.push(['no watcher', tok('wait')])
  else facts.push([p.watcher, DIM])
  if (p.stale) facts.push(['stale', DIM])
  let c = tcol
  for (const [i, [t, s]] of facts.entries()) {
    const sep = i ? 3 : 0
    if (c + sep + cellLen(t) > IW) {
      if (i === 0) d.put(c, clip(t, IW - c), s)
      break
    }
    if (sep) c = d.put(c, ' · ', DIM)
    c = d.put(c, t, s)
  }
  return [r, d]
}

function prCard(prs: readonly PrVM[], x: Ctx): Row[] {
  const groups = groupPrs(prs)
  const tcol = Math.max(...prs.map(p => cellLen(`#${p.number}`))) + 2
  const inner: Row[] = []
  groups.forEach((g, i) => {
    if (groups.length > 1) {
      if (i > 0) inner.push(new Row(x.IW))
      const h = new Row(x.IW)
      h.put(0, clip(g.repo, x.IW), DIM)
      inner.push(h)
    }
    for (const p of g.prs) inner.push(...prRows(p, tcol, x))
  })
  const kinds = prs.map(prKind)
  const tone = worst(kinds.map(k => (k === 'fail' ? 'fail' : k === 'wait' ? 'wait' : 'rule')))
  return card(x, 'pull requests', tone, inner, false)
}

// ---------- hint and indicators ----------

function hint(r: Row, focused: boolean, actions: Record<string, Action>) {
  if (!focused) {
    r.put(1, clip(UNFOCUSED_HINT, r.W - 1), DIM)
    return
  }
  actions.j = { kind: 'move', dir: 1 }
  actions.k = { kind: 'move', dir: -1 }
  // A plain hotkey Button draws "j: next" itself; the cells mirror that.
  let c = r.button(1, 'j: next', { key: 'j', label: 'next', hotkey: 'j', action: actions.j, dim: true }, DIM)
  c = r.put(c, ' · ', DIM)
  c = r.button(c, 'k: prev', { key: 'k', label: 'prev', hotkey: 'k', action: actions.k, dim: true }, DIM)
  r.put(c, clip(` · ${FOCUSED_HINT}`, r.W - c), DIM)
}

function indicator(r: Row, key: 'up' | 'down', n: number, lit: { fail: number; wait: number }, actions: Record<string, Action>) {
  actions[key] = { kind: 'scroll', dir: key === 'up' ? -1 : 1 }
  const text = key === 'up' ? `↑ ${plural(n, 'row')} above` : `↓ ${plural(n, 'row')} below`
  let c = r.button(1, text, { key, action: actions[key]!, dim: true }, DIM)
  if (lit.fail) {
    c = r.put(c + 3, '✗', tok('fail'))
    c = r.put(c, ` ${lit.fail} broken`)
  }
  if (lit.wait) {
    c = r.put(c + 3, '◆', tok('wait'))
    c = r.put(c, ` ${lit.wait} waiting on you`)
  }
  if (!lit.fail && !lit.wait) r.put(c, ', nothing that needs you', DIM)
}

function litCount(rows: readonly Row[]) {
  let fail = 0
  let wait = 0
  for (const r of rows) {
    if (!r.head && r.item !== undefined) continue
    if (r.gutter === 'fail') fail++
    else if (r.gutter === 'wait') wait++
  }
  return { fail, wait }
}

// ---------- the pane ----------

export function body(m: HqModel, x: Ctx): Row[] {
  const out: Row[] = [...sessionCard(m, x)]
  for (const g of m.others) out.push(new Row(x.W), ...groupCard(g, x))
  if (m.current.prs.length) out.push(new Row(x.W), ...prCard(m.current.prs, x))
  return out
}

/** The whole pane, exactly `view.rows` rows: header, flare and hint pinned; the body windowed. */
export function layout(m: HqModel, view: View): Layout {
  const W = Math.max(1, view.width)
  const R = Math.max(1, view.rows)
  const actions: Record<string, Action> = {}
  const IW = Math.max(1, W >= FRAME_MIN ? W - 8 : W - 2)
  const x: Ctx = { W, IW, now: m.now, phase: view.phase, expanded: new Set(view.expanded), actions }

  const top0 = new Row(W)
  header(top0, m, view.focused)
  const flare = new Row(W)
  flareRow(flare, m, actions)
  // Header, a blank, the flare when there is one, then the row the "above" indicator takes.
  const top = m.flare ? 4 : 2
  const content = body(m, x)

  const items: string[] = []
  const itemLine: Record<string, number> = {}
  if (m.flare) {
    items.push('flare')
    itemLine.flare = -1
  }
  content.forEach((r, i) => {
    if (r.head && r.item !== undefined && actions[r.item] && !(r.item in itemLine)) {
      items.push(r.item)
      itemLine[r.item] = i
    }
  })

  // Rows the frame keeps: the top rows, [body], below, hint.
  const region = Math.max(0, R - top - 2)
  const overflow = content.length > region
  const scroll = overflow ? Math.min(Math.max(0, view.scroll), content.length - region) : 0
  const vis = content.slice(scroll, scroll + region)
  const below = Math.max(0, content.length - scroll - region)

  const out: Row[] = Array.from({ length: R }, () => new Row(W))
  const place = (i: number, r: Row) => {
    if (i >= 0 && i < R) out[i] = r
  }
  place(0, top0)
  if (m.flare) place(2, flare)
  if (scroll > 0) {
    const r = new Row(W)
    indicator(r, 'up', scroll, litCount(content.slice(0, scroll)), actions)
    place(top - 1, r)
  }
  vis.forEach((r, i) => place(top + i, r))
  if (below > 0) {
    const r = new Row(W)
    indicator(r, 'down', below, litCount(content.slice(scroll + region)), actions)
    place(R - 2, r)
  }
  const hr = new Row(W)
  hint(hr, view.focused, actions)
  place(R - 1, hr)

  if (view.focused && view.cursor !== null) {
    const r = out.find(row => row.item === view.cursor && row.head)
    if (r) r.put(r.mark ?? 2, '▶', tok('accent'))
  }
  return { rows: out, items, itemLine, actions, region, bodyLen: content.length, scroll }
}

/** The scroll that keeps `key`'s first line in the window. */
export function scrollFor(l: Pick<Layout, 'itemLine' | 'region' | 'bodyLen'>, key: string, scroll: number): number {
  const line = l.itemLine[key]
  if (line === undefined || line < 0) return scroll
  const max = Math.max(0, l.bodyLen - l.region)
  let s = scroll
  if (line < s) s = line
  else if (line >= s + l.region - 1) s = line - l.region + 2
  return Math.min(Math.max(0, s), max)
}
