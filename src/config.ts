/**
 * Deployment configuration: the Loader schema, and the single authority that
 * turns raw input into a validated runtime configuration.
 *
 * ## Why the schema is deliberately permissive
 *
 * `schemastery` is non-strict: unknown keys survive validation and reach
 * `apply` (the sibling plugin `dsh-drawio` records this as GROUND-TRUTH pitfall
 * #9). It is also *strict about types*: a wrong type produces `issues`, the
 * Loader drops that plugin row, and the plugin silently disappears.
 *
 * For a network-exposed plugin, "silently gone" is the worst failure mode: the
 * operator sees a node that simply is not there. So {@link Config} declares
 * types and defaults but **no bounds**, and {@link resolveNodeConfig} is the one
 * place that decides validity. A bad value then keeps the row mounted and
 * surfaces as `node/config-invalid` plus a logged reason, which is diagnosable.
 *
 * `resolveNodeConfig` also re-derives every field from scratch, so an unknown
 * yaml key can never reach the connector.
 *
 * @module dsh-node/config
 */

import { isAbsolute } from 'node:path'
import z from 'schemastery'
import { NODE_MODES, type NodeMode } from './protocol.js'

/** Environment variable carrying the Coordinator bearer token. */
export const TOKEN_ENV = 'DSH_NODE_TOKEN'

/** Environment variable carrying the Coordinator URL, for headless deployments. */
export const COORDINATOR_URL_ENV = 'DSH_NODE_COORDINATOR_URL'

/** Environment variable overriding the identity file location. */
export const IDENTITY_FILE_ENV = 'DSH_NODE_IDENTITY_FILE'

/** Protocols a Coordinator URL may use. */
export const ALLOWED_URL_PROTOCOLS: ReadonlySet<string> = new Set(['ws:', 'wss:'])

/**
 * Query/fragment parameter names that look like credentials.
 *
 * A URL carrying one of these is rejected outright rather than ignored: the
 * security red line is that a token never travels in a URL, so a deployment
 * that tries it must fail loudly instead of appearing to work.
 */
export const SECRET_URL_PARAMS: ReadonlySet<string> = new Set([
  'token',
  'access_token',
  'accesstoken',
  'auth',
  'auth_token',
  'apikey',
  'api_key',
  'secret',
  'password',
])

/** Field bounds, each with an explicit ceiling. */
export const BOUNDS = {
  initialDelayMs: { min: 1, max: 600_000 },
  maxDelayMs: { min: 1, max: 3_600_000 },
  jitterRatio: { min: 0, max: 1 },
  stableResetMs: { min: 0, max: 3_600_000 },
  heartbeatIntervalMs: { min: 10, max: 3_600_000 },
  handshakeTimeoutMs: { min: 10, max: 600_000 },
  requestTimeoutMs: { min: 10, max: 3_600_000 },
  maxFrameBytes: { min: 1_024, max: 67_108_864 },
  maxInFlightRequests: { min: 1, max: 4_096 },
  maxStreams: { min: 1, max: 1_024 },
  maxBufferedBytesPerStream: { min: 1_024, max: 268_435_456 },
  sendStallTimeoutMs: { min: 10, max: 600_000 },
  auditCapacity: { min: 1, max: 10_000 },
} as const

/** Default values for every tunable, also used when a field is absent. */
export const DEFAULT_NODE_CONFIG = {
  mode: 'full-access' as NodeMode,
  reconnect: {
    initialDelayMs: 1_000,
    maxDelayMs: 30_000,
    jitterRatio: 0.2,
    stableResetMs: 30_000,
  },
  heartbeatIntervalMs: 20_000,
  handshakeTimeoutMs: 10_000,
  requestTimeoutMs: 120_000,
  maxFrameBytes: 4_194_304,
  maxInFlightRequests: 64,
  maxStreams: 16,
  maxBufferedBytesPerStream: 4_194_304,
  /**
   * How long a stream may wait for a slow Coordinator to drain before the node
   * terminates it with `node/backpressure`. Pausing the iterator comes first;
   * this is the bound on how long that pause may last.
   */
  sendStallTimeoutMs: 30_000,
  /**
   * Extra absolute roots the `nodeAdmin` filesystem Remotes may touch.
   *
   * Empty by default: the reachable roots are then the working directories of
   * live sessions, so "default on" means "the work area", not "the disk".
   */
  allowedRoots: [] as readonly string[],
  /** Extra absolute roots for skill bundles; the harness skill dirs are always added. */
  skillRoots: [] as readonly string[],
  /** Whether `nodeAdmin/fs*` is registered and usable. */
  adminFilesystemEnabled: true,
  /** Whether `nodeAdmin/skill*` is registered and usable. */
  adminSkillsEnabled: true,
  /** How many `nodeAdmin` operations the audit ring retains. */
  auditCapacity: 256,
} as const

