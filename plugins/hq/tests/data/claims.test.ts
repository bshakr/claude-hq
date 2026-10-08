import { expect, test } from 'claude-code/testing'

import { parseOwnership, repoOfRemote } from '../../hooks/data/claims'

const PUSH_NEW = [
  'remote: Create a pull request for \'feat-x\' on GitHub by visiting:',
  'remote:      https://github.com/acme/app/pull/new/feat-x',
  'To github.com:acme/app.git',
  ' * [new branch]      feat-x -> feat-x',
  "branch 'feat-x' set up to track 'origin/feat-x'.",
].join('\n')

test('ownership: gh pr create owns the URL it printed', () => {
  const o = parseOwnership('gh pr create --title "Fix 12" --body "Closes 99"', 'https://github.com/acme/app/pull/77\n')
  expect(o.created).toEqual([{ repo: 'acme/app', number: 77 }])
  expect(o.pushed).toEqual([])
})

test('ownership: gh pr create read from the engine gitOperation when the output has no URL', () => {
  const o = parseOwnership('gh pr create --fill', '', '', { pr: { number: 9, url: 'https://github.com/acme/app/pull/9', action: 'created' } })
  expect(o.created).toEqual([{ repo: 'acme/app', number: 9 }])
})

test('ownership: git push owns the pushed branch, repo from the To line', () => {
  const o = parseOwnership('git push -u origin feat-x', '', PUSH_NEW)
  expect(o.pushed).toEqual([{ repo: 'acme/app', branch: 'feat-x' }])
})

test('ownership: an update push and a forced push, with cd and git -C', () => {
  const out = 'To https://github.com/acme/app\n   abc1234..def5678  feat-y -> feat-y\n'
  expect(parseOwnership('cd /w/app/.koh/feat-y && git push', '', out).pushed).toEqual([
    { repo: 'acme/app', branch: 'feat-y', dir: '/w/app/.koh/feat-y' },
  ])
  const forced = 'To github.com:acme/app.git\n + 1111111...2222222 HEAD -> feat-z (forced update)\n'
  expect(parseOwnership('git -C /w/z push --force-with-lease origin HEAD:feat-z', '', forced).pushed).toEqual([
    { repo: 'acme/app', branch: 'feat-z', dir: '/w/z' },
  ])
})

test('ownership: a push with no output names no branch; the dir resolves it later', () => {
  expect(parseOwnership('cd ~/code/app && git push 2>/dev/null').pushed).toEqual([{ dir: '~/code/app' }])
  expect(parseOwnership('git push', '', '', { push: { branch: 'feat-q' } }).pushed).toEqual([{ branch: 'feat-q' }])
})

test('ownership: deleting a branch or pushing a tag owns nothing', () => {
  expect(parseOwnership('git push origin --delete feat-x', '', 'To github.com:acme/app.git\n - [deleted]  feat-x\n').pushed).toEqual([])
  expect(parseOwnership('git push origin v1', '', 'To github.com:acme/app.git\n * [new tag]  v1 -> v1\n').pushed).toEqual([])
})

for (const command of [
  'gh pr view 12 -R acme/app',
  'gh pr checks https://github.com/acme/app/pull/34 --watch',
  'gh pr comment 15 --body hi --repo=acme/app',
  'gh pr merge 9 --squash',
  'pr-ci-wait 56 --repo acme/api',
  'pr-merge-wait https://github.com/o/r/pull/7 --timeout 30m',
  'gh pr view',
]) {
  test(`ownership: viewing, checking, commenting, merging or waiting claims nothing: ${command}`, () => {
    const o = parseOwnership(command, 'url: https://github.com/acme/app/pull/5\n')
    expect(o.created).toEqual([])
    expect(o.pushed).toEqual([])
  })
}

test('ownership: a merge this session ran is reported from gitOperation, without owning it', () => {
  const o = parseOwnership('gh pr merge 9 --squash', '', '', { pr: { number: 9, url: 'https://github.com/acme/app/pull/9', action: 'merged' } })
  expect(o.merged).toEqual([{ repo: 'acme/app', number: 9 }])
  expect(o.created).toEqual([])
})

test('ownership: quoted text is not a command', () => {
  expect(parseOwnership('echo "git push && gh pr create"', 'https://github.com/acme/app/pull/1').created).toEqual([])
})

test('claims: repo from git remotes', () => {
  expect(repoOfRemote('git@github.com:acme/app.git\n')).toBe('acme/app')
  expect(repoOfRemote('https://github.com/acme/app')).toBe('acme/app')
  expect(repoOfRemote('ssh://git@github.com/acme/app.git')).toBe('acme/app')
  expect(repoOfRemote('https://gitlab.com/acme/app.git')).toBe(undefined)
})
