/**
 * Bookkeeping for in-flight unary requests.
 *
 * The spec's §8.1 contract, and the invariant that makes it safe:
 *
 * - Every request is recorded once and settles **exactly once**.
 * - A duplicate `rpc.request` for a live id is refused, so a replayed frame can
 *   never start a second execution of the same business method.
 * - A response for an unknown or already-settled id is reported to the caller as
 *   `undefined` from {@link RequestManager.complete}; the caller logs a protocol
 *   warning and sends nothing. That is what stops a duplicate response from
 *   invoking a callback twice.
 * - Dropping the connection fails every live request with
 *   `node/connection-lost`, and never replays one: replaying a write would
 *   duplicate a Session, a Prompt, or a file edit (spec §1.1 #8).
 *
 * This module owns no socket and no business logic, so its guarantees hold
 * regardless of which transport drives it.
 *
 * @module dsh-node/request-manager
 */

import { NodeError, type NodeAbortReason } from './errors.js'

/** One live unary request. */
export interface PendingRequest {
  /** Client-chosen correlation id from the `rpc.request` frame. */
  readonly requestId: string
  /** Canonical `<namespace>/<method>` endpoint, for diagnostics and logs. */
  readonly endpoint: string
  /**
   * Cancellation signal handed to `ctx.typertGateway.invoke`.
   *
   * Aborting it always carries a {@link NodeError} reason, so a waiter can
   * distinguish cancel, timeout, disconnect, and shutdown by code.
   */
  readonly signal: AbortSignal
  /** `Date.now()` at admission, for duration logging. */
  readonly startedAt: number
}

/** Injected sources, so tests can drive time and observe completion. */
export interface RequestManagerOptions {
  /** Maximum concurrent unary requests. */
  readonly maxInFlight: number
  /** Per-request wall-clock ceiling. */
  readonly timeoutMs: number
  /** Clock, injectable for deterministic tests. */
  readonly now?: () => number
  /** Timer scheduler, injectable for deterministic tests. */
  readonly setTimer?: (handler: () => void, ms: number) => () => void
  /** Called when a request exceeds {@link RequestManagerOptions.timeoutMs}. */
  readonly onTimeout?: (pending: PendingRequest) => void
}

interface LiveRequest {
  readonly pending: PendingRequest
  readonly controller: AbortController
  readonly cancelTimer: () => void
}

/**
 * Registry of unary requests that are currently executing.
 *
 * Not safe to share across connections: construct one per connector.
 */
export class RequestManager {
  private readonly live = new Map<string, LiveRequest>()
  private readonly options: RequestManagerOptions

  /**
   * @param options - limits and injectable time sources.
   */
  constructor(options: RequestManagerOptions) {
    this.options = options
  }

  /** Number of requests currently executing. */
  get size(): number {
    return this.live.size
  }

  /** Whether `requestId` is currently executing. */
  has(requestId: string): boolean {
    return this.live.has(requestId)
  }

  /**
   * Admit a request.
   * @param requestId - correlation id from the frame; must be unique among live requests.
   * @param endpoint - canonical endpoint, for diagnostics.
   * @returns the pending record, whose signal the caller passes to the Gateway.
   * @throws NodeError `node/request-limit` when the concurrency ceiling is reached,
   * `node/protocol-invalid` for a blank or duplicate id.
   */
  begin(requestId: string, endpoint: string): PendingRequest {
    if (typeof requestId !== 'string' || requestId === '') {
      throw new NodeError('node/protocol-invalid', 'rpc.request requires a non-empty requestId', { endpoint })
    }
    if (this.live.has(requestId)) {
      throw new NodeError(
        'node/protocol-invalid',
        'rpc.request reuses a requestId that is still in flight; the first request is unaffected',
        { requestId, endpoint },
      )
    }
    if (this.live.size >= this.options.maxInFlight) {
      throw new NodeError(
        'node/request-limit',
        `node already has ${this.live.size} unary requests in flight`,
        { requestId, endpoint, maxInFlightRequests: this.options.maxInFlight },
      )
    }

    const controller = new AbortController()
    const now = this.options.now ?? Date.now
    const pending: PendingRequest = {
      requestId,
      endpoint,
      signal: controller.signal,
      startedAt: now(),
    }

    const schedule = this.options.setTimer ?? defaultSetTimer
    const cancelTimer = schedule(() => {
      // `abort` is idempotent; `settle` below decides whether this was first.
      this.abort(requestId, new NodeError(
        'node/request-timeout',
        `request exceeded the ${this.options.timeoutMs} ms local limit`,
        { requestId, endpoint, requestTimeoutMs: this.options.timeoutMs },
      ))
      this.options.onTimeout?.(pending)
    }, this.options.timeoutMs)

    this.live.set(requestId, { pending, controller, cancelTimer })
    return pending
  }

  /**
   * Declare a request finished and release its timer.
   *
   * The single-settlement gate: the first caller gets the record and is
   * therefore the one allowed to send the terminal frame; every later caller
   * gets `undefined` and must stay silent.
   * @param requestId - correlation id.
   * @returns the settled record, or `undefined` when it was already settled or unknown.
   */
  complete(requestId: string): PendingRequest | undefined {
    const entry = this.live.get(requestId)
    if (entry === undefined) return undefined
    this.live.delete(requestId)
    entry.cancelTimer()
    return entry.pending
  }

  /**
   * Abort one live request without settling it.
   *
   * Used by `rpc.cancel`; the request stays live until its own completion path
   * runs, so it still produces exactly one terminal frame.
   * @param requestId - correlation id.
   * @param reason - the {@link NodeAbortReason} abort reason.
   * @returns `true` when a live request was aborted.
   */
  abort(requestId: string, reason: NodeAbortReason): boolean {
    const entry = this.live.get(requestId)
    if (entry === undefined) return false
    if (!entry.controller.signal.aborted) entry.controller.abort(reason)
    return true
  }

  /**
   * Fail every live request and forget them.
   *
   * The reason becomes the abort reason, so a waiter sees `node/connection-lost`
   * on disconnect or `node/shutdown` on plugin disposal. Nothing is replayed.
   * @param reason - the {@link NodeAbortReason} abort reason.
   * @returns the ids that were failed, in admission order.
   */
  failAll(reason: NodeAbortReason): string[] {
    const failed: string[] = []
    for (const [requestId, entry] of this.live) {
      failed.push(requestId)
      entry.cancelTimer()
      if (!entry.controller.signal.aborted) entry.controller.abort(reason)
    }
    this.live.clear()
    return failed
  }
}

/** Default timer: a real `setTimeout`, returning its canceller. */
function defaultSetTimer(handler: () => void, ms: number): () => void {
  const handle = setTimeout(handler, ms)
  // Never hold the event loop open for a request timer.
  if (typeof handle === 'object' && handle !== null && 'unref' in handle) handle.unref()
  return () => { clearTimeout(handle) }
}

