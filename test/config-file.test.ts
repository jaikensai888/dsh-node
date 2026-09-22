/**
 * The stored configuration file and the service that writes it.
 *
 * These are the tests for the one place this plugin puts a **credential** on disk, so
 * they are written around three questions: can a save be lost or half-written, can the
 * token come back out, and can a save silently mean nothing because a higher-precedence
 * layer disagrees.
 *
 * @module dsh-node/test/config-file
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { COORDINATOR_URL_ENV, TOKEN_ENV, resolveNodeConfig } from '../src/config.js'
import {
  CONFIG_FILE_NAME,
  CONFIG_FILE_VERSION,
  describeStoredConfig,
  mergeNodeConfig,
  readConfigFile,
  resolveConfigFile,
  writeConfigFile,
} from '../src/config-file.js'
import { NodeConfigService, foldSubmission, readSubmission } from '../src/config-service.js'
import { HttpFailure } from '../src/http-api.js'
import type { StoredNodeConfig } from '../src/config-file.js'

const TOKEN = 'token-that-must-never-be-echoed'
const WS_URL = 'ws://127.0.0.1:39472/node'
const ENV: NodeJS.ProcessEnv = { [TOKEN_ENV]: TOKEN }

let directory: string
let file: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-node-config-'))
  file = join(directory, CONFIG_FILE_NAME)
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('the configuration file location', () => {
  it('lives beside the identity file, with a fixed name', () => {
    const resolved = resolveConfigFile({ DSH_HOME: join('C:', 'Users', 'someone', '.dsh') })
    expect(resolved.endsWith(join('storages', 'dsh-node', 'config.json'))).toBe(true)
    expect(CONFIG_FILE_NAME).toBe('config.json')
  })
})

describe('reading the file', () => {
  it('treats a missing file as "nothing configured here", not as an error', async () => {
    const read = await readConfigFile(file)
    expect(read.file).toBe(file)
    expect(read.config).toBeUndefined()
    expect(read.error).toBeUndefined()
  })

  it('reads a written document back unchanged', async () => {
    await writeConfigFile(file, { coordinatorUrl: WS_URL, token: TOKEN, nodeName: 'desk', role: 'build', connectionIntent: 'paused' })
    const read = await readConfigFile(file)
    expect(read.error).toBeUndefined()
    expect(read.config).toEqual({ coordinatorUrl: WS_URL, token: TOKEN, nodeName: 'desk', role: 'build', connectionIntent: 'paused' })
    // Versioned on disk, so a future schema change can migrate instead of guess.
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as { version: number }
    expect(onDisk.version).toBe(CONFIG_FILE_VERSION)
  })

  it('reports a corrupt file instead of throwing, so the node still starts', async () => {
    await writeFile(file, '{ this is not json', 'utf8')
    const read = await readConfigFile(file)
    expect(read.config).toBeUndefined()
    expect(read.error).toMatch(/not valid JSON/u)
  })

  it('ignores a document from a newer schema rather than half-reading it', async () => {
    await writeFile(file, JSON.stringify({ version: 99, coordinatorUrl: WS_URL, token: TOKEN }), 'utf8')
    const read = await readConfigFile(file)
    expect(read.config).toBeUndefined()
    expect(read.error).toMatch(/version 99/u)
  })

  it('ignores a document with no usable field', async () => {
    await writeFile(file, JSON.stringify({ version: CONFIG_FILE_VERSION, coordinatorUrl: 42 }), 'utf8')
    const read = await readConfigFile(file)
    expect(read.config).toBeUndefined()
    expect(read.error).toMatch(/no usable field/u)
  })
})

describe('writing the file', () => {
  it('replaces the document atomically, leaving no temporary behind', async () => {
    await writeConfigFile(file, { coordinatorUrl: WS_URL, token: 'first' })
    await writeConfigFile(file, { coordinatorUrl: WS_URL, token: 'second' })
    expect((await readConfigFile(file)).config?.token).toBe('second')
    await expect(readFile(`${file}.tmp`, 'utf8')).rejects.toThrow()
  })

  it('creates the parent directory, which may not exist on a first save', async () => {
    const nested = join(directory, 'storages', 'dsh-node', CONFIG_FILE_NAME)
    await writeConfigFile(nested, { coordinatorUrl: WS_URL, token: TOKEN })
    expect((await readConfigFile(nested)).config?.token).toBe(TOKEN)
  })

  it('drops fields it does not own, so a hand-edited document cannot inject one', async () => {
    await writeConfigFile(file, { coordinatorUrl: WS_URL, allowedRoots: ['/'] } as StoredNodeConfig)
    expect((await readConfigFile(file)).config).toEqual({ coordinatorUrl: WS_URL })
  })
})

describe('merging the stored layer over the profile', () => {
  it('puts the stored token under auth.token, where the resolver actually looks', () => {
    // The trap: `resolveNodeConfig` reads `auth.token`. A top-level `token` would be
    // silently ignored, and a saved credential would never reach the handshake.
    const merged = mergeNodeConfig({ coordinatorUrl: 'ws://profile.example/node' }, { token: TOKEN })
    expect(merged).toEqual({ coordinatorUrl: 'ws://profile.example/node', auth: { token: TOKEN } })
    expect(resolveNodeConfig(merged, {}).config.token).toBe(TOKEN)
  })

  it('wins per field over both the profile and the environment', () => {
    const merged = mergeNodeConfig(
      { coordinatorUrl: 'ws://profile.example/node', auth: { token: 'profile-token' }, mode: 'full-access' },
      { coordinatorUrl: WS_URL, token: TOKEN, nodeName: 'desk' },
    )
    const resolution = resolveNodeConfig(merged, { [TOKEN_ENV]: 'env-token' })
    expect(resolution.status).toBe('ok')
    expect(resolution.config.coordinatorUrl).toBe(WS_URL)
    expect(resolution.config.token).toBe(TOKEN)
    expect(resolution.config.nodeName).toBe('desk')
    // Untouched fields keep coming from the profile.
    expect(resolution.config.mode).toBe('full-access')
  })

  it('leaves the profile\'s token in place when the document has none', () => {
    const merged = mergeNodeConfig({ auth: { token: 'profile-token' } }, { coordinatorUrl: WS_URL })
    expect(resolveNodeConfig(merged, {}).config.token).toBe('profile-token')
  })

  it('returns the profile untouched when there is no document', () => {
    expect(mergeNodeConfig({ coordinatorUrl: WS_URL }, undefined)).toEqual({ coordinatorUrl: WS_URL })
    expect(mergeNodeConfig(undefined, { token: TOKEN })).toEqual({ auth: { token: TOKEN } })
  })

  it('does not feed the connection intent into runtime configuration', () => {
    expect(mergeNodeConfig({ coordinatorUrl: WS_URL }, { connectionIntent: 'paused' })).toEqual({ coordinatorUrl: WS_URL })
  })
})

describe('describeStoredConfig', () => {
  it('describes a document without ever carrying the token', () => {
    const described = JSON.stringify(describeStoredConfig({ coordinatorUrl: WS_URL, token: TOKEN }))
    expect(described).not.toContain(TOKEN)
    expect(described).toContain('"tokenSet":true')
    expect(describeStoredConfig(undefined)).toEqual({ present: false })
  })
})

describe('folding a submission into a document', () => {
  it('keeps a field the operator did not touch', () => {
    const next = foldSubmission({ coordinatorUrl: WS_URL, token: TOKEN }, { nodeName: 'desk' })
    expect(next).toEqual({ coordinatorUrl: WS_URL, token: TOKEN, nodeName: 'desk' })
  })

  it('treats an empty token box as "unchanged", which is what a browser submits', () => {
    const next = foldSubmission({ coordinatorUrl: WS_URL, token: TOKEN }, { token: '' })
    expect(next.token).toBe(TOKEN)
  })

  it('clears a field only when the clear is explicit', () => {
    const next = foldSubmission({ coordinatorUrl: WS_URL, token: TOKEN, role: 'build' }, { token: null, role: '' })
    expect(next.token).toBeUndefined()
    // Display metadata clears on an empty value; a credential must not.
    expect(next.role).toBeUndefined()
    expect(next.coordinatorUrl).toBe(WS_URL)
  })

  it('refuses a non-string, so a mistyped body cannot erase anything', () => {
    expect(() => readSubmission({ token: 42 }, 'token', false)).toThrow(HttpFailure)
    try {
      readSubmission({ token: 42 }, 'token', false)
    } catch (error) {
      expect((error as HttpFailure).status).toBe(400)
      expect((error as HttpFailure).failure.code).toBe('invalid-arguments')
    }
  })

  it('trims what it stores', () => {
    expect(foldSubmission(undefined, { coordinatorUrl: `  ${WS_URL}  ` }).coordinatorUrl).toBe(WS_URL)
  })
})

/** Build a service over a temporary file with an injectable environment. */
function service(options: {
  readonly stored?: StoredNodeConfig
  readonly profile?: unknown
  readonly env?: NodeJS.ProcessEnv
  readonly apply?: (stored: StoredNodeConfig) => Promise<void>
  readonly nodeId?: string
} = {}) {
  const applied: StoredNodeConfig[] = []
  const instance = new NodeConfigService({
    file,
    profileConfig: () => options.profile,
    // The panel shows the *effective* values, so the fake reports what the merged
    // resolution produced for the last apply — or the stored document before that.
    effective: () => {
      const last = applied.at(-1) ?? options.stored
      const resolution = resolveNodeConfig(mergeNodeConfig(options.profile, last), options.env ?? ENV)
      return resolution.config
    },
    nodeId: () => options.nodeId ?? 'node-abcdef0123456789',
    apply: async (stored) => {
      applied.push(stored)
      await options.apply?.(stored)
    },
    env: options.env ?? ENV,
    now: () => Date.parse('2026-09-20T12:00:00.000Z'),
  })
  if (options.stored !== undefined) instance.seed({ file, config: options.stored })
  return { instance, applied }
}

