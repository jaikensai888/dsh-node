/**
 * Connector lifecycle: state machine, backoff, heartbeat, and disposal.
 *
 * Covers spec §12.1 items 3, 6, 7, 9, and 16. The real connector runs here with
 * an injected socket factory, clock, timers, and random source, so the state
 * machine under test is the production one — only the environment is synthetic.
 */

import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_NODE_CONFIG, type DshNodeRuntimeConfig } from '../src/config.js'
import {
  AUTH_CLOSE_CODES,
  CLOSE_GRACE_MS,
  Connector,
  HEARTBEAT_MISSES_ALLOWED,
  MAX_CONSECUTIVE_AUTH_FAILURES,
  SOCKET_OPEN,
  type ConnectorDelegate,
  type NodeSocket,
  type NodeTimers,
  type TimerHandle,
} from '../src/connector.js'
import { NodeError } from '../src/errors.js'
import type { RawFrameData } from '../src/frame-codec.js'
import type { HelloFrame, HelloOkFrame, InboundFrame, OutboundFrame, ReadyFrame } from '../src/protocol.js'
import { PROTOCOL_VERSION } from '../src/protocol.js'
import { createNodeLogger, type NodeLogFields, type NodeLogLevel } from '../src/status.js'

const NODE_ID = 'node-test-01'
const TOKEN = 'secret-token'
const URL = 'ws://127.0.0.1:9999/node'

/** Any listener shape the socket double has to accept. */
type AnyListener = (...args: never[]) => void

/** A socket double that records what the connector sent and can be driven by hand. */
class FakeSocket implements NodeSocket {
  readyState = 0
  readonly sent: string[] = []
  closeCalls: { code: number | undefined; reason: string | undefined }[] = []
  terminateCalls = 0
  sendThrows: Error | undefined
  /** Whether `close()` completes the handshake the way a cooperative peer does. */
  autoCloseOnClose = true

  private readonly listeners = new Map<string, AnyListener[]>()

  on(event: 'open', listener: () => void): this
  on(event: 'message', listener: (data: RawFrameData) => void): this
  on(event: 'close', listener: (code: number, reason: unknown) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: string, listener: AnyListener): this {
    const existing: AnyListener[] = this.listeners.get(event) ?? []
    existing.push(listener)
    this.listeners.set(event, existing)
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      ;(listener as (...inner: unknown[]) => void)(...args)
    }
  }

  send(data: string): void {
    if (this.sendThrows !== undefined) throw this.sendThrows
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason })
    if (this.autoCloseOnClose && this.readyState === SOCKET_OPEN) this.drop(code ?? 1000, reason ?? 'closed')
  }

  terminate(): void {
    this.terminateCalls += 1
  }

  /** Frames the connector put on the wire, decoded. */
  frames(): OutboundFrame[] {
    return this.sent.map(text => JSON.parse(text) as OutboundFrame)
  }

  types(): string[] {
    return this.frames().map(frame => frame.type)
  }

  /** Simulate a successful connect. */
  open(): void {
    this.readyState = SOCKET_OPEN
    this.emit('open')
  }

  /** Simulate an inbound frame. */
  receive(frame: unknown): void {
    this.emit('message', JSON.stringify(frame))
  }

  /** Simulate an inbound raw payload. */
  receiveRaw(data: string): void {
    this.emit('message', data)
  }

  /** Simulate the peer closing the connection. */
  drop(code = 1006, reason = 'gone'): void {
    this.readyState = 3
    this.emit('close', code, Buffer.from(reason, 'utf8'))
  }

  /** Simulate a socket-level error. */
  fail(message: string): void {
    this.emit('error', new Error(message))
  }
}

/** Manual clock and timer queue. */
class FakeTimers implements NodeTimers {
  private time = 1_700_000_000_000
  private readonly queue: { at: number; handler: () => void; cancelled: boolean; ms: number }[] = []

  now(): number {
    return this.time
  }

  setTimeout(handler: () => void, ms: number): TimerHandle {
    const entry = { at: this.time + ms, handler, cancelled: false, ms }
    this.queue.push(entry)
    return { cancel: () => { entry.cancelled = true } }
  }

  /** Advance the clock, firing every timer that comes due. */
  advance(ms: number): void {
    const target = this.time + ms
    for (;;) {
      const due = this.queue
        .filter(entry => !entry.cancelled && entry.at <= target)
        .sort((left, right) => left.at - right.at)[0]
      if (due === undefined) break
      due.cancelled = true
      this.time = due.at
      due.handler()
    }
    this.time = target
  }

  /** Delays of the timers still waiting, in milliseconds. */
  pendingDelays(): number[] {
    return this.queue.filter(entry => !entry.cancelled).map(entry => entry.at - this.time).sort((a, b) => a - b)
  }

  get pending(): number {
    return this.queue.filter(entry => !entry.cancelled).length
  }
}

