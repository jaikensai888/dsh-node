/**
 * `nodeAdmin` — the node's own management Remotes.
 *
 * Everything else in this plugin *forwards* capabilities the profile already has.
 * This module is the opposite: it **adds** a small, explicitly named, explicitly
 * parameterised surface so a Coordinator can diagnose the node, move files inside
 * a policy, and manage skills. The spec's Phase 3 asks for exactly this, and is
 * emphatic that it must not become "any system call":
 *
 * > 这些能力必须是明确命名、明确参数和明确权限的 Remote，
 * > 不能通过 "full-access" 偷偷变成任意系统调用。
 *
 * How each of those three words is honoured here:
 *
 * - **命名**: one namespace, `nodeAdmin`, with one method per capability. No
 *   generic "run this" or "read any path" escape hatch.
 * - **参数**: every method declares its wire parameters and validates their types
 *   itself, because a `src-json` codec lets the Gateway tolerate a missing field
 *   (see the note on codecs below).
 * - **权限**: filesystem access goes through `decidePath` against a policy, and
 *   skill management is confined to the harness skill roots. Nothing here spawns a
 *   process, evaluates a string, or loads a module.
 *
 * ## Why `src-json` codecs plus hand-written validation
 *
 * `assertExactArguments` treats a `src-json` parameter as omissible, so the Gateway
 * will happily deliver `{}` to a method that wanted three fields. Two options
 * existed: declare strict codecs with a runtime schema, or declare `src-json` and
 * validate in the method. The second was chosen so that **every management failure
 * is reported by one mechanism** — a `nodeAdmin/*` code from the method — instead
 * of splitting "missing arg" (`gateway/arguments-invalid`) from "bad arg"
 * (`nodeAdmin/invalid-arguments`).
 *
 * ## One record per operation
 *
 * The audit append lives in the `audited*` wrappers and nowhere else. A body that
 * wants its byte count recorded returns it as `bytes` in its result; the wrapper
 * picks it up. Appending inside a body as well would double every operation in the
 * trail, which a test now asserts against.
 *
 * @module dsh-node/admin/service
 */

