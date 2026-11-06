/**
 * The `sessionFiles` Remote owner and its registered surface.
 *
 * The owner is the Gateway-facing half: it must expose exactly the reviewed
 * methods, keep the binding the Gateway validates, and translate a malformed
 * argument set into the `files/*` vocabulary rather than a generic gateway
 * failure.
 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  FILES_DESCRIPTORS,
  SessionFilesOwner,
} from '../src/files/service.js'
import { SessionFileStore } from '../src/files/store.js'
import {
  FILES_NAMESPACE,
  FILES_SERVICE_KEY,
  MAX_FILE_BYTES,
  UPLOAD_CHUNK_BYTES,
} from '../src/files/types.js'

const SESSION = 'session-11111111-1111-4111-8111-111111111111'
const NODE = 'node-service-test'

let root: string
let workspace: string
let store: SessionFileStore
let owner: SessionFilesOwner
let deliveryAvailable: boolean

beforeEach(async () => {
  const tmp = join(process.cwd(), '.tmp')
  await mkdir(tmp, { recursive: true })
  root = await mkdtemp(join(tmp, 'files-service-'))
  workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  store = new SessionFileStore({
    root: join(root, 'files'),
    nodeId: () => NODE,
    sessionCwd: id => (id === SESSION ? workspace : undefined),
  })
  deliveryAvailable = true
  owner = new SessionFilesOwner({ store, deliveryToolAvailable: () => deliveryAvailable })
  await store.open()
})

afterEach(async () => {
  await store.close().catch(() => undefined)
  await rm(root, { recursive: true, force: true })
})

describe('registered surface', () => {
  it('exposes exactly the reviewed endpoints', () => {
    expect(FILES_DESCRIPTORS.map(descriptor => `${descriptor.namespace}/${descriptor.method}`)).toEqual([
      'sessionFiles/describe',
      'sessionFiles/beginUpload',
      'sessionFiles/writeChunk',
      'sessionFiles/commitUpload',
      'sessionFiles/abortUpload',
      'sessionFiles/resolveAttachments',
      'sessionFiles/listArtifacts',
      'sessionFiles/readArtifactChunk',
    ])
    for (const descriptor of FILES_DESCRIPTORS) {
      expect(descriptor.service).toBe(FILES_SERVICE_KEY)
      expect(descriptor.namespace).toBe(FILES_NAMESPACE)
      expect(descriptor.result).toEqual({ mode: 'src-json' })
      expect(descriptor.parameters.length).toBeGreaterThan(0)
    }
  })

  it('binds the Gateway marker to this very owner', () => {
    expect(owner.typertRemote.service).toBe(owner)
    expect(owner.typertRemote.namespace).toBe('sessionFiles')
    expect(owner.typertRemote.serviceKey).toBe('sessionFiles')
  })

  it('matches the shared contract fixture', async () => {
    const raw = await readFile(join(process.cwd(), 'test', 'fixtures', 'session-files-contract.json'), 'utf8')
    const fixture = JSON.parse(raw) as {
      protocolVersion: number
      limits: Record<string, number>
      responses: { describe: { limits: Record<string, number> } }
    }
    expect(fixture.protocolVersion).toBe(1)
    expect(owner.describe().limits).toEqual(fixture.responses.describe.limits)
    expect(owner.describe().limits).toEqual(fixture.limits)
  })
})

describe('describe', () => {
  it('reports the delivery tool state and the frozen limits', () => {
    expect(owner.describe()).toMatchObject({ protocolVersion: 1, deliveryTool: 'available' })
    expect(owner.describe().limits.maxFileBytes).toBe(MAX_FILE_BYTES)
    expect(owner.describe().limits.chunkBytes).toBe(UPLOAD_CHUNK_BYTES)
    deliveryAvailable = false
    expect(owner.describe(SESSION).deliveryTool).toBe('unavailable')
  })

  it('rejects an unusable session id', () => {
    expect(() => owner.describe('../escape')).toThrow(expect.objectContaining({ code: 'files/invalid-arguments' }))
  })
})

describe('transfer', () => {
  it('runs the full upload through the owner', async () => {
    const bytes = Buffer.from('owner-path-bytes')
    const begun = await owner.beginUpload(SESSION, '报告.pdf', bytes.byteLength, 'client-owner')
    expect(begun.chunkBytes).toBe(UPLOAD_CHUNK_BYTES)
    await owner.writeChunk(SESSION, begun.uploadId, 0, bytes.toString('base64'))
    const ref = await owner.commitUpload(SESSION, begun.uploadId, bytes.byteLength, createHash('sha256').update(bytes).digest('hex'))
    expect(ref.name).toBe('报告.pdf')
    const resolved = await owner.resolveAttachments(SESSION, [ref.attachmentId])
    expect(resolved.attachments[0]?.remotePath).toContain('attachments')
  })

  it('converts a malformed argument set into files/invalid-arguments', async () => {
    await expect(owner.beginUpload(SESSION, 'x', Number.NaN, 'c')).rejects.toMatchObject({ code: 'files/invalid-arguments' })
    await expect(owner.beginUpload(42, 'x', 1, 'c')).rejects.toMatchObject({ code: 'files/invalid-arguments' })
    await expect(owner.writeChunk(SESSION, 'missing', 0, 'aGk=')).rejects.toMatchObject({ code: 'files/not-found' })
    await expect(owner.resolveAttachments(SESSION, ['not-an-id'])).rejects.toMatchObject({ code: 'files/not-found' })
  })

  it('lists and reads deliverable artifacts', async () => {
    const source = join(workspace, 'out.txt')
    await writeFile(source, 'artifact-through-owner')
    const artifact = await store.publishArtifact({ sessionId: SESSION, path: source })
    const listed = await owner.listArtifacts(SESSION)
    expect(listed.artifacts[0]?.artifactId).toBe(artifact.artifactId)
    const chunk = await owner.readArtifactChunk(SESSION, artifact.artifactId, 0, 8)
    expect(Buffer.from(chunk.base64, 'base64').toString('utf8')).toBe('artifact')
    expect(chunk.totalSize).toBe(22)
  })
})