interface Harness {
  connector: Connector
  timers: FakeTimers
  sockets: FakeSocket[]
  logs: { level: NodeLogLevel; message: string; fields: NodeLogFields }[]
  disconnected: NodeError[]
  frames: InboundFrame[]
  delegate: ConnectorDelegate
  readyCalls: number
  setReadyError: (error: unknown) => void
}

function harness(config: Partial<DshNodeRuntimeConfig> = {}, options: { configured?: boolean } = {}): Harness {
  const timers = new FakeTimers()
  const sockets: FakeSocket[] = []
  const logs: { level: NodeLogLevel; message: string; fields: NodeLogFields }[] = []
  const disconnected: NodeError[] = []
  const frames: InboundFrame[] = []
  let readyError: unknown
  let readyCalls = 0

  const full: DshNodeRuntimeConfig = {
    ...DEFAULT_NODE_CONFIG,
    coordinatorUrl: URL,
    token: TOKEN,
    reconnect: { ...DEFAULT_NODE_CONFIG.reconnect },
    ...config,
  }
  // `exactOptionalPropertyTypes` forbids assigning `undefined` to an optional
  // field, so an unconfigured node is built by removing the keys instead.
  const effective = options.configured === false ? withoutCredentials(full) : full

  const delegate: ConnectorDelegate = {
    nodeId: NODE_ID,
    createHello(): HelloFrame {
      return {
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        nodeId: NODE_ID,
        mode: 'full-access',
        auth: { type: 'bearer', token: TOKEN },
      }
    },
    createReady(): ReadyFrame {
      readyCalls += 1
      if (readyError !== undefined) throw readyError
      return {
        type: 'ready',
        protocolVersion: PROTOCOL_VERSION,
        nodeId: NODE_ID,
        capabilities: { remotes: [], remoteSurfaceHash: 'sha256:empty', namespaces: [] },
      }
    },
    onFrame(frame: InboundFrame): void {
      frames.push(frame)
    },
    onDisconnected(error: NodeError): void {
      disconnected.push(error)
    },
  }

  const connector = new Connector({
    config: effective,
    delegate,
    logger: createNodeLogger({
      secrets: [TOKEN],
      env: {},
      sink: (level, message, fields) => { logs.push({ level, message, fields }) },
    }),
    createSocket: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    timers,
    // Deterministic jitter: `random()` returning 0.5 makes the factor exactly 1.
    random: () => 0.5,
  })

  return {
    connector,
    timers,
    sockets,
    logs,
    disconnected,
    frames,
    delegate,
    get readyCalls() { return readyCalls },
    setReadyError: error => { readyError = error },
  }
}

/** Build a configured copy without the two credential fields. */
function withoutCredentials(config: DshNodeRuntimeConfig): DshNodeRuntimeConfig {
  const { coordinatorUrl: _url, token: _token, ...rest } = config
  return rest
}

/** Drive one connection all the way to `ready`. */
function connect(harness: Harness, socketIndex = 0): FakeSocket {
  harness.connector.start()
  const socket = harness.sockets[socketIndex]!
  socket.open()
  socket.receive({
    type: 'hello.ok',
    protocolVersion: PROTOCOL_VERSION,
    nodeId: NODE_ID,
    connectionId: `conn-${socketIndex}`,
  })
  return socket
}

/**
 * Stop the connector, letting its bounded close-grace window elapse.
 *
 * `stop()` sends a `close` frame and then waits {@link CLOSE_GRACE_MS} for the
 * peer before forcing the socket down, so a manual clock has to move.
 */
async function stopNode(test: Harness, reason = 'plugin-disposed'): Promise<void> {
  const stopping = test.connector.stop(reason)
  test.timers.advance(CLOSE_GRACE_MS + 1)
  await stopping
}

/** Every log line plus its fields, as text. */
function logText(harness: Harness): string {
  return harness.logs.map(entry => `${entry.message} ${JSON.stringify(entry.fields)}`).join('\n')
}

describe('unconfigured starts nothing (spec §12.1 item 3)', () => {
  it('creates no socket and schedules no reconnect', () => {
    const test = harness({}, { configured: false })
    test.connector.start()

    expect(test.connector.state).toBe('unconfigured')
    expect(test.sockets).toHaveLength(0)
    expect(test.timers.pending).toBe(0)

    // Time passing must not conjure a connection attempt.
    test.timers.advance(10 * 60_000)
    expect(test.sockets).toHaveLength(0)
    expect(test.connector.state).toBe('unconfigured')
  })

  it('ignores reconnectNow, which must not start a loop', () => {
    const test = harness({}, { configured: false })
    test.connector.start()
    test.connector.reconnectNow()
    test.timers.advance(10 * 60_000)
    expect(test.sockets).toHaveLength(0)
    expect(test.connector.state).toBe('unconfigured')
  })

  it('refuses to send anything', () => {
    const test = harness({}, { configured: false })
    test.connector.start()
    expect(test.connector.isReady).toBe(false)
    expect(test.connector.send({
      type: 'ping',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: NODE_ID,
    })).toBe(false)
  })
})

