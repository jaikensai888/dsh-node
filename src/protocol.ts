/**
 * Wire protocol of `dsh-node` (version `dsh-node/1`).
 *
 * Frame shapes are the spec's §7.2 / §7.3 field lists, restricted to the Phase 1
 * set: `hello`, `hello.ok`, `ready`, `rpc.request`, `rpc.result`, `rpc.cancel`,
 * `ping`, `pong`, `close`. Stream frames (§7.4) are Phase 2 and are not declared
 * here at all — declaring them would advertise a capability this build does not
 * implement.
 *
 * @module dsh-node/protocol
 */

/** The only protocol version this build speaks. */
export const PROTOCOL_VERSION = 'dsh-node/1'

/** Every connection state of the state machine (spec §6). */
export const NODE_STATES = [
  /** No Coordinator URL or no token: no connection, no reconnect loop. */
  'unconfigured',
  /** Not started, stopped, or stopped by invalid configuration. */
  'stopped',
  /** Opening the WebSocket (TCP/TLS). */
  'connecting',
  /** Socket is up; `hello` / `hello.ok` handshake is in progress. */
  'authenticating',
  /** Handshake accepted; requests are served. */
  'ready',
  /** A connection attempt failed; waiting for the next one. */
  'backoff',
  /** Credentials were refused. Retries are slow and bounded. */
  'auth_failed',
  /** Cancelling in-flight work and closing the socket. */
  'closing',
] as const

/** One connection state. */
export type NodeState = (typeof NODE_STATES)[number]

/**
 * The single permission mode. There is exactly one, on purpose: `full-access`
 * means "no extra node-level Remote allowlist", not "arbitrary remote execution"
 * (spec §2.2).
 */
export const NODE_MODES = ['full-access'] as const

/** The only accepted mode value. */
export type NodeMode = (typeof NODE_MODES)[number]

/** How one advertised endpoint is invoked. */
export const CAPABILITY_MODES = ['unary', 'stream'] as const

/** One advertised endpoint's invocation shape. */
export type CapabilityMode = (typeof CAPABILITY_MODES)[number]

/** One advertised Remote endpoint. Never carries a path, token, or env value. */
export interface NodeCapability {
  /** Canonical `<namespace>/<method>` endpoint. */
  readonly endpoint: string
  /** `unary` for `gateway.invoke`, `stream` for `gateway.stream`. */
  readonly mode: CapabilityMode
}

/**
 * The `ready` frame's controlled capability summary.
 *
 * `remoteSurfaceHash` is a sha256 over the sorted endpoint+mode list, so the
 * Coordinator can detect that a node's surface changed without receiving a full
 * descriptor dump. See `docs/GROUND-TRUTH.md` for why this replaced the spec's
 * unspecified "Remote surface" interface.
 */
export interface NodeCapabilitySummary {
  /** Sorted, de-duplicated endpoints with their invocation mode. */
  readonly remotes: readonly NodeCapability[]
  /** Stable digest of {@link remotes}. */
  readonly remoteSurfaceHash: string
  /**
   * Every namespace this node will dispatch, whether or not its methods could be
   * enumerated.
   *
   * This is deliberately **not** only the unenumerable ones: what it guarantees is
   * the negative — a namespace *absent* here will not be dispatched at all, so a
   * Coordinator can refuse it locally instead of paying a round trip. A namespace
   * that *is* present does not promise that an unlisted method exists, which is
   * why the rule for a Coordinator is "a method missing from {@link remotes} may
   * still exist; forward it and let the node answer `node/capability-unavailable`".
   *
   * Cross-implementation note (found by `dsh-coordinator`'s cross-implementation
   * test): an earlier revision of this comment claimed the field held only
   * source-mode namespaces, while `collectCapabilities` has always sent all of
   * them. The field's contract is the one described above; only the subset that is
   * unenumerable feeds `remoteSurfaceHash`.
   */
  readonly namespaces: readonly string[]
}

/** Fields every frame carries. */
export interface BaseFrame {
  /** Frame discriminator. */
  readonly type: string
  /** Always {@link PROTOCOL_VERSION} for this build. */
  readonly protocolVersion: string
  /** Emitting node's stable identity. */
  readonly nodeId: string
  /** Optional correlation id, echoed on the terminal frame it belongs to. */
  readonly messageId?: string
}

/** The DSH build facts this node reports. Never carries host paths. */
export interface NodeDshInfo {
  /** Version of the running DSH installation. */
  readonly version?: string
  /** Digest of the advertised Remote surface. */
  readonly remoteSurfaceHash?: string
}

