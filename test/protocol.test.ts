/**
 * Frame codec and protocol constants.
 *
 * Covers spec §12.1 items 8, 9, and the frame-size half of 14: what a
 * well-formed frame is, what a malformed one is, and the rule that an unknown or
 * misplaced frame is never reinterpreted as a command.
 */

import { describe, expect, it } from 'vitest'
import { NodeError, isNodeError } from '../src/errors.js'
import {
  capabilitySurfaceHash,
  decodeFrame,
  encodeFrame,
  frameByteLength,
  isCapabilitySummary,
  isFrameType,
  isPlainObject,
  parseEndpoint,
  parseRequestArgs,
  toFrameText,
} from '../src/frame-codec.js'
import {
  CAPABILITY_MODES,
  COORDINATOR_FRAME_TYPES,
  FRAME_TYPES,
  NODE_FRAME_TYPES,
  NODE_MODES,
  NODE_STATES,
  PROTOCOL_VERSION,
  type AnyFrame,
  type HelloFrame,
  type HelloOkFrame,
  type ReadyFrame,
} from '../src/protocol.js'

const NODE = 'node-abc123'
const TOKEN = 'secret-token'
const MAX = 4_194_304

/** Build a valid frame of the given shape with the shared envelope filled in. */
function frame<T extends AnyFrame>(body: Omit<T, 'protocolVersion' | 'nodeId'>): T {
  return { protocolVersion: PROTOCOL_VERSION, nodeId: NODE, ...body } as T
}

/** Round-trip a frame through the codec. */
function roundTrip(value: AnyFrame): AnyFrame {
  return decodeFrame(encodeFrame(value, MAX), MAX)
}

/** Assert that decoding throws a NodeError with the given code. */
function expectCode(run: () => unknown, code: string): NodeError {
  try {
    run()
  } catch (error) {
    expect(isNodeError(error)).toBe(true)
    expect((error as NodeError).code).toBe(code)
    return error as NodeError
  }
  throw new Error(`expected a ${code} failure`)
}

describe('protocol constants', () => {
  it('declares the full Phase 1 + Phase 2 frame set', () => {
    expect([...FRAME_TYPES].sort()).toEqual([
      'close',
      'hello',
      'hello.ok',
      'ping',
      'pong',
      'ready',
      'rpc.cancel',
      'rpc.request',
      'rpc.result',
      'stream.cancel',
      'stream.data',
      'stream.end',
      'stream.error',
      'stream.open',
      'stream.ready',
    ])
  })

  it('gives every stream frame the direction the spec requires', () => {
    for (const type of ['stream.open', 'stream.cancel'] as const) {
      expect(COORDINATOR_FRAME_TYPES.has(type), type).toBe(true)
      expect(NODE_FRAME_TYPES.has(type), type).toBe(false)
    }
    for (const type of ['stream.ready', 'stream.data', 'stream.end', 'stream.error'] as const) {
      expect(NODE_FRAME_TYPES.has(type), type).toBe(true)
      expect(COORDINATOR_FRAME_TYPES.has(type), type).toBe(false)
    }
  })

  it('separates the two frame directions', () => {
    expect([...COORDINATOR_FRAME_TYPES].sort()).toEqual([
      'close',
      'hello.ok',
      'ping',
      'pong',
      'rpc.cancel',
      'rpc.request',
      'stream.cancel',
      'stream.open',
    ])
    for (const type of ['hello', 'ready', 'rpc.result', 'stream.data'] as const) {
      expect(COORDINATOR_FRAME_TYPES.has(type), type).toBe(false)
    }
  })

  it('defines the full state machine and exactly one mode', () => {
    expect([...NODE_STATES].sort()).toEqual([
      'auth_failed',
      'authenticating',
      'backoff',
      'closing',
      'connecting',
      'paused',
      'ready',
      'stopped',
      'unconfigured',
    ])
    expect([...NODE_MODES]).toEqual(['full-access'])
    expect([...CAPABILITY_MODES]).toEqual(['unary', 'stream'])
  })
})