describe('handshake', () => {
  it('walks connecting -> authenticating -> ready and sends hello then ready', () => {
    const test = harness()
    const states: string[] = []
    test.connector.start()
    states.push(test.connector.state)
    expect(test.connector.state).toBe('connecting')

    const socket = test.sockets[0]!
    socket.open()
    states.push(test.connector.state)
    expect(test.connector.state).toBe('authenticating')
    expect(socket.types()).toEqual(['hello'])

    const hello = socket.frames()[0] as HelloFrame
    expect(hello.auth).toEqual({ type: 'bearer', token: TOKEN })
    expect(hello.mode).toBe('full-access')
    expect(hello.nodeId).toBe(NODE_ID)

    socket.receive({
      type: 'hello.ok',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: NODE_ID,
      connectionId: 'conn-1',
    })
    states.push(test.connector.state)
    expect(test.connector.state).toBe('ready')
    expect(socket.types()).toEqual(['hello', 'ready'])
    expect(test.connector.snapshot.connectionId).toBe('conn-1')
    expect(test.connector.snapshot.lastConnectedAt).toBeDefined()
    expect(states).toEqual(['connecting', 'authenticating', 'ready'])
  })

  it('opens exactly one socket per attempt', () => {
    const test = harness()
    connect(test)
    expect(test.sockets).toHaveLength(1)
    // `start` is idempotent, so a duplicated effect cannot double-connect.
    test.connector.start()
    expect(test.sockets).toHaveLength(1)
  })

  it('times out a handshake that never completes', () => {
    const test = harness({ handshakeTimeoutMs: 5_000 })
    test.connector.start()
    const socket = test.sockets[0]!
    socket.open()
    test.timers.advance(5_000)

    expect(test.connector.state).toBe('backoff')
    expect(test.connector.snapshot.lastError?.code).toBe('node/handshake-timeout')
    expect(socket.closeCalls.length).toBeGreaterThan(0)
  })

  it('treats a failure to build ready as retryable, not as an auth failure', () => {
    const test = harness()
    test.setReadyError(new NodeError('node/not-ready', 'the local Gateway is not usable'))
    test.connector.start()
    test.sockets[0]!.open()
    test.sockets[0]!.receive({
      type: 'hello.ok',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: NODE_ID,
      connectionId: 'conn-1',
    })

    expect(test.connector.state).toBe('backoff')
    expect(test.connector.snapshot.lastError?.code).toBe('node/not-ready')
  })

  it('reports a handshake transport loss with node/connection-lost', () => {
    const test = harness()
    test.connector.start()
    test.sockets[0]!.open()
    test.sockets[0]!.drop(1006, 'reset')

    expect(test.disconnected).toHaveLength(1)
    expect(test.disconnected[0]!.code).toBe('node/connection-lost')
    expect(test.connector.state).toBe('backoff')
  })
})

