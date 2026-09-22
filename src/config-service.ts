/**
 * The configuration surface the status panel writes through.
 *
 * Three rules shape this module, and each one exists because the alternative is a
 * failure nobody can see:
 *
 * 1. **One validator.** A save is validated by {@link resolveNodeConfig} — the very
 *    function the boot path uses — over the merged document. A second, "lighter"
 *    validator for the panel would eventually disagree with the real one, and the
 *    disagreement would show up as a node that accepts a setting it cannot use.
 * 2. **No half-applied state.** The file is written first and the node is rebuilt
 *    second. A save either lands in both places or reports that it landed in one,
 *    and the response says which. Silently keeping the old connection while the
 *    file says otherwise is the one outcome that must not happen.
 * 3. **The token never travels out.** {@link NodeConfigService.read} reports
 *    `tokenSet`, never the value. The panel is served over the same origin as the
 *    DSH session, but the token is the credential for a remote-access channel, so it
 *    is write-only from the browser's point of view.
 *
 * @module dsh-node/config-service
 */

import {
  COORDINATOR_URL_ENV,
  TOKEN_ENV,
  resolveNodeConfig,
  type DshNodeRuntimeConfig,
} from './config.js'
import {
  mergeNodeConfig,
  readConfigFile,
  writeConfigFile,
  type ConfigFileRead,
  type ConnectionIntent,
  type StoredNodeConfig,
} from './config-file.js'
import { HttpFailure, type NodeConfigSurface, type NodeConfigView } from './http-api.js'

/** The effective configuration, as the live host holds it. */
export type EffectiveConfig = Pick<DshNodeRuntimeConfig, 'coordinatorUrl' | 'token' | 'nodeName' | 'role'>

/** What the service needs from its host. */
export interface NodeConfigServiceOptions {
  /** Absolute path of the file a save writes, from `resolveConfigFile`. */
  readonly file: string
  /** The raw profile configuration, read per request so a live patch is visible. */
  readonly profileConfig: () => unknown
  /** The live host's resolution. Read per request, never cached. */
  readonly effective: () => EffectiveConfig
  /** The node's stable id, for the operator to register on the Coordinator side. */
  readonly nodeId: () => string
  /** Rebuild and restart the node on the stored document. Rejects on failure. */
  readonly apply: (stored: StoredNodeConfig) => Promise<void>
  /** Environment mapping; injectable for tests. */
  readonly env?: NodeJS.ProcessEnv
  /** Non-fatal observation sink. Never receives a token. */
  readonly warn?: (message: string, details: Record<string, unknown>) => void
  /** Clock, for the `updatedAt` stamp; injectable for tests. */
  readonly now?: () => number
}

/** A trimmed non-empty string, or `undefined`. Mirrors the config resolver's rule. */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Read one submitted field.
 *
 * The three cases are deliberately distinct, because collapsing them is how a
 * panel silently erases a credential:
 *
 * - **absent** — the operator did not touch the field; keep whatever is stored;
 * - **`null`** — an explicit clear, for a token that should no longer exist;
 * - **`''`** — treated as absent for credentials (a browser submits empty strings
 *   for untouched inputs) and as clear elsewhere.
 *
 * @param input - the submitted body.
 * @param field - the field name.
 * @param emptyMeansClear - whether `''` clears the field rather than keeping it.
 * @returns the intent.
 */
export function readSubmission(
  input: Record<string, unknown>,
  field: string,
  emptyMeansClear: boolean,
): { readonly kind: 'keep' } | { readonly kind: 'clear' } | { readonly kind: 'set'; readonly value: string } {
  if (!Object.hasOwn(input, field)) return { kind: 'keep' }
  const raw = input[field]
  if (raw === null) return { kind: 'clear' }
  if (typeof raw !== 'string') {
    throw new HttpFailure(400, {
      code: 'invalid-arguments',
      message: `${field} must be a string or null`,
      details: { field, received: typeof raw },
    })
  }
  const trimmed = raw.trim()
  if (trimmed === '') return emptyMeansClear ? { kind: 'clear' } : { kind: 'keep' }
  return { kind: 'set', value: trimmed }
}

/**
 * Fold a submission into the stored document.
 *
 * Pure, so the merge rules can be tested without touching a file or a host.
 * @param stored - the document currently on disk, if any.
 * @param input - the submitted body.
 * @returns the document a save would write, without `updatedAt`.
 */
