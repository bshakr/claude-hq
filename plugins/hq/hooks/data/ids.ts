// Ticket ids and ADR numbers glossed with a few words, so a card reads outside the session that wrote it.

export const GLOSS_MODEL = 'haiku'
export const GLOSS_WORDS = 5
export const LOOKUP_TTL_MS = 24 * 60 * 60_000
export const LOOKUP_RETRY_MS = 30 * 60_000
export const TICKET_LOOKUPS_PER_TICK = 3
export const ADR_LOOKUPS_PER_TICK = 5
export const BRIEF_BATCH_MAX = 12

const TICKET_RE = /\b[A-Z]{2,5}-\d+\b/g
const ADR_RE = /\bADR[ -]?(\d{1,4})\b/g

export type IdRef = { kind: 'ticket'; id: string } | { kind: 'adr'; id: string; num: string }

/** Canonical key of an ADR number: "ADR 0019" for "ADR-19", "ADR 19", "ADR 0019". */
export const adrId = (n: string) => `ADR ${n.padStart(4, '0')}`

/** Each id once, in the order of its first occurrence. */
export function findIds(text: string): IdRef[] {
  const hits: { at: number; ref: IdRef }[] = []
  for (const m of text.matchAll(TICKET_RE)) {
    if (/^ADR-/.test(m[0])) continue
    hits.push({ at: m.index ?? 0, ref: { kind: 'ticket', id: m[0] } })
  }
  for (const m of text.matchAll(ADR_RE)) {
    const num = m[1]!.padStart(4, '0')
    hits.push({ at: m.index ?? 0, ref: { kind: 'adr', id: adrId(num), num } })
  }
  hits.sort((a, b) => a.at - b.at)
  const seen = new Set<string>()
  return hits.flatMap(h => (seen.has(h.ref.id) ? [] : (seen.add(h.ref.id), [h.ref])))
}

/** "BLO-1947 (withhold file from labels)": the first occurrence of each glossed id in the line. */
export function expandIds(text: string, glosses: Readonly<Record<string, string>> | undefined): string {
  if (!glosses || !text) return text
  const done = new Set<string>()
  const re = new RegExp(`${ADR_RE.source}|${TICKET_RE.source}`, 'g')
  return text.replace(re, (m: string, num: string | undefined, offset: number, whole: string) => {
    const id = num !== undefined ? adrId(num) : m
    const g = glosses[id]
    if (!g || done.has(id)) return m
    done.add(id)
    // Already glossed by whoever wrote the line.
    if (whole.slice(offset + m.length).startsWith(' (')) return m
    return `${m} (${g})`
  })
}

export interface GlossEntry {
  title?: string
  brief?: string
  fetchedAt?: number
  failedAt?: number
  briefFailedAt?: number
}

export const words = (s: string, n: number) => s.trim().split(/\s+/).slice(0, n).join(' ').replace(/[.;:,]+$/, '')

/** The model's brief, else the title's first words. */
export function glossOf(e: GlossEntry | undefined): string | undefined {
  if (!e?.title) return undefined
  return e.brief || words(e.title, GLOSS_WORDS) || undefined
}

/** Never looked up, failed over LOOKUP_RETRY_MS ago, or fetched over LOOKUP_TTL_MS ago. */
export function lookupDue(e: GlossEntry | undefined, now: number): boolean {
  if (!e) return true
  if (e.failedAt !== undefined && (e.fetchedAt === undefined || e.failedAt > e.fetchedAt)) return now - e.failedAt >= LOOKUP_RETRY_MS
  return e.fetchedAt === undefined || now - e.fetchedAt >= LOOKUP_TTL_MS
}

export function briefDue(e: GlossEntry | undefined, now: number): boolean {
  if (!e?.title || e.brief) return false
  return e.briefFailedAt === undefined || now - e.briefFailedAt >= LOOKUP_RETRY_MS
}

/** `linear issue show <id>` opens with "# BLO-1947: <title>". */
export function parseLinearShow(stdout: string, id: string): string | undefined {
  const m = /^#\s+([A-Z]{2,5}-\d+):\s*(.+?)\s*$/m.exec(stdout)
  return m && m[1] === id ? m[2] : undefined
}

/** An ADR's title: its first "# " heading, else its slug. */
export function adrTitle(text: string | undefined, fileName: string): string {
  const h = text === undefined ? undefined : /^#\s+(.+?)\s*$/m.exec(text)?.[1]
  return h || fileName.replace(/\.md$/, '').replace(/^\d+-/, '').replace(/-/g, ' ')
}

