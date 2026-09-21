/**
 * Stream forwarding: sequencing, limits, backpressure, and termination.
 *
 * The manager is driven here with a fake clock and a fake transport, so the
 * drain deadline and the send counters are asserted exactly rather than
 * approximately. The integration suite covers the same code against a real
 * Gateway and a real socket.
 */

import { describe, expect, it, vi } from 'vitest'
import { RemoteCodeError, nodeFailure } from '../src/errors.js'
import { PROTOCOL_VERSION, type OutboundFrame, type StreamDataFrame, type StreamErrorFrame } from '../src/protocol.js'
import {
  StreamManager,
  type StreamEvent,
  type StreamManagerOptions,
  type StreamManagerTimers,
} from '../src/stream-manager.js'

const NODE = 'node-test-01'

/** A clock the test drives, including the `drain` polling loop. */
class FakeTimers implements StreamManagerTimers {
  private current = 0
  private readonly sleepers: { at: number; resolve: () => void }[] = []

  now(): number {
    return this.current
  }

  setTimeout(handler: () => void, ms: number) {
    const entry = { at: this.current + ms, resolve: handler }
    this.sleepers.push(entry)
    return { cancel: () => { entry.resolve = () => {} } }
  }

  sleep(ms: number): Promise<void> {
    return new Promise<void>(resolve => {
      this.sleepers.push({ at: this.current + ms, resolve })
    })
  }

  /**
   * Advance the clock, waking every sleeper that comes due.
   *
   * The leading macrotask hop lets a just-started `pump` reach its first
   * `sleep`; without it the queue is empty when we look and the deadline is
   * never reached. A hop after each wake-up gives the `drain` loop its turn to
   * re-check the transport and queue the next sleep, which is what makes the
   * deadline deterministic instead of flaky.
   */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms
    await new Promise(resolve => { setTimeout(resolve, 0) })
    for (;;) {
      const due = this.sleepers.filter(entry => entry.at <= target).sort((left, right) => left.at - right.at)[0]
      if (due === undefined) break
      this.sleepers.splice(this.sleepers.indexOf(due), 1)
      this.current = due.at
      due.resolve()
      await new Promise(resolve => { setTimeout(resolve, 0) })
    }
    this.current = target
  }
}

interface Harness {
  manager: StreamManager
  timers: FakeTimers
  sent: OutboundFrame[]
  events: StreamEvent[]
  setBuffered: (bytes: number) => void
  setSendOk: (ok: boolean) => void
}

function harness(options: Partial<StreamManagerOptions> = {}): Harness {
  const timers = new FakeTimers()
  const sent: OutboundFrame[] = []
  const events: StreamEvent[] = []
  let buffered = 0
  let sendOk = true

  const manager = new StreamManager({
    nodeId: () => NODE,
    maxStreams: 2,
    maxFrameBytes: 4_096,
    maxBufferedBytesPerStream: 1_000,
    sendStallTimeoutMs: 50,
    drainPollMs: 10,
    send: frame => {
      if (!sendOk) return false
      sent.push(frame)
      return true
    },
    bufferedBytes: () => buffered,
    timers,
    onEvent: event => { events.push(event) },
    ...options,
  })

  return {
    manager,
    timers,
    sent,
    events,
    setBuffered: bytes => { buffered = bytes },
    setSendOk: ok => { sendOk = ok },
  }
}

/** An open frame with the shared envelope filled in. */
function openFrame(streamId: string, endpoint = 'session/follow', requestId?: string) {
  return {
    type: 'stream.open' as const,
    protocolVersion: PROTOCOL_VERSION,
    nodeId: NODE,
    streamId,
    endpoint,
    payload: { args: {} },
    ...(requestId === undefined ? {} : { requestId }),
  }
}

/** Yield the given values, then finish. */
async function* yields(...values: unknown[]): AsyncIterable<unknown> {
  for (const value of values) yield value
}

/** Yield nothing and never finish until aborted. */
function neverEnding(signal?: AbortSignal): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (signal?.aborted === true) return
        yield 'tick'
        await new Promise(resolve => { setTimeout(resolve, 1) })
      }
    },
  }
}

