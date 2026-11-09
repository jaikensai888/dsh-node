/** Named Remote operations for session permissions and existing approval requests. */
import { createHash } from 'node:crypto'
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'

type Outcome = 'allowed-once' | 'rejected'
interface Session { readonly id?: unknown; readonly seq?: number; eventAt?(seq: number): { type: string; data: Record<string, unknown> } | undefined }
interface Agent { readonly session: Session }
interface Pending { readonly requestId: string; readonly toolName: string; readonly callId?: string; readonly reason?: string }
interface Presets {
  readonly names: readonly string[]
  current(session: Session): string
  resolve(name: string): { sandbox: string; approval: string }
  optionOf(name: string): { value: string; name: string; description?: string }
  setForAgent(agent: Agent, name: string): void
}
interface Approvals {
  readonly config?: { policy?: string }
  pending(session: Session): readonly Pending[]
  decidePending(session: Session, requestId: string, outcome: Outcome): { outcome: string }
}
export interface AccessContext { get(key: string, strict?: boolean): unknown }
export interface AccessSnapshot {
  readonly currentValue: string
  readonly options: readonly { value: string; name: string; sandbox: string; approval: string }[]
  readonly revision: string
  readonly pendingApprovals: readonly Pending[]
  readonly supportsResumePending: true
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code: `nodeSessionAccess/${code}`, isDSHRemoteError: true, details: {} })
}
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 512) fail('invalid-arguments', `${name} must be a non-empty string of at most 512 characters`)
  return value
}
const parameter = (name: string): InvocationDescriptor['parameters'][number] => ({ name, wire: name, source: 'json', codec: { mode: 'src-json' } })
export const ACCESS_DESCRIPTORS: readonly InvocationDescriptor[] = [
  ['get', ['sessionId', 'interactive']], ['set', ['sessionId', 'preset', 'expectedRevision', 'operationId']],
  ['decide', ['sessionId', 'requestId', 'outcome', 'operationId']],
].map(([method, fields]) => ({
  id: `dsh-node/session-access#${method as string}`, service: 'nodeSessionAccess', namespace: 'nodeSessionAccess',
  method: method as string, invocation: { kind: 'direct' }, parameters: (fields as string[]).map(name => name === 'interactive' ? { ...parameter(name), acceptsUndefined: true as const } : parameter(name)), result: { mode: 'src-json' },
}))

/** Host-owned state is never reconstructed from master-side event rows. */
export class NodeSessionAccess {
  readonly typertRemote: { readonly service: unknown; readonly serviceKey: string; readonly namespace: string } = { service: this, serviceKey: 'nodeSessionAccess', namespace: 'nodeSessionAccess' }
  readonly #viewed = new Map<string, number>()
  readonly #operations = new Map<string, { fingerprint: string; result: unknown }>()
  readonly #withdraw = new AbortController()
  constructor(readonly ctx: AccessContext) {}

  supported(): boolean {
    const permissions = this.ctx.get('permissionPresets', false) as Partial<Presets> | undefined
    const approval = this.ctx.get('approval', false) as Partial<Approvals> | undefined
    return typeof permissions?.setForAgent === 'function' && typeof approval?.pending === 'function' && typeof approval.decidePending === 'function'
  }

