/**
 * The `nodeAdmin` management surface.
 *
 * This is the only part of the plugin that can *change* the machine, so the tests
 * are written around refusals as much as around happy paths: what the fence
 * rejects, what the name validator rejects, and — most importantly — that the
 * exposed surface is exactly the list someone reviewed, with no extra endpoint.
 *
 * The dispatch path itself (a Coordinator reaching these over the wire, through
 * the real Gateway) is covered in `integration.test.ts`.
 */

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ADMIN_ERROR_CODES, remoteError } from '../src/errors.js'
import { AuditLog } from '../src/admin/audit.js'
import { canonicalize, decidePath, describeDenial, isWithin, resolvePathPolicy } from '../src/admin/path-policy.js'
import {
  ADMIN_DESCRIPTORS,
  ADMIN_NAMESPACE,
  ADMIN_SERVICE_KEY,
  MAX_READ_BYTES,
  NodeAdminOwner,
  requireSkillName,
  type AdminHostView,
} from '../src/admin/service.js'

const NODE = 'node-admin-test'
const WORKSPACE = 'w-1'

let root: string
let allowed: string
let outside: string
let skillRoot: string

beforeEach(async () => {
  // Create the parent first: `mkdtemp` needs it to exist, and relying on another
  // test file to have created it makes this file fail when run on its own (or
  // after `.tmp` is cleaned).
  const tmp = join(process.cwd(), '.tmp')
  await mkdir(tmp, { recursive: true })
  root = await mkdtemp(join(tmp, 'admin-'))
  allowed = join(root, 'workspace')
  outside = join(root, 'outside')
  skillRoot = join(root, 'skills')
  await mkdir(allowed, { recursive: true })
  await mkdir(outside, { recursive: true })
  await mkdir(skillRoot, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A host view with no sessions and fixed diagnostics. */
function hostView(overrides: Partial<AdminHostView> = {}): AdminHostView {
  return {
    status: () => ({
      state: 'ready',
      nodeId: NODE,
      reconnectAttempt: 0,
      inFlightRequests: 0,
      activeStreams: 0,
      coordinatorOrigin: 'wss://example.com',
    }),
    capabilities: () => [{ endpoint: 'session/list', mode: 'unary' }],
    startedAt: () => 1_000,
    sessionCwds: () => [allowed],
    version: () => '0.1.0',
    ...overrides,
  }
}

/** Options for {@link makeOwner}. */
interface OwnerOptions {
  readonly host?: AdminHostView
  readonly allowedRoots?: readonly string[]
  readonly skillRoots?: readonly string[]
  readonly filesystemEnabled?: boolean
  readonly skillsEnabled?: boolean
  readonly now?: () => number
}

/**
 * An owner over the temp roots.
 *
 * `DSH_HOME` and `DSH_AGENTS_HOME` are redirected into the temp directory so the
 * default skill roots land there too — otherwise a test would read this machine's
 * real `~/.dsh/skills`, which is both a leak and a source of flakiness.
 */
function makeOwner(overrides: OwnerOptions = {}): NodeAdminOwner {
  return new NodeAdminOwner({
    host: overrides.host ?? hostView(),
    policy: {
      allowedRoots: overrides.allowedRoots ?? [allowed],
      skillRoots: overrides.skillRoots ?? [skillRoot],
      env: { DSH_HOME: root, DSH_AGENTS_HOME: join(root, 'agents') },
    },
    filesystemEnabled: overrides.filesystemEnabled ?? true,
    skillsEnabled: overrides.skillsEnabled ?? true,
    now: overrides.now ?? (() => 10_000),
  })
}

/** Assert a rejection carries one of the plugin's own codes. */
async function expectCode(run: () => Promise<unknown> | unknown, code: string): Promise<void> {
  try {
    await run()
  } catch (error) {
    expect((error as { code?: string }).code, String(error)).toBe(code)
    return
  }
  throw new Error(`expected ${code}`)
}

/** Capture a rejection as `{ code, message }`, failing the test if it resolves. */
async function captureFailure(
  run: () => Promise<unknown> | unknown,
): Promise<{ readonly code: string; readonly message: string }> {
  try {
    await run()
  } catch (error) {
    const failure = error as { code?: string; message?: string }
    return { code: failure.code ?? '', message: failure.message ?? '' }
  }
  throw new Error('expected the call to fail')
}

describe('exposed surface', () => {
  it('is exactly the reviewed list, with no extra endpoint', () => {
    // A new endpoint has to be added here deliberately. That is the point: this
    // surface is "everything a Coordinator may do to this machine".
    expect(ADMIN_DESCRIPTORS.map(descriptor => descriptor.method).sort()).toEqual([
      'audit',
      'capabilities',
      'describe',
      'fsList',
      'fsRead',
      'fsRemove',
      'fsStat',
      'fsWrite',
      'skillInstall',
      'skillRead',
      'skillRemove',
      'skillsList',
      'status',
    ])
  })

  it('puts every method in one namespace under one service', () => {
    for (const descriptor of ADMIN_DESCRIPTORS) {
      expect(descriptor.namespace, descriptor.method).toBe(ADMIN_NAMESPACE)
      expect(descriptor.service, descriptor.method).toBe(ADMIN_SERVICE_KEY)
      expect(descriptor.result, descriptor.method).toEqual({ mode: 'src-json' })
    }
  })

  it('declares only named scalar parameters — no free-form blob', () => {
    const parameters = ADMIN_DESCRIPTORS.flatMap(descriptor => descriptor.parameters.map(p => p.wire))
    expect([...new Set(parameters)].sort()).toEqual(['content', 'limit', 'name', 'path'])
  })

  it('exposes no endpoint that names a process, a shell, or a module', () => {
    const methods = ADMIN_DESCRIPTORS.map(descriptor => descriptor.method).join(' ')
    for (const forbidden of ['exec', 'shell', 'spawn', 'eval', 'require', 'import']) {
      expect(methods).not.toContain(forbidden)
    }
  })

  it('carries the gateway binding the way the Gateway reads it', () => {
    const owner = makeOwner()
    // `readBinding` checks these three and that `service` is the receiver itself.
    expect(owner.typertRemote.service).toBe(owner)
    expect(owner.typertRemote.serviceKey).toBe(ADMIN_SERVICE_KEY)
    expect(owner.typertRemote.namespace).toBe(ADMIN_NAMESPACE)
    expect(Object.isFrozen(owner.typertRemote)).toBe(true)
  })

  it('resolves every descriptor to a callable method on the owner', () => {
    // This is the test that catches a real bug found in integration: a descriptor
    // named `audit` while the method was `auditRecent`, and `owner.audit` was a
    // data field — so the Gateway's `Reflect.get(receiver, 'audit')` found a
    // non-callable object and every call failed as `gateway/method-unavailable`.
    // Calling the method directly in a unit test never crosses that boundary.
    const owner = makeOwner() as unknown as Record<string, unknown>
    for (const descriptor of ADMIN_DESCRIPTORS) {
      const name = descriptor.implementation ?? descriptor.method
      expect(typeof owner[name], descriptor.method).toBe('function')
    }
  })

  it('keeps every wire method name free of a non-callable field', () => {
    // Belt and braces for the same hazard: a data field must never sit on a name
    // the Gateway resolves.
    const owner = makeOwner() as unknown as Record<string, unknown>
    for (const descriptor of ADMIN_DESCRIPTORS) {
      if (descriptor.implementation !== undefined) continue
      expect(typeof owner[descriptor.method], descriptor.method).toBe('function')
    }
    // The audit trail is `auditLog` precisely so the name `audit` stays free.
    expect(owner['audit']).toBeUndefined()
    expect(owner['auditLog']).toBeInstanceOf(AuditLog)
  })
})

describe('diagnostics', () => {
  it('describes the node without leaking its configuration or credential', () => {
    const owner = makeOwner({ host: hostView({ nodeName: 'agent-a', role: 'test-agent' }) })
    const described = owner.describe()

    expect(described).toMatchObject({
      nodeId: NODE,
      nodeName: 'agent-a',
      role: 'test-agent',
      mode: 'full-access',
      pluginVersion: '0.1.0',
      state: 'ready',
      capabilityCount: 1,
      surfaces: { diagnostics: true, filesystem: true, skills: true },
    })
    expect(JSON.stringify(described)).not.toContain('token')
    expect(JSON.stringify(described)).not.toContain(skillRoot)
  })

  it('reports an uptime from the injected clock', () => {
    const owner = makeOwner({ now: () => 11_000 })
    expect(owner.describe()['uptimeMs']).toBe(10_000)
  })

  it('reports the switches so "empty" is distinguishable from "off"', () => {
    const off = makeOwner({ filesystemEnabled: false, skillsEnabled: false }).describe()
    expect(off['surfaces']).toEqual({ diagnostics: true, filesystem: false, skills: false })
  })

  it('returns the capability list with modes', () => {
    const owner = makeOwner()
    expect(owner.capabilities()).toEqual({ remotes: [{ endpoint: 'session/list', mode: 'unary' }] })
  })

  it('caps a requested audit limit at the ring capacity', () => {
    const owner = makeOwner()
    expect(owner.auditRecent(10_000).capacity).toBe(owner.auditLog.limit)
    expect(owner.auditRecent(10_000).records.length).toBeLessThanOrEqual(owner.auditLog.limit)
  })

  it.each([['a string', 'ten'], ['a fraction', 1.5], ['zero', 0], ['negative', -1]])(
    'rejects an audit limit that is %s',
    async (_label, limit) => {
      await expectCode(() => makeOwner().auditRecent(limit), 'nodeAdmin/invalid-arguments')
    },
  )
})

describe('filesystem policy', () => {
  it('reads and writes inside an allowed root', async () => {
    const owner = makeOwner()
    const target = join(allowed, 'notes', 'a.txt')

    const written = await owner.fsWrite(target, 'hello')
    expect(written['bytes']).toBe(5)
    expect(await readFile(target, 'utf8')).toBe('hello')

    expect((await owner.fsRead(target))['content']).toBe('hello')
    expect((await owner.fsStat(target))['kind']).toBe('file')
    const listing = await owner.fsList(join(allowed, 'notes'))
    expect(listing['entries']).toEqual([{ name: 'a.txt', kind: 'file' }])
  })

  it('refuses a path outside every allowed root', async () => {
    const owner = makeOwner()
    await expectCode(() => owner.fsRead(join(outside, 'secret.txt')), 'nodeAdmin/path-denied')
    await expectCode(() => owner.fsWrite(join(outside, 'x.txt'), 'x'), 'nodeAdmin/path-denied')
    await expectCode(() => owner.fsList(outside), 'nodeAdmin/path-denied')
    await expectCode(() => owner.fsRemove(join(outside, 'x.txt')), 'nodeAdmin/path-denied')
  })

  it('refuses a sibling whose name merely starts with the root name', async () => {
    // `/tmp/admin-x/workspace-evil` must not pass because it starts with the root
    // string: containment is segment-aware, not `startsWith`.
    const sibling = `${allowed}-evil`
    await mkdir(sibling, { recursive: true })
    await writeFile(join(sibling, 'f.txt'), 'x', 'utf8')
    await expectCode(() => makeOwner().fsRead(join(sibling, 'f.txt')), 'nodeAdmin/path-denied')
  })

  it('refuses traversal that climbs out of an allowed root', async () => {
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8')
    const escaping = join(allowed, '..', 'outside', 'secret.txt')
    await expectCode(() => makeOwner().fsRead(escaping), 'nodeAdmin/path-denied')
  })

  it('refuses a relative path and a drive-relative path', async () => {
    const owner = makeOwner()
    await expectCode(() => owner.fsRead('notes/a.txt'), 'nodeAdmin/path-denied')
    await expectCode(() => owner.fsRead(''), 'nodeAdmin/path-denied')
    await expectCode(() => owner.fsRead(undefined), 'nodeAdmin/path-denied')
    if (process.platform === 'win32') {
      // `C:foo` satisfies `isAbsolute` but resolves against a per-drive cwd.
      await expectCode(() => owner.fsRead('C:windows\\system32\\drivers\\etc\\hosts'), 'nodeAdmin/path-denied')
    }
  })

  it('refuses a link that points outside the allowed root', async () => {
    const link = join(allowed, 'escape')
    try {
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      return // Links are unavailable in this environment; the realpath rule is covered below.
    }
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8')
    // The link is inside the root, but its target is not — realpath catches it.
    await expectCode(() => makeOwner().fsRead(join(link, 'secret.txt')), 'nodeAdmin/path-denied')
  })

  it('refuses everything when no root is allowed', async () => {
    const owner = makeOwner({ allowedRoots: [], host: hostView({ sessionCwds: () => [] }) })
    await expectCode(() => owner.fsRead(join(allowed, 'a.txt')), 'nodeAdmin/path-denied')
    await expectCode(() => owner.fsList(allowed), 'nodeAdmin/path-denied')
  })

  it('refuses the whole surface when it is switched off', async () => {
    const owner = makeOwner({ filesystemEnabled: false })
    await expectCode(() => owner.fsRead(join(allowed, 'a.txt')), 'nodeAdmin/path-denied')
    await expectCode(() => owner.fsWrite(join(allowed, 'a.txt'), 'x'), 'nodeAdmin/path-denied')
  })

  it('refuses a read larger than the limit instead of truncating silently', async () => {
    const target = join(allowed, 'big.txt')
    await writeFile(target, 'x'.repeat(MAX_READ_BYTES + 1), 'utf8')
    await expectCode(() => makeOwner().fsRead(target), 'nodeAdmin/too-large')
  })

  it('refuses a write larger than the limit', async () => {
    await expectCode(
      () => makeOwner().fsWrite(join(allowed, 'big.txt'), 'x'.repeat(5_000_000)),
      'nodeAdmin/too-large',
    )
  })

  it('refuses a non-string content', async () => {
    await expectCode(() => makeOwner().fsWrite(join(allowed, 'a.txt'), 42), 'nodeAdmin/invalid-arguments')
    await expectCode(() => makeOwner().fsWrite(join(allowed, 'a.txt'), undefined), 'nodeAdmin/invalid-arguments')
  })

  it('refuses to read a directory', async () => {
    await expectCode(() => makeOwner().fsRead(allowed), 'nodeAdmin/invalid-arguments')
  })

  it('removes one file but never a non-empty tree in one call', async () => {
    const owner = makeOwner()
    const directory = join(allowed, 'tree')
    await owner.fsWrite(join(directory, 'inner.txt'), 'x')

    // A non-recursive delete on a non-empty directory must fail rather than wipe it.
    await expect(owner.fsRemove(directory)).rejects.toThrow()
    expect((await owner.fsRead(join(directory, 'inner.txt')))['content']).toBe('x')

    expect((await owner.fsRemove(join(directory, 'inner.txt')))).toMatchObject({ removed: true, kind: 'file' })
    // Now empty, so it may go — and only now.
    expect((await owner.fsRemove(directory))).toMatchObject({ removed: true, kind: 'directory' })
  })

  it('surfaces a missing file as an ordinary operational error', async () => {
    await expect(makeOwner().fsRead(join(allowed, 'nope.txt'))).rejects.toThrow()
  })
})

describe('skill names', () => {
  it.each(['my-skill', 'a1', 'skill_v2', 'skill.name'])('accepts %s', name => {
    expect(requireSkillName(name)).toBe(name)
  })

  it.each([
    ['', 'empty'],
    ['..', 'dotdot'],
    ['.', 'dot'],
    ['../escape', 'traversal'],
    ['..\\escape', 'windows traversal'],
    ['/absolute', 'absolute'],
    ['nested/name', 'a path'],
    ['nested\\name', 'a windows path'],
    ['-leading', 'a leading hyphen'],
    ['a'.repeat(65), 'too long'],
  ])('rejects %s (%s)', (name, _why) => {
    expect(() => requireSkillName(name)).toThrowError(/nodeAdmin\/invalid-name|name must/u)
    try {
      requireSkillName(name)
    } catch (error) {
      expect((error as { code?: string }).code).toBe('nodeAdmin/invalid-name')
    }
  })
})

describe('skill management', () => {
  it('installs, reads, lists, and removes one bundle', async () => {
    const owner = makeOwner()

    const installed = await owner.skillInstall('demo-skill', '# Demo\n')
    expect(installed).toMatchObject({ name: 'demo-skill', bytes: 7 })
    // The response echoes the name, not this machine's skill directory.
    expect(JSON.stringify(installed)).not.toContain(skillRoot)
    expect(await readFile(join(skillRoot, 'demo-skill', 'SKILL.md'), 'utf8')).toBe('# Demo\n')

    expect((await owner.skillRead('demo-skill'))['content']).toBe('# Demo\n')
    const listed = await owner.skillsList()
    expect(listed['skills']).toEqual([{ name: 'demo-skill', layer: 'primary', hasSkillMd: true }])
    expect(JSON.stringify(listed)).not.toContain(skillRoot)

    expect((await owner.skillRemove('demo-skill'))['removed']).toBe(true)
    await expect(owner.skillRead('demo-skill')).rejects.toThrow()
  })

  it('cannot be steered out of the skill root by a name', async () => {
    const owner = makeOwner()
    for (const name of ['../outside', '..\\outside', '/etc/passwd', 'a/b']) {
      await expectCode(() => owner.skillInstall(name, 'x'), 'nodeAdmin/invalid-name')
      await expectCode(() => owner.skillRemove(name), 'nodeAdmin/invalid-name')
    }
    // Nothing was created outside the root.
    await expect(readFile(join(outside, 'SKILL.md'), 'utf8')).rejects.toThrow()
  })

  it('refuses the whole surface when it is switched off', async () => {
    const owner = makeOwner({ skillsEnabled: false })
    await expectCode(() => owner.skillsList(), 'nodeAdmin/path-denied')
    await expectCode(() => owner.skillInstall('demo', 'x'), 'nodeAdmin/path-denied')
    await expectCode(() => owner.skillRead('demo'), 'nodeAdmin/path-denied')
  })

  it('refuses an oversized bundle', async () => {
    await expectCode(() => makeOwner().skillInstall('demo', 'x'.repeat(2_000_000)), 'nodeAdmin/too-large')
  })

  it('reports a missing skill as not-found without naming the skill directory', async () => {
    // Found live, through a real Coordinator: `rm`/`readFile` on a missing skill
    // escaped as `gateway/internal` carrying the raw OS message — which contains
    // the absolute path, exactly what the skill surface promises never to reveal.
    const owner = makeOwner()

    for (const call of [() => owner.skillRead('never-installed'), () => owner.skillRemove('never-installed')]) {
      const failure = await captureFailure(call)
      expect(failure.code).toBe('nodeAdmin/not-found')
      expect(failure.message).toContain('never-installed')
      expect(failure.message).not.toContain(skillRoot)
      expect(failure.message).not.toMatch(/[A-Za-z]:\\\\/u)
      expect(failure.message).not.toContain('ENOENT')
    }
  })
})

describe('filesystem failures', () => {
  it('reports a missing path as not-found rather than a raw errno', async () => {
    const owner = makeOwner()
    const missing = join(allowed, 'no-such-file.txt')

    for (const call of [
      () => owner.fsStat(missing),
      () => owner.fsRead(missing),
      () => owner.fsRemove(missing),
      () => owner.fsList(join(allowed, 'no-such-directory')),
    ]) {
      const failure = await captureFailure(call)
      expect(failure.code).toBe('nodeAdmin/not-found')
      // The caller's own path may appear (they supplied it); the OS text may not.
      expect(failure.message).not.toContain('ENOENT')
      expect(failure.message).not.toContain('lstat')
    }
  })

  it('reports a non-empty directory as invalid-arguments, not a raw errno', async () => {
    const owner = makeOwner()
    await owner.fsWrite(join(allowed, 'nested', 'child.txt'), 'x')

    const failure = await captureFailure(() => owner.fsRemove(join(allowed, 'nested')))
    expect(failure.code).toBe('nodeAdmin/invalid-arguments')
    expect(failure.message).not.toContain('ENOTEMPTY')
  })

  it('never leaks an absolute path in a failure message for a skill, and never a raw errno anywhere', async () => {
    const owner = makeOwner()
    const failures = await Promise.all([
      captureFailure(() => owner.skillRead('missing')),
      captureFailure(() => owner.fsStat(join(allowed, 'missing'))),
      captureFailure(() => owner.fsRemove(join(outside, 'anything'))),
    ])
    for (const failure of failures) {
      expect(failure.message).not.toMatch(/ENOENT|EPERM|EACCES|ENOTEMPTY|EISDIR|ENOTDIR/u)
    }
    // A path refusal names the reason, never the OS error text.
    expect(failures[2]?.code).toBe('nodeAdmin/path-denied')
  })
})

describe('audit trail', () => {
  it('records what happened, newest first, without arguments or contents', async () => {
    const owner = makeOwner()
    await owner.fsWrite(join(allowed, 'a.txt'), 'SECRET-CONTENT')
    await owner.fsRead(join(allowed, 'a.txt'))
    owner.describe()

    const { records } = owner.auditRecent(10)
    expect(records.map(record => record.endpoint)).toEqual([
      'nodeAdmin/describe',
      'nodeAdmin/fsRead',
      'nodeAdmin/fsWrite',
    ])
    const text = JSON.stringify(records)
    // The trail must not become a copy of the data it describes.
    expect(text).not.toContain('SECRET-CONTENT')
    expect(text).not.toContain(allowed)
  })

  it('records a refusal with its code', async () => {
    const owner = makeOwner()
    await expect(owner.fsRead(join(outside, 'x.txt'))).rejects.toThrow()
    const { records } = owner.auditRecent(1)
    expect(records[0]).toMatchObject({
      endpoint: 'nodeAdmin/fsRead',
      outcome: 'error',
      code: 'nodeAdmin/path-denied',
    })
  })

  it('stays bounded', () => {
    const log = new AuditLog(3, () => 0)
    for (let index = 1; index <= 5; index += 1) {
      log.append({ at: log.timestamp(), endpoint: `e${index}`, outcome: 'ok' })
    }
    expect(log.size).toBe(3)
    expect(log.recent(10).map(record => record.endpoint)).toEqual(['e5', 'e4', 'e3'])
  })

  it('returns a copy, so a caller cannot rewrite history', () => {
    const log = new AuditLog(2, () => 0)
    log.append({ at: log.timestamp(), endpoint: 'e1', outcome: 'ok' })
    const records = log.recent(1)
    records.push({ at: 'x', endpoint: 'injected', outcome: 'ok' })
    expect(log.recent(10)).toHaveLength(1)
  })

  it('clamps a capacity of zero or below to one', () => {
    expect(new AuditLog(0).limit).toBe(1)
    expect(new AuditLog(-5).limit).toBe(1)
  })
})

describe('path policy primitives', () => {
  it('keeps containment segment-aware and case-insensitive on Windows', () => {
    const base = process.platform === 'win32' ? 'C:\\root' : '/root'
    const child = process.platform === 'win32' ? 'C:\\root\\a\\b' : '/root/a/b'
    const sibling = process.platform === 'win32' ? 'C:\\rooted' : '/rooted'
    expect(isWithin(base, base)).toBe(true)
    expect(isWithin(base, child)).toBe(true)
    expect(isWithin(base, sibling)).toBe(false)
    expect(isWithin(base, process.platform === 'win32' ? 'C:/root/a' : '/root/a')).toBe(true)
    if (process.platform === 'win32') expect(isWithin(base, 'c:\\ROOT\\a')).toBe(true)
  })

  it('canonicalizes a path whose final components do not exist yet', async () => {
    const canonical = await canonicalize(join(allowed, 'not', 'created', 'yet.txt'))
    expect(canonical?.toLowerCase()).toContain('yet.txt')
    expect(canonical).not.toContain('..')
  })

  it('reports every denial without naming a host path', () => {
    for (const message of [
      describeDenial('not-absolute'),
      describeDenial('no-roots'),
      describeDenial('outside-roots'),
      describeDenial('unresolvable'),
    ]) {
      expect(message).not.toContain('\\')
      expect(message).not.toContain('/')
      expect(message.length).toBeGreaterThan(10)
    }
  })

  it('derives the harness skill roots from $DSH_HOME', () => {
    const policy = resolvePathPolicy({ env: { DSH_HOME: root, DSH_AGENTS_HOME: join(root, 'agents') } })
    expect(policy.skillRoots).toContain(join(root, 'skills'))
    expect(policy.skillRoots).toContain(join(root, 'agents', 'skills'))
  })

  it('puts a configured skill root first, so it is the install target', () => {
    const policy = resolvePathPolicy({ skillRoots: [skillRoot], env: { DSH_HOME: root } })
    expect(policy.skillRoots[0]).toBe(skillRoot)
  })

  it('de-duplicates roots and drops blanks', () => {
    const policy = resolvePathPolicy({
      allowedRoots: [allowed, allowed, '', '   '],
      skillRoots: [skillRoot],
      env: { DSH_HOME: root },
    })
    expect(policy.roots).toEqual([allowed])
  })

  it('decides a path without touching the filesystem when no root is allowed', async () => {
    expect(await decidePath([], allowed)).toEqual({ allowed: false, reason: 'no-roots' })
    expect(await decidePath([allowed], 'relative/x')).toEqual({ allowed: false, reason: 'not-absolute' })
  })
})

describe('remoteError', () => {
  it('carries the structural marker DSH recognises as a business failure', () => {
    const error = remoteError('nodeAdmin/path-denied', 'no', { reason: 'outside-roots' }) as Error & {
      code: string
      details: Record<string, unknown>
      isDSHRemoteError: boolean
    }
    // This is what `remoteErrorOf` checks, and it is why no official package has
    // to be imported at runtime to keep a code intact.
    expect(error.isDSHRemoteError).toBe(true)
    expect(error.code).toBe('nodeAdmin/path-denied')
    expect(error.details).toEqual({ reason: 'outside-roots' })
    expect(error).toBeInstanceOf(Error)
  })

  it('declares every code the surface can raise', () => {
    expect([...ADMIN_ERROR_CODES].every(code => code.startsWith('nodeAdmin/'))).toBe(true)
    expect(ADMIN_ERROR_CODES).toHaveLength(6)
  })
})
