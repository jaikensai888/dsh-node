/**
 * Stream forwarding, sequencing, limits, and backpressure.
 *
 * A stream Remote (`session/follow`, `session/control`, `workspace/follow`)
 * yields values for as long as the Coordinator listens, so this module is where
 * the spec's §8.2 limits are actually enforced:
 *
 * - at most `maxStreams` open at once → `node/stream-limit`;
 * - at most `maxFrameBytes` per frame → `node/frame-too-large`;
 * - at most `maxBufferedBytesPerStream` pending in the transport
 *   → `node/backpressure`;
 * - and when the Coordinator falls behind, **pause the iterator first**:
 *   `for await` only requests the next value after the previous frame has been
 *   handed over, and {@link StreamManager.pump} additionally waits for the socket
 *   to drain before taking the next value. So a slow peer stops the source
 *   instead of filling this process's memory.
 *
 * Two invariants mirror `RequestManager`, because a stream carries the same
 * once-only duty:
 *
 * - `seq` starts at 1 and increases by exactly one per `stream.data`;
 * - every stream reaches **exactly one** terminal frame (`stream.end` or
 *   `stream.error`), and none after it.
 *
 * @module dsh-node/stream-manager
 */

import { RemoteCodeError, nodeFailure, type NodeFailure } from './errors.js'
import { frameByteLength } from './frame-codec.js'
import {
  PROTOCOL_VERSION,
  type OutboundFrame,
  type StreamCancelFrame,
  type StreamDataFrame,
  type StreamEndFrame,
  type StreamErrorFrame,
  type StreamOpenFrame,
  type StreamReadyFrame,
} from './protocol.js'

/** How to hand one encoded frame to the transport. `false` means "not sent". */
export type StreamSender = (frame: OutboundFrame) => boolean

/** How many bytes the transport has accepted but not yet flushed. */
export type BufferedBytesProbe = () => number

/** Injected scheduling, so the drain deadline is deterministic in tests. */
export interface StreamManagerTimers {
  setTimeout(handler: () => void, ms: number): { cancel(): void }
  sleep(ms: number): Promise<void>
  now(): number
}

/** Real timers. */
export function createStreamTimers(): StreamManagerTimers {
  return {
    setTimeout(handler, ms) {
      const handle = setTimeout(handler, ms)
      if (typeof handle === 'object' && handle !== null && 'unref' in handle) handle.unref()
      return { cancel: () => { clearTimeout(handle) } }
    },
    sleep(ms) {
      return new Promise(resolve => {
        const handle = setTimeout(resolve, ms)
        if (typeof handle === 'object' && handle !== null && 'unref' in handle) handle.unref()
      })
    },
    now: () => Date.now(),
  }
}

/** One open stream, as the manager exposes it. */
export interface ActiveStream {
  readonly streamId: string
  readonly endpoint: string
  readonly requestId: string | undefined
  readonly startedAt: number
  /** Cancellation handed to `ctx.typertGateway.stream`. */
  readonly signal: AbortSignal
  /** `stream.data` frames already accepted by the transport. */
  readonly count: number
}

/** A structured observation, already free of values and credentials. */
export interface StreamEvent {
  readonly kind: 'opened' | 'data' | 'ended' | 'failed' | 'cancelled' | 'backpressure' | 'stalled'
  readonly streamId: string
  readonly endpoint?: string
  readonly count?: number
  readonly code?: string
  readonly detail?: string
}

/** Options; every limit is required so nothing is silently unlimited. */
export interface StreamManagerOptions {
  /** Reads the node identity stamped on every outbound frame. */
  readonly nodeId: () => string
  /** Concurrent stream ceiling. */
  readonly maxStreams: number
  /** Per-frame ceiling, matching the connector's own `maxFrameBytes`. */
  readonly maxFrameBytes: number
  /**
   * Pending-transport-bytes ceiling while a stream is pumping.
   *
   * The transport is one socket, so its pending byte count is connection-wide;
   * this bounds how far ahead of the Coordinator one stream may run.
   */
  readonly maxBufferedBytesPerStream: number
  /** How long a stalled transport may block before the stream is terminated. */
  readonly sendStallTimeoutMs: number
  /** How often to re-check the transport while draining. */
  readonly drainPollMs?: number
  /** Hands an encoded frame to the transport. */
  readonly send: StreamSender
  /** Reads the transport's pending byte count. */
  readonly bufferedBytes: BufferedBytesProbe
  /**
   * Projects an iteration failure onto wire fields.
   *
   * The host wires this to the Gateway's own `wireStream.failure`, so a stream
   * that fails with a business code keeps that code exactly as a unary call does.
   * Defaults to {@link nodeFailure}.
   */
  readonly failureOf?: (error: unknown) => NodeFailure
  /** Timer source. */
  readonly timers?: StreamManagerTimers
  /** Observer for logs and status. */
  readonly onEvent?: (event: StreamEvent) => void
}

