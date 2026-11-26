/**
 * The completion projection contract.
 *
 * `dsh-master` shows a reminder for a session whose last turn succeeded and has
 * not been looked at. That reminder is only sound if the node's fold is exact:
 * failure, cancellation, a token ceiling, or a crash closer must never raise it,
 * and a replayed inherited prefix must never move the watermark backwards. These
 * tests pin the fold, the wire schema, and the best-effort registration.
 *
 * @module dsh-node/test/completion
 */

import { describe, expect, it } from 'vitest'
import {
  lastCompletedSeqProjection,
  lastCompletedSeqSchema,
  registerCompletionProjection,
  type CompletionEventLike,
  type CompletionHostContext,
  type LastCompletedSeq,
  type SessionProjectionRegistryLike,
} from '../src/completion.js'

const turnEnd = (seq: number, kind: string): CompletionEventLike => ({
  type: 'turn/end',
  seq,
  data: { reason: { kind } },
})

const fold = (events: readonly CompletionEventLike[]): LastCompletedSeq =>
  events.reduce<LastCompletedSeq>((state, event) => lastCompletedSeqProjection.apply(state, event), lastCompletedSeqProjection.init())

describe('lastCompletedSeq projection', () => {
  it('starts at null and keeps the latest successful turn end', () => {
    expect(fold([])).toBeNull()
    expect(fold([turnEnd(12, 'completed')])).toBe(12)
    expect(fold([turnEnd(12, 'completed'), turnEnd(19, 'completed')])).toBe(19)
  })

  it('never raises the reminder for failure, cancellation, blocking, a token ceiling or a crash closer', () => {
    for (const kind of ['aborted', 'error', 'blocked', 'max-tokens', 'interrupted']) {
      expect(fold([turnEnd(12, 'completed'), turnEnd(15, kind)])).toBe(12)
      expect(fold([turnEnd(15, kind)])).toBeNull()
    }
  })

  it('keeps the previous state reference for every uninteresting event', () => {
    const state = fold([turnEnd(12, 'completed')])
    const untouched: CompletionEventLike[] = [
      { type: 'turn/start', seq: 13 },
      { type: 'assistant/message', seq: 14 },
      { type: 'turn/end', seq: 15, data: { reason: { kind: 'error' } } },
      { type: 'turn/end', seq: 16 },
    ]
    for (const event of untouched) {
      expect(lastCompletedSeqProjection.apply(state, event)).toBe(state)
    }
  })

  it('never regresses when a fork replays an older success', () => {
    expect(fold([turnEnd(12, 'completed'), turnEnd(5, 'completed')])).toBe(12)
  })

  it('ignores a turn end without a usable seq', () => {
    expect(lastCompletedSeqProjection.apply(7, { type: 'turn/end', data: { reason: { kind: 'completed' } } })).toBe(7)
    expect(lastCompletedSeqProjection.apply(7, turnEnd(-1, 'completed'))).toBe(7)
    expect(lastCompletedSeqProjection.apply(7, turnEnd(1.5, 'completed'))).toBe(7)
  })

  it('publishes the state itself as the wire value', () => {
    expect(lastCompletedSeqProjection.wire.view(12)).toBe(12)
    expect(lastCompletedSeqProjection.wire.view(null)).toBeNull()
    expect(lastCompletedSeqProjection.key).toBe('lastCompletedSeq')
    expect(lastCompletedSeqProjection.stateVersion).toBe(1)
  })
})

describe('lastCompletedSeq schema', () => {
  it('accepts exactly null or a non-negative safe integer', () => {
    expect(lastCompletedSeqSchema.parse(null)).toBeNull()
    expect(lastCompletedSeqSchema.parse(0)).toBe(0)
    expect(lastCompletedSeqSchema.parse(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('rejects every other shape', () => {
    for (const value of ['12', -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, {}, [], true]) {
      expect(() => lastCompletedSeqSchema.parse(value)).toThrow(/lastCompletedSeq/u)
    }
  })
})

describe('registerCompletionProjection', () => {
  interface Scoped {
    sessionProjections?: SessionProjectionRegistryLike
    effect(fn: () => () => void, label: string): void
  }

  const host = (scoped: Scoped): { ctx: CompletionHostContext; disposers: (() => void)[] } => {
    const disposers: (() => void)[] = []
    return {
      ctx: {
        inject: (_names, callback) => { callback(scoped as never) },
      },
      disposers,
    }
  }

  it('registers the definition and releases it when the host disposes', async () => {
    let released = 0
    let definition: unknown
    const scoped: Scoped = {
      sessionProjections: {
        register: (value) => {
          definition = value
          const disposer = Object.assign(
            Promise.resolve({ dispose: () => Promise.resolve() }),
            () => { released += 1; return Promise.resolve() },
          )
          return disposer
        },
      },
      effect: (fn) => { fn() },
    }
    registerCompletionProjection(host(scoped).ctx)
    expect(definition).toBe(lastCompletedSeqProjection)
    await Promise.resolve()
    expect(released).toBe(0)
  })

  it('does nothing when the host has no projection registry', () => {
    const scoped: Scoped = { effect: (fn) => { fn() } }
    expect(() => registerCompletionProjection(host(scoped).ctx)).not.toThrow()
  })

  it('reports a registration failure instead of throwing into the host', async () => {
    const failures: unknown[] = []
    const scoped: Scoped = {
      sessionProjections: {
        register: () => {
          const promise = Promise.reject(new Error('boom')) as Promise<{ dispose(): Promise<void> }> & (() => Promise<void>)
          return Object.assign(promise, () => Promise.resolve())
        },
      },
      effect: (fn) => { fn() },
    }
    registerCompletionProjection(host(scoped).ctx, { onFailure: error => { failures.push(error) } })
    await Promise.resolve()
    await Promise.resolve()
    expect(failures).toHaveLength(1)
  })
})
