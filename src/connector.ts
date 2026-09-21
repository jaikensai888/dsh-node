/**
 * Outbound WebSocket lifecycle: the state machine, backoff, and heartbeat.
 *
 * The connector owns exactly one socket at a time and never listens on a port.
 * Its contract, taken from spec §6 and the security red lines:
 *
 * - `unconfigured` means **no socket and no reconnect timer**. It is a normal
 *   state, not a failure.
 * - At most one live socket exists. `stop()` clears every timer *before* it
 *   closes the socket, and every scheduling path re-checks `running`, so no
 *   reconnect timer can outlive disposal.
 * - Backoff is `min(maxDelayMs, initialDelayMs * 2^(n-1))` scaled by
 *   `1 + random(-jitterRatio, jitterRatio)`, so the first failure waits
 *   `initialDelayMs`.
 * - Credential refusal is never retried at speed: `auth_failed` waits
 *   `maxDelayMs` and gives up after {@link MAX_CONSECUTIVE_AUTH_FAILURES}.
 *
 * Everything environmental is injectable — socket factory, clock, timers,
 * random source — so the unit tests drive the real state machine without a
 * network, while the integration test drives it over a real socket.
 *
 * @module dsh-node/connector
 */

import WebSocket from 'ws'
import { NodeError, isNodeError } from './errors.js'
import { decodeFrame, encodeFrame, isProtocolVersionFailure, type RawFrameData } from './frame-codec.js'
import {
  COORDINATOR_FRAME_TYPES,
  PROTOCOL_VERSION,
  type AnyFrame,
  type CloseFrame,
  type HelloFrame,
  type HelloOkFrame,
  type InboundFrame,
  type NodeState,
  type OutboundFrame,
  type PingFrame,
  type PongFrame,
  type ReadyFrame,
} from './protocol.js'
import type { DshNodeRuntimeConfig } from './config.js'
import { REDACTED, type NodeLogger } from './status.js'

/** Longest peer-supplied string kept in status or logs. */
export const PEER_TEXT_LIMIT = 256

/** `WebSocket.OPEN`, spelled out so this module needs no `ws` import. */
export const SOCKET_OPEN = 1

/** How long `stop()` waits for the peer to acknowledge the `close` frame. */
export const CLOSE_GRACE_MS = 250

/** Missed heartbeat intervals tolerated before the link is declared half-open. */
export const HEARTBEAT_MISSES_ALLOWED = 2

/**
 * Consecutive credential refusals tolerated before retrying stops entirely.
 *
 * A wrong token is an operator problem, so the node keeps trying slowly enough
 * to recover from a server-side fix on its own, but not forever.
 */
export const MAX_CONSECUTIVE_AUTH_FAILURES = 5

/** Coordinator `close` codes that mean "your credentials were refused". */
export const AUTH_CLOSE_CODES: ReadonlySet<string> = new Set([
  'auth-failed',
  'node/auth-failed',
  'unauthorized',
  'forbidden',
  'invalid-token',
  'token-invalid',
])

/** WebSocket close codes conventionally used for authorization refusals. */
export const AUTH_WEBSOCKET_CODES: ReadonlySet<number> = new Set([4401, 4403])

