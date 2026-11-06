/**
 * The running-build contract.
 *
 * A process must report the build it *loaded*, even if the installed package (and
 * therefore `build-info.json`) has since changed on disk. The build info is a
 * compile-time constant, so the two things worth testing are: it is derived from
 * the embedded value rather than disk, and a bundle compiled with a different
 * embedded value reports that different value.
 *
 * @module dsh-node/test/build-info-runtime
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BUILD_INFO, PLUGIN_VERSION, buildInfoFromEmbedded } from '../src/build-info.js'

/** The manifest this test build should match. */
async function manifestVersion(): Promise<string> {
  const path = fileURLToPath(new URL('../package.json', import.meta.url))
  const manifest = JSON.parse(await readFile(path, 'utf8')) as { version: string }
  return manifest.version
}

describe('the build embedded in this bundle', () => {
  it('matches package.json and the compatibility version export', async () => {
    expect(BUILD_INFO.version).toBe(await manifestVersion())
    expect(PLUGIN_VERSION).toBe(BUILD_INFO.version)
  })

  it('is a development build in the test environment, with honest Git metadata', () => {
    expect(BUILD_INFO.channel).toBe('dev')
    expect(Number.isNaN(new Date(BUILD_INFO.builtAt).getTime())).toBe(false)
    expect(BUILD_INFO.commit === null || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(BUILD_INFO.commit)).toBe(true)
    expect(BUILD_INFO.dirty === null || typeof BUILD_INFO.dirty === 'boolean').toBe(true)
  })

  it('is frozen, so nothing can rewrite the running version', () => {
    expect(Object.isFrozen(BUILD_INFO)).toBe(true)
    expect(() => {
      ;(BUILD_INFO as { version: string }).version = '9.9.9'
    }).toThrow()
  })
})

describe('loading a different bundle', () => {
  it('reports the newly embedded value, not the previous one', () => {
    const next = buildInfoFromEmbedded({
      version: '0.9.0',
      commit: 'b'.repeat(40),
      builtAt: '2026-12-01T00:00:00.000Z',
      channel: 'stable',
      dirty: false,
    })
    expect(next.version).toBe('0.9.0')
    expect(next.version).not.toBe(BUILD_INFO.version)
    expect(next.channel).toBe('stable')
    expect(Object.isFrozen(next)).toBe(true)
  })

  it('falls back to an explicit unbundled marker when no define is present', () => {
    const unbundled = buildInfoFromEmbedded(undefined)
    expect(unbundled.channel).toBe('dev')
    expect(unbundled.commit).toBeNull()
    expect(unbundled.version).toBe('0.0.0-dev')
  })

  it('refuses a malformed embedded object instead of reporting it', () => {
    expect(() => buildInfoFromEmbedded({ version: '', channel: 'dev', builtAt: '2026-01-01T00:00:00.000Z', commit: null, dirty: null }))
      .toThrow(/no version/u)
    expect(() => buildInfoFromEmbedded({ version: '1.0.0', channel: 'nightly' as 'dev', builtAt: '2026-01-01T00:00:00.000Z', commit: null, dirty: null }))
      .toThrow(/unknown channel/u)
    expect(() => buildInfoFromEmbedded({ version: '1.0.0', channel: 'dev', builtAt: 'not-a-date', commit: null, dirty: null }))
      .toThrow(/invalid builtAt/u)
  })
})

describe('the source contract', () => {
  it('never reads build-info.json at runtime', async () => {
    // The point is structural: if this module ever gained a filesystem read, a
    // replaced package file could make an old process lie about its version.
    const path = fileURLToPath(new URL('../src/build-info.ts', import.meta.url))
    const source = await readFile(path, 'utf8')
    expect(source).not.toMatch(/node:fs|readFileSync|readFile\(/u)
    expect(source).not.toMatch(/build-info\.json['"]/u)
  })
})