describe('the configuration service', () => {
  it('validates, persists, and applies a complete save', async () => {
    const { instance, applied } = service({ env: {} })
    const view = await instance.write({ coordinatorUrl: WS_URL, token: TOKEN, nodeName: 'desk' })
    expect(applied).toHaveLength(1)
    expect(applied[0]?.token).toBe(TOKEN)
    expect(view.coordinatorUrl).toBe(WS_URL)
    expect(view.tokenSet).toBe(true)
    expect(view.configFile).toBe(file)
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as { updatedAt?: string; token?: string }
    expect(onDisk.token).toBe(TOKEN)
    expect(onDisk.updatedAt).toBe('2026-09-20T12:00:00.000Z')
  })

  it('never returns the token, in the view or the log line', async () => {
    const warnings: Record<string, unknown>[] = []
    const instance = new NodeConfigService({
      file,
      profileConfig: () => undefined,
      effective: () => ({ coordinatorUrl: WS_URL, token: TOKEN }),
      nodeId: () => 'node-1',
      apply: async () => undefined,
      env: {},
      warn: (_message, details) => { warnings.push(details) },
    })
    const view = instance.read()
    expect(JSON.stringify(view)).not.toContain(TOKEN)
    expect(view.tokenSet).toBe(true)
    await instance.write({ coordinatorUrl: WS_URL, token: TOKEN })
    expect(JSON.stringify(warnings)).not.toContain(TOKEN)
    expect(warnings.at(-1)?.['tokenSet']).toBe(true)
  })

  it('refuses an incomplete save instead of taking a working node offline', async () => {
    const { instance, applied } = service({ env: {} })
    const failure = await instance.write({ coordinatorUrl: WS_URL }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(HttpFailure)
    expect((failure as HttpFailure).status).toBe(400)
    expect((failure as HttpFailure).failure.code).toBe('node/config-incomplete')
    expect((failure as HttpFailure).failure.details['missing']).toEqual(['token'])
    expect(applied).toHaveLength(0)
    // Nothing was written, so a retry starts from the same place.
    await expect(readFile(file, 'utf8')).rejects.toThrow()
  })

  it('names both missing fields when the panel was submitted empty', async () => {
    const { instance } = service({ env: {} })
    const failure = await instance.write({ coordinatorUrl: '  ', token: '  ' }).catch((error: unknown) => error)
    expect((failure as HttpFailure).failure.details['missing']).toEqual(['coordinatorUrl', 'token'])
  })

  it('refuses an http:// endpoint with the resolver\'s own reason', async () => {
    const { instance, applied } = service({ env: {} })
    const failure = await instance.write({ coordinatorUrl: 'http://127.0.0.1:39472/node', token: TOKEN })
      .catch((error: unknown) => error)
    expect((failure as HttpFailure).failure.code).toBe('node/config-invalid')
    expect((failure as HttpFailure).failure.message).toMatch(/ws:.*wss:/u)
    expect(applied).toHaveLength(0)
  })

  it('refuses a credential smuggled into the URL', async () => {
    const { instance } = service({ env: {} })
    const failure = await instance.write({ coordinatorUrl: `ws://127.0.0.1:39472/node?token=${TOKEN}`, token: TOKEN })
      .catch((error: unknown) => error)
    expect((failure as HttpFailure).failure.code).toBe('node/config-invalid')
    expect((failure as HttpFailure).failure.message).toMatch(/must not carry a credential/u)
  })

  it('replaces a stored token and reports the panel as the source', async () => {
    await writeConfigFile(file, { coordinatorUrl: WS_URL, token: 'old-token' })
    const { instance } = service({ stored: { coordinatorUrl: WS_URL, token: 'old-token' }, env: {} })
    const view = await instance.write({ token: 'new-token' })
    expect(view.tokenSet).toBe(true)
    expect(view.sources.token).toBe('panel')
    expect((await readConfigFile(file)).config?.token).toBe('new-token')
    // The address came from the file too, so the URL is unchanged and still reported.
    expect(view.coordinatorUrl).toBe(WS_URL)
  })

  it('clears a token on an explicit null and falls back to nothing', async () => {
    await writeConfigFile(file, { coordinatorUrl: WS_URL, token: TOKEN })
    const { instance } = service({ stored: { coordinatorUrl: WS_URL, token: TOKEN }, env: {} })
    const failure = await instance.write({ token: null }).catch((error: unknown) => error)
    // With no other layer holding a token, clearing it leaves the node incomplete and
    // that is refused — the file is not silently emptied.
    expect((failure as HttpFailure).failure.code).toBe('node/config-incomplete')
    expect((await readConfigFile(file)).config?.token).toBe(TOKEN)
  })

  it('clears a token when the environment still supplies one, and says where it came from', async () => {
    await writeConfigFile(file, { coordinatorUrl: WS_URL, token: 'panel-token' })
    const { instance } = service({ stored: { coordinatorUrl: WS_URL, token: 'panel-token' }, env: ENV })
    const view = await instance.write({ token: null })
    expect(view.tokenSet).toBe(true)
    expect(view.sources.token).toBe('environment')
    expect((await readConfigFile(file)).config?.token).toBeUndefined()
  })

  it('reports the profile and the environment as sources when the file is empty', async () => {
    const { instance } = service({ env: ENV, profile: { coordinatorUrl: 'ws://profile.example/node' } })
    const view = instance.read()
    expect(view.sources.coordinatorUrl).toBe('profile')
    expect(view.sources.token).toBe('environment')
    // Effective values, not the file's: the operator sees what the node is using.
    expect(view.coordinatorUrl).toBe('ws://profile.example/node')
    expect(view.tokenSet).toBe(true)
  })

  it('reports "none" when no layer supplies a field', () => {
    const { instance } = service({ env: {} })
    expect(instance.read().sources).toEqual({ coordinatorUrl: 'none', token: 'none' })
    expect(instance.read().tokenSet).toBe(false)
  })

  it('persists a manual disconnect without rebuilding the node', async () => {
    const { instance, applied } = service({ stored: { coordinatorUrl: WS_URL, token: TOKEN }, env: {} })
    expect(instance.read().connectionIntent).toBe('active')

    const paused = await instance.setConnectionIntent('paused')
    expect(paused.connectionIntent).toBe('paused')
    expect(applied).toHaveLength(0)
    expect((await readConfigFile(file)).config?.connectionIntent).toBe('paused')

    const active = await instance.setConnectionIntent('active')
    expect(active.connectionIntent).toBe('active')
    expect(applied).toHaveLength(0)
  })

  it('surfaces a boot read failure without blocking a save that fixes it', async () => {
    await writeFile(file, 'not json at all', 'utf8')
    const instance = new NodeConfigService({
      file,
      profileConfig: () => undefined,
      effective: () => ({}),
      nodeId: () => 'node-1',
      apply: async () => undefined,
      env: {},
    })
    instance.seed(await readConfigFile(file))
    expect(instance.read().configFileError).toMatch(/not valid JSON/u)
    await instance.write({ coordinatorUrl: WS_URL, token: TOKEN })
    expect(instance.read().configFileError).toBeUndefined()
  })

  it('reports a save that landed on disk but could not be applied', async () => {
    const { instance } = service({
      env: {},
      apply: async () => { throw new Error('identity file is unreadable') },
    })
    const failure = await instance.write({ coordinatorUrl: WS_URL, token: TOKEN }).catch((error: unknown) => error)
    expect((failure as HttpFailure).status).toBe(500)
    expect((failure as HttpFailure).failure.code).toBe('node/reconfigure-failed')
    // The truth the operator needs: the file is saved, so retyping is not required.
    expect((failure as HttpFailure).failure.details['saved']).toBe(true)
    expect((await readConfigFile(file)).config?.token).toBe(TOKEN)
  })

  it('serialises concurrent saves, so two reboots cannot interleave', async () => {
    let active = 0
    let peak = 0
    const { instance, applied } = service({
      env: {},
      apply: async () => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise(resolve => setTimeout(resolve, 5))
        active -= 1
      },
    })
    await Promise.all([
      instance.write({ coordinatorUrl: WS_URL, token: 'one' }),
      instance.write({ coordinatorUrl: WS_URL, token: 'two' }),
    ])
    expect(peak).toBe(1)
    expect(applied).toHaveLength(2)
    expect(applied.at(-1)?.token).toBe('two')
  })

  it('keeps working after a refused save', async () => {
    const { instance, applied } = service({ env: {} })
    await instance.write({ coordinatorUrl: 'nonsense' }).catch(() => undefined)
    await instance.write({ coordinatorUrl: WS_URL, token: TOKEN })
    expect(applied).toHaveLength(1)
  })

  it('reports a write failure as itself, and leaves no temporary credential behind', async () => {
    const { instance } = service({ env: {} })
    // A non-empty directory where the file belongs: the rename cannot succeed, which
    // is the realistic failure (a locked or read-only target).
    await mkdir(join(file, 'occupied'), { recursive: true })
    const failure = await instance.write({ coordinatorUrl: WS_URL, token: TOKEN }).catch((error: unknown) => error)
    expect((failure as HttpFailure).status).toBe(500)
    expect((failure as HttpFailure).failure.code).toBe('node/config-write-failed')
    // The whole reason the write goes through a temp file: a failed save must not
    // leave the credential sitting in `<file>.tmp`.
    await expect(readFile(`${file}.tmp`, 'utf8')).rejects.toThrow()
    // And the service did not pretend the save happened.
    expect(instance.read().tokenSet).toBe(false)
  })
})