/**
 * The schema the Loader validates a `cordis.patch.yml` config against.
 *
 * Types and defaults only — see the module docstring for why there are no
 * bounds and no `.required()` here.
 */
export const Config = z.object({
  coordinatorUrl: z.string().default(''),
  nodeId: z.string().default(''),
  nodeName: z.string().default(''),
  role: z.string().default(''),
  mode: z.string().default(DEFAULT_NODE_CONFIG.mode),
  auth: z.object({ token: z.string().default('') }).default({ token: '' }),
  reconnect: z
    .object({
      initialDelayMs: z.number().default(DEFAULT_NODE_CONFIG.reconnect.initialDelayMs),
      maxDelayMs: z.number().default(DEFAULT_NODE_CONFIG.reconnect.maxDelayMs),
      jitterRatio: z.number().default(DEFAULT_NODE_CONFIG.reconnect.jitterRatio),
      stableResetMs: z.number().default(DEFAULT_NODE_CONFIG.reconnect.stableResetMs),
    })
    .default({ ...DEFAULT_NODE_CONFIG.reconnect }),
  heartbeatIntervalMs: z.number().default(DEFAULT_NODE_CONFIG.heartbeatIntervalMs),
  handshakeTimeoutMs: z.number().default(DEFAULT_NODE_CONFIG.handshakeTimeoutMs),
  requestTimeoutMs: z.number().default(DEFAULT_NODE_CONFIG.requestTimeoutMs),
  maxFrameBytes: z.number().default(DEFAULT_NODE_CONFIG.maxFrameBytes),
  maxInFlightRequests: z.number().default(DEFAULT_NODE_CONFIG.maxInFlightRequests),
  maxStreams: z.number().default(DEFAULT_NODE_CONFIG.maxStreams),
  maxBufferedBytesPerStream: z.number().default(DEFAULT_NODE_CONFIG.maxBufferedBytesPerStream),
  sendStallTimeoutMs: z.number().default(DEFAULT_NODE_CONFIG.sendStallTimeoutMs),
  /** Extra absolute filesystem roots for the `nodeAdmin` Remotes. */
  allowedRoots: z.array(z.string()).default([]),
  /** Extra absolute skill roots for the `nodeAdmin` Remotes. */
  skillRoots: z.array(z.string()).default([]),
  adminFilesystemEnabled: z.boolean().default(DEFAULT_NODE_CONFIG.adminFilesystemEnabled),
  adminSkillsEnabled: z.boolean().default(DEFAULT_NODE_CONFIG.adminSkillsEnabled),
  auditCapacity: z.number().default(DEFAULT_NODE_CONFIG.auditCapacity),
  /** Override the identity file; must be an absolute path when set. */
  identityFile: z.string().default(''),
})

/**
 * The fully validated configuration the connector runs on.
 *
 * `coordinatorUrl` and `token` are absent exactly when the node is
 * `unconfigured`; every other field is always present.
 */
export interface DshNodeRuntimeConfig {
  readonly coordinatorUrl?: string
  readonly token?: string
  readonly nodeId?: string
  readonly nodeName?: string
  readonly role?: string
  readonly mode: NodeMode
  readonly reconnect: {
    readonly initialDelayMs: number
    readonly maxDelayMs: number
    readonly jitterRatio: number
    readonly stableResetMs: number
  }
  readonly heartbeatIntervalMs: number
  readonly handshakeTimeoutMs: number
  readonly requestTimeoutMs: number
  readonly maxFrameBytes: number
  readonly maxInFlightRequests: number
  /** Concurrent stream ceiling. */
  readonly maxStreams: number
  /** Pending-transport-bytes ceiling while a stream is pumping. */
  readonly maxBufferedBytesPerStream: number
  /** How long a stream may wait for a slow Coordinator before `node/backpressure`. */
  readonly sendStallTimeoutMs: number
  /** Extra absolute filesystem roots for `nodeAdmin`; sessions supply the default. */
  readonly allowedRoots: readonly string[]
  /** Extra absolute skill roots; the harness skill dirs are always included. */
  readonly skillRoots: readonly string[]
  /** Whether the `nodeAdmin` filesystem surface is usable. */
  readonly adminFilesystemEnabled: boolean
  /** Whether the `nodeAdmin` skill surface is usable. */
  readonly adminSkillsEnabled: boolean
  /** Audit ring capacity. */
  readonly auditCapacity: number
  readonly identityFile?: string
}