describe('protocol handling while ready (spec §12.1 item 9)', () => {
  it('dispatches legal frames and answers ping with pong', () => {
    const test = harness()
    const socket = connect(test)

    socket.receive({
      type: 'rpc.request',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: NODE_ID,
      requestId: 'req-1',
      endpoint: 'session/create',
      payload: { args: {} },
    })
    expect(test.frames.map(frame => frame.type)).toEqual(['rpc.request'])

    socket.receive({ type: 'ping', protocolVersion: PROTOCOL_VERSION, nodeId: NODE_ID })
    expect(socket.types().slice(-1)).toEqual(['pong'])
  })

  it('ignores an unknown frame type once ready, keeping the link up', () => {
    const test = harness()
    const socket = connect(test)
    // `stream.resume` is not implemented: v1 has no stream continuation.
    socket.receive({ type: 'stream.resume', protocolVersion: PROTOCOL_VERSION, nodeId: NODE_ID })

    expect(test.frames).toHaveLength(0)
    expect(test.connector.state).toBe('ready')
    expect(logText(test)).toMatch(/unknown type/u)
  })

  it('dispatches the Phase 2 stream frames to the delegate once ready', () => {
    const test = harness()
    const socket = connect(test)
    socket.receive({
      type: 'stream.open',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: NODE_ID,
      streamId: 's-1',
      endpoint: 'session/follow',
      payload: { args: {} },
    })
    socket.receive({ type: 'stream.cancel', protocolVersion: PROTOCOL_VERSION, nodeId: NODE_ID, streamId: 's-1' })

    expect(test.frames.map(frame => frame.type)).toEqual(['stream.open', 'stream.cancel'])
    expect(test.connector.state).toBe('ready')
  })

  it('never lets the Coordinator drive a node-direction stream frame', () => {
    const test = harness()
    const socket = connect(test)
    socket.receive({
      type: 'stream.data',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: NODE_ID,
      streamId: 's-1',
      seq: 1,
      value: 'injected',
    })

    expect(test.frames).toHaveLength(0)
    expect(test.connector.state).toBe('ready')
    expect(logText(test)).toMatch(/must not send a stream\.data frame/u)
  })

  it('ignores a frame addressed to a different nodeId without executing it', () => {
    const test = harness()
    const socket = connect(test)
    socket.receive({
      type: 'rpc.request',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: 'node-someone-else',
      requestId: 'req-1',
      endpoint: 'session/create',
      payload: { args: {} },
    })

    expect(test.frames).toHaveLength(0)
    expect(test.connector.state).toBe('ready')
    expect(logText(test)).toMatch(/different nodeId/u)
  })

  it('treats a node-direction frame from the Coordinator as a protocol error, not a command', () => {
    const test = harness()
    const socket = connect(test)
    socket.receive({
      type: 'rpc.result',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: NODE_ID,
      requestId: 'req-1',
      result: { ok: true, value: {} },
    })

    expect(test.frames).toHaveLength(0)
    expect(test.connector.state).toBe('ready')
    expect(logText(test)).toMatch(/must not send a rpc\.result frame/u)
  })

  it('ignores a second hello.ok', () => {
    const test = harness()
    const socket = connect(test)
    expect(test.connector.snapshot.connectionId).toBe('conn-0')
    socket.receive({
      type: 'hello.ok',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: NODE_ID,
      connectionId: 'conn-2',
    })
    // The first handshake's identity stands; a late duplicate cannot rebind it.
    expect(test.connector.snapshot.connectionId).toBe('conn-0')
    expect(logText(test)).toMatch(/second hello\.ok/u)
  })

  it('survives a malformed frame while ready instead of dropping a working link', () => {
    const test = harness()
    const socket = connect(test)
    socket.receiveRaw('{ this is not json')
    expect(test.connector.state).toBe('ready')
    expect(logText(test)).toMatch(/not valid JSON/u)
  })

  it('treats a wrong protocolVersion during the handshake as fatal, not retryable', () => {
    const test = harness()
    test.connector.start()
    const socket = test.sockets[0]!
    socket.open()
    socket.receive({ type: 'hello.ok', protocolVersion: 'dsh-node/99', nodeId: NODE_ID, connectionId: 'conn-1' })

    // A peer that does not speak this protocol must not be retried in a loop.
    expect(logText(test)).toMatch(/unsupported protocol version/u)
    expect(test.connector.state).toBe('stopped')
    expect(test.connector.snapshot.lastError?.code).toBe('node/protocol-invalid')
    expect(test.connector.snapshot.lastError?.message).toMatch(/unsupported protocol version/u)
    test.timers.advance(60 * 60_000)
    expect(test.sockets).toHaveLength(1)
  })

  it('routes every advertised authorization close code to auth_failed', () => {
    for (const code of AUTH_CLOSE_CODES) {
      const test = harness({ reconnect: { initialDelayMs: 50, maxDelayMs: 30_000, jitterRatio: 0, stableResetMs: 0 } })
      test.connector.start()
      test.sockets[0]!.open()
      test.sockets[0]!.receive({ type: 'close', protocolVersion: PROTOCOL_VERSION, nodeId: NODE_ID, code })
      test.sockets[0]!.drop(1000, code)
      expect(test.connector.state, code).toBe('auth_failed')
    }
  })

  it('lets an operator retry after a fatal protocol mismatch', () => {
    const test = harness()
    test.connector.start()
    test.sockets[0]!.open()
    test.sockets[0]!.receive({ type: 'hello.ok', protocolVersion: 'dsh-node/99', nodeId: NODE_ID, connectionId: 'c' })
    expect(test.connector.state).toBe('stopped')

    test.connector.reconnectNow()
    expect(test.connector.state).toBe('connecting')
    expect(test.sockets).toHaveLength(2)
  })

  it('keeps retrying an ordinary malformed handshake frame', () => {
    const test = harness({ reconnect: { initialDelayMs: 100, maxDelayMs: 1_000, jitterRatio: 0, stableResetMs: 0 } })
    test.connector.start()
    test.sockets[0]!.open()
    test.sockets[0]!.receiveRaw('{ not json')
    expect(test.connector.state).toBe('backoff')
    test.timers.advance(100)
    expect(test.sockets).toHaveLength(2)
  })

  it('never leaks the token into a log line, including the hello frame', () => {
    const test = harness()
    const socket = connect(test)
    socket.receive({ type: 'nope', protocolVersion: PROTOCOL_VERSION, nodeId: NODE_ID, token: TOKEN })
    socket.drop(1006, `token=${TOKEN}`)

    expect(logText(test)).not.toContain(TOKEN)
    expect(JSON.stringify(test.connector.snapshot)).not.toContain(TOKEN)
  })
})

