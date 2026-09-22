/**
 * `dsh-node` — the outbound WebSocket adapter for this machine's Typert Gateway.
 *
 * This plugin does one thing: it opens **one outbound** `ws://` or `wss://`
 * connection to a Coordinator and forwards structured Remote calls into
 * `ctx.typertGateway`. It opens no listening socket, spawns no process, evaluates
 * no string, loads no module by name, and reads no path. The capabilities it can
 * offer are exactly the Remotes the running DSH profile already registered, and
 * every argument set is validated by the Gateway, not by this plugin (spec §2.2,
 * §9.3).
 *
 * Phase 1 scope: unary Remotes, handshake, heartbeat, reconnect, cancellation,
 * timeouts. Streams and backpressure are Phase 2 and are not implemented or
 * advertised here.
 *
 * @module dsh-node
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ADMIN_DESCRIPTORS, ADMIN_SERVICE_KEY, NodeAdminOwner } from './admin/service.js'
import { resolveNodeConfig, Config, type DshNodeRuntimeConfig, type NodeConfigResolution } from './config.js'
import { mergeNodeConfig, resolveConfigFile, type ConnectionIntent, type StoredNodeConfig } from './config-file.js'
import { NodeConfigService, loadStoredConfig } from './config-service.js'
import {
  Connector,
  type ConnectorOptions,
  type ConnectorDelegate,
  type NodeSocketFactory,
  type NodeTimers,
} from './connector.js'
import { NodeError, RemoteCodeError, nodeFailure, type NodeFailure } from './errors.js'
import { capabilitySurfaceHash, parseEndpoint, parseRequestArgs } from './frame-codec.js'
import { loadOrCreateIdentity, resolveIdentityFile, type NodeIdentity } from './identity.js'
import {
  createNodeRouteHandler,
  NODE_ROUTE_PREFIX,
  type NodeConfigSurface,
  type NodeConnectionSurface,
  type NodeDiagnostics,
  type NodeStatusView,
} from './http-api.js'
import {
  PROTOCOL_VERSION,
  type DshNodeStatus,
  type HelloFrame,
  type HelloOkFrame,
  type InboundFrame,
  type NodeCapability,
  type NodeCapabilitySummary,
  type ReadyFrame,
  type RpcRequestFrame,
  type RpcResultFrame,
  type StreamCancelFrame,
  type StreamOpenFrame,
} from './protocol.js'
import { RequestManager, type PendingRequest } from './request-manager.js'
import { StreamManager, type StreamEvent, type StreamManagerTimers } from './stream-manager.js'
import { cordisLogSink, createNodeLogger, statusSnapshot, type NodeLogger, type NodeLogSink } from './status.js'

export { Config, resolveNodeConfig } from './config.js'
export type { DshNodeRuntimeConfig, NodeConfigResolution } from './config.js'
export { NodeError, RemoteCodeError, nodeFailure } from './errors.js'
export { loadOrCreateIdentity, generateNodeId, resolveIdentityFile } from './identity.js'
export { RequestManager } from './request-manager.js'
export { Connector, createNodeTimers } from './connector.js'
export { createNodeLogger, redactUrl, scrubText, REDACTED } from './status.js'
export { createNodeRouteHandler, NODE_ROUTE_PREFIX, HttpFailure, MAX_CONFIG_BODY_BYTES } from './http-api.js'
export type { NodeConfigSurface, NodeConfigView, NodeConnectionSurface, NodeDiagnostics, NodeRouteDeps, NodeStatusView } from './http-api.js'
export {
  CONFIG_FILE_NAME,
  CONFIG_FILE_VERSION,
  describeStoredConfig,
  mergeNodeConfig,
  readConfigFile,
  resolveConfigFile,
  writeConfigFile,
} from './config-file.js'
export type { ConfigFileRead, ConnectionIntent, StoredNodeConfig } from './config-file.js'
export { foldSubmission, loadStoredConfig, NodeConfigService, readSubmission } from './config-service.js'
export { isLoopbackHostname, isTrustedNodeRequest } from './net/trust-fence.js'
export * from './protocol.js'

/** Host-half plugin name. Must equal the package name. */
export const name = 'dsh-node'

/**
 * Hard dependencies.
 *
 * The whole point of this plugin is forwarding through the Gateway, and a node
 * that started before the Gateway existed would have to advertise an empty
 * surface. `typert` is the registry the advertised surface is read from; the
 * Gateway injects it too, so declaring both costs nothing and makes every
 * dependency explicit. Cordis holding this plugin back until both are active is
 * also how spec §6.2's "delay `ready` until the local Gateway is ready" is
 * enforced.
 */
export const inject = ['typertGateway', 'typert'] as const

/**
 * Gateway codes that mean "this node has no such capability".
 *
 * Only the *availability* family is folded into `node/capability-unavailable`.
 * Every other `gateway/*` code — `arguments-invalid`, `signature-invalid`,
 * `result-invalid`, `context-not-found`, `binding-invalid`,
 * `ambiguous-endpoint`, `cancelled`, ... — and every business code such as
 * `session/not-found` keeps its identity, message, and details, because folding
 * them together would destroy the diagnostic the Coordinator needs (spec §10).
 */
export const CAPABILITY_FAILURE_CODES: ReadonlySet<string> = new Set([
  'gateway/invocation-unavailable',
  'gateway/method-unavailable',
  'gateway/service-unavailable',
  'gateway/definition-unavailable',
])

/** The slice of `ctx.typertGateway` this plugin uses. Structural on purpose. */
export interface TypertGatewayLike {
  invoke(request: {
    readonly namespace: string
    readonly method: string
    readonly args: Readonly<Record<string, unknown>>
    readonly signal?: AbortSignal
  }): Promise<unknown>
  /** Opens one stream Remote; the descriptor's mode must be `stream`. */
  stream(request: {
    readonly namespace: string
    readonly method: string
    readonly args: Readonly<Record<string, unknown>>
    readonly signal?: AbortSignal
  }): Promise<AsyncIterable<unknown>>
  readonly wireStream: {
    failure(error: unknown): { readonly code: string; readonly message: string; readonly details: object }
  }
}

/** One descriptor as `ctx.typert.local.list()` reports it. */
export interface InvocationDescriptorLike {
  readonly namespace: string
  readonly method: string
  /** Absent for unary invocations; `stream` for stream invocations. */
  readonly mode?: string
}

/** The slice of `ctx.typert` this plugin uses. Structural on purpose. */
export interface TypertRegistryLike {
  readonly local: {
    get(endpoint: string): InvocationDescriptorLike | undefined
    hasSeen(endpoint: string): boolean
    list(): readonly InvocationDescriptorLike[]
    subscribe?(listener: (change: { readonly kind: string; readonly key: string }) => void): () => void
  }
}

/** Host context this plugin requires. */
export type NodeHostContext = Context & { typertGateway: TypertGatewayLike }

