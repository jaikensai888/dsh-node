import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DshNodeHost, type NodeHostContext } from '../src/index.js'
import { NodeError } from '../src/errors.js'
import { PROTOCOL_VERSION } from '../src/protocol.js'

async function harness(modern = true) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-node-peer-'))
  const peers: { signal: AbortSignal; dispose: ReturnType<typeof vi.fn> }[] = []
  const createPeer = vi.fn(() => {
    const lifetime = new AbortController()
    const peer = { signal: lifetime.signal, dispose: vi.fn(async () => { lifetime.abort() }) }
    peers.push(peer)
    return peer
  })
  const gateway = {
    invoke: vi.fn(async (_request: { peer?: unknown }) => ({ items: [] })),
    stream: vi.fn(async (_request: { peer?: unknown }) => (async function* () { yield { items: [] } })()),
    wireStream: { failure: () => ({ code: 'gateway/internal', message: 'failed', details: {} }) },
  }
  const ctx = { get: (key: string) => {
    if (key === 'typertGateway') return gateway
    if (key === 'connection' && modern) return { createPeer }
    if (key === 'typert') return { local: { list: () => [
      { namespace: 'demo', method: 'list' },
      { namespace: 'demo', method: 'follow', mode: 'stream' },
    ] } }
    return undefined
  } } as unknown as NodeHostContext
  const host = new DshNodeHost({
    ctx, env: { DSH_HOME: directory }, connectionIntent: 'paused', logSink: () => undefined,
    bootstrap: { coordinatorUrl: 'ws://127.0.0.1:1/node', auth: { token: 'fixture' }, mode: 'full-access' },
  })
  await host.start()
  const request = (id: string) => host.onFrame({
    type: 'rpc.request', protocolVersion: PROTOCOL_VERSION, nodeId: '', requestId: id,
    endpoint: 'demo/list', payload: { args: {} },
  })
  const follow = () => host.onFrame({
    type: 'stream.open', protocolVersion: PROTOCOL_VERSION, nodeId: '', streamId: 'stream-1',
    endpoint: 'demo/follow', payload: { args: {} },
  })
  return { host, peers, createPeer, gateway, request, follow, close: async () => {
    await host.stop('fixture cleanup')
    if (!directory.startsWith(join(tmpdir(), 'dsh-node-peer-'))) throw new Error('unexpected fixture path')
    await rm(directory, { recursive: true, force: true })
  } }
}

describe('Gateway calling Peer compatibility', () => {
  it('passes the same live Peer to unary and stream calls and releases it on disconnect', async () => {
    const h = await harness()
    try {
      h.request('one')
      h.follow()
      await vi.waitFor(() => expect(h.host.inFlightRequests).toBe(0))
      expect(h.createPeer).toHaveBeenCalledWith({ principal: { kind: 'owner' }, interactions: 'none' })
      expect(h.gateway.invoke.mock.calls[0]?.[0].peer).toBe(h.peers[0])
      expect(h.gateway.stream.mock.calls[0]?.[0].peer).toBe(h.peers[0])
      expect(h.peers[0]?.signal.aborted).toBe(false)
      h.host.onDisconnected(new NodeError('node/connection-lost', 'fixture disconnected', {}))
      await vi.waitFor(() => expect(h.peers[0]?.signal.aborted).toBe(true))
      h.request('two')
      await vi.waitFor(() => expect(h.host.inFlightRequests).toBe(0))
      expect(h.peers).toHaveLength(2)
      expect(h.gateway.invoke.mock.calls[1]?.[0].peer).toBe(h.peers[1])
    } finally {
      await h.close()
    }
  })

  it('keeps forwarding on older hosts without a Peer factory', async () => {
    const h = await harness(false)
    h.request('legacy')
    h.follow()
    await vi.waitFor(() => expect(h.host.inFlightRequests).toBe(0))
    expect(h.gateway.invoke).toHaveBeenCalledOnce()
    expect(h.gateway.stream).toHaveBeenCalledOnce()
    expect(h.gateway.invoke.mock.calls[0]?.[0].peer).toBeUndefined()
    expect(h.createPeer).not.toHaveBeenCalled()
    await h.close()
  })
})