/** Node -> Coordinator: first frame on a fresh socket. */
export interface HelloFrame extends BaseFrame {
  readonly type: 'hello'
  /** Display metadata. Never authentication material. */
  readonly nodeName?: string
  /** Display metadata. Never authentication material. */
  readonly role?: string
  readonly mode: NodeMode
  /** The credential. Write-only: never logged, never placed in the URL. */
  readonly auth: {
    readonly type: 'bearer'
    readonly token: string
  }
  readonly dsh?: NodeDshInfo
}

/** Coordinator -> Node: handshake accepted. */
export interface HelloOkFrame extends BaseFrame {
  readonly type: 'hello.ok'
  /** Server-assigned connection identity, surfaced in status. */
  readonly connectionId: string
  /** Server-preferred ping interval; the node's configured value wins when absent. */
  readonly heartbeatIntervalMs?: number
  /** Server-side frame limit; the node's configured value wins when absent. */
  readonly maxFrameBytes?: number
  /** Mode the Coordinator accepted. */
  readonly acceptedMode?: string
}

/** Node -> Coordinator: this node is serving requests. */
export interface ReadyFrame extends BaseFrame {
  readonly type: 'ready'
  readonly connectionId?: string
  readonly dsh?: NodeDshInfo
  readonly capabilities: NodeCapabilitySummary
}

/** Coordinator -> Node: invoke one unary Remote. */
export interface RpcRequestFrame extends BaseFrame {
  readonly type: 'rpc.request'
  /** Client-chosen correlation id; unique per connection. */
  readonly requestId: string
  /** Canonical `<namespace>/<method>` endpoint. */
  readonly endpoint: string
  /** Must be exactly `{ args: <plain object> }` and is forwarded without edits. */
  readonly payload: {
    readonly args: Readonly<Record<string, unknown>>
  }
}

/** Node -> Coordinator: terminal result of one unary Remote. */
export interface RpcResultFrame extends BaseFrame {
  readonly type: 'rpc.result'
  readonly requestId: string
  readonly result:
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly error: NodeResultError }
}

/** Failure fields carried by {@link RpcResultFrame}. */
export interface NodeResultError {
  /** Preserved verbatim for business and `gateway/*` failures. */
  readonly code: string
  readonly message: string
  readonly details: Record<string, unknown>
}

/** Coordinator -> Node: abort one in-flight unary Remote. */
export interface RpcCancelFrame extends BaseFrame {
  readonly type: 'rpc.cancel'
  readonly requestId: string
  /** Free-form, non-sensitive explanation for the log. */
  readonly reason?: string
}

/** Node -> Coordinator: liveness probe. */
export interface PingFrame extends BaseFrame {
  readonly type: 'ping'
}

/** Coordinator -> Node: liveness answer. */
export interface PongFrame extends BaseFrame {
  readonly type: 'pong'
}

/** Either direction: this side is going away. */
export interface CloseFrame extends BaseFrame {
  readonly type: 'close'
  /** Stable code, either `node/*` or a Coordinator-chosen value. */
  readonly code?: string
  readonly reason?: string
  /** `false` tells the peer not to expect an automatic reconnection. */
  readonly reconnect?: boolean
}

/** Coordinator -> Node: open one stream Remote. */
export interface StreamOpenFrame extends BaseFrame {
  readonly type: 'stream.open'
  /** Client-chosen stream identity; unique per connection. */
  readonly streamId: string
  /** Optional correlation id echoed on every frame of this stream. */
  readonly requestId?: string
  /** Canonical `<namespace>/<method>` endpoint whose descriptor mode is `stream`. */
  readonly endpoint: string
  /** Must be exactly `{ args: <plain object> }` and is forwarded without edits. */
  readonly payload: {
    readonly args: Readonly<Record<string, unknown>>
  }
}

/**
 * Node -> Coordinator: the stream is open and data may follow.
 *
 * Sent only after the Gateway actually opened the iterable, so a Coordinator can
 * tell "opening succeeded, nothing yielded yet" apart from "still opening". No
 * `stream.data` for this id precedes it.
 */
export interface StreamReadyFrame extends BaseFrame {
  readonly type: 'stream.ready'
  readonly streamId: string
  /** Echoed when `stream.open` carried one. */
  readonly requestId?: string
}

/**
 * Node -> Coordinator: one yielded value.
 *
 * `seq` starts at 1 and increases by exactly one per frame, so a Coordinator can
 * detect loss and reordering. `seq` is per stream, not per connection.
 */
