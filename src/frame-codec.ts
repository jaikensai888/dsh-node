/**
 * Encoding, size limiting, and structural validation of `dsh-node/1` frames.
 *
 * The codec is the protocol boundary. Anything it accepts is a well-formed
 * frame of the right direction; anything it rejects never reaches dispatch, so
 * a malformed frame can never be reinterpreted as a command (spec §7.1).
 *
 * @module dsh-node/frame-codec
 */

import { createHash } from 'node:crypto'
import { NodeError } from './errors.js'
import {
  FRAME_TYPES,
  PROTOCOL_VERSION,
  type AnyFrame,
  type CapabilityMode,
  type FrameType,
  type NodeCapabilitySummary,
} from './protocol.js'

/** Modes a stream/listener can deliver, used for raw socket data. */
export type RawFrameData = string | Buffer | ArrayBuffer | Uint8Array | readonly Buffer[] | readonly Uint8Array[]

/**
 * Normalize whatever the socket layer handed us into text.
 *
 * `ws` delivers text frames as a string or a Buffer depending on
 * `binaryType`, and fragments as an array; all three shapes are accepted so
 * the transport adapter never has to care.
 * @param data - raw socket payload.
 * @returns the payload decoded as UTF-8 text.
 */
export function toFrameText(data: RawFrameData): string {
  if (typeof data === 'string') return data
  if (Array.isArray(data)) {
    const parts = (data as readonly (Buffer | Uint8Array)[]).map(part => Buffer.from(part))
    return Buffer.concat(parts).toString('utf8')
  }
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return Buffer.from(data as Uint8Array).toString('utf8')
}

/**
 * Report the UTF-8 byte length of a frame body.
 * @param text - encoded frame.
 * @returns byte length, not character count.
 */
export function frameByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * Serialize one outbound frame, refusing to emit anything oversized.
 * @param frame - frame to send.
 * @param maxFrameBytes - outbound size ceiling.
 * @returns the JSON text to put on the wire.
 * @throws NodeError `node/frame-too-large` when the body exceeds the ceiling.
 */
export function encodeFrame(frame: AnyFrame, maxFrameBytes: number): string {
  const text = JSON.stringify(frame)
  const bytes = frameByteLength(text)
  if (bytes > maxFrameBytes) {
    throw new NodeError(
      'node/frame-too-large',
      `outbound ${frame.type} frame is ${bytes} bytes, over the ${maxFrameBytes} byte limit`,
      { type: frame.type, bytes, maxFrameBytes },
    )
  }
  return text
}

/**
 * Decode and validate one inbound frame.
 *
 * Validation is structural only: it guarantees the frame is a JSON object of a
 * known type with the fields that type requires. It makes no claim about
 * whether the node is in a state where the frame is legal — that belongs to the
 * connector's state machine.
 * @param data - raw socket payload.
 * @param maxFrameBytes - inbound size ceiling, applied before parsing.
 * @returns the validated frame.
 * @throws NodeError `node/frame-too-large` when oversized, `node/protocol-invalid` otherwise.
 */