describe('handshake frames (spec §12.1 item 8)', () => {
  it('round-trips a hello frame carrying exactly the specified fields', () => {
    const hello: HelloFrame = frame<HelloFrame>({
      type: 'hello',
      mode: 'full-access',
      nodeName: 'test-agent-a',
      role: 'test-agent',
      auth: { type: 'bearer', token: TOKEN },
      dsh: { remoteSurfaceHash: 'sha256:abc' },
    })
    const decoded = roundTrip(hello) as HelloFrame
    expect(decoded).toEqual(hello)
    expect(decoded.mode).toBe('full-access')
    expect(decoded.auth).toEqual({ type: 'bearer', token: TOKEN })
  })

  it('round-trips hello.ok, including the optional limits', () => {
    const ok: HelloOkFrame = frame<HelloOkFrame>({
      type: 'hello.ok',
      connectionId: 'conn-1',
      heartbeatIntervalMs: 20_000,
      maxFrameBytes: 65_536,
      acceptedMode: 'full-access',
    })
    expect(roundTrip(ok)).toEqual(ok)
  })

  it('accepts hello.ok with only its required field', () => {
    const ok: HelloOkFrame = frame<HelloOkFrame>({ type: 'hello.ok', connectionId: 'conn-1' })
    expect(roundTrip(ok)).toEqual(ok)
  })

  it.each([
    ['connectionId', {}],
    ['connectionId', { connectionId: '' }],
    ['connectionId', { connectionId: 42 }],
  ])('rejects hello.ok with a bad %s', (_field, body) => {
    expectCode(
      () => decodeFrame(JSON.stringify({ type: 'hello.ok', protocolVersion: PROTOCOL_VERSION, nodeId: NODE, ...body }), MAX),
      'node/protocol-invalid',
    )
  })

  it.each([
    ['heartbeatIntervalMs', 'soon'],
    ['heartbeatIntervalMs', Number.POSITIVE_INFINITY],
    ['maxFrameBytes', 'big'],
    ['acceptedMode', 7],
  ])('rejects hello.ok with a bad optional %s', (field, value) => {
    expectCode(
      () => decodeFrame(
        JSON.stringify({
          type: 'hello.ok',
          protocolVersion: PROTOCOL_VERSION,
          nodeId: NODE,
          connectionId: 'conn-1',
          [field]: value,
        }),
        MAX,
      ),
      'node/protocol-invalid',
    )
  })

  it('round-trips a ready frame carrying the capability summary', () => {
    const ready: ReadyFrame = frame<ReadyFrame>({
      type: 'ready',
      connectionId: 'conn-1',
      dsh: { remoteSurfaceHash: 'sha256:abc' },
      capabilities: {
        remotes: [
          { endpoint: 'session/create', mode: 'unary' },
          { endpoint: 'session/follow', mode: 'stream' },
        ],
        remoteSurfaceHash: 'sha256:abc',
        namespaces: ['demo'],
      },
    })
    const decoded = roundTrip(ready) as ReadyFrame
    expect(decoded).toEqual(ready)
    expect(isCapabilitySummary(decoded.capabilities)).toBe(true)
  })

  it.each([
    [{ remotes: 'nope', remoteSurfaceHash: 'x', namespaces: [] }],
    [{ remotes: [{ endpoint: 'a/b', mode: 'unary' }] }],
    [{ remotes: [{ endpoint: 'a/b', mode: 'both' }], remoteSurfaceHash: 'x', namespaces: [] }],
    [{ remotes: [], remoteSurfaceHash: 1, namespaces: [] }],
    [{ remotes: [], remoteSurfaceHash: 'x', namespaces: [1] }],
  ])('rejects a malformed capability summary %#', summary => {
    expect(isCapabilitySummary(summary)).toBe(false)
  })
})

