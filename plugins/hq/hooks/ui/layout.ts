import { summaryLine } from '../model/plain'
import { LONG_CALL_MS } from '../model/types'
import type {
  AgentVM,
  CiState,
  HqModel,
  NowVM,
  OtherAgentVM,
  OtherSessionVM,
  PrVM,
  TmuxGroupVM,
  TodoVM,
  WaitVM,
  WaitingVM,
} from '../model/types'
import { caretKey } from './caret'
import { resumeOnly } from './focus'
import { Row } from './row'
import type { Action, Sty, Tok } from './row'
import { expandIds } from '../data/ids'
import { bucketOf } from '../data/wake'
import type { Bucket } from '../data/wake'
import { age, cellLen, clip, elapsed, plural, wrap, wrapCapped } from './text'
import { accountParts, meterParts, partsWidth, putRight } from './meter'
import type { Part } from './meter'

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
  /** A config problem, drawn dim above the hint. */
  warning?: string
}

export type Layout = {
  rows: Row[]
  /** Actionable items in j/k order, offscreen ones included. */
  items: string[]
  /** Body index of each item's first line (the flare is -1). */
  itemLine: Record<string, number>
  /** The item each item-row Button belongs to, by key. */
  owner: Record<string, string>
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
/** Item key of the `+N finished` row; its open state rides in `expanded` under FINISHED_ID. */
export const FINISHED_KEY = 'finished'
export const FINISHED_ID = '+finished'

/** The running dot: one glyph, its colour stepping between full and dim with the motion phase. */
const runDot = (phase: number): Sty => tok('run', phase % 2 ? { dim: true } : {})
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
  /** The cursor's item while the pane is focused, else null. */
  cursor: string | null
  /** Glosses of the ids in the card being drawn. */
  g?: Readonly<Record<string, string>>
}

/** Below this width a card drops its border and keeps its title. */
const FRAME_MIN = 20