/**
 * The capabilities this node will dispatch.
 *
 * Two sources, both public:
 *
 * 1. `ctx.typert.local.list()` — every invocation registered through generated
 *    Typert artifacts. This yields complete endpoints, so the advertised summary
 *    is exact for them.
 * 2. The public `typertRemote` binding that `TypertRemoteService` sets on
 *    source-mode services ("Visible binding consumed by the Gateway's
 *    source-mode discovery"). That gives a *namespace* but not the method names,
 *    because the marker table is module-private to
 *    `@deepseek-ai/dsh-typert-protocol` and this plugin deliberately takes no
 *    runtime dependency on official packages. Method names in those namespaces
 *    are therefore resolved by the Gateway, and its availability failure is
 *    mapped back to `node/capability-unavailable`.
 *
 * The union is what keeps a source-mode plugin callable without making this
 * plugin guess, and it is why the gate never has to be bypassed.
 */
export interface CapabilityIndex {
  /** Fully enumerated endpoints, as `${namespace}/${method}`. */
  readonly endpoints: ReadonlySet<string>
  /** Every namespace this node will attempt to dispatch. */
  readonly namespaces: ReadonlySet<string>
  /** Namespaces with no enumerable endpoint: source-mode services. */
  readonly opaqueNamespaces: ReadonlySet<string>
  /** What the `ready` frame advertises. */
  readonly summary: NodeCapabilitySummary
  /** Sorted endpoint+mode pairs, also used for the surface digest. */
  readonly remotes: readonly NodeCapability[]
}

/** Build the capability index from the live registry. */
export function collectCapabilities(ctx: Context): CapabilityIndex {
  const endpoints = new Set<string>()
  const namespaces = new Set<string>()
  const opaqueNamespaces = new Set<string>()
  const remotes: NodeCapability[] = []

  const registry = getTypertRegistry(ctx)
  if (registry !== undefined) {
    try {
      for (const descriptor of registry.local.list()) {
        if (typeof descriptor.namespace !== 'string' || typeof descriptor.method !== 'string') continue
        const endpoint = `${descriptor.namespace}/${descriptor.method}`
        endpoints.add(endpoint)
        namespaces.add(descriptor.namespace)
        remotes.push({ endpoint, mode: descriptor.mode === 'stream' ? 'stream' : 'unary' })
      }
    } catch {
      // A registry that throws must not take the connection down; the node then
      // simply advertises less and the Gateway remains the final authority.
    }
  }

  for (const namespace of sourceModeNamespaces(ctx)) {
    namespaces.add(namespace)
    if (!remotes.some(entry => entry.endpoint.startsWith(`${namespace}/`))) opaqueNamespaces.add(namespace)
  }

  remotes.sort((left, right) => (left.endpoint < right.endpoint ? -1 : left.endpoint > right.endpoint ? 1 : 0))
  const sortedNamespaces = [...namespaces].sort()
  return {
    endpoints,
    namespaces,
    opaqueNamespaces,
    remotes,
    summary: {
      remotes,
      remoteSurfaceHash: capabilitySurfaceHash(remotes, [...opaqueNamespaces].sort()),
      namespaces: sortedNamespaces,
    },
  }
}

/**
 * Enumerate namespaces exposed by source-mode services.
 *
 * Reads only the *public* `typertRemote` binding, defensively: a missing or
 * unexpected shape is skipped rather than reflected further. No private field is
 * touched, and no official package is imported.
 */
function sourceModeNamespaces(ctx: Context): string[] {
  const namespaces = new Set<string>()
  const reflect = (ctx as { reflect?: { props?: Record<string, { type?: string }> } }).reflect
  const props = reflect?.props
  if (props === undefined || props === null) return []

  for (const [serviceKey, definition] of Object.entries(props)) {
    if (definition?.type !== 'service') continue
    let receiver: unknown
    try {
      receiver = (ctx as unknown as { get(key: string, strict?: boolean): unknown }).get(serviceKey, false)
    } catch {
      continue
    }
    const binding = readTypertRemoteBinding(receiver)
    if (binding !== undefined) namespaces.add(binding)
  }
  return [...namespaces]
}

/** Read the public `typertRemote` namespace from a service, if it has one. */
function readTypertRemoteBinding(receiver: unknown): string | undefined {
  if (typeof receiver !== 'object' || receiver === null) return undefined
  let binding: unknown
  try {
    binding = Reflect.get(receiver, 'typertRemote')
  } catch {
    return undefined
  }
  if (typeof binding !== 'object' || binding === null) return undefined
  const namespace = Reflect.get(binding, 'namespace')
  if (typeof namespace !== 'string' || namespace === '') return undefined
  // The binding must point at this very object, mirroring how the Gateway
  // validates it: a stale or forged binding is not evidence of a capability.
  const service = Reflect.get(binding, 'service')
  return service === receiver ? namespace : undefined
}

/** Read the optional `ctx.typert` service. */
function getTypertRegistry(ctx: Context): TypertRegistryLike | undefined {
  try {
    return (ctx as unknown as { get(key: string, strict?: boolean): unknown }).get('typert', false) as
      | TypertRegistryLike
      | undefined
  } catch {
    return undefined
  }
}

/**
 * Injected collaborators, so tests can drive the host without a network.
 *
 * Every field is optional and each defaults to the production implementation.
 */
export interface DshNodeHostOptions {
  /** Host context carrying `typertGateway`. */
  readonly ctx: NodeHostContext
  /** Raw deployment input, resolved with {@link resolveNodeConfig} unless a resolution is given. */
  readonly bootstrap?: unknown
  /** Persisted manual decision; active by default. */
  readonly connectionIntent?: ConnectionIntent
  /** Pre-resolved configuration, for tests that want to fix the environment. */
  readonly resolution?: NodeConfigResolution
  /** Environment mapping used for config and identity resolution. */
  readonly env?: NodeJS.ProcessEnv
  /** Log destination; defaults to `console`. */
  readonly logSink?: NodeLogSink
  /** Socket factory; defaults to a real `ws` client. */
  readonly createSocket?: NodeSocketFactory
  /** Timer source; defaults to real timers. */
  readonly timers?: NodeTimers
  /** Timer source for stream draining; defaults to real timers. */
  readonly streamTimers?: StreamManagerTimers
  /** Uniform random in `[0, 1)`; defaults to `Math.random`. */
  readonly random?: () => number
  /** Clock; defaults to `Date.now`. */
  readonly now?: () => number
}

/**
 * The node's in-process coordinator.
 *
 * Deliberately **not** a typed Remote: exporting one would require assembling it
 * into `packages/api/remotes`, which is impossible for an out-of-tree plugin
 * against a read-only installed core (see `docs/GROUND-TRUTH.md`). It is a plain
 * Cordis service, which is enough for logging, diagnosis, and tests.
 */
export class DshNodeHost implements ConnectorDelegate {
  /** Host context, exposed so callers can reach the Gateway through it. */
  readonly ctx: NodeHostContext
  /** The resolution this host was built from. */
  readonly resolution: NodeConfigResolution

  private readonly env: NodeJS.ProcessEnv
  private readonly logger: NodeLogger
  private readonly hostOptions: DshNodeHostOptions
  private readonly requests: RequestManager
  private readonly streams: StreamManager

  private identity: NodeIdentity | undefined
  private connector: Connector | undefined
  private capabilityIndex: CapabilityIndex | undefined
  private capabilitiesStale = true
  private running = false
  private connectionIntent: ConnectionIntent
  private lastState: DshNodeStatus['state']

