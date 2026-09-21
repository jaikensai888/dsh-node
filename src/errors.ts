/**
 * Stable transport-layer failure vocabulary for `dsh-node`.
 *
 * The spec fixes these codes (§10). They are deliberately separate from the
 * Typert Gateway codes: `node/*` describes *this node's* transport boundary,
 * while a `gateway/*` or business code (e.g. `session/not-found`) produced
 * inside a business method keeps its own identity and crosses the wire
 * unchanged.
 *
 * @module dsh-node/errors
 */

/** Every stable `node/*` code this plugin can emit. */
export const NODE_ERROR_CODES = [
  /** Configuration is absent or semantically invalid. */
  'node/config-invalid',
  /** The Coordinator rejected this node's credentials. */
  'node/auth-failed',
  /** A frame was structurally invalid or carried an unsupported protocol version. */
  'node/protocol-invalid',
  /** `hello.ok` never arrived inside `handshakeTimeoutMs`. */
  'node/handshake-timeout',
  /** The socket went away while a request was in flight. */
  'node/connection-lost',
  /** A unary request exceeded the node's local `requestTimeoutMs`. */
  'node/request-timeout',
  /** An encoded or decoded frame exceeded `maxFrameBytes`. */
  'node/frame-too-large',
  /** `maxInFlightRequests` is exhausted. */
  'node/request-limit',
  /** `maxStreams` is exhausted (reserved for Phase 2). */
  'node/stream-limit',
  /** A slow consumer forced this node to terminate a stream (reserved for Phase 2). */
  'node/backpressure',
  /** The local Typert Gateway is not usable yet. */
  'node/not-ready',
  /** The endpoint is not among the Remotes registered on this machine. */
  'node/capability-unavailable',
  /** The plugin or DSH is shutting down. */
  'node/shutdown',
] as const

/** One stable `node/*` failure category. */
export type NodeErrorCode = (typeof NODE_ERROR_CODES)[number]

/** Wire-shaped failure fields, mirroring the Gateway's own carrier failure shape. */
export interface NodeFailure {
  readonly code: string
  readonly message: string
  readonly details: Record<string, unknown>
}

const NODE_ERROR_CODE_SET: ReadonlySet<string> = new Set(NODE_ERROR_CODES)

/**
 * Report whether a value is one of this plugin's own stable codes.
 * @param value - candidate code.
 * @returns `true` for a declared `node/*` code.
 */
export function isNodeErrorCode(value: unknown): value is NodeErrorCode {
  return typeof value === 'string' && NODE_ERROR_CODE_SET.has(value)
}

/**
 * A failure raised at this plugin's transport boundary.
 *
 * `details` must stay free of credentials: it is serialized onto the wire and
 * into the log sink. Never pass the token here.
 */
export class NodeError extends Error {
  /** Stable `node/*` category. */
  readonly code: NodeErrorCode
  /** Non-sensitive, JSON-serializable context. */
  readonly details: Record<string, unknown>

  /**
   * @param code - stable category.
   * @param message - correction-oriented diagnostic without credentials.
   * @param details - non-sensitive JSON context.
   * @param options - optional contained cause, which is never serialized.
   */
  constructor(
    code: NodeErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    options: ErrorOptions = {},
  ) {
    super(message, options)
    this.name = 'NodeError'
    this.code = code
    this.details = details
  }
}

/**
 * A failure that already carries a non-`node/*` wire code.
 *
 * Used where this node must mirror DSH's own vocabulary instead of inventing a
 * transport code — cancelling a request is `gateway/cancelled`, exactly what a
 * local DSH caller sees, not a node-specific variant. Business and `gateway/*`
 * codes produced *inside* a Remote method never travel through this class: those
 * arrive as data from `ctx.typertGateway.wireStream.failure`.
 */
export class RemoteCodeError extends Error {
  /** Wire code, preserved verbatim on the Coordinator's side. */
  readonly code: string
  /** Non-sensitive, JSON-serializable context. */
  readonly details: Record<string, unknown>

