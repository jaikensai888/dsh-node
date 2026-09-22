/**
 * Real composition test: real Cordis + real `ctx.typertGateway` + a real
 * registered Remote owner + a local fake WebSocket Coordinator.
 *
 * Nothing at the DSH boundary is mocked. The Gateway, the Typert registry, the
 * service binding, argument validation, error projection, and the socket are all
 * production implementations; only the *Coordinator* is a stand-in, because it
 * does not exist yet. That is what lets this suite prove what a mock cannot:
 * that a forwarded endpoint really reaches a business method, that an unknown
 * endpoint really does not, and that a lost connection really does not replay.
 *
 * The owner is registered through `ctx.typert.register` with a hand-written
 * descriptor — the strict dispatch path every generated DSH Remote takes — so no
 * decorator transpilation is involved.
 */

import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import { RemoteError, TypertRemoteService, type InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { WebSocketServer, type WebSocket } from 'ws'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as nodePlugin from '../src/index.js'
import { resolveConfigFile, writeConfigFile } from '../src/index.js'
import {
  NODE_MODES,
  PROTOCOL_VERSION,
  type AnyFrame,
  type HelloFrame,
  type ReadyFrame,
  type RpcResultFrame,
  type StreamDataFrame,
  type StreamErrorFrame,
} from '../src/protocol.js'

const TOKEN = 'integration-secret-token'
const OWNER_SERVICE = 'demoNodeOwner'
const OWNER_NAMESPACE = 'demo'

/**
 * The node plugin, mounted exactly as the DSH Loader mounts a row: the named
 * exports assembled into one plugin object. Mounting the bare `apply` would test
 * a plugin whose `inject` and `Config` never ran.
 */
const NODE_PLUGIN = {
  name: nodePlugin.name,
  inject: nodePlugin.inject,
  apply: nodePlugin.apply,
  Config: nodePlugin.Config,
}

/** One invocation the fixture owner exports to the Gateway. */
function descriptor(
  method: string,
  parameters: InvocationDescriptor['parameters'],
  options: { readonly mode?: 'stream'; readonly cancellation?: true } = {},
): InvocationDescriptor {
  return {
    id: `dsh-node-integration-fixture#${method}`,
    service: OWNER_SERVICE,
    namespace: OWNER_NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters,
    result: { mode: 'src-json' },
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.cancellation === true ? { cancellation: { parameter: 'signal' as const } } : {}),
  }
}

const ECHO_DESCRIPTOR = descriptor('echo', [
  { name: 'message', wire: 'message', source: 'json', codec: { mode: 'src-json' } },
])
/** Throws a real business `RemoteError`, to prove its code survives the trip. */
const FAIL_DESCRIPTOR = descriptor('fail', [])
/** Stays in flight until its gate opens, so a drop can land mid-request. */
const SLOW_DESCRIPTOR = descriptor('slow', [])
/** Finite stream: yields `count` values and finishes. */
const WATCH_DESCRIPTOR = descriptor(
  'watch',
  [{ name: 'count', wire: 'count', source: 'json', codec: { mode: 'src-json' } }],
  { mode: 'stream', cancellation: true },
)
/** Endless stream: yields until it is cancelled. */
const TICK_DESCRIPTOR = descriptor('tick', [], { mode: 'stream', cancellation: true })

/**
 * A real Remote owner: an actual Cordis Service with a real Typert binding.
 *
 * `calls` is the evidence that "the business method really ran" — or, for the
 * negative cases, that it did not.
 */
class DemoOwner extends TypertRemoteService {
  /** Same hard dependency a real DSH Remote owner declares. */
  static inject = ['typert']

  readonly calls: string[] = []
  readonly receivedArgs: Record<string, unknown>[] = []
  /** Resolves the `slow` method; the test opens it to let the request finish. */
  gate: Promise<void> = Promise.resolve()
  /**
   * Whether a stream generator observed its cancellation signal.
   *
   * The Gateway appends the signal when a descriptor declares `cancellation`, so
   * this is direct evidence that a Coordinator `stream.cancel` reached the local
   * operation — not just that the node stopped forwarding (spec §12.2).
   */
  watchAborted = false
  tickAborted = false

  constructor(ctx: Context) {
    super(ctx, OWNER_SERVICE, { namespace: OWNER_NAMESPACE })
    const dispose = ctx.typert.register({
      package: 'dsh-node-integration-fixture',
      face: 'host',
      schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: [
        ECHO_DESCRIPTOR,
        FAIL_DESCRIPTOR,
        SLOW_DESCRIPTOR,
        WATCH_DESCRIPTOR,
        TICK_DESCRIPTOR,
      ],
    })
    ctx.effect(() => () => { void dispose() }, 'integration fixture invocation descriptors')
  }

  /** Echo one argument back, recording that it was reached. */
  echo(message: unknown): unknown {
    this.calls.push('echo')
    this.receivedArgs.push({ message })
    return { echoed: message, at: 'fixture' }
  }

  /** Throw a business error whose code must cross the wire unchanged. */
  fail(): never {
    this.calls.push('fail')
    throw new RemoteError(
      'demo/not-found' as never,
      'the fixture refused',
      { hint: 'business code preserved' } as never,
    )
  }

  /** Run long enough for the transport to disappear underneath the request. */
  async slow(): Promise<unknown> {
    this.calls.push('slow')
    await this.gate
    return { finished: true }
  }

  /** A finite stream that records whether it observed its cancellation signal. */
  async *watch(count: number, signal?: AbortSignal): AsyncIterable<unknown> {
    this.calls.push('watch')
    this.watchAborted = false
    try {
      for (let index = 1; index <= count; index += 1) {
        if (isAborted(signal)) return
        yield { n: index }
      }
    } finally {
      // `finally` covers both endings: the loop noticing the abort, and the
      // carrier closing this iterator early.
      if (isAborted(signal)) this.watchAborted = true
    }
  }

  /** An endless stream, so a cancellation has something real to interrupt. */
  async *tick(signal?: AbortSignal): AsyncIterable<unknown> {
    this.calls.push('tick')
    this.tickAborted = false
    try {
      for (let index = 1; ; index += 1) {
        if (isAborted(signal)) return
        await delay(5)
        if (isAborted(signal)) return
        yield { tick: index }
      }
    } finally {
      if (isAborted(signal)) this.tickAborted = true
    }
  }
}

/**
 * Read an abort flag through a call, not a property access.
 *
 * TypeScript narrows `signal.aborted` to `false` after the first check, because
 * it cannot see that an `await` lets another task abort the signal. A call
 * defeats that (wrong) narrowing.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** One connected node, as the fake Coordinator sees it. */
