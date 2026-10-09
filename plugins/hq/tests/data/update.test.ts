import { describe, expect, test } from 'claude-code/testing'

import {
  CHECK_MS,
  DEV_UPDATE_TOAST,
  compareVersions,
  headerNotice,
  installOf,
  knownMarketplacesPath,
  latestVersion,
  manifestVersion,
  runUpdate,
  updateToast,
} from '../../hooks/data/update'
import type { CheckIO, Install } from '../../hooks/data/update'

const ROOT = '/home/u/.claude/plugins/cache/claude-hq/hq/0.1.0'
const KNOWN = JSON.stringify({ 'claude-hq': { source: { source: 'github', repo: 'bshakr/claude-hq' } } })
const INSTALL: Install = { version: '0.1.0', marketplace: 'claude-hq' }
const T0 = Date.parse('2026-10-09T08:00:00Z')

/** A machine's store shared by every session, and a count of fetches of the published manifest. */
function machine(published = '0.2.0') {
  const m = {
    store: new Map<string, unknown>(),
    fetches: 0,
    published,
    io: (now: number): CheckIO => ({
      now,
      get: async k => m.store.get(k),
      set: async (k, v) => void m.store.set(k, v),
      fetchManifest: async () => {
        m.fetches++
        return JSON.stringify({ name: 'hq', version: m.published })
      },
    }),
    count: () => m.fetches,
  }
  return m
}

describe('version compare', () => {
  test('orders by major, minor, patch, numerically', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBe(1)
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('v1.2.3', '1.2.4')).toBe(-1)
  })
  test('a release outranks its pre-releases; pre-releases compare by identifier', () => {
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1)
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1)
    expect(compareVersions('1.0.0-alpha', '1.0.0-1')).toBe(1)
  })
  test('anything not a version compares as undefined', () => {
    expect(compareVersions('latest', '0.1.0')).toBe(undefined)
    expect(compareVersions('0.1', '0.1.0')).toBe(undefined)
    expect(manifestVersion('{"version":"nope"}')).toBe(undefined)
    expect(manifestVersion('not json')).toBe(undefined)
    expect(manifestVersion('{"version":"0.3.1"}')).toBe('0.3.1')
  })
})

describe('install detection', () => {
  test('a plugin-store copy from a GitHub marketplace is an install', () => {
    expect(knownMarketplacesPath(ROOT)).toBe('/home/u/.claude/plugins/known_marketplaces.json')
    expect(installOf(ROOT, '0.1.0', KNOWN)).toEqual(INSTALL)
  })
  test('--plugin-dir, a local-path marketplace, or no marketplace list is dev', () => {
    expect(knownMarketplacesPath('/home/u/code/claude-hq/plugins/hq')).toBe(undefined)
    expect(installOf('/home/u/code/claude-hq/plugins/hq', '0.1.0', KNOWN)).toBe(undefined)
    const local = JSON.stringify({ 'claude-hq': { source: { source: 'directory', path: '/home/u/code/claude-hq' } } })
    expect(installOf(ROOT, '0.1.0', local)).toBe(undefined)
    expect(installOf(ROOT, '0.1.0', undefined)).toBe(undefined)
    expect(installOf(ROOT, undefined, KNOWN)).toBe(undefined)
  })
})