  private currentError: { code: string; message: string; at: string } | undefined
  /** Construction time, so `nodeAdmin/describe` can report an uptime. */
  private readonly startedAtMs: number

  /**
   * @param options - context, configuration source, and injectable environment.
   */
  constructor(options: DshNodeHostOptions) {
    this.ctx = options.ctx
    this.env = options.env ?? process.env
    this.hostOptions = options
    this.connectionIntent = options.connectionIntent ?? 'active'
    this.resolution = options.resolution ?? resolveNodeConfig(options.bootstrap, this.env)
    // Prefer the harness logger over `console`: `console.log` never reaches the
    // DSH log file, so a node logging only there is invisible to the operator in
    // exactly the situation where they need to see it (no Coordinator, no UI).
    const sink = options.logSink ?? cordisLogSink((this.ctx as unknown as { logger?: unknown }).logger)
    this.logger = createNodeLogger({
      secrets: this.resolution.config.token === undefined ? [] : [this.resolution.config.token],
      ...(sink === undefined ? {} : { sink }),
      env: this.env,
    })
    this.requests = new RequestManager({
      maxInFlight: this.resolution.config.maxInFlightRequests,
      timeoutMs: this.resolution.config.requestTimeoutMs,
      onTimeout: pending => {
        this.logger.warn('dsh-node/request-completed', {
          requestId: pending.requestId,
          endpoint: pending.endpoint,
          outcome: 'timeout',
          code: 'node/request-timeout',
        })
      },
    })
    this.streams = new StreamManager({
      nodeId: () => this.nodeId,
      maxStreams: this.resolution.config.maxStreams,
      maxFrameBytes: this.resolution.config.maxFrameBytes,
      maxBufferedBytesPerStream: this.resolution.config.maxBufferedBytesPerStream,
      sendStallTimeoutMs: this.resolution.config.sendStallTimeoutMs,
      send: frame => this.connector?.send(frame) ?? false,
      // The connector's own socket buffer is the only real backpressure signal
      // available; it is connection-wide, so it bounds how far ahead one stream
      // may run rather than attributing bytes to that stream.
      bufferedBytes: () => this.connector?.bufferedBytes ?? 0,
      failureOf: error => {
        const gateway = this.gateway()
        return gateway === undefined ? nodeFailure(error) : this.failureOf(gateway, error, 'stream')
      },
      ...(options.streamTimers === undefined ? {} : { timers: options.streamTimers }),
      onEvent: event => this.onStreamEvent(event),
    })
    this.lastState = this.resolution.status === 'ok'
      ? this.connectionIntent === 'paused' ? 'paused' : 'stopped'
      : 'unconfigured'
    this.startedAtMs = this.now()
  }

  /** The current configuration. */
  get config(): DshNodeRuntimeConfig {
    return this.resolution.config
  }

  /** Stable node identity, available once {@link DshNodeHost.start} has resolved it. */
  get nodeId(): string {
    return this.identity?.nodeId ?? ''
  }

  /** Secret-free status snapshot (spec §11). */
  get status(): DshNodeStatus {
    const snapshot = this.connector?.snapshot
    return statusSnapshot({
      state: this.lastState,
      nodeId: this.nodeId,
      nodeName: this.config.nodeName,
      role: this.config.role,
      coordinatorUrl: this.config.coordinatorUrl,
      connectionId: snapshot?.connectionId,
      reconnectAttempt: snapshot?.reconnectAttempt ?? 0,
      lastConnectedAt: snapshot?.lastConnectedAt,
      // Host-level failures win (an unusable config or identity file is the more
      // specific cause), but a connection-level failure must not be lost: the
      // connector knows why the link ended — `node/auth-failed` after a credential
      // refusal, `node/handshake-timeout`, `node/protocol-invalid` — and this
      // snapshot is the *only* surface an operator or a Coordinator can read
      // (`ctx.dshNode.status()`, `nodeAdmin/status`, `nodeAdmin/describe`).
      // Without the fallback a revoked token is indistinguishable from any other
      // disconnect, which is precisely what spec §7.5 forbids.
      lastError: this.currentError ?? snapshot?.lastError,
      secrets: this.config.token === undefined ? [] : [this.config.token],
      inFlightRequests: this.requests.size,
      activeStreams: this.streams.size,
    })
  }

  /** Number of unary requests currently executing. */
  get inFlightRequests(): number {
    return this.requests.size
  }

  /** Number of streams currently open. */
  get activeStreams(): number {
    return this.streams.size
  }

  /** The persisted manual connection decision. */
  get connectionMode(): ConnectionIntent {
    return this.connectionIntent
  }

  /** When this host was constructed, for the uptime the diagnostics report. */
  get startedAt(): number {
    return this.startedAtMs
  }

  /**
   * The capability summary as it stands right now.
   *
   * Rebuilt on demand rather than cached for callers: `nodeAdmin/capabilities`
   * must answer with what the node can actually dispatch at that moment.
   */
  capabilitySummary(): NodeCapabilitySummary {
    return this.ensureCapabilities().summary
  }

  /** Log one stream observation. Values never appear here, only counts and codes. */
  private onStreamEvent(event: StreamEvent): void {
    const fields = {
      nodeId: this.nodeId,
      streamId: event.streamId,
      ...(event.endpoint === undefined ? {} : { endpoint: event.endpoint }),
      ...(event.count === undefined ? {} : { count: event.count }),
      ...(event.code === undefined ? {} : { code: event.code }),
      ...(event.detail === undefined ? {} : { detail: event.detail }),
    }
    switch (event.kind) {
      case 'backpressure':
        this.logger.error('dsh-node/protocol-error', { ...fields, reason: 'terminating a stream the Coordinator is not consuming' })
        return
      case 'failed':
        this.logger.warn('dsh-node/stream-closed', { ...fields, outcome: 'error' })
        return
      case 'ended':
        this.logger.info('dsh-node/stream-closed', { ...fields, outcome: 'ended' })
        return
      case 'cancelled':
        this.logger.info('dsh-node/stream-closed', { ...fields, outcome: 'cancelled' })
        return
      default:
        this.logger.debug('dsh-node/stream-closed', { ...fields, outcome: event.kind })
        return
    }
  }