import { mkdir, readFile, readdir, rmdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'
import { remoteError } from '../errors.js'
import type { DshNodeStatus } from '../protocol.js'
import { AuditLog, type AuditRecord } from './audit.js'
import { decidePath, describeDenial, resolvePathPolicy, type PathPolicy, type PathPolicyOptions } from './path-policy.js'

/** Wire namespace of every management Remote in this plugin. */
export const ADMIN_NAMESPACE = 'nodeAdmin'

/** Cordis service key the owner is provided under. */
export const ADMIN_SERVICE_KEY = 'nodeAdmin'

/** Largest file this node will read in one call. */
export const MAX_READ_BYTES = 1_048_576

/** Largest content this node will write in one call. */
export const MAX_WRITE_BYTES = 4_194_304

/** Largest skill bundle body accepted. */
export const MAX_SKILL_BYTES = 1_048_576

/** Default number of audit records returned when the caller does not say. */
const DEFAULT_AUDIT_LIMIT = 50

/** A JSON parameter the Gateway tolerates omitting, validated by the method. */
function jsonParameter(name: string): InvocationDescriptor['parameters'][number] {
  return { name, wire: name, source: 'json', codec: { mode: 'src-json' } }
}

/** Build one descriptor of the `nodeAdmin` surface. */
function adminDescriptor(
  method: string,
  parameters: readonly string[],
  implementation?: string,
): InvocationDescriptor {
  return {
    id: `dsh-node/admin#${method}`,
    service: ADMIN_SERVICE_KEY,
    namespace: ADMIN_NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters: parameters.map(jsonParameter),
    result: { mode: 'src-json' },
    // Set only when the wire name and the method name differ: the Gateway resolves
    // `implementation ?? method`, so an unlisted mismatch surfaces as "has no
    // callable method" at call time rather than at review time.
    ...(implementation === undefined ? {} : { implementation }),
  }
}

/**
 * The complete `nodeAdmin` surface.
 *
 * Exported as data so a test can assert the exact surface: an endpoint added here
 * without a decision is visible in review, and a test can prove the node does not
 * expose anything else.
 */
export const ADMIN_DESCRIPTORS: readonly InvocationDescriptor[] = [
  // ---- diagnostics: read-only, no argument can name a host resource ----
  adminDescriptor('describe', []),
  adminDescriptor('status', []),
  adminDescriptor('capabilities', []),
  adminDescriptor('audit', ['limit'], 'auditRecent'),
  // ---- filesystem: policy-bounded ----
  adminDescriptor('fsList', ['path']),
  adminDescriptor('fsStat', ['path']),
  adminDescriptor('fsRead', ['path']),
  adminDescriptor('fsWrite', ['path', 'content']),
  adminDescriptor('fsRemove', ['path']),
  // ---- skills: confined to the harness skill roots ----
  adminDescriptor('skillsList', []),
  adminDescriptor('skillRead', ['name']),
  adminDescriptor('skillInstall', ['name', 'content']),
  adminDescriptor('skillRemove', ['name']),
]

/** What the owner reads from the node for its diagnostics. */
export interface AdminHostView {
  /** The redacted status snapshot. */
  status(): DshNodeStatus
  /** Advertised endpoints, endpoint + mode. */
  capabilities(): readonly { readonly endpoint: string; readonly mode: string }[]
  /** Process start, for an uptime figure. */
  startedAt(): number
  /** Node name from configuration, for display only. */
  nodeName?: string
  /** Role from configuration, for display only. */
  role?: string
  /** Working directories of live sessions, used as default filesystem roots. */
  sessionCwds(): readonly string[]
  /** Version string of this plugin. */
  version(): string
}

/** Construction inputs for {@link NodeAdminOwner}. */
export interface NodeAdminOwnerOptions {
  /** Read-only view of the node. */
  readonly host: AdminHostView
  /** Filesystem policy overrides from configuration. */
  readonly policy?: PathPolicyOptions
  /** Clock, injectable for tests. */
  readonly now?: () => number
  /** Whether the filesystem surface is enabled at all. */
  readonly filesystemEnabled?: boolean
  /** Whether the skill surface is enabled at all. */
  readonly skillsEnabled?: boolean
  /** Audit ring capacity. */
  readonly auditCapacity?: number
}

/**
 * The `nodeAdmin` Remote owner.
 *
 * A plain object rather than a Cordis `Service` subclass, deliberately: the Gateway
 * only needs `ctx.get(serviceKey)` to return an object carrying a `typertRemote`
 * binding, and building that binding by hand keeps this plugin free of runtime
 * imports from official packages (see `docs/GROUND-TRUTH.md` §3).
 */
export class NodeAdminOwner {
  /** Gateway binding, read structurally by `validateBinding` and `collectSrcClaims`. */
  readonly typertRemote: { readonly service: unknown; readonly serviceKey: string; readonly namespace: string }

  private readonly host: AdminHostView
  private readonly policyOptions: PathPolicyOptions
  private readonly filesystemEnabled: boolean
  private readonly skillsEnabled: boolean
  private readonly now: () => number
  /**
   * The audit trail, also readable through `nodeAdmin/audit`.
   *
   * Named `auditLog`, not `audit`: a field called `audit` would sit exactly on the
   * name the `nodeAdmin/audit` descriptor resolves, and `Reflect.get` would find a
   * non-callable object there.
   */
  readonly auditLog: AuditLog

  /**
   * @param options - host view, policy, and capability switches.
   */
  constructor(options: NodeAdminOwnerOptions) {
    this.host = options.host
    this.policyOptions = options.policy ?? {}
    this.filesystemEnabled = options.filesystemEnabled ?? true
    this.skillsEnabled = options.skillsEnabled ?? true
    this.now = options.now ?? Date.now
    this.auditLog = new AuditLog(options.auditCapacity ?? 256, this.now)
    // Exactly what `bindTypertRemote` produces, built here so no official package is
    // imported at runtime. `readBinding` checks these three fields and that
    // `service` is the receiver itself.
    this.typertRemote = Object.freeze({
      service: this,
      serviceKey: ADMIN_SERVICE_KEY,
      namespace: ADMIN_NAMESPACE,
    })
  }

  // ------------------------------------------------------------- diagnostics

  /** One call that answers "what is this node". */
  describe(): Record<string, unknown> {
    return this.audited('nodeAdmin/describe', undefined, () => {
      const status = this.host.status()
      return {
        nodeId: status.nodeId,
        ...(this.host.nodeName === undefined ? {} : { nodeName: this.host.nodeName }),
        ...(this.host.role === undefined ? {} : { role: this.host.role }),
        mode: 'full-access',
        pluginVersion: this.host.version(),
        state: status.state,
        uptimeMs: Math.max(0, this.now() - this.host.startedAt()),
        ...(status.coordinatorOrigin === undefined ? {} : { coordinatorOrigin: status.coordinatorOrigin }),
        ...(status.connectionId === undefined ? {} : { connectionId: status.connectionId }),
        inFlightRequests: status.inFlightRequests,
        activeStreams: status.activeStreams,
        capabilityCount: this.host.capabilities().length,
        auditCapacity: this.auditLog.limit,
        // The switches are reported so a Coordinator can tell "empty" from "off".
        surfaces: { diagnostics: true, filesystem: this.filesystemEnabled, skills: this.skillsEnabled },
      }
    })
  }

  /** The redacted status snapshot, unchanged from what the node reports locally. */
  status(): DshNodeStatus {
    return this.audited('nodeAdmin/status', undefined, () => this.host.status())
  }

  /** Every endpoint this node advertises, with its invocation mode. */
  capabilities(): { readonly remotes: readonly { endpoint: string; mode: string }[] } {
    return this.audited('nodeAdmin/capabilities', undefined, () => ({
      remotes: this.host.capabilities().map(entry => ({ endpoint: entry.endpoint, mode: entry.mode })),
    }))
  }

  /** Recent management operations, newest first. */
  auditRecent(limit?: unknown): { readonly records: readonly AuditRecord[]; readonly capacity: number } {
    const requested = limit === undefined
      ? DEFAULT_AUDIT_LIMIT
      : requireCount(limit, 'limit', 1, this.auditLog.limit)
    return this.audited('nodeAdmin/audit', undefined, () => ({
      records: this.auditLog.recent(requested),
      capacity: this.auditLog.limit,
    }))
  }

  // -------------------------------------------------------------- filesystem

  /** List one directory inside the policy. */
  async fsList(path?: unknown): Promise<Record<string, unknown>> {
    return this.auditedAsync('nodeAdmin/fsList', path, async () => {
      const target = await this.allow(path)
      let entries
      try {
        entries = await readdir(target, { withFileTypes: true })
      } catch (error) {
        fsFailure(error, `"${target}"`)
      }
      return {
        path: target,
        entries: entries
          .map(entry => ({ name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file' }))
          .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)),
      }
    })
  }

  /** Stat one path inside the policy. */
  async fsStat(path?: unknown): Promise<Record<string, unknown>> {
    return this.auditedAsync('nodeAdmin/fsStat', path, async () => {
      const target = await this.allow(path)
      const info = await this.statOf(target)
      return {
        path: target,
        kind: info.isDirectory() ? 'directory' : 'file',
        size: info.size,
        modifiedAt: info.mtime.toISOString(),
      }
    })
  }

  /** Read one file inside the policy, up to {@link MAX_READ_BYTES}. */
  async fsRead(path?: unknown): Promise<Record<string, unknown>> {
    return this.auditedAsync('nodeAdmin/fsRead', path, async () => {
      const target = await this.allow(path)
      const info = await this.statOf(target)
      if (info.isDirectory()) {
        throw remoteError('nodeAdmin/invalid-arguments', 'path is a directory, not a file', {})
      }
      if (info.size > MAX_READ_BYTES) {
        throw remoteError(
          'nodeAdmin/too-large',
          `file is ${info.size} bytes, over the ${MAX_READ_BYTES} byte read limit`,
          { bytes: info.size, maxBytes: MAX_READ_BYTES },
        )
      }
      let content: string
      try {
        content = await readFile(target, 'utf8')
      } catch (error) {
        fsFailure(error, `"${target}"`)
      }
      return { path: target, content, bytes: info.size }
    })
  }

  /** Write one file inside the policy, replacing it if it exists. */
  async fsWrite(path?: unknown, content?: unknown): Promise<Record<string, unknown>> {
    return this.auditedAsync('nodeAdmin/fsWrite', path, async () => {
      const target = await this.allow(path)
      const body = requireString(content, 'content', MAX_WRITE_BYTES)
      try {
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, body, 'utf8')
      } catch (error) {
        fsFailure(error, `"${target}"`)
      }
      return { path: target, bytes: Buffer.byteLength(body, 'utf8') }
    })
  }

  /** Remove one file, or one **empty** directory, inside the policy. */
  async fsRemove(path?: unknown): Promise<Record<string, unknown>> {
    return this.auditedAsync('nodeAdmin/fsRemove', path, async () => {
      const target = await this.allow(path)
      const info = await this.statOf(target)
      try {
        if (info.isDirectory()) {
          // `rmdir`, not `rm({ recursive: false })`: Node refuses *any* directory with
          // `rm` and `recursive: false` (EISDIR), while `rmdir` is exactly the wanted
          // semantic — it succeeds only when the directory is empty, so a remote
          // caller cannot erase a tree in one call.
          await rmdir(target)
          return { path: target, removed: true, kind: 'directory' }
        }
        await rm(target)
      } catch (error) {
        fsFailure(error, `"${target}"`)
      }
      return { path: target, removed: true, kind: 'file' }
    })
  }

  /** `stat`, with a missing path reported as the documented refusal. */
  private async statOf(target: string): Promise<Awaited<ReturnType<typeof stat>>> {
    try {
      return await stat(target)
    } catch (error) {
      return fsFailure(error, `"${target}"`)
    }
  }

  // ------------------------------------------------------------------ skills

  /** Every installed skill bundle, across the harness skill roots. */
  async skillsList(): Promise<Record<string, unknown>> {
    return this.auditedAsync('nodeAdmin/skillsList', undefined, async () => {
      this.requireSkills()
      const policy = this.policy()
      const skills: { name: string; layer: string; hasSkillMd: boolean }[] = []
      for (const [index, root] of policy.skillRoots.entries()) {
        let entries
        try {
          entries = await readdir(root, { withFileTypes: true })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw error
        }
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          skills.push({
            name: entry.name,
            // A layer label, not the host path: the Coordinator never learns where
            // this machine keeps its skills, only how many layers exist.
            layer: index === 0 ? 'primary' : `layer-${index}`,
            hasSkillMd: await exists(join(root, entry.name, 'SKILL.md')),
          })
        }
      }
      return { skills, layers: policy.skillRoots.length }
    })
  }

  /** Read one skill's `SKILL.md`. */
  async skillRead(name?: unknown): Promise<Record<string, unknown>> {
    return this.auditedAsync('nodeAdmin/skillRead', name, async () => {
      this.requireSkills()
      const safe = requireSkillName(name)
      const path = await this.skillPath(safe)
      let content: string
      try {
        content = await readFile(path, 'utf8')
      } catch (error) {
        // Named by the *name* the caller supplied: the resolved path stays private.
        fsFailure(error, `skill "${safe}"`)
      }
      // The name is echoed, the resolved path is not: the caller asked by name and
      // has no need to learn this machine's directory layout.
      return { name: safe, content, bytes: Buffer.byteLength(content, 'utf8') }
    })
  }

  /**
   * Install (or replace) one skill bundle.
   *
   * Writes into the primary harness skill root, and only ever two levels deep:
   * `<root>/<name>/SKILL.md`. There is no way to name a path, which is what keeps
   * this from being a general file-writing primitive with a friendlier name.
   */
  async skillInstall(name?: unknown, content?: unknown): Promise<Record<string, unknown>> {
    return this.auditedAsync('nodeAdmin/skillInstall', name, async () => {
      this.requireSkills()
      const safe = requireSkillName(name)
      const body = requireString(content, 'content', MAX_SKILL_BYTES)
      const directory = join(this.primarySkillRoot(), safe)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'SKILL.md'), body, 'utf8')
      return { name: safe, bytes: Buffer.byteLength(body, 'utf8') }
    })
  }

  /** Remove one skill bundle directory. */
  async skillRemove(name?: unknown): Promise<Record<string, unknown>> {
    return this.auditedAsync('nodeAdmin/skillRemove', name, async () => {
      this.requireSkills()
      const safe = requireSkillName(name)
      // The name is validated to a single safe segment, so this can only ever
      // remove one directory directly under the primary skill root.
      try {
        await rm(join(this.primarySkillRoot(), safe), { recursive: true })
      } catch (error) {
        fsFailure(error, `skill "${safe}"`)
      }
      return { name: safe, removed: true }
    })
  }

  // ----------------------------------------------------------------- helpers

  /** Resolve the current policy, folding in the live session working directories. */
  private policy(): PathPolicy {
    return resolvePathPolicy({
      ...this.policyOptions,
      sessionCwds: [...(this.policyOptions.sessionCwds ?? []), ...this.host.sessionCwds()],
    })
  }

  /** Decide one path against the filesystem policy, or raise `nodeAdmin/path-denied`. */
  private async allow(path: unknown): Promise<string> {
    if (!this.filesystemEnabled) {
      throw remoteError('nodeAdmin/path-denied', 'the filesystem surface is disabled on this node', {
        surface: 'filesystem',
      })
    }
    const decision = await decidePath(this.policy().roots, path)
    if (!decision.allowed) {
      throw remoteError('nodeAdmin/path-denied', describeDenial(decision.reason), { reason: decision.reason })
    }
    return decision.path
  }

  /** Refuse the skill surface when it is switched off. */
  private requireSkills(): void {
    if (!this.skillsEnabled) {
      throw remoteError('nodeAdmin/path-denied', 'the skill surface is disabled on this node', { surface: 'skills' })
    }
  }

  /** The primary skill root, or a refusal when none is configured. */
  private primarySkillRoot(): string {
    const root = this.policy().skillRoots[0]
    if (root === undefined) {
      throw remoteError('nodeAdmin/path-denied', describeDenial('no-roots'), { surface: 'skills' })
    }
    return root
  }

  /** Resolve `<primary skill root>/<name>/SKILL.md` through the policy. */
  private async skillPath(name: string): Promise<string> {
    const decision = await decidePath(
      this.policy().skillRoots,
      join(this.primarySkillRoot(), name, 'SKILL.md'),
    )
    if (!decision.allowed) {
      throw remoteError('nodeAdmin/path-denied', describeDenial(decision.reason), { reason: decision.reason })
    }
    return decision.path
  }

  /** Time one synchronous operation and record its outcome exactly once. */
  private audited<T>(endpoint: string, subject: string | undefined, body: () => T): T {
    const startedAt = this.now()
    try {
      const value = body()
      this.auditLog.append({
        at: this.auditLog.timestamp(),
        endpoint,
        outcome: 'ok',
        ...(subject === undefined ? {} : { subject: subjectKind(subject) }),
        ...bytesOf(value),
        durationMs: this.now() - startedAt,
      })
      return value
    } catch (error) {
      this.recordFailure(endpoint, subject, error, startedAt)
      throw error
    }
  }

  /** Time one asynchronous operation and record its outcome exactly once. */
  private async auditedAsync<T>(endpoint: string, subject: unknown, body: () => Promise<T>): Promise<T> {
    const startedAt = this.now()
    try {
      const value = await body()
      this.auditLog.append({
        at: this.auditLog.timestamp(),
        endpoint,
        outcome: 'ok',
        ...(typeof subject === 'string' ? { subject: subjectKind(subject) } : {}),
        // A body that moved bytes reports them in its result; the wrapper is the
        // only writer, so one operation is one record.
        ...bytesOf(value),
        durationMs: this.now() - startedAt,
      })
      return value
    } catch (error) {
      this.recordFailure(endpoint, subject, error, startedAt)
      throw error
    }
  }

  private recordFailure(endpoint: string, subject: unknown, error: unknown, startedAt: number): void {
    const code = typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : 'unknown'
    this.auditLog.append({
      at: this.auditLog.timestamp(),
      endpoint,
      outcome: 'error',
      code,
      ...(typeof subject === 'string' ? { subject: subjectKind(subject) } : {}),
      durationMs: this.now() - startedAt,
    })
  }
}