class CoordinatorSession {
  readonly frames: AnyFrame[] = []
  readonly socket: WebSocket

  constructor(socket: WebSocket) {
    this.socket = socket
    socket.on('message', data => {
      this.frames.push(JSON.parse(data.toString()) as AnyFrame)
    })
  }

  /** Whether a frame of the given type has arrived. */
  has(type: string): boolean {
    return this.frames.some(frame => frame.type === type)
  }

  /** The first frame of the given type. */
  frame<T extends AnyFrame>(type: string): T | undefined {
    return this.frames.find(frame => frame.type === type) as T | undefined
  }

  /** The most recent frame of the given type. */
  last<T extends AnyFrame>(type: string): T | undefined {
    return [...this.frames].reverse().find(frame => frame.type === type) as T | undefined
  }

  send(frame: unknown): void {
    this.socket.send(JSON.stringify(frame))
  }

  /** Send an `rpc.request` for one endpoint. */
  request(requestId: string, endpoint: string, args: Record<string, unknown> = {}): void {
    this.send({
      type: 'rpc.request',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: this.nodeId,
      requestId,
      endpoint,
      payload: { args },
    })
  }

  /** Open one stream. */
  streamOpen(streamId: string, endpoint: string, args: Record<string, unknown> = {}, requestId?: string): void {
    this.send({
      type: 'stream.open',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: this.nodeId,
      streamId,
      endpoint,
      payload: { args },
      ...(requestId === undefined ? {} : { requestId }),
    })
  }

  /** Cancel one stream. */
  streamCancel(streamId: string, reason?: string): void {
    this.send({
      type: 'stream.cancel',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: this.nodeId,
      streamId,
      ...(reason === undefined ? {} : { reason }),
    })
  }

  /** Every frame belonging to one stream, in arrival order. */
  framesOfStream(streamId: string): AnyFrame[] {
    return this.frames.filter(frame => 'streamId' in frame && frame.streamId === streamId)
  }

  /** Wait for one stream's terminal frame. */
  async waitStreamEnd(streamId: string, timeoutMs = 5_000): Promise<AnyFrame> {
    return waitForValue(
      () => this.framesOfStream(streamId).find(frame => frame.type === 'stream.end' || frame.type === 'stream.error'),
      `a terminal frame for ${streamId}`,
      timeoutMs,
    )
  }

  /** Whether the socket is open right now. */
  get isOpen(): boolean {
    return this.socket.readyState === 1
  }

  /** The `nodeId` this session's peer announced. */
  get nodeId(): string {
    return this.frame<HelloFrame>('hello')?.nodeId ?? ''
  }
}

/** A minimal Coordinator: accepts outbound node connections and nothing else. */
class FakeCoordinator {
  readonly sessions: CoordinatorSession[] = []
  private readonly server: WebSocketServer
  private readonly port: number

  private constructor(server: WebSocketServer, port: number) {
    this.server = server
    this.port = port
  }

  /** Bind a loopback listener on an ephemeral port. */
  static async start(): Promise<FakeCoordinator> {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => { resolve() })
      server.once('error', reject)
    })
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const coordinator = new FakeCoordinator(server, port)
    server.on('connection', socket => {
      const session = new CoordinatorSession(socket)
      coordinator.sessions.push(session)
      socket.on('message', data => {
        const frame = JSON.parse(data.toString()) as AnyFrame
        // Answer heartbeats so the node's liveness check stays satisfied.
        if (frame.type === 'ping') {
          session.send({
            type: 'pong',
            protocolVersion: PROTOCOL_VERSION,
            nodeId: session.nodeId,
            ...(frame.messageId === undefined ? {} : { messageId: frame.messageId }),
          })
        }
      })
    })
    return coordinator
  }

  /** The `ws://` URL a node should connect to. */
  get url(): string {
    return `ws://127.0.0.1:${this.port}/node`
  }

  /**
   * Accept the newest node that has said `hello` but has not been answered.
   *
   * Newest-first on purpose: after a reconnect the fresh session is the one to
   * answer, and the stale one must stay unanswered.
   */
  async acceptHandshake(timeoutMs = 5_000): Promise<CoordinatorSession> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      for (const session of [...this.sessions].reverse()) {
        const hello = session.frame<HelloFrame>('hello')
        if (hello === undefined || session.has('hello.ok')) continue
        session.send({
          type: 'hello.ok',
          protocolVersion: PROTOCOL_VERSION,
          nodeId: hello.nodeId,
          connectionId: `conn-${this.sessions.indexOf(session) + 1}`,
          acceptedMode: 'full-access',
        })
        return session
      }
      if (Date.now() > deadline) throw new Error('timed out waiting for a hello frame')
      await delay(10)
    }
  }

  /** Wait until one session has sent its `ready` frame. */
  async waitForReady(session: CoordinatorSession, timeoutMs = 5_000): Promise<ReadyFrame> {
    return waitForValue(() => session.frame<ReadyFrame>('ready'), 'the ready frame', timeoutMs)
  }

  /** Wait for a terminal result frame for one requestId. */
  async result(requestId: string, timeoutMs = 5_000): Promise<RpcResultFrame> {
    return waitForValue(
      () => this.sessions
        .flatMap(session => session.frames)
        .find(frame => frame.type === 'rpc.result' && (frame as RpcResultFrame).requestId === requestId) as
        | RpcResultFrame
        | undefined,
      `rpc.result for ${requestId}`,
      timeoutMs,
    )
  }

  /** Close every node connection, leaving the listener up. */
  dropAll(): void {
    for (const session of this.sessions) session.socket.terminate()
  }

  /** Close the listener and every connection. */
  async close(): Promise<void> {
    for (const session of this.sessions) session.socket.terminate()
    await new Promise<void>(resolve => { this.server.close(() => { resolve() }) })
  }
}

/** Sleep for a short interval. */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/** Poll until `probe` yields a value. */
async function waitForValue<T>(probe: () => T | undefined, label: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await delay(10)
  }
}

/** The node's bootstrap config for one test. */
function nodeConfig(
  coordinatorUrl: string,
  identityFile: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    coordinatorUrl,
    identityFile,
    nodeName: 'integration-node',
    role: 'test-agent',
    mode: 'full-access',
    auth: { token: TOKEN },
    reconnect: { initialDelayMs: 50, maxDelayMs: 200, jitterRatio: 0, stableResetMs: 100 },
    heartbeatIntervalMs: 200,
    handshakeTimeoutMs: 3_000,
    requestTimeoutMs: 3_000,
    maxFrameBytes: 131_072,
    maxInFlightRequests: 4,
    ...overrides,
  }
}