  /**
   * Resolve identity and configuration and begin connecting.
   *
   * Idempotent: a second call awaits the first. An `unconfigured` or `invalid`
   * resolution deliberately creates no connector, so no socket and no reconnect
   * timer exists.
   * @returns when the node has either started connecting or settled into a
   * non-connecting state.
   */
  async start(): Promise<void> {
    if (this.running) return
    this.running = true

    for (const warning of this.resolution.warnings) this.logger.warn('dsh-node/state-changed', { warning })

    if (this.resolution.status !== 'ok') {
      // Best-effort, and deliberately not fatal here. The node id is needed *before*
      // the first connection — approving this node on the Coordinator takes that id,
      // and a panel that cannot show it until after a successful connect leaves the
      // operator with no way to configure anything. A failure is swallowed because a
      // corrupt identity file must not turn "not configured yet" into an error state.
      await this.loadIdentityQuietly()
    }

    if (this.resolution.status === 'invalid') {
      for (const error of this.resolution.errors) {
        this.logger.error('dsh-node/state-changed', { state: 'stopped', reason: error, code: 'node/config-invalid' })
      }
      this.currentError = {
        code: 'node/config-invalid',
        message: this.resolution.errors.join('; '),
        at: new Date(this.now()).toISOString(),
      }
      this.lastState = 'stopped'
      return
    }
    if (this.resolution.status === 'unconfigured') {
      this.logger.info('dsh-node/state-changed', {
        state: 'unconfigured',
        reason: 'coordinatorUrl or token is not configured; no connection is attempted and no reconnect is scheduled',
        nodeId: this.nodeId,
      })
      this.lastState = 'unconfigured'
      return
    }

    try {
      this.identity = await loadOrCreateIdentity({
        file: resolveIdentityFile(this.env, this.config.identityFile),
        configuredNodeId: this.config.nodeId,
      })
    } catch (error) {
      const failure = nodeFailure(error)
      this.currentError = { code: failure.code, message: failure.message, at: new Date(this.now()).toISOString() }
      this.lastState = 'stopped'
      this.logger.error('dsh-node/state-changed', { state: 'stopped', reason: failure.message, code: failure.code })
      return
    }

    this.subscribeToRegistry()
    this.ensureCapabilities()
    this.connector = new Connector(this.connectorOptions())
    this.logger.info('dsh-node/state-changed', {
      state: 'stopped',
      reason: 'starting outbound connector',
      nodeId: this.nodeId,
      mode: this.config.mode,
      endpoints: this.capabilityIndex?.remotes.length ?? 0,
    })
    if (this.connectionIntent === 'paused') {
      this.lastState = 'paused'
      this.logger.info('dsh-node/state-changed', {
        state: 'paused',
        reason: 'manual disconnect is persisted; waiting for an explicit connect action',
        nodeId: this.nodeId,
      })
    } else {
      this.connector.start()
      this.lastState = this.connector.state
    }
  }

  /**
   * Load the identity file without letting a failure change the node's state.
   *
   * Used on the paths that never connect. See {@link DshNodeHost.start} for why the
   * id matters before the first connection.
   */
  private async loadIdentityQuietly(): Promise<void> {
    try {
      this.identity = await loadOrCreateIdentity({
        file: resolveIdentityFile(this.env, this.config.identityFile),
        configuredNodeId: this.config.nodeId,
      })
    } catch {
      // No state change, no error: this path exists to make an id available, not to
      // report on the filesystem.
    }
  }

  /**
   * Stop the node: clear reconnect timers, cancel in-flight work, close the socket.
   * @param reason - short, non-sensitive explanation for the log.
   */
  async stop(reason: string): Promise<void> {
    if (!this.running && this.connector === undefined) return
    this.running = false
    const connector = this.connector
    // Terminate streams and requests *while the connector is still installed*, so
    // their terminal frames actually reach the Coordinator. Clearing it first
    // makes every `send` a silent no-op, and the peer is then left guessing
    // whether the node stopped or vanished.
    this.streams.failAll(
      { code: 'node/shutdown', message: `node is shutting down: ${reason}`, details: { reason } },
      true,
    )
    this.requests.failAll(new NodeError('node/shutdown', `node is shutting down: ${reason}`, { reason }))
    this.connector = undefined
    if (connector !== undefined) await connector.stop(reason)
    this.lastState = this.resolution.status === 'ok' ? 'stopped' : 'unconfigured'
  }

  /** Disconnect without disposing the host, and suppress automatic reconnects. */
  async disconnect(): Promise<void> {
    this.connectionIntent = 'paused'
    if (!this.running) {
      if (this.resolution.status === 'ok') this.lastState = 'paused'
      return
    }
    this.streams.failAll(
      { code: 'node/shutdown', message: 'node is manually disconnected', details: { reason: 'manual disconnect' } },
      true,
    )
    this.requests.failAll(new NodeError('node/shutdown', 'node is manually disconnected', { reason: 'manual disconnect' }))
    const connector = this.connector
    if (connector !== undefined) await connector.stop('manual disconnect')
    this.currentError = undefined
    this.lastState = this.resolution.status === 'ok' ? 'paused' : 'unconfigured'
    this.logger.info('dsh-node/disconnected', { reason: 'manual disconnect', nodeId: this.nodeId })
  }

  /** Resume an explicitly disconnected host and start one outbound attempt. */
  async connect(): Promise<void> {
    this.connectionIntent = 'active'
    if (!this.running) {
      await this.start()
      return
    }
    if (this.resolution.status !== 'ok') return
    const connector = this.connector
    if (connector === undefined) return
    connector.start()
    this.lastState = connector.state
    this.logger.info('dsh-node/reconnect-requested', { nodeId: this.nodeId, reason: 'manual connect' })
  }

  /**
   * Drop any backoff and retry immediately.
   *
   * A no-op when the node is `unconfigured` or `invalid`: there is nothing to
   * retry, and starting a reconnect loop is exactly what those states forbid.
   */
  reconnectNow(): void {
    if (this.connectionIntent === 'paused') return
    this.connector?.reconnectNow()
  }

  // ---------------------------------------------------------------- delegate

  /** Build the `hello` frame. The token is placed here and nowhere else. */
  createHello(): HelloFrame {
    const token = this.config.token as string
    return {
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: this.nodeId,
      mode: this.config.mode,
      auth: { type: 'bearer', token },
      ...(this.config.nodeName === undefined ? {} : { nodeName: this.config.nodeName }),
      ...(this.config.role === undefined ? {} : { role: this.config.role }),
      dsh: { remoteSurfaceHash: this.ensureCapabilities().summary.remoteSurfaceHash },
    }
  }

  /** Build the `ready` frame from the surface as it is right now. */
  createReady(helloOk: HelloOkFrame): ReadyFrame {
    const index = this.refreshCapabilities()
    this.logger.info('dsh-node/state-changed', {
      state: 'authenticating',
      nodeId: this.nodeId,
      connectionId: helloOk.connectionId,
      acceptedMode: helloOk.acceptedMode ?? this.config.mode,
    })
    return {
      type: 'ready',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: this.nodeId,
      connectionId: helloOk.connectionId,
      dsh: { remoteSurfaceHash: index.summary.remoteSurfaceHash },
      capabilities: index.summary,
    }
  }

  /** Dispatch one inbound frame received while `ready`. */
  onFrame(frame: InboundFrame): void {
    if (!this.running) return
    switch (frame.type) {
      case 'rpc.request':
        this.handleRequest(frame)
        return
      case 'rpc.cancel':
        this.handleCancel(frame.requestId, frame.reason)
        return
      case 'stream.open':
        this.handleStreamOpen(frame)
        return
      case 'stream.cancel':
        this.handleStreamCancel(frame)
        return
      default:
        // `ping`, `pong`, and `close` are consumed by the connector.
        return
    }
  }

