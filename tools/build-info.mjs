#!/usr/bin/env node
/**
 * One source of build metadata for `dsh-node`.
 *
 * `package.json` is the only place a version is written. This module turns that
 * version plus the checkout's Git state into the object that is both:
 *
 *   1. written to `build-info.json` at the package root, so the installed package
 *      can be inspected without loading it; and
 *   2. embedded into the host bundle through a build-time define, so the running
 *      process reports the build it actually loaded — never a file on disk that a
 *      later install may have replaced.
 *
 * The release path is deliberately stricter than a normal build: a release must
 * have a clean checkout, a real commit, and a tag that exactly matches
 * `v<package.json version>`. A normal (developer or CI) build is always
 * `channel: "dev"` and records unknown Git facts as `null` rather than guessing.
 *
 * This file is plain JavaScript on purpose: it is imported by `tsdown.config.ts`,
 * `vitest.config.ts`, the GitHub workflows, and tests, so it must run without a
 * build step.
 *
 * @module dsh-node/tools/build-info
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** File name written at the repository/package root. */
export const BUILD_INFO_FILE = 'build-info.json'

/** Every channel a build may report. Only `dev` is produced outside a release tag. */
export const BUILD_CHANNELS = Object.freeze(['stable', 'preview', 'dev'])

/** The repository root, derived from this file's location (`tools/..`). */
export const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** A semver tag such as `v0.2.0` or `v0.3.0-rc.1`. */
const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u

/** A version without the leading `v`, as `package.json` stores it. */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u

/** A full Git object id (SHA-1 or SHA-256). */
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u

/** A coded failure the CLI and the workflows can report without a stack trace. */
export class BuildInfoError extends Error {
  /**
   * @param {string} code - stable machine-readable reason.
   * @param {string} message - operator-readable explanation.
   */
  constructor(code, message) {
    super(message)
    this.name = 'BuildInfoError'
    this.code = code
  }
}

/**
 * Parse a semantic version.
 * @param {string} version - version without a leading `v`.
 * @returns {{major: number, minor: number, patch: number, prerelease: string | undefined, build: string | undefined}} parsed parts.
 * @throws {BuildInfoError} when the version is not valid SemVer.
 */
export function parseSemver(version) {
  const match = typeof version === 'string' ? SEMVER.exec(version) : null
  if (match === null) {
    throw new BuildInfoError('invalid-version', `"${String(version)}" is not a valid semantic version`)
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
    build: match[5],
  }
}

/**
 * Parse a release tag of the form `v<semver>`.
 * @param {string} tag - the Git tag.
 * @returns {{version: string, prerelease: string | undefined}} the version it names.
 * @throws {BuildInfoError} when the tag is not a valid release tag.
 */
export function parseReleaseTag(tag) {
  const match = typeof tag === 'string' ? RELEASE_TAG.exec(tag) : null
  if (match === null) {
    throw new BuildInfoError('invalid-tag', `"${String(tag)}" is not a release tag of the form v<semver>`)
  }
  return { version: tag.slice(1), prerelease: match[4] }
}

/**
 * The channel a version belongs to when it is released.
 * @param {string} version - version without a leading `v`.
 * @returns {'stable' | 'preview'} stable for a plain version, preview for a prerelease.
 */
export function channelOfVersion(version) {
  return parseSemver(version).prerelease === undefined ? 'stable' : 'preview'
}

/**
 * Read the authoritative version from `package.json`.
 * @param {string} [root] - repository root; defaults to this checkout.
 * @returns {string} the version.
 */