/** Outcome of resolving raw deployment input. */
export interface NodeConfigResolution {
  /**
   * `ok` — connect. `unconfigured` — no URL or no token; not an error, and the
   * node must not connect or schedule a reconnect.
   * `invalid` — semantically wrong; the node stays `stopped` and reports why.
   */
  readonly status: 'ok' | 'unconfigured' | 'invalid'
  /** Human-readable reasons, empty unless `status` is `invalid`. */
  readonly errors: readonly string[]
  /** Non-fatal advisories, e.g. a plaintext `ws:` endpoint. */
  readonly warnings: readonly string[]
  /** Every field that could be derived, with absent credentials left absent. */
  readonly config: DshNodeRuntimeConfig
}

/**
 * Resolve raw deployment input into a validated runtime configuration.
 *
 * Precedence per field: an explicit non-empty bootstrap value, then the
 * environment, then the default. The token is read from config or
 * {@link TOKEN_ENV} and from nowhere else — in particular never from the URL.
 *
 * Never throws: every problem becomes an entry in {@link NodeConfigResolution.errors}.
 * @param raw - whatever the Loader passed as `apply`'s second argument.
 * @param env - environment mapping, injectable for tests.
 * @returns the resolution.
 */
export function resolveNodeConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): NodeConfigResolution {
  const errors: string[] = []
  const warnings: string[] = []
  const record = isRecord(raw) ? raw : {}

  const mode = resolveMode(record['mode'], errors)
  const reconnectRaw = isRecord(record['reconnect']) ? record['reconnect'] : {}
  const initialDelayMs = resolveNumber(reconnectRaw['initialDelayMs'], DEFAULT_NODE_CONFIG.reconnect.initialDelayMs, 'reconnect.initialDelayMs', BOUNDS.initialDelayMs, errors)
  const maxDelayMs = resolveNumber(reconnectRaw['maxDelayMs'], DEFAULT_NODE_CONFIG.reconnect.maxDelayMs, 'reconnect.maxDelayMs', BOUNDS.maxDelayMs, errors)
  const jitterRatio = resolveNumber(reconnectRaw['jitterRatio'], DEFAULT_NODE_CONFIG.reconnect.jitterRatio, 'reconnect.jitterRatio', BOUNDS.jitterRatio, errors)
  const stableResetMs = resolveNumber(reconnectRaw['stableResetMs'], DEFAULT_NODE_CONFIG.reconnect.stableResetMs, 'reconnect.stableResetMs', BOUNDS.stableResetMs, errors)
  if (maxDelayMs < initialDelayMs) {
    errors.push(`reconnect.maxDelayMs (${maxDelayMs}) must be greater than or equal to reconnect.initialDelayMs (${initialDelayMs})`)
  }

  const coordinatorUrl = resolveCoordinatorUrl(record['coordinatorUrl'], env, errors, warnings)
  const token = resolveToken(record, env)
  const identityFile = resolveIdentityFile(record['identityFile'], env, errors)

  const config: DshNodeRuntimeConfig = {
    mode,
    reconnect: { initialDelayMs, maxDelayMs, jitterRatio, stableResetMs },
    heartbeatIntervalMs: resolveNumber(record['heartbeatIntervalMs'], DEFAULT_NODE_CONFIG.heartbeatIntervalMs, 'heartbeatIntervalMs', BOUNDS.heartbeatIntervalMs, errors),
    handshakeTimeoutMs: resolveNumber(record['handshakeTimeoutMs'], DEFAULT_NODE_CONFIG.handshakeTimeoutMs, 'handshakeTimeoutMs', BOUNDS.handshakeTimeoutMs, errors),
    requestTimeoutMs: resolveNumber(record['requestTimeoutMs'], DEFAULT_NODE_CONFIG.requestTimeoutMs, 'requestTimeoutMs', BOUNDS.requestTimeoutMs, errors),
    maxFrameBytes: resolveNumber(record['maxFrameBytes'], DEFAULT_NODE_CONFIG.maxFrameBytes, 'maxFrameBytes', BOUNDS.maxFrameBytes, errors),
    maxInFlightRequests: resolveNumber(record['maxInFlightRequests'], DEFAULT_NODE_CONFIG.maxInFlightRequests, 'maxInFlightRequests', BOUNDS.maxInFlightRequests, errors),
    maxStreams: resolveNumber(record['maxStreams'], DEFAULT_NODE_CONFIG.maxStreams, 'maxStreams', BOUNDS.maxStreams, errors),
    maxBufferedBytesPerStream: resolveNumber(record['maxBufferedBytesPerStream'], DEFAULT_NODE_CONFIG.maxBufferedBytesPerStream, 'maxBufferedBytesPerStream', BOUNDS.maxBufferedBytesPerStream, errors),
    sendStallTimeoutMs: resolveNumber(record['sendStallTimeoutMs'], DEFAULT_NODE_CONFIG.sendStallTimeoutMs, 'sendStallTimeoutMs', BOUNDS.sendStallTimeoutMs, errors),
    allowedRoots: resolveRoots(record['allowedRoots'], 'allowedRoots', errors),
    skillRoots: resolveRoots(record['skillRoots'], 'skillRoots', errors),
    adminFilesystemEnabled: resolveBoolean(record['adminFilesystemEnabled'], DEFAULT_NODE_CONFIG.adminFilesystemEnabled),
    adminSkillsEnabled: resolveBoolean(record['adminSkillsEnabled'], DEFAULT_NODE_CONFIG.adminSkillsEnabled),
    auditCapacity: resolveNumber(record['auditCapacity'], DEFAULT_NODE_CONFIG.auditCapacity, 'auditCapacity', BOUNDS.auditCapacity, errors),
    ...(coordinatorUrl === undefined ? {} : { coordinatorUrl }),
    ...(token === undefined ? {} : { token }),
    ...(optionalString(record['nodeId']) === undefined ? {} : { nodeId: optionalString(record['nodeId']) as string }),
    ...(optionalString(record['nodeName']) === undefined ? {} : { nodeName: optionalString(record['nodeName']) as string }),
    ...(optionalString(record['role']) === undefined ? {} : { role: optionalString(record['role']) as string }),
    ...(identityFile === undefined ? {} : { identityFile }),
  }

  if (errors.length > 0) return { status: 'invalid', errors, warnings, config }
  if (coordinatorUrl === undefined || token === undefined) return { status: 'unconfigured', errors, warnings, config }
  return { status: 'ok', errors, warnings, config }
}