/** Every frame of one type the node sent. */
function framesOfType<T extends OutboundFrame['type']>(sent: OutboundFrame[], type: T) {
  return sent.filter(frame => frame.type === type) as Extract<OutboundFrame, { type: T }>[]
}

describe('admission', () => {
  it('admits a stream and reports it as active', () => {
    const test = harness()
    const result = test.manager.open(openFrame('s-1', 'session/follow', 'req-1'))
    expect(result.ok).toBe(true)
    expect(test.manager.size).toBe(1)
    expect(test.manager.has('s-1')).toBe(true)
    expect(test.manager.active[0]).toMatchObject({ streamId: 's-1', endpoint: 'session/follow', requestId: 'req-1', count: 0 })
    expect(test.events.map(event => event.kind)).toEqual(['opened'])
  })

  it('refuses a duplicate open without disturbing the first stream', () => {
    const test = harness()
    expect(test.manager.open(openFrame('s-1')).ok).toBe(true)
    const second = test.manager.open(openFrame('s-1'))
    expect(second.ok).toBe(false)
    expect(second.ok === false && second.error.code).toBe('node/protocol-invalid')
    expect(test.manager.size).toBe(1)
  })

  it('refuses an open beyond maxStreams with node/stream-limit', () => {
    const test = harness({ maxStreams: 2 })
    expect(test.manager.open(openFrame('s-1')).ok).toBe(true)
    expect(test.manager.open(openFrame('s-2')).ok).toBe(true)
    const third = test.manager.open(openFrame('s-3'))
    expect(third.ok).toBe(false)
    expect(third.ok === false && third.error.code).toBe('node/stream-limit')
    expect(third.ok === false && third.error.details['maxStreams']).toBe(2)
    expect(test.manager.size).toBe(2)
  })

  it('frees a slot as soon as a stream terminates', () => {
    const test = harness({ maxStreams: 1 })
    test.manager.open(openFrame('s-1'))
    expect(test.manager.open(openFrame('s-2')).ok).toBe(false)
    test.manager.end('s-1')
    expect(test.manager.open(openFrame('s-2')).ok).toBe(true)
  })
})

describe('sequencing', () => {
  it('acknowledges with stream.ready before any data, echoing the requestId', () => {
    const test = harness()
    test.manager.open(openFrame('s-1', 'session/follow', 'req-7'))
    expect(test.manager.ready('s-1')).toBe(true)

    const ready = framesOfType(test.sent, 'stream.ready')[0]
    expect(ready).toMatchObject({ streamId: 's-1', requestId: 'req-7', nodeId: NODE })
    expect(framesOfType(test.sent, 'stream.data')).toHaveLength(0)
  })

  it('numbers stream.data from 1 with no gaps', async () => {
    const test = harness()
    test.manager.open(openFrame('s-1'))
    await test.manager.pump('s-1', yields('a', 'b', 'c'))

    const data = framesOfType(test.sent, 'stream.data')
    expect(data.map(frame => frame.seq)).toEqual([1, 2, 3])
    expect(data.map(frame => frame.value)).toEqual(['a', 'b', 'c'])
    expect(data.every(frame => frame.streamId === 's-1')).toBe(true)
  })

  it('numbers each stream independently', async () => {
    const test = harness()
    test.manager.open(openFrame('s-1'))
    test.manager.open(openFrame('s-2'))
    await test.manager.pump('s-1', yields('a', 'b'))
    await test.manager.pump('s-2', yields('x'))

    expect(framesOfType(test.sent, 'stream.data').map(frame => `${frame.streamId}:${frame.seq}`))
      .toEqual(['s-1:1', 's-1:2', 's-2:1'])
  })

  it('ends with stream.end carrying the data count', async () => {
    const test = harness()
    test.manager.open(openFrame('s-1'))
    await test.manager.pump('s-1', yields('a', 'b'))

    const end = framesOfType(test.sent, 'stream.end')
    expect(end).toHaveLength(1)
    expect(end[0]).toMatchObject({ streamId: 's-1', count: 2 })
    expect(test.manager.has('s-1')).toBe(false)
    expect(test.manager.size).toBe(0)
  })

  it('ends an immediately empty stream with count 0', async () => {
    const test = harness()
    test.manager.open(openFrame('s-1'))
    await test.manager.pump('s-1', yields())
    expect(framesOfType(test.sent, 'stream.end')[0]).toMatchObject({ count: 0 })
  })

  it('sends nothing at all after the terminal frame', async () => {
    const test = harness()
    test.manager.open(openFrame('s-1'))
    await test.manager.pump('s-1', yields('a'))
    const after = test.sent.length

    // Every later entry point must be inert.
    expect(test.manager.end('s-1')).toBe(false)
    expect(test.manager.fail('s-1', { code: 'node/shutdown', message: 'late', details: {} })).toBe(false)
    expect(test.manager.ready('s-1')).toBe(false)
    expect(test.manager.cancel({ type: 'stream.cancel', protocolVersion: PROTOCOL_VERSION, nodeId: NODE, streamId: 's-1' })).toBe(false)
    expect(test.sent).toHaveLength(after)
  })

  it('pumps exactly once per stream: a second pump on the same id is inert', async () => {
    const test = harness()
    test.manager.open(openFrame('s-1'))
    await test.manager.pump('s-1', yields('a'))
    // The entry is gone, so a late pump cannot emit a second terminal frame.
    await test.manager.pump('s-1', yields('b'))
    expect(framesOfType(test.sent, 'stream.data')).toHaveLength(1)
    expect(framesOfType(test.sent, 'stream.end')).toHaveLength(1)
  })

  it('carries the node identity on every outbound stream frame', async () => {
    const test = harness()
    test.manager.open(openFrame('s-1'))
    test.manager.ready('s-1')
    await test.manager.pump('s-1', yields('a'))
    for (const frame of test.sent) expect(frame.nodeId, frame.type).toBe(NODE)
  })
})