  /**
   * Fail every in-flight request with `node/connection-lost`.
   *
   * Nothing is replayed. Re-running an unconfirmed write after a reconnect would
   * duplicate a Session, a Prompt, or a file edit, so the Coordinator is given an
   * explicit failure and decides for itself (spec §1.1 #8).
   */
  onDisconnected(error: NodeError): void {
    const failed = this.requests.failAll(error)
    // Streams have no socket left to report on, so they are released locally and
    // never resumed: v1 has no continuation, and replaying a partially consumed
    // stream would duplicate every value the Coordinator already saw.
    const ended = this.streams.failAll(
      { code: 'node/connection-lost', message: error.message, details: error.details },
      false,
    )
    if (failed.length > 0 || ended.length > 0) {
      this.logger.warn('dsh-node/disconnected', {
        nodeId: this.nodeId,
        reason: 'in-flight requests and streams failed and were not replayed',
        code: error.code,
        requestIds: failed,
        streamIds: ended,
      })
    }
  }

  // ---------------------------------------------------------------- dispatch

  private handleRequest(frame: RpcRequestFrame): void {
    let parsed: { namespace: string; method: string }
    try {
      parsed = parseEndpoint(frame.endpoint)
    } catch (error) {
      this.replyError(frame, nodeFailure(error))
      return
    }

    let args: Readonly<Record<string, unknown>>
    try {
      // Shape-checked, then forwarded by reference: no field is added, renamed,
      // or dropped, because the Gateway's `assertExactArguments` requires an
      // exact match against the descriptor (spec §7.3).
      args = parseRequestArgs(frame.payload)
    } catch (error) {
      this.replyError(frame, nodeFailure(error))
      return
    }

    if (!this.allows(parsed.namespace, frame.endpoint)) {
      this.replyError(frame, {
        code: 'node/capability-unavailable',
        message: `endpoint ${frame.endpoint} is not among the Remotes registered on this node`,
        details: { endpoint: frame.endpoint, namespace: parsed.namespace },
      })
      return
    }

    let pending: PendingRequest
    try {
      pending = this.requests.begin(frame.requestId, frame.endpoint)
    } catch (error) {
      this.replyError(frame, nodeFailure(error))
      return
    }

    void this.runRequest(frame, parsed, args, pending)
  }

  /** Execute one admitted request and emit exactly one terminal frame. */
  private async runRequest(
    frame: RpcRequestFrame,
    parsed: { namespace: string; method: string },
    args: Readonly<Record<string, unknown>>,
    pending: PendingRequest,
  ): Promise<void> {
    const startedAt = this.now()
    let detach: (() => void) | undefined
    try {
      const gateway = this.gateway()
      const invocation = gateway === undefined
        ? Promise.resolve<NodeFailure>({
          code: 'node/not-ready',
          message: 'the local Typert Gateway is not available',
          details: {},
        }).then(failure => ({ ok: false as const, failure }))
        : gateway
          .invoke({ namespace: parsed.namespace, method: parsed.method, args, signal: pending.signal })
          .then(
            value => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, failure: this.failureOf(gateway, error, frame.endpoint) }),
          )

      let aborted: Promise<{ ok: false; failure: NodeFailure }> | undefined
      if (!pending.signal.aborted) {
        aborted = new Promise(resolve => {
          const onAbort = (): void => { resolve({ ok: false, failure: nodeFailure(pending.signal.reason) }) }
          pending.signal.addEventListener('abort', onAbort, { once: true })
          detach = () => { pending.signal.removeEventListener('abort', onAbort) }
        })
      }

      const outcome = aborted === undefined ? await invocation : await Promise.race([invocation, aborted])

      // The single-settlement gate: whoever completes first owns the reply. A
      // second completion (duplicate or late) gets `undefined` and stays silent.
      const settled = this.requests.complete(frame.requestId)
      if (settled === undefined) return
      // A lost transport has no channel left; the Coordinator already learned the
      // connection dropped, and nothing is replayed.
      if (this.connector?.isReady !== true) return