/** Report whether a URL string is acceptable as a Coordinator endpoint. */
export function isAllowedCoordinatorUrl(value: string): boolean {
  try {
    return ALLOWED_URL_PROTOCOLS.has(new URL(value).protocol)
  } catch {
    return false
  }
}

function resolveMode(value: unknown, errors: string[]): NodeMode {
  if (value === undefined || value === '') return DEFAULT_NODE_CONFIG.mode
  if (typeof value !== 'string' || !(NODE_MODES as readonly string[]).includes(value)) {
    errors.push(`mode must be exactly ${JSON.stringify(DEFAULT_NODE_CONFIG.mode)}; received ${JSON.stringify(value)}`)
    return DEFAULT_NODE_CONFIG.mode
  }
  return value as NodeMode
}

/**
 * Validate the Coordinator URL.
 *
 * Rejected: a non-URL, any protocol other than `ws:`/`wss:`, embedded
 * credentials, and a query or fragment that carries a credential-shaped
 * parameter. Only the protocol, host, and port are ever reported.
 */
function resolveCoordinatorUrl(
  raw: unknown,
  env: NodeJS.ProcessEnv,
  errors: string[],
  warnings: string[],
): string | undefined {
  const configured = optionalString(raw) ?? optionalString(env[COORDINATOR_URL_ENV])
  if (configured === undefined) return undefined

  let url: URL
  try {
    url = new URL(configured)
  } catch {
    errors.push('coordinatorUrl is not a valid absolute URL')
    return undefined
  }
  if (!ALLOWED_URL_PROTOCOLS.has(url.protocol)) {
    errors.push(
      `coordinatorUrl protocol must be "ws:" or "wss:"; received ${JSON.stringify(url.protocol)} `
      + '(http:/https: are not WebSocket endpoints)',
    )
    return undefined
  }
  if (url.host === '') {
    errors.push('coordinatorUrl must include a host')
    return undefined
  }
  if (url.username !== '' || url.password !== '') {
    errors.push('coordinatorUrl must not embed a username or password; the token is sent in the hello frame instead')
    return undefined
  }
  const offending = findSecretParam(url)
  if (offending !== undefined) {
    errors.push(
      `coordinatorUrl must not carry a credential in its ${offending.where}; `
      + `remove the ${JSON.stringify(offending.name)} parameter and set ${TOKEN_ENV} instead`,
    )
    return undefined
  }
  if (url.protocol === 'ws:') {
    warnings.push('coordinatorUrl uses plaintext "ws:"; use "wss:" unless this is a trusted LAN or local development')
  }
  return configured
}