export function readPackageVersion(root = REPOSITORY_ROOT) {
  const file = join(root, 'package.json')
  let manifest
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new BuildInfoError('package-unreadable', `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof manifest?.version !== 'string') {
    throw new BuildInfoError('package-version-missing', `${file} has no string "version" field`)
  }
  parseSemver(manifest.version)
  return manifest.version
}

/**
 * Run one Git command, returning `undefined` when Git is absent or refuses.
 * @param {string[]} args - Git arguments.
 * @param {string} root - working directory.
 * @returns {string | undefined} trimmed stdout.
 */
function git(args, root) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim()
  } catch {
    return undefined
  }
}

/**
 * Read the checkout state.
 *
 * `commit: null` means "this is not a Git checkout"; `dirty: null` means Git could
 * not tell. Both are reported as unknown rather than guessed. A release treats
 * either unknown as a hard failure.
 *
 * The status command runs with `--untracked-files=normal`, so an untracked source
 * file counts as dirty. Ignored build output (`lib/`, `dist/`, `build-info.json`,
 * `node_modules/`) does not.
 *
 * @param {string} [root] - repository root; defaults to this checkout.
 * @returns {{commit: string | null, dirty: boolean | null}} the state.
 */
export function readGitState(root = REPOSITORY_ROOT) {
  const commit = git(['rev-parse', '--verify', 'HEAD'], root)
  if (commit === undefined || !GIT_OBJECT_ID.test(commit)) {
    return { commit: null, dirty: null }
  }
  const status = git(['status', '--porcelain', '--untracked-files=normal'], root)
  if (status === undefined) return { commit, dirty: null }
  return { commit, dirty: status !== '' }
}

/**
 * Build the metadata object for one build.
 *
 * @param {object} [options]
 * @param {string} [options.root] - repository root.
 * @param {boolean} [options.release] - true for a tag-triggered release build.
 * @param {string} [options.tag] - the Git tag; required for a release.
 * @param {string} [options.packageVersion] - override for tests.
 * @param {{commit: string | null, dirty: boolean | null}} [options.gitInfo] - override for tests.
 * @param {string} [options.builtAt] - override for tests; must be a valid date.
 * @returns {{version: string, commit: string | null, builtAt: string, channel: 'stable' | 'preview' | 'dev', dirty: boolean | null}} frozen metadata.
 */
export function createBuildInfo(options = {}) {
  const {
    root = REPOSITORY_ROOT,
    release = false,
    tag,
    packageVersion,
    gitInfo,
    builtAt = new Date().toISOString(),
  } = options

  const version = packageVersion ?? readPackageVersion(root)
  const parsed = parseSemver(version)
  const time = new Date(builtAt)
  if (Number.isNaN(time.getTime())) {
    throw new BuildInfoError('invalid-built-at', `"${String(builtAt)}" is not a valid build timestamp`)
  }

  const state = gitInfo ?? readGitState(root)

  if (!release) {
    return Object.freeze({
      version,
      commit: state.commit,
      builtAt: time.toISOString(),
      channel: 'dev',
      dirty: state.dirty,
    })
  }

  if (typeof tag !== 'string' || tag === '') {
    throw new BuildInfoError('release-tag-missing', 'a release build requires --tag v<version>')
  }
  const expectedTag = `v${version}`
  if (tag !== expectedTag) {
    throw new BuildInfoError(
      'release-tag-mismatch',
      `tag "${tag}" does not match package.json version "${version}" (expected "${expectedTag}")`,
    )
  }
  // Parsing the tag again proves it is a complete semantic version, not just a
  // string that happens to equal `v` + something semver-shaped.
  parseReleaseTag(tag)
  if (state.commit === null) {
    throw new BuildInfoError('release-commit-unknown', 'a release build requires a Git checkout with a commit')
  }
  if (state.dirty !== false) {
    throw new BuildInfoError('release-tree-dirty', 'a release build requires a clean working tree (including untracked files)')
  }

  return Object.freeze({
    version,
    commit: state.commit,
    builtAt: time.toISOString(),
    channel: parsed.prerelease === undefined ? 'stable' : 'preview',
    dirty: false,
  })
}

/**
 * Validate a metadata object, optionally against an expected version.
 * @param {unknown} value - parsed JSON or a candidate object.
 * @param {object} [options]
 * @param {string} [options.expectedVersion] - version that must match.
 * @param {string} [options.source] - label used in error messages.
 * @returns {{version: string, commit: string | null, builtAt: string, channel: 'stable' | 'preview' | 'dev', dirty: boolean | null}} the metadata.
 */
export function validateBuildInfo(value, options = {}) {
  const { expectedVersion, source = 'build-info' } = options
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BuildInfoError('invalid-build-info', `${source} must be a JSON object`)
  }
  const info = /** @type {Record<string, unknown>} */ (value)
  if (typeof info.version !== 'string') {
    throw new BuildInfoError('invalid-build-info', `${source}.version must be a string`)
  }
  parseSemver(info.version)
  if (expectedVersion !== undefined && info.version !== expectedVersion) {
    throw new BuildInfoError(
      'version-mismatch',
      `${source}.version "${info.version}" does not match package.json version "${expectedVersion}"`,
    )
  }
  if (typeof info.commit !== 'string' && info.commit !== null) {
    throw new BuildInfoError('invalid-build-info', `${source}.commit must be a Git object id or null`)
  }
  if (typeof info.commit === 'string' && !GIT_OBJECT_ID.test(info.commit)) {
    throw new BuildInfoError('invalid-build-info', `${source}.commit is not a full Git object id`)
  }
  if (typeof info.builtAt !== 'string' || Number.isNaN(new Date(info.builtAt).getTime())) {
    throw new BuildInfoError('invalid-build-info', `${source}.builtAt must be an ISO 8601 timestamp`)
  }
  if (!BUILD_CHANNELS.includes(info.channel)) {
    throw new BuildInfoError('invalid-build-info', `${source}.channel must be one of ${BUILD_CHANNELS.join(', ')}`)
  }
  if (info.dirty !== null && typeof info.dirty !== 'boolean') {
    throw new BuildInfoError('invalid-build-info', `${source}.dirty must be a boolean or null`)
  }
  if (info.channel !== 'dev') {
    const expectedChannel = channelOfVersion(info.version)
    if (info.channel !== expectedChannel) {
      throw new BuildInfoError(
        'invalid-build-info',
        `${source}.channel "${String(info.channel)}" does not match version "${info.version}" (expected "${expectedChannel}")`,
      )
    }
    if (info.commit === null || info.dirty !== false) {
      throw new BuildInfoError('invalid-build-info', `${source} is a release build but its Git state is not clean and known`)
    }
  }
  return /** @type {{version: string, commit: string | null, builtAt: string, channel: 'stable' | 'preview' | 'dev', dirty: boolean | null}} */ (info)
}

/**
 * Write `build-info.json` at the package root.
 * @param {ReturnType<typeof createBuildInfo>} info - metadata to write.
 * @param {string} [root] - repository root.
 * @returns {string} absolute path written.
 */
export function writeBuildInfo(info, root = REPOSITORY_ROOT) {
  validateBuildInfo(info)
  const file = join(root, BUILD_INFO_FILE)
  writeFileSync(file, `${JSON.stringify(info, null, 2)}\n`, 'utf8')
  return file
}

/**
 * Read and validate `build-info.json`.
 * @param {string} [root] - repository root.
 * @returns {ReturnType<typeof createBuildInfo>} the metadata.
 */
export function readBuildInfo(root = REPOSITORY_ROOT) {
  const file = join(root, BUILD_INFO_FILE)
  if (!existsSync(file)) {
    throw new BuildInfoError('build-info-missing', `${file} does not exist; run the build before packing`)
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new BuildInfoError('build-info-unreadable', `cannot parse ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return validateBuildInfo(parsed, { source: BUILD_INFO_FILE })
}

/**
 * Read `build-info.json` and prove it describes the current `package.json`.
 * @param {string} [root] - repository root.
 * @returns {ReturnType<typeof createBuildInfo>} the metadata.
 */
export function checkBuildInfo(root = REPOSITORY_ROOT) {
  const expectedVersion = readPackageVersion(root)
  const info = readBuildInfo(root)
  validateBuildInfo(info, { expectedVersion, source: BUILD_INFO_FILE })
  return info
}

/**
 * Produce the metadata for a build and, by default, write it to disk.
 *
 * `tsdown.config.ts` calls this once and embeds the returned object, so the JSON
 * file and the bundle always describe the same instant. Release mode is enabled by
 * `DSH_NODE_RELEASE=1` plus `DSH_NODE_RELEASE_TAG=v<version>`.
 *
 * @param {object} [options]
 * @param {string} [options.root] - repository root.
 * @param {NodeJS.ProcessEnv} [options.env] - environment to read.
 * @param {boolean} [options.write] - whether to write `build-info.json`.
 * @returns {ReturnType<typeof createBuildInfo>} the metadata.
 */
export function prepareBuildInfo(options = {}) {
  const { root = REPOSITORY_ROOT, env = process.env, write = true } = options
  const release = env.DSH_NODE_RELEASE === '1' || env.DSH_NODE_RELEASE === 'true'
  const tag = env.DSH_NODE_RELEASE_TAG
  const info = createBuildInfo({
    root,
    release,
    ...(typeof tag === 'string' && tag !== '' ? { tag } : {}),
  })
  if (write) writeBuildInfo(info, root)
  return info
}

/** Print a one-line summary used by the workflows and by a human. */
function report(info, root, verb = 'ok') {
  const file = join(root, BUILD_INFO_FILE)
  console.log(`build-info: ${verb} ${file}`)
  console.log(`  version=${info.version} channel=${info.channel} commit=${info.commit ?? 'null'} dirty=${info.dirty === null ? 'null' : String(info.dirty)} builtAt=${info.builtAt}`)
}

/**
 * Parse the small CLI surface.
 * @param {string[]} argv - arguments after `node`.
 * @returns {{write: boolean, release: boolean, check: boolean, checkRelease: boolean, tag: string | undefined, root: string | undefined}} parsed flags.
 */
function parseArgs(argv) {
  const parsed = { write: false, release: false, check: false, checkRelease: false, tag: undefined, root: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--write') parsed.write = true
    else if (argument === '--release') parsed.release = true
    else if (argument === '--check') parsed.check = true
    else if (argument === '--check-release') parsed.checkRelease = true
    else if (argument === '--tag') {
      parsed.tag = argv[index + 1]
      index += 1
    } else if (argument.startsWith('--tag=')) parsed.tag = argument.slice('--tag='.length)
    else if (argument === '--root') {
      parsed.root = argv[index + 1]
      index += 1
    } else if (argument.startsWith('--root=')) parsed.root = argument.slice('--root='.length)
    else throw new BuildInfoError('invalid-argument', `unknown argument "${String(argument)}"`)
  }
  return parsed
}

/** CLI entry point. */
function main() {
  const args = parseArgs(process.argv.slice(2))
  const root = args.root === undefined ? REPOSITORY_ROOT : resolve(args.root)

  if (args.check && args.checkRelease) {
    throw new BuildInfoError('invalid-argument', '--check and --check-release are mutually exclusive')
  }
  if (args.check) {
    report(checkBuildInfo(root), root)
    return
  }
  if (args.checkRelease) {
    const info = createBuildInfo({ root, release: true, tag: args.tag })
    report(info, root, 'release candidate')
    return
  }

  const info = createBuildInfo({
    root,
    release: args.release,
    ...(args.tag === undefined ? {} : { tag: args.tag }),
  })
  if (args.write) {
    const file = writeBuildInfo(info, root)
    console.log(`build-info: wrote ${file}`)
  } else {
    console.log(JSON.stringify(info, null, 2))
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    if (error instanceof BuildInfoError) {
      console.error(`build-info: ${error.code}: ${error.message}`)
      process.exitCode = 1
    } else {
      throw error
    }
  }
}