describe('exponential backoff (spec §12.1 item 6)', () => {
  /** Fail `count` attempts and return the delay scheduled after each. */
  function backoffDelays(count: number, config: Partial<DshNodeRuntimeConfig> = {}): number[] {
    const test = harness({
      reconnect: { initialDelayMs: 100, maxDelayMs: 1_000, jitterRatio: 0, stableResetMs: 60_000 },
      ...config,
    })
    const delays: number[] = []
    test.connector.start()
    for (let index = 0; index < count; index += 1) {
      const socket = test.sockets[index]!
      socket.open()
      socket.drop(1006, 'flaky')
      delays.push(test.timers.pendingDelays()[0] ?? -1)
      test.timers.advance(test.timers.pendingDelays()[0] ?? 0)
    }
    return delays
  }

  it('waits initialDelayMs after the first failure, then doubles', () => {
    expect(backoffDelays(6)).toEqual([100, 200, 400, 800, 1_000, 1_000])
  })

  it('never exceeds maxDelayMs', () => {
    const delays = backoffDelays(10, { reconnect: { initialDelayMs: 100, maxDelayMs: 700, jitterRatio: 0, stableResetMs: 0 } })
    expect(Math.max(...delays)).toBeLessThanOrEqual(700)
  })

  it('reports the attempt count in the snapshot', () => {
    const test = harness({ reconnect: { initialDelayMs: 100, maxDelayMs: 1_000, jitterRatio: 0, stableResetMs: 60_000 } })
    test.connector.start()
    expect(test.connector.reconnectAttempt).toBe(0)
    test.sockets[0]!.open()
    test.sockets[0]!.drop()
    expect(test.connector.reconnectAttempt).toBe(1)
    test.timers.advance(100)
    test.sockets[1]!.open()
    test.sockets[1]!.drop()
    expect(test.connector.reconnectAttempt).toBe(2)
  })

  it('keeps the jitter inside the configured ratio', () => {
    const base = { initialDelayMs: 1_000, maxDelayMs: 100_000, jitterRatio: 0.2, stableResetMs: 0 }
    const seen: number[] = []
    for (const value of [0, 0.25, 0.5, 0.75, 0.999_999]) {
      const test = harness({ reconnect: base })
      const connector = new Connector({
        config: { ...DEFAULT_NODE_CONFIG, coordinatorUrl: URL, token: TOKEN, reconnect: base },
        delegate: test.delegate,
        logger: createNodeLogger({ env: {}, sink: () => {} }),
        createSocket: () => {
          const socket = new FakeSocket()
          test.sockets.push(socket)
          return socket
        },
        timers: test.timers,
        random: () => value,
      })
      connector.start()
      test.sockets[0]!.open()
      test.sockets[0]!.drop()
      seen.push(test.timers.pendingDelays()[0] ?? -1)
    }
    for (const delay of seen) {
      expect(delay).toBeGreaterThanOrEqual(800)
      expect(delay).toBeLessThanOrEqual(1_200)
    }
    // The extreme ends are actually exercised, so the assertion above is not vacuous.
    expect(seen[0]).toBe(800)
    expect(seen[seen.length - 1]).toBeLessThanOrEqual(1_200)
    expect(new Set(seen).size).toBeGreaterThan(1)
  })

  it('schedules nothing when jitter would produce a negative delay', () => {
    const test = harness({ reconnect: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 1, stableResetMs: 0 } })
    const connector = new Connector({
      config: { ...DEFAULT_NODE_CONFIG, coordinatorUrl: URL, token: TOKEN, reconnect: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 1, stableResetMs: 0 } },
      delegate: test.delegate,
      logger: createNodeLogger({ env: {}, sink: () => {} }),
      createSocket: () => {
        const socket = new FakeSocket()
        test.sockets.push(socket)
        return socket
      },
      timers: test.timers,
      random: () => 0,
    })
    connector.start()
    test.sockets[0]!.open()
    test.sockets[0]!.drop()
    expect(test.timers.pendingDelays()[0]).toBe(0)
  })

  it('does not reconnect in a tight loop on a server-side close', () => {
    const test = harness({ reconnect: { initialDelayMs: 250, maxDelayMs: 250, jitterRatio: 0, stableResetMs: 60_000 } })
    test.connector.start()
    test.sockets[0]!.open()
    test.sockets[0]!.drop(1001, 'going away')

    // Nothing happens until the delay elapses.
    test.timers.advance(249)
    expect(test.sockets).toHaveLength(1)
    test.timers.advance(1)
    expect(test.sockets).toHaveLength(2)
  })
})

describe('stable reset (spec §12.1 item 7)', () => {
  it('resets the attempt counter only after stableResetMs of readiness', () => {
    const test = harness({ reconnect: { initialDelayMs: 100, maxDelayMs: 1_000, jitterRatio: 0, stableResetMs: 5_000 } })
    test.connector.start()
    test.sockets[0]!.open()
    test.sockets[0]!.drop()
    expect(test.connector.reconnectAttempt).toBe(1)

    test.timers.advance(100)
    connect(test, 1)
    expect(test.connector.state).toBe('ready')
    // Not yet stable: a drop now must resume the exponential series.
    expect(test.connector.reconnectAttempt).toBe(1)

    test.timers.advance(5_000)
    expect(test.connector.reconnectAttempt).toBe(0)

    test.sockets[1]!.drop()
    expect(test.connector.reconnectAttempt).toBe(1)
    expect(test.timers.pendingDelays()[0]).toBe(100)
  })

  it('resets immediately when stableResetMs is zero', () => {
    const test = harness({ reconnect: { initialDelayMs: 100, maxDelayMs: 1_000, jitterRatio: 0, stableResetMs: 0 } })
    test.connector.start()
    test.sockets[0]!.open()
    test.sockets[0]!.drop()
    expect(test.connector.reconnectAttempt).toBe(1)
    test.timers.advance(100)
    connect(test, 1)
    expect(test.connector.reconnectAttempt).toBe(0)
  })

  it('cancels the reset timer when the link drops early', () => {
    const test = harness({ reconnect: { initialDelayMs: 100, maxDelayMs: 1_000, jitterRatio: 0, stableResetMs: 5_000 } })
    connect(test)
    expect(test.timers.pending).toBeGreaterThan(0)
    test.sockets[0]!.drop()
    // Only the fresh reconnect timer remains: the stale stable-reset timer can
    // no longer fire later and zero a counter that describes a new series.
    expect(test.timers.pendingDelays()).toEqual([100])
  })
})