  /**
   * @param code - wire code to preserve.
   * @param message - correction-oriented diagnostic without credentials.
   * @param details - non-sensitive JSON context.
   * @param options - optional contained cause, which is never serialized.
   */
  constructor(code: string, message: string, details: Record<string, unknown> = {}, options: ErrorOptions = {}) {
    super(message, options)
    this.name = 'RemoteCodeError'
    this.code = code
    this.details = details
  }
}

/**
 * Any failure this plugin may use as an `AbortSignal` reason.
 *
 * Both variants carry a wire code and details, so a waiter can always classify
 * why its operation ended.
 */
export type NodeAbortReason = NodeError | RemoteCodeError

/**
 * Raise a failure that keeps its own wire code from a Remote this plugin owns.
 *
 * DSH recognises a business failure **structurally**, not by class:
 * `remoteErrorOf(value)` accepts anything with `isDSHRemoteError === true` and a
 * string `code`. Setting those two fields is therefore enough, and is strictly
 * more robust than importing `RemoteError` from an official package — it costs no
 * runtime dependency and survives a version bump that changes the class identity.
 *
 * ⚠️ On DSH `0.1.2-alpha.1` the Gateway projects *every* non-business boundary
 * failure to `internal` (see `docs/GROUND-TRUTH.md` §1.5.1), so these codes reach
 * the Coordinator intact only on `alpha.2+`. This plugin does not paper over that
 * by rewriting codes, because doing so would make it disagree with DSH's own
 * carriers.
 * @param code - stable failure code, e.g. `nodeAdmin/path-denied`.
 * @param message - correction-oriented diagnostic without host paths.
 * @param details - non-sensitive JSON context.
 * @returns an `Error` DSH treats as a declared Remote failure.
 */
export function remoteError(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): Error {
  const error = new Error(message) as Error & {
    code: string
    details: Record<string, unknown>
    isDSHRemoteError: boolean
  }
  error.name = 'NodeAdminError'
  error.code = code
  error.details = details
  error.isDSHRemoteError = true
  return error
}

/** Codes the `nodeAdmin` management Remotes can raise. */
export const ADMIN_ERROR_CODES = [
  /** A required argument was absent or the wrong type. */
  'nodeAdmin/invalid-arguments',
  /** The path was refused by the node's filesystem policy. */
  'nodeAdmin/path-denied',
  /** The target does not exist. */
  'nodeAdmin/not-found',
  /** The target already exists and the call does not overwrite. */
  'nodeAdmin/already-exists',
  /** The operation was refused by a size or shape limit. */
  'nodeAdmin/too-large',
  /** The skill name was not an acceptable skill directory name. */
  'nodeAdmin/invalid-name',
] as const

/** One `nodeAdmin` failure code. */
export type AdminErrorCode = (typeof ADMIN_ERROR_CODES)[number]

/**
 * Report whether a value is one of this plugin's own failures.
 * @param value - candidate value.
 * @returns `true` for a {@link NodeError}.
 */
export function isNodeError(value: unknown): value is NodeError {
  return value instanceof NodeError
}

/**
 * Project any thrown value into the wire failure shape of `rpc.result`.
 *
 * A {@link NodeError} keeps its own code and a {@link RemoteCodeError} keeps the
 * code it was built with. Anything else becomes `node/protocol-invalid`, because
 * by the time this runs the value has already escaped this plugin's boundary and
 * no `node/*` code describes it.
 * @param error - thrown value.
 * @returns stable code, message, and details.
 */
export function nodeFailure(error: unknown): NodeFailure {
  if (isNodeError(error)) {
    return { code: error.code, message: error.message, details: error.details }
  }
  if (error instanceof RemoteCodeError) {
    return { code: error.code, message: error.message, details: error.details }
  }
  return {
    code: 'node/protocol-invalid',
    message: error instanceof Error ? error.message : String(error),
    details: {},
  }
}