describe('unknown and misplaced frames (spec §12.1 item 9)', () => {
  it('rejects an unknown type', () => {
    // `stream.resume` is deliberately not implemented: v1 has no stream
    // continuation, so a peer asking for one is speaking a protocol this build
    // does not have.
    const error = expectCode(
      () => decodeFrame(JSON.stringify({ type: 'stream.resume', protocolVersion: PROTOCOL_VERSION, nodeId: NODE }), MAX),
      'node/protocol-invalid',
    )
    expect(error.message).toMatch(/unknown type/u)
    // The offending value is reported, but a payload never is.
    expect(error.details['type']).toBe('stream.resume')
  })

  it('rejects a frame that is not JSON at all', () => {
    expectCode(() => decodeFrame('{', MAX), 'node/protocol-invalid')
    expectCode(() => decodeFrame('null', MAX), 'node/protocol-invalid')
    expectCode(() => decodeFrame('[]', MAX), 'node/protocol-invalid')
    expectCode(() => decodeFrame('"ready"', MAX), 'node/protocol-invalid')
  })

  it.each([
    ['a missing type', { protocolVersion: PROTOCOL_VERSION, nodeId: NODE }],
    ['a non-string type', { type: 7, protocolVersion: PROTOCOL_VERSION, nodeId: NODE }],
  ])('rejects %s', (_label, body) => {
    expectCode(() => decodeFrame(JSON.stringify(body), MAX), 'node/protocol-invalid')
  })

  it('rejects a wrong protocolVersion on any frame', () => {
    for (const version of ['dsh-node/2', 'dsh-node', '', 1, undefined]) {
      const error = expectCode(
        () => decodeFrame(JSON.stringify({ type: 'ping', protocolVersion: version, nodeId: NODE }), MAX),
        'node/protocol-invalid',
      )
      expect(error.message).toMatch(/unsupported protocol version/u)
      expect(error.details['expected']).toBe(PROTOCOL_VERSION)
    }
  })

  it('rejects a frame without a nodeId', () => {
    expectCode(() => decodeFrame(JSON.stringify({ type: 'ping', protocolVersion: PROTOCOL_VERSION }), MAX), 'node/protocol-invalid')
    expectCode(
      () => decodeFrame(JSON.stringify({ type: 'ping', protocolVersion: PROTOCOL_VERSION, nodeId: '' }), MAX),
      'node/protocol-invalid',
    )
  })

  it('accepts a node-direction frame structurally, leaving direction to the connector', () => {
    // The codec answers "is this a well-formed frame of this protocol?", not
    // "may this peer send it?". Direction is the state machine's decision.
    const decoded = decodeFrame(
      JSON.stringify({ type: 'ready', protocolVersion: PROTOCOL_VERSION, nodeId: NODE }),
      MAX,
    )
    expect(decoded.type).toBe('ready')
    expect(isFrameType(decoded.type)).toBe(true)
  })

  it('never echoes the frame body in a rejection', () => {
    const error = expectCode(
      () => decodeFrame(JSON.stringify({ type: 'nope', protocolVersion: PROTOCOL_VERSION, nodeId: NODE, token: TOKEN }), MAX),
      'node/protocol-invalid',
    )
    expect(JSON.stringify(error)).not.toContain(TOKEN)
  })
})

describe('frame size limit (spec §12.1 item 14)', () => {
  it('refuses to encode an oversized frame', () => {
    const hello = frame<HelloFrame>({
      type: 'hello',
      mode: 'full-access',
      auth: { type: 'bearer', token: 'x'.repeat(500) },
    })
    const error = expectCode(() => encodeFrame(hello, 128), 'node/frame-too-large')
    expect(error.details['bytes']).toBeGreaterThan(128)
    expect(error.details['maxFrameBytes']).toBe(128)
  })

  it('refuses to decode an oversized frame before parsing it', () => {
    const oversized = JSON.stringify({ type: 'ping', protocolVersion: PROTOCOL_VERSION, nodeId: NODE, pad: 'x'.repeat(400) })
    const error = expectCode(() => decodeFrame(oversized, 128), 'node/frame-too-large')
    expect(error.details['bytes']).toBeGreaterThan(128)
  })

  it('measures bytes, not characters', () => {
    expect(frameByteLength('abc')).toBe(3)
    expect(frameByteLength('「」')).toBe(6)
    expect(frameByteLength('')).toBe(0)
  })

  it('accepts a frame exactly at the limit', () => {
    const hello = frame<HelloFrame>({ type: 'hello', mode: 'full-access', auth: { type: 'bearer', token: TOKEN } })
    const text = encodeFrame(hello, MAX)
    const exact = frameByteLength(text)
    expect(() => encodeFrame(hello, exact)).not.toThrow()
    expect(() => decodeFrame(text, exact)).not.toThrow()
    expectCode(() => decodeFrame(text, exact - 1), 'node/frame-too-large')
  })
})

describe('raw socket data shapes', () => {
  it('accepts a string, a Buffer, an ArrayBuffer, and a fragment array', () => {
    const text = JSON.stringify({ type: 'ping', protocolVersion: PROTOCOL_VERSION, nodeId: NODE })
    const bytes = Buffer.from(text, 'utf8')
    expect(toFrameText(text)).toBe(text)
    expect(toFrameText(bytes)).toBe(text)
    expect(toFrameText(new Uint8Array(bytes))).toBe(text)
    expect(toFrameText(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)).toBe(text)
    expect(toFrameText([Buffer.from('{"type":', 'utf8'), Buffer.from('"ping"}', 'utf8')])).toBe('{"type":"ping"}')
  })

  it('decodes each shape identically', () => {
    const text = JSON.stringify({ type: 'ping', protocolVersion: PROTOCOL_VERSION, nodeId: NODE })
    expect(decodeFrame(Buffer.from(text, 'utf8'), MAX).type).toBe('ping')
    expect(decodeFrame(new Uint8Array(Buffer.from(text, 'utf8')), MAX).type).toBe('ping')
  })
})

