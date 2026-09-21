/**
 * The filesystem fence for the management Remotes.
 *
 * Every path that arrives from a Coordinator is attacker-controlled, so no
 * management Remote may touch a path directly. Instead each one asks this module
 * whether the path is inside an allowed root, and the answer is computed the same
 * way every time:
 *
 * 1. the path must be **absolute** (`C:foo` and `foo/bar` are refused — the
 *    drive-relative form resolves against a per-process cwd, which is exactly the
 *    kind of ambient state a remote caller must not be able to steer);
 * 2. both the root and the target are **realpath'd**, so a symlink or junction
 *    inside an allowed root cannot be used to step outside it;
 * 3. the resolved target must be the root itself or a descendant of it.
 *
 * Comparison is case-insensitive on Windows and tolerates mixed separators,
 * because a mixed path is what real callers actually produce on this platform.
 *
 * @module dsh-node/admin/path-policy
 */

import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { resolveDshHome } from '../identity.js'

/** Refusal reason, for a diagnostic that does not leak host paths. */
export type PathDenialReason =
  | 'not-absolute'
  | 'no-roots'
  | 'outside-roots'
  | 'unresolvable'

/** Outcome of one containment question. */
export type PathDecision =
  | { readonly allowed: true; readonly path: string; readonly root: string }
  | { readonly allowed: false; readonly reason: PathDenialReason }

/**
 * The roots a management Remote may touch.
 *
 * Kept as an explicit object rather than a loose array so a caller has to name
 * the policy it is asking about, and so an empty policy is visibly empty.
 */
export interface PathPolicy {
  /** Absolute roots, already resolved. */
  readonly roots: readonly string[]
  /** Where skill bundles may be written, when skill management is in use. */
  readonly skillRoots: readonly string[]
}

/** Options for {@link resolvePathPolicy}. */
export interface PathPolicyOptions {
  /** Extra absolute roots from configuration. */
  readonly allowedRoots?: readonly string[]
  /** Extra absolute skill roots from configuration. */
  readonly skillRoots?: readonly string[]
  /** Working directories of live sessions. */
  readonly sessionCwds?: readonly string[]
  /** Environment used to resolve `$DSH_HOME`. */
  readonly env?: NodeJS.ProcessEnv
}

/**
 * Build the effective policy.
 *
 * Defaults are deliberately narrow but useful: the working directories of live
 * DSH sessions, plus the harness skill directories. Nothing else on the machine
 * is reachable, which is what keeps "default on" from meaning "the whole disk".
 * @param options - configured roots plus live session working directories.
 * @returns the resolved policy.
 */
export function resolvePathPolicy(options: PathPolicyOptions = {}): PathPolicy {
  const dshHome = resolveDshHome(options.env ?? process.env)
  const agentsHome = options.env?.['DSH_AGENTS_HOME'] ?? join(dshHome, '..', '.agents')
  return {
    roots: dedupe([
      ...(options.allowedRoots ?? []),
      ...(options.sessionCwds ?? []),
    ]),
    skillRoots: dedupe([
      ...(options.skillRoots ?? []),
      join(dshHome, 'skills'),
      join(agentsHome, 'skills'),
    ]),
  }
}

/** Drop blanks and duplicates, keeping the configured order. */
function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const kept: string[] = []
  for (const value of values) {
    if (typeof value !== 'string' || value.trim() === '') continue
    const key = process.platform === 'win32' ? value.toLowerCase() : value
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(value)
  }
  return kept
}

/**
 * Answer whether `target` may be read or written under `roots`.
 *
 * `roots` is empty ⇒ everything is refused, on purpose: an unconfigured node must
 * not fall back to "the whole filesystem".
 * @param roots - absolute allowed roots.
 * @param target - absolute path from the Coordinator.
 * @returns the decision, with the canonical path when allowed.
 */
export async function decidePath(
  roots: readonly string[],
  target: unknown,
): Promise<PathDecision> {
  if (typeof target !== 'string' || target === '') return { allowed: false, reason: 'not-absolute' }
  if (!isAbsolute(target)) return { allowed: false, reason: 'not-absolute' }
  // `C:foo` satisfies `isAbsolute` on Windows but resolves against a per-drive
  // cwd, so it is explicitly refused.
  if (process.platform === 'win32' && /^[A-Za-z]:[^\\/]/u.test(target)) {
    return { allowed: false, reason: 'not-absolute' }
  }
  if (roots.length === 0) return { allowed: false, reason: 'no-roots' }

  const canonicalTarget = await canonicalize(target)
  if (canonicalTarget === undefined) return { allowed: false, reason: 'unresolvable' }

  for (const root of roots) {
    const canonicalRoot = await canonicalize(root)
    if (canonicalRoot === undefined) continue
    if (isWithin(canonicalRoot, canonicalTarget)) {
      return { allowed: true, path: canonicalTarget, root: canonicalRoot }
    }
  }
  return { allowed: false, reason: 'outside-roots' }
}

/**
 * Canonicalize a path whose final components may not exist yet.
 *
 * `fs.realpath` fails on a missing path, and resolving only the parent is not
 * enough: a symlinked *parent* is exactly the escape this guards against. So the
 * deepest existing ancestor is realpath'd and the missing suffix is appended.
 * @param path - absolute path.
 * @returns the canonical path, or `undefined` when it cannot be resolved.
 */
export async function canonicalize(path: string): Promise<string | undefined> {
  let current = resolve(path)
  const missing: string[] = []
  for (;;) {
    try {
      const canonical = await realpath(current)
      return missing.length === 0 ? canonical : join(canonical, ...missing.reverse())
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return undefined
      const parent = dirname(current)
      // Reached the filesystem root without finding anything real.
      if (parent === current) return undefined
      missing.push(current.slice(parent.length).replace(/^[\\/]/u, ''))
      current = parent
    }
  }
}

/**
 * Whether `target` is `base` or a descendant of it.
 *
 * Separator-normalized and case-insensitive on Windows, because a caller that
 * joins a session cwd with a relative path produces exactly that mixture.
 * @param base - canonical root.
 * @param target - canonical candidate.
 * @returns `true` when the target is contained.
 */
export function isWithin(base: string, target: string): boolean {
  const normalize = (value: string): string => value.replace(/[\\/]+/gu, '/').replace(/\/+$/u, '')
  const left = normalize(base)
  const right = normalize(target)
  if (process.platform === 'win32') {
    const lowerLeft = left.toLowerCase()
    const lowerRight = right.toLowerCase()
    return lowerRight === lowerLeft || lowerRight.startsWith(`${lowerLeft}/`)
  }
  return right === left || right.startsWith(`${left}/`)
}

/**
 * Turn a denial into a message that does not disclose the host's layout.
 *
 * The Coordinator is told *why* it was refused, never which directories exist.
 * @param reason - the denial reason.
 * @returns a short, path-free explanation.
 */
export function describeDenial(reason: PathDenialReason): string {
  switch (reason) {
    case 'not-absolute':
      return 'path must be an absolute path (drive-relative and relative paths are refused)'
    case 'no-roots':
      return 'no filesystem root is allowed on this node; configure allowedRoots or open a session first'
    case 'outside-roots':
      return 'path is outside every allowed root on this node'
    case 'unresolvable':
      return 'path could not be resolved on this node'
    default:
      return 'path was refused'
  }
}

/** The platform separator, re-exported so callers need not import `node:path`. */
export const PATH_SEPARATOR = sep