/** Minimal structural socket, satisfied by `ws` and by the test doubles. */
export interface NodeSocket {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  /** `ws`-only escape hatch for a link that will not close politely. */
  terminate?(): void
  on(event: 'open', listener: () => void): unknown
  on(event: 'message', listener: (data: RawFrameData) => void): unknown
  on(event: 'close', listener: (code: number, reason: unknown) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

/** Creates one socket for a resolved Coordinator URL. */
export type NodeSocketFactory = (url: string) => NodeSocket

/** A cancellable scheduled callback. */
export interface TimerHandle {
  cancel(): void
}

/** Injectable time source, so backoff and heartbeat are deterministic in tests. */
export interface NodeTimers {
  setTimeout(handler: () => void, ms: number): TimerHandle
  now(): number
}

/** Real timers, with `unref` so a pending timer cannot hold the process open. */
export function createNodeTimers(): NodeTimers {
  return {
    setTimeout(handler, ms) {
      const handle = setTimeout(handler, ms)
      if (typeof handle === 'object' && handle !== null && 'unref' in handle) handle.unref()
      return { cancel: () => { clearTimeout(handle) } }
    },
    now: () => Date.now(),
  }
}

/** The node-specific half of the protocol; the connector owns only transport. */
export interface ConnectorDelegate {
  /** Stable identity stamped on every outbound frame. */
  readonly nodeId: string
  /** Build the `hello` frame for a fresh socket. */
  createHello(): HelloFrame
  /**
   * Build the `ready` frame after `hello.ok`.
   *
   * May await local readiness, which is how "do not advertise `ready` before the
   * local Gateway is usable" (spec §6.2) is enforced.
   */
  createReady(helloOk: HelloOkFrame): Promise<ReadyFrame> | ReadyFrame
  /** Handle one legal inbound frame while `ready`. */
  onFrame(frame: InboundFrame): void
  /** The transport is gone; fail every in-flight operation with `error`. */
  onDisconnected(error: NodeError): void
}

/** Constructor inputs. */
export interface ConnectorOptions {
  /** Fully validated configuration. */
  readonly config: DshNodeRuntimeConfig
  /** Node-specific protocol half. */
  readonly delegate: ConnectorDelegate
  /** Redacting logger. */
  readonly logger: NodeLogger
  /** Socket factory; defaults to a real `ws` client. */
  readonly createSocket?: NodeSocketFactory
  /** Timer source; defaults to real timers. */
  readonly timers?: NodeTimers
  /** Uniform random in `[0, 1)`; defaults to `Math.random`. */
  readonly random?: () => number
  /** Observer for state transitions, used for logging and status. */
  readonly onStateChange?: (state: NodeState, previous: NodeState) => void
}

/** The connector's observable facts, all secret-free. */
export interface ConnectorSnapshot {
  readonly state: NodeState
  readonly reconnectAttempt: number
  readonly connectionId?: string
  readonly lastConnectedAt?: string
  readonly lastError?: { code: string; message: string; at: string }
}

/**
 * One outbound WebSocket link, with its state machine, backoff, and heartbeat.
 */
export class Connector {
  private readonly config: DshNodeRuntimeConfig
  private readonly delegate: ConnectorDelegate
  private readonly logger: NodeLogger
  private readonly createSocket: NodeSocketFactory
  private readonly timers: NodeTimers
  private readonly random: () => number
  private readonly onStateChange: ((state: NodeState, previous: NodeState) => void) | undefined

  private currentState: NodeState
  private running = false
  private socket: NodeSocket | undefined

  /** Consecutive connection failures; drives backoff and resets once stable. */
  private failureCount = 0
  /** Consecutive credential refusals; resets on a successful handshake. */
  private authFailureCount = 0
  /** Set by a `close` frame so the following socket close routes to `auth_failed`. */
  private authRefused = false
  /** The Coordinator asked us not to reconnect. */
  private reconnectForbidden = false
  /** A failure retrying cannot fix; cleared only by an explicit reconnect. */
  private fatalFailure = false
  private lastSocketError: NodeError | undefined
  /**
   * The specific failure that is tearing this connection down.
   *
   * Kept so the close event can report *why* the link ended (a handshake
   * timeout, an unusable local Gateway) instead of flattening every cause into
   * a generic connection loss.
   */
  private pendingFailure: NodeError | undefined

  private connectionId: string | undefined
  private lastConnectedAt: string | undefined
  private lastError: { code: string; message: string; at: string } | undefined
  private lastPongAt = 0
  private effectiveMaxFrameBytes: number
  private heartbeatIntervalMs: number

  private handshakeTimer: TimerHandle | undefined
  private heartbeatTimer: TimerHandle | undefined
  private reconnectTimer: TimerHandle | undefined
  private stableTimer: TimerHandle | undefined
  private closeWatchdog: TimerHandle | undefined

  /**
   * @param options - configuration, delegate, and injectable environment.
   */
  constructor(options: ConnectorOptions) {
    this.config = options.config
    this.delegate = options.delegate
    this.logger = options.logger
    this.createSocket = options.createSocket ?? createWebSocket
    this.timers = options.timers ?? createNodeTimers()
    this.random = options.random ?? Math.random
    this.onStateChange = options.onStateChange
    this.effectiveMaxFrameBytes = options.config.maxFrameBytes
    this.heartbeatIntervalMs = options.config.heartbeatIntervalMs
    this.currentState = this.isConfigured() ? 'stopped' : 'unconfigured'
  }

  /** Current connection state. */
  get state(): NodeState {
    return this.currentState
  }

  /** Consecutive failed attempts; `0` once the link has been stable. */
  get reconnectAttempt(): number {
    return this.failureCount
  }

  /** The snapshot a status reader needs, all of it secret-free. */
  get snapshot(): ConnectorSnapshot {
    return {
      state: this.currentState,
      reconnectAttempt: this.failureCount,
      ...(this.connectionId === undefined ? {} : { connectionId: this.connectionId }),
      ...(this.lastConnectedAt === undefined ? {} : { lastConnectedAt: this.lastConnectedAt }),
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
    }
  }

  /**
   * Whether an inbound frame may currently be dispatched.
   *
   * Sender-side counterpart of the state machine: the service consults this
   * before acting, so a frame that arrives after `stop()` has no effect.
   */
  get isReady(): boolean {
    return this.running && this.currentState === 'ready' && this.socket !== undefined
  }

  /**
   * Bytes the transport has accepted but not yet flushed.
   *
   * This is the only real backpressure signal available, and it is
   * connection-wide: `ws` keeps one buffer per socket. `0` when the socket is
   * gone or does not expose the property, which correctly reads as "nothing
   * queued".
   */
  get bufferedBytes(): number {
    const socket = this.socket as (NodeSocket & { readonly bufferedAmount?: unknown }) | undefined
    const value = socket?.bufferedAmount
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
  }

  /**
   * Begin connecting.
   *
   * Idempotent: a second call while running is ignored, so a duplicate effect
   * cannot open a second socket.
   */
  start(): void {
    if (this.running) return
    if (!this.isConfigured()) {
      this.running = false
      this.setState('unconfigured')
      return
    }
    this.running = true
    this.failureCount = 0
    this.authFailureCount = 0
    this.fatalFailure = false
    this.reconnectForbidden = false
    this.connect()
  }

  /**
   * Cancel every timer, fail in-flight work, and close the socket.
   *
   * Order matters: `running` is cleared and the timers are gone first, so any
   * late socket event finds the connector inert and schedules nothing.
   * @param reason - short, non-sensitive explanation for the log.
   */
  async stop(reason: string): Promise<void> {
    this.running = false
    this.clearAllTimers()
    const socket = this.socket
    this.socket = undefined
    this.connectionId = undefined
    this.delegate.onDisconnected(new NodeError('node/shutdown', `node is shutting down: ${reason}`, { reason }))

    if (socket !== undefined) {
      this.setState('closing')
      const frame: CloseFrame = {
        type: 'close',
        protocolVersion: PROTOCOL_VERSION,
        nodeId: this.delegate.nodeId,
        code: 'node/shutdown',
        reason,
        reconnect: false,
      }
      if (socket.readyState === SOCKET_OPEN) {
        try {
          socket.send(encodeFrame(frame, this.effectiveMaxFrameBytes))
        } catch {
          // The peer is already gone; the close below is all that is left.
        }
        await this.waitForClose(socket)
      }
      try {
        socket.close(1000, 'dsh-node shutdown')
      } catch {
        // Already closing or closed.
      }
      try {
        socket.terminate?.()
      } catch {
        // Nothing left to terminate.
      }
    }
    this.setState('stopped')
    this.logger.info('dsh-node/disconnected', { reason, nodeId: this.delegate.nodeId })
  }

  /**
   * Drop the current link and try again immediately.
   *
   * Clears the pending backoff *and* the auth-failure budget, because a manual
   * reconnect is how an operator retries after fixing a token.
   */
  reconnectNow(): void {
    if (!this.running) {
      this.start()
      return
    }
    this.cancelReconnectTimer()
    this.authFailureCount = 0
    this.failureCount = 0
    this.fatalFailure = false
    this.reconnectForbidden = false
    this.logger.info('dsh-node/reconnect-requested', { nodeId: this.delegate.nodeId })
    const socket = this.socket
    if (socket === undefined) {
      this.connect()
      return
    }
    // Force the existing link down; its close event leads back into `connect`.
    this.socket = undefined
    this.clearConnectionTimers()
    try {
      socket.terminate?.()
      socket.close(1000, 'dsh-node reconnect')
    } catch {
      // Already gone.
    }
    this.connect()
  }

  /**
   * Send one frame if a socket is open.
   *
   * `false` is an ordinary outcome during teardown, never an error: a caller
   * must not treat a dropped frame as delivered (spec §1.1 #8 — nothing is
   * replayed).
   * @param frame - frame to send.
   * @returns `true` only when the frame reached an open socket.
   */
  send(frame: OutboundFrame): boolean {
    const socket = this.socket
    if (socket === undefined || socket.readyState !== SOCKET_OPEN) return false
    let text: string
    try {
      text = encodeFrame(frame, this.effectiveMaxFrameBytes)
    } catch (error) {
      this.logger.warn('dsh-node/frame-too-large', { type: frame.type, reason: messageOf(error) })
      return false
    }
    try {
      socket.send(text)
      return true
    } catch (error) {
      this.logger.warn('dsh-node/protocol-error', { type: frame.type, reason: messageOf(error) })
      return false
    }
  }

  /** Record one failure for backoff and schedule the next attempt. */
  private connect(): void {
    if (!this.running) return
    this.cancelReconnectTimer()
    this.clearConnectionTimers()
    this.setState('connecting')

    let socket: NodeSocket
    try {
      socket = this.createSocket(this.config.coordinatorUrl as string)
    } catch (error) {
      this.scheduleReconnect(toNodeError('node/connection-lost', error, 'opening the WebSocket failed'))
      return
    }
    this.socket = socket

    socket.on('open', () => { this.handleOpen(socket) })
    socket.on('message', data => { this.handleMessage(socket, data) })
    socket.on('error', error => { this.handleSocketError(socket, error) })
    socket.on('close', (code, reason) => { this.handleClose(socket, code, reason) })
  }

  private handleOpen(socket: NodeSocket): void {
    if (socket !== this.socket || !this.running) return
    this.setState('authenticating')
    this.lastSocketError = undefined
    this.heartbeatIntervalMs = this.config.heartbeatIntervalMs
    this.effectiveMaxFrameBytes = this.config.maxFrameBytes

    try {
      this.send(this.delegate.createHello())
    } catch (error) {
      this.failConnection(toNodeError('node/protocol-invalid', error, 'building the hello frame failed'))
      return
    }
    this.armHandshakeTimeout()
    this.logger.info('dsh-node/connecting', {
      nodeId: this.delegate.nodeId,
      origin: safeOrigin(this.config.coordinatorUrl),
    })
  }

  private handleMessage(socket: NodeSocket, data: RawFrameData): void {
    if (socket !== this.socket) return

    let frame: AnyFrame
    try {
      frame = decodeFrame(data, this.effectiveMaxFrameBytes)
    } catch (error) {
      const failure = toNodeError('node/protocol-invalid', error, 'inbound frame was rejected')
      this.reportProtocolError(failure)
      // A peer speaking another protocol version can never be retried into
      // compatibility, so the node stops and waits for a human (spec §6.1).
      if (isProtocolVersionFailure(error)) {
        this.failFatal(failure)
        return
      }
      // Any other unusable frame during the handshake is retryable; once ready,
      // it is ignored instead of tearing down a working link.
      if (this.currentState === 'authenticating') this.failConnection(failure)
      return
    }

    if (!isCoordinatorFrame(frame)) {
      this.reportProtocolError(new NodeError(
        'node/protocol-invalid',
        `a Coordinator must not send a ${frame.type} frame`,
        { type: frame.type },
      ))
      return
    }

    // Heartbeats are transport-level and legal in every state.
    if (frame.type === 'ping') {
      this.lastPongAt = this.timers.now()
      const pong: PongFrame = {
        type: 'pong',
        protocolVersion: PROTOCOL_VERSION,
        nodeId: this.delegate.nodeId,
        ...(frame.messageId === undefined ? {} : { messageId: frame.messageId }),
      }
      this.send(pong)
      return
    }
    if (frame.type === 'pong') {
      this.lastPongAt = this.timers.now()
      return
    }

    // A frame addressed to a different node is never executed: this connection
    // serves exactly one identity.
    if (frame.nodeId !== this.delegate.nodeId) {
      this.reportProtocolError(new NodeError(
        'node/protocol-invalid',
        'inbound frame names a different nodeId and was ignored',
        { type: frame.type, expected: this.delegate.nodeId, received: frame.nodeId },
      ))
      return
    }

    if (frame.type === 'close') {
      this.handleCloseFrame(frame)
      return
    }

    switch (this.currentState) {
      case 'authenticating':
        if (frame.type === 'hello.ok') {
          this.acceptHandshake(socket, frame)
          return
        }
        this.reportProtocolError(new NodeError(
          'node/protocol-invalid',
          `${frame.type} is not legal before the handshake completes`,
          { type: frame.type, state: this.currentState },
        ))
        return
      case 'ready':
        if (frame.type === 'hello.ok') {
          this.reportProtocolError(new NodeError(
            'node/protocol-invalid',
            'a second hello.ok was ignored',
            { type: frame.type },
          ))
          return
        }
        this.delegate.onFrame(frame)
        return
      default:
        // Frames arriving in backoff/stopped/closing have no live request to
        // answer; ignoring them is the safe reading of spec §7.1.
        this.logger.debug('dsh-node/protocol-error', {
          reason: 'frame ignored outside an active handshake',
          type: frame.type,
          state: this.currentState,
        })
        return
    }
  }

  /**
   * Complete the handshake: build `ready`, then become dispatchable.
   *
   * A synchronous delegate resolves synchronously: `await`ing a plain value
   * would still push the transition into a later microtask, which makes the
   * state machine harder to reason about and harder to test for no benefit. The
   * delegate is allowed to return a promise (that is how "delay `ready` until
   * the local Gateway is usable" is expressed), and only then is the transition
   * deferred.
   */
  private acceptHandshake(socket: NodeSocket, frame: HelloOkFrame): void {
    this.clearHandshakeTimer()
    if (this.currentState !== 'authenticating' || socket !== this.socket || !this.running) return

    let ready: Promise<ReadyFrame> | ReadyFrame
    try {
      ready = this.delegate.createReady(frame)
    } catch (error) {
      this.rejectHandshake(socket, error)
      return
    }
    if (isPromiseLike(ready)) {
      ready.then(
        value => { this.completeHandshake(socket, frame, value) },
        (error: unknown) => { this.rejectHandshake(socket, error) },
      )
      return
    }
    this.completeHandshake(socket, frame, ready)
  }

  /**
   * A handshake failed locally.
   *
   * The local Gateway is unusable (or the surface could not be read): retryable,
   * and explicitly not a credential problem.
   */
  private rejectHandshake(socket: NodeSocket, error: unknown): void {
    if (socket !== this.socket || !this.running) return
    this.failConnection(toNodeError('node/not-ready', error, 'the node is not ready to serve requests'))
  }

  /** Apply the handshake outcome exactly once, synchronously. */
  private completeHandshake(socket: NodeSocket, frame: HelloOkFrame, ready: ReadyFrame): void {
    if (socket !== this.socket || !this.running || this.currentState !== 'authenticating') return

    // The Coordinator may tighten a limit but never loosen one.
    if (frame.maxFrameBytes !== undefined && Number.isFinite(frame.maxFrameBytes)) {
      this.effectiveMaxFrameBytes = Math.min(this.config.maxFrameBytes, Math.max(1_024, frame.maxFrameBytes))
    }
    if (frame.heartbeatIntervalMs !== undefined && Number.isFinite(frame.heartbeatIntervalMs)) {
      this.heartbeatIntervalMs = Math.min(this.config.heartbeatIntervalMs, Math.max(10, frame.heartbeatIntervalMs))
    }

    if (!this.send(ready)) {
      this.failConnection(new NodeError('node/connection-lost', 'ready frame could not be sent', {}))
      return
    }

    this.connectionId = frame.connectionId
    this.lastConnectedAt = new Date(this.timers.now()).toISOString()
    this.authFailureCount = 0
    this.setState('ready')
    this.logger.info('dsh-node/connected', {
      nodeId: this.delegate.nodeId,
      connectionId: frame.connectionId,
      origin: safeOrigin(this.config.coordinatorUrl),
    })
    this.armStableReset()
    this.lastPongAt = this.timers.now()
    this.startHeartbeat()
  }

  private handleCloseFrame(frame: CloseFrame): void {
    const authRefused = frame.code !== undefined && AUTH_CLOSE_CODES.has(frame.code.toLowerCase())
    if (authRefused) this.authRefused = true
    if (frame.reconnect === false && !authRefused) this.reconnectForbidden = true
    this.lastSocketError = new NodeError(
      authRefused ? 'node/auth-failed' : 'node/connection-lost',
      this.peerText(frame.reason ?? frame.code ?? 'the Coordinator closed the connection'),
      { ...(frame.code === undefined ? {} : { code: this.peerText(frame.code) }) },
    )
    this.logger.warn('dsh-node/protocol-error', {
      reason: 'the Coordinator sent a close frame',
      code: frame.code ?? 'unspecified',
      reconnect: frame.reconnect ?? true,
    })
    this.closeSocket('Coordinator close frame')
  }

  private handleSocketError(socket: NodeSocket, error: Error): void {
    if (socket !== this.socket) return
    this.lastSocketError = new NodeError('node/connection-lost', this.peerText(`WebSocket error: ${error.message}`), {})
    this.logger.warn('dsh-node/protocol-error', { reason: 'WebSocket error', detail: error.message })
  }

  /**
   * Make peer-supplied text safe to store, log, and expose through status.
   *
   * A close reason is written by the *other* end, and the status snapshot is
   * returned verbatim to a status reader — unlike a log line, it is not passed
   * through the redacting logger. Anything the peer sends is therefore scrubbed
   * against this node's own credential and length-capped before it is kept.
   * @param text - text of unknown provenance.
   * @returns text that cannot carry the token and cannot be unbounded.
   */
  private peerText(text: string): string {
    const token = this.config.token
    const scrubbed = token === undefined || token === '' ? text : text.split(token).join(REDACTED)
    return scrubbed.length > PEER_TEXT_LIMIT ? `${scrubbed.slice(0, PEER_TEXT_LIMIT)}…` : scrubbed
  }

  private handleClose(socket: NodeSocket, code: number, reason: unknown): void {
    if (socket !== this.socket) return
    this.socket = undefined
    this.connectionId = undefined
    this.clearConnectionTimers()

    const authRefused = this.authRefused || AUTH_WEBSOCKET_CODES.has(code)
    const forbidden = this.reconnectForbidden
    const detail = this.peerText(reasonText(reason))
    // Prefer the most specific cause: a WebSocket error, then the failure that
    // decided to tear this connection down (handshake timeout, unusable local
    // Gateway), and only then a generic connection loss.
    const failure = this.lastSocketError ?? this.pendingFailure ?? new NodeError(
      'node/connection-lost',
      `the connection closed${detail === '' ? '' : `: ${detail}`}`,
      { closeCode: code },
    )
    this.authRefused = false
    this.reconnectForbidden = false
    this.lastSocketError = undefined
    this.pendingFailure = undefined
    this.recordError(failure)

    this.delegate.onDisconnected(new NodeError(
      'node/connection-lost',
      'the connection was lost; in-flight requests were failed and are not replayed',
      { closeCode: code },
    ))
    this.logger.info('dsh-node/disconnected', {
      nodeId: this.delegate.nodeId,
      closeCode: code,
      reason: detail,
      willReconnect: this.running && !authRefused && !forbidden,
    })

    if (!this.running) return
    if (this.fatalFailure) {
      // Retrying cannot fix an incompatible protocol version, so the node goes
      // quiescent with the reason recorded. `reconnectNow()` re-arms it.
      this.fatalFailure = false
      this.setState('stopped')
      return
    }
    if (authRefused) {
      this.enterAuthFailed(failure)
      return
    }
    if (forbidden) {
      this.setState('stopped')
      return
    }
    this.scheduleReconnect(failure)
  }

  private handleHandshakeTimeout(): void {
    this.handshakeTimer = undefined
    if (this.currentState !== 'authenticating') return
    this.failConnection(new NodeError(
      'node/handshake-timeout',
      `hello.ok did not arrive within ${this.config.handshakeTimeoutMs} ms`,
      { handshakeTimeoutMs: this.config.handshakeTimeoutMs },
    ))
  }

  /** Close the current socket after recording a failure; `close` drives the rest. */
  private failConnection(failure: NodeError): void {
    this.pendingFailure = failure
    this.recordError(failure)
    this.closeSocket(failure.message)
  }

  /**
   * Close the current socket and refuse to retry until something changes.
   *
   * Reserved for failures that retrying cannot fix — an incompatible protocol
   * version. `reconnectNow()` clears the flag, so an operator who upgrades the
   * Coordinator can recover without restarting DSH.
   */
  private failFatal(failure: NodeError): void {
    this.fatalFailure = true
    this.pendingFailure = failure
    this.recordError(failure)
    this.closeSocket(failure.message)
  }

  private closeSocket(reason: string): void {
    const socket = this.socket
    if (socket === undefined) {
      if (this.running) this.scheduleReconnect(this.lastSocketError)
      return
    }
    this.clearConnectionTimers()
    // Arm the watchdog BEFORE closing: `close()` may emit `close` synchronously,
    // and a watchdog armed afterwards would be orphaned past the teardown.
    this.closeWatchdog = this.timers.setTimeout(() => {
      this.closeWatchdog = undefined
      try {
        socket.terminate?.()
      } catch {
        // Nothing left to terminate.
      }
      this.handleClose(socket, 1006, 'forced close')
    }, CLOSE_GRACE_MS)
    try {
      socket.close(1000, reason)
    } catch {
      // Already closing.
    }
  }

  /** Enter the slow, bounded credential-refusal path. */
  private enterAuthFailed(failure: NodeError): void {
    this.authFailureCount += 1
    this.recordError(failure)
    this.setState('auth_failed')
    if (this.authFailureCount > MAX_CONSECUTIVE_AUTH_FAILURES) {
      this.logger.error('dsh-node/state-changed', {
        state: 'auth_failed',
        nodeId: this.delegate.nodeId,
        reason: `giving up after ${MAX_CONSECUTIVE_AUTH_FAILURES} consecutive credential refusals`,
        code: failure.code,
      })
      return
    }
    // Slow on purpose: a wrong token must not become a request storm.
    const delay = jitter(this.config.reconnect.maxDelayMs, this.config.reconnect.jitterRatio, this.random)
    this.logger.warn('dsh-node/reconnect-scheduled', {
      nodeId: this.delegate.nodeId,
      delayMs: delay,
      attempt: this.authFailureCount,
      reason: 'credentials were refused',
    })
    this.armReconnect(delay)
  }

  private scheduleReconnect(failure: NodeError | undefined): void {
    if (!this.running) return
    if (failure !== undefined) this.recordError(failure)
    this.failureCount += 1
    const delay = this.backoffDelay()
    this.setState('backoff')
    this.logger.warn('dsh-node/reconnect-scheduled', {
      nodeId: this.delegate.nodeId,
      delayMs: delay,
      attempt: this.failureCount,
      code: this.lastError?.code,
    })
    this.armReconnect(delay)
  }

  /**
   * `min(maxDelayMs, initialDelayMs * 2^(n-1))`, scaled by jitter.
   *
   * `failureCount` has already been incremented when this runs, so the first
   * failure yields exactly `initialDelayMs`.
   */
  private backoffDelay(): number {
    const { initialDelayMs, maxDelayMs, jitterRatio } = this.config.reconnect
    const exponent = Math.max(0, this.failureCount - 1)
    const base = Math.min(maxDelayMs, initialDelayMs * 2 ** exponent)
    return jitter(base, jitterRatio, this.random)
  }

  private armReconnect(delayMs: number): void {
    this.cancelReconnectTimer()
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = undefined
      // The disposal guard: no timer that survived `stop()` may reconnect.
      if (!this.running) return
      this.connect()
    }, delayMs)
  }

