import { describe, expect, it, vi } from 'vitest'
import { NodeApprovalBridge } from '../src/approval-bridge.js'

function fixture() {
  const frames: unknown[] = [{ type: 'ready', clientId: 'client-1' }]
  let notify: (() => void) | undefined
  const push = (frame: unknown) => { frames.push(frame); notify?.() }
  const dispose = vi.fn(async () => {})
  const sent: Record<string, unknown>[] = []
  const connection = {
    createPeer: vi.fn(() => ({ signal: new AbortController().signal, dispose })),
    createSharedFetchHandler: () => ({ fetch: async (request: Request) => {
      const body = await request.json() as { rpcId: string; payload: { args: Record<string, unknown> } }
      sent.push(body.payload.args)
      return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true } })
    } }),
  }
  const gateway = { wireStream: { open: async (_endpoint: string, _payload: unknown, _uplink: unknown, _peer: unknown, signal: AbortSignal) => (async function* () {
    while (!signal.aborted) {
      if (frames.length > 0) { yield frames.shift(); continue }
      await new Promise<void>(resolve => {
        notify = () => { signal.removeEventListener('abort', notify!); resolve() }
        signal.addEventListener('abort', notify, { once: true })
      })
    }
  })() } }
  const bridge = new NodeApprovalBridge({ get: (key: string) => key === 'connection' ? connection : key === 'typertGateway' ? gateway : undefined })
  return { bridge, push, connection, dispose, sent }
}

const request = (id: string, session: string, event = 'approval/request') => ({ type: 'waterfall', event, eventId: id, agentId: session, request: { toolName: 'write', reason: 'outside workspace' } })

describe('native approval forwarding', () => {
  it('opens only on interactive views and answers the original event using its own peer', async () => {
    const { bridge, push, connection, sent, dispose } = fixture()
    try {
      expect(await bridge.pending('s1', false)).toEqual({ requests: [] })
      expect(connection.createPeer).not.toHaveBeenCalled()
      await bridge.pending('s1', true)
      expect(connection.createPeer).toHaveBeenCalledWith({ principal: { kind: 'owner' }, interactions: 'answer' })
      push(request('other', 's2'))
      push(request('question', 's1', 'user-questions/request'))
      push(request('approval', 's1'))
      await vi.waitFor(async () => expect((await bridge.pending('s1', true)).requests).toMatchObject([{ requestId: 'approval', toolName: 'write' }]))
      await expect(bridge.decide('s2', 'approval', 'allowed-once')).rejects.toMatchObject({ code: 'nodeApprovals/not-found' })
      await expect(bridge.decide('s1', 'approval', 'allow-all')).rejects.toMatchObject({ code: 'nodeApprovals/invalid-arguments' })
      expect(await bridge.decide('s1', 'approval', 'allowed-once')).toEqual({ accepted: true })
      await expect(bridge.decide('s1', 'approval', 'allowed-once')).rejects.toMatchObject({ code: 'nodeApprovals/not-found' })
      expect(sent).toEqual([
        { clientId: 'client-1', eventId: 'approval', outcome: { kind: 'result', value: 'allowed-once' } },
      ])
    } finally { await bridge.dispose() }
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('withdraws a cancelled event without submitting a decision', async () => {
    const { bridge, push, dispose, sent } = fixture()
    try {
      await bridge.pending('s1', true)
      push(request('cancelled', 's1'))
      await vi.waitFor(async () => expect((await bridge.pending('s1', true)).requests).toHaveLength(1))
      push({ type: 'cancel', eventId: 'cancelled' })
      await vi.waitFor(async () => expect((await bridge.pending('s1', false)).requests).toHaveLength(0))
      await expect(bridge.decide('s1', 'cancelled', 'rejected')).rejects.toMatchObject({ code: 'nodeApprovals/not-found' })
      expect(sent).toHaveLength(0)
    } finally { await bridge.dispose() }
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})


it('closes the peer when an interactive view stops renewing its lease', async () => {
  vi.useFakeTimers()
  const { bridge, dispose } = fixture()
  try {
    await bridge.pending('s1', true)
    await vi.advanceTimersByTimeAsync(15_001)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(await bridge.pending('s1', false)).toEqual({ requests: [] })
  } finally {
    await bridge.dispose()
    vi.useRealTimers()
  }
})