export function foldSubmission(stored: StoredNodeConfig | undefined, input: Record<string, unknown>): StoredNodeConfig {
  const next: Record<string, string> = {}
  const seed = (field: keyof StoredNodeConfig): void => {
    const value = stored?.[field]
    if (typeof value === 'string' && value !== '') next[field] = value
  }
  seed('coordinatorUrl')
  seed('token')
  seed('nodeName')
  seed('role')
  if (stored?.connectionIntent === 'paused' || stored?.connectionIntent === 'active') {
    next['connectionIntent'] = stored.connectionIntent
  }

  const apply = (field: string, emptyMeansClear: boolean): void => {
    const intent = readSubmission(input, field, emptyMeansClear)
    if (intent.kind === 'keep') return
    if (intent.kind === 'clear') {
      delete next[field]
      return
    }
    next[field] = intent.value
  }

  // The token is the only field where it, and only it, is clear-proof: an empty
  // box is the browser's way of saying "unchanged", and clearing it must be asked
  // for explicitly with `null`.
  apply('coordinatorUrl', false)
  apply('token', false)
  apply('nodeName', true)
  apply('role', true)

  return next as StoredNodeConfig
}

/**
 * The panel's read/write surface.
 *
 * Holds the last document it read or wrote, so {@link read} can answer
 * synchronously (the route is synchronous) while {@link write} stays the only
 * thing that touches the disk.
 */
export class NodeConfigService implements NodeConfigSurface {
  private readonly options: NodeConfigServiceOptions
  private stored: StoredNodeConfig | undefined
  private fileError: string | undefined
  /** Serialises writes: two concurrent saves must not interleave a reboot. */
  private queue: Promise<unknown> = Promise.resolve()

  /**
   * @param options - file, host accessors, and the reboot hook.
   */
  constructor(options: NodeConfigServiceOptions) {
    this.options = options
  }

  /** Record the outcome of the boot-time read, so the panel can show a bad file. */
  seed(read: ConfigFileRead): void {
    this.stored = read.config
    this.fileError = read.error
  }

  /** Where the file is, reported so an operator can find and protect it. */
  get file(): string {
    return this.options.file
  }

  /** The stored document as last read or written. */
  get document(): StoredNodeConfig | undefined {
    return this.stored
  }

  private env(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env
  }

  /** Which layer supplied a field: the panel's file, the profile, or the environment. */
  private sourceOf(field: 'coordinatorUrl' | 'token'): 'panel' | 'profile' | 'environment' | 'none' {
    if (nonEmpty(this.stored?.[field]) !== undefined) return 'panel'
    const profile = this.options.profileConfig()
    if (typeof profile === 'object' && profile !== null) {
      const raw = (profile as Record<string, unknown>)[field]
      // The token lives under `auth`, exactly as the Loader schema declares it.
      const fromProfile = field === 'token'
        ? nonEmpty((raw as { token?: unknown } | undefined)?.token)
        : nonEmpty(raw)
      if (fromProfile !== undefined) return 'profile'
    }
    const fromEnv = nonEmpty(this.env()[field === 'token' ? TOKEN_ENV : COORDINATOR_URL_ENV])
    return fromEnv === undefined ? 'none' : 'environment'
  }

  /**
   * The current view.
   *
   * Values are the **effective** ones — what the node is actually using — so the
   * panel and the status dot can never disagree. `sources` says where each came
   * from, because "I saved this and nothing changed" is the expected confusion when
   * a profile or an environment variable is the real source.
   */
  read(): NodeConfigView {
    const effective = this.options.effective()
    return {
      ...(effective.coordinatorUrl === undefined ? {} : { coordinatorUrl: effective.coordinatorUrl }),
      tokenSet: effective.token !== undefined,
      ...(effective.nodeName === undefined ? {} : { nodeName: effective.nodeName }),
      ...(effective.role === undefined ? {} : { role: effective.role }),
      connectionIntent: this.stored?.connectionIntent ?? 'active',
      nodeId: this.options.nodeId(),
      configFile: this.options.file,
      ...(this.fileError === undefined ? {} : { configFileError: this.fileError }),
      sources: {
        coordinatorUrl: this.sourceOf('coordinatorUrl'),
        token: this.sourceOf('token'),
      },
    }
  }

