#!/usr/bin/env node
/**
 * Write (or verify) the `SHA256SUMS` file that ships beside a release tarball.
 *
 * A small script instead of a shell pipeline keeps the release identical on
 * Windows and Linux: the workflow, a maintainer's machine, and an operator
 * checking a downloaded asset all run the same code.
 *
 * Usage:
 *   node tools/checksums.mjs dist
 *   node tools/checksums.mjs dist --verify
 *
 * @module dsh-node/tools/checksums
 */

import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

/** The manifest file written into the artifact directory. */
export const CHECKSUMS_FILE = 'SHA256SUMS'

/** A coded failure with an operator-readable reason. */
export class ChecksumError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ChecksumError'
    this.code = code
  }
}

/**
 * Compute a file's SHA-256.
 * @param {string} file - path to read.
 * @returns {Promise<string>} lowercase hex digest.
 */
export async function sha256File(file) {
  const hash = createHash('sha256')
  hash.update(await readFile(file))
  return hash.digest('hex')
}

/**
 * Parse a `SHA256SUMS` document.
 *
 * Accepts the two-space and ` *` binary markers used by `sha256sum`, and refuses
 * path components so a manifest cannot point outside its directory.
 * @param {string} text - the document.
 * @returns {Map<string, string>} file name to digest.
 */
export function parseChecksums(text) {
  const entries = new Map()
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const match = /^([0-9a-f]{64})\s+\*?([^/\\]+)$/u.exec(trimmed)
    if (match === null) {
      throw new ChecksumError('invalid-checksums', `${CHECKSUMS_FILE}:${String(index + 1)} is not a SHA-256 line`)
    }
    const digest = match[1]
    const name = match[2]
    if (entries.has(name)) {
      throw new ChecksumError('duplicate-checksum', `${CHECKSUMS_FILE} lists "${name}" twice`)
    }
    entries.set(name, digest)
  }
  if (entries.size === 0) throw new ChecksumError('empty-checksums', `${CHECKSUMS_FILE} lists no files`)
  return entries
}

/**
 * List the tarballs directly inside a directory.
 * @param {string} directory - artifact directory.
 * @returns {Promise<string[]>} sorted absolute paths.
 */
export async function tarballsIn(directory) {
  const names = await readdir(directory)
  return names
    .filter(name => name.endsWith('.tgz'))
    .sort()
    .map(name => join(directory, name))
}

/**
 * Build the manifest text for a set of files.
 * @param {string[]} files - tarball paths.
 * @returns {Promise<string>} `SHA256SUMS` content.
 */
export async function buildChecksums(files) {
  const lines = []
  for (const file of [...files].sort((left, right) => basename(left).localeCompare(basename(right)))) {
    lines.push(`${await sha256File(file)}  ${basename(file)}`)
  }
  return `${lines.join('\n')}\n`
}

/** CLI entry point. */
async function main() {
  const argv = process.argv.slice(2)
  const verify = argv.includes('--verify')
  const positional = argv.filter(argument => !argument.startsWith('--'))
  if (positional.length !== 1) {
    throw new ChecksumError('invalid-argument', 'usage: node tools/checksums.mjs <artifact-dir> [--verify]')
  }
  const directory = resolve(positional[0])
  const manifest = join(directory, CHECKSUMS_FILE)
  const files = await tarballsIn(directory)
  if (files.length === 0) {
    throw new ChecksumError('no-tarballs', `${directory} contains no .tgz file`)
  }

  if (verify) {
    const expected = parseChecksums(await readFile(manifest, 'utf8'))
    for (const file of files) {
      const name = basename(file)
      const digest = expected.get(name)
      if (digest === undefined) {
        throw new ChecksumError('checksum-missing', `${CHECKSUMS_FILE} does not list "${name}"`)
      }
      const actual = await sha256File(file)
      if (actual !== digest) {
        throw new ChecksumError('checksum-mismatch', `${name}: expected ${digest}, got ${actual}`)
      }
    }
    console.log(`checksums: ok ${CHECKSUMS_FILE} (${String(files.length)} file(s))`)
    return
  }

  await writeFile(manifest, await buildChecksums(files), 'utf8')
  console.log(`checksums: wrote ${manifest}`)
  for (const file of files) console.log(`  ${await sha256File(file)}  ${basename(file)}`)
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('checksums.mjs')) {
  main().catch((error) => {
    if (error instanceof ChecksumError) {
      console.error(`checksums: ${error.code}: ${error.message}`)
      process.exitCode = 1
    } else {
      console.error(`checksums: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    }
  })
}
