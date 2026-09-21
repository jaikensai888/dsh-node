/**
 * The node's own configuration file: the layer the status panel writes to.
 *
 * Why a separate file instead of the profile's `cordis.patch.yml`:
 *
 * - that file is the operator's own document, with comments and layout they wrote.
 *   A YAML round-trip through this plugin would destroy both, and a plugin that
 *   silently reformats its host's configuration is not a plugin anyone should trust;
 * - this file is additive and idempotent: absent means "nothing configured here", and
 *   writing it never has to reason about what else lives in the file.
 *
 * **It holds a credential.** A node token grants full remote access to this machine
 * through the Coordinator, so: the file is written atomically (a torn write would be a
 * node that cannot start), it is created with the tightest mode the platform honours,
 * and nothing in this module ever logs or returns the token.
 *
 * @module dsh-node/config-file
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { resolveDshHome } from './identity.js'

/** File name inside `<DSH_HOME>/storages/dsh-node/`. */
export const CONFIG_FILE_NAME = 'config.json'

/** Schema version of the stored document, so a future change can migrate. */
export const CONFIG_FILE_VERSION = 1

/** The fields the panel may persist. Everything else stays file-configured. */
export interface StoredNodeConfig {
  /** Coordinator endpoint, `ws://` or `wss://`, validated by the host before it lands here. */
  readonly coordinatorUrl?: string
  /** Bearer credential. Never echoed back by any API. */
  readonly token?: string
  /** Display metadata; never authentication material. */
  readonly nodeName?: string
  /** Display metadata; never authentication material. */
  readonly role?: string
  /** ISO timestamp of the last write, for humans. */
  readonly updatedAt?: string
}

/** The outcome of reading the file: usable config, or the reason there is none. */
export interface ConfigFileRead {
  /** Absolute path, reported so an operator can find (and chmod) it. */
  readonly file: string
  /** Present when the file held a usable document with at least one field. */
  readonly config?: StoredNodeConfig
  /** Set when the file exists but could not be used. Absent means "no file, no problem". */
  readonly error?: string
}

/**
 * Where the file lives.
 *
 * Deliberately the same directory as the node's identity file (`<DSH_HOME>/storages/
 * dsh-node`): one directory to back up, one directory to protect.
 * @param env - environment mapping, injectable for tests.
 * @returns the absolute path.
 */
export function resolveConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDshHome(env), 'storages', 'dsh-node', CONFIG_FILE_NAME)
}

/** Keep only the string fields this module stores, dropping anything else. */
function pickStored(value: unknown): StoredNodeConfig {
  if (typeof value !== 'object' || value === null) return {}
  const record = value as Record<string, unknown>
  const text = (field: string): string | undefined => {
    const raw = record[field]
    return typeof raw === 'string' && raw !== '' ? raw : undefined
  }
  const coordinatorUrl = text('coordinatorUrl')
  const token = text('token')
  const nodeName = text('nodeName')
  const role = text('role')
  const updatedAt = text('updatedAt')
  return {
    ...(coordinatorUrl === undefined ? {} : { coordinatorUrl }),
    ...(token === undefined ? {} : { token }),
    ...(nodeName === undefined ? {} : { nodeName }),
    ...(role === undefined ? {} : { role }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
  }
}

/**
 * Read the stored configuration.
 *
 * A missing file is the normal case and is **not** an error. A corrupt or
 * unreadable file is reported but never thrown: the node must still start on the
 * configuration it was given by the profile, and an operator needs to see why the
 * panel's settings are being ignored.
 * @param file - absolute path from {@link resolveConfigFile}.
 * @returns the read outcome.
 */
export async function readConfigFile(file: string): Promise<ConfigFileRead> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { file }
    return { file, error: `could not read ${file}: ${(error as Error).message}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { file, error: `${file} is not valid JSON; ignoring it` }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { file, error: `${file} must contain a JSON object; ignoring it` }
  }
  const version = (parsed as { version?: unknown }).version
  if (version !== undefined && version !== CONFIG_FILE_VERSION) {
    return { file, error: `${file} has version ${String(version)}, expected ${String(CONFIG_FILE_VERSION)}; ignoring it` }
  }
  const config = pickStored(parsed)
  return Object.keys(config).length === 0 ? { file, error: `${file} holds no usable field; ignoring it` } : { file, config }
}

/**
 * Write the stored configuration atomically.
 *
 * Temp file plus rename: a reader either sees the previous document or the new one,
 * never a half-written token. The temp file is removed if the rename fails, so a
 * failed save cannot leave a stray credential on disk.
 * @param file - absolute path from {@link resolveConfigFile}.
 * @param next - the document to store.
 * @returns when the document is in place.
 */
export async function writeConfigFile(file: string, next: StoredNodeConfig): Promise<void> {
  const payload = { version: CONFIG_FILE_VERSION, ...pickStored(next) }
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  // `mode` is honoured on POSIX and ignored on Windows; passing it is still right,
  // and the catch below covers platforms that reject the option outright.
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/**
 * Merge the stored layer over the profile's configuration.
 *
 * The stored document wins per field, which is what makes the panel's "save" mean
 * something: `resolveNodeConfig` already reads an explicit bootstrap value before the
 * environment, so merging the file *into* the bootstrap puts the panel above both the
 * profile and `DSH_NODE_TOKEN`. The reverse order would produce the worst possible
 * behaviour — a save that appears to succeed and changes nothing.
 *
 * The token is written to `auth.token`, **not** to a top-level `token`: that is where
 * `resolveNodeConfig` looks for it, and a top-level copy would be silently ignored —
 * a saved credential that never reaches the handshake is the one failure this whole
 * feature exists to prevent.
 * @param raw - whatever the Loader passed as `apply`'s second argument.
 * @param stored - the document read from {@link readConfigFile}.
 * @returns the bootstrap to resolve.
 */
export function mergeNodeConfig(raw: unknown, stored: StoredNodeConfig | undefined): Record<string, unknown> {
  const base: Record<string, unknown> = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? { ...(raw as Record<string, unknown>) }
    : {}
  if (stored === undefined) return base

  const coordinatorUrl = nonEmpty(stored.coordinatorUrl)
  if (coordinatorUrl !== undefined) base['coordinatorUrl'] = coordinatorUrl

  const token = nonEmpty(stored.token)
  if (token !== undefined) {
    const auth: Record<string, unknown> = typeof base['auth'] === 'object' && base['auth'] !== null
      ? { ...(base['auth'] as Record<string, unknown>) }
      : {}
    auth['token'] = token
    base['auth'] = auth
  }

  const nodeName = nonEmpty(stored.nodeName)
  if (nodeName !== undefined) base['nodeName'] = nodeName

  const role = nonEmpty(stored.role)
  if (role !== undefined) base['role'] = role

  return base
}

/** A trimmed non-empty string, or `undefined`. */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** A secret-free description of a stored document, for logs and diagnostics. */
export function describeStoredConfig(stored: StoredNodeConfig | undefined): Record<string, unknown> {
  if (stored === undefined) return { present: false }
  return {
    present: true,
    coordinatorUrl: stored.coordinatorUrl ?? null,
    tokenSet: typeof stored.token === 'string' && stored.token !== '',
    nodeName: stored.nodeName ?? null,
    role: stored.role ?? null,
    updatedAt: stored.updatedAt ?? null,
  }
}
