/**
 * Guard rails for the artifact tooling.
 *
 * These tests do not build a tarball; they pin the pure checks a broken artifact
 * must fail before anyone uploads it: a missing client bundle, a missing metadata
 * file, a stray test/log/source entry, or a malformed checksum manifest.
 *
 * @module dsh-node/test/release-tools
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ChecksumError, parseChecksums, sha256File } from '../tools/checksums.mjs'
import { REQUIRED_ENTRIES, VerifyError, assertPackageEntries } from '../tools/verify-package.mjs'

const temporaryDirectories: string[] = []

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop()
    if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  }
})

/** A tarball entry list containing every required file. */
function completeEntries(): string[] {
  return [...REQUIRED_ENTRIES]
}

/** Assert a coded verification failure. */
function expectVerifyError(run: () => unknown, code: string): void {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(VerifyError)
    expect((error as VerifyError).code).toBe(code)
    return
  }
  throw new Error(`expected VerifyError ${code}`)
}

describe('tarball entry list', () => {
  it('accepts a complete package', () => {
    expect(() => assertPackageEntries(completeEntries())).not.toThrow()
  })

  it.each(['package/lib/client.js', 'package/build-info.json', 'package/package.json', 'package/lib/index.js'])(
    'rejects a package missing %s',
    (missing) => {
      expectVerifyError(
        () => assertPackageEntries(completeEntries().filter(entry => entry !== missing)),
        'missing-entry',
      )
    },
  )

  it('rejects a stray test, source, log, or dependency entry', () => {
    for (const stray of [
      'package/test/integration.test.ts',
      'package/src/index.ts',
      'package/tools/build-info.mjs',
      'package/node_modules/ws/index.js',
      'package/.tmp/build.log',
      'package/config.json',
      'package/.env.local',
      'package/.github/workflows/ci.yml',
    ]) {
      expectVerifyError(() => assertPackageEntries([...completeEntries(), stray]), 'forbidden-entry')
    }
  })

  it('rejects an entry outside package/ and an empty tarball', () => {
    expectVerifyError(() => assertPackageEntries([...completeEntries(), 'outside.txt']), 'invalid-entry')
    expectVerifyError(() => assertPackageEntries([]), 'empty-tarball')
  })
})

describe('checksum manifest', () => {
  it('parses the two common separators', () => {
    const digest = 'a'.repeat(64)
    const parsed = parseChecksums(`${digest}  dsh-node-0.2.0.tgz\n${'b'.repeat(64)} *other.tgz\n`)
    expect(parsed.get('dsh-node-0.2.0.tgz')).toBe(digest)
    expect(parsed.get('other.tgz')).toBe('b'.repeat(64))
  })

  it('refuses a malformed line, a path, or a duplicate', () => {
    expect(() => parseChecksums('not-a-digest  file.tgz\n')).toThrow(ChecksumError)
    expect(() => parseChecksums(`${'a'.repeat(64)}  dir/file.tgz\n`)).toThrow(ChecksumError)
    expect(() => parseChecksums(`${'a'.repeat(64)}  file.tgz\n${'a'.repeat(64)}  file.tgz\n`)).toThrow(ChecksumError)
    expect(() => parseChecksums('\n')).toThrow(ChecksumError)
  })

  it('hashes the bytes it is given', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-node-checksum-'))
    temporaryDirectories.push(directory)
    const file = join(directory, 'payload.bin')
    await writeFile(file, 'dsh-node', 'utf8')
    // Known SHA-256 of the UTF-8 bytes "dsh-node".
    expect(await sha256File(file)).toBe('c61790c5322a8175a5ccfca038233c142deb5b8915728f77ffa402e3cf7337d6')
  })
})