  async #owner(sessionId: string): Promise<{ agent: Agent; permissions: Presets; approval: Approvals }> {
    if (!this.supported()) fail('unsupported', 'Upgrade the remote DSH host to support session permissions and approval settlement')
    const registry = this.ctx.get('typert', false) as { lookups?: { get(key: string): { resolve(id: string): unknown } | undefined } } | undefined
    const agent = await registry?.lookups?.get('agent')?.resolve(sessionId) as Agent | undefined
    if (agent?.session === undefined) fail('not-found', 'Session not found')
    return { agent, permissions: this.ctx.get('permissionPresets', false) as Presets, approval: this.ctx.get('approval', false) as Approvals }
  }

  #snapshot(agent: Agent, permissions: Presets, approval: Approvals): AccessSnapshot {
    const currentValue = permissions.current(agent.session)
    const options = permissions.names.map(name => ({ ...permissions.optionOf(name), ...permissions.resolve(name) }))
    const selected = options.find(option => option.value === currentValue)
    const shell = this.ctx.get('shell', false) as { sandboxMode?: string } | undefined
    let sandbox: unknown = shell?.sandboxMode ?? selected?.sandbox
    let policy: unknown = approval.config?.policy ?? selected?.approval
    let foundSandbox = false, foundPolicy = false
    for (let seq = (agent.session.seq ?? 0) - 1; seq >= 0 && (!foundSandbox || !foundPolicy); seq--) {
      const event = agent.session.eventAt?.(seq)
      if (!foundSandbox && event?.type === 'sandbox/mode') { sandbox = event.data['mode']; foundSandbox = true }
      if (!foundPolicy && event?.type === 'approval/policy') { policy = event.data['policy']; foundPolicy = true }
    }
    return { currentValue, options, revision: createHash('sha256').update(JSON.stringify([currentValue, sandbox, policy])).digest('hex'),
      pendingApprovals: approval.pending(agent.session), supportsResumePending: true }
  }

  async get(sessionIdValue: unknown, interactiveValue: unknown = false): Promise<AccessSnapshot> {
    const sessionId = text(sessionIdValue, 'sessionId')
    if (typeof interactiveValue !== 'boolean') fail('invalid-arguments', 'interactive must be a boolean')
    const { agent, permissions, approval } = await this.#owner(sessionId)
    for (const [id, expiry] of this.#viewed) if (expiry <= Date.now()) this.#viewed.delete(id)
    if (interactiveValue) this.#viewed.set(sessionId, Date.now() + 15_000)
    return this.#snapshot(agent, permissions, approval)
  }

  #run<T>(sessionId: string, operationIdValue: unknown, args: readonly unknown[], action: () => T): T {
    const operationId = text(operationIdValue, 'operationId')
    const key = JSON.stringify([sessionId, operationId])
    const fingerprint = JSON.stringify(args)
    const old = this.#operations.get(key)
    if (old !== undefined) {
      if (old.fingerprint !== fingerprint) fail('conflict', 'operationId already used for a different action')
      return old.result as T
    }
    const result = action()
    this.#operations.set(key, { fingerprint, result })
    if (this.#operations.size > 256) this.#operations.delete(this.#operations.keys().next().value!)
    return result
  }

  async set(sessionIdValue: unknown, presetValue: unknown, revisionValue: unknown, operationId: unknown): Promise<AccessSnapshot> {
    const sessionId = text(sessionIdValue, 'sessionId'), preset = text(presetValue, 'preset'), revision = text(revisionValue, 'expectedRevision')
    const { agent, permissions, approval } = await this.#owner(sessionId)
    return this.#run(sessionId, operationId, ['set', preset, revision], () => {
      if (!permissions.names.includes(preset) || preset === 'custom') fail('invalid-arguments', 'Unknown permission preset')
      if (revision !== this.#snapshot(agent, permissions, approval).revision) fail('conflict', 'Permissions changed; refresh before switching')
      permissions.setForAgent(agent, preset)
      return this.#snapshot(agent, permissions, approval)
    })
  }

  async decide(sessionIdValue: unknown, requestIdValue: unknown, outcomeValue: unknown, operationId: unknown): Promise<{ outcome: string }> {
    const sessionId = text(sessionIdValue, 'sessionId'), requestId = text(requestIdValue, 'requestId')
    if (outcomeValue !== 'allowed-once' && outcomeValue !== 'rejected') fail('invalid-arguments', 'Invalid approval outcome')
    const { agent, approval } = await this.#owner(sessionId)
    return this.#run(sessionId, operationId, ['decide', requestId, outcomeValue], () => {
      try { return approval.decidePending(agent.session, requestId, outcomeValue) }
      catch (error) { fail('conflict', error instanceof Error ? error.message : 'Approval is no longer pending') }
    })
  }

  /** Wait only while the selected session is viewed; otherwise delegate locally. */
  async answer(request: { agent?: { id?: unknown }; signal?: AbortSignal }, next: () => Promise<string>): Promise<string> {
    const sessionId = request.agent?.id
    if (typeof sessionId !== 'string' || !this.supported() || (this.#viewed.get(sessionId) ?? 0) <= Date.now()) return next()
    return new Promise<string>(resolve => {
      let timer: ReturnType<typeof setTimeout>
      const finish = (outcome?: string): void => {
        clearTimeout(timer)
        request.signal?.removeEventListener('abort', cancelled)
        this.#withdraw.signal.removeEventListener('abort', withdrawn)
        if (outcome === undefined) void next().then(resolve, () => resolve('unavailable'))
        else resolve(outcome)
      }
      const cancelled = (): void => { finish('cancelled') }
      const withdrawn = (): void => { finish('unavailable') }
      const tick = (): void => {
        const remaining = (this.#viewed.get(sessionId) ?? 0) - Date.now()
        if (remaining <= 0) finish()
        else timer = setTimeout(tick, remaining)
      }
      request.signal?.addEventListener('abort', cancelled, { once: true })
      this.#withdraw.signal.addEventListener('abort', withdrawn, { once: true })
      if (request.signal?.aborted) cancelled()
      else if (this.#withdraw.signal.aborted) withdrawn()
      else tick()
    })
  }

  dispose(): void { this.#withdraw.abort(); this.#viewed.clear(); this.#operations.clear() }
}