/** Locate a credential-shaped query or fragment parameter, if any. */
function findSecretParam(url: URL): { where: 'query'; name: string } | { where: 'fragment'; name: string } | undefined {
  for (const name of url.searchParams.keys()) {
    if (SECRET_URL_PARAMS.has(name.toLowerCase())) return { where: 'query', name }
  }
  const fragment = url.hash.replace(/^#/u, '')
  if (fragment !== '') {
    for (const pair of fragment.split('&')) {
      const name = (pair.split('=')[0] ?? '').toLowerCase()
      if (name !== '' && SECRET_URL_PARAMS.has(name)) return { where: 'fragment', name }
    }
  }
  return undefined
}

/** Read the token from bootstrap config or {@link TOKEN_ENV}; never from the URL. */
function resolveToken(record: Record<string, unknown>, env: NodeJS.ProcessEnv): string | undefined {
  const auth = isRecord(record['auth']) ? record['auth'] : {}
  return optionalString(auth['token']) ?? optionalString(env[TOKEN_ENV])
}

/** Resolve and validate an optional identity-file override. */
function resolveIdentityFile(raw: unknown, env: NodeJS.ProcessEnv, errors: string[]): string | undefined {
  const configured = optionalString(raw) ?? optionalString(env[IDENTITY_FILE_ENV])
  if (configured === undefined) return undefined
  if (!isAbsolute(configured)) {
    errors.push('identityFile must be an absolute path')
    return undefined
  }
  return configured
}

/** Read one bounded number, reporting out-of-range or non-numeric input. */
function resolveNumber(
  raw: unknown,
  fallback: number,
  field: string,
  bounds: { readonly min: number; readonly max: number },
  errors: string[],
): number {
  if (raw === undefined || raw === null || raw === '') return fallback
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    errors.push(`${field} must be a finite number; received ${JSON.stringify(raw)}`)
    return fallback
  }
  if (raw < bounds.min || raw > bounds.max) {
    errors.push(`${field} must be between ${bounds.min} and ${bounds.max}; received ${raw}`)
    return fallback
  }
  return raw
}

/** Read one boolean, keeping the default when the field is absent. */
function resolveBoolean(raw: unknown, fallback: boolean): boolean {
  return typeof raw === 'boolean' ? raw : fallback
}

/**
 * Read a list of absolute roots.
 *
 * A relative entry is reported rather than silently kept: the paths in this list
 * are the whole boundary of the filesystem Remotes, so an entry that does not
 * mean what the operator thinks it means must fail loudly.
 */
function resolveRoots(raw: unknown, field: string, errors: string[]): string[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    errors.push(`${field} must be a list of absolute paths`)
    return []
  }
  const roots: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      errors.push(`${field} entries must be non-empty strings`)
      continue
    }
    if (!isAbsolute(entry)) {
      errors.push(`${field} entry must be an absolute path; received ${JSON.stringify(entry)}`)
      continue
    }
    roots.push(entry)
  }
  return roots
}

/** Trimmed non-empty string, or `undefined`. */
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