describe('the daily check', () => {
  test('fetches at most once a day, shared by every session on the machine', async () => {
    const m = machine()
    expect(await latestVersion(m.io(T0))).toBe('0.2.0')
    // A second session an hour later reads what the first stored.
    expect(await latestVersion(m.io(T0 + 60 * 60_000))).toBe('0.2.0')
    expect(await latestVersion(m.io(T0 + CHECK_MS - 1))).toBe('0.2.0')
    expect(m.count()).toBe(1)
    m.published = '0.3.0'
    expect(await latestVersion(m.io(T0 + CHECK_MS))).toBe('0.3.0')
    expect(m.count()).toBe(2)
  })

  test('a failed fetch keeps the last version seen and still waits a day', async () => {
    const m = machine()
    await latestVersion(m.io(T0))
    const failing: CheckIO = { ...m.io(T0 + CHECK_MS), fetchManifest: async () => Promise.reject(new Error('offline')) }
    expect(await latestVersion(failing)).toBe('0.2.0')
    expect(m.store.get('update:checkedAt')).toBe(T0 + CHECK_MS)
  })

  test('a newer published version is an "available" notice; the same one is none', async () => {
    const m = machine('0.2.0')
    expect(await headerNotice(INSTALL, { enabled: true, trafficOff: false }, m.io(T0))).toEqual({ kind: 'available', version: '0.2.0' })
    const same = machine('0.1.0')
    expect(await headerNotice(INSTALL, { enabled: true, trafficOff: false }, same.io(T0))).toBe(undefined)
  })

  for (const [why, opts] of [
    ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', { enabled: true, trafficOff: true }],
    ['updateCheck off', { enabled: false, trafficOff: false }],
  ] as const) {
    test(`${why}: no fetch and no notice, even with a newer version stored`, async () => {
      const m = machine()
      m.store.set('update:latest', '0.9.0')
      expect(await headerNotice(INSTALL, opts, m.io(T0))).toBe(undefined)
      expect(m.count()).toBe(0)
    })
  }

  test('a dev copy never fetches and never notifies', async () => {
    const m = machine()
    m.store.set('update:latest', '0.9.0')
    m.store.set('update:lastRun', '0.0.1')
    expect(await headerNotice(undefined, { enabled: true, trafficOff: false }, m.io(T0))).toBe(undefined)
    expect(m.count()).toBe(0)
  })
})

describe('after an update', () => {
  test('the first load of a newer version says so once, with its release page', async () => {
    const m = machine('0.2.0')
    m.store.set('update:lastRun', '0.1.0')
    const v2: Install = { version: '0.2.0', marketplace: 'claude-hq' }
    expect(await headerNotice(v2, { enabled: true, trafficOff: false }, m.io(T0))).toEqual({
      kind: 'updated',
      version: '0.2.0',
      url: 'https://github.com/bshakr/claude-hq/releases/tag/v0.2.0',
    })
    expect(m.store.get('update:lastRun')).toBe('0.2.0')
    expect(await headerNotice(v2, { enabled: true, trafficOff: false }, m.io(T0 + 1000))).toBe(undefined)
  })

  test('a first install records its version and shows nothing', async () => {
    const m = machine('0.1.0')
    expect(await headerNotice(INSTALL, { enabled: true, trafficOff: false }, m.io(T0))).toBe(undefined)
    expect(m.store.get('update:lastRun')).toBe('0.1.0')
  })
})

describe('/hq update', () => {
  const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' })

  test('success: the version it updated to, and /reload-plugins', async () => {
    const ran: (readonly string[])[] = []
    const said = await runUpdate(INSTALL, async argv => {
      ran.push(argv)
      return ok('{"command":"update","outcome":"updated","plugin":"hq@claude-hq","newVersion":"0.2.0"}\n')
    })
    expect(ran).toEqual([['claude', 'plugin', 'update', 'hq@claude-hq', '--json']])
    expect(said).toBe('updated to 0.2.0 · /reload-plugins to apply')
    expect(updateToast(ok(''), INSTALL, '0.3.0')).toBe('updated to 0.3.0 · /reload-plugins to apply')
  })

  test('nothing newer: says so instead of "updated to"', () => {
    expect(updateToast(ok('{"outcome":"unchanged","message":"hq is already at the latest version"}'), INSTALL)).toBe(
      'hq: hq is already at the latest version',
    )
    expect(updateToast(ok(''), INSTALL)).toBe('hq 0.1.0 is up to date')
  })

  test('failure: why, and the command to run by hand', async () => {
    const failed = await runUpdate(INSTALL, async () => ({
      exitCode: 1,
      stdout: '{"command":"update","outcome":"failed","message":"Plugin \\"hq\\" not found","failureCode":"not_found"}',
      stderr: '',
    }))
    expect(failed).toBe('hq update failed: Plugin "hq" not found · run claude plugin update hq@claude-hq, then /reload-plugins')
    const threw = await runUpdate(INSTALL, async () => Promise.reject(new Error('spawn claude ENOENT')))
    expect(threw).toBe('hq update failed · run claude plugin update hq@claude-hq, then /reload-plugins')
  })

  test('a dev copy runs nothing', async () => {
    let calls = 0
    expect(
      await runUpdate(undefined, async () => {
        calls++
        return ok('')
      }),
    ).toBe(DEV_UPDATE_TOAST)
    expect(calls).toBe(0)
  })
})
