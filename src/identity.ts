/**
 * Stable node identity (`nodeId`) generation and persistence.
 *
 * ## Where identity lives, and why
 *
 * The spec (§5.8) deliberately left the location open and asked for a public
 * DSH storage or settings provider if one fits. DSH does ship a public storage
 * facility (`ctx.storage.domain` from `@deepseek-ai/dsh-storage-domain`), but it
 * was rejected here for one decisive reason: it is *composition-dependent*. A
 * domain can only be opened when the deployment mounted `storage-domain` **and**
 * configured a `backend` route for that domain name, and it may be absent in
 * headless, SDK, or minimal test compositions.
 *
 * An identity that changes with the composition is exactly the failure the spec
 * forbids ("不要把身份随机生成在内存中"): the Coordinator would see one machine
 * as two nodes. So identity is a plain JSON file under the harness home, which
 * every profile and every test composition can read and write identically. The
 * location follows the convention already used on this machine by the sibling
 * plugin `dsh-drawio` (`<dshHome>/storages/<plugin-id>/`).
 *
 * `$DSH_HOME` is honoured with the same precedence as the official
 * `@deepseek-ai/dsh-home-paths` helper: an explicit override, then `$DSH_HOME`,
 * then `~/.dsh`. The token is never written here.
 *
 * @module dsh-node/identity
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { NodeError } from './errors.js'

/** Directory name used for every DSH user-data blob on this machine. */
export const STORAGES_DIR_NAME = 'storages'

/** Owning plugin id; also the storage directory name. */
export const NODE_DATA_DIR_NAME = 'dsh-node'

/** Identity file name inside {@link NODE_DATA_DIR_NAME}. */
export const IDENTITY_FILE_NAME = 'identity.json'

/** The persisted identity document. */
export interface NodeIdentity {
  /** Stable node identity. The only field the Coordinator should trust. */
  readonly nodeId: string
  /** ISO timestamp of first generation, for operator diagnostics. */
  readonly createdAt: string
}

/**
 * Resolve the DeepSeek Harness home.
 *
 * Mirrors `@deepseek-ai/dsh-home-paths#resolveDshHome`: `$DSH_HOME` when set and
 * non-blank, otherwise `~/.dsh`. A blank override is treated as unset so it can
 * never resolve the home to the current working directory.
 * @param env - environment mapping.
 * @returns the absolute harness home.
 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['DSH_HOME']
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv.trim())
  return join(homedir(), '.dsh')
}

/**
 * Resolve the directory holding this node's persistent data.
 * @param env - environment mapping.
 * @returns `<dshHome>/storages/dsh-node`.
 */
export function resolveIdentityDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDshHome(env), STORAGES_DIR_NAME, NODE_DATA_DIR_NAME)
}

/**
 * Resolve the identity file location.
 * @param env - environment mapping.
 * @param override - explicit absolute path from configuration.
 * @returns the absolute identity file path.
 * @throws NodeError `node/config-invalid` when the override is not absolute.
 */
export function resolveIdentityFile(env: NodeJS.ProcessEnv = process.env, override?: string): string {
  if (override === undefined || override === '') return join(resolveIdentityDir(env), IDENTITY_FILE_NAME)
  if (!isAbsolute(override)) {
    throw new NodeError('node/config-invalid', 'identityFile must be an absolute path', {})
  }
  return override
}

/**
 * Mint a new node id.
 *
 * `node-` plus 128 random bits, hex encoded. Not a UUID on purpose: the id is
 * an opaque handle the Coordinator binds a token to, and a flat, fixed-width,
 * URL-safe token avoids any downstream surprise about dashes or braces.
 * @param bytes - random source, injectable for tests.
 * @returns the new id.
 */
export function generateNodeId(bytes: (size: number) => Buffer = randomBytes): string {
  return `node-${bytes(16).toString('hex')}`
}

/** Options for {@link loadOrCreateIdentity}. */
export interface LoadIdentityOptions {
  /** Absolute identity file path. */
  readonly file: string
  /** Operator-supplied id; wins over any persisted value and is not persisted. */
  readonly configuredNodeId?: string | undefined
  /** Wall-clock source, injectable for tests. */
  readonly now?: () => Date
  /** Random source, injectable for tests. */
  readonly generate?: () => string
}

/**
 * Load the persisted identity, generating and persisting one on first start.
 *
 * Creation uses `wx` (exclusive create): exactly one process can win the race,
 * so two DSH instances starting together cannot mint two identities. A corrupt
 * file is moved aside rather than silently repaired, so an operator can see what
 * happened.
 * @param options - file location, overrides, and injectable sources.
 * @returns the stable identity.
 * @throws NodeError `node/config-invalid` when the file cannot be used or written.
 */
export async function loadOrCreateIdentity(options: LoadIdentityOptions): Promise<NodeIdentity> {
  const configured = options.configuredNodeId
  if (configured !== undefined && configured !== '') return { nodeId: configured, createdAt: isoNow(options) }

  const existing = await readIdentity(options.file)
  if (existing !== undefined) return existing

  const identity: NodeIdentity = { nodeId: (options.generate ?? generateNodeId)(), createdAt: isoNow(options) }
  const created = await createIdentity(options.file, identity)
  if (created !== undefined) return created

  // Another process won the `wx` race between our read and our create; its
  // identity is the authoritative one.
  const raced = await readIdentity(options.file)
  if (raced !== undefined) return raced
  throw new NodeError('node/config-invalid', 'identity file could not be created or read', { file: options.file })
}

/** Read and validate an identity file; `undefined` when absent or unusable. */
async function readIdentity(file: string): Promise<NodeIdentity | undefined> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new NodeError('node/config-invalid', 'identity file could not be read', { file, reason: errnoCode(error) })
  }

  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>
      const nodeId = record['nodeId']
      if (typeof nodeId === 'string' && nodeId !== '') {
        const createdAt = record['createdAt']
        return { nodeId, createdAt: typeof createdAt === 'string' ? createdAt : '' }
      }
    }
  } catch {
    // Fall through to quarantine.
  }

  // Unusable: preserve the bytes under a new name instead of overwriting them,
  // then mint a fresh identity. Losing the old id is unavoidable, but losing the
  // evidence is not.
  const quarantine = `${file}.corrupt-${Date.now()}`
  try {
    await rename(file, quarantine)
  } catch {
    // A rename failure must not block startup; the create below will report a
    // real error if the path is genuinely unusable.
  }
  return undefined
}

/** Exclusively create the identity file; `undefined` when another process won. */
async function createIdentity(file: string, identity: NodeIdentity): Promise<NodeIdentity | undefined> {
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, `${JSON.stringify(identity, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    return identity
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined
    throw new NodeError('node/config-invalid', 'identity file could not be written', { file, reason: errnoCode(error) })
  }
}

function isoNow(options: LoadIdentityOptions): string {
  return (options.now?.() ?? new Date()).toISOString()
}

function errnoCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code
  return typeof code === 'string' ? code : 'unknown'
}