describe('authentication failure', () => {
  it('enters auth_failed and retries slowly rather than rapidly', () => {
    const test = harness({ reconnect: { initialDelayMs: 50, maxDelayMs: 30_000, jitterRatio: 0, stableResetMs: 60_000 } })
    test.connector.start()
    const socket = test.sockets[0]!
    socket.open()
    socket.receive({
      type: 'close',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: NODE_ID,
      code: 'auth-failed',
      reason: 'bad token',
      reconnect: false,
    })
    socket.drop(1000, 'auth-failed')

    expect(test.connector.state).toBe('auth_failed')
    // maxDelayMs, not initialDelayMs: a wrong token must not become a storm.
    expect(test.timers.pendingDelays()[0]).toBe(30_000)
  })

  it('recognises the conventional WebSocket authorization codes', () => {
    for (const code of [4401, 4403]) {
      const test = harness({ reconnect: { initialDelayMs: 50, maxDelayMs: 30_000, jitterRatio: 0, stableResetMs: 0 } })
      test.connector.start()
      test.sockets[0]!.open()
      test.sockets[0]!.drop(code, 'unauthorized')
      expect(test.connector.state, String(code)).toBe('auth_failed')
    }
  })

  it('gives up after a bounded number of refusals', () => {
    const test = harness({ reconnect: { initialDelayMs: 50, maxDelayMs: 1_000, jitterRatio: 0, stableResetMs: 0 } })
    test.connector.start()
    for (let attempt = 0; attempt <= MAX_CONSECUTIVE_AUTH_FAILURES; attempt += 1) {
      const socket = test.sockets[attempt]
      expect(socket, `attempt ${attempt}`).toBeDefined()
      socket!.open()
      socket!.receive({
        type: 'close',
        protocolVersion: PROTOCOL_VERSION,
        nodeId: NODE_ID,
        code: 'auth-failed',
      })
      socket!.drop(1000, 'auth-failed')
      if (attempt < MAX_CONSECUTIVE_AUTH_FAILURES) test.timers.advance(1_000)
    }
    expect(test.connector.state).toBe('auth_failed')
    // No timer is left: the node is quiescent until an operator acts.
    test.timers.advance(60 * 60_000)
    expect(test.sockets).toHaveLength(MAX_CONSECUTIVE_AUTH_FAILURES + 1)
  })

  it('lets a manual reconnect retry immediately after the token is fixed', () => {
    const test = harness({ reconnect: { initialDelayMs: 50, maxDelayMs: 30_000, jitterRatio: 0, stableResetMs: 0 } })
    test.connector.start()
    test.sockets[0]!.open()
    test.sockets[0]!.receive({ type: 'close', protocolVersion: PROTOCOL_VERSION, nodeId: NODE_ID, code: 'auth-failed' })
    test.sockets[0]!.drop(1000, 'auth-failed')
    expect(test.connector.state).toBe('auth_failed')

    test.connector.reconnectNow()
    expect(test.connector.state).toBe('connecting')
    expect(test.sockets).toHaveLength(2)
    expect(test.timers.pending).toBe(0)
  })

  it('resets the refusal budget after a successful handshake', () => {
    const test = harness({ reconnect: { initialDelayMs: 50, maxDelayMs: 100, jitterRatio: 0, stableResetMs: 0 } })
    test.connector.start()
    test.sockets[0]!.open()
    test.sockets[0]!.receive({ type: 'close', protocolVersion: PROTOCOL_VERSION, nodeId: NODE_ID, code: 'auth-failed' })
    test.sockets[0]!.drop(1000, 'auth-failed')
    test.timers.advance(100)
    connect(test, 1)
    expect(test.connector.state).toBe('ready')

    test.sockets[1]!.drop()
    // A fresh failure series, so the ordinary backoff applies again.
    expect(test.timers.pendingDelays()[0]).toBe(50)
  })

  it('honours an explicit reconnect:false', () => {
    const test = harness()
    test.connector.start()
    test.sockets[0]!.open()
    test.sockets[0]!.receive({
      type: 'close',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: NODE_ID,
      code: 'going-away',
      reconnect: false,
    })
    test.sockets[0]!.drop(1000, 'going-away')

    expect(test.connector.state).toBe('stopped')
    test.timers.advance(60 * 60_000)
    expect(test.sockets).toHaveLength(1)
  })
})

