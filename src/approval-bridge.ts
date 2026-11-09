/** Session-scoped adapter for Desktop's native, already-pending approval events. */
import { randomUUID } from 'node:crypto'
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'

type Decision = 'allowed-once' | 'rejected'
interface Approval { requestId: string; toolName: string; callId?: string; reason?: string }
interface Peer { readonly signal: AbortSignal; dispose(): Promise<void> }
interface Connection {
  createPeer(options: { principal: { kind: 'owner' }; interactions: 'answer' }): Peer
  createSharedFetchHandler(channel: '/api'): { fetch(request: Request, peer: Peer): Promise<Response> }
}
interface Gateway {
  wireStream: {
    open(endpoint: string, payload: unknown, uplink: AsyncIterable<unknown>, peer: Peer, signal: AbortSignal): Promise<AsyncIterable<unknown>>
  }
}
interface View {
  readonly sessionId: string
  readonly controller: AbortController
  readonly requests: Map<string, Approval>
  readonly ready: Promise<void>
  readonly peer: Peer
  readonly handler: ReturnType<Connection['createSharedFetchHandler']>
  timer?: ReturnType<typeof setTimeout>
  clientId?: string
}

const LEASE_MS = 15_000
const MAX_VIEWS = 32
const MAX_REQUESTS = 256
const SERVICE_KEY = 'nodeApprovals'

function descriptor(method: string, fields: readonly string[]): InvocationDescriptor {
  return {
    id: `dsh-node/approvals#${method}`, service: SERVICE_KEY, namespace: SERVICE_KEY, method,
    invocation: { kind: 'direct' },
    parameters: fields.map(name => ({ name, wire: name, source: 'json', codec: { mode: 'src-json' } })),
    result: { mode: 'src-json' },
  }
}
export const APPROVAL_DESCRIPTORS = [
  descriptor('pending', ['sessionId', 'interactive']),
  descriptor('decide', ['sessionId', 'requestId', 'outcome']),
]

