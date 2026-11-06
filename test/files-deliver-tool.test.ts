/**
 * `deliver_file` — the Agent-facing delivery tool.
 *
 * What matters here is that the definition is registry-ready (the installed
 * host validates `name`/`output.schema`/`output.render`), that the session
 * identity comes from the execution context and never from arguments, and that
 * the tool refuses every path the store's policy refuses.
 */

import type { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDeliverToolDefinition,
  DELIVER_TOOL_NAME,
  readSessionId,
  registerDeliverTool,
  type ToolDefinitionLike,
  type ToolRegistryLike,
} from '../src/files/deliver-tool.js'
import { SessionFileStore } from '../src/files/store.js'

const SESSION = 'session-11111111-1111-4111-8111-111111111111'
const NODE = 'node-deliver-test'

let root: string
let workspace: string
let store: SessionFileStore

beforeEach(async () => {
  const tmp = join(process.cwd(), '.tmp')
  await mkdir(tmp, { recursive: true })
  root = await mkdtemp(join(tmp, 'files-deliver-'))
  workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  store = new SessionFileStore({
    root: join(root, 'files'),
    nodeId: () => NODE,
    sessionCwd: id => (id === SESSION ? workspace : undefined),
  })
  await store.open()
})

afterEach(async () => {
  await store.close().catch(() => undefined)
  await rm(root, { recursive: true, force: true })
})

function execFor(cwd: string): { agent: { id: string; session: { id: string; header: { cwd: string } } }; signal: AbortSignal } {
  return {
    agent: {
      id: SESSION,
      session: { id: SESSION, header: { cwd } },
    },
    signal: new AbortController().signal,
  }
}

describe('definition', () => {
  it('is registry-ready and declares exactly path and name', () => {
    const definition = createDeliverToolDefinition({ store })
    expect(definition.name).toBe(DELIVER_TOOL_NAME)
    expect(definition.parameters).toMatchObject({
      type: 'object',
      required: ['path'],
      additionalProperties: false,
    })
    expect(Object.keys(definition.parameters['properties'] as Record<string, unknown>)).toEqual(['path', 'name'])
    expect(definition.output.schema).toMatchObject({ type: 'object', required: expect.arrayContaining(['artifactId', 'sha256', 'state']) })
    expect(typeof definition.output.render).toBe('function')
  })

  it('states the delivery contract in the model-facing tool description', () => {
    const definition = createDeliverToolDefinition({ store })
    expect(definition.description).toContain('after this tool succeeds')
    expect(definition.description).toContain('present card')
    expect(definition.description).toContain('diff card')
    expect(definition.description).toContain('do not claim a download was created')
    expect(definition.description).toContain('absolute path')
  })

  it('renders the delivered artifact without a host path', () => {
    const definition = createDeliverToolDefinition({ store })
    const rendered = definition.output.render({}, {
      artifactId: 'a-1',
      nodeId: NODE,
      sessionId: SESSION,
      name: '结果.docx',
      size: 12,
      sha256: 'a'.repeat(64),
      createdAt: '2026-10-29T03:00:00.000Z',
      expiresAt: '2026-11-05T03:00:00.000Z',
      state: 'ready',
    }) as { type: string; text: string }[]
    expect(rendered[0]?.text).toContain('结果.docx')
    expect(rendered[0]?.text).not.toContain('C:')
  })
})

describe('registration', () => {
  it('registers into the live tools registry and disposes', () => {
    const dispose = vi.fn()
    const registry: ToolRegistryLike = { register: vi.fn(() => dispose) }
    const ctx = fakeContext({ tools: registry })
    const registered = registerDeliverTool(ctx, store)
    expect(registry.register).toHaveBeenCalledTimes(1)
    expect((registry.register as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({ name: 'deliver_file' })
    expect(registered).toBe(dispose)
  })

  it('does nothing when the profile has no tools registry', () => {
    expect(registerDeliverTool(fakeContext({}), store)).toBeUndefined()
  })
})

describe('execution', () => {
  it('publishes a regular file and returns the reference', async () => {
    const source = join(workspace, '报告 最终版.docx')
    await writeFile(source, 'final-document')
    const definition = createDeliverToolDefinition({ store })
    const value = await definition.execute({ path: source }, execFor(workspace)) as Record<string, unknown>
    expect(value['sessionId']).toBe(SESSION)
    expect(value['name']).toBe('报告 最终版.docx')
    expect(value['size']).toBe(14)
    expect(value['state']).toBe('ready')
    expect(value['remotePath']).toBeUndefined()
    expect((await store.listArtifacts(SESSION)).artifacts).toHaveLength(1)
  })

  it('ignores a session id supplied in the arguments', async () => {
    const source = join(workspace, 'x.txt')
    await writeFile(source, 'x')
    const definition = createDeliverToolDefinition({ store })
    const value = await definition.execute({ path: source, sessionId: 'session-forged' }, execFor(workspace)) as Record<string, unknown>
    expect(value['sessionId']).toBe(SESSION)
  })

  it('uses the working-directory service when the header has no cwd', async () => {
    const source = join(workspace, 'no-header.txt')
    await writeFile(source, 'no header')
    const definition = createDeliverToolDefinition({
      store,
      workingDirectory: { ensure: async () => workspace },
    })
    const value = await definition.execute({ path: source }, {
      agent: { id: SESSION, session: { id: SESSION } },
    }) as Record<string, unknown>
    expect(value['name']).toBe('no-header.txt')
  })

  it('refuses a call with no session identity', async () => {
    const source = join(workspace, 'unowned.txt')
    await writeFile(source, 'unowned')
    const definition = createDeliverToolDefinition({ store })
    await expect(definition.execute({ path: source }, {})).rejects.toMatchObject({ code: 'files/forbidden' })
    expect(readSessionId({ agent: { id: 'agent-only' } })).toBe('agent-only')
  })

  it('refuses a directory, an outside file and a linked-directory escape', async () => {
    const definition = createDeliverToolDefinition({ store })
    await expect(definition.execute({ path: workspace }, execFor(workspace))).rejects.toMatchObject({ code: 'files/forbidden' })

    const outside = join(root, 'outside')
    await mkdir(outside, { recursive: true })
    const outsideFile = join(outside, 'secret.txt')
    await writeFile(outsideFile, 'secret')
    await expect(definition.execute({ path: outsideFile }, execFor(workspace))).rejects.toMatchObject({ code: 'files/forbidden' })

    const junction = join(workspace, 'linked')
    await symlink(outside, junction, 'junction').catch(() => undefined)
    try {
      await writeFile(join(junction, 'through-link.txt'), 'through link')
      await expect(definition.execute({ path: join(junction, 'through-link.txt') }, execFor(workspace)))
        .rejects.toMatchObject({ code: 'files/forbidden' })
    } catch (error) {
      // Creating a junction needs no privilege on Windows; a platform that
      // refuses it still covers the realpath rule through `decidePath`.
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
    }
  })

  it('requires a non-empty path', async () => {
    const definition = createDeliverToolDefinition({ store })
    await expect(definition.execute({}, execFor(workspace))).rejects.toMatchObject({ code: 'files/invalid-arguments' })
  })
})

/** A minimal host context exposing only the services a test supplies. */
function fakeContext(services: Record<string, unknown>): Context {
  return {
    get: (key: string) => services[key],
  } as unknown as Context
}

/** Keep the definition type imported for readers of this file. */
export type { ToolDefinitionLike }