  private armStableReset(): void {
    this.cancelStableTimer()
    const reset = () => {
      this.stableTimer = undefined
      if (this.currentState !== 'ready') return
      if (this.failureCount !== 0) {
        this.logger.debug('dsh-node/state-changed', { state: 'ready', reason: 'reconnect attempt counter reset' })
      }
      this.failureCount = 0
    }
    if (this.config.reconnect.stableResetMs <= 0) {
      reset()
      return
    }
    this.stableTimer = this.timers.setTimeout(reset, this.config.reconnect.stableResetMs)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    const tick = (): void => {
      this.heartbeatTimer = undefined
      if (this.currentState !== 'ready' || !this.running) return
      const now = this.timers.now()
      if (now - this.lastPongAt > this.heartbeatIntervalMs * HEARTBEAT_MISSES_ALLOWED) {
        this.failConnection(new NodeError(
          'node/connection-lost',
          `no pong within ${this.heartbeatIntervalMs * HEARTBEAT_MISSES_ALLOWED} ms; treating the link as half-open`,
          { heartbeatIntervalMs: this.heartbeatIntervalMs },
        ))
        return
      }
      const ping: PingFrame = {
        type: 'ping',
        protocolVersion: PROTOCOL_VERSION,
        nodeId: this.delegate.nodeId,
      }
      this.send(ping)
      this.heartbeatTimer = this.timers.setTimeout(tick, this.heartbeatIntervalMs)
    }
    this.heartbeatTimer = this.timers.setTimeout(tick, this.heartbeatIntervalMs)
  }