interface LiveStream {
  readonly streamId: string
  readonly endpoint: string
  readonly requestId: string | undefined
  readonly controller: AbortController
  readonly startedAt: number
  seq: number
  count: number
  settled: boolean
}

/**
 * Registry and pump for stream Remotes.
 *
 * One instance per connection, like `RequestManager`.
 */
export class StreamManager {
  private readonly live = new Map<string, LiveStream>()
  private readonly options: StreamManagerOptions
  private readonly timers: StreamManagerTimers

  /**
   * @param options - limits, transport hooks, and injectable time.
   */
  constructor(options: StreamManagerOptions) {
    this.options = options
    this.timers = options.timers ?? createStreamTimers()
  }

  /** Number of open streams. */
  get size(): number {
    return this.live.size
  }

  /** Whether `streamId` is open. */
  has(streamId: string): boolean {
    return this.live.has(streamId)
  }

  /** Snapshot of the open streams, for status and logs. */
  get active(): ActiveStream[] {
    return [...this.live.values()].map(entry => ({
      streamId: entry.streamId,
      endpoint: entry.endpoint,
      requestId: entry.requestId,
      startedAt: entry.startedAt,
      signal: entry.controller.signal,
      count: entry.count,
    }))
  }

  /**
   * Admit a `stream.open`.
   *
   * The arguments were already shape-checked and are forwarded untouched by the
   * caller; this only decides whether the stream may exist at all.
   * @param frame - the decoded open frame.
   * @returns either the admitted stream or the failure to answer with.
   */
  open(frame: StreamOpenFrame): { ok: true; stream: ActiveStream } | { ok: false; error: NodeFailure } {
    if (this.live.has(frame.streamId)) {
      return {
        ok: false,
        error: {
          code: 'node/protocol-invalid',
          message: 'stream.open reuses a streamId that is still open; the first stream is unaffected',
          details: { streamId: frame.streamId },
        },
      }
    }
    if (this.live.size >= this.options.maxStreams) {
      return {
        ok: false,
        error: {
          code: 'node/stream-limit',
          message: `node already has ${this.live.size} streams open`,
          details: { streamId: frame.streamId, endpoint: frame.endpoint, maxStreams: this.options.maxStreams },
        },
      }
    }

    const entry: LiveStream = {
      streamId: frame.streamId,
      endpoint: frame.endpoint,
      requestId: frame.requestId,
      controller: new AbortController(),
      startedAt: this.timers.now(),
      seq: 0,
      count: 0,
      settled: false,
    }
    this.live.set(frame.streamId, entry)
    this.emit({ kind: 'opened', streamId: entry.streamId, endpoint: entry.endpoint })
    return { ok: true, stream: this.snapshotOf(entry) }
  }

  /**
   * Acknowledge that the source really opened.
   *
   * Sent only after `ctx.typertGateway.stream` resolved, so the Coordinator can
   * tell "open, nothing yielded yet" apart from "still opening". No
   * `stream.data` for this id precedes it.
   * @param streamId - the stream to acknowledge.
   * @returns whether the frame reached the transport.
   */
  ready(streamId: string): boolean {
    const entry = this.live.get(streamId)
    if (entry === undefined || entry.settled) return false
    const frame: StreamReadyFrame = {
      type: 'stream.ready',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: this.options.nodeId(),
      streamId,
      ...(entry.requestId === undefined ? {} : { requestId: entry.requestId }),
    }
    return this.options.send(frame)
  }