      const result: RpcResultFrame['result'] = outcome.ok
        ? { ok: true, value: outcome.value }
        : { ok: false, error: outcome.failure }
      this.sendResult(frame, result)
      this.logger.info('dsh-node/request-completed', {
        nodeId: this.nodeId,
        requestId: frame.requestId,
        endpoint: frame.endpoint,
        outcome: outcome.ok ? 'ok' : 'error',
        code: outcome.ok ? undefined : outcome.failure.code,
        durationMs: this.now() - startedAt,
      })
    } catch (error) {
      const settled = this.requests.complete(frame.requestId)
      if (settled === undefined) return
      if (this.connector?.isReady !== true) return
      const failure = nodeFailure(error)
      this.sendResult(frame, { ok: false, error: failure })
      this.logger.error('dsh-node/request-completed', {
        requestId: frame.requestId,
        endpoint: frame.endpoint,
        outcome: 'error',
        code: failure.code,
      })
    } finally {
      detach?.()
      // Defensive: a throw before completion must not leave the id live.
      this.requests.complete(frame.requestId)
    }
  }

  /**
   * Open one stream Remote and pump it.
   *
   * The stream is admitted before the Gateway is touched, so `node/stream-limit`
   * and a duplicate `streamId` are refused without opening anything. Opening the
   * iterable happens here rather than in the pump so a failure to open is
   * reported as a single `stream.error` (with no `stream.ready` before it).
   */
  private handleStreamOpen(frame: StreamOpenFrame): void {
    let parsed: { namespace: string; method: string }
    try {
      parsed = parseEndpoint(frame.endpoint)
    } catch (error) {
      this.openFailed(frame, nodeFailure(error))
      return
    }

    let args: Readonly<Record<string, unknown>>
    try {
      // Forwarded by reference, exactly like a unary call: the Gateway's
      // `assertExactArguments` demands an exact match against the descriptor.
      args = parseRequestArgs(frame.payload)
    } catch (error) {
      this.openFailed(frame, nodeFailure(error))
      return
    }

    if (!this.allows(parsed.namespace, frame.endpoint)) {
      this.openFailed(frame, {
        code: 'node/capability-unavailable',
        message: `endpoint ${frame.endpoint} is not among the Remotes registered on this node`,
        details: { endpoint: frame.endpoint, namespace: parsed.namespace },
      })
      return
    }

    const admitted = this.streams.open(frame)
    if (!admitted.ok) {
      this.openFailed(frame, admitted.error)
      return
    }

    void this.runStream(frame, parsed, args)
  }

  /** Open the iterable and pump it; exactly one terminal frame is emitted. */
  private async runStream(
    frame: StreamOpenFrame,
    parsed: { namespace: string; method: string },
    args: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const streamId = frame.streamId
    const startedAt = this.now()
    const gateway = this.gateway()
    if (gateway === undefined) {
      this.streams.fail(streamId, {
        code: 'node/not-ready',
        message: 'the local Typert Gateway is not available',
        details: { streamId },
      })
      return
    }

    const entry = this.streams.active.find(candidate => candidate.streamId === streamId)
    if (entry === undefined) return

    let source: AsyncIterable<unknown>
    try {
      source = await gateway.stream({
        namespace: parsed.namespace,
        method: parsed.method,
        args,
        signal: entry.signal,
      })
    } catch (error) {
      // Opening failed: no `stream.ready` was sent, so this is the stream's one
      // terminal frame.
      this.streams.fail(streamId, this.failureOf(gateway, error, frame.endpoint))
      this.logStreamEnd(frame.endpoint, streamId, startedAt, 'error')
      return
    }

    if (!this.streams.ready(streamId)) {
      // The socket went away between admitting and opening; release the source.
      this.streams.fail(streamId, {
        code: 'node/connection-lost',
        message: 'the transport closed before the stream could be acknowledged',
        details: { streamId },
      })
      return
    }

    await this.streams.pump(streamId, source)
    this.logStreamEnd(frame.endpoint, streamId, startedAt, 'closed')
  }

  private logStreamEnd(endpoint: string, streamId: string, startedAt: number, outcome: string): void {
    this.logger.info('dsh-node/stream-closed', {
      nodeId: this.nodeId,
      streamId,
      endpoint,
      outcome,
      durationMs: this.now() - startedAt,
    })
  }

  /** Report a failure for a stream that never opened. */
  private openFailed(frame: StreamOpenFrame, failure: NodeFailure): void {
    this.logger.warn('dsh-node/protocol-error', {
      nodeId: this.nodeId,
      streamId: frame.streamId,
      endpoint: frame.endpoint,
      code: failure.code,
      reason: failure.message,
    })
    // The stream was refused before it existed, so there is no entry to fail;
    // answer with a terminal frame anyway so the Coordinator is not left waiting.
    this.connector?.send({
      type: 'stream.error',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: this.nodeId,
      streamId: frame.streamId,
      error: { code: failure.code, message: failure.message, details: failure.details },
      count: 0,
    })
  }

  private handleStreamCancel(frame: StreamCancelFrame): void {
    if (!this.streams.cancel(frame)) {
      this.logger.warn('dsh-node/protocol-error', {
        reason: 'stream.cancel names no open stream',
        streamId: frame.streamId,
      })
      return
    }
    this.logger.info('dsh-node/stream-closed', {
      nodeId: this.nodeId,
      streamId: frame.streamId,
      outcome: 'cancelled',
      code: 'gateway/cancelled',
    })
  }

  private handleCancel(requestId: unknown, reason: string | undefined): void {
    if (typeof requestId !== 'string' || requestId === '') {
      this.logger.warn('dsh-node/protocol-error', { reason: 'rpc.cancel requires a non-empty requestId' })
      return
    }
    // Mirrors the code a local DSH caller sees for the same cancellation.
    const aborted = this.requests.abort(
      requestId,
      new RemoteCodeError('gateway/cancelled', reason ?? 'the Coordinator cancelled the request', {}),
    )
    if (!aborted) {
      this.logger.warn('dsh-node/protocol-error', {
        reason: 'rpc.cancel names no in-flight request',
        requestId,
      })
      return
    }
    this.logger.info('dsh-node/request-completed', { requestId, outcome: 'cancelled', code: 'gateway/cancelled' })
  }

  /** Send one terminal frame, echoing the request's `messageId` when present. */
  private sendResult(frame: RpcRequestFrame, result: RpcResultFrame['result']): boolean {
    const outbound: RpcResultFrame = {
      type: 'rpc.result',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: this.nodeId,
      requestId: frame.requestId,
      result,
      ...(frame.messageId === undefined ? {} : { messageId: frame.messageId }),
    }
    return this.connector?.send(outbound) ?? false
  }

  private replyError(frame: RpcRequestFrame, failure: NodeFailure): void {
    this.sendResult(frame, { ok: false, error: failure })
    this.logger.warn('dsh-node/request-completed', {
      nodeId: this.nodeId,
      requestId: frame.requestId,
      endpoint: frame.endpoint,
      outcome: 'error',
      code: failure.code,
    })
  }

  /**
   * Convert a thrown Gateway failure into wire fields.
   *
   * `wireStream.failure` is the Gateway's own carrier-safe projection, so this
   * plugin reports exactly what the official HTTP and WebSocket carriers would
   * rather than re-deriving codes from error shapes. The only transformation is
   * the availability fold documented on {@link CAPABILITY_FAILURE_CODES}.
   */
  private failureOf(gateway: TypertGatewayLike, error: unknown, endpoint: string): NodeFailure {
    let projected: { code: string; message: string; details: object }
    try {
      projected = gateway.wireStream.failure(error)
    } catch {
      return nodeFailure(error)
    }
    if (CAPABILITY_FAILURE_CODES.has(projected.code)) {
      return {
        code: 'node/capability-unavailable',
        message: `endpoint ${endpoint} is not available on this node: ${projected.message}`,
        details: { endpoint, gatewayCode: projected.code },
      }
    }
    return {
      code: projected.code,
      message: projected.message,
      details: { ...(projected.details as Record<string, unknown>) },
    }
  }

  // ------------------------------------------------------------ capabilities

  /**
   * Decide whether an endpoint may be attempted.
   *
   * A miss rebuilds the index once first: plugins can mount after this one, and a
   * stale cache would make a legitimately registered Remote unreachable. A
   * namespace that is still unknown is refused here, before dispatch, so an
   * unregistered endpoint never reaches a business method.
   */
  private allows(namespace: string, endpoint: string): boolean {
    let index = this.ensureCapabilities()
    if (index.endpoints.has(endpoint) || index.namespaces.has(namespace)) return true
    index = this.refreshCapabilities()
    return index.endpoints.has(endpoint) || index.namespaces.has(namespace)
  }

  private ensureCapabilities(): CapabilityIndex {
    if (this.capabilityIndex === undefined || this.capabilitiesStale) return this.refreshCapabilities()
    return this.capabilityIndex
  }

  private refreshCapabilities(): CapabilityIndex {
    this.capabilityIndex = collectCapabilities(this.ctx)
    this.capabilitiesStale = false
    return this.capabilityIndex
  }

  /** Mark the cached surface stale whenever the registry changes. */
  private subscribeToRegistry(): void {
    const registry = getTypertRegistry(this.ctx)
    if (registry?.local.subscribe === undefined) return
    try {
      registry.local.subscribe(() => { this.capabilitiesStale = true })
    } catch {
      // Observation is an optimisation; a registry that refuses it still works
      // because `allows` rebuilds on a miss.
    }
  }

  // ------------------------------------------------------------------ wiring

  private connectorOptions(): ConnectorOptions {
    return {
      config: this.config,
      delegate: this,
      logger: this.logger,
      ...(this.hostOptions.createSocket === undefined ? {} : { createSocket: this.hostOptions.createSocket }),
      ...(this.hostOptions.timers === undefined ? {} : { timers: this.hostOptions.timers }),
      ...(this.hostOptions.random === undefined ? {} : { random: this.hostOptions.random }),
      onStateChange: state => {
        this.lastState = state
        if (state === 'ready') this.currentError = undefined
      },
    }
  }

  private gateway(): TypertGatewayLike | undefined {
    try {
      return (this.ctx as unknown as { get(key: string, strict?: boolean): unknown }).get('typertGateway', false) as
        | TypertGatewayLike
        | undefined
    } catch {
      return undefined
    }
  }

  private now(): number {
    return this.hostOptions.now?.() ?? Date.now()
  }
}

