export const MANIFEST_URL = 'https://raw.githubusercontent.com/bshakr/claude-hq/main/plugins/hq/.claude-plugin/plugin.json'
export const RELEASES_URL = 'https://github.com/bshakr/claude-hq/releases/tag'
export const CHECK_MS = 24 * 60 * 60_000

/** `$.store` keys, shared by every session on the machine and kept across updates. */
export const CHECKED_AT_KEY = 'update:checkedAt'
export const LATEST_KEY = 'update:latest'
export const LAST_RUN_KEY = 'update:lastRun'

/** A plugin-store install: its version and the marketplace `claude plugin update` names it under. */
export type Install = { version: string; marketplace: string }

export type HeaderNotice = { kind: 'available'; version: string } | { kind: 'updated'; version: string; url: string }

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** -1, 0 or 1 by semver precedence; undefined when either is not a version. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | undefined {
  const x = SEMVER.exec(a.trim())
  const y = SEMVER.exec(b.trim())
  if (!x || !y) return undefined
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i])
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return comparePre(x[4], y[4])
}

function comparePre(a: string | undefined, b: string | undefined): -1 | 0 | 1 {
  if (a === b) return 0
  // A release outranks its pre-releases.
  if (a === undefined) return 1
  if (b === undefined) return -1
  const xs = a.split('.')
  const ys = b.split('.')
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const p = xs[i]
    const q = ys[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    if (p === q) continue
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1
    if (pn !== qn) return pn ? -1 : 1
    return p < q ? -1 : 1
  }
  return 0
}

export const isNewer = (candidate: string | undefined, than: string): boolean =>
  candidate !== undefined && compareVersions(candidate, than) === 1

/** The `version` of a plugin.json text; undefined when absent or not a version. */
export function manifestVersion(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  try {
    const v = (JSON.parse(text) as { version?: unknown }).version
    return typeof v === 'string' && compareVersions(v, v) === 0 ? v : undefined
  } catch {
    return undefined
  }
}

const CACHE_ROOT = /^(.*)[\\/]plugins[\\/]cache[\\/]([^\\/]+)[\\/]hq[\\/][^\\/]+[\\/]?$/

/** Where the marketplace list sits for a root under the plugin cache; undefined for any other root. */
export function knownMarketplacesPath(root: string): string | undefined {
  const m = CACHE_ROOT.exec(root)
  return m ? `${m[1]}/plugins/known_marketplaces.json` : undefined
}

/**
 * The install HQ runs from, or undefined for a dev copy: `--plugin-dir`, or a marketplace
 * added from a local path, whose cache entry is a snapshot no remote version describes.
 */
export function installOf(root: string, version: string | undefined, knownMarketplaces: string | undefined): Install | undefined {
  const m = CACHE_ROOT.exec(root)
  if (!m || version === undefined || knownMarketplaces === undefined) return undefined
  const marketplace = m[2]!
  try {
    const entry = (JSON.parse(knownMarketplaces) as Record<string, { source?: { source?: unknown } }>)[marketplace]
    const kind = entry?.source?.source
    return kind === 'github' || kind === 'git' ? { version, marketplace } : undefined
  } catch {
    return undefined
  }
}

export interface CheckIO {
  now: number
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<void>
  /** The published plugin.json, or undefined when it could not be fetched. */
  fetchManifest: () => Promise<string | undefined>
}

/**
 * The newest version seen, fetching at most once a day across sessions: the
 * check time is written before the fetch, so a session starting meanwhile skips it.
 */
export async function latestVersion(io: CheckIO): Promise<string | undefined> {
  const checkedAt = await io.get(CHECKED_AT_KEY)
  const seen = await io.get(LATEST_KEY)
  let latest = typeof seen === 'string' ? seen : undefined
  if (typeof checkedAt !== 'number' || io.now - checkedAt >= CHECK_MS || checkedAt > io.now) {
    await io.set(CHECKED_AT_KEY, io.now)
    const fetched = manifestVersion(await io.fetchManifest().catch(() => undefined))
    if (fetched !== undefined) {
      latest = fetched
      await io.set(LATEST_KEY, fetched)
    }
  }
  return latest
}

/** True once per newer version: the first load of it after an older one ran here. Records this one. */
export async function justUpdated(install: Install, io: Pick<CheckIO, 'get' | 'set'>): Promise<boolean> {
  const last = await io.get(LAST_RUN_KEY)
  if (last !== install.version) await io.set(LAST_RUN_KEY, install.version)
  return typeof last === 'string' && isNewer(install.version, last)
}

export type CheckOptions = { enabled: boolean; trafficOff: boolean }

/** The header notice for this load: just updated wins over an available update. */
export async function headerNotice(install: Install | undefined, opts: CheckOptions, io: CheckIO): Promise<HeaderNotice | undefined> {
  if (install === undefined) return undefined
  if (await justUpdated(install, io)) return { kind: 'updated', version: install.version, url: `${RELEASES_URL}/v${install.version}` }
  if (!opts.enabled || opts.trafficOff) return undefined
  const latest = await latestVersion(io)
  return isNewer(latest, install.version) ? { kind: 'available', version: latest! } : undefined
}

export const updateCommand = (marketplace: string) => ['claude', 'plugin', 'update', `hq@${marketplace}`]

/** What `/hq update` toasts, from how `claude plugin update --json` ended. */
export function updateToast(
  ran: { exitCode: number; stdout: string; stderr: string } | undefined,
  install: Install,
  latest?: string,
): string {
  const by = `claude plugin update hq@${install.marketplace}`
  const got = ran ? lastJson(ran.stdout) : undefined
  const said = typeof got?.message === 'string' && got.message ? got.message : undefined
  if (!ran || ran.exitCode !== 0 || got?.outcome === 'failed') {
    const why = said ?? ran?.stderr.trim().split('\n')[0]
    return `hq update failed${why ? `: ${why}` : ''} · run ${by}, then /reload-plugins`
  }
  const version = [got?.newVersion, got?.toVersion, got?.version, latest].find(
    (v): v is string => typeof v === 'string' && compareVersions(v, v) === 0,
  )
  if (version === undefined || !isNewer(version, install.version)) return said ? `hq: ${said}` : `hq ${install.version} is up to date`
  return `updated to ${version} · /reload-plugins to apply`
}

function lastJson(stdout: string): Record<string, unknown> | undefined {
  const line = stdout
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('{'))
    .at(-1)
  if (line === undefined) return undefined
  try {
    const v = JSON.parse(line) as unknown
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

export const DEV_UPDATE_TOAST = 'hq runs from a local folder, not the plugin store · update it with git pull, then /reload-plugins'

/** `/hq update`: runs the CLI's update and says how it went; a dev copy runs nothing. */
export async function runUpdate(
  install: Install | undefined,
  run: (argv: readonly string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  latest?: string,
): Promise<string> {
  if (install === undefined) return DEV_UPDATE_TOAST
  const ran = await run([...updateCommand(install.marketplace), '--json']).catch(() => undefined)
  return updateToast(ran, install, latest)
}
