/**
 * Request bookkeeping.
 *
 * Covers spec §12.1 items 10, 11, 14 (concurrency half), and 15: correlation by
 * `requestId`, exactly-once settlement, and the rule that a lost connection fails
 * in-flight work instead of replaying it.
 */

import { describe, expect, it, vi } from 'vitest'
import { NodeError, RemoteCodeError, isNodeError, nodeFailure } from '../src/errors.js'
import { RequestManager } from '../src/request-manager.js'

/** A timer source that never fires unless the test fires it. */
function manualTimers() {
  const scheduled: { handler: () => void; ms: number; cancelled: boolean }[] = []
  const setTimer = (handler: () => void, ms: number): (() => void) => {
    const entry = { handler, ms, cancelled: false }
    scheduled.push(entry)
    return () => { entry.cancelled = true }
  }
  return {
    setTimer,
    scheduled,
    /** Fire every timer that is still pending, oldest first. */
    fireAll(): void {
      for (const entry of [...scheduled]) {
        if (!entry.cancelled) entry.handler()
      }
    },
    get pending(): number {
      return scheduled.filter(entry => !entry.cancelled).length
    },
  }
}

function manager(options: Partial<ConstructorParameters<typeof RequestManager>[0]> = {}) {
  const timers = manualTimers()
  const onTimeout = vi.fn()
  const instance = new RequestManager({
    maxInFlight: 4,
    timeoutMs: 1_000,
    setTimer: timers.setTimer,
    onTimeout,
    ...options,
  })
  return { instance, timers, onTimeout }
}

describe('correlation by requestId (spec §12.1 item 10)', () => {
  it('tracks each request independently and settles each exactly once', () => {
    const { instance } = manager()
    const first = instance.begin('req-1', 'session/create')
    const second = instance.begin('req-2', 'session/list')

    expect(instance.size).toBe(2)
    expect(instance.has('req-1')).toBe(true)
    expect(instance.has('req-2')).toBe(true)
    expect(first.requestId).toBe('req-1')
    expect(second.endpoint).toBe('session/list')

    expect(instance.complete('req-1')?.requestId).toBe('req-1')
    expect(instance.size).toBe(1)
    expect(instance.has('req-2')).toBe(true)
    expect(instance.complete('req-2')?.requestId).toBe('req-2')
    expect(instance.size).toBe(0)
  })

  it('issues a distinct signal per request', () => {
    const { instance } = manager()
    const first = instance.begin('req-1', 'a/b')
    const second = instance.begin('req-2', 'a/b')
    expect(first.signal).not.toBe(second.signal)
    expect(first.signal.aborted).toBe(false)
    expect(second.signal.aborted).toBe(false)
  })

  it('refuses a duplicate live requestId without disturbing the first request', () => {
    const { instance } = manager()
    const first = instance.begin('req-1', 'session/create')
    const error = (() => {
      try {
        instance.begin('req-1', 'session/create')
        return undefined
      } catch (caught) {
        return caught as NodeError
      }
    })()

    expect(error?.code).toBe('node/protocol-invalid')
    expect(error?.message).toMatch(/still in flight/u)
    // The original request is untouched and still owns the id.
    expect(instance.size).toBe(1)
    expect(instance.has('req-1')).toBe(true)
    expect(first.signal.aborted).toBe(false)
  })

  it('allows a requestId to be reused after it settles', () => {
    const { instance } = manager()
    instance.begin('req-1', 'a/b')
    expect(instance.complete('req-1')).toBeDefined()
    expect(() => instance.begin('req-1', 'a/b')).not.toThrow()
  })

  it.each([['an empty id', ''], ['a non-string id', 7 as unknown as string]])('refuses %s', (_label, id) => {
    const { instance } = manager()
    expect(() => instance.begin(id, 'a/b')).toThrowError(/non-empty requestId/u)
  })
})

