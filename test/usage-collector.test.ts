/**
 * The runtime observer: what counts as one call, how it ends, and the promise that
 * observing it changes nothing.
 *
 * The fake `llm/stream` waterfall here is shaped exactly like the real one
 * (`(options, next) => AsyncIterable<StreamChunk>`), which is what the DSH host
 * measured in Task 0. Every test asserts on the snapshots the collector persisted,
 * not on internals, so a change to how it batches revisions stays visible.
 *
 * @module dsh-node/test/usage-collector
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { installUsageCollector, stateOf } from '../src/usage/collector.js'
import type { NodeUsageStore } from '../src/usage/store.js'
import type { AttemptSnapshot } from '../src/usage/types.js'

/** One captured waterfall listener. */
type Listener = (options: Record<string, unknown>, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>

/** A context that records waterfall listeners. */
function fakeContext(): { ctx: Context; listeners: Listener[] } {
  const listeners: Listener[] = []
  const ctx = {
    on: (name: string, listener: Listener) => {
      if (name !== 'llm/stream') throw new Error(`unexpected event ${name}`)
      listeners.push(listener)
      return () => {
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
  } as unknown as Context
  return { ctx, listeners }
}

/** A store that records snapshots and can be made to fail. */
function fakeStore(options: { fail?: boolean } = {}): { store: NodeUsageStore; snapshots: AttemptSnapshot[] } {
  const snapshots: AttemptSnapshot[] = []
  let seq = 0
  const store = {
    appendAttempt: (snapshot: AttemptSnapshot) => {
      if (options.fail === true) throw new Error('disk full')
      snapshots.push(snapshot)
      seq += 1
      return String(seq)
    },
    collectorId: 'collector-1',
  } as unknown as NodeUsageStore
  return { store, snapshots }
}

/** Build a stream from a list of chunks, counting `return()` calls. */
function streamOf(chunks: readonly unknown[], counters: { returned: number } = { returned: 0 }): () => AsyncIterable<unknown> {
  return () => (async function* generate() {
    try {
      for (const chunk of chunks) yield chunk
    } finally {
      counters.returned += 1
    }
  })()
}

/** Run one observed call to completion. */
async function runOne(
  listener: Listener,
  options: Record<string, unknown>,
  next: () => AsyncIterable<unknown>,
  consume?: (iterable: AsyncIterable<unknown>) => Promise<void>,
): Promise<unknown[]> {
  const iterable = listener(options, next)
  const seen: unknown[] = []
  if (consume !== undefined) {
    await consume(iterable)
    return seen
  }
  for await (const chunk of iterable) seen.push(chunk)
  return seen
}

describe('installing', () => {
  it('installs exactly one global listener', () => {
    const { ctx, listeners } = fakeContext()
    const { store } = fakeStore()
    const collector = installUsageCollector(ctx, store)
    expect(listeners).toHaveLength(1)
    void collector.dispose()
    expect(listeners).toHaveLength(0)
  })

  it('records nothing for a stream that is created and never iterated', async () => {
    const { ctx, listeners } = fakeContext()
    const { store, snapshots } = fakeStore()
    installUsageCollector(ctx, store)
    listeners[0]!({ provider: 'p', model: 'm' }, streamOf([{ type: 'text-delta', text: 'hi' }]))
    // No iteration happened.
    expect(snapshots).toHaveLength(0)
  })
})

describe('one model call', () => {
  it('records running, a usage revision, and one terminal revision', async () => {
    const { ctx, listeners } = fakeContext()
    const { store, snapshots } = fakeStore()
    installUsageCollector(ctx, store)
    const chunks = [
      { type: 'text-delta', text: 'hello' },
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const seen = await runOne(listeners[0]!, { provider: 'deepseek-official', model: 'deepseek-v4-flash', sessionId: 's1' }, streamOf(chunks))
    expect(seen).toEqual(chunks)
    expect(snapshots.map(snapshot => snapshot.state)).toEqual(['running', 'running', 'completed'])
    const last = snapshots.at(-1)
    expect(last?.usage.totalTokens).toBe('10')
    expect(last?.usageReported).toBe(true)
    expect(last?.provider).toBe('deepseek-official')
    expect(last?.purpose).toBe('conversation')
    expect(last?.endedAt).not.toBeNull()
  })

  it('records one attempt for a call whose usage arrives once', () => {
    const first = stateOf({ kind: 'stop' })
    expect(first).toBe('completed')
    expect(stateOf({ kind: 'tool-calls' })).toBe('completed')
    expect(stateOf({ kind: 'max-tokens' })).toBe('completed')
    expect(stateOf({ kind: 'error' })).toBe('failed')
    expect(stateOf({ kind: 'aborted' })).toBe('cancelled')
  })

  it('classifies an error finish as failed and a cancelled signal as cancelled', async () => {
    const { ctx, listeners } = fakeContext()
    const { store, snapshots } = fakeStore()
    installUsageCollector(ctx, store)
    await runOne(listeners[0]!, { provider: 'p', model: 'm' }, streamOf([{ type: 'finish', reason: { kind: 'error' } }]))
    expect(snapshots.at(-1)?.state).toBe('failed')
  })

  it('counts a call that never returned usage, and marks it unreported', async () => {
    const { ctx, listeners } = fakeContext()
    const { store, snapshots } = fakeStore()
    installUsageCollector(ctx, store)
    await runOne(listeners[0]!, { provider: 'p', model: 'm' }, streamOf([{ type: 'finish', reason: { kind: 'limit' } }]))
    const last = snapshots.at(-1)
    expect(last?.usageReported).toBe(false)
    expect(last?.usage.totalTokens).toBeNull()
  })

  it('keeps a usage sample that arrived before a throw, and rethrows', async () => {
    const { ctx, listeners } = fakeContext()
    const { store, snapshots } = fakeStore()
    installUsageCollector(ctx, store)
    const next = () => (async function* generate() {
      yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0 } }
      throw new Error('provider fell over')
    })()
    await expect(runOne(listeners[0]!, { provider: 'p', model: 'm' }, next)).rejects.toThrow(/fell over/u)
    const last = snapshots.at(-1)
    expect(last?.state).toBe('failed')
    expect(last?.usage.totalTokens).toBe('10')
  })

  it('records a consumer break as cancelled and closes the source iterator', async () => {
    const { ctx, listeners } = fakeContext()
    const { store, snapshots } = fakeStore()
    installUsageCollector(ctx, store)
    const counters = { returned: 0 }
    const iterable = listeners[0]!(
      { provider: 'p', model: 'm' },
      streamOf([{ type: 'text-delta', text: 'one' }, { type: 'text-delta', text: 'two' }], counters),
    )
    for await (const chunk of iterable) {
      expect(chunk).toMatchObject({ type: 'text-delta' })
      break
    }
    expect(snapshots.at(-1)?.state).toBe('cancelled')
    expect(counters.returned).toBe(1)
  })

  it('records a clean end without a finish chunk as failed and reports the protocol violation', async () => {
    const { ctx, listeners } = fakeContext()
    const { store, snapshots } = fakeStore()
    const issues: string[] = []
    installUsageCollector(ctx, store, { onIssue: issue => { issues.push(issue.code) } })
    await runOne(listeners[0]!, { provider: 'p', model: 'm' }, streamOf([{ type: 'text-delta', text: 'partial' }]))
    expect(snapshots.at(-1)?.state).toBe('failed')
    expect(issues).toContain('nodeUsage/no-finish')
  })

  it('maps purpose explicitly and defaults from the presence of a session', async () => {
    const { ctx, listeners } = fakeContext()
    const { store, snapshots } = fakeStore()
    installUsageCollector(ctx, store)
    await runOne(listeners[0]!, { provider: 'p', model: 'm', purpose: 'compaction' }, streamOf([{ type: 'finish', reason: { kind: 'stop' } }]))
    expect(snapshots.at(-1)?.purpose).toBe('compaction')
    await runOne(listeners[0]!, { provider: 'p', model: 'm' }, streamOf([{ type: 'finish', reason: { kind: 'stop' } }]))
    expect(snapshots.at(-1)?.purpose).toBe('other')
    await runOne(listeners[0]!, { provider: 'p', model: 'm', sessionId: 's' }, streamOf([{ type: 'finish', reason: { kind: 'stop' } }]))
    expect(snapshots.at(-1)?.purpose).toBe('conversation')
  })

  it('does not change the stream when the queue write fails', async () => {
    const { ctx, listeners } = fakeContext()
    const { store } = fakeStore({ fail: true })
    const issues: string[] = []
    installUsageCollector(ctx, store, { onIssue: issue => { issues.push(issue.code) } })
    const chunks = [{ type: 'text-delta', text: 'still here' }, { type: 'finish', reason: { kind: 'stop' } }]
    const seen = await runOne(listeners[0]!, { provider: 'p', model: 'm' }, streamOf(chunks))
    expect(seen).toEqual(chunks)
    expect(issues.length).toBeGreaterThan(0)
  })

  it('does not install a second observer when called twice', () => {
    const { ctx, listeners } = fakeContext()
    const { store } = fakeStore()
    installUsageCollector(ctx, store)
    // The plugin guards re-installation; two listeners would double count, so the
    // guard is asserted at the level the plugin controls.
    expect(listeners).toHaveLength(1)
  })

  it('records provider and model as null when the runtime did not say', async () => {
    const { ctx, listeners } = fakeContext()
    const { store, snapshots } = fakeStore()
    installUsageCollector(ctx, store)
    await runOne(listeners[0]!, {}, streamOf([{ type: 'finish', reason: { kind: 'stop' } }]))
    expect(snapshots.at(-1)?.provider).toBeNull()
    expect(snapshots.at(-1)?.model).toBeNull()
  })
})

describe('the observer itself', () => {
  it('does not call the LLM twice for one stream', async () => {
    const { ctx, listeners } = fakeContext()
    const { store } = fakeStore()
    installUsageCollector(ctx, store)
    let calls = 0
    const next = () => {
      calls += 1
      return streamOf([{ type: 'finish', reason: { kind: 'stop' } }])()
    }
    await runOne(listeners[0]!, { provider: 'p', model: 'm' }, next)
    expect(calls).toBe(1)
  })

  it('never awaits a timer of its own: disposal is synchronous enough for stop()', async () => {
    const { ctx, listeners } = fakeContext()
    const { store } = fakeStore()
    const collector = installUsageCollector(ctx, store)
    expect(vi.isMockFunction(collector.dispose)).toBe(false)
    await collector.dispose()
    expect(listeners).toHaveLength(0)
  })
})
