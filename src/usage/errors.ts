/**
 * Usage-collection failures, as a small vocabulary of their own.
 *
 * Separate from `node/*` on purpose. Those describe the transport boundary and are
 * already handled by the Coordinator's connection logic; these describe the
 * collector, and the Coordinator treats them differently — an
 * `nodeUsage/invalid-arguments` is a bug in the caller, `nodeUsage/record-too-large`
 * is a node that must be shown as degraded, and `nodeUsage/storage-unavailable` is a
 * disk problem that must never be reported as "no usage".
 *
 * @module dsh-node/usage/errors
 */

/** One failure raised by the usage boundary. */
export class UsageError extends Error {
  /** Stable `nodeUsage/*` code. */
  readonly code: string
  /** Non-sensitive, JSON-serializable context. */
  readonly details: Record<string, unknown>

  /**
   * @param code - stable category.
   * @param message - correction-oriented diagnostic without secrets.
   * @param details - non-sensitive JSON context.
   */
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'UsageError'
    this.code = code
    this.details = details
  }
}

/** Whether a value is one of these failures. */
export function isUsageError(value: unknown): value is UsageError {
  return value instanceof UsageError
}

/** A caller-supplied argument was unusable. */
export function invalidArguments(message: string, details: Record<string, unknown> = {}): UsageError {
  return new UsageError('nodeUsage/invalid-arguments', message, details)
}

/** The collector's identity does not match the caller's expectation. */
export function collectorMismatch(message: string, details: Record<string, unknown> = {}): UsageError {
  return new UsageError('nodeUsage/collector-mismatch', message, details)
}

/** The queue could not be read or written. */
export function storageUnavailable(message: string, details: Record<string, unknown> = {}): UsageError {
  return new UsageError('nodeUsage/storage-unavailable', message, details)
}
