/**
 * Release-policy decisions, without GitHub.
 *
 * The workflow must never publish a Release for a mismatched tag, replace an
 * already-published Release, retry a draft built from a different commit, or mark
 * an older stable version as "latest". Each of those is a pure decision here.
 *
 * @module dsh-node/test/release-policy
 */

import { describe, expect, it } from 'vitest'
import { BuildInfoError } from '../tools/build-info.mjs'
import { compareVersions, planRelease, sameCommit } from '../tools/release-policy.mjs'

const COMMIT = 'a'.repeat(40)

/** Assert one coded policy failure. */
function expectPolicyError(run: () => unknown, code: string): void {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(BuildInfoError)
    expect((error as BuildInfoError).code).toBe(code)
    return
  }
  throw new Error(`expected BuildInfoError ${code}`)
}

/** Build a valid plan input. */
function input(overrides: Record<string, unknown> = {}): Parameters<typeof planRelease>[0] {
  return {
    tag: 'v0.2.0',
    version: '0.2.0',
    commit: COMMIT,
    existing: 'none',
    latestStable: 'v0.1.9',
    ...overrides,
  } as Parameters<typeof planRelease>[0]
}

describe('semantic ordering', () => {
  it('orders patch, minor, and major versions', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1)
    expect(compareVersions('0.1.9', '0.2.0')).toBe(-1)
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1)
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0)
  })

  it('orders prereleases below the release and by identifier', () => {
    expect(compareVersions('1.2.3-rc.1', '1.2.3')).toBe(-1)
    expect(compareVersions('1.2.3-rc.2', '1.2.3-rc.1')).toBe(1)
    expect(compareVersions('1.2.3-alpha', '1.2.3-beta')).toBe(-1)
    expect(compareVersions('1.2.3-alpha', '1.2.3-alpha.1')).toBe(-1)
    expect(compareVersions('1.2.3-1', '1.2.3-alpha')).toBe(-1)
  })
})

describe('commit matching', () => {
  it('accepts a short and a long SHA naming the same commit', () => {
    expect(sameCommit(COMMIT.slice(0, 8), COMMIT)).toBe(true)
    expect(sameCommit(COMMIT, COMMIT.slice(0, 8))).toBe(true)
  })

  it('refuses a branch name and a different commit', () => {
    expect(sameCommit('main', COMMIT)).toBe(false)
    expect(sameCommit('b'.repeat(40), COMMIT)).toBe(false)
  })
})

describe('planning a release', () => {
  it('creates a stable release and marks it latest when no stable release exists', () => {
    expect(planRelease(input({ latestStable: undefined }))).toEqual({
      action: 'create',
      channel: 'stable',
      prerelease: false,
      latest: true,
    })
  })

  it('marks a newer stable release latest', () => {
    expect(planRelease(input()).latest).toBe(true)
  })

  it('never marks an older stable release latest', () => {
    const plan = planRelease(input({ tag: 'v0.2.0', version: '0.2.0', latestStable: 'v0.3.0' }))
    expect(plan.latest).toBe(false)
    expect(plan.action).toBe('create')
  })

  it('classifies a prerelease as preview and never latest', () => {
    const plan = planRelease(input({
      tag: 'v0.3.0-rc.1',
      version: '0.3.0-rc.1',
      latestStable: 'v0.2.0',
    }))
    expect(plan).toEqual({
      action: 'create',
      channel: 'preview',
      prerelease: true,
      latest: false,
    })
  })

  it('refuses to replace an already-published release', () => {
    expectPolicyError(
      () => planRelease(input({ existing: 'published' })),
      'release-already-published',
    )
  })

  it('retries a draft only for the same commit', () => {
    expect(planRelease(input({ existing: 'draft', existingCommit: COMMIT.slice(0, 8) })).action)
      .toBe('retry-draft')
    expectPolicyError(
      () => planRelease(input({ existing: 'draft', existingCommit: 'b'.repeat(40) })),
      'release-draft-commit-mismatch',
    )
  })

  it('refuses a tag that does not match the package version', () => {
    expectPolicyError(
      () => planRelease(input({ tag: 'v0.2.1' })),
      'release-tag-mismatch',
    )
  })

  it('refuses an incomplete tag and a malformed commit', () => {
    expectPolicyError(() => planRelease(input({ tag: '0.2.0' })), 'invalid-tag')
    expectPolicyError(() => planRelease(input({ commit: 'abc' })), 'invalid-commit')
  })

  it('refuses an unknown existing state', () => {
    expectPolicyError(
      () => planRelease(input({ existing: 'maybe' })),
      'invalid-existing',
    )
  })
})