/** The file for ADR `num` among `<dir>/` listings: docs/adr first, then design topics. */
export function adrFile(names: readonly { dir: string; name: string }[], num: string): { dir: string; name: string } | undefined {
  return names.find(f => f.name.startsWith(`${num}-`) && f.name.endsWith('.md'))
}

type Run = (argv: string[]) => Promise<{ exitCode: number; stdout: string } | undefined>

export async function lookUpTicket(id: string, prev: GlossEntry | undefined, now: number, run: Run): Promise<GlossEntry> {
  const r = await run(['linear', 'issue', 'show', id])
  const title = r && r.exitCode === 0 ? parseLinearShow(r.stdout, id) : undefined
  if (!title) return { ...(prev ?? {}), failedAt: now }
  // A renamed ticket gets a new brief.
  const brief = prev?.title === title ? prev.brief : undefined
  return { title, ...(brief ? { brief } : {}), fetchedAt: now }
}

export type Fs = {
  list: (dir: string) => Promise<{ name: string; kind: string }[] | undefined>
  read: (path: string) => Promise<string | undefined>
}

/** `<root>/docs/adr/NNNN-*.md`, else `<root>/design/<topic>/adr/NNNN-*.md`. */
export async function lookUpAdr(root: string, num: string, prev: GlossEntry | undefined, now: number, fs: Fs): Promise<GlossEntry> {
  const dirs = [`${root}/docs/adr`]
  for (const t of (await fs.list(`${root}/design`)) ?? []) if (t.kind === 'directory') dirs.push(`${root}/design/${t.name}/adr`)
  for (const dir of dirs) {
    const files = ((await fs.list(dir)) ?? []).filter(f => f.kind === 'file').map(f => ({ dir, name: f.name }))
    const hit = adrFile(files, num)
    if (!hit) continue
    const title = adrTitle(await fs.read(`${hit.dir}/${hit.name}`), hit.name)
    const brief = prev?.title === title ? prev.brief : undefined
    return { title, ...(brief ? { brief } : {}), fetchedAt: now }
  }
  return { ...(prev ?? {}), failedAt: now }
}

export const BRIEF_SYSTEM =
  'You shorten titles of tickets and design records for a dashboard. Reply with JSON only, no prose: ' +
  `{"<key>": "<the title as a plain lowercase phrase of at most ${GLOSS_WORDS} words>"} for every key given. ` +
  'Keep the distinctive subject; drop ids, prefixes like "Evaluation:" and filler.'

export function briefPrompt(items: readonly { key: string; title: string }[]): string {
  return items.map(i => `${i.key}: ${i.title}`).join('\n')
}

export function parseBriefReply(text: string, keys: readonly string[]): Record<string, string> {
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return {}
  try {
    const v = JSON.parse(m[0]) as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const k of keys) {
      const s = typeof v[k] === 'string' ? words(v[k] as string, GLOSS_WORDS) : ''
      if (s) out[k] = s
    }
    return out
  } catch {
    return {}
  }
}

export type Complete = (req: { system: string; prompt: string; maxTokens: number }) => Promise<{ isAnswered: boolean; text?: string }>

/** One model call for every title without a brief; a key the reply misses keeps its fallback and backs off. */
export async function briefBatch(
  entries: ReadonlyMap<string, GlossEntry>, now: number, complete: Complete,
): Promise<Map<string, GlossEntry>> {
  const due = [...entries].filter(([, e]) => briefDue(e, now)).slice(0, BRIEF_BATCH_MAX)
  // Short keys: a store key carries a repo path the model need not see.
  const items = due.map(([, e], i) => ({ key: String(i + 1), title: e.title! }))
  const out = new Map<string, GlossEntry>()
  if (items.length === 0) return out
  let got: Record<string, string> = {}
  try {
    const r = await complete({ system: BRIEF_SYSTEM, prompt: briefPrompt(items), maxTokens: 40 + 30 * items.length })
    if (r.isAnswered && r.text) got = parseBriefReply(r.text, items.map(i => i.key))
  } catch {
    // every key backs off below
  }
  due.forEach(([key, e], i) => {
    const b = got[String(i + 1)]
    out.set(key, b ? { ...e, brief: b } : { ...e, briefFailedAt: now })
  })
  return out
}