describe('settlement and duplicate responses (spec §12.1 item 11)', () => {
  it('reports a duplicate completion as already settled', () => {
    const { instance } = manager()
    instance.begin('req-1', 'a/b')
    expect(instance.complete('req-1')).toBeDefined()
    // This is the gate that stops a second response from running a callback
    // twice: the second completion has nothing to hand back.
    expect(instance.complete('req-1')).toBeUndefined()
    expect(instance.complete('req-1')).toBeUndefined()
  })

  it('reports an unknown requestId as unowned', () => {
    const { instance } = manager()
    expect(instance.complete('never-seen')).toBeUndefined()
    expect(instance.abort('never-seen', new NodeError('node/connection-lost', 'x'))).toBe(false)
    expect(instance.size).toBe(0)
  })

  it('cancels the per-request timer on completion, leaking no timer', () => {
    const { instance, timers } = manager()
    instance.begin('req-1', 'a/b')
    instance.begin('req-2', 'a/b')
    expect(timers.pending).toBe(2)
    instance.complete('req-1')
    expect(timers.pending).toBe(1)
    instance.complete('req-2')
    expect(timers.pending).toBe(0)
  })

  it('does not fire a timeout for a request that already settled', () => {
    const { instance, timers, onTimeout } = manager()
    instance.begin('req-1', 'a/b')
    instance.complete('req-1')
    timers.fireAll()
    expect(onTimeout).not.toHaveBeenCalled()
    expect(instance.size).toBe(0)
  })

  it('does not leave a live entry behind when a timer fires late', () => {
    const { instance, timers } = manager()
    instance.begin('req-1', 'a/b')
    instance.complete('req-1')
    // A canceller that lies: the entry is already gone, so nothing can revive it.
    timers.scheduled[0]!.cancelled = false
    timers.fireAll()
    expect(instance.size).toBe(0)
  })
})

describe('timeout', () => {
  it('aborts with node/request-timeout and keeps the request live for its terminal frame', () => {
    const { instance, timers, onTimeout } = manager()
    const pending = instance.begin('req-1', 'session/create')
    expect(pending.signal.aborted).toBe(false)

    timers.fireAll()

    expect(pending.signal.aborted).toBe(true)
    expect(isNodeError(pending.signal.reason)).toBe(true)
    expect((pending.signal.reason as NodeError).code).toBe('node/request-timeout')
    expect((pending.signal.reason as NodeError).details).toMatchObject({
      requestId: 'req-1',
      endpoint: 'session/create',
      requestTimeoutMs: 1_000,
    })
    expect(onTimeout).toHaveBeenCalledTimes(1)
    // Still live: the caller's own completion path must still emit one result.
    expect(instance.has('req-1')).toBe(true)
    expect(instance.complete('req-1')).toBeDefined()
  })

  it('uses the configured timeout', () => {
    const { instance, timers } = manager({ timeoutMs: 25 })
    instance.begin('req-1', 'a/b')
    expect(timers.scheduled[0]?.ms).toBe(25)
  })
})

describe('cancellation', () => {
  it('aborts the signal with the supplied reason and keeps the entry live', () => {
    const { instance } = manager()
    const pending = instance.begin('req-1', 'session/create')
    const reason = new RemoteCodeError('gateway/cancelled', 'Coordinator cancelled', {})

    expect(instance.abort('req-1', reason)).toBe(true)
    expect(pending.signal.aborted).toBe(true)
    expect(pending.signal.reason).toBe(reason)
    expect(nodeFailure(pending.signal.reason).code).toBe('gateway/cancelled')
    expect(instance.has('req-1')).toBe(true)
  })

  it('is idempotent: a second abort keeps the first reason', () => {
    const { instance } = manager()
    const pending = instance.begin('req-1', 'a/b')
    const first = new RemoteCodeError('gateway/cancelled', 'first', {})
    instance.abort('req-1', first)
    instance.abort('req-1', new NodeError('node/shutdown', 'second'))
    expect(pending.signal.reason).toBe(first)
  })

  it('can cancel one request without touching its neighbour', () => {
    const { instance } = manager()
    const one = instance.begin('req-1', 'a/b')
    const two = instance.begin('req-2', 'a/b')
    instance.abort('req-1', new RemoteCodeError('gateway/cancelled', 'cancel', {}))
    expect(one.signal.aborted).toBe(true)
    expect(two.signal.aborted).toBe(false)
  })
})

