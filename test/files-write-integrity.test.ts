import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionFileStore } from '../src/files/store.js'

const fault = vi.hoisted(() => ({ mode: 'short' as 'short' | 'zero' | 'error' | 'none', calls: 0 }))
vi.mock('node:fs/promises', async importActual => {
  const actual = await importActual<typeof import('node:fs/promises')>()
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args)
    if (args[1] === 'wx+' || (args[1] === 'wx' && String(args[0]).includes('.tmp-'))) {
      const write = handle.write.bind(handle)
      handle.write = (async (buffer: Buffer, offset = 0, length = buffer.length, position: number | null = null) => {
        fault.calls++
        if (fault.mode === 'zero') return { bytesWritten: 0, buffer }
        if (fault.mode === 'error' && fault.calls > 1) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
        return write(buffer, offset, fault.mode === 'none' ? length : Math.min(length, 2), position)
      }) as typeof handle.write
    }
    return handle
  } }
})
let root: string | undefined
let store: SessionFileStore | undefined
const sessionId = 'session-write-integrity'
const bytes = Buffer.from('abcdefghij')
const sha256 = createHash('sha256').update(bytes).digest('hex')
async function setup(limit = 100) {
  await mkdir('.tmp', { recursive: true })
  root = await mkdtemp(join(resolve('.tmp'), 'write-integrity-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  store = new SessionFileStore({ root: join(root, 'files'), nodeId: () => 'node-test', sessionCwd: () => workspace, limits: { storageLimitBytes: limit } })
  await store.open()
  return { store, workspace }
}
afterEach(async () => {
  await store?.close()
  if (root && resolve(root).startsWith(resolve('.tmp') + sep)) await rm(root, { recursive: true, force: true })
  fault.mode = 'short'
  fault.calls = 0
})
it('finishes short writes before committing the original upload', async () => {
  const { store } = await setup()
  const { uploadId } = await store.beginUpload({ sessionId, name: 'a', size: bytes.length, clientUploadId: 'one' })
  await store.writeChunk({ sessionId, uploadId, offset: 0, base64: bytes.toString('base64') })
  const ref = await store.commitUpload({ sessionId, uploadId, size: bytes.length, sha256 })
  expect(await readFile(ref.remotePath)).toEqual(bytes)
})
it('finishes short writes when creating an artifact snapshot', async () => {
  const { store, workspace } = await setup()
  const source = join(workspace, 'report.txt')
  await writeFile(source, bytes)
  const ref = await store.publishArtifact({ sessionId, path: source })
  const result = await store.readArtifactChunk({ sessionId, artifactId: ref.artifactId, offset: 0, length: bytes.length })
  expect(Buffer.from(result.base64, 'base64')).toEqual(bytes)
})
it('rejects zero-progress disk writes without exposing an attachment', async () => {
  const { store } = await setup()
  fault.mode = 'zero'
  const { uploadId } = await store.beginUpload({ sessionId, name: 'a', size: bytes.length, clientUploadId: 'one' })
  await expect(store.writeChunk({ sessionId, uploadId, offset: 0, base64: bytes.toString('base64') })).rejects.toMatchObject({ code: 'files/io-error' })
  expect(store.usedBytes).toBe(0)
})
it('discards a partially written chunk when the disk fails mid-write', async () => {
  const { store } = await setup()
  fault.mode = 'error'
  const { uploadId } = await store.beginUpload({ sessionId, name: 'a', size: bytes.length, clientUploadId: 'one' })
  await expect(store.writeChunk({ sessionId, uploadId, offset: 0, base64: bytes.toString('base64') })).rejects.toMatchObject({ code: 'files/io-error' })
  expect(store.activeUploads).toBe(0)
  expect(store.usedBytes).toBe(0)
})
it('accepts a duplicate chunk even when storage is full', async () => {
  const { store } = await setup(bytes.length)
  fault.mode = 'none'
  const { uploadId } = await store.beginUpload({ sessionId, name: 'a', size: bytes.length, clientUploadId: 'one' })
  const chunk = { sessionId, uploadId, offset: 0, base64: bytes.toString('base64') }
  const first = await store.writeChunk(chunk)
  await expect(store.writeChunk(chunk)).resolves.toEqual(first)
  expect(store.usedBytes).toBe(bytes.length)
  await expect(store.writeChunk({ ...chunk, base64: Buffer.alloc(bytes.length).toString('base64') })).rejects.toMatchObject({ code: 'files/offset-conflict' })
})