  private armHandshakeTimeout(): void {
    this.clearHandshakeTimer()
    this.handshakeTimer = this.timers.setTimeout(() => { this.handleHandshakeTimeout() }, this.config.handshakeTimeoutMs)
  }

  private reportProtocolError(failure: NodeError): void {
    this.logger.warn('dsh-node/protocol-error', {
      nodeId: this.delegate.nodeId,
      code: failure.code,
      reason: failure.message,
      details: failure.details,
    })
  }

  private recordError(failure: NodeError): void {
    this.lastError = {
      code: failure.code,
      message: failure.message,
      at: new Date(this.timers.now()).toISOString(),
    }
  }

  private setState(state: NodeState): void {
    if (this.currentState === state) return
    const previous = this.currentState
    this.currentState = state
    this.onStateChange?.(state, previous)
  }

  private isConfigured(): boolean {
    return this.config.coordinatorUrl !== undefined && this.config.token !== undefined
  }

  /** Wait out the close handshake, bounded by {@link CLOSE_GRACE_MS}. */
  private async waitForClose(socket: NodeSocket): Promise<void> {
    await new Promise<void>(resolve => {
      const timer = this.timers.setTimeout(() => { resolve() }, CLOSE_GRACE_MS)
      socket.on('close', () => {
        timer.cancel()
        resolve()
      })
    })
  }

