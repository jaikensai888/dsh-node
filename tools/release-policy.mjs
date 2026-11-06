#!/usr/bin/env node
/**
 * Release decisions that do not need GitHub to be reachable.
 *
 * The release workflow delegates every policy question to this module so the
 * answer can be unit-tested: which channel a version belongs to, whether it is a
 * prerelease, whether it should become the repository's "latest" release, and
 * whether an existing Release may be created, retried, or must be refused.
 *
 * Keeping this out of YAML also keeps the workflow readable: the workflow only
 * gathers facts (existing Release state, current latest stable tag) and acts on
 * the plan printed here.
 *
 * @module dsh-node/tools/release-policy
 */

import { appendFileSync } from 'node:fs'
import {
  BuildInfoError,
  channelOfVersion,
  parseReleaseTag,
  parseSemver,
  readPackageVersion,
} from './build-info.mjs'

/**
 * Compare two semantic versions, ignoring build metadata.
 * @param {string} left - version, optionally prefixed with `v`.
 * @param {string} right - version, optionally prefixed with `v`.
 * @returns {-1 | 0 | 1} negative when `left` precedes `right`.
 */
export function compareVersions(left, right) {
  const a = parseSemver(String(left).replace(/^v/u, ''))
  const b = parseSemver(String(right).replace(/^v/u, ''))
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  if (a.prerelease === undefined && b.prerelease === undefined) return 0
  // A version without a prerelease is greater than one with it.
  if (a.prerelease === undefined) return 1
  if (b.prerelease === undefined) return -1
  const leftParts = a.prerelease.split('.')
  const rightParts = b.prerelease.split('.')
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftPart = leftParts[index]
    const rightPart = rightParts[index]
    // A shorter set of identifiers has lower precedence when all shared parts match.
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (leftPart === rightPart) continue
    const leftNumeric = /^\d+$/u.test(leftPart)
    const rightNumeric = /^\d+$/u.test(rightPart)
    if (leftNumeric && rightNumeric) return Number(leftPart) < Number(rightPart) ? -1 : 1
    if (leftNumeric) return -1
    if (rightNumeric) return 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

/**
 * Whether two commit identifiers name the same commit.
 *
 * GitHub may report a short SHA or a branch name in `target_commitish`; this
 * accepts a short/long SHA pair but never a branch name.
 * @param {string} left - one identifier.
 * @param {string} right - the other identifier.
 * @returns {boolean} true when both are SHA prefixes of the same value.
 */
export function sameCommit(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const a = left.trim().toLowerCase()
  const b = right.trim().toLowerCase()
  if (!/^[0-9a-f]{7,64}$/u.test(a) || !/^[0-9a-f]{7,64}$/u.test(b)) return false
  return a.startsWith(b) || b.startsWith(a)
}

/**
 * Decide what the workflow may do with one release tag.
 *
 * @param {object} input
 * @param {string} input.tag - the pushed tag, `v<version>`.
 * @param {string} input.version - the version in `package.json`.
 * @param {string} input.commit - the full commit the tag points at.
 * @param {'none' | 'draft' | 'published'} [input.existing] - current Release state.
 * @param {string} [input.existingCommit] - `target_commitish` of an existing draft.
 * @param {string | undefined} [input.latestStable] - newest published non-prerelease tag.
 * @returns {{action: 'create' | 'retry-draft', channel: 'stable' | 'preview', prerelease: boolean, latest: boolean}} the plan.
 * @throws {BuildInfoError} when the tag, version, or existing Release makes publishing unsafe.
 */
export function planRelease(input) {
  const { tag, version, commit, existing = 'none', existingCommit, latestStable } = input
  if (typeof commit !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commit)) {
    throw new BuildInfoError('invalid-commit', `"${String(commit)}" is not a full Git commit id`)
  }
  const parsedTag = parseReleaseTag(tag)
  if (parsedTag.version !== version) {
    throw new BuildInfoError(
      'release-tag-mismatch',
      `tag "${tag}" does not match package.json version "${version}"`,
    )
  }
  if (!['none', 'draft', 'published'].includes(existing)) {
    throw new BuildInfoError('invalid-existing', `"${String(existing)}" is not one of none, draft, published`)
  }

  let action
  if (existing === 'none') {
    action = 'create'
  } else if (existing === 'published') {
    // A published Release is immutable history: a retry must never replace it.
    throw new BuildInfoError(
      'release-already-published',
      `release ${tag} is already published; bump the version instead of replacing it`,
    )
  } else {
    if (!sameCommit(existingCommit ?? '', commit)) {
      throw new BuildInfoError(
        'release-draft-commit-mismatch',
        `draft release ${tag} targets ${String(existingCommit)}, not ${commit}; refusing to retry it`,
      )
    }
    action = 'retry-draft'
  }

  const channel = channelOfVersion(version)
  const prerelease = channel === 'preview'
  let latest = false
  if (!prerelease) {
    if (latestStable === undefined || latestStable === '') {
      latest = true
    } else {
      latest = compareVersions(version, latestStable) > 0
    }
  }

  return Object.freeze({ action, channel, prerelease, latest })
}

/**
 * Parse the workflow-facing CLI.
 * @param {string[]} argv - arguments after `node`.
 * @returns {{tag: string | undefined, version: string | undefined, commit: string | undefined, existing: 'none' | 'draft' | 'published', existingCommit: string | undefined, latestStable: string | undefined, root: string | undefined}} parsed flags.
 */
function parseArgs(argv) {
  const parsed = {
    tag: undefined,
    version: undefined,
    commit: process.env.GITHUB_SHA,
    existing: 'none',
    existingCommit: undefined,
    latestStable: undefined,
    root: undefined,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const take = () => {
      const value = argv[index + 1]
      index += 1
      return value
    }
    if (argument === '--tag') parsed.tag = take()
    else if (argument === '--version') parsed.version = take()
    else if (argument === '--commit') parsed.commit = take()
    else if (argument === '--existing') parsed.existing = take()
    else if (argument === '--existing-commit') parsed.existingCommit = take()
    else if (argument === '--latest-stable') parsed.latestStable = take()
    else if (argument === '--root') parsed.root = take()
    else if (argument.startsWith('--tag=')) parsed.tag = argument.slice('--tag='.length)
    else throw new BuildInfoError('invalid-argument', `unknown argument "${String(argument)}"`)
  }
  return parsed
}

/** CLI entry point. */
function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.tag === undefined) throw new BuildInfoError('invalid-argument', '--tag is required')
  const version = args.version ?? readPackageVersion(args.root)
  const plan = planRelease({
    tag: args.tag,
    version,
    commit: args.commit ?? '',
    existing: args.existing ?? 'none',
    ...(args.existingCommit === undefined ? {} : { existingCommit: args.existingCommit }),
    ...(args.latestStable === undefined ? {} : { latestStable: args.latestStable }),
  })
  if (process.env.GITHUB_OUTPUT !== undefined && process.env.GITHUB_OUTPUT !== '') {
    const lines = [
      `action=${plan.action}`,
      `channel=${plan.channel}`,
      `prerelease=${String(plan.prerelease)}`,
      `latest=${String(plan.latest)}`,
    ]
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`, 'utf8')
    console.log(`release-policy: ${lines.join(' ')}`)
  } else {
    console.log(JSON.stringify(plan, null, 2))
  }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('release-policy.mjs')) {
  try {
    main()
  } catch (error) {
    if (error instanceof BuildInfoError) {
      console.error(`release-policy: ${error.code}: ${error.message}`)
      process.exitCode = 1
    } else {
      throw error
    }
  }
}