function error(code: string, message: string): Error {
  return Object.assign(new Error(message), { code: `${SERVICE_KEY}/${code}`, isDSHRemoteError: true, details: {} })
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 512 && value.trim() !== ''
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export class NodeApprovalBridge {
  readonly typertRemote: { readonly service: unknown; readonly serviceKey: string; readonly namespace: string } = {
    service: this, serviceKey: SERVICE_KEY, namespace: SERVICE_KEY,
  }
  readonly #views = new Map<string, View>()
  readonly #tasks = new Set<Promise<void>>()
  #disposed = false

  constructor(private readonly ctx: { get(key: string, strict?: boolean): unknown }) {}

  /** Keep a dedicated answering peer only while master is viewing this session. */
  async pending(sessionId: unknown, interactive: unknown): Promise<{ requests: readonly Approval[] }> {
    if (!id(sessionId) || typeof interactive !== 'boolean') throw error('invalid-arguments', 'Invalid approval view')
    let view = this.#views.get(sessionId)
    if (interactive) {
      view ??= this.#start(sessionId)
      clearTimeout(view.timer)
      const current = view
      view.timer = setTimeout(() => { this.#close(current) }, LEASE_MS)
    }
    if (view === undefined) return { requests: [] }
    await view.ready
    return { requests: this.#views.get(sessionId) === view ? [...view.requests.values()] : [] }
  }

  /** Send one decision for an event delivered to this exact session and peer. */
  async decide(sessionId: unknown, requestId: unknown, outcome: unknown): Promise<{ accepted: true }> {
    if (!id(sessionId) || !id(requestId) || (outcome !== 'allowed-once' && outcome !== 'rejected')) {
      throw error('invalid-arguments', 'Invalid approval decision')
    }
    const view = this.#views.get(sessionId)
    if (view === undefined || !view.requests.delete(requestId)) {
      throw error('not-found', 'This approval is no longer pending in this session')
    }
    try {
      await this.#reply(view, requestId, outcome)
      return { accepted: true }
    } catch (cause) {
      // An uncertain answer must not be resent. A fresh view can replay any request still open on the host.
      this.#close(view)
      throw cause
    }
  }

  #start(sessionId: string): View {
    const connection = this.ctx.get('connection', false) as Partial<Connection> | undefined
    const gateway = this.ctx.get('typertGateway', false) as Partial<Gateway> | undefined
    if (this.#disposed || typeof connection?.createPeer !== 'function'
      || typeof connection.createSharedFetchHandler !== 'function' || typeof gateway?.wireStream?.open !== 'function') {
      throw error('unsupported', 'This host has no native approval event transport')
    }
    if (this.#views.size >= MAX_VIEWS) throw error('busy', 'Too many sessions are viewing approvals')
    const handler = connection.createSharedFetchHandler('/api')
    const peer = connection.createPeer({ principal: { kind: 'owner' }, interactions: 'answer' })
    let ready!: () => void
    let failed!: (cause: unknown) => void
    const view: View = {
      sessionId, peer, handler, controller: new AbortController(), requests: new Map(),
      ready: new Promise((resolve, reject) => { ready = resolve; failed = reject }),
    }
    this.#views.set(sessionId, view)
    const task = this.#consume(view, gateway.wireStream, ready).catch(failed).finally(async () => {
      this.#close(view)
      await peer.dispose().catch(() => {})
    })
    this.#tasks.add(task)
    void task.then(() => this.#tasks.delete(task))
    return view
  }

  async #consume(view: View, wire: Gateway['wireStream'], ready: () => void): Promise<void> {
    const signal = view.controller.signal
    const stream = await wire.open('$events', { args: {} }, (async function* () {})(), view.peer, signal)
    for await (const value of stream) {
      if (signal.aborted) break
      const frame = record(value)
      if (view.clientId === undefined) {
        if (frame?.['type'] !== 'ready' || !id(frame['clientId'])) throw error('unavailable', 'Approval stream did not initialize')
        view.clientId = frame['clientId']
        ready()
        continue
      }
      if (frame === undefined) continue
      const eventId = frame['eventId']
      if (!id(eventId)) continue
      if (frame['type'] === 'cancel') {
        view.requests.delete(eventId)
        continue
      }
      if (frame['type'] !== 'waterfall') continue
      const request = record(frame['request'])
      const toolName = request?.['toolName']
      // Gateway can settle the entire event on the last listener's `next` reply.
      // Leave unrelated or undisplayed requests open for their own answerers.
      if (frame['event'] !== 'approval/request' || frame['agentId'] !== view.sessionId || !id(toolName) || view.requests.size >= MAX_REQUESTS) continue
      const callId = request?.['callId']
      const reason = request?.['reason']
      view.requests.set(eventId, {
        requestId: eventId, toolName,
        ...(id(callId) ? { callId } : {}),
        ...(typeof reason === 'string' && reason !== '' ? { reason: reason.slice(0, 16_384) } : {}),
      })
    }
    if (view.clientId === undefined) throw error('unavailable', 'Approval stream closed before it was ready')
  }

  async #reply(view: View, eventId: string, outcome: Decision): Promise<void> {
    const rpcId = randomUUID()
    // This Request is dispatched in-process through the official Connection carrier.
    const request = new Request('http://localhost/api/$events/result', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: view.controller.signal,
      body: JSON.stringify({ type: 'client-request', rpcId, method: '$events/result',
        payload: { args: { clientId: view.clientId, eventId, outcome: { kind: 'result', value: outcome } } } }),
    })
    const response = await view.handler.fetch(request, view.peer)
    const reply = response.ok ? record(await response.json()) : undefined
    if (reply?.['type'] !== 'server-response' || reply['rpcId'] !== rpcId || record(reply['result'])?.['ok'] !== true) {
      throw error('unavailable', 'The host did not acknowledge the approval response')
    }
  }

  #close(view: View): void {
    if (this.#views.get(view.sessionId) === view) this.#views.delete(view.sessionId)
    clearTimeout(view.timer)
    view.requests.clear()
    view.controller.abort()
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    for (const view of this.#views.values()) this.#close(view)
    await Promise.all(this.#tasks)
  }
}
