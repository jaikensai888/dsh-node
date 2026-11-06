/**
 * The build metadata contract.
 *
 * These tests pin the two halves of the promise: `package.json` is the only
 * version source, and a release build is refused unless the tag, the commit, and
 * the cleanliness of the tree all agree. They also pin the JSON/embedded
 * consistency check that the package smoke test repeats against a real tarball.
 *
 * @module dsh-node/test/build-info
 */

import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BUILD_INFO_FILE,
  BuildInfoError,
  checkBuildInfo,
  createBuildInfo,
  parseReleaseTag,
  prepareBuildInfo,
  readBuildInfo,
  readPackageVersion,
  validateBuildInfo,
  writeBuildInfo,
} from '../tools/build-info.mjs'

const COMMIT = 'a'.repeat(40)
const CLEAN = { commit: COMMIT, dirty: false }
const UNKNOWN_GIT = { commit: null, dirty: null }
const BUILT_AT = '2026-11-06T00:00:00.000Z'

const temporaryDirectories: string[] = []

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop()
    if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  }
})

/** Create a throwaway package root with the given manifest. */
async function packageRoot(version = '1.2.3'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-node-build-info-'))
  temporaryDirectories.push(directory)
  await writeFile(join(directory, 'package.json'), `${JSON.stringify({ name: 'dsh-node', version }, null, 2)}\n`, 'utf8')
  return directory
}

/** Assert a thrown value is a coded build-info failure. */
function expectBuildInfoError(run: () => unknown, code: string): void {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(BuildInfoError)
    expect((error as BuildInfoError).code).toBe(code)
    return
  }
  throw new Error(`expected BuildInfoError ${code}`)
}

describe('version source', () => {
  it('takes the version from package.json', async () => {
    const root = await packageRoot('3.4.5')
    expect(readPackageVersion(root)).toBe('3.4.5')
    expect(createBuildInfo({ root, gitInfo: CLEAN, builtAt: BUILT_AT }).version).toBe('3.4.5')
  })

  it('rejects a manifest without a semantic version', async () => {
    const root = await packageRoot('not-a-version')
    expectBuildInfoError(() => createBuildInfo({ root, gitInfo: CLEAN }), 'invalid-version')
  })
})

describe('development builds', () => {
  it('always reports channel dev outside a release, even for a release-shaped version', () => {
    const info = createBuildInfo({
      packageVersion: '1.2.3',
      gitInfo: CLEAN,
      builtAt: BUILT_AT,
      release: false,
    })
    expect(info.channel).toBe('dev')
    expect(info.dirty).toBe(false)
    expect(info.commit).toBe(COMMIT)
  })

  it('reports unknown Git facts as null when there is no checkout', () => {
    const info = createBuildInfo({
      packageVersion: '1.2.3',
      gitInfo: UNKNOWN_GIT,
      builtAt: BUILT_AT,
    })
    expect(info).toEqual({
      version: '1.2.3',
      commit: null,
      builtAt: BUILT_AT,
      channel: 'dev',
      dirty: null,
    })
  })

  it('marks a dirty development build as dirty', () => {
    const info = createBuildInfo({
      packageVersion: '1.2.3',
      gitInfo: { commit: COMMIT, dirty: true },
      builtAt: BUILT_AT,
    })
    expect(info.dirty).toBe(true)
    expect(info.channel).toBe('dev')
  })
})

describe('release builds', () => {
  it('classifies a plain version as stable', () => {
    const info = createBuildInfo({
      packageVersion: '1.2.3',
      release: true,
      tag: 'v1.2.3',
      gitInfo: CLEAN,
      builtAt: BUILT_AT,
    })
    expect(info.channel).toBe('stable')
    expect(info.dirty).toBe(false)
  })

  it('classifies a prerelease as preview', () => {
    const info = createBuildInfo({
      packageVersion: '1.2.3-rc.1',
      release: true,
      tag: 'v1.2.3-rc.1',
      gitInfo: CLEAN,
      builtAt: BUILT_AT,
    })
    expect(info.channel).toBe('preview')
  })

  it('refuses a tag that does not exactly match package.json', () => {
    expectBuildInfoError(
      () => createBuildInfo({ packageVersion: '1.2.3', release: true, tag: 'v1.2.4', gitInfo: CLEAN }),
      'release-tag-mismatch',
    )
    expectBuildInfoError(
      () => createBuildInfo({ packageVersion: '1.2.3-rc.1', release: true, tag: 'v1.2.3', gitInfo: CLEAN }),
      'release-tag-mismatch',
    )
  })

  it('requires a tag', () => {
    expectBuildInfoError(
      () => createBuildInfo({ packageVersion: '1.2.3', release: true, gitInfo: CLEAN }),
      'release-tag-missing',
    )
  })

  it('refuses a dirty tree', () => {
    expectBuildInfoError(
      () => createBuildInfo({
        packageVersion: '1.2.3',
        release: true,
        tag: 'v1.2.3',
        gitInfo: { commit: COMMIT, dirty: true },
      }),
      'release-tree-dirty',
    )
  })

  it('refuses an unknown tree state', () => {
    expectBuildInfoError(
      () => createBuildInfo({
        packageVersion: '1.2.3',
        release: true,
        tag: 'v1.2.3',
        gitInfo: { commit: COMMIT, dirty: null },
      }),
      'release-tree-dirty',
    )
  })

  it('refuses an unknown commit', () => {
    expectBuildInfoError(
      () => createBuildInfo({
        packageVersion: '1.2.3',
        release: true,
        tag: 'v1.2.3',
        gitInfo: { commit: null, dirty: false },
      }),
      'release-commit-unknown',
    )
  })
})