/**
 * Register the status and configuration route, if this host has a Web server.
 *
 * Deliberately **not** part of `inject`. The route exists for one consumer — the
 * footer entry — so making `webServer` a hard dependency would stop the node from
 * running at all in a profile that has no Web server. `ctx.inject` asks for the
 * service and runs the callback when it appears, so the node keeps working
 * everywhere and the UI gets its route wherever there is a server to serve it.
 *
 * The host and the config surface are read through getters, not captured: a save
 * rebuilds the node, and a handler closed over the old instance would keep reporting
 * the previous connection forever.
 * @param ctx - Host context.
 * @param host - getter for the node currently serving, if any.
 * @param config - the configuration surface, absent when this deployment has no
 * resolvable home directory to write into.
 */
function installStatusRoute(
  ctx: NodeHostContext,
  host: () => DshNodeHost | undefined,
  config: NodeConfigSurface | undefined,
  connection: NodeConnectionSurface | undefined,
): void {
  const register = (scoped: Context): void => {
    const webServer = (scoped as Context & { webServer?: WebServerLike }).webServer
    if (webServer === undefined) return

    const status = (): NodeStatusView => {
      const current = host()
      if (current === undefined) {
        // The window between mounting and the first boot is milliseconds; reporting
        // an honest placeholder beats throwing inside a route handler.
        return {
          state: 'stopped',
          nodeId: '',
          reconnectAttempt: 0,
          inFlightRequests: 0,
          activeStreams: 0,
          pluginVersion: PLUGIN_VERSION,
          mode: 'full-access',
          uptimeMs: 0,
          updatedAt: new Date().toISOString(),
        }
      }
      return {
        // Already redacted at the source: the snapshot never contains the token, and
        // `coordinatorOrigin` is scheme+host+port only.
        ...current.status,
        pluginVersion: PLUGIN_VERSION,
        mode: 'full-access',
        uptimeMs: Date.now() - current.startedAt,
        updatedAt: new Date().toISOString(),
      }
    }

    scoped.effect(() => {
      const dispose = webServer.register({
        kind: 'prefix',
        path: NODE_ROUTE_PREFIX,
        handler: createNodeRouteHandler({
          status,
          trustedHosts: () => {
            // `webRuntime` is read structurally: it is optional and only exists
            // where the deployment serves more than loopback.
            const runtime = (ctx.get as (key: string, strict?: boolean) => unknown)('webRuntime', false)
            const hosts = (runtime as { trustedHosts?: readonly string[] } | undefined)?.trustedHosts
            return Array.isArray(hosts) ? hosts : []
          },
          diagnostics: () => readClientModules(ctx),
          ...(config === undefined ? {} : { config }),
          ...(connection === undefined ? {} : { connection }),
        }),
      })
      return () => { dispose() }
    }, 'dsh-node: status route')
  }

  // `webServer` may already be there (the usual case) or arrive later.
  ctx.inject(['webServer'], (scoped: Context) => { register(scoped) })
}

/** The slice of DSH's Web server this plugin uses. */
interface WebServerLike {
  register(route: {
    kind: 'prefix'
    path: string
    handler: (request: IncomingMessage, response: ServerResponse) => void
  }): () => void
}

/** The slice of `@deepseek-ai/dsh-client-modules` this plugin reads for diagnosis. */
interface ClientModulesLike {
  graph(): { readonly entries: readonly { readonly id: string }[] }
  clientPath(id: string): string | undefined
}

/**
 * Report what the host's client-module composer thinks of this plugin.
 *
 * That composer fails **silently** — a package whose manifest it cannot locate is
 * skipped with no log line, and the plugin then runs on the host while never
 * appearing in the browser. This is the read-only window into that decision, so the
 * next such failure takes one request to diagnose instead of one round of guessing.
 * @param ctx - host context (the service is optional and appears after the web app).
 * @returns the diagnostic payload.
 */