describe('failure reporting', () => {
  it('projects an iteration failure through failureOf, preserving a business code', async () => {
    const test = harness({
      failureOf: (error: unknown) => {
        const failure = nodeFailure(error)
        return failure
      },
    })
    test.manager.open(openFrame('s-1'))
    const source: AsyncIterable<unknown> = {
      // eslint-disable-next-line require-yield
      async *[Symbol.asyncIterator]() {
        throw new RemoteCodeError('session/not-found', 'the session went away', { sessionId: 'x' })
      },
    }

    await test.manager.pump('s-1', source)

    const errors = framesOfType(test.sent, 'stream.error')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.error.code).toBe('session/not-found')
    expect(errors[0]!.error.details).toEqual({ sessionId: 'x' })
    expect(errors[0]!.count).toBe(0)
    expect(test.manager.has('s-1')).toBe(false)
  })

  it('reports a value too large to ever fit instead of dropping it silently', async () => {
    const test = harness({ maxFrameBytes: 200 })
    test.manager.open(openFrame('s-1'))
    await test.manager.pump('s-1', yields('x'.repeat(500)))

    const errors = framesOfType(test.sent, 'stream.error')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.error.code).toBe('node/frame-too-large')
    expect(framesOfType(test.sent, 'stream.data')).toHaveLength(0)
  })

  it('reports a value that cannot be serialized as node/result-invalid', async () => {
    const test = harness()
    test.manager.open(openFrame('s-1'))
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    await test.manager.pump('s-1', yields(cyclic))

    expect(framesOfType(test.sent, 'stream.error')[0]!.error.code).toBe('node/result-invalid')
  })

  it('fails with node/connection-lost when the transport refuses the frame', async () => {
    const test = harness()
    test.manager.open(openFrame('s-1'))
    test.setSendOk(false)
    await test.manager.pump('s-1', yields('a'))

    const errors = framesOfType(test.sent, 'stream.error')
    // Nothing could be sent, so the failure is only observable through events.
    expect(errors).toHaveLength(0)
    expect(test.manager.has('s-1')).toBe(false)
    expect(test.events.map(event => `${event.kind}:${event.code ?? ''}`))
      .toContain('stalled:node/connection-lost')
  })
})

