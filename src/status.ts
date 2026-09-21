/**
 * Redaction, logging, and the secret-free status snapshot.
 *
 * Two security rules are enforced *here*, in one place, rather than by asking
 * every call site to remember them:
 *
 * 1. A configured secret is never emitted. Every log field is passed through
 *    {@link scrubValue}, so the token cannot reach the log even by accident.
 * 2. A Coordinator URL is never emitted whole. Only `scheme://host:port` is
 *    kept, so a token smuggled into a path, query, or fragment — or any future
 *    routing parameter — cannot leak through status or logs.
 *
 * @module dsh-node/status
 */

import type { DshNodeStatus, NodeState } from './protocol.js'

/** The text substituted for any redacted value. */
export const REDACTED = '«redacted»'

/** Field names whose values are treated as credentials regardless of content. */
const SECRET_FIELD_NAMES: ReadonlySet<string> = new Set([
  'token',
  'accesstoken',
  'access_token',
  'authtoken',
  'authorization',
  'apikey',
  'api_key',
  'secret',
  'password',
  'passwd',
  'credential',
  'credentials',
])

/** How deep {@link scrubValue} walks before it stops trusting the input. */
const MAX_SCRUB_DEPTH = 6

/** One severity this plugin logs at. */
export type NodeLogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Structured, already-redacted log fields. */
export type NodeLogFields = Readonly<Record<string, unknown>>

/** The sink this plugin writes to; injectable so tests can capture output. */
export type NodeLogSink = (level: NodeLogLevel, message: string, fields: NodeLogFields) => void

/** Redacting logger used by every module in this plugin. */
export interface NodeLogger {
  debug(message: string, fields?: NodeLogFields): void
  info(message: string, fields?: NodeLogFields): void
  warn(message: string, fields?: NodeLogFields): void
  error(message: string, fields?: NodeLogFields): void
}

/** Options for {@link createNodeLogger}. */
export interface NodeLoggerOptions {
  /** Literal secret values that must never appear in output. */
  readonly secrets?: readonly string[]
  /** Destination; defaults to `console`. */
  readonly sink?: NodeLogSink
}

/**
 * Strip a URL down to `scheme://host:port`.
 *
 * Everything else — userinfo, path, query, fragment — is discarded, because any
 * of them can carry a credential. An unparseable value yields `undefined`
 * rather than the raw string.
 * @param value - URL to reduce.
 * @returns the origin, or `undefined` when the value is not a usable URL.
 */
export function redactUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined
  try {
    const url = new URL(value)
    if (url.host === '') return undefined
    return `${url.protocol}//${url.host}`
  } catch {
    return undefined
  }
}

/**
 * Replace every occurrence of every secret with {@link REDACTED}.
 * @param text - arbitrary text.
 * @param secrets - literal values to remove.
 * @returns text that contains none of the secrets.
 */
export function scrubText(text: string, secrets: readonly string[]): string {
  let result = text
  for (const secret of secrets) {
    if (secret === '') continue
    result = result.split(secret).join(REDACTED)
  }
  return result
}

/**
 * Deep-scrub an arbitrary value for logging.
 *
 * Three independent defences: fields whose *name* looks like a credential, any
 * literal secret appearing inside a string, and a depth bound so a cyclic or
 * adversarial object cannot lock up the logger.
 * @param value - value to scrub.
 * @param secrets - literal secret values.
 * @param depth - current recursion depth.
 * @returns a JSON-safe, secret-free projection.
 */
export function scrubValue(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (typeof value === 'string') return scrubText(value, secrets)
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'undefined') return undefined
  if (typeof value === 'function' || typeof value === 'symbol') return typeof value
  if (depth >= MAX_SCRUB_DEPTH) return '«depth-limit»'
  if (value instanceof Error) {
    return { name: value.name, message: scrubText(value.message, secrets) }
  }
  if (Array.isArray(value)) {
    return value.map(item => scrubValue(item, secrets, depth + 1))
  }
  if (value instanceof Map) {
    return [...value.entries()].map(([key, item]) => [
      scrubValue(key, secrets, depth + 1),
      scrubValue(item, secrets, depth + 1),
    ])
  }
  if (value instanceof Set) {
    return [...value.values()].map(item => scrubValue(item, secrets, depth + 1))
  }
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>
    const output: Record<string, unknown> = {}
    for (const key of Object.keys(source)) {
      if (SECRET_FIELD_NAMES.has(key.toLowerCase())) {
        output[key] = REDACTED
        continue
      }
      output[key] = scrubValue(source[key], secrets, depth + 1)
    }
    return output
  }
  return typeof value
}

const LEVEL_ORDER: Readonly<Record<NodeLogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

/** Minimum level emitted; `DSH_NODE_LOG_LEVEL` raises it when set. */
function resolveMinLevel(env: NodeJS.ProcessEnv): NodeLogLevel {
  const configured = env['DSH_NODE_LOG_LEVEL']
  if (configured === 'debug' || configured === 'info' || configured === 'warn' || configured === 'error') {
    return configured
  }
  return 'info'
}

/**
 * The four severity methods of a Cordis logger, structurally.
 *
 * Cordis types these as `(format: any, ...param: any[]) => void`, so this plugin
 * never imports the package to reach them.
 */
export interface CordisLoggerLike {
  debug?: (format: unknown, ...param: unknown[]) => void
  info?: (format: unknown, ...param: unknown[]) => void
  warn?: (format: unknown, ...param: unknown[]) => void
  error?: (format: unknown, ...param: unknown[]) => void
}