describe('endpoint parsing (spec §7.3)', () => {
  it('splits exactly two non-empty segments', () => {
    expect(parseEndpoint('session/create')).toEqual({ namespace: 'session', method: 'create' })
    expect(parseEndpoint('workspace/insert-before')).toEqual({ namespace: 'workspace', method: 'insert-before' })
  })

  it.each(['session', 'session/', '/create', '', 'a/b/c', 'session//create', 'a/b/'])(
    'rejects %j, which the Gateway would also refuse',
    endpoint => {
      const error = expectCode(() => parseEndpoint(endpoint), 'node/protocol-invalid')
      // The two-segment rule is the Gateway's own; the empty-string case gets a
      // more specific diagnostic, so both are accepted here.
      expect(error.message).toMatch(/endpoint/u)
      expect(error.message).toMatch(/exactly "<namespace>\/<method>"|non-empty/u)
    },
  )

  it('rejects a non-string endpoint', () => {
    for (const value of [undefined, null, 7, {}, []]) {
      expectCode(() => parseEndpoint(value), 'node/protocol-invalid')
    }
  })
})

describe('rpc.request payload envelope (spec §7.3)', () => {
  it('returns the caller\'s own args object, unmodified', () => {
    const args = { workspaceId: 'w-1', nested: { keep: [1, 2, 3] } }
    const parsed = parseRequestArgs({ args })
    // Identity, not deep equality: the node must not copy, rename, add, or drop
    // a field, because the Gateway asserts an exact match against the descriptor.
    expect(parsed).toBe(args)
  })

  it('preserves an empty args map', () => {
    const args = {}
    expect(parseRequestArgs({ args })).toBe(args)
  })

  it.each([
    ['a missing payload', undefined],
    ['a null payload', null],
    ['an array payload', []],
    ['a string payload', 'args'],
    ['a bare args map', { workspaceId: 'w-1' }],
    ['a payload with an extra field', { args: {}, endpoint: 'session/create' }],
    ['a payload with only the wrong field', { arguments: {} }],
  ])('rejects %s', (_label, payload) => {
    expectCode(() => parseRequestArgs(payload), 'node/protocol-invalid')
  })

  it.each([['a null args', null], ['an array args', []], ['a string args', 'x'], ['a missing args', undefined]])(
    'rejects %s',
    (_label, args) => {
      expectCode(() => parseRequestArgs({ args }), 'node/protocol-invalid')
    },
  )

  it('rejects a payload whose args is present but not a plain object', () => {
    class Args {
      readonly value = 1
    }
    expectCode(() => parseRequestArgs({ args: new Args() }), 'node/protocol-invalid')
  })
})

describe('plain-object test', () => {
  it('accepts object literals and null-prototype maps only', () => {
    expect(isPlainObject({})).toBe(true)
    expect(isPlainObject(Object.create(null))).toBe(true)
    expect(isPlainObject([])).toBe(false)
    expect(isPlainObject(null)).toBe(false)
    expect(isPlainObject(new Date())).toBe(false)
    expect(isPlainObject(new Map())).toBe(false)
    expect(isPlainObject('x')).toBe(false)
  })
})

describe('capability surface digest', () => {
  it('is stable for the same surface and changes when the surface does', () => {
    const remotes = [
      { endpoint: 'session/create', mode: 'unary' as const },
      { endpoint: 'session/follow', mode: 'stream' as const },
    ]
    const base = capabilitySurfaceHash(remotes, ['demo'])
    expect(base).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(capabilitySurfaceHash(remotes, ['demo'])).toBe(base)
    expect(capabilitySurfaceHash(remotes, [])).not.toBe(base)
    expect(capabilitySurfaceHash(remotes, ['demo', 'other'])).not.toBe(base)
    expect(capabilitySurfaceHash([...remotes, { endpoint: 'session/list', mode: 'unary' }], ['demo'])).not.toBe(base)
    expect(capabilitySurfaceHash([{ ...remotes[0]!, mode: 'stream' }, remotes[1]!], ['demo'])).not.toBe(base)
  })

  it('carries no path, host, or credential', () => {
    const digest = capabilitySurfaceHash([{ endpoint: 'session/create', mode: 'unary' }], [])
    expect(digest).not.toContain('C:')
    expect(digest).not.toContain(TOKEN)
  })
})