describe('tags', () => {
  it('accepts complete stable and prerelease tags', () => {
    expect(parseReleaseTag('v1.2.3').version).toBe('1.2.3')
    expect(parseReleaseTag('v1.2.3-rc.1').prerelease).toBe('rc.1')
    expect(parseReleaseTag('v1.2.3+build.7').version).toBe('1.2.3+build.7')
  })

  it('rejects incomplete or unprefixed tags', () => {
    for (const tag of ['1.2.3', 'v1.2', 'v1.2.3.4', 'release-1.2.3', 'v01.2.3']) {
      expectBuildInfoError(() => parseReleaseTag(tag), 'invalid-tag')
    }
  })
})

describe('the real checkout state', () => {
  it('reads a clean commit, then refuses a release after an untracked file appears', async () => {
    const root = await packageRoot('0.1.0')
    execFileSync('git', ['init', '-q'], { cwd: root })
    execFileSync('git', ['add', 'package.json'], { cwd: root })
    execFileSync(
      'git',
      ['-c', 'user.email=test@example.com', '-c', 'user.name=Build Info Test', 'commit', '-q', '-m', 'init'],
      { cwd: root },
    )

    const clean = createBuildInfo({ root, release: true, tag: 'v0.1.0', builtAt: BUILT_AT })
    expect(clean.channel).toBe('stable')
    expect(clean.dirty).toBe(false)
    expect(clean.commit).toMatch(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u)

    // An untracked source file is a dirty tree, not something to silently ship.
    await writeFile(join(root, 'untracked.ts'), 'export {}\n', 'utf8')
    expectBuildInfoError(
      () => createBuildInfo({ root, release: true, tag: 'v0.1.0' }),
      'release-tree-dirty',
    )
    const dev = createBuildInfo({ root, builtAt: BUILT_AT })
    expect(dev.channel).toBe('dev')
    expect(dev.dirty).toBe(true)
  })
})

describe('the package file', () => {
  it('round-trips the exact object and is validated against package.json', async () => {
    const root = await packageRoot('1.2.3')
    const info = createBuildInfo({
      root,
      gitInfo: CLEAN,
      builtAt: BUILT_AT,
      packageVersion: '1.2.3',
    })
    const file = writeBuildInfo(info, root)
    expect(file).toBe(join(root, BUILD_INFO_FILE))
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(info)
    expect(expectedKeys(await readBuildInfo(root))).toEqual(['builtAt', 'channel', 'commit', 'dirty', 'version'])
    expect(checkBuildInfo(root).version).toBe('1.2.3')
  })

  it('refuses a file whose version drifted from package.json', async () => {
    const root = await packageRoot('1.2.3')
    writeBuildInfo(createBuildInfo({ root, packageVersion: '1.2.4', gitInfo: CLEAN, builtAt: BUILT_AT }), root)
    expectBuildInfoError(() => checkBuildInfo(root), 'version-mismatch')
  })

  it('refuses a missing file before packing', async () => {
    const root = await packageRoot('1.2.3')
    expectBuildInfoError(() => checkBuildInfo(root), 'build-info-missing')
  })

  it('rejects a release channel that disagrees with the version', () => {
    const withChannel = (channel: string, version: string) => ({
      version,
      commit: COMMIT,
      builtAt: BUILT_AT,
      channel,
      dirty: false,
    })
    expectBuildInfoError(
      () => validateBuildInfo(withChannel('stable', '1.2.3-rc.1')),
      'invalid-build-info',
    )
    expectBuildInfoError(
      () => validateBuildInfo(withChannel('preview', '1.2.3')),
      'invalid-build-info',
    )
    expectBuildInfoError(
      () => validateBuildInfo({ ...withChannel('stable', '1.2.3'), dirty: true }),
      'invalid-build-info',
    )
  })

  it('rejects malformed fields', () => {
    expectBuildInfoError(() => validateBuildInfo(null), 'invalid-build-info')
    expectBuildInfoError(
      () => validateBuildInfo({ version: '1.2.3', commit: 'abc', builtAt: BUILT_AT, channel: 'dev', dirty: null }),
      'invalid-build-info',
    )
    expectBuildInfoError(
      () => validateBuildInfo({ version: '1.2.3', commit: COMMIT, builtAt: 'yesterday', channel: 'dev', dirty: null }),
      'invalid-build-info',
    )
  })
})

describe('prepareBuildInfo', () => {
  it('writes a dev build for a non-release environment', async () => {
    const root = await packageRoot('1.2.3')
    // `gitInfo` is not injectable here, so the temp directory correctly reports
    // unknown Git metadata. The point of this test is the write and the channel.
    const info = prepareBuildInfo({ root, env: {}, write: true })
    expect(info.channel).toBe('dev')
    expect(readBuildInfo(root)).toEqual(info)
  })

  it('requires the tag in a release environment', async () => {
    const root = await packageRoot('1.2.3')
    expectBuildInfoError(
      () => prepareBuildInfo({ root, env: { DSH_NODE_RELEASE: '1' }, write: false }),
      'release-tag-missing',
    )
  })
})

/** The sorted keys of an object, to pin the on-disk shape. */
function expectedKeys(value: object): string[] {
  return Object.keys(value).sort()
}