  private clearHandshakeTimer(): void {
    this.handshakeTimer?.cancel()
    this.handshakeTimer = undefined
  }

  private stopHeartbeat(): void {
    this.heartbeatTimer?.cancel()
    this.heartbeatTimer = undefined
  }

  private cancelReconnectTimer(): void {
    this.reconnectTimer?.cancel()
    this.reconnectTimer = undefined
  }

  private cancelStableTimer(): void {
    this.stableTimer?.cancel()
    this.stableTimer = undefined
  }

  private clearConnectionTimers(): void {
    this.clearHandshakeTimer()
    this.stopHeartbeat()
    this.cancelStableTimer()
    this.closeWatchdog?.cancel()
    this.closeWatchdog = undefined
  }

  private clearAllTimers(): void {
    this.clearConnectionTimers()
    this.cancelReconnectTimer()
  }
}

/** Scale a delay by a symmetric jitter factor in `[1-ratio, 1+ratio]`. */
function jitter(baseMs: number, ratio: number, random: () => number): number {
  if (ratio <= 0) return Math.max(0, Math.round(baseMs))
  const factor = 1 + (random() * 2 - 1) * ratio
  return Math.max(0, Math.round(baseMs * factor))
}

/**
 * Narrow a decoded frame to the Coordinator direction.
 *
 * The codec validates structure but cannot know direction, so this is the one
 * place the two vocabularies are separated: a node-direction frame arriving on
 * the wire is a protocol error, never a command.
 * @param frame - decoded frame.
 * @returns `true` when the frame is one only a Coordinator may send.
 */