/** Rounded at rest; heavy on the card holding the cursor. */
const ROUND = { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│', lj: '├', rj: '┤' }
const HEAVY = { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃', lj: '┣', rj: '┫' }

/** A section divider row; `card` draws it joined to the border. */
const section = (IW: number, label = ''): Row => Object.assign(new Row(IW), { section: label })

/** A divider then its rows, or nothing when there are none. */
const withSection = (IW: number, label: string, rows: Row[]): Row[] => (rows.length ? [section(IW, label), ...rows] : [])

const THIS_SESSION = 'this session'

/** Inner rows inside a border, the title in the top edge, two cells of padding each side. */
function card(x: Ctx, title: string, tone: Tok, inner: Row[], current = false): Row[] {
  const { W } = x
  const label: Sty = current ? tok('accent', { bold: true }) : { bold: true }
  if (W < FRAME_MIN) {
    const h = new Row(W)
    h.put(0, clip(title, W), label)
    return [
      h,
      ...inner.map(r => {
        if (r.section === undefined) return Object.assign(new Row(W).inset(2, r), { mark: 0 })
        const d = new Row(W)
        d.put(0, clip(r.section ? `── ${r.section}` : '──', W), DIM)
        return d
      }),
    ]
  }
  const g = x.cursor !== null && inner.some(r => r.item === x.cursor) ? HEAVY : ROUND
  const edge = tok(tone)
  const top = new Row(W)
  top.put(1, `${g.tl}${g.h}`, edge)
  const room = W - 8
  // The suffix goes before the name is cut.
  const suffix = current && title !== THIS_SESSION ? ` · ${THIS_SESSION}` : ''
  let end = top.put(4, clip(title, room), label)
  if (suffix && cellLen(title) + cellLen(suffix) <= room) end = top.put(end, suffix, DIM)
  top.fill(end + 1, W - 2, g.h, edge)
  top.put(W - 2, g.tr, edge)
  const side = (r: Row) => {
    if (r.section !== undefined) {
      const d = new Row(W)
      d.put(1, g.lj, edge)
      d.fill(2, W - 2, g.h, edge)
      if (r.section) {
        d.put(3, ' ')
        d.put(d.put(4, clip(r.section, W - 8), DIM), ' ')
      }
      d.put(W - 2, g.rj, edge)
      return d
    }
    const s = new Row(W)
    s.inset(4, r)
    s.put(1, g.v, edge)
    s.put(W - 2, g.v, edge)
    s.mark = 2
    return s
  }
  const bottom = new Row(W)
  bottom.put(1, g.bl, edge)
  bottom.fill(2, W - 2, g.h, edge)
  bottom.put(W - 2, g.br, edge)
  return [top, ...inner.map(side), bottom]
}

/** The cursor row's style: bold at full strength. */
const FOCUS: Sty = { bold: true }
/** A link's cursor row: underlined too. */
const LINK_FOCUS: Sty = { bold: true, underline: true }
/** Lines the cursor row may grow to. */
const FOCUS_LINES = 3

const worst = (tones: readonly Tok[]): Tok => (tones.includes('fail') ? 'fail' : tones.includes('wait') ? 'wait' : 'rule')

// ---------- header and flare ----------

/** The pinned top row: plan usage right-aligned; narrowing drops the bars, then the week. */
function header(r: Row, m: HqModel, focused: boolean) {
  if (focused) r.put(0, '▌', tok('accent'))
  const a = m.account
  if (!a) return
  const tries = [accountParts(a), accountParts(a, false), accountParts({ ...a, week: undefined }, false)]
  for (const parts of tries) if (putRight(r, parts, 2)) return
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
  nodes.sort((x, y) => rank(x.a) - rank(y.a) || (rank(x.a) === 2 ? (y.a.endedAt ?? 0) - (x.a.endedAt ?? 0) : x.a.startedAt - y.a.startedAt))
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
  const focused = x.cursor === key
  /** One line clipped to `first`, or on the cursor row up to FOCUS_LINES, the rest `IW - tc` wide. */
  const lines = (text: string, first: number) => (focused ? wrapCapped(text, first, IW - tc, FOCUS_LINES) : [clip(text, first)])
  const extra = (rest: string[], sty: Sty) =>
    rest.map(line => {
      const c = mk(false)
      c.put(tc, line, sty)
      return c
    })

  if (!failed && !live) {
    const killed = a.status === 'killed'
    r.put(gc, killed ? '✗' : '✓', DIM)
    const avail = rightPart(r, tc, a.endedAt !== undefined ? `${age(now - a.endedAt)} ago` : '')
    const outcome = summaryLine(a.outcome) ?? (killed ? 'stopped' : '')
    const full = gl(a.title)
    if (focused) {
      const [head = '', ...rest] = lines(outcome ? `${full} → ${outcome}` : full, avail)
      r.button(tc, head, { key, action: x.actions[key]! }, FOCUS)
      out.push(...extra(rest, FOCUS))
    } else {
      const title = outcome && cellLen(full) + 3 + 12 > avail ? clip(full, Math.max(8, avail - 3 - 12)) : clip(full, avail)
      let c = r.button(tc, title, { key, action: x.actions[key]!, dim: true }, DIM)
      if (outcome && avail - cellLen(title) - 3 >= 4) {
        c = r.put(c, ' → ', DIM)
        r.put(c, clip(outcome, avail - cellLen(title) - 3), DIM)
      }
    }
  } else {
    const longCall = a.status === 'running' && a.callSince !== undefined && now - a.callSince >= LONG_CALL_MS
    const glyph = failed ? '✗' : a.status === 'waiting' || longCall ? '◷' : a.status === 'pending' ? '◦' : '●'
    r.put(gc, glyph, glyph === '●' ? runDot(x.phase) : tok(failed ? 'fail' : 'run'))
    const end = failed ? (a.endedAt ?? now) : now
    const parts = [shortModel(a.model), elapsed(end - a.startedAt)].filter(Boolean)
    let right = parts.join(' · ')
    if (a.place) {
      const placed = `${clip(a.place, 18)} · ${right}`
      if (IW - tc - cellLen(placed) - 2 >= 16) right = placed
    }
    if (IW - tc - cellLen(right) - 2 < 12) right = parts.slice(-1).join('')
    const room = rightPart(r, tc, right)
    const sty = failed || focused ? FOCUS : {}
    const [head = '', ...rest] = lines(gl(a.title), room)
    r.button(tc, head, { key, action: x.actions[key]! }, sty)
    out.push(...extra(rest, sty))

    const d = mk(false)
    let more: Row[] = []
    if (failed) {
      const tail = a.endedAt !== undefined ? ` · failed ${age(now - a.endedAt)} ago` : ''
      const [first = '', ...rest2] = lines(gl(a.now ?? a.outcome ?? 'failed'), IW - tc - cellLen(tail))
      const c = d.put(tc, first)
      if (tail) d.put(c, tail, DIM)
      more = extra(rest2, {})
    } else if (longCall) {
      d.put(tc, waitingLine(gl(a.now ?? 'working'), now - a.callSince!, IW - tc), DIM)
    } else {
      const child = node.kids.find(k => LIVE.has(k.a.status))
      const progress = a.todo && a.status !== 'waiting' ? `${a.todo.done}/${a.todo.total}` : ''
      const text =
        a.status === 'waiting' && child
          ? `waiting on ${gl(child.a.title)}`
          : gl(a.todo?.text ?? a.now ?? (a.status === 'pending' ? 'starting' : 'working'))
      const [first = '', ...rest2] = lines(text, IW - tc - (progress ? cellLen(progress) + 2 : 0))
      d.put(tc, first, DIM)
      if (progress) d.right(progress, DIM)
      more = extra(rest2, DIM)
    }
    out.push(d, ...more)
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
    // Only what the header and doing line do not say already.
    const where = [a.worktree, a.files.join(', ')].filter(Boolean).join(' · ')
    if (where) field('in', where, DIM)
    const result = summaryLine(a.outcome)
    if (result) field('result', result)
  }
  return out
}

/** Live and failed agents, then after a blank the newest finished one and a `+N finished` toggle for the rest. */
function agentBlock(agents: readonly AgentVM[], x: Ctx): Row[] {
  const out: Row[] = []
  const roots = agentTree(agents)
  const walk = (n: Node, depth: number) => {
    out.push(...agentRows(n, Math.min(depth, 2), x))
    n.kids.forEach(k => walk(k, depth + 1))
  }
  const active = roots.filter(n => rank(n.a) !== 2)
  const finished = roots.filter(n => rank(n.a) === 2)
  active.forEach(n => walk(n, 0))
  if (!finished.length) return out
  if (active.length) out.push(new Row(x.IW))
  walk(finished[0]!, 0)
  if (finished.length > 1) {
    const open = x.expanded.has(FINISHED_ID)
    x.actions[FINISHED_KEY] = { kind: 'toggle', id: FINISHED_ID }
    const r = new Row(x.IW)
    r.item = FINISHED_KEY
    r.head = true
    const n = finished.length - 1
    const label = open ? `− ${n} finished` : `+${n} finished`
    const action = x.actions[FINISHED_KEY]
    if (x.cursor === FINISHED_KEY) r.button(2, label, { key: FINISHED_KEY, action }, FOCUS)
    else r.button(2, label, { key: FINISHED_KEY, action, dim: true }, DIM)
    out.push(r)
    if (open) finished.slice(1).forEach(f => walk(f, 0))
  }
  return out
}

// ---------- this session ----------

/** Parts right-aligned as the first that leaves `keep` cells of text; answers the text's room. */
function fitRight(r: Row, tries: readonly Part[][], keep = 8): number {
  const fit = tries.find(p => r.W - partsWidth(p) - 2 >= keep) ?? []
  putRight(r, fit)
  return fit.length ? r.W - partsWidth(fit) - 2 : r.W
}

/** What the main loop waits on while idle: its running agents and background shells. */
function waitingOn(agents: readonly AgentVM[], waits: readonly WaitingVM[]): { text: string; since: number } | undefined {
  const ids = new Set(agents.map(a => a.id))
  // The main loop waits on the agents it started; a nested child is its parent's wait.
  const live = agents.filter(a => LIVE.has(a.status) && !(a.parentId !== undefined && ids.has(a.parentId)))
  if (!live.length && !waits.length) return undefined
  const what = [live.length ? plural(live.length, 'agent') : '', waits.length ? plural(waits.length, 'background task') : '']
  return {
    text: `waiting on ${what.filter(Boolean).join(' · ')}`,
    since: Math.min(...live.map(a => a.startedAt), ...waits.map(w => w.since)),
  }
}

/** The now line; `meter` rides on its right when the card has no goal line to carry it. */
function nowRows(
  n: NowVM | undefined,
  x: Ctx,
  meter: { full: Part[]; pct: Part[] },
  on: { text: string; since: number } | undefined,
): Row[] {
  const { IW, now } = x
  const r = new Row(IW)
  const idle = !n || n.idle
  const waiting = idle && on !== undefined
  const ago = waiting ? elapsed(now - on.since) : n ? age(now - n.since) : ''
  const lead: Part[] = ago ? [{ t: ago, s: DIM }] : []
  const room = fitRight(r, [[...lead, ...meter.full], [...lead, ...meter.pct], lead], 10) - 2
  if (waiting) {
    r.put(0, '◷', tok('run'))
    r.put(2, clip(on.text, room))
  } else if (!n) {
    if (!meter.full.length) return []
  } else if (n.idle) {
    r.put(0, '○', DIM)
    r.put(2, clip(n.prompt ? `idle · ${n.prompt}` : 'idle', room), DIM)
  } else {
    r.put(0, '●', runDot(x.phase))
    r.put(2, clip(n.prompt ?? 'working', room))
  }
  const out = [r]
  if (n?.tool && !n.idle) {
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
  const meter = meterParts(cur.context)
  const on = waitingOn(cur.agents, cur.waiting ?? [])
  if (cur.goal) {
    // Summarised like another session's card: goal, then day, status and meter on the right; the step under it.
    const g = new Row(x.IW)
    const day: Part[] = cur.goal.day ? [{ t: `day ${cur.goal.day} · `, s: DIM }] : []
    const busy = cur.now !== undefined && !cur.now.idle
    const status: Part[] = busy
      ? [
          { t: '●', s: runDot(x.phase) },
          { t: ' busy', s: DIM },
        ]
      : on
        ? [
            { t: '◷', s: tok('run') },
            { t: ' waiting', s: DIM },
          ]
        : [{ t: 'idle', s: DIM }]
    const room = fitRight(g, [[...day, ...status, ...meter.full], [...day, ...status, ...meter.pct], [...status, ...meter.pct], status])
    g.put(0, clip(expandIds(cur.goal.text, x.g), room), { bold: true })
    inner.push(g)
    if (cur.goal.step) {
      const st = new Row(x.IW)
      st.put(0, clip(expandIds(cur.goal.step, x.g), x.IW), DIM)
      inner.push(st)
    }
  }
  inner.push(...nowRows(cur.now, x, cur.goal ? { full: [], pct: [] } : meter, on))
  if (cur.todos?.length) inner.push(todoRow(cur.todos, x))
  if (cur.waiting?.length) inner.push(...waitingRows(cur.waiting, x))
  const sections = [...withSection(x.IW, 'agents', agentBlock(cur.agents, x)), ...withSection(x.IW, 'pull requests', prSection(cur.prs, x))]
  // Without a line of its own the card would open on a divider.
  if (inner.length === 0) {
    const r = new Row(x.IW)
    r.put(0, 'nothing running', DIM)
    inner.push(r)
  }
  inner.push(...sections)
  const tone = worst([...cur.agents.filter(a => a.status === 'failed').map(() => 'fail' as const), ...cur.prs.map(prTone)])
  return card(x, cur.goal && cur.title ? cur.title : THIS_SESSION, tone, inner, true)
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
  const own: Tok = (s.prSummary?.broken ?? 0) > 0 ? 'fail' : s.status === 'waiting' ? 'wait' : 'rule'
  return worst([own, ...(s.prs ?? []).map(prTone)])
}

const OTHER_PRS_SHOWN = 3
/** The status line's urgency, most urgent first. */
const URGENCY: readonly Bucket[] = ['red', 'conflict', 'rebase', 'running', 'green', 'open']
const urgency = (p: PrVM) => {
  const b = bucketOf(p)
  return b ? URGENCY.indexOf(b) : URGENCY.length
}
export const morePrsKey = (s: OtherSessionVM) => `${sessionKey(s)}:prs`
export const morePrsId = (s: OtherSessionVM) => `+prs:${s.sessionId}`
export const sessionPrKey = (s: OtherSessionVM, p: PrVM) => `${sessionKey(s)}:${prKey(p)}`

/** Another session's open PRs, one line each, most urgent first: three, then a `+N more PRs` toggle. */
function otherPrRows(s: OtherSessionVM, x: Ctx): Row[] {
  const open = (s.prs ?? [])
    .filter(p => prKind(p) !== 'gone')
    .map((p, i) => ({ p, i }))
    .sort((a, b) => urgency(a.p) - urgency(b.p) || a.i - b.i)
    .map(o => o.p)
  if (!open.length) return []
  const id = morePrsId(s)
  const expanded = x.expanded.has(id)
  const shown = open.length > OTHER_PRS_SHOWN && !expanded ? open.slice(0, OTHER_PRS_SHOWN) : open
  const tcol = Math.max(...shown.map(p => cellLen(`#${p.number}`))) + 2
  const out = shown.flatMap(p => prRows(p, tcol, x, sessionPrKey(s, p), true))
  const n = open.length - OTHER_PRS_SHOWN
  if (n > 0) {
    const key = morePrsKey(s)
    const action: Action = { kind: 'toggle', id }
    x.actions[key] = action
    const r = new Row(x.IW)
    r.item = key
    r.head = true
    const label = expanded ? `− ${n} more ${n === 1 ? 'PR' : 'PRs'}` : `+${n} more ${n === 1 ? 'PR' : 'PRs'}`
    if (x.cursor === key) r.button(0, label, { key, action }, FOCUS)
    else r.button(0, label, { key, action, dim: true }, DIM)
    out.push(r)
  }
  return out
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
      ? [
          { t: '◆', s: tok('wait') },
          { t: ` waiting${since}`, s: tok('wait') },
        ]
      : s.status === 'busy'
        ? [
            { t: '●', s: runDot(x.phase) },
            { t: ` busy${since}`, s: DIM },
          ]
        : [{ t: `${s.wait?.kind === 'turn' ? 'your turn' : 'idle'}${since}`, s: DIM }]
  if (s.day) status.unshift({ t: `day ${s.day} · `, s: DIM })
  const ps = s.prSummary
  const prs: Part[] = []
  // A count published without its list still says how many run.
  if (s.agentsRunning && !s.agents?.length) prs.push({ t: `${plural(s.agentsRunning, 'agent')} · `, s: DIM })
  if (ps && ps.total > 0) {
    if (ps.broken) prs.push({ t: `✗ ${plural(ps.broken, 'PR')} red`, s: tok('fail') })
    else if (ps.waiting) {
      const t =
        ps.waiting === ps.total
          ? `${plural(ps.total, 'PR')} need${ps.total === 1 ? 's' : ''} you`
          : `${ps.waiting} of ${ps.total} PRs need you`
      prs.push({ t, s: tok('wait') })
    } else prs.push({ t: plural(ps.total, 'PR'), s: DIM })
    prs.push({ t: ' · ', s: DIM })
  }
  const width = (ps2: Part[]) => ps2.reduce((n, p) => n + cellLen(p.t), 0)
  const name = expandIds(s.name, s.glosses)
  const keep = Math.min(cellLen(name), 12)
  // Narrowing drops the meter's cells, then the PR facts, then its percent, then the status.
  const meter = meterParts(s.context)
  const right =
    [[...prs, ...status, ...meter.full], [...prs, ...status, ...meter.pct], [...status, ...meter.pct], status].find(
      p => IW - width(p) - 2 >= keep,
    ) ?? []
  let col = IW - width(right)
  for (const p of right) col = r.put(col, p.t, p.s)
  const room = right.length ? IW - width(right) - 2 : IW
  const focused = s.jump !== undefined && x.cursor === key
  const sty: Sty = s.status === 'waiting' || focused ? FOCUS : {}
  const lines = (text: string, first: number) => (focused ? wrapCapped(text, first, IW, FOCUS_LINES) : [clip(text, first)])
  const extra = (rest: string[], st: Sty) =>
    rest.map(line => {
      const c = under()
      c.put(0, line, st)
      return c
    })
  const [head = '', ...rest] = lines(name, room)
  if (s.jump) {
    x.actions[key] = { kind: 'jump', jump: s.jump }
    r.button(0, head, { key, action: x.actions[key] }, sty)
  } else r.put(0, head, sty)
  const out = [r, ...extra(rest, sty)]
  const second = expandIds([s.step, s.prText].filter(Boolean).join(' · ') || s.detail || '', s.glosses)
  const hint = s.jump && resumeOnly(s.jump) && IW >= 32 ? RESUME_HINT : ''
  if (second || hint) {
    const d = under()
    const [first = '', ...more] = lines(second, hint ? IW - cellLen(hint) - 2 : IW)
    d.put(0, first, DIM)
    if (hint) d.right(hint, DIM)
    out.push(d, ...extra(more, DIM))
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
  if (s.status === 'waiting' && s.wait && s.wait.kind !== 'turn') out.push(asksRow(s, s.wait, under(), x))
  out.push(...withSection(IW, 'agents', otherAgentRows(s, under, x)), ...withSection(IW, 'pull requests', otherPrRows(s, x)))
  return out
}

/** "◆ asks: <what>", the options dimmed after it; clicking it jumps like the name does. */
function asksRow(s: OtherSessionVM, w: WaitVM, a: Row, x: Ctx): Row {
  const { IW } = x
  let c = a.put(0, '◆', tok('wait'))
  c = a.put(c + 1, 'asks: ', tok('wait'))
  const text = clip(w.text, IW - c)
  if (s.jump) {
    const key = `${sessionKey(s)}:asks`
    x.actions[key] = { kind: 'jump', jump: s.jump }
    c = a.button(c, text, { key, action: x.actions[key] })
  } else c = a.put(c, text)
  const opts = w.options?.length ? ` · ${w.options.join(' / ')}` : ''
  if (opts && IW - c >= 6) a.put(c, clip(opts, IW - c), DIM)
  return a
}

function groupCard(group: TmuxGroupVM, x: Ctx): Row[] {
  const inner: Row[] = []
  let sectioned = false
  for (const s of group.sessions) {
    // After a session with sections a bare rule, so the next session does not read as one of its rows.
    if (inner.length) inner.push(sectioned ? section(x.IW) : new Row(x.IW))
    const rows = otherRows(s, x)
    sectioned = rows.some(r => r.section !== undefined)
    inner.push(...rows)
  }
  return card(x, group.tmuxSession || (group.background ? 'background' : 'no tmux'), worst(group.sessions.map(sessionTone)), inner)
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
      prs: list
        .map((p, j) => ({ p, j }))
        .sort((a, b) => SEV[prKind(a.p)] - SEV[prKind(b.p)] || a.j - b.j)
        .map(o => o.p),
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

/** A PR's rows; `compact` is one line with its status on the right, for another session's card. */
function prRows(p: PrVM, tcol: number, x: Ctx, key = prKey(p), compact = false): Row[] {
  const { IW, now } = x
  const k = prKind(p)
  x.actions[key] = { kind: 'jump', jump: { kind: 'url', url: p.url } }
  const r = new Row(IW)
  r.item = key
  r.head = true
  // The session's own row already counts toward the scroll indicators.
  if (!compact) r.gutter = k === 'fail' ? 'fail' : k === 'wait' ? 'wait' : k === 'run' ? 'run' : undefined
  const ref = `#${p.number}`
  const out = [r]
  /** The title as its Button; on the cursor row the whole title, wrapped under itself. */
  const title = (room: number, dim: boolean) => {
    if (x.cursor !== key) {
      r.button(tcol, clip(p.title, room), { key, action: x.actions[key]!, ...(dim ? { dim: true as const } : {}) }, dim ? DIM : {})
      return
    }
    const [head = '', ...rest] = wrapCapped(p.title, room, IW - tcol, FOCUS_LINES)
    r.button(tcol, head, { key, action: x.actions[key]! }, LINK_FOCUS)
    for (const line of rest) {
      const c = new Row(IW)
      c.item = key
      c.put(tcol, line, LINK_FOCUS)
      out.push(c)
    }
  }
  if (k === 'gone') {
    r.put(0, ref, { dim: true, href: p.url })
    const room = rightPart(
      r,
      tcol,
      p.merge === 'closed' ? 'closed' : p.mergedAt !== undefined ? `merged ${age(now - p.mergedAt)} ago` : 'merged',
      8,
    )
    title(room, true)
    return out
  }
  const needs = k === 'fail' || k === 'wait'
  r.put(0, ref, needs ? { bold: true, href: p.url } : { href: p.url })
  if (compact) {
    const [t, st] = p.ci.kind === 'failed' ? ciFact(p.ci) : (mergeFact(p) ?? ciFact(p.ci))
    const fits = IW - tcol - cellLen(t) - 2 >= 10
    if (fits) r.right(t, st)
    title(IW - tcol - (fits ? cellLen(t) + 2 : 0), false)
    return out
  }
  const bar = IW >= 56 ? 10 : 6
  const barW = bar + 1 + 5
  const took = IW - tcol - barW - 2 >= 10 ? checkBar(r, bar, p.ci, x.phase) : 0
  title(IW - tcol - (took ? took + 2 : 0), false)

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
  out.push(d)
  return out
}

/** This session's PRs grouped by repo, each with its checks bar and facts line. */
function prSection(prs: readonly PrVM[], x: Ctx): Row[] {
  if (!prs.length) return []
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
  return inner
}

function prTone(p: PrVM): Tok {
  const k = prKind(p)
  return k === 'fail' ? 'fail' : k === 'wait' ? 'wait' : 'rule'
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

/** Separates this session's card from the others: a dim rule across the card width. */
function divider(W: number): Row {
  const r = new Row(W)
  if (W < FRAME_MIN) {
    r.put(0, clip('── other sessions', W), DIM)
    return r
  }
  const end = r.put(1, '── other sessions ', DIM)
  r.fill(end, W - 1, '─', DIM)
  return r
}

export function body(m: HqModel, x: Ctx): Row[] {
  const out: Row[] = [...sessionCard(m, x)]
  if (m.others.length) out.push(new Row(x.W), divider(x.W))
  for (const g of m.others) out.push(new Row(x.W), ...groupCard(g, x))
  return out
}

/** The whole pane, exactly `view.rows` rows: header, flare and hint pinned; the body windowed. */
export function layout(m: HqModel, view: View): Layout {
  const W = Math.max(1, view.width)
  const R = Math.max(1, view.rows)
  const actions: Record<string, Action> = {}
  const IW = Math.max(1, W >= FRAME_MIN ? W - 8 : W - 2)
  const x: Ctx = {
    W,
    IW,
    now: m.now,
    phase: view.phase,
    expanded: new Set(view.expanded),
    actions,
    cursor: view.focused ? view.cursor : null,
  }

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

  // Rows the frame keeps: the top rows, [body], below, [warning], hint.
  const foot = view.warning ? 1 : 0
  const region = Math.max(0, R - top - 2 - foot)
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
    place(R - 2 - foot, r)
  }
  if (view.warning) {
    const r = new Row(W)
    r.put(1, view.warning, DIM)
    place(R - 2, r)
  }
  const hr = new Row(W)
  hint(hr, view.focused, actions)
  place(R - 1, hr)

  const owner: Record<string, string> = {}
  for (const r of m.flare ? [flare, ...content] : content) {
    if (r.item !== undefined) for (const b of r.buttons) owner[b.key] ??= r.item
  }
  // Each drawn item's caret; the cursor's shows the marker. The engine's focus
  // ring inverts it, so a right-half block reads as an accent bar on the left.
  const capped = new Set<string>()
  for (const r of out) {
    if (!r.head || r.item === undefined || !actions[r.item] || capped.has(r.item)) continue
    capped.add(r.item)
    const isCursor = view.focused && view.cursor === r.item
    r.button(r.mark ?? 2, isCursor ? '▐' : ' ', { key: caretKey(r.item), action: actions[r.item]! }, isCursor ? tok('accent') : {})
  }
  return { rows: out, items, itemLine, owner, actions, region, bodyLen: content.length, scroll }
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