  /**
   * Pump one async iterable to the Coordinator.
   *
   * The `for await` loop plus the drain wait are the backpressure mechanism: the
   * next value is requested only once the previous frame has been accepted and
   * the transport is keeping up, so a slow Coordinator stops the source rather
   * than growing memory here.
   * @param streamId - the stream to pump.
   * @param source - values from `ctx.typertGateway.stream`.
   */
  async pump(streamId: string, source: AsyncIterable<unknown>): Promise<void> {
    const entry = this.live.get(streamId)
    if (entry === undefined) return

    try {
      for await (const value of source) {
        if (entry.settled || entry.controller.signal.aborted) return
        const failure = await this.pumpOne(entry, value)
        if (failure !== undefined) {
          this.fail(streamId, failure)
          return
        }
        if (entry.settled || entry.controller.signal.aborted) return
      }
      this.end(streamId)
    } catch (error) {
      // A cancelled iterator may reject; that is a cancellation already reported
      // through the signal, not a second failure worth a second frame.
      if (entry.controller.signal.aborted || entry.settled) return
      this.fail(streamId, (this.options.failureOf ?? nodeFailure)(error))
    }
  }

  /**
   * End one stream normally. Terminal and idempotent.
   * @param streamId - the stream to end.
   * @returns `true` when this call was the one that ended it.
   */
  end(streamId: string): boolean {
    const entry = this.live.get(streamId)
    if (entry === undefined || entry.settled) return false
    entry.settled = true
    const frame: StreamEndFrame = {
      type: 'stream.end',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: this.options.nodeId(),
      streamId,
      count: entry.count,
    }
    this.options.send(frame)
    this.live.delete(streamId)
    this.emit({ kind: 'ended', streamId, endpoint: entry.endpoint, count: entry.count })
    return true
  }

  /**
   * Terminate one stream with a failure. Terminal and idempotent.
   *
   * The reason also becomes the abort reason, so whatever waits inside the
   * Gateway observes the same code this node reported.
   * @param streamId - the stream to fail.
   * @param failure - the wire failure to report.
   * @returns `true` when this call was the one that failed it.
   */
  fail(streamId: string, failure: NodeFailure): boolean {
    const entry = this.live.get(streamId)
    if (entry === undefined || entry.settled) return false
    entry.settled = true
    const frame: StreamErrorFrame = {
      type: 'stream.error',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: this.options.nodeId(),
      streamId,
      error: { code: failure.code, message: failure.message, details: failure.details },
      count: entry.count,
    }
    this.options.send(frame)
    this.live.delete(streamId)
    this.abortEntry(entry, failure)
    this.emit({ kind: 'failed', streamId, endpoint: entry.endpoint, count: entry.count, code: failure.code })
    return true
  }

  /**
   * Cancel one stream because the Coordinator asked.
   *
   * Reports `gateway/cancelled`, which is what a local DSH caller sees for the
   * same cancellation — not a node-specific code.
   * @param frame - the decoded `stream.cancel`.
   * @returns `true` when a live stream was cancelled.
   */
  cancel(frame: StreamCancelFrame): boolean {
    const entry = this.live.get(frame.streamId)
    if (entry === undefined || entry.settled) return false
    this.emit({ kind: 'cancelled', streamId: frame.streamId, endpoint: entry.endpoint, count: entry.count })
    return this.fail(frame.streamId, {
      code: 'gateway/cancelled',
      message: frame.reason ?? 'the Coordinator cancelled the stream',
      details: {},
    })
  }

  /**
   * Terminate every open stream because the transport is gone or the node is
   * stopping.
   *
   * Nothing is resumed: v1 has no continuation, so the Coordinator decides
   * whether to open a fresh stream (spec §7.4). Replaying a partially consumed
   * stream would duplicate the values it already saw.
   * @param failure - the wire failure to report.
   * @param notify - whether to attempt a terminal frame per stream. `false` when
   * the socket is already gone and sending is pointless.
   * @returns the ids that were terminated.
   */
  failAll(failure: NodeFailure, notify: boolean): string[] {
    const ids = [...this.live.keys()]
    for (const streamId of ids) {
      const entry = this.live.get(streamId)
      if (entry === undefined || entry.settled) continue
      if (notify) {
        this.fail(streamId, failure)
        continue
      }
      // Transport gone: release locally instead of pretending to have reported.
      entry.settled = true
      this.live.delete(streamId)
      this.abortEntry(entry, failure)
      this.emit({ kind: 'failed', streamId, endpoint: entry.endpoint, count: entry.count, code: failure.code })
    }
    return ids
  }