function isCoordinatorFrame(frame: AnyFrame): frame is InboundFrame {
  return COORDINATOR_FRAME_TYPES.has(frame.type)
}

/** `scheme://host:port` for logging, or `undefined` when unparseable. */
function safeOrigin(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return undefined
  }
}

/** Whether a delegate answer was deferred. */
function isPromiseLike<T>(value: Promise<T> | T): value is Promise<T> {
  return typeof (value as { then?: unknown }).then === 'function'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function reasonText(reason: unknown): string {
  if (typeof reason === 'string') return reason
  if (reason instanceof Uint8Array) return Buffer.from(reason).toString('utf8')
  if (reason instanceof Error) return reason.message
  return ''
}

/** Normalize any thrown value into a {@link NodeError} of the given code. */
function toNodeError(code: NodeError['code'], error: unknown, context: string): NodeError {
  if (isNodeError(error)) return error
  return new NodeError(code, `${context}: ${messageOf(error)}`, {})
}

/**
 * Default socket factory: a real `ws` client.
 *
 * TLS certificate validation is never disabled, and no proxy is invented: the
 * only outbound destination is the configured Coordinator URL. The client half
 * of this interface is the whole surface this plugin uses, so nothing here can
 * be repurposed into an inbound listener.
 */
function createWebSocket(url: string): NodeSocket {
  return new WebSocket(url) as unknown as NodeSocket
}
