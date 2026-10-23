/**
 * The node's durable queue: sequencing, replay, acknowledgement, and cleanup.
 *
 * These tests are about the promises the Coordinator relies on: a sequence number is
 * never reused, an acknowledgement never deletes data that was not delivered, and a
 * reader whose cursor is too old gets an explicit gap instead of a silent jump.
 *
 * @module dsh-node/test/usage-store
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NodeUsageStore } from '../src/usage/store.js'
import { emptyUsage, normalizeUsage, type AttemptSnapshot } from '../src/usage/types.js'

const directories: string[] = []
const stores: NodeUsageStore[] = []

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-node-usage-'))
  directories.push(directory)
  return directory
}

async function open(
  options: { nodeId?: string; now?: () => number; retentionMs?: number; maxBytes?: number } = {},
): Promise<NodeUsageStore> {
  const file = join(await scratch(), 'usage.sqlite')
  const store = NodeUsageStore.open({
    file,
    nodeId: options.nodeId ?? 'node-1',
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.retentionMs === undefined ? {} : { retentionMs: options.retentionMs }),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  })
  stores.push(store)
  return store
}

afterEach(async () => {
  for (const store of stores.splice(0)) {
    try {
      store.close()
    } catch {
      // Already closed.
    }
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

/** One complete snapshot. */
function snapshot(overrides: Partial<AttemptSnapshot> & { attemptId: string }): AttemptSnapshot {
  return {
    startedAt: '2026-10-23T01:00:00.000Z',
    endedAt: '2026-10-23T01:00:02.000Z',
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    sessionId: 'session-1',
    purpose: 'conversation',
    state: 'completed',
    usageReported: true,
    usage: normalizeUsage({ inputTokens: 5, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0 }).usage,
    source: 'runtime',
    ...overrides,
  }
}

/** A read request. */
function readRequest(overrides: Record<string, unknown> = {}): Parameters<NodeUsageStore['read']>[0] {
  return { collectorId: '', afterSeq: '0', limit: 200, maxBytes: 262_144, ...overrides } as Parameters<NodeUsageStore['read']>[0]
}

describe('appending', () => {
  it('turns running, usage, and terminal revisions into one attempt', async () => {
    const store = await open()
    const running = store.appendAttempt(snapshot({ attemptId: 'a', state: 'running', endedAt: null, usageReported: false, usage: emptyUsage() }))
    const usage = store.appendAttempt(snapshot({ attemptId: 'a', state: 'running', endedAt: null, usageReported: true }))
    const done = store.appendAttempt(snapshot({ attemptId: 'a' }))
    expect([running, usage, done]).toEqual(['1', '2', '3'])
    const status = store.status()
    expect(status.latestIssuedSeq).toBe('3')
    expect(status.pendingCount).toBe('3')
    expect(status.earliestAvailableSeq).toBe('1')
  })

  it('gives every event its own sequence number', async () => {
    const store = await open()
    expect(store.appendAttempt(snapshot({ attemptId: 'a' }))).toBe('1')
    expect(store.appendAttempt(snapshot({ attemptId: 'b' }))).toBe('2')
    expect(store.appendGap({ fromAt: '2026-10-23T00:00:00.000Z', toAt: '2026-10-23T00:05:00.000Z', reason: 'storage-failure' })).toBe('3')
  })

  it('does not consume a sequence number when the write is refused', async () => {
    const store = await open()
    // A provider name this long cannot fit in one 16 KiB event.
    expect(() => store.appendAttempt(snapshot({ attemptId: 'huge', provider: 'x'.repeat(20_000) }))).toThrow(/16|too large|limit/iu)
    expect(store.status().latestIssuedSeq).toBe('0')
    expect(store.appendAttempt(snapshot({ attemptId: 'fine' }))).toBe('1')
  })
})

