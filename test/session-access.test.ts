import { describe, it, expect, vi } from 'vitest'
import { NodeSessionAccess } from '../src/session-access.js'

function fixture() {
  const session = { id: 's1' }
  const agent = { id: 's1', session }
  let preset = 'workspace-write'
  const pending = [{ requestId: 'r1', toolName: 'write' }]
  const permissions = {
    names: ['workspace-write', 'danger-full-access'],
    current: () => preset,
    resolve: (name: string) => name === 'workspace-write'
      ? { sandbox: 'workspace-write', approval: 'ask' }
      : { sandbox: 'danger-full-access', approval: 'never' },
    optionOf: (value: string) => ({ value, name: value }),
    setForAgent: vi.fn((_agent: unknown, name: string) => { preset = name }),
  }
  const approval = { pending: () => pending, decidePending: vi.fn(() => ({ outcome: 'allowed-once' })) }
  const services: Record<string, unknown> = { permissionPresets: permissions, approval,
    typert: { lookups: { get: () => ({ resolve: async (id: string) => id === 's1' ? agent : undefined }) } } }
  const access = new NodeSessionAccess({ get: (key: string) => services[key] })
  return { access, permissions, approval }
}

describe('node session access', () => {
  it('returns authoritative options and switches only the selected existing session', async () => {
    const { access, permissions } = fixture()
    const before = await access.get('s1')
    expect(before.currentValue).toBe('workspace-write')
    expect(before.pendingApprovals).toHaveLength(1)
    const after = await access.set('s1', 'danger-full-access', before.revision, 'operation1')
    expect(after.currentValue).toBe('danger-full-access')
    await access.set('s1', 'danger-full-access', before.revision, 'operation1')
    expect(permissions.setForAgent).toHaveBeenCalledTimes(1)
    await expect(access.set('s1', 'workspace-write', before.revision, 'operation2')).rejects.toMatchObject({ code: 'nodeSessionAccess/conflict' })
  })
  it('rejects unknown sessions, presets, invalid outcomes and reused operation ids', async () => {
    const { access, approval } = fixture()
    await expect(access.get('missing')).rejects.toMatchObject({ code: 'nodeSessionAccess/not-found' })
    const before = await access.get('s1')
    await expect(access.set('s1', 'custom', before.revision, 'o1')).rejects.toMatchObject({ code: 'nodeSessionAccess/invalid-arguments' })
    await expect(access.decide('s1', 'r1', 'allow-all', 'o2')).rejects.toMatchObject({ code: 'nodeSessionAccess/invalid-arguments' })
    await access.decide('s1', 'r1', 'allowed-once', 'o3')
    await expect(access.decide('s1', 'r1', 'rejected', 'o3')).rejects.toMatchObject({ code: 'nodeSessionAccess/conflict' })
    expect(approval.decidePending).toHaveBeenCalledTimes(1)
  })
  it('fails explicitly on a host without the required lifecycle API', async () => {
    const access = new NodeSessionAccess({ get: () => undefined })
    await expect(access.get('s1')).rejects.toMatchObject({ code: 'nodeSessionAccess/unsupported' })
  })
})

it('delegates read-only viewers and expires an interactive viewing lease', async () => {
  vi.useFakeTimers()
  try {
    const { access } = fixture()
    await access.get('s1', false)
    const next = vi.fn(async () => 'rejected')
    await expect(access.answer({ agent: { id: 's1' } }, next)).resolves.toBe('rejected')
    await access.get('s1', true)
    const signal = new AbortController()
    const waiting = access.answer({ agent: { id: 's1' }, signal: signal.signal }, next)
    expect(next).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(15_001)
    await expect(waiting).resolves.toBe('rejected')
    expect(next).toHaveBeenCalledTimes(2)
    access.dispose()
  } finally { vi.useRealTimers() }
})