/** The node service's status shape, as this test reads it. */
interface NodeStatusView {
  state: string
  nodeId: string
  coordinatorOrigin?: string
  inFlightRequests: number
  activeStreams: number
  connectionId?: string
  lastError?: { code: string; message: string }
}

/** A mounted plugin fiber, reduced to what this test disposes. */
interface Mounted {
  dispose: () => Promise<void>
}

/** Poll until `probe` yields a value. */
async function eventually<T>(probe: () => T | undefined, label: string, timeoutMs = 5_000): Promise<T> {
  return waitForValue(probe, label, timeoutMs)
}

describe('real Cordis + Typert Gateway + registered Remote + fake Coordinator', () => {
  let coordinator: FakeCoordinator
  let root: Context
  let owner: DemoOwner
  let identityFile: string
  let identityDir: string
  let previousDshHome: string | undefined
  let nodeFiber: Mounted | undefined
  const mounted: Mounted[] = []

  /** Mount a plugin on the root context and remember it for teardown. */
  async function mount(plugin: unknown, config?: unknown): Promise<Mounted> {
    const fiber = root.plugin(plugin as never, config as never) as unknown as Mounted
    mounted.push(fiber)
    await fiber
    return fiber
  }

  beforeEach(async () => {
    coordinator = await FakeCoordinator.start()
    await mkdir(join(process.cwd(), '.tmp'), { recursive: true })
    identityDir = await mkdtemp(join(process.cwd(), '.tmp', 'integration-'))
    identityFile = join(identityDir, 'identity.json')
    // **Isolate the storage layer.** The plugin reads the panel's
    // `<DSH_HOME>/storages/dsh-node/config.json` on every boot and merges it *over*
    // the bootstrap, so a machine where someone has configured a node with the panel
    // would silently rewrite every mount below. That is not hypothetical: the suite
    // went green on a machine with no config file and then failed 27 tests once one
    // existed. Pointing `DSH_HOME` at a fresh directory makes each run independent of
    // whatever this machine happens to have, and the two tests at the end of this
    // describe block pin the file layer itself.
    previousDshHome = process.env['DSH_HOME']
    process.env['DSH_HOME'] = identityDir

    root = new Context()
    // The order a real profile composes them in: the registry, then the Gateway
    // that injects it, then the business owner, then the node.
    await mount(TypertRegistry)
    await mount(TypertGatewayService, { websocketHeartbeatIntervalMs: 2_000 })
    await mount(DemoOwner)
    owner = await eventually(() => root.get(OWNER_SERVICE) as unknown as DemoOwner | undefined, OWNER_SERVICE)
    expect(owner).toBeInstanceOf(DemoOwner)
  }, 20_000)

  afterEach(async () => {
    for (const fiber of [...mounted].reverse()) await fiber.dispose()
    mounted.length = 0
    nodeFiber = undefined
    await coordinator.close()
    await rm(identityDir, { recursive: true, force: true })
    if (previousDshHome === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = previousDshHome
  })

  /** The live status of the mounted node, or `undefined` before it exists. */
  function nodeStatus(): NodeStatusView | undefined {
    const service = root.get('dshNode', false) as unknown as { status: NodeStatusView } | undefined
    return service?.status
  }

  /** Mount the node and wait until both ends agree the link is ready. */
  async function connectNode(config?: Record<string, unknown>): Promise<CoordinatorSession> {
    nodeFiber = await mount(NODE_PLUGIN, config ?? nodeConfig(coordinator.url, identityFile))
    const session = await coordinator.acceptHandshake()
    await coordinator.waitForReady(session)
    await eventually(() => (nodeStatus()?.state === 'ready' ? true : undefined), 'node state ready')
    return session
  }

  it('connects outbound and completes hello / hello.ok / ready', async () => {
    const session = await connectNode()

    const hello = session.frame<HelloFrame>('hello')!
    expect(hello.protocolVersion).toBe(PROTOCOL_VERSION)
    expect(hello.mode).toBe('full-access')
    expect(hello.auth).toEqual({ type: 'bearer', token: TOKEN })
    expect(hello.nodeName).toBe('integration-node')
    expect(hello.role).toBe('test-agent')
    // The nodeId is generated and persisted, not invented per connection.
    expect(hello.nodeId).toMatch(/^node-[0-9a-f]{32}$/u)
    const persisted = JSON.parse(await readFile(identityFile, 'utf8')) as { nodeId: string }
    expect(persisted.nodeId).toBe(hello.nodeId)

    const ready = session.frame<ReadyFrame>('ready')!
    expect(ready.connectionId).toBe('conn-1')
    expect(ready.nodeId).toBe(hello.nodeId)
    // The advertised surface is the real one: the fixture owner is in it.
    expect(ready.capabilities.remotes.map(entry => entry.endpoint)).toContain(`${OWNER_NAMESPACE}/echo`)
    expect(ready.capabilities.remotes.find(entry => entry.endpoint === `${OWNER_NAMESPACE}/echo`)?.mode).toBe('unary')
    expect(ready.capabilities.remoteSurfaceHash).toMatch(/^sha256:[0-9a-f]{64}$/u)

    const status = nodeStatus()!
    expect(status.nodeId).toBe(hello.nodeId)
    expect(status.connectionId).toBe('conn-1')
    expect(JSON.stringify(status)).not.toContain(TOKEN)
  }, 20_000)

  it('reports its records through the harness logger, never through console alone', async () => {
    // A Cordis exporter is the public way to observe log records, and it is the
    // same seam DSH uses to write `logs/dsh-<date>.log`. A node that logged only
    // to `console` would be invisible to the operator — which is exactly the
    // situation with no Coordinator and no browser half to look at.
    const records: { name: string; type: string; text: string }[] = []
    const dispose = root.logger.exporter({
      export(message) {
        records.push({ name: message.name, type: message.type, text: JSON.stringify(message.args) })
      },
    })

    try {
      const session = await connectNode()
      session.request('req-log', `${OWNER_NAMESPACE}/echo`, { message: 'logged' })
      await coordinator.result('req-log')
      // Give the exporter a turn to receive the last records.
      await delay(50)

      const text = records.map(record => record.text).join('\n')
      expect(text).toContain('dsh-node/connecting')
      expect(text).toContain('dsh-node/connected')
      expect(text).toContain('dsh-node/request-completed')
      // Records are attributed to this plugin, not to an anonymous logger.
      expect(records.some(record => record.name.includes('dsh-node'))).toBe(true)
      // And the credential never reaches the harness log file.
      expect(text).not.toContain(TOKEN)
    } finally {
      await dispose()
    }
  }, 20_000)

  it('forwards an rpc.request into the real business method and returns its value', async () => {
    const session = await connectNode()
    session.request('req-1', `${OWNER_NAMESPACE}/echo`, { message: 'hello node' })

    const result = await coordinator.result('req-1')
    expect(result.nodeId).toBe(session.nodeId)
    expect(result.result).toEqual({ ok: true, value: { echoed: 'hello node', at: 'fixture' } })
    // The method really ran, with exactly the arguments the Coordinator sent.
    expect(owner.calls).toEqual(['echo'])
    expect(owner.receivedArgs).toEqual([{ message: 'hello node' }])
  }, 20_000)

  it('passes the args map through unmodified, including nested values', async () => {
    const session = await connectNode()
    // The Gateway's `assertExactArguments` is satisfied by the descriptor's
    // single src-json parameter; the point is that the node itself neither
    // renames, adds, nor drops anything on the way through.
    session.request('req-args', `${OWNER_NAMESPACE}/echo`, { message: { deep: [1, 'two', { three: true }] } })

    const result = await coordinator.result('req-args')
    expect(result.result.ok).toBe(true)
    expect(owner.receivedArgs[0]).toEqual({ message: { deep: [1, 'two', { three: true }] } })
  }, 20_000)

  it('preserves a business error code instead of collapsing it to a transport error', async () => {
    const session = await connectNode()
    session.request('req-boom', `${OWNER_NAMESPACE}/fail`)

    const result = await coordinator.result('req-boom')
    expect(result.result.ok).toBe(false)
    const failure = (result.result as { ok: false; error: { code: string; details: object } }).error
    // `demo/not-found` is the fixture's own code; it must not become node/*.
    expect(failure.code).toBe('demo/not-found')
    expect(failure.details).toEqual({ hint: 'business code preserved' })
    expect(owner.calls).toEqual(['fail'])
  }, 20_000)

  it('refuses an unregistered endpoint with node/capability-unavailable and runs nothing', async () => {
    const session = await connectNode()
    session.request('req-missing', 'nope/missing', { anything: true })

    const result = await coordinator.result('req-missing')
    expect(result.result.ok).toBe(false)
    const failure = (result.result as { ok: false; error: { code: string; details: Record<string, unknown> } }).error
    expect(failure.code).toBe('node/capability-unavailable')
    expect(failure.details['endpoint']).toBe('nope/missing')
    // No business method was reached.
    expect(owner.calls).toEqual([])
  }, 20_000)

  it('refuses an unknown method inside a known namespace without running anything', async () => {
    const session = await connectNode()
    session.request('req-method', `${OWNER_NAMESPACE}/nonexistent`)

    const result = await coordinator.result('req-method')
    expect(result.result.ok).toBe(false)
    const failure = (result.result as { ok: false; error: { code: string } }).error
    // The Gateway cannot confirm a method it does not export, so the node folds
    // its availability failure into the node vocabulary — never into a call.
    expect(failure.code).toBe('node/capability-unavailable')
    expect(owner.calls).toEqual([])
  }, 20_000)

  it('preserves a gateway/* boundary code instead of collapsing it to a node error', async () => {
    const session = await connectNode()
    // An extra field is always rejected by the Gateway's `assertExactArguments`,
    // so this fails at the boundary rather than inside the business method.
    session.request('req-args-bad', `${OWNER_NAMESPACE}/echo`, { message: 'x', bogus: 1 })

    const result = await coordinator.result('req-args-bad')
    expect(result.result.ok).toBe(false)
    const failure = (result.result as { ok: false; error: { code: string } }).error
    // Spec §10: a gateway/* code keeps its identity; only the availability
    // family is folded into node/capability-unavailable.
    expect(failure.code).toBe('gateway/arguments-invalid')
    expect(owner.calls).toEqual([])
  }, 20_000)

  it('streams every value in order and ends the stream (§7.4)', async () => {
    const session = await connectNode()
    session.streamOpen('s-1', `${OWNER_NAMESPACE}/watch`, { count: 3 }, 'req-s1')
    await session.waitStreamEnd('s-1')

    const frames = session.framesOfStream('s-1')
    expect(frames[0]).toMatchObject({ type: 'stream.ready', streamId: 's-1', requestId: 'req-s1' })
    const data = frames.filter(frame => frame.type === 'stream.data') as StreamDataFrame[]
    expect(data.map(frame => frame.seq)).toEqual([1, 2, 3])
    expect(data.map(frame => frame.value)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
    expect(frames.at(-1)).toMatchObject({ type: 'stream.end', count: 3 })
    expect(owner.calls).toContain('watch')
    // Nothing is left open, and status agrees.
    await eventually(() => (nodeStatus()?.activeStreams === 0 ? true : undefined), 'no active streams')
  }, 20_000)

  it('cancels a stream and the local operation really receives the signal (§12.2)', async () => {
    const session = await connectNode()
    session.streamOpen('s-cancel', `${OWNER_NAMESPACE}/tick`, {})
    // Wait until at least one value has been forwarded, so the source is live.
    await eventually(
      () => (session.framesOfStream('s-cancel').some(frame => frame.type === 'stream.data') ? true : undefined),
      'the first stream value',
    )

    session.streamCancel('s-cancel', 'operator stopped it')
    const terminal = await session.waitStreamEnd('s-cancel')

    expect(terminal).toMatchObject({ type: 'stream.error' })
    // The same code a local DSH caller sees for a cancellation.
    expect((terminal as StreamErrorFrame).error.code).toBe('gateway/cancelled')
    // And the signal reached the business generator, not just this node's loop.
    await eventually(() => (owner.tickAborted ? true : undefined), 'the source to observe its abort')
  }, 20_000)

  it('refuses a stream for an unregistered endpoint and runs nothing', async () => {
    const session = await connectNode()
    session.streamOpen('s-missing', 'nope/missing', {})
    const terminal = await session.waitStreamEnd('s-missing')

    expect(terminal).toMatchObject({ type: 'stream.error' })
    expect((terminal as StreamErrorFrame).error.code).toBe('node/capability-unavailable')
    // No `stream.ready`: the stream never opened.
    expect(session.framesOfStream('s-missing').some(frame => frame.type === 'stream.ready')).toBe(false)
    expect(owner.calls).toEqual([])
  }, 20_000)

  it('keeps the carrier and the method shape consistent in both directions', async () => {
    const session = await connectNode()

    // A unary method on the stream carrier.
    session.streamOpen('s-wrong', `${OWNER_NAMESPACE}/echo`, { message: 'x' })
    const wrongCarrier = await session.waitStreamEnd('s-wrong')
    expect((wrongCarrier as StreamErrorFrame).error.code).toBe('gateway/signature-invalid')

    // A stream method on the unary carrier.
    session.request('req-wrong', `${OWNER_NAMESPACE}/watch`, { count: 1 })
    const wrongMethod = await coordinator.result('req-wrong')
    expect(wrongMethod.result.ok).toBe(false)
    expect((wrongMethod.result as { error: { code: string } }).error.code).toBe('gateway/signature-invalid')
  }, 20_000)

  it('enforces maxStreams at the host, not just in the manager', async () => {
    const session = await connectNode(nodeConfig(coordinator.url, identityFile, { maxStreams: 1 }))
    session.streamOpen('s-a', `${OWNER_NAMESPACE}/tick`, {})
    await eventually(
      () => (session.framesOfStream('s-a').some(frame => frame.type === 'stream.data') ? true : undefined),
      'the first stream to produce a value',
    )

    session.streamOpen('s-b', `${OWNER_NAMESPACE}/tick`, {})
    const terminal = await session.waitStreamEnd('s-b')
    expect((terminal as StreamErrorFrame).error.code).toBe('node/stream-limit')

    // The first stream is undisturbed.
    expect(session.framesOfStream('s-a').some(frame => frame.type === 'stream.error')).toBe(false)
    session.streamCancel('s-a')
    await session.waitStreamEnd('s-a')
  }, 20_000)

  it('releases streams when the link drops, without resuming them', async () => {
    const session = await connectNode()
    session.streamOpen('s-drop', `${OWNER_NAMESPACE}/tick`, {})
    await eventually(
      () => (session.framesOfStream('s-drop').some(frame => frame.type === 'stream.data') ? true : undefined),
      'the stream to produce a value',
    )

    coordinator.dropAll()

    // The node releases locally; the socket is gone, so there is nothing to send.
    await eventually(() => (nodeStatus()?.activeStreams === 0 ? true : undefined), 'the stream to be released')
    await eventually(() => (owner.tickAborted ? true : undefined), 'the source to be aborted')

    // A reconnect must not resurrect the stream: v1 has no continuation, and
    // replaying would duplicate every value the Coordinator already saw.
    const second = await eventually(() => {
      const latest = coordinator.sessions.at(-1)
      return coordinator.sessions.length > 1 && latest !== session && latest?.has('hello') === true ? latest : undefined
    }, 'a reconnect')
    await coordinator.acceptHandshake()
    await coordinator.waitForReady(second)
    await delay(150)
    expect(second.framesOfStream('s-drop')).toHaveLength(0)
  }, 30_000)

  it('terminates open streams with node/shutdown when the plugin is disposed', async () => {
    const session = await connectNode()
    session.streamOpen('s-stop', `${OWNER_NAMESPACE}/tick`, {})
    await eventually(
      () => (session.framesOfStream('s-stop').some(frame => frame.type === 'stream.data') ? true : undefined),
      'the stream to produce a value',
    )

    await nodeFiber!.dispose()
    nodeFiber = undefined

    const terminal = await session.waitStreamEnd('s-stop')
    expect(terminal).toMatchObject({ type: 'stream.error' })
    // The Coordinator is told the node is stopping, not left guessing.
    expect((terminal as StreamErrorFrame).error.code).toBe('node/shutdown')
  }, 20_000)

  it('advertises the nodeAdmin management surface like any other capability', async () => {
    const session = await connectNode()
    const ready = session.frame<ReadyFrame>('ready')!
    const endpoints = ready.capabilities.remotes.map(entry => entry.endpoint)

    // The management Remotes travel the same path as everything else: they are in
    // the advertised surface, with `unary` mode.
    expect(endpoints).toContain('nodeAdmin/describe')
    expect(endpoints).toContain('nodeAdmin/fsRead')
    expect(endpoints).toContain('nodeAdmin/skillInstall')
    expect(ready.capabilities.remotes.find(entry => entry.endpoint === 'nodeAdmin/describe')?.mode).toBe('unary')
  }, 20_000)

  it('dispatches nodeAdmin/describe through the real Gateway', async () => {
    const session = await connectNode()
    session.request('req-admin', 'nodeAdmin/describe')

    const result = await coordinator.result('req-admin')
    expect(result.result.ok).toBe(true)
    const value = (result.result as { ok: true; value: Record<string, unknown> }).value
    expect(value['nodeId']).toBe(session.nodeId)
    expect(value['mode']).toBe('full-access')
    expect(value['state']).toBe('ready')
    expect(typeof value['capabilityCount']).toBe('number')
    // Diagnostics never carry the credential or a host path.
    expect(JSON.stringify(value)).not.toContain(TOKEN)
    expect(JSON.stringify(value)).not.toContain(process.cwd())
  }, 20_000)

  it('keeps a nodeAdmin path refusal intact and writes nothing', async () => {
    const session = await connectNode()
    session.request('req-admin-write', 'nodeAdmin/fsWrite', {
      path: join(process.cwd(), '.tmp', 'should-not-exist.txt'),
      content: 'nope',
    })

    const result = await coordinator.result('req-admin-write')
    expect(result.result.ok).toBe(false)
    const failure = (result.result as { ok: false; error: { code: string; message: string } }).error
    // `nodeAdmin/*` is a business code raised by the Remote, so it is reported as
    // such rather than folded into a transport error.
    expect(failure.code).toBe('nodeAdmin/path-denied')
    expect(failure.message).not.toContain(process.cwd())
    await expect(readFile(join(process.cwd(), '.tmp', 'should-not-exist.txt'), 'utf8')).rejects.toThrow()
  }, 20_000)

  it('lets a nodeAdmin write land inside an allowed root, and audits it', async () => {
    const workspace = await mkdtemp(join(process.cwd(), '.tmp', 'admin-ws-'))
    try {
      const session = await connectNode(nodeConfig(coordinator.url, identityFile, { allowedRoots: [workspace] }))
      const target = join(workspace, 'from-coordinator.txt')
      session.request('req-admin-ok', 'nodeAdmin/fsWrite', { path: target, content: 'written remotely' })
      const written = await coordinator.result('req-admin-ok')
      expect(written.result, JSON.stringify(written.result)).toMatchObject({ ok: true })
      expect(await readFile(target, 'utf8')).toBe('written remotely')

      session.request('req-admin-audit', 'nodeAdmin/audit', { limit: 5 })
      const audit = (await coordinator.result('req-admin-audit')).result
      expect(audit, JSON.stringify(audit)).toMatchObject({ ok: true })
      const records = (audit as { ok: true; value: { records: unknown[] } }).value.records
      // The trail records the operation without copying the content or the path.
      const text = JSON.stringify(records)
      expect(text).toContain('nodeAdmin/fsWrite')
      expect(text).not.toContain('written remotely')
      expect(text).not.toContain(workspace)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  }, 20_000)

  it('rejects a malformed endpoint and a malformed payload as protocol errors', async () => {
    const session = await connectNode()
    session.request('req-shape', 'not-an-endpoint')
    session.send({
      type: 'rpc.request',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: session.nodeId,
      requestId: 'req-payload',
      endpoint: `${OWNER_NAMESPACE}/echo`,
      payload: { message: 'unwrapped' },
    })

    const badEndpoint = await coordinator.result('req-shape')
    expect((badEndpoint.result as { error: { code: string } }).error.code).toBe('node/protocol-invalid')
    const badPayload = await coordinator.result('req-payload')
    expect((badPayload.result as { error: { code: string } }).error.code).toBe('node/protocol-invalid')
    expect(owner.calls).toEqual([])
  }, 20_000)

  it('answers a heartbeat ping from the Coordinator', async () => {
    const session = await connectNode()
    session.send({ type: 'ping', protocolVersion: PROTOCOL_VERSION, nodeId: session.nodeId })
    const pong = await eventually(() => session.last('pong'), 'a pong frame')
    expect(pong.type).toBe('pong')
  }, 20_000)

  it('explains a credential refusal in the status snapshot an operator can read', async () => {
    // Spec §7.5: the status must say *why* the link ended. The connector already
    // knows (`snapshot.lastError`), and the host status is the only surface a
    // Coordinator or an operator has (`ctx.dshNode.status`, `nodeAdmin/status`,
    // `nodeAdmin/describe`) — so a refused token must not read as a bare
    // disconnect, or nobody can tell a revoked credential from a network blip.
    const session = await connectNode()
    session.send({
      type: 'close',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: session.nodeId,
      code: 'node/auth-failed',
      reason: 'the node was revoked by an operator',
      reconnect: false,
    })
    session.socket.close(4401, 'the node was revoked by an operator')

    await eventually(
      () => (nodeStatus()?.state === 'auth_failed' ? true : undefined),
      'the node to enter auth_failed',
    )
    const status = nodeStatus()!
    expect(status.lastError?.code).toBe('node/auth-failed')
    expect(status.lastError?.message).toContain('revoked')
    // The snapshot is handed out verbatim, so it must not carry the credential.
    expect(JSON.stringify(status)).not.toContain(TOKEN)
  }, 20_000)

  it('keeps working across a dropped connection by reconnecting outbound', async () => {
    const first = await connectNode()
    coordinator.dropAll()

    // The node reconnects on its own; the Coordinator never dials in.
    const second = await eventually(() => {
      const latest = coordinator.sessions.at(-1)
      return coordinator.sessions.length > 1 && latest !== first && latest?.has('hello') === true ? latest : undefined
    }, 'an outbound reconnect')
    await coordinator.acceptHandshake()
    await coordinator.waitForReady(second)
    await eventually(() => (nodeStatus()?.state === 'ready' ? true : undefined), 'node ready again')
    expect(second.nodeId).toBe(first.nodeId)

    // And the forwarded path still works on the new connection.
    second.request('req-after', `${OWNER_NAMESPACE}/echo`, { message: 'again' })
    const result = await coordinator.result('req-after')
    expect(result.result).toEqual({ ok: true, value: { echoed: 'again', at: 'fixture' } })
  }, 30_000)

  it('fails an in-flight request when the link drops, and never replays it', async () => {
    // A gated owner method keeps the request in flight across the drop.
    let openGate: () => void = () => {}
    owner.gate = new Promise<void>(resolve => { openGate = resolve })

    const session = await connectNode()
    session.request('req-slow', `${OWNER_NAMESPACE}/slow`, {})
    await eventually(
      () => (nodeStatus()?.inFlightRequests === 1 ? true : undefined),
      'the request to be in flight',
    )

    coordinator.dropAll()

    // The node reports the loss locally instead of waiting for a business
    // outcome, so the Coordinator learns about it from the socket closing.
    await eventually(
      () => (nodeStatus()?.inFlightRequests === 0 ? true : undefined),
      'the in-flight request to be released',
    )
    // Exactly one execution: nothing was replayed.
    expect(owner.calls.filter(call => call === 'slow')).toHaveLength(1)

    // Let the business method finish; its transport is long gone, and its result
    // must not be smuggled onto the new connection.
    openGate()
    const second = await eventually(() => {
      const latest = coordinator.sessions.at(-1)
      return coordinator.sessions.length > 1 && latest !== session && latest?.has('hello') === true ? latest : undefined
    }, 'a reconnect')
    await coordinator.acceptHandshake()
    await coordinator.waitForReady(second)
    await delay(150)
    expect(second.frames.some(frame => frame.type === 'rpc.result')).toBe(false)
  }, 30_000)

  it('releases the socket and the service when the plugin is disposed', async () => {
    const session = await connectNode()
    const socket = session.socket
    expect(socket.readyState).toBe(1)

    await nodeFiber!.dispose()
    nodeFiber = undefined

    await eventually(() => (socket.readyState === 3 ? true : undefined), 'the socket to close')
    // The provided service is gone with the fiber.
    expect(root.get('dshNode', false)).toBeUndefined()

    // No reconnect timer survived: the Coordinator sees no further connection.
    const seen = coordinator.sessions.length
    await delay(500)
    expect(coordinator.sessions.length).toBe(seen)
  }, 20_000)

  it('does not connect at all while the URL or token is missing', async () => {
    const bare = new Context()
    try {
      await bare.plugin(TypertRegistry)
      await bare.plugin(TypertGatewayService, { websocketHeartbeatIntervalMs: 2_000 })
      await bare.plugin(NODE_PLUGIN, { identityFile })
      const node = await eventually(
        () => bare.get('dshNode', false) as unknown as { status: NodeStatusView } | undefined,
        'the dshNode service',
      )
      await delay(300)

      expect(node.status.state).toBe('unconfigured')
      expect(coordinator.sessions).toHaveLength(0)
      // The id is available *before* the first connection, which is what lets the
      // status panel show the operator the value they must approve on the Coordinator
      // side. Without it, first-run configuration is a chicken-and-egg problem.
      expect(node.status.nodeId).toMatch(/^node-[0-9a-f]{32}$/u)
    } finally {
      await bare.fiber.dispose()
    }
  }, 20_000)

  it('refuses an invalid configuration without opening a socket', async () => {
    const bare = new Context()
    try {
      await bare.plugin(TypertRegistry)
      await bare.plugin(TypertGatewayService, { websocketHeartbeatIntervalMs: 2_000 })
      await bare.plugin(NODE_PLUGIN, { coordinatorUrl: 'https://example.com/node', auth: { token: TOKEN }, identityFile })
      const node = await eventually(
        () => bare.get('dshNode', false) as unknown as { status: NodeStatusView } | undefined,
        'the dshNode service',
      )
      await delay(300)

      expect(node.status.state).toBe('stopped')
      expect(node.status.lastError?.code).toBe('node/config-invalid')
      expect(JSON.stringify(node.status)).not.toContain(TOKEN)
      expect(coordinator.sessions).toHaveLength(0)
    } finally {
      await bare.fiber.dispose()
    }
  }, 20_000)

  it('connects on the document the panel writes, with no configuration in the bootstrap', async () => {
    // The panel's whole promise: type two values into the sidebar, and the node is
    // connected. This is that promise expressed as a boot — the file exists, the
    // bootstrap carries nothing but an identity file, and a real handshake must
    // still complete.
    const file = resolveConfigFile(process.env)
    await writeConfigFile(file, { coordinatorUrl: coordinator.url, token: TOKEN, nodeName: 'from-the-panel' })
    try {
      nodeFiber = await mount(NODE_PLUGIN, { identityFile })
      const session = await coordinator.acceptHandshake()
      await coordinator.waitForReady(session)
      const hello = session.frame<HelloFrame>('hello')
      expect(hello?.auth.token).toBe(TOKEN)
      expect(hello?.nodeName).toBe('from-the-panel')
    } finally {
      await rm(file, { force: true })
    }
  }, 20_000)

  it('lets the stored document win over the profile it was started with', async () => {
    // Precedence, as the panel's "save" depends on it: a save that a profile value
    // could override would be a save that appears to work and changes nothing. The
    // bogus URL below is the profile's; the node must ignore it and use the file's.
    const file = resolveConfigFile(process.env)
    await writeConfigFile(file, { coordinatorUrl: coordinator.url, token: TOKEN })
    try {
      nodeFiber = await mount(NODE_PLUGIN, nodeConfig('ws://127.0.0.1:1/node', identityFile))
      const session = await coordinator.acceptHandshake()
      await coordinator.waitForReady(session)
      expect(nodeStatus()?.state).toBe('ready')
      expect(nodeStatus()?.coordinatorOrigin).toBe(new URL(coordinator.url).origin)
    } finally {
      await rm(file, { force: true })
    }
  }, 20_000)
})

describe('architecture guards (spec §1.1, §9.3, §15)', () => {
  const sourceDir = fileURLToPath(new URL('../src/', import.meta.url))

  /**
   * Every source module under `src/`, recursively.
   *
   * Recursive on purpose: a flat `readdir` silently skipped `src/admin/`, which is
   * the subdirectory holding every capability that can change this machine — the
   * one place these guards matter most.
   */
  async function readSources(): Promise<{ name: string; text: string }[]> {
    const entries = await readdir(sourceDir, { withFileTypes: true, recursive: true })
    // `.tsx` too: the client half is React, and a filter that only knew `.ts`
    // would silently skip exactly the files the newest guards are about — the same
    // class of mistake as the flat `readdir` this comment already records.
    const files = entries.filter(entry => entry.isFile() && /\.tsx?$/u.test(entry.name))
    expect(files.length).toBeGreaterThan(0)
    return Promise.all(
      files.map(async entry => {
        const full = join(entry.parentPath, entry.name)
        return { name: full.slice(sourceDir.length).replace(/\\/gu, '/'), text: await readFile(full, 'utf8') }
      }),
    )
  }

  it('actually scans the management subdirectory', async () => {
    const names = (await readSources()).map(source => source.name)
    expect(names).toContain('admin/service.ts')
    expect(names).toContain('admin/path-policy.ts')
    expect(names).toContain('admin/audit.ts')
  })

  it('opens no inbound listener of any kind', async () => {
    const sources = await readSources()
    expect(sources.length).toBeGreaterThanOrEqual(12)
    for (const source of sources) {
      // Still absolute: this plugin never creates a listener. The status route it
      // added later rides DSH's *existing* Web server (see the next test); it does
      // not open one of its own, which is the property the whole design rests on.
      expect(source.text, source.name).not.toMatch(/WebSocketServer/)
      expect(source.text, source.name).not.toMatch(/createServer\s*\(/)
      expect(source.text, source.name).not.toMatch(/\.listen\s*\(/)
      // An upgrade handler would be a second protocol surface; a fallback would
      // swallow every unrouted request. Neither is ever wanted here.
      expect(source.text, source.name).not.toMatch(/registerUpgrade|registerFallback/)
    }
  })

  it('uses DSH\'s Web server for exactly one read-only prefix route', async () => {
    // The route was added for the footer entry, so the invariant changed shape and
    // is pinned precisely instead of being dropped: `webServer` may appear, but only
    // as a `kind: 'prefix'` registration in the one module that wires it, and the
    // handler it registers must be the read-only one.
    const sources = await readSources()
    const users = sources.filter(source => /webServer/u.test(source.text)).map(source => source.name)
    expect(users).toContain('index.ts')
    // Direct registration is confined to index.ts; http-api.ts only *names* it in
    // prose, so the pattern requires a call — a guard that tripped on a comment
    // would be a guard nobody could keep.
    const registrars = sources.filter(source => /webServer\.register\s*\(/u.test(source.text)).map(source => source.name)
    expect(registrars).toEqual(['index.ts'])
    expect(sources.find(source => source.name === 'index.ts')?.text).toContain("kind: 'prefix'")

    for (const source of sources) {
      expect(source.text, source.name).not.toMatch(/kind:\s*'upgrade'/)
      expect(source.text, source.name).not.toMatch(/kind:\s*'fallback'/)
    }
    // The single route is a prefix on the plugin's own namespace, and its handler
    // is the fenced, GET-only one.
    expect(nodePlugin.NODE_ROUTE_PREFIX).toBe('/dsh-node')
    expect(sources.find(source => source.name === 'index.ts')?.text).toContain('createNodeRouteHandler')
  })

  it('keeps DOM globals out of the host half', async () => {
    // `tsconfig` has to include `DOM` for the client half to compile, which would
    // otherwise silently let host code touch `document`. The split is pinned here.
    const sources = await readSources()
    const client = sources.filter(source => source.name.startsWith('client/'))
    // Assert the client half is actually present, so a rename cannot make this test
    // pass by scanning nothing — the mistake the recursive-readdir fix addressed.
    expect(client.map(source => source.name).sort()).toEqual([
      'client/ConfigPanel.tsx',
      'client/NodeStatusEntry.tsx',
      'client/config-source.ts',
      'client/index.tsx',
      'client/mapping.ts',
      'client/status-source.ts',
    ])
    for (const source of sources) {
      if (source.name.startsWith('client/')) continue
      // Usage, not the word: `document.` needs a member name after it, so prose like
      // "the persisted identity document." does not trip the guard.
      expect(source.text, source.name).not.toMatch(/(?<![.\w])document\.[A-Za-z_$]/u)
      expect(source.text, source.name).not.toMatch(/(?<![.\w])window\.[A-Za-z_$]/u)
      expect(source.text, source.name).not.toMatch(/(?<![.\w])navigator\.[A-Za-z_$]/u)
      expect(source.text, source.name).not.toMatch(/\blocalStorage\b|\bsessionStorage\b/)
      // A host file importing the client half would drag React into the Node bundle.
      expect(source.text, source.name).not.toMatch(/from '\.\/client\//)
    }
  })

  it('declares the client half the way the module system expects', async () => {
    const manifest = JSON.parse(
      await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { exports?: Record<string, unknown>; dsh?: { client?: { platform?: string; inject?: string[] } } }
    expect(manifest.exports?.['./client']).toBeDefined()
    expect(manifest.dsh?.client?.platform).toBe('web')
    // The trap that took a neighbouring plugin's footer entry down on this machine:
    // `@deepseek-ai/dsh-client-runtime` does not exist in `0.1.5-rc.2`, and a client
    // bundle that asks for it never loads.
    for (const injected of manifest.dsh?.client?.inject ?? []) {
      expect(injected).not.toBe('@deepseek-ai/dsh-client-runtime')
    }
    expect(manifest.dsh?.client?.inject).toContain('@deepseek-ai/dsh-client-ui-slots')
  })

  it('exports ./package.json, without which the client half is silently dropped', async () => {
    // This cost a whole debugging round, so it is pinned here with its reason.
    // `@deepseek-ai/dsh-client-modules` locates a plugin's manifest with
    // `createRequire(baseUrl).resolve('<name>/package.json')`. Once a package has an
    // `exports` map that subpath is **blocked unless it is exported**, the lookup
    // fails, the composition is skipped, and **nothing is logged**: the plugin keeps
    // running on the host and simply never appears in the browser. Both working
    // plugins on this machine (`dsh-drawio`, `dsh-better-sidebar`) export it;
    // `dsh-skillui` does not, and its client half is missing for exactly this reason.
    const manifest = JSON.parse(
      await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { exports?: Record<string, unknown> }
    expect(manifest.exports?.['./package.json']).toBe('./package.json')

    // And exercise the lookup this guard protects, so the assertion above cannot pass
    // while resolution is broken for some other reason.
    const { createRequire } = await import('node:module')
    const resolveFromRepo = createRequire(fileURLToPath(new URL('../', import.meta.url)))
    expect(resolveFromRepo.resolve('dsh-node/package.json')).toContain('dsh-node')
  })

  it('contains no shell, eval, or arbitrary module-loading channel', async () => {
    for (const source of await readSources()) {
      expect(source.text, source.name).not.toMatch(/child_process/)
      expect(source.text, source.name).not.toMatch(/\bexecSync\b|\bspawnSync\b|\bspawn\s*\(/)
      expect(source.text, source.name).not.toMatch(/\beval\s*\(/)
      expect(source.text, source.name).not.toMatch(/new\s+Function\s*\(/)
      expect(source.text, source.name).not.toMatch(/\brequire\s*\(/)
      expect(source.text, source.name).not.toMatch(/\bimport\s*\(/)
      expect(source.text, source.name).not.toMatch(/\bcreateRequire\b/)
    }
  })

  it('takes no runtime dependency on an official DSH package', async () => {
    for (const source of await readSources()) {
      // The real invariant is "type-only": a `@deepseek-ai/*` import must be erased
      // by the compiler, because an out-of-tree plugin cannot assume any official
      // package is resolvable next to it at runtime. `@deepseek-ai/cordis` is a
      // declared peerDependency, and `@deepseek-ai/dsh-typert-protocol` is a
      // devDependency used for descriptor types only.
      const imports = source.text.match(/^import[^\n]*from\s+'([^']+)'/gmu) ?? []
      for (const statement of imports) {
        const specifier = /from\s+'([^']+)'/u.exec(statement)?.[1] ?? ''
        if (!specifier.startsWith('@deepseek-ai/')) continue
        expect(/^import\s+type\b/u.test(statement), `${source.name}: ${statement}`).toBe(true)
      }
    }
  })

  it('keeps official packages out of the runtime dependency list', async () => {
    const manifest = JSON.parse(
      await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> }
    // Runtime dependencies must be resolvable by the plugin alone.
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      expect(name.startsWith('@deepseek-ai/'), name).toBe(false)
    }
    // The only official peer is the one the plugin is hosted by. `react` is the
    // client half's peer: the page's module table supplies it, so it is declared
    // (to state the requirement) but never bundled and never a runtime import.
    expect(Object.keys(manifest.peerDependencies ?? {}).sort()).toEqual(['@deepseek-ai/cordis', 'react'])
  })

  it('reads and writes the filesystem only through the policy fence', async () => {
    const sources = await readSources()
    // Exactly two files own a path of their own, and both derive it from `DSH_HOME`
    // with a hard-coded name: `identity.ts` (the node id) and `config-file.ts` (the
    // settings the panel writes). Neither takes a path from a caller. Every *other*
    // filesystem access in this plugin goes through `admin/`, whose policy fence
    // decides each path before it is touched.
    const owners = new Set(['identity.ts', 'config-file.ts'])
    for (const source of sources) {
      if (!/from 'node:fs\/promises'/u.test(source.text)) continue
      const allowed = owners.has(source.name) || source.name.startsWith('admin/')
      expect(allowed, `${source.name} imports node:fs/promises`).toBe(true)
    }
    // The one write route's own module must never touch the disk. It validates a body
    // and hands the document to the service, which is what keeps "a path from a
    // request" from being a thing that can exist here.
    expect(sources.find(source => source.name === 'http-api.ts')?.text).not.toMatch(/node:fs/)
    // And the file the panel writes is pinned to `DSH_HOME` with a fixed name.
    const configFile = sources.find(source => source.name === 'config-file.ts')?.text ?? ''
    expect(configFile).toContain('resolveDshHome')
    expect(configFile).toContain("CONFIG_FILE_NAME = 'config.json'")
  })

  it('declares exactly one mode, so no second privilege level can be forged', () => {
    expect([...NODE_MODES]).toEqual(['full-access'])
  })

  it('keeps the reported plugin version equal to package.json', async () => {
    const manifest = JSON.parse(
      await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { version: string }
    // `nodeAdmin/describe` reports this, so a drift would make a Coordinator
    // reason about a version that is not the one running.
    expect(nodePlugin.PLUGIN_VERSION).toBe(manifest.version)
  })
})