/**
 * Reduce an audit subject to something safe to retain.
 *
 * A path never reaches the trail: the Coordinator learns what *kind* of thing was
 * touched, not where the node keeps it.
 */
function subjectKind(subject: string): string {
  if (subject.startsWith('/') || /^[A-Za-z]:/u.test(subject)) {
    return subject.includes('.') ? 'file' : 'path'
  }
  return subject.includes('/') ? subject.split('/').slice(0, 2).join('/') : subject
}

/** Pull a byte count out of a result, when the operation moved bytes. */
function bytesOf(value: unknown): { bytes?: number } {
  if (typeof value !== 'object' || value === null) return {}
  const bytes = (value as { bytes?: unknown }).bytes
  return typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0 ? { bytes } : {}
}

/** Validate one required string argument. */
function requireString(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== 'string') {
    throw remoteError('nodeAdmin/invalid-arguments', `${field} must be a string`, { field })
  }
  const bytes = Buffer.byteLength(value, 'utf8')
  if (bytes > maxBytes) {
    throw remoteError(
      'nodeAdmin/too-large',
      `${field} is ${bytes} bytes, over the ${maxBytes} byte limit`,
      { field, bytes, maxBytes },
    )
  }
  return value
}

/** Validate one count argument, clamping the upper end to `max`. */
function requireCount(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw remoteError('nodeAdmin/invalid-arguments', `${field} must be an integer`, { field })
  }
  if (value < min) {
    throw remoteError('nodeAdmin/invalid-arguments', `${field} must be at least ${min}`, { field, min })
  }
  return Math.min(value, max)
}