describe('backpressure (spec §8.2)', () => {
  it('waits for the transport to drain rather than terminating immediately', async () => {
    const test = harness({ maxBufferedBytesPerStream: 1_000, sendStallTimeoutMs: 50 })
    test.manager.open(openFrame('s-1'))
    test.setBuffered(5_000)

    const pumping = test.manager.pump('s-1', yields('a'))
    // Give the drain loop a couple of polls, then let the transport catch up.
    await test.timers.advance(20)
    expect(framesOfType(test.sent, 'stream.data')).toHaveLength(0)
    test.setBuffered(0)
    await test.timers.advance(20)
    await pumping

    expect(framesOfType(test.sent, 'stream.data')).toHaveLength(1)
    expect(framesOfType(test.sent, 'stream.end')).toHaveLength(1)
    expect(framesOfType(test.sent, 'stream.error')).toHaveLength(0)
  })

  it('terminates the stream with node/backpressure when the transport never drains', async () => {
    const test = harness({ maxBufferedBytesPerStream: 1_000, sendStallTimeoutMs: 50, drainPollMs: 10 })
    test.manager.open(openFrame('s-1'))
    test.setBuffered(9_999)

    const pumping = test.manager.pump('s-1', yields('a'))
    await test.timers.advance(200)
    await pumping

    const errors = framesOfType(test.sent, 'stream.error')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.error.code).toBe('node/backpressure')
    expect(errors[0]!.error.details).toMatchObject({ maxBufferedBytesPerStream: 1_000, sendStallTimeoutMs: 50 })
    expect(framesOfType(test.sent, 'stream.data')).toHaveLength(0)
    expect(test.events.some(event => event.kind === 'backpressure')).toBe(true)
    expect(test.manager.size).toBe(0)
  })

  it('does not pull the next value while the transport is behind', async () => {
    // The strongest statement of "pause the iterator": the source is only asked
    // for value N+1 after value N has been accepted by a drained transport.
    const pulled: number[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const source: AsyncIterable<unknown> = {
      async *[Symbol.asyncIterator]() {
        for (let index = 1; index <= 2; index += 1) {
          if (index === 2) await gate
          pulled.push(index)
          yield index
        }
      },
    }

    const test = harness({ maxBufferedBytesPerStream: 1_000 })
    test.manager.open(openFrame('s-1'))
    test.setBuffered(5_000)

    const pumping = test.manager.pump('s-1', source)
    await test.timers.advance(20)
    // Value 1 was pulled but could not be sent, so value 2 is never requested.
    expect(pulled).toEqual([1])
    expect(framesOfType(test.sent, 'stream.data')).toHaveLength(0)

    test.setBuffered(0)
    release()
    await test.timers.advance(20)
    await pumping
    expect(pulled).toEqual([1, 2])
    expect(framesOfType(test.sent, 'stream.data').map(frame => frame.seq)).toEqual([1, 2])
  })
})