  /** Build, drain-wait, and send one value. */
  private async pumpOne(entry: LiveStream, value: unknown): Promise<NodeFailure | undefined> {
    entry.seq += 1
    const frame: StreamDataFrame = {
      type: 'stream.data',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: this.options.nodeId(),
      streamId: entry.streamId,
      seq: entry.seq,
      value,
    }

    let bytes: number
    try {
      bytes = frameByteLength(JSON.stringify(frame))
    } catch {
      return {
        code: 'node/result-invalid',
        message: 'a stream value could not be serialized to JSON',
        details: { streamId: entry.streamId, seq: entry.seq },
      }
    }
    if (bytes > this.options.maxFrameBytes) {
      // Too large to ever fit. Reported rather than silently dropped, so the
      // Coordinator learns data is missing instead of seeing a short stream.
      return {
        code: 'node/frame-too-large',
        message: `stream value is ${bytes} bytes, over the ${this.options.maxFrameBytes} byte limit`,
        details: { streamId: entry.streamId, seq: entry.seq, bytes, maxFrameBytes: this.options.maxFrameBytes },
      }
    }

    const drained = await this.drain(entry)
    if (drained !== undefined) return drained
    if (entry.settled || entry.controller.signal.aborted) return undefined

    if (!this.options.send(frame)) {
      this.emit({ kind: 'stalled', streamId: entry.streamId, code: 'node/connection-lost' })
      return {
        code: 'node/connection-lost',
        message: 'the stream could not be sent because the transport is not open',
        details: { streamId: entry.streamId },
      }
    }

    entry.count += 1
    this.emit({ kind: 'data', streamId: entry.streamId, count: entry.count })
    return undefined
  }

  /**
   * Wait for the transport to fall back under the buffered-bytes ceiling.
   *
   * This is the "pause the async iterator" half of the spec's backpressure rule,
   * made explicit: nothing is pulled from the source while the socket is behind.
   * Only when pausing is not enough — the peer never drains inside
   * `sendStallTimeoutMs` — does the stream get terminated.
   */
  private async drain(entry: LiveStream): Promise<NodeFailure | undefined> {
    const limit = this.options.maxBufferedBytesPerStream
    if (this.options.bufferedBytes() <= limit) return undefined

    const pollMs = this.options.drainPollMs ?? 10
    const deadline = this.timers.now() + this.options.sendStallTimeoutMs
    while (this.options.bufferedBytes() > limit) {
      if (entry.settled || entry.controller.signal.aborted) return undefined
      if (this.timers.now() >= deadline) {
        const pending = this.options.bufferedBytes()
        this.emit({ kind: 'backpressure', streamId: entry.streamId, detail: `${pending} bytes pending` })
        return {
          code: 'node/backpressure',
          message: `the Coordinator did not consume ${pending} queued bytes within ${this.options.sendStallTimeoutMs} ms`,
          details: {
            streamId: entry.streamId,
            pendingBytes: pending,
            maxBufferedBytesPerStream: limit,
            sendStallTimeoutMs: this.options.sendStallTimeoutMs,
          },
        }
      }
      await this.timers.sleep(pollMs)
    }
    return undefined
  }

  /** Abort a stream's signal with a reason carrying the wire code. */
  private abortEntry(entry: LiveStream, failure: NodeFailure): void {
    if (entry.controller.signal.aborted) return
    entry.controller.abort(new RemoteCodeError(failure.code, failure.message, failure.details))
  }

  private snapshotOf(entry: LiveStream): ActiveStream {
    return {
      streamId: entry.streamId,
      endpoint: entry.endpoint,
      requestId: entry.requestId,
      startedAt: entry.startedAt,
      signal: entry.controller.signal,
      count: entry.count,
    }
  }

  /**
   * Report an observation without letting it break stream accounting.
   *
   * The observer is a diagnostic channel — logging, metrics. If it throws, the
   * once-only terminal guarantee still has to hold, so the failure is contained
   * here rather than propagating into `pump`, where it would turn into a second
   * `stream.error` for a stream that is already being failed.
   */
  private emit(event: StreamEvent): void {
    try {
      this.options.onEvent?.(event)
    } catch {
      // Deliberately swallowed: see above. A broken observer must not be able to
      // corrupt the stream state machine.
    }
  }
}