describe('restarting', () => {
  it('keeps the collector identity and the sequence', async () => {
    const directory = await scratch()
    const file = join(directory, 'usage.sqlite')
    const first = NodeUsageStore.open({ file, nodeId: 'node-1' })
    const collectorId = first.collectorId
    first.appendAttempt(snapshot({ attemptId: 'a' }))
    first.close()

    const second = NodeUsageStore.open({ file, nodeId: 'node-1' })
    stores.push(second)
    expect(second.collectorId).toBe(collectorId)
    expect(second.status().latestIssuedSeq).toBe('1')
    // A clean restart does not invent an interruption.
    expect(second.status().coverage).toBe('complete')
  })

  it('marks a leftover running attempt as process_interrupted, keeping its usage', async () => {
    const directory = await scratch()
    const file = join(directory, 'usage.sqlite')
    const first = NodeUsageStore.open({ file, nodeId: 'node-1' })
    first.appendAttempt(snapshot({
      attemptId: 'a',
      state: 'running',
      endedAt: null,
      usage: normalizeUsage({ inputTokens: 5, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0 }).usage,
    }))
    first.close()

    const second = NodeUsageStore.open({ file, nodeId: 'node-1' })
    stores.push(second)
    const batch = second.read(readRequest({ collectorId: second.collectorId }))
    expect(batch.events).toHaveLength(2)
    const last = batch.events.at(-1)
    expect(last?.kind).toBe('attempt')
    if (last?.kind !== 'attempt') throw new Error('expected an attempt')
    expect(last.attempt.state).toBe('process_interrupted')
    // The tokens that were already persisted are still there.
    expect(last.attempt.usage.totalTokens).toBe('10')
  })

  it('refuses a queue that belongs to another node', async () => {
    const directory = await scratch()
    const file = join(directory, 'usage.sqlite')
    const first = NodeUsageStore.open({ file, nodeId: 'node-1' })
    first.close()
    expect(() => NodeUsageStore.open({ file, nodeId: 'node-2' })).toThrow(/belongs to node node-1/u)
  })

  it('refuses a second process opening the same queue', async () => {
    const directory = await scratch()
    const file = join(directory, 'usage.sqlite')
    const first = NodeUsageStore.open({ file, nodeId: 'node-1' })
    stores.push(first)
    expect(() => NodeUsageStore.open({ file, nodeId: 'node-1' })).toThrow(/in use by process/u)
  })
})

describe('reading', () => {
  it('returns events in order and reports whether more remain', async () => {
    const store = await open()
    for (let index = 0; index < 5; index += 1) store.appendAttempt(snapshot({ attemptId: `a${index}` }))
    const page = store.read(readRequest({ collectorId: store.collectorId, limit: 2 }))
    expect(page.events).toHaveLength(2)
    expect(page.nextSeq).toBe('2')
    expect(page.hasMore).toBe(true)
    const next = store.read(readRequest({ collectorId: store.collectorId, afterSeq: page.nextSeq, limit: 2 }))
    expect(next.events.map(event => event.seq)).toEqual(['3', '4'])
  })

  it('stops at the byte budget without skipping the next record', async () => {
    const store = await open()
    for (let index = 0; index < 4; index += 1) store.appendAttempt(snapshot({ attemptId: `a${index}` }))
    const page = store.read(readRequest({ collectorId: store.collectorId, maxBytes: 900 }))
    expect(page.events.length).toBeGreaterThan(0)
    expect(page.events.length).toBeLessThan(4)
    expect(page.nextSeq).toBe(String(page.events.length))
    expect(page.hasMore).toBe(true)
  })

  it('names a pruned prefix as an explicit gap', async () => {
    const store = await open({ retentionMs: 0 })
    for (let index = 0; index < 4; index += 1) store.appendAttempt(snapshot({ attemptId: `a${index}` }))
    store.read(readRequest({ collectorId: store.collectorId }))
    store.ack({ collectorId: store.collectorId, throughSeq: '2' })
    await new Promise(resolve => setTimeout(resolve, 20))
    const page = store.read(readRequest({ collectorId: store.collectorId, afterSeq: '0' }))
    expect(page.gaps).toEqual([{ fromSeq: '1', throughSeq: '2', reason: 'pruned' }])
    expect(page.events.map(event => event.seq)).toEqual(['3', '4'])
    expect(page.nextSeq).toBe('4')
  })

  it('refuses a collector id that is not this node\'s', async () => {
    const store = await open()
    expect(() => store.read(readRequest({ collectorId: 'someone-else' }))).toThrow(/does not match/u)
  })

  it('refuses one record larger than the whole page', async () => {
    const store = await open()
    store.appendAttempt(snapshot({ attemptId: 'a' }))
    expect(() => store.read(readRequest({ collectorId: store.collectorId, maxBytes: 10 })))
      .toThrow(/does not fit/u)
    expect(store.status().state).toBe('degraded')
  })
})