export function decodeFrame(data: RawFrameData, maxFrameBytes: number): AnyFrame {
  const text = toFrameText(data)
  const bytes = frameByteLength(text)
  if (bytes > maxFrameBytes) {
    throw new NodeError(
      'node/frame-too-large',
      `inbound frame is ${bytes} bytes, over the ${maxFrameBytes} byte limit`,
      { bytes, maxFrameBytes },
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Never echo the body: it may contain a credential or business payload.
    throw new NodeError('node/protocol-invalid', 'inbound frame is not valid JSON', { reason: 'not-json', bytes })
  }
  if (!isPlainObject(parsed)) {
    throw new NodeError('node/protocol-invalid', 'inbound frame must be a JSON object', { reason: 'not-object' })
  }

  const type = parsed['type']
  if (typeof type !== 'string' || !isFrameType(type)) {
    throw new NodeError('node/protocol-invalid', 'inbound frame has an unknown type', {
      reason: 'unknown-type',
      type: typeof type === 'string' ? type : typeof type,
    })
  }

  const version = parsed['protocolVersion']
  if (version !== PROTOCOL_VERSION) {
    // `reason` is a stable marker: the connector treats a version mismatch
    // differently from every other malformed frame (spec §6.1).
    throw new NodeError(
      'node/protocol-invalid',
      `inbound ${type} frame declares an unsupported protocol version`,
      {
        reason: 'protocol-version',
        type,
        expected: PROTOCOL_VERSION,
        received: typeof version === 'string' ? version : typeof version,
      },
    )
  }

  requireWireString(parsed, 'nodeId', type)
  validateFrameBody(type, parsed)
  return parsed as unknown as AnyFrame
}

/**
 * Report whether a decode failure was a protocol-version mismatch.
 *
 * A peer that speaks another version cannot be retried into compatibility, so
 * the connector stops rather than looping (spec §6.1).
 * @param error - value thrown by {@link decodeFrame}.
 * @returns `true` for a version mismatch.
 */
export function isProtocolVersionFailure(error: unknown): boolean {
  return error instanceof NodeError && error.details['reason'] === 'protocol-version'
}

/**
 * Report whether a value is one of the frame types this build implements.
 * @param value - candidate type string.
 * @returns `true` for an implemented frame type.
 */
export function isFrameType(value: string): value is FrameType {
  return (FRAME_TYPES as readonly string[]).includes(value)
}

/**
 * Split a canonical `<namespace>/<method>` endpoint.
 *
 * Mirrors the Gateway's own rule exactly: the endpoint must be precisely two
 * non-empty `/`-separated segments. Anything else is rejected here rather than
 * being handed to the Gateway to fail on.
 * @param endpoint - candidate endpoint.
 * @returns the two segments.
 * @throws NodeError `node/protocol-invalid`.
 */
export function parseEndpoint(endpoint: unknown): { namespace: string; method: string } {
  if (typeof endpoint !== 'string' || endpoint === '') {
    throw new NodeError('node/protocol-invalid', 'rpc.request requires a non-empty endpoint string', {})
  }
  const segments = endpoint.split('/')
  const namespace = segments[0]
  const method = segments[1]
  if (segments.length !== 2 || namespace === undefined || method === undefined || namespace === '' || method === '') {
    throw new NodeError(
      'node/protocol-invalid',
      'endpoint must be exactly "<namespace>/<method>" with both segments non-empty',
      { endpoint },
    )
  }
  return { namespace, method }
}

/**
 * Validate the `{ args }` envelope of an `rpc.request`.
 *
 * The Gateway requires the carrier payload to be a plain object whose *only*
 * field is a plain-object `args` map. Enforcing the same shape here means a
 * malformed envelope is reported as a protocol error instead of surfacing as an
 * opaque gateway failure. The returned object is the caller's own reference: the
 * node never copies, renames, adds, or drops an argument (spec §7.3).
 * @param payload - the frame's `payload` field.
 * @returns the untouched `args` map.
 * @throws NodeError `node/protocol-invalid`.
 */
export function parseRequestArgs(payload: unknown): Readonly<Record<string, unknown>> {
  if (!isPlainObject(payload)) {
    throw new NodeError('node/protocol-invalid', 'rpc.request payload must be a plain object', {})
  }
  const keys = Reflect.ownKeys(payload)
  if (keys.length !== 1 || !Object.hasOwn(payload, 'args')) {
    throw new NodeError(
      'node/protocol-invalid',
      'rpc.request payload must contain exactly one "args" field',
      { fields: keys.map(String) },
    )
  }
  const args = payload['args']
  if (!isPlainObject(args)) {
    throw new NodeError('node/protocol-invalid', 'rpc.request payload.args must be a plain object', {})
  }
  return args as Readonly<Record<string, unknown>>
}

/**
 * Compute the stable digest of an advertised Remote surface.
 *
 * A controlled summary, not a reflection dump: only endpoint, mode, and the
 * namespaces that cannot be enumerated by method are hashed, so no path, token,
 * or environment value can leak through it.
 * @param remotes - sorted endpoint list.
 * @param namespaces - additional dispatchable namespaces.
 * @returns `sha256:<hex>`.
 */
export function capabilitySurfaceHash(
  remotes: readonly { readonly endpoint: string; readonly mode: CapabilityMode }[],
  namespaces: readonly string[],
): string {
  const surface = [
    ...remotes.map(entry => `${entry.mode} ${entry.endpoint}`),
    ...namespaces.map(namespace => `namespace ${namespace}`),
  ]
  const digest = createHash('sha256').update(surface.join('\n'), 'utf8').digest('hex')
  return `sha256:${digest}`
}

/**
 * Validate a decoded `ready` capability summary.
 *
 * Used by the fake Coordinator and future peers, not on this node's inbound
 * path (a node never receives `ready`).
 * @param value - candidate summary.
 * @returns `true` when the summary is well formed.
 */
export function isCapabilitySummary(value: unknown): value is NodeCapabilitySummary {
  if (!isPlainObject(value)) return false
  const remotes = value['remotes']
  if (!Array.isArray(remotes)) return false
  for (const entry of remotes) {
    if (!isPlainObject(entry)) return false
    if (typeof entry['endpoint'] !== 'string') return false
    if (entry['mode'] !== 'unary' && entry['mode'] !== 'stream') return false
  }
  if (typeof value['remoteSurfaceHash'] !== 'string') return false
  const namespaces = value['namespaces']
  return Array.isArray(namespaces) && namespaces.every(item => typeof item === 'string')
}

/** Per-type required-field validation. */
function validateFrameBody(type: FrameType, frame: Record<string, unknown>): void {
  switch (type) {
    case 'hello.ok':
      requireWireString(frame, 'connectionId', type)
      optionalFiniteNumber(frame, 'heartbeatIntervalMs', type)
      optionalFiniteNumber(frame, 'maxFrameBytes', type)
      optionalWireString(frame, 'acceptedMode', type)
      return
    case 'rpc.request':
      requireWireString(frame, 'requestId', type)
      requireWireString(frame, 'endpoint', type)
      if (!Object.hasOwn(frame, 'payload')) {
        throw invalidFrame(type, 'missing required field "payload"')
      }
      return
    case 'rpc.cancel':
      requireWireString(frame, 'requestId', type)
      optionalWireString(frame, 'reason', type)
      return
    case 'stream.open':
      requireWireString(frame, 'streamId', type)
      requireWireString(frame, 'endpoint', type)
      optionalWireString(frame, 'requestId', type)
      if (!Object.hasOwn(frame, 'payload')) {
        throw invalidFrame(type, 'missing required field "payload"')
      }
      return
    case 'stream.cancel':
      requireWireString(frame, 'streamId', type)
      optionalWireString(frame, 'reason', type)
      return
    case 'stream.data':
      requireWireString(frame, 'streamId', type)
      requireWireNumber(frame, 'seq', type)
      if (!Object.hasOwn(frame, 'value')) {
        throw invalidFrame(type, 'missing required field "value"')
      }
      return
    case 'stream.end':
      requireWireString(frame, 'streamId', type)
      requireWireNumber(frame, 'count', type)
      return
    case 'stream.error':
      requireWireString(frame, 'streamId', type)
      requireWireNumber(frame, 'count', type)
      if (!isPlainObject(frame['error'])) {
        throw invalidFrame(type, 'requires a plain-object field "error"')
      }
      return
    case 'close':
      optionalWireString(frame, 'code', type)
      optionalWireString(frame, 'reason', type)
      if (Object.hasOwn(frame, 'reconnect') && typeof frame['reconnect'] !== 'boolean') {
        throw invalidFrame(type, 'field "reconnect" must be a boolean')
      }
      return
    case 'hello':
    case 'ready':
    case 'rpc.result':
    case 'stream.ready':
    case 'ping':
    case 'pong':
      // Node-direction frames: a Coordinator sending these is handled as a
      // state-machine error, so the body needs no field validation here.
      return
    default:
      return assertNeverType(type)
  }
}

/** Exhaustiveness guard for {@link validateFrameBody}. */
function assertNeverType(type: never): never {
  throw new NodeError('node/protocol-invalid', `unhandled frame type ${String(type)}`, {})
}

function invalidFrame(type: string, detail: string): NodeError {
  return new NodeError('node/protocol-invalid', `${type} frame ${detail}`, { reason: 'invalid-field', type })
}

/** Cordis/JSON-safe plain object test. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function requireWireString(frame: Record<string, unknown>, field: string, type: string): string {
  const value = frame[field]
  if (typeof value !== 'string' || value === '') {
    throw invalidFrame(type, `requires a non-empty string field ${JSON.stringify(field)}`)
  }
  return value
}

function optionalWireString(frame: Record<string, unknown>, field: string, type: string): void {
  const value = frame[field]
  if (value === undefined) return
  if (typeof value !== 'string') {
    throw invalidFrame(type, `field ${JSON.stringify(field)} must be a string when present`)
  }
}

function optionalFiniteNumber(frame: Record<string, unknown>, field: string, type: string): void {
  const value = frame[field]
  if (value === undefined) return
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidFrame(type, `field ${JSON.stringify(field)} must be a finite number when present`)
  }
}

function requireWireNumber(frame: Record<string, unknown>, field: string, type: string): number {
  const value = frame[field]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidFrame(type, `requires a finite number field ${JSON.stringify(field)}`)
  }
  return value
}