function readClientModules(ctx: NodeHostContext): NodeDiagnostics {
  const get = ctx.get as (key: string, strict?: boolean) => unknown
  const registry = get('clientModules', false) as ClientModulesLike | undefined
  if (registry === undefined) {
    return { clientModulesService: false, entries: [], selfComposed: false, selfClientPath: null }
  }
  try {
    const entries = registry.graph().entries.map(entry => entry.id)
    return {
      clientModulesService: true,
      entries,
      selfComposed: entries.includes('dsh-node'),
      selfClientPath: registry.clientPath('dsh-node') ?? null,
    }
  } catch (error) {
    // A diagnostic that can throw is worse than no diagnostic at all.
    return {
      clientModulesService: true,
      entries: [],
      selfComposed: false,
      selfClientPath: null,
      readError: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Host half: resolve configuration, load identity, and run one outbound connector.
 *
 * The node is **rebuildable**. A save from the status panel changes the very fields
 * the host was constructed from (`resolution` is readonly, and the request and stream
 * managers take their bounds from it), so applying a new configuration means stopping
 * the old host and constructing a new one — which is also what makes "save" mean
 * "reconnect now" instead of "restart DSH".
 *
 * Configuration precedence is file > profile > environment, produced by merging the
 * stored document into the Loader's bootstrap before {@link resolveNodeConfig} runs.
 *
 * Every resource is owned by {@link Context.effect}, so Cordis disposal stops
 * reconnection, cancels in-flight operations, and closes the socket. The node service
 * is provided under `dshNode` for the same lifetime, through whichever host instance
 * is current.
 * @param ctx - Host context with the Gateway available.
 * @param config - raw bootstrap configuration from `cordis.patch.yml`.
 */
export function apply(ctx: NodeHostContext, config?: unknown): void {
  const env = process.env
  const file = resolveConfigFile(env)
  const profileConfig = (): unknown => config
  const sink = cordisLogSink((ctx as unknown as { logger?: unknown }).logger)
  const logger = createNodeLogger({
    // Nothing passed to this logger ever contains the token: the config service
    // reports presence (`tokenSet`), and the host keeps its own redacting logger.
    secrets: [],
    ...(sink === undefined ? {} : { sink }),
    env,
  })

  let current: DshNodeHost | undefined
  let adminDisposer: (() => Promise<void>) | undefined
  let serviceDisposer: (() => void) | undefined
  let started: Promise<void> = Promise.resolve()
  let disposed = false
  /** Serialises boots and shutdowns, so two saves cannot race each other. */
  let queue: Promise<unknown> = Promise.resolve()

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task)
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  const bootNow = async (stored: StoredNodeConfig | undefined): Promise<void> => {
    if (disposed) return
    const host = new DshNodeHost({
      ctx,
      bootstrap: mergeNodeConfig(profileConfig(), stored),
      ...(stored?.connectionIntent === undefined ? {} : { connectionIntent: stored.connectionIntent }),
    })
    // Mounted before the connector starts, so the very first `ready` frame already
    // advertises `nodeAdmin/*`.
    const disposeAdmin = installAdminSurface(ctx, host)
    const disposeService = ctx.provide('dshNode', host)
    current = host
    adminDisposer = disposeAdmin
    serviceDisposer = disposeService
    started = host.start()
    await started
  }

  const shutdownNow = async (reason: string): Promise<void> => {
    const host = current
    const disposeAdmin = adminDisposer
    const disposeService = serviceDisposer
    current = undefined
    adminDisposer = undefined
    serviceDisposer = undefined
    // Withdrawn before the host stops, so a call arriving mid-reboot finds no
    // half-stopped node to dispatch into.
    disposeService?.()
    await started.catch(() => undefined)
    if (host !== undefined) await host.stop(reason)
    await disposeAdmin?.()
  }

  const configService = new NodeConfigService({
    file,
    profileConfig,
    effective: () => current?.config ?? {},
    nodeId: () => current?.nodeId ?? '',
    apply: async (stored: StoredNodeConfig) => {
      await enqueue(async () => {
        await shutdownNow('reconfigured')
        await bootNow(stored)
        const host = current
        if (host === undefined) throw new Error('the node was not rebuilt')
        // `start()` resolves without throwing for an unusable identity file or a
        // config it refused; those are exactly the failures the operator needs to see
        // in the panel rather than in a log they would have to go find.
        const failure = host.status.lastError
        if (host.resolution.status !== 'ok') {
          throw new Error(host.resolution.errors.join('; ') || 'the node resolved to an unusable configuration')
        }
        if (failure !== undefined && host.status.state === 'stopped') throw new Error(failure.message)
      })
    },
    env,
    warn: (message, details) => { logger.warn(message, details) },
    now: Date.now,
  })

  const connection: NodeConnectionSurface = {
    state: () => configService.read().connectionIntent ?? 'active',
    connect: async () => {
      await configService.setConnectionIntent('active')
      await current?.connect()
      return configService.read().connectionIntent ?? 'active'
    },
    disconnect: async () => {
      await configService.setConnectionIntent('paused')
      await current?.disconnect()
      return configService.read().connectionIntent ?? 'paused'
    },
  }

  const initialise = (): Promise<void> => enqueue(async () => {
    const read = await loadStoredConfig(file)
    configService.seed(read)
    if (read.error !== undefined) {
      logger.warn('dsh-node/state-changed', { warning: read.error })
    }
    await bootNow(read.config)
  })

  ctx.effect(() => {
    const booting = initialise()
    return async () => {
      disposed = true
      await booting.catch(() => undefined)
      await enqueue(() => shutdownNow('plugin-disposed'))
    }
  }, 'dsh-node: outbound WebSocket node')

  installStatusRoute(ctx, () => current, configService, connection)
}

/** Plugin version, kept in sync with `package.json` by a test. */
export const PLUGIN_VERSION = '0.1.0'

/**
 * The Host-side Typert registration entry point, as `dsh-typert-loader` documents
 * it.
 *
 * `ctx.typert` is *typed* as `TypertRegistryContract`, which exposes only
 * `local` / `remotes` / `lookups` / `contexts` — `register` lives on the concrete
 * registry class. The loader's own documentation sanctions it for exactly this
 * case: "Manual `ctx.typert.register()` remains available for contributions that
 * do not use a `./typert` artifact (hand-written wire schemas, tests, non-loader
 * compositions)."
 *
 * It is read structurally rather than by importing the registry package, so this
 * plugin keeps taking no runtime dependency on an official package.
 */
interface TypertHostRegistration {
  register(contribution: {
    readonly package: string
    readonly face: 'host'
    readonly schemas: readonly unknown[]
    readonly model: {
      readonly services: readonly unknown[]
      readonly events: readonly unknown[]
      readonly objects: readonly unknown[]
    }
    readonly invocations: readonly unknown[]
  }): () => Promise<void>
}

/**
 * Read the Host-side registration entry point, if this DSH exposes one.
 *
 * A DSH that dropped or renamed it would leave the descriptors unregistered, and
 * the capability list would then simply show no `nodeAdmin/*` rather than the
 * node pretending to offer a surface it cannot dispatch.
 */
function typertHostRegistration(ctx: NodeHostContext): TypertHostRegistration | undefined {
  try {
    const registry = (ctx as unknown as { get(key: string, strict?: boolean): unknown }).get('typert', false) as
      | Partial<TypertHostRegistration>
      | undefined
    return typeof registry?.register === 'function' ? (registry as TypertHostRegistration) : undefined
  } catch {
    return undefined
  }
}

/**
 * Provide the `nodeAdmin` owner and register its invocation descriptors.
 *
 * The owner is a plain object carrying a hand-built `typertRemote` binding, which
 * is what the Gateway's `validateBinding` and `collectSrcClaims` read. Building it
 * by hand rather than extending `TypertRemoteService` keeps this plugin free of
 * runtime imports from official packages; `docs/GROUND-TRUTH.md` §3 records why
 * that constraint exists for an out-of-tree plugin.
 *
 * Registration is what makes the surface *dispatchable*: with the descriptors in
 * `ctx.typert.local`, a `rpc.request` for `nodeAdmin/describe` travels the exact
 * same path as `session/list` — no special case in the dispatcher, and the
 * capability gate sees it like any other endpoint.
 * @param ctx - host context.
 * @param host - the node host the owner reads diagnostics from.
 * @returns a disposer that withdraws the descriptors and the service.
 */
function installAdminSurface(ctx: NodeHostContext, host: DshNodeHost): () => Promise<void> {
  const config = host.config
  const owner = new NodeAdminOwner({
    host: {
      status: () => host.status,
      capabilities: () => host.capabilitySummary().remotes,
      startedAt: () => host.startedAt,
      ...(config.nodeName === undefined ? {} : { nodeName: config.nodeName }),
      ...(config.role === undefined ? {} : { role: config.role }),
      sessionCwds: () => sessionWorkingDirectories(ctx),
      version: () => PLUGIN_VERSION,
    },
    policy: {
      allowedRoots: config.allowedRoots,
      skillRoots: config.skillRoots,
    },
    filesystemEnabled: config.adminFilesystemEnabled,
    skillsEnabled: config.adminSkillsEnabled,
    auditCapacity: config.auditCapacity,
  })

  const disposeService = ctx.provide(ADMIN_SERVICE_KEY, owner)
  const disposeInvocations = typertHostRegistration(ctx)?.register({
    package: 'dsh-node',
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: [...ADMIN_DESCRIPTORS],
  })

  return async () => {
    disposeService()
    // `undefined` when this DSH exposes no Host registration entry point, in which
    // case there is nothing to withdraw.
    await disposeInvocations?.()
  }
}

/**
 * Working directories of live sessions, used as the default filesystem roots.
 *
 * Read through `ctx.get(..., false)` so a profile without `sessions` simply has no
 * default roots instead of failing to mount. Only live sessions are listed, which
 * is exactly the intended scope: a Coordinator may work inside sessions that are
 * open, not in historical working directories it cannot see.
 */
function sessionWorkingDirectories(ctx: NodeHostContext): string[] {
  interface SessionsLike {
    list?(): readonly { readonly header?: { readonly cwd?: unknown } }[]
  }
  let sessions: SessionsLike | undefined
  try {
    sessions = (ctx as unknown as { get(key: string, strict?: boolean): unknown }).get('sessions', false) as
      | SessionsLike
      | undefined
  } catch {
    return []
  }
  if (sessions?.list === undefined) return []
  try {
    return sessions.list()
      .map(session => session.header?.cwd)
      .filter((cwd): cwd is string => typeof cwd === 'string' && cwd !== '')
  } catch {
    return []
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The `dsh-node` host service, present while this plugin is mounted. */
    dshNode: DshNodeHost
  }
}