describe('acknowledging', () => {
  it('is cumulative and idempotent, and never lowers the watermark', async () => {
    const store = await open()
    for (let index = 0; index < 3; index += 1) store.appendAttempt(snapshot({ attemptId: `a${index}` }))
    store.read(readRequest({ collectorId: store.collectorId }))
    expect(store.ack({ collectorId: store.collectorId, throughSeq: '2' }).ackedThroughSeq).toBe('2')
    expect(store.ack({ collectorId: store.collectorId, throughSeq: '2' }).ackedThroughSeq).toBe('2')
    // An old ACK arriving late must not rewind the watermark.
    expect(store.ack({ collectorId: store.collectorId, throughSeq: '1' }).ackedThroughSeq).toBe('2')
    expect(store.ack({ collectorId: store.collectorId, throughSeq: '3' }).ackedThroughSeq).toBe('3')
  })

  it('refuses an acknowledgement beyond what was delivered', async () => {
    const store = await open()
    store.appendAttempt(snapshot({ attemptId: 'a' }))
    store.appendAttempt(snapshot({ attemptId: 'b' }))
    // Nothing was read, so nothing was delivered.
    expect(() => store.ack({ collectorId: store.collectorId, throughSeq: '2' })).toThrow(/beyond what this node delivered/u)
    store.read(readRequest({ collectorId: store.collectorId, limit: 1 }))
    expect(() => store.ack({ collectorId: store.collectorId, throughSeq: '2' })).toThrow(/beyond/u)
    expect(store.ack({ collectorId: store.collectorId, throughSeq: '1' }).ackedThroughSeq).toBe('1')
  })

  it('keeps unacknowledged events forever, regardless of age', async () => {
    let now = Date.parse('2026-10-23T00:00:00.000Z')
    const store = await open({ retentionMs: 0, now: () => now })
    store.appendAttempt(snapshot({ attemptId: 'a' }))
    store.appendAttempt(snapshot({ attemptId: 'b' }))
    store.read(readRequest({ collectorId: store.collectorId }))
    store.ack({ collectorId: store.collectorId, throughSeq: '1' })
    now += 10 * 24 * 60 * 60 * 1000
    // Trigger another cleanup pass through a second ACK.
    store.ack({ collectorId: store.collectorId, throughSeq: '1' })
    await new Promise(resolve => setTimeout(resolve, 20))
    const page = store.read(readRequest({ collectorId: store.collectorId, afterSeq: '1' }))
    expect(page.events.map(event => event.seq)).toEqual(['2'])
  })
})

describe('status', () => {
  it('reports a complete, ready collector on a fresh queue', async () => {
    const store = await open()
    const status = store.status()
    expect(status).toMatchObject({
      schemaVersion: 1,
      enabled: true,
      state: 'ready',
      coverage: 'complete',
      latestIssuedSeq: '0',
      earliestAvailableSeq: '1',
      ackedThroughSeq: '0',
      pendingCount: '0',
    })
    expect(status.collectorId).toMatch(/^[0-9a-f-]{36}$/u)
  })

  it('reports disabled without pretending the queue is empty', async () => {
    const store = await open()
    store.setEnabled(false)
    const status = store.status()
    expect(status.enabled).toBe(false)
    expect(status.state).toBe('disabled')
    expect(status.collectorId).not.toBeNull()
  })

  it('reports incomplete after a gap event', async () => {
    const store = await open()
    store.appendGap({ fromAt: '2026-10-23T00:00:00.000Z', toAt: '2026-10-23T00:05:00.000Z', reason: 'storage-failure' })
    expect(store.status().coverage).toBe('incomplete')
  })
})
