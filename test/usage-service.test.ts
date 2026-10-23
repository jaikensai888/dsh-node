/**
 * The `nodeUsage` Remote surface: three methods, one request parameter each, and
 * failures that keep their own code instead of becoming "internal".
 *
 * The descriptor assertions are exact on purpose. A Remote surface is a protocol;
 * adding a method or renaming a parameter is a contract change, and this test is what
 * makes that change deliberate rather than incidental.
 *
 * @module dsh-node/test/usage-service
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NodeUsageOwner, USAGE_DESCRIPTORS, USAGE_NAMESPACE, USAGE_SERVICE_KEY } from '../src/usage/service.js'
import { NodeUsageStore } from '../src/usage/store.js'
import { normalizeUsage, type AttemptSnapshot } from '../src/usage/types.js'

const directories: string[] = []
const stores: NodeUsageStore[] = []

async function store(): Promise<NodeUsageStore> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-node-service-'))
  directories.push(directory)
  const opened = NodeUsageStore.open({ file: join(directory, 'usage.sqlite'), nodeId: 'node-1' })
  stores.push(opened)
  return opened
}

afterEach(async () => {
  for (const entry of stores.splice(0)) {
    try {
      entry.close()
    } catch {
      // Already closed.
    }
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

/** One complete attempt. */
function snapshot(overrides: Partial<AttemptSnapshot> & { attemptId: string }): AttemptSnapshot {
  return {
    startedAt: '2026-10-23T01:00:00.000Z',
    endedAt: '2026-10-23T01:00:02.000Z',
    provider: 'p',
    model: 'm',
    sessionId: null,
    purpose: 'other',
    state: 'completed',
    usageReported: true,
    usage: normalizeUsage({ inputTokens: 5, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0 }).usage,
    source: 'runtime',
    ...overrides,
  }
}

/** Read one NodeRemote failure code. */
function codeOf(run: () => unknown): string | undefined {
  try {
    run()
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

describe('the descriptor surface', () => {
  it('is exactly status, read, and ack in the nodeUsage namespace', () => {
    expect(USAGE_NAMESPACE).toBe('nodeUsage')
    expect(USAGE_SERVICE_KEY).toBe('nodeUsage')
    expect(USAGE_DESCRIPTORS.map(descriptor => descriptor.method)).toEqual(['status', 'read', 'ack'])
    for (const descriptor of USAGE_DESCRIPTORS) {
      expect(descriptor.namespace).toBe('nodeUsage')
      expect(descriptor.service).toBe('nodeUsage')
      expect(descriptor.invocation).toEqual({ kind: 'direct' })
      expect(descriptor.result).toEqual({ mode: 'src-json' })
    }
    expect(USAGE_DESCRIPTORS[0]?.parameters).toEqual([])
    expect(USAGE_DESCRIPTORS[1]?.parameters?.map(parameter => parameter.name)).toEqual(['request'])
    expect(USAGE_DESCRIPTORS[2]?.parameters?.map(parameter => parameter.name)).toEqual(['request'])
  })
})

describe('the owner', () => {
  it('carries the binding the Gateway reads', async () => {
    const owner = new NodeUsageOwner({ store: await store() })
    expect(owner.typertRemote).toEqual({
      service: owner,
      serviceKey: 'nodeUsage',
      namespace: 'nodeUsage',
    })
  })

  it('reports status from the store', async () => {
    const opened = await store()
    const owner = new NodeUsageOwner({ store: opened })
    expect(owner.status()).toMatchObject({ schemaVersion: 1, state: 'ready', collectorId: opened.collectorId })
  })

  it('reports disabled rather than an empty queue', async () => {
    const owner = new NodeUsageOwner({ store: await store(), enabled: false })
    const status = owner.status()
    expect(status.enabled).toBe(false)
    expect(status.state).toBe('disabled')
  })

  it('reports unsupported when this host cannot collect at all', async () => {
    const owner = new NodeUsageOwner({ store: await store(), unsupportedReason: 'no-llm' })
    const status = owner.status()
    expect(status.state).toBe('unsupported')
    expect(status.issueCode).toBe('no-llm')
  })

  it('reads and acknowledges through the store', async () => {
    const opened = await store()
    opened.appendAttempt(snapshot({ attemptId: 'a' }))
    const owner = new NodeUsageOwner({ store: opened })
    const batch = owner.read({ collectorId: opened.collectorId, afterSeq: '0' })
    expect(batch.events).toHaveLength(1)
    expect(owner.ack({ collectorId: opened.collectorId, throughSeq: batch.nextSeq }).ackedThroughSeq).toBe('1')
  })
})

describe('failures', () => {
  it('keeps nodeUsage/invalid-arguments for a bad request', async () => {
    const owner = new NodeUsageOwner({ store: await store() })
    expect(codeOf(() => owner.read({ afterSeq: '0' }))).toBe('nodeUsage/invalid-arguments')
    expect(codeOf(() => owner.read({ collectorId: 'c', afterSeq: '01' }))).toBe('nodeUsage/invalid-arguments')
    expect(codeOf(() => owner.read(undefined))).toBe('nodeUsage/invalid-arguments')
    expect(codeOf(() => owner.ack({ collectorId: 'c', throughSeq: '-1' }))).toBe('nodeUsage/invalid-arguments')
  })

  it('keeps nodeUsage/collector-mismatch for a stale collector id', async () => {
    const owner = new NodeUsageOwner({ store: await store() })
    expect(codeOf(() => owner.read({ collectorId: 'stale', afterSeq: '0' }))).toBe('nodeUsage/collector-mismatch')
  })

  it('marks failures as declared Remote failures, not internal errors', async () => {
    const owner = new NodeUsageOwner({ store: await store() })
    try {
      owner.read({ collectorId: 'c' })
      throw new Error('expected a failure')
    } catch (error) {
      expect((error as { isDSHRemoteError?: boolean }).isDSHRemoteError).toBe(true)
      expect((error as { name?: string }).name).toBe('NodeAdminError')
    }
  })

  it('turns an unexpected store failure into storage-unavailable', async () => {
    const broken = { read: () => { throw new Error('boom') }, status: () => { throw new Error('boom') }, ack: () => { throw new Error('boom') } } as unknown as NodeUsageStore
    const owner = new NodeUsageOwner({ store: broken })
    expect(codeOf(() => owner.read({ collectorId: 'c', afterSeq: '0' }))).toBe('nodeUsage/storage-unavailable')
    expect(codeOf(() => owner.status())).toBe('nodeUsage/storage-unavailable')
  })
})