describe('cancellation and connection loss', () => {
  it('cancels with gateway/cancelled and aborts the source signal', () => {
    const test = harness()
    const admitted = test.manager.open(openFrame('s-1'))
    expect(admitted.ok).toBe(true)
    const signal = admitted.ok ? admitted.stream.signal : undefined
    expect(signal?.aborted).toBe(false)

    expect(test.manager.cancel({
      type: 'stream.cancel',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: NODE,
      streamId: 's-1',
      reason: 'operator stopped it',
    })).toBe(true)

    const errors = framesOfType(test.sent, 'stream.error')
    expect(errors).toHaveLength(1)
    // The code a local DSH caller sees for the same cancellation, not node/*.
    expect(errors[0]!.error.code).toBe('gateway/cancelled')
    expect(errors[0]!.error.message).toBe('operator stopped it')
    expect(signal?.aborted).toBe(true)
    expect(test.manager.size).toBe(0)
  })

  it('reports the abort reason as a wire code, not a bare Error', () => {
    const test = harness()
    const admitted = test.manager.open(openFrame('s-1'))
    test.manager.fail('s-1', { code: 'node/backpressure', message: 'too slow', details: {} })
    const reason = admitted.ok ? admitted.stream.signal.reason : undefined
    expect(reason).toBeInstanceOf(RemoteCodeError)
    expect((reason as RemoteCodeError).code).toBe('node/backpressure')
  })

  it('ignores a cancel for an unknown stream', () => {
    const test = harness()
    expect(test.manager.cancel({ type: 'stream.cancel', protocolVersion: PROTOCOL_VERSION, nodeId: NODE, streamId: 'nope' }))
      .toBe(false)
    expect(test.sent).toHaveLength(0)
  })

  it('stops an in-flight pump when the stream is cancelled', async () => {
    const test = harness()
    const admitted = test.manager.open(openFrame('s-1'))
    const signal = admitted.ok ? admitted.stream.signal : undefined

    const pumping = test.manager.pump('s-1', neverEnding(signal))
    await new Promise(resolve => { setTimeout(resolve, 5) })
    test.manager.cancel({ type: 'stream.cancel', protocolVersion: PROTOCOL_VERSION, nodeId: NODE, streamId: 's-1' })
    await pumping

    // Exactly one terminal frame: the cancel's, and nothing after it.
    expect(framesOfType(test.sent, 'stream.error')).toHaveLength(1)
    expect(framesOfType(test.sent, 'stream.end')).toHaveLength(0)
  })

  it('releases every stream without reporting when the transport is gone', async () => {
    const test = harness({ maxStreams: 4 })
    const first = test.manager.open(openFrame('s-1'))
    const second = test.manager.open(openFrame('s-2'))
    const signals = [first, second].map(result => (result.ok ? result.stream.signal : undefined))

    const released = test.manager.failAll({ code: 'node/connection-lost', message: 'gone', details: {} }, false)

    expect(released).toEqual(['s-1', 's-2'])
    expect(test.manager.size).toBe(0)
    // No frame is pretended: the socket is gone, so nothing was sent.
    expect(test.sent).toHaveLength(0)
    for (const signal of signals) expect(signal?.aborted).toBe(true)
  })

  it('reports a terminal frame per stream when the node is shutting down', () => {
    const test = harness({ maxStreams: 4 })
    test.manager.open(openFrame('s-1'))
    test.manager.open(openFrame('s-2'))

    const released = test.manager.failAll({ code: 'node/shutdown', message: 'stopping', details: {} }, true)

    expect(released).toEqual(['s-1', 's-2'])
    const errors = framesOfType(test.sent, 'stream.error')
    expect(errors.map(frame => frame.streamId)).toEqual(['s-1', 's-2'])
    expect(errors.every(frame => frame.error.code === 'node/shutdown')).toBe(true)
  })

  it('is a no-op when nothing is open', () => {
    const test = harness()
    expect(test.manager.failAll({ code: 'node/shutdown', message: 'stopping', details: {} }, true)).toEqual([])
    expect(test.sent).toHaveLength(0)
  })
})

describe('event stream', () => {
  it('reports only counts, codes, and identifiers — never values', async () => {
    const test = harness()
    test.manager.open(openFrame('s-1', 'session/follow'))
    await test.manager.pump('s-1', yields({ secret: 'payload-value' }))

    const text = JSON.stringify(test.events)
    expect(text).not.toContain('payload-value')
    expect(test.events.map(event => event.kind)).toContain('opened')
    expect(test.events.map(event => event.kind)).toContain('data')
    expect(test.events.map(event => event.kind)).toContain('ended')
  })

  it('contains an observer that throws, so stream accounting survives it', async () => {
    const explode = vi.fn(() => { throw new Error('observer bug') })
    const test = harness({ onEvent: explode })
    test.manager.open(openFrame('s-1'))

    // The observer is a diagnostic channel. A broken one must not be able to
    // turn into a second terminal frame, or into a rejected pump.
    await expect(test.manager.pump('s-1', yields('a'))).resolves.toBeUndefined()

    expect(explode).toHaveBeenCalled()
    expect(framesOfType(test.sent, 'stream.data')).toHaveLength(1)
    expect(framesOfType(test.sent, 'stream.end')).toHaveLength(1)
    expect(framesOfType(test.sent, 'stream.error')).toHaveLength(0)
    expect(test.manager.size).toBe(0)
  })
})