  /**
   * Validate, persist, and apply a submitted configuration.
   *
   * Runs on the same serial queue as every other write, so a second save waits for
   * the first reboot instead of racing it.
   * @param input - the submitted body.
   * @returns the view after the node has been rebuilt.
   */
  async write(input: Record<string, unknown>): Promise<NodeConfigView> {
    const run = this.queue.then(() => this.applySubmission(input))
    // Keep the chain alive after a rejection, or one bad save would wedge every
    // later one behind a rejected promise.
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Persist a manual connection decision without rebuilding the node.
   *
   * The connection button changes transport intent, not the resolved URL/token;
   * routing that through `write()` would unnecessarily tear down a healthy node.
   */
  async setConnectionIntent(intent: ConnectionIntent): Promise<NodeConfigView> {
    if (intent !== 'active' && intent !== 'paused') {
      throw new HttpFailure(400, {
        code: 'invalid-arguments',
        message: 'connectionIntent must be "active" or "paused"',
        details: { field: 'connectionIntent' },
      })
    }
    const run = this.queue.then(async () => {
      const saved: StoredNodeConfig = {
        ...(this.stored ?? {}),
        connectionIntent: intent,
        updatedAt: new Date(this.options.now?.() ?? Date.now()).toISOString(),
      }
      try {
        await writeConfigFile(this.options.file, saved)
      } catch (error) {
        throw new HttpFailure(500, {
          code: 'node/config-write-failed',
          message: `could not write ${this.options.file}: ${(error as Error).message}`,
          details: { file: this.options.file },
        })
      }
      this.stored = saved
      this.fileError = undefined
      this.options.warn?.('dsh-node/connection-intent-changed', {
        file: this.options.file,
        connectionIntent: intent,
      })
      return this.read()
    })
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  private async applySubmission(input: Record<string, unknown>): Promise<NodeConfigView> {
    const next = foldSubmission(this.stored, input)
    // The same merge and the same validator the boot path uses, so a document that
    // saves is exactly a document that boots.
    const resolution = resolveNodeConfig(mergeNodeConfig(this.options.profileConfig(), next), this.env())

    if (resolution.status === 'invalid') {
      throw new HttpFailure(400, {
        code: 'node/config-invalid',
        message: resolution.errors.join('; '),
        details: { errors: [...resolution.errors] },
      })
    }
    if (resolution.status === 'unconfigured') {
      // Refused rather than saved: an incomplete document would take a working node
      // offline, and the operator's intent is plainly to connect it.
      const missing: string[] = []
      if (resolution.config.coordinatorUrl === undefined) missing.push('coordinatorUrl')
      if (resolution.config.token === undefined) missing.push('token')
      throw new HttpFailure(400, {
        code: 'node/config-incomplete',
        message: `the node still has no ${missing.join(' and ')}; both a Coordinator URL and a token are required`,
        details: { missing },
      })
    }

    // Deliberately not named `document`: a host module that mentions `document.` reads
    // like browser code, and an architecture guard rightly refuses to tell the two
    // apart.
    const saved: StoredNodeConfig = { ...next, updatedAt: new Date(this.options.now?.() ?? Date.now()).toISOString() }
    try {
      await writeConfigFile(this.options.file, saved)
    } catch (error) {
      throw new HttpFailure(500, {
        code: 'node/config-write-failed',
        message: `could not write ${this.options.file}: ${(error as Error).message}`,
        details: { file: this.options.file },
      })
    }
    this.stored = saved
    this.fileError = undefined
    this.options.warn?.('dsh-node/config-saved', {
      file: this.options.file,
      // Secret-free: presence only, so the log is safe to hand to anyone.
      coordinatorUrl: saved.coordinatorUrl ?? null,
      tokenSet: nonEmpty(saved.token) !== undefined,
      nodeName: saved.nodeName ?? null,
      role: saved.role ?? null,
    })

    try {
      await this.options.apply(saved)
    } catch (error) {
      // The file *is* saved; saying otherwise would make the operator retype a
      // working configuration. The details say what actually happened.
      throw new HttpFailure(500, {
        code: 'node/reconfigure-failed',
        message: `the configuration was saved to ${this.options.file}, but the node could not be restarted: ${(error as Error).message}`,
        details: { saved: true, file: this.options.file },
      })
    }
    return this.read()
  }
}

/**
 * Read the stored document once, at boot. Exposed for the host's init step.
 * @param file - absolute path from `resolveConfigFile`.
 * @returns the read outcome.
 */
export async function loadStoredConfig(file: string): Promise<ConfigFileRead> {
  return readConfigFile(file)
}