/**
 * Turn a filesystem errno into a documented `nodeAdmin/*` refusal.
 *
 * Two reasons this exists rather than letting the error propagate:
 *
 * 1. **A raw errno is not an answer.** Without the mapping, `rm` on a missing
 *    skill escaped as `gateway/internal` — a code that tells the caller nothing
 *    about what to fix, even though `nodeAdmin/not-found` was already part of the
 *    documented vocabulary.
 * 2. **The OS message carries the absolute path.** `ENOENT: no such file or
 *    directory, lstat 'C:\Users\…'` would hand a remote caller this machine's
 *    directory layout, which the skill surface in particular promises never to
 *    reveal. So the message is rebuilt from the *subject* the caller already knows
 *    (their name, or the path they asked for) and never from the OS text.
 *
 * An errno that is not recognised propagates unchanged: those are genuine
 * surprises, and guessing a business code for them would be worse than an
 * `internal`.
 * @param error - whatever the filesystem call threw.
 * @param subject - how to name the thing in a message, e.g. `skill "dbs"`.
 * @throws NodeError with a documented code.
 */
function fsFailure(error: unknown, subject: string): never {
  switch ((error as NodeJS.ErrnoException).code) {
    case 'ENOENT':
      throw remoteError('nodeAdmin/not-found', `${subject} does not exist`, { reason: 'not-found' })
    case 'EEXIST':
      throw remoteError('nodeAdmin/already-exists', `${subject} already exists`, { reason: 'already-exists' })
    case 'EACCES':
    case 'EPERM':
      throw remoteError('nodeAdmin/path-denied', `${subject} is refused by the operating system`, {
        reason: 'os-denied',
      })
    case 'ENOTEMPTY':
      throw remoteError('nodeAdmin/invalid-arguments', `${subject} is a directory that is not empty`, {
        reason: 'not-empty',
      })
    case 'EISDIR':
      throw remoteError('nodeAdmin/invalid-arguments', `${subject} is a directory, not a file`, {
        reason: 'is-directory',
      })
    case 'ENOTDIR':
      throw remoteError('nodeAdmin/invalid-arguments', `${subject} is not a directory`, { reason: 'not-directory' })
    case 'ENAMETOOLONG':
    case 'EINVAL':
      throw remoteError('nodeAdmin/invalid-name', `${subject} is not a usable name on this filesystem`, {
        reason: 'invalid-name',
      })
    default:
      throw error
  }
}

/** Validate a skill name into a single safe path segment.
 *
 * This is the whole reason skill management is not a general file writer: the
 * caller supplies a *name*, and any name that could denote a path is rejected.
 */
export function requireSkillName(value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw remoteError('nodeAdmin/invalid-name', 'name must be a non-empty string', {})
  }
  if (value.length > 64) {
    throw remoteError('nodeAdmin/invalid-name', 'name must be at most 64 characters', { length: value.length })
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value) || value === '.' || value === '..') {
    throw remoteError(
      'nodeAdmin/invalid-name',
      'name must start with a letter or digit and contain only letters, digits, dot, underscore, or hyphen',
      {},
    )
  }
  return value
}

/** Whether a path exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