describe('concurrency ceiling (spec §12.1 item 14)', () => {
  it('refuses a request beyond maxInFlightRequests and does not disturb the rest', () => {
    const { instance } = manager({ maxInFlight: 2 })
    instance.begin('req-1', 'a/b')
    instance.begin('req-2', 'a/b')

    const error = (() => {
      try {
        instance.begin('req-3', 'a/b')
        return undefined
      } catch (caught) {
        return caught as NodeError
      }
    })()

    expect(error?.code).toBe('node/request-limit')
    expect(error?.details['maxInFlightRequests']).toBe(2)
    expect(instance.size).toBe(2)
    expect(instance.has('req-3')).toBe(false)
  })

  it('frees a slot as soon as a request settles', () => {
    const { instance } = manager({ maxInFlight: 1 })
    instance.begin('req-1', 'a/b')
    expect(() => instance.begin('req-2', 'a/b')).toThrowError(/in flight/u)
    instance.complete('req-1')
    expect(() => instance.begin('req-2', 'a/b')).not.toThrow()
  })
})

describe('connection loss (spec §12.1 item 15, §1.1 item 8)', () => {
  it('fails every in-flight request with the supplied reason and forgets them', () => {
    const { instance, timers } = manager()
    const one = instance.begin('req-1', 'session/create')
    const two = instance.begin('req-2', 'session/message')
    const reason = new NodeError('node/connection-lost', 'the connection was lost')
    // Each request also carries a signal consumer, as the real dispatcher does.
    let observed = 0
    one.signal.addEventListener('abort', () => { observed += 1 })
    two.signal.addEventListener('abort', () => { observed += 1 })

    const failed = instance.failAll(reason)

    expect(failed).toEqual(['req-1', 'req-2'])
    expect(observed).toBe(2)
    expect((one.signal.reason as NodeError).code).toBe('node/connection-lost')
    expect((two.signal.reason as NodeError).code).toBe('node/connection-lost')
    expect(instance.size).toBe(0)
    // Timers must not outlive the connection.
    expect(timers.pending).toBe(0)
    // Nothing is replayed: the ids are gone, so a late completion is unowned.
    expect(instance.complete('req-1')).toBeUndefined()
  })

  it('leaves no entry for a request that completes after the connection dropped', () => {
    const { instance } = manager()
    instance.begin('req-1', 'a/b')
    instance.failAll(new NodeError('node/connection-lost', 'lost'))
    expect(instance.has('req-1')).toBe(false)
  })

  it('reports shutdown distinctly from a connection loss', () => {
    const { instance } = manager()
    const pending = instance.begin('req-1', 'a/b')
    instance.failAll(new NodeError('node/shutdown', 'plugin-disposed'))
    expect((pending.signal.reason as NodeError).code).toBe('node/shutdown')
  })

  it('is a no-op when nothing is in flight', () => {
    const { instance } = manager()
    expect(instance.failAll(new NodeError('node/connection-lost', 'lost'))).toEqual([])
    expect(instance.size).toBe(0)
  })

  it('can be called twice without emitting a second abort', () => {
    const { instance } = manager()
    const pending = instance.begin('req-1', 'a/b')
    let observed = 0
    pending.signal.addEventListener('abort', () => { observed += 1 })
    instance.failAll(new NodeError('node/connection-lost', 'lost'))
    instance.failAll(new NodeError('node/connection-lost', 'lost again'))
    expect(observed).toBe(1)
  })
})

describe('startedAt', () => {
  it('records the injected clock', () => {
    const { instance } = manager({ now: () => 1_234 })
    expect(instance.begin('req-1', 'a/b').startedAt).toBe(1_234)
  })
})