/**
 * Neutralize printf placeholders in a message.
 *
 * Cordis renders a log call with `format.replace(/%([a-zA-Z%])/g, …)`, and every
 * recognized placeholder calls `args.shift()` — so a `%s` or `%o` appearing in a
 * message *consumes the structured fields meant to follow it*, and `%d` would
 * even render them as `NaN`. Messages here can carry peer-supplied text (a
 * `close` reason) or a Remote method's error message, so this is a real way for
 * a log line to lie.
 *
 * Doubling every `%` makes the formatter emit it literally and consume nothing.
 * @param text - raw message.
 * @returns the message with `%` escaped for `String.prototype.replace` semantics.
 */
export function escapeLogFormat(text: string): string {
  return text.replace(/%/g, '%%')
}

/**
 * Wrap a Cordis logger as a {@link NodeLogSink}.
 *
 * This is what makes the node visible at all under DSH: `console.log` output
 * does not reach the harness log file, while `ctx.logger` records do (DSH
 * registers an exporter that writes `%APPDATA%\DSH Desktop\logs\dsh-<date>.log`).
 * A node whose only output is `console.log` is invisible in exactly the
 * situation where an operator needs it.
 *
 * Fields are handed over as `%o` so Cordis does the JSON rendering, after the
 * message's own placeholders have been escaped by {@link escapeLogFormat}.
 * @param logger - a Cordis `ctx.logger`, or anything else.
 * @returns a sink, or `undefined` when the value is not a usable logger.
 */
export function cordisLogSink(logger: unknown): NodeLogSink | undefined {
  // A Cordis logger is *callable* — `ctx.logger('subsystem')` returns a named
  // facade — so it is a function, not a plain object. Guarding on `object`
  // alone silently rejects the real thing and falls back to `console`.
  const isObjectLike = (typeof logger === 'object' && logger !== null) || typeof logger === 'function'
  if (!isObjectLike) return undefined
  const candidate = logger as CordisLoggerLike
  if (typeof candidate.info !== 'function') return undefined
  return (level, message, fields) => {
    const write = candidate[level]
    if (typeof write !== 'function') return
    const escaped = escapeLogFormat(message)
    if (Object.keys(fields).length === 0) write.call(candidate, escaped)
    else write.call(candidate, `${escaped} %o`, fields)
  }
}

/**
 * Build a logger that cannot print a configured secret.
 *
 * The redaction happens inside the logger, not at the call sites, so a future
 * field added carelessly is still safe.
 * @param options - secrets, sink, and minimum level.
 * @returns the redacting logger.
 */
export function createNodeLogger(options: NodeLoggerOptions & { readonly env?: NodeJS.ProcessEnv } = {}): NodeLogger {
  const secrets = (options.secrets ?? []).filter(secret => secret !== '')
  const minLevel = resolveMinLevel(options.env ?? process.env)
  const sink = options.sink ?? defaultSink

  const emit = (level: NodeLogLevel, message: string, fields: NodeLogFields = {}): void => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return
    const scrubbed = scrubValue(fields, secrets)
    sink(level, scrubText(message, secrets), (scrubbed ?? {}) as NodeLogFields)
  }

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  }
}

/** Default sink: one prefixed console line per record. */
const defaultSink: NodeLogSink = (level, message, fields) => {
  const line = `[dsh-node] ${message}`
  const write = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  if (Object.keys(fields).length === 0) write(line)
  else write(line, fields)
}

/** Everything {@link statusSnapshot} needs. */
export interface NodeStatusInput {
  readonly state: NodeState
  readonly nodeId: string
  readonly nodeName?: string | undefined
  readonly role?: string | undefined
  /** Raw Coordinator URL; reduced to its origin here. */
  readonly coordinatorUrl?: string | undefined
  readonly connectionId?: string | undefined
  readonly reconnectAttempt: number
  readonly lastConnectedAt?: string | undefined
  readonly lastError?: { readonly code: string; readonly message: string; readonly at: string } | undefined
  readonly inFlightRequests: number
  readonly activeStreams: number
  /**
   * Literal secrets that must not survive into the snapshot.
   *
   * A snapshot is handed to a caller verbatim, so the scrubbing has to happen
   * here rather than being delegated to a log sink. An error message can
   * originate inside a Remote method — outside this plugin's control — and may
   * echo the credential.
   */
  readonly secrets?: readonly string[]
}

/**
 * Build the redacted status snapshot.
 *
 * `exactOptionalPropertyTypes` is on, so absent optionals are omitted rather
 * than set to `undefined` — the snapshot stays clean for JSON serialization.
 * @param input - live values, including the secrets to scrub.
 * @returns the snapshot, which provably contains no credential.
 */
export function statusSnapshot(input: NodeStatusInput): DshNodeStatus {
  const origin = redactUrl(input.coordinatorUrl)
  const nodeName = input.nodeName
  const role = input.role
  const secrets = input.secrets ?? []
  const lastError = input.lastError
  return {
    state: input.state,
    nodeId: input.nodeId,
    reconnectAttempt: input.reconnectAttempt,
    inFlightRequests: input.inFlightRequests,
    activeStreams: input.activeStreams,
    ...(origin === undefined ? {} : { coordinatorOrigin: origin }),
    ...(nodeName === undefined || nodeName === '' ? {} : { nodeName }),
    ...(role === undefined || role === '' ? {} : { role }),
    ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
    ...(input.lastConnectedAt === undefined ? {} : { lastConnectedAt: input.lastConnectedAt }),
    ...(lastError === undefined
      ? {}
      : { lastError: { code: lastError.code, message: scrubText(lastError.message, secrets), at: lastError.at } }),
  }
}