export interface StreamDataFrame extends BaseFrame {
  readonly type: 'stream.data'
  readonly streamId: string
  readonly seq: number
  readonly value: unknown
}

/**
 * Node -> Coordinator: the source finished normally.
 *
 * Terminal: no `stream.data` or `stream.error` for this id may follow.
 */
export interface StreamEndFrame extends BaseFrame {
  readonly type: 'stream.end'
  readonly streamId: string
  /** Number of `stream.data` frames sent, for the Coordinator's own accounting. */
  readonly count: number
}

/**
 * Node -> Coordinator: the stream failed or was terminated by this node.
 *
 * Terminal, same as {@link StreamEndFrame}. `error.code` is a `node/*` code for
 * transport-side terminations (`node/backpressure`, `node/frame-too-large`,
 * `node/stream-limit`) and the Gateway's own code for a business failure.
 */
export interface StreamErrorFrame extends BaseFrame {
  readonly type: 'stream.error'
  readonly streamId: string
  readonly error: NodeResultError
  /** `stream.data` frames sent before the failure. */
  readonly count: number
}

/** Coordinator -> Node: stop producing and release this stream. */
export interface StreamCancelFrame extends BaseFrame {
  readonly type: 'stream.cancel'
  readonly streamId: string
  /** Free-form, non-sensitive explanation for the log. */
  readonly reason?: string
}

/** Every frame this build can send. */
export type OutboundFrame =
  | HelloFrame
  | ReadyFrame
  | RpcResultFrame
  | StreamReadyFrame
  | StreamDataFrame
  | StreamEndFrame
  | StreamErrorFrame
  | PingFrame
  | PongFrame
  | CloseFrame

/** Every frame this build can receive. */
export type InboundFrame =
  | HelloOkFrame
  | RpcRequestFrame
  | RpcCancelFrame
  | StreamOpenFrame
  | StreamCancelFrame
  | PingFrame
  | PongFrame
  | CloseFrame

/** Any frame of this protocol. */
export type AnyFrame = OutboundFrame | InboundFrame

/** Frame types this build implements. */
export const FRAME_TYPES = [
  'hello',
  'hello.ok',
  'ready',
  'rpc.request',
  'rpc.result',
  'rpc.cancel',
  'stream.open',
  'stream.ready',
  'stream.data',
  'stream.end',
  'stream.error',
  'stream.cancel',
  'ping',
  'pong',
  'close',
] as const

/** One implemented frame type. */
export type FrameType = (typeof FRAME_TYPES)[number]

/**
 * Frames only a Coordinator may send. A node receiving its own outbound
 * vocabulary (`ready`, `rpc.result`, ...) has a peer that is confused or
 * hostile; such a frame is ignored with a protocol warning.
 */
export const COORDINATOR_FRAME_TYPES: ReadonlySet<string> = new Set<FrameType>([
  'hello.ok',
  'rpc.request',
  'rpc.cancel',
  'stream.open',
  'stream.cancel',
  'ping',
  'pong',
  'close',
])

/** Frames only a node may send. */
export const NODE_FRAME_TYPES: ReadonlySet<string> = new Set<FrameType>([
  'hello',
  'ready',
  'rpc.result',
  'stream.ready',
  'stream.data',
  'stream.end',
  'stream.error',
  'ping',
  'pong',
  'close',
])

/**
 * A secret-free snapshot of the node's runtime state (spec §11).
 *
 * Pure data, safe to serialize, log, or hand to a future status surface. The
 * token is deliberately absent from every field.
 */
export interface DshNodeStatus {
  readonly state: NodeState
  /** Stable node identity, persisted across restarts. */
  readonly nodeId: string
  /** Display metadata; never authentication material. */
  readonly nodeName?: string
  /** Display metadata; never authentication material. */
  readonly role?: string
  /** `scheme://host:port` only — never the path, query, or fragment. */
  readonly coordinatorOrigin?: string
  readonly connectionId?: string
  /** Consecutive failed connection attempts; `0` once the link is stable. */
  readonly reconnectAttempt: number
  /** ISO timestamp of the last successful handshake. */
  readonly lastConnectedAt?: string
  /** Last failure, already stripped of credentials. */
  readonly lastError?: {
    readonly code: string
    readonly message: string
    readonly at: string
  }
  /** Unary Remotes currently executing. */
  readonly inFlightRequests: number
  /** Open streams. Always `0` in Phase 1. */
  readonly activeStreams: number
}