describe('heartbeat', () => {
  it('pings on the configured interval and tolerates a missed pong', () => {
    const test = harness({ heartbeatIntervalMs: 1_000 })
    const socket = connect(test)

    test.timers.advance(1_000)
    expect(socket.types().filter(type => type === 'ping')).toHaveLength(1)

    // One missed interval is still tolerated.
    test.timers.advance(1_000)
    expect(socket.types().filter(type => type === 'ping')).toHaveLength(2)
    expect(test.connector.state).toBe('ready')

    socket.receive({ type: 'pong', protocolVersion: PROTOCOL_VERSION, nodeId: NODE_ID })
    test.timers.advance(HEARTBEAT_MISSES_ALLOWED * 1_000)
    expect(test.connector.state).toBe('ready')
  })

  it('treats a half-open link as lost and reconnects', () => {
    const test = harness({
      heartbeatIntervalMs: 1_000,
      reconnect: { initialDelayMs: 100, maxDelayMs: 1_000, jitterRatio: 0, stableResetMs: 60_000 },
    })
    const socket = connect(test)

    // Answer nothing: the link looks open but carries nothing back.
    test.timers.advance(3_000)
    expect(socket.closeCalls.length).toBeGreaterThan(0)
    expect(test.disconnected.length).toBeGreaterThan(0)
    expect(test.disconnected[0]!.code).toBe('node/connection-lost')

    test.timers.advance(1_000)
    expect(test.sockets.length).toBeGreaterThanOrEqual(2)
  })

  it('stops pinging once the link drops', () => {
    const test = harness({ heartbeatIntervalMs: 1_000 })
    const socket = connect(test)
    test.timers.advance(1_000)
    socket.drop()
    const afterDrop = socket.types().filter(type => type === 'ping').length
    test.timers.advance(10_000)
    expect(socket.types().filter(type => type === 'ping')).toHaveLength(afterDrop)
  })

  it('takes the tighter of the configured and the Coordinator interval', () => {
    const test = harness({ heartbeatIntervalMs: 10_000 })
    test.connector.start()
    const socket = test.sockets[0]!
    socket.open()
    socket.receive({
      type: 'hello.ok',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: NODE_ID,
      connectionId: 'conn-1',
      heartbeatIntervalMs: 1_000,
    })
    test.timers.advance(1_000)
    expect(socket.types()).toContain('ping')
  })

  it('never lets the Coordinator loosen the frame limit', () => {
    const test = harness({ maxFrameBytes: 4_096 })
    test.connector.start()
    const socket = test.sockets[0]!
    socket.open()
    socket.receive({
      type: 'hello.ok',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: NODE_ID,
      connectionId: 'conn-1',
      maxFrameBytes: 10_000_000,
    })
    // A frame larger than the node's own ceiling is still refused.
    socket.receiveRaw(JSON.stringify({
      type: 'ping',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: NODE_ID,
      pad: 'x'.repeat(5_000),
    }))
    expect(logText(test)).toMatch(/over the 4096 byte limit/u)
  })
})

describe('disposal (spec §12.1 item 16, §1.1 item 9)', () => {
  it('clears every timer and reports stopped', async () => {
    const test = harness()
    connect(test)
    expect(test.timers.pending).toBeGreaterThan(0)

    await stopNode(test)

    expect(test.connector.state).toBe('stopped')
    expect(test.timers.pending).toBe(0)
    expect(test.disconnected.at(-1)?.code).toBe('node/shutdown')
  })

  it('never reconnects after stop, even with time passing or a late close event', async () => {
    const test = harness()
    const socket = connect(test)
    await stopNode(test)

    socket.drop(1006, 'late')
    test.timers.advance(60 * 60_000)
    expect(test.sockets).toHaveLength(1)
    expect(test.connector.state).toBe('stopped')
  })

  it('cancels a pending backoff when stopped', async () => {
    const test = harness({ reconnect: { initialDelayMs: 30_000, maxDelayMs: 30_000, jitterRatio: 0, stableResetMs: 0 } })
    test.connector.start()
    test.sockets[0]!.open()
    test.sockets[0]!.drop()
    expect(test.timers.pendingDelays()).toEqual([30_000])

    // The backoff timer is cancelled before the close-grace window is served,
    // so the close itself cannot ride the pending reconnect.
    const stopping = test.connector.stop('plugin-disposed')
    test.timers.advance(CLOSE_GRACE_MS + 1)
    await stopping

    test.timers.advance(60 * 60_000)
    expect(test.sockets).toHaveLength(1)
  })

  it('sends a close frame with reconnect:false before giving up the socket', async () => {
    const test = harness()
    const socket = connect(test)
    await stopNode(test)

    const close = socket.frames().find(frame => frame.type === 'close')
    expect(close).toBeDefined()
    expect((close as { reconnect?: boolean }).reconnect).toBe(false)
    expect((close as { code?: string }).code).toBe('node/shutdown')
    expect(socket.closeCalls.length).toBeGreaterThan(0)
  })

  it('is safe to call twice', async () => {
    const test = harness()
    connect(test)
    await stopNode(test, 'once')
    await expect(test.connector.stop('twice')).resolves.toBeUndefined()
    expect(test.connector.state).toBe('stopped')
  })

  it('can start again after a stop, with a clean failure counter', async () => {
    const test = harness()
    test.connector.start()
    test.sockets[0]!.open()
    test.sockets[0]!.drop()
    expect(test.connector.reconnectAttempt).toBe(1)

    await stopNode(test, 'reconfigure')
    test.connector.start()
    expect(test.connector.state).toBe('connecting')
    expect(test.connector.reconnectAttempt).toBe(0)
    expect(test.sockets).toHaveLength(2)
  })

  it('forces a socket that will not close politely', async () => {
    const test = harness()
    const socket = connect(test)
    // The peer never answers the close handshake.
    socket.autoCloseOnClose = false

    await stopNode(test)

    expect(socket.terminateCalls).toBeGreaterThan(0)
    expect(test.connector.state).toBe('stopped')
    expect(test.timers.pending).toBe(0)
  })

  it('does not schedule a reconnect when a failure lands during shutdown', async () => {
    const test = harness()
    const socket = connect(test)
    const stopping = test.connector.stop('plugin-disposed')
    // The socket reports the drop while the grace window is still open.
    socket.drop(1006, 'during shutdown')
    test.timers.advance(CLOSE_GRACE_MS + 1)
    await stopping

    test.timers.advance(60 * 60_000)
    expect(test.sockets).toHaveLength(1)
  })
})

describe('send', () => {
  it('reports false rather than throwing when the socket is not open', () => {
    const test = harness()
    test.connector.start()
    expect(test.connector.send({ type: 'ping', protocolVersion: PROTOCOL_VERSION, nodeId: NODE_ID })).toBe(false)
  })

  it('reports false when the socket refuses the write', () => {
    const test = harness()
    const socket = connect(test)
    socket.sendThrows = new Error('write after end')
    expect(test.connector.send({ type: 'ping', protocolVersion: PROTOCOL_VERSION, nodeId: NODE_ID })).toBe(false)
    expect(logText(test)).toMatch(/write after end/u)
  })

  it('reports false for an oversized frame without putting it on the wire', () => {
    const test = harness({ maxFrameBytes: 1_024 })
    const socket = connect(test)
    const before = socket.sent.length
    expect(test.connector.send({
      type: 'rpc.result',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: NODE_ID,
      requestId: 'req-1',
      result: { ok: true, value: 'x'.repeat(4_000) },
    })).toBe(false)
    expect(socket.sent).toHaveLength(before)
    expect(logText(test)).toMatch(/frame-too-large/u)
  })

  it('is never treated as delivery: a dropped frame is simply not replayed', () => {
    const test = harness()
    connect(test)
    test.sockets[0]!.drop()
    const send = vi.fn(() => test.connector.send({
      type: 'ping',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: NODE_ID,
    }))
    expect(send()).toBe(false)
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('state observers and logging', () => {
  it('logs the connect transition and never the token', () => {
    const test = harness()
    connect(test)

    expect(test.logs.some(entry => entry.message === 'dsh-node/connecting')).toBe(true)
    expect(test.logs.some(entry => entry.message === 'dsh-node/connected')).toBe(true)
    expect(logText(test)).not.toContain(TOKEN)
    // The configured origin may be logged; the credential and the path may not.
    expect(logText(test)).toContain('ws://127.0.0.1:9999')
    expect(logText(test)).not.toContain('/node')
  })

  it('scrubs a peer-supplied close reason before it can reach status', () => {
    const test = harness()
    const socket = connect(test)
    socket.receive({
      type: 'close',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: NODE_ID,
      code: 'going-away',
      reason: `retry with token=${TOKEN}`,
    })
    socket.drop(1000, `also token=${TOKEN}`)

    // Unlike a log line, the snapshot is handed to a caller verbatim, so the
    // peer's own text must already be clean when it is stored.
    expect(JSON.stringify(test.connector.snapshot)).not.toContain(TOKEN)
    expect(test.connector.snapshot.lastError?.message).toContain('«redacted»')
    expect(logText(test)).not.toContain(TOKEN)
  })

  it('logs a reconnect schedule with its delay and attempt', () => {
    const test = harness({ reconnect: { initialDelayMs: 400, maxDelayMs: 400, jitterRatio: 0, stableResetMs: 0 } })
    test.connector.start()
    test.sockets[0]!.open()
    test.sockets[0]!.drop()

    const scheduled = test.logs.find(entry => entry.message === 'dsh-node/reconnect-scheduled')
    expect(scheduled?.fields['delayMs']).toBe(400)
    expect(scheduled?.fields['attempt']).toBe(1)
  })
})
