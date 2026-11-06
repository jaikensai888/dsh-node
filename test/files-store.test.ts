/**
 * Session file storage and transfer.
 *
 * The tests are built around the failure rules rather than the happy path: a
 * half upload must never become an attachment, a retried chunk must be a no-op,
 * a session must not read another session's file, and a restart must not turn an
 * orphaned `.part` into something downloadable.
 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionFileStore, sessionKeyOf } from '../src/files/store.js'
import {
  FILES_PROTOCOL_VERSION,
  MAX_FILE_BYTES,
  UPLOAD_CHUNK_BYTES,
  type AttachmentRef,
} from '../src/files/types.js'

const SESSION = 'session-11111111-1111-4111-8111-111111111111'
const OTHER = 'session-22222222-2222-4222-8222-222222222222'
const NODE = 'node-files-test'

let root: string
let workspace: string
let store: SessionFileStore
let clock: number

beforeEach(async () => {
  const tmp = join(process.cwd(), '.tmp')
  await mkdir(tmp, { recursive: true })
  root = await mkdtemp(join(tmp, 'files-store-'))
  workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  clock = Date.parse('2026-10-29T03:00:00.000Z')
  store = new SessionFileStore({
    root: join(root, 'files'),
    nodeId: () => NODE,
    sessionCwd: id => (id === SESSION ? workspace : undefined),
    now: () => clock,
  })
  await store.open()
})

afterEach(async () => {
  await store.close().catch(() => undefined)
  await rm(root, { recursive: true, force: true })
})

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Drive a complete upload through the public store API. */
async function upload(
  target: SessionFileStore,
  sessionId: string,
  name: string,
  bytes: Buffer,
  chunkBytes = 7,
): Promise<AttachmentRef> {
  const begun = await target.beginUpload({
    sessionId,
    name,
    size: bytes.byteLength,
    clientUploadId: `client-${name}-${String(bytes.byteLength)}`,
  })
  for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
    await target.writeChunk({
      sessionId,
      uploadId: begun.uploadId,
      offset,
      base64: bytes.subarray(offset, offset + chunkBytes).toString('base64'),
    })
  }
  return target.commitUpload({
    sessionId,
    uploadId: begun.uploadId,
    size: bytes.byteLength,
    sha256: sha256(bytes),
  })
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10, 0x7f])
const ZIP_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01, 0x02])
const DOCX_BYTES = Buffer.from('UEsDBBQABgAIAAAAIQBiYWdpIHdvcmxk', 'base64')

describe('attachment lifecycle', () => {
  it('round-trips PNG, ZIP and DOCX bytes exactly', async () => {
    for (const [name, bytes] of [
      ['image.png', PNG_BYTES],
      ['bundle.zip', ZIP_BYTES],
      ['report.docx', DOCX_BYTES],
    ] as const) {
      const ref = await upload(store, SESSION, name, bytes)
      expect(ref.name).toBe(name)
      expect(ref.size).toBe(bytes.byteLength)
      expect(ref.sha256).toBe(sha256(bytes))
      expect(ref.nodeId).toBe(NODE)
      expect(ref.sessionId).toBe(SESSION)
      expect(ref.remotePath).toContain('attachments')
      expect(Buffer.compare(await readFile(ref.remotePath), bytes)).toBe(0)
    }
  })

  it('accepts a zero-byte file', async () => {
    const empty = Buffer.alloc(0)
    const ref = await upload(store, SESSION, 'empty.txt', empty)
    expect(ref.size).toBe(0)
    expect(ref.sha256).toBe(sha256(empty))
    const resolved = await store.resolveAttachments({ sessionId: SESSION, attachmentIds: [ref.attachmentId] })
    expect(resolved.attachments).toHaveLength(1)
  })

  it('accepts exactly 20 MiB and refuses one byte more', async () => {
    const big = Buffer.alloc(MAX_FILE_BYTES, 0x5a)
    const ref = await upload(store, SESSION, 'big.bin', big, UPLOAD_CHUNK_BYTES)
    expect(ref.size).toBe(MAX_FILE_BYTES)
    expect((await store.resolveAttachments({ sessionId: SESSION, attachmentIds: [ref.attachmentId] })).attachments[0]?.sha256)
      .toBe(sha256(big))

    await expect(store.beginUpload({
      sessionId: SESSION,
      name: 'too-big.bin',
      size: MAX_FILE_BYTES + 1,
      clientUploadId: 'too-big',
    })).rejects.toMatchObject({ code: 'files/too-large' })
  })

  it('does not commit when the declared sha256 does not match', async () => {
    const bytes = Buffer.from('hello world!!')
    const begun = await store.beginUpload({ sessionId: SESSION, name: 'x.txt', size: bytes.byteLength, clientUploadId: 'c1' })
    await store.writeChunk({ sessionId: SESSION, uploadId: begun.uploadId, offset: 0, base64: bytes.toString('base64') })
    await expect(store.commitUpload({
      sessionId: SESSION,
      uploadId: begun.uploadId,
      size: bytes.byteLength,
      sha256: '0'.repeat(64),
    })).rejects.toMatchObject({ code: 'files/hash-mismatch' })
    expect(await store.listArtifacts(SESSION)).toEqual({ artifacts: [] })
    // A mismatched commit leaves the upload open, so a corrected retry can win.
    const ref = await store.commitUpload({
      sessionId: SESSION,
      uploadId: begun.uploadId,
      size: bytes.byteLength,
      sha256: sha256(bytes),
    })
    expect(ref.size).toBe(bytes.byteLength)
  })

  it('treats a repeated chunk at the same offset as a no-op', async () => {
    const bytes = Buffer.from('0123456789abcdef')
    const begun = await store.beginUpload({ sessionId: SESSION, name: 'a.txt', size: bytes.byteLength, clientUploadId: 'c2' })
    const first = bytes.subarray(0, 8)
    const second = bytes.subarray(8)
    expect(await store.writeChunk({ sessionId: SESSION, uploadId: begun.uploadId, offset: 0, base64: first.toString('base64') }))
      .toEqual({ nextOffset: 8, received: 8 })
    expect(await store.writeChunk({ sessionId: SESSION, uploadId: begun.uploadId, offset: 0, base64: first.toString('base64') }))
      .toEqual({ nextOffset: 8, received: 8 })
    await store.writeChunk({ sessionId: SESSION, uploadId: begun.uploadId, offset: 8, base64: second.toString('base64') })
    const ref = await store.commitUpload({
      sessionId: SESSION,
      uploadId: begun.uploadId,
      size: bytes.byteLength,
      sha256: sha256(bytes),
    })
    expect(Buffer.compare(await readFile(ref.remotePath), bytes)).toBe(0)
  })

  it('refuses a different retried chunk and a skipped offset', async () => {
    const bytes = Buffer.from('0123456789abcdef')
    const begun = await store.beginUpload({ sessionId: SESSION, name: 'b.txt', size: bytes.byteLength, clientUploadId: 'c3' })
    await store.writeChunk({ sessionId: SESSION, uploadId: begun.uploadId, offset: 0, base64: bytes.subarray(0, 8).toString('base64') })
    await expect(store.writeChunk({
      sessionId: SESSION,
      uploadId: begun.uploadId,
      offset: 0,
      base64: Buffer.from('XXXXXXXX').toString('base64'),
    })).rejects.toMatchObject({ code: 'files/offset-conflict' })
    await expect(store.writeChunk({
      sessionId: SESSION,
      uploadId: begun.uploadId,
      offset: 12,
      base64: bytes.subarray(12).toString('base64'),
    })).rejects.toMatchObject({ code: 'files/offset-conflict' })
  })

  it('rejects invalid base64 and an oversized chunk', async () => {
    const bytes = Buffer.from('hello')
    const begun = await store.beginUpload({ sessionId: SESSION, name: 'c.txt', size: bytes.byteLength, clientUploadId: 'c4' })
    await expect(store.writeChunk({ sessionId: SESSION, uploadId: begun.uploadId, offset: 0, base64: '!!!!' }))
      .rejects.toMatchObject({ code: 'files/invalid-arguments' })
    const oversized = Buffer.alloc(UPLOAD_CHUNK_BYTES + 1, 1).toString('base64')
    await expect(store.writeChunk({ sessionId: SESSION, uploadId: begun.uploadId, offset: 0, base64: oversized }))
      .rejects.toMatchObject({ code: 'files/too-large' })
  })

  it('keeps two same-named Chinese files apart and never overwrites', async () => {
    const first = await upload(store, SESSION, '季度报告.docx', Buffer.from('first'))
    const second = await upload(store, SESSION, '季度报告.docx', Buffer.from('second'))
    expect(first.attachmentId).not.toBe(second.attachmentId)
    expect(first.remotePath).not.toBe(second.remotePath)
    expect(await readFile(first.remotePath, 'utf8')).toBe('first')
    expect(await readFile(second.remotePath, 'utf8')).toBe('second')
  })

  it('returns the original reference when a commit is retried', async () => {
    const bytes = Buffer.from('retry')
    const begun = await store.beginUpload({ sessionId: SESSION, name: 'r.txt', size: bytes.byteLength, clientUploadId: 'c5' })
    await store.writeChunk({ sessionId: SESSION, uploadId: begun.uploadId, offset: 0, base64: bytes.toString('base64') })
    const first = await store.commitUpload({ sessionId: SESSION, uploadId: begun.uploadId, size: bytes.byteLength, sha256: sha256(bytes) })
    const second = await store.commitUpload({ sessionId: SESSION, uploadId: begun.uploadId, size: bytes.byteLength, sha256: sha256(bytes) })
    expect(second).toEqual(first)
    await expect(store.commitUpload({
      sessionId: SESSION,
      uploadId: begun.uploadId,
      size: bytes.byteLength,
      sha256: '1'.repeat(64),
    })).rejects.toMatchObject({ code: 'files/offset-conflict' })
  })

  it('deduplicates beginUpload by clientUploadId within a session', async () => {
    const first = await store.beginUpload({ sessionId: SESSION, name: 'd.txt', size: 3, clientUploadId: 'same' })
    const second = await store.beginUpload({ sessionId: SESSION, name: 'd.txt', size: 3, clientUploadId: 'same' })
    expect(second.uploadId).toBe(first.uploadId)
    await expect(store.beginUpload({ sessionId: OTHER, name: 'd.txt', size: 3, clientUploadId: 'same' }))
      .resolves.toMatchObject({ received: 0 })
  })

  it('does not expose another session\'s attachment', async () => {
    const ref = await upload(store, SESSION, 'secret.txt', Buffer.from('secret'))
    await expect(store.resolveAttachments({ sessionId: OTHER, attachmentIds: [ref.attachmentId] }))
      .rejects.toMatchObject({ code: 'files/not-found' })
    await expect(store.readArtifactChunk({ sessionId: OTHER, artifactId: ref.attachmentId, offset: 0, length: 1 }))
      .rejects.toMatchObject({ code: 'files/not-found' })
  })

  it('enforces the active-upload ceiling and the byte quota', async () => {
    const quotaStore = new SessionFileStore({
      root: join(root, 'quota'),
      nodeId: () => NODE,
      sessionCwd: () => workspace,
      now: () => clock,
      limits: { storageLimitBytes: 8, maxActiveUploads: 2 },
    })
    await quotaStore.open()
    const a = await quotaStore.beginUpload({ sessionId: SESSION, name: 'a', size: 4, clientUploadId: 'a' })
    await quotaStore.beginUpload({ sessionId: SESSION, name: 'b', size: 4, clientUploadId: 'b' })
    await expect(quotaStore.beginUpload({ sessionId: SESSION, name: 'c', size: 1, clientUploadId: 'c' }))
      .rejects.toMatchObject({ code: 'files/quota-exceeded' })
    await expect(quotaStore.beginUpload({ sessionId: OTHER, name: 'd', size: 9, clientUploadId: 'd' }))
      .rejects.toMatchObject({ code: 'files/quota-exceeded' })
    await quotaStore.abortUpload({ sessionId: SESSION, uploadId: a.uploadId })
    await quotaStore.close()
  })

  it('reports an I/O failure instead of producing a ready attachment', async () => {
    const blocked = join(root, 'blocked-root')
    await writeFile(blocked, 'not a directory')
    const failing = new SessionFileStore({ root: blocked, nodeId: () => NODE, now: () => clock })
    await expect(failing.beginUpload({ sessionId: SESSION, name: 'x', size: 1, clientUploadId: 'x' }))
      .rejects.toMatchObject({ code: 'files/io-error' })
    expect(failing.usedBytes).toBe(0)
  })
})

describe('retention and restart', () => {
  it('expires bytes but keeps the metadata row', async () => {
    const short = new SessionFileStore({
      root: join(root, 'retention'),
      nodeId: () => NODE,
      sessionCwd: () => workspace,
      now: () => clock,
      limits: { retentionMs: 1_000 },
    })
    await short.open()
    const source = join(workspace, 'expire.txt')
    await writeFile(source, 'expire me')
    const ref = await short.publishArtifact({ sessionId: SESSION, path: source })
    clock += 2_000
    const listed = await short.listArtifacts(SESSION)
    expect(listed.artifacts).toHaveLength(1)
    expect(listed.artifacts[0]).toMatchObject({ artifactId: ref.artifactId, state: 'expired' })
    await expect(short.readArtifactChunk({ sessionId: SESSION, artifactId: ref.artifactId, offset: 0, length: 1 }))
      .rejects.toMatchObject({ code: 'files/expired' })
    const sessionDir = join(root, 'retention', sessionKeyOf(SESSION))
    await expect(stat(join(sessionDir, 'artifacts', ref.artifactId))).rejects.toMatchObject({ code: 'ENOENT' })
    await short.close()
  })

  it('reloads committed attachments and artifacts after a restart', async () => {
    const first = await upload(store, SESSION, '持久.txt', Buffer.from('persist'))
    await writeFile(join(workspace, 'out.md'), '# delivered\n')
    const artifact = await store.publishArtifact({ sessionId: SESSION, path: join(workspace, 'out.md') })
    await store.close()

    const reopened = new SessionFileStore({
      root: join(root, 'files'),
      nodeId: () => NODE,
      sessionCwd: () => workspace,
      now: () => clock,
    })
    await reopened.open()
    expect((await reopened.resolveAttachments({ sessionId: SESSION, attachmentIds: [first.attachmentId] })).attachments[0]?.name)
      .toBe('持久.txt')
    expect((await reopened.listArtifacts(SESSION)).artifacts[0]?.artifactId).toBe(artifact.artifactId)
    await reopened.close()
  })

  it('drops incomplete uploads on restart and reclaims idle ones', async () => {
    const begun = await store.beginUpload({ sessionId: SESSION, name: 'partial', size: 10, clientUploadId: 'p' })
    await store.writeChunk({ sessionId: SESSION, uploadId: begun.uploadId, offset: 0, base64: Buffer.from('12345').toString('base64') })
    await store.close()

    const reopened = new SessionFileStore({
      root: join(root, 'files'),
      nodeId: () => NODE,
      sessionCwd: () => workspace,
      now: () => clock + 2 * 60 * 60 * 1000,
    })
    await reopened.open()
    expect(reopened.usedBytes).toBe(0)
    await expect(reopened.resolveAttachments({ sessionId: SESSION, attachmentIds: ['missing'] }))
      .rejects.toMatchObject({ code: 'files/not-found' })
    const report = await reopened.cleanup()
    expect(report.uploads).toBe(0)
    await reopened.close()
  })

  it('reclaims a final file whose metadata write never landed', async () => {
    const source = join(workspace, 'orphan.txt')
    await writeFile(source, 'orphan')
    const artifact = await store.publishArtifact({ sessionId: SESSION, path: source })
    await store.close()
    const sessionDir = join(root, 'files', sessionKeyOf(SESSION))
    await rm(join(sessionDir, 'manifests', 'artifacts', `${artifact.artifactId}.json`))

    const reopened = new SessionFileStore({
      root: join(root, 'files'),
      nodeId: () => NODE,
      sessionCwd: () => workspace,
      now: () => clock,
    })
    await reopened.open()
    expect((await reopened.listArtifacts(SESSION)).artifacts).toEqual([])
    await expect(stat(join(sessionDir, 'artifacts', artifact.artifactId))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(reopened.usedBytes).toBe(0)
    await reopened.close()
  })

  it('reclaims an idle incomplete upload through cleanup', async () => {
    await store.beginUpload({ sessionId: SESSION, name: 'idle', size: 10, clientUploadId: 'idle' })
    clock += 2 * 60 * 60 * 1000
    const report = await store.cleanup()
    expect(report.uploads).toBe(1)
    expect(store.activeUploads).toBe(0)
    expect(store.usedBytes).toBe(0)
  })
})

describe('artifact snapshots', () => {
  it('snapshots a file and keeps the bytes after the source changes or disappears', async () => {
    const source = join(workspace, '结果 文档.docx')
    await writeFile(source, 'original-document')
    const artifact = await store.publishArtifact({ sessionId: SESSION, path: source })
    expect(artifact).toMatchObject({ name: '结果 文档.docx', size: 17, state: 'ready' })

    await writeFile(source, 'changed-after-delivery')
    expect((await store.listArtifacts(SESSION)).artifacts[0]?.sha256).toBe(artifact.sha256)
    const chunk = await store.readArtifactChunk({ sessionId: SESSION, artifactId: artifact.artifactId, offset: 0, length: 64 })
    expect(Buffer.from(chunk.base64, 'base64').toString('utf8')).toBe('original-document')

    await rm(source)
    const stillThere = await store.readArtifactChunk({ sessionId: SESSION, artifactId: artifact.artifactId, offset: 0, length: 64 })
    expect(stillThere.totalSize).toBe(17)
  })

  it('reads bounded chunks with the documented offsets', async () => {
    const source = join(workspace, 'chunks.txt')
    await writeFile(source, 'abcdefghij')
    const artifact = await store.publishArtifact({ sessionId: SESSION, path: source })
    const first = await store.readArtifactChunk({ sessionId: SESSION, artifactId: artifact.artifactId, offset: 0, length: 4 })
    expect(Buffer.from(first.base64, 'base64').toString('utf8')).toBe('abcd')
    expect(first.nextOffset).toBe(4)
    const second = await store.readArtifactChunk({ sessionId: SESSION, artifactId: artifact.artifactId, offset: first.nextOffset, length: 100 })
    expect(Buffer.from(second.base64, 'base64').toString('utf8')).toBe('efghij')
    expect(second.nextOffset).toBe(10)
    expect(second.totalSize).toBe(10)
    await expect(store.readArtifactChunk({ sessionId: SESSION, artifactId: artifact.artifactId, offset: 0, length: 0 }))
      .rejects.toMatchObject({ code: 'files/invalid-arguments' })
  })

  it('refuses a directory, a link and a path outside the workspace', async () => {
    await expect(store.publishArtifact({ sessionId: SESSION, path: workspace }))
      .rejects.toMatchObject({ code: 'files/forbidden' })

    const outsideDir = join(root, 'outside')
    await mkdir(outsideDir, { recursive: true })
    const outsideFile = join(outsideDir, 'outside.txt')
    await writeFile(outsideFile, 'outside')
    await expect(store.publishArtifact({ sessionId: SESSION, path: outsideFile }))
      .rejects.toMatchObject({ code: 'files/forbidden' })

    const link = join(workspace, 'link.txt')
    await symlink(outsideFile, link, 'file').catch(() => undefined)
    try {
      const info = await stat(link)
      if (info.isFile()) {
        await expect(store.publishArtifact({ sessionId: SESSION, path: link }))
          .rejects.toMatchObject({ code: 'files/forbidden' })
      }
    } catch {
      // Symlink creation is privilege-dependent on Windows; the junction test
      // below still covers a linked directory, and `decidePath` is unit-tested
      // in admin.test.ts.
    }
  })

  it('refuses to deliver when the session has no working directory', async () => {
    const source = join(workspace, 'x.txt')
    await writeFile(source, 'x')
    await expect(store.publishArtifact({ sessionId: OTHER, path: source }))
      .rejects.toMatchObject({ code: 'files/forbidden' })
  })

  it('keeps artifact names unique and Chinese names intact', async () => {
    const one = join(workspace, '一.txt')
    const two = join(workspace, '二.txt')
    await writeFile(one, '1')
    await writeFile(two, '2')
    const first = await store.publishArtifact({ sessionId: SESSION, path: one, name: '同名报告.docx' })
    const second = await store.publishArtifact({ sessionId: SESSION, path: two, name: '同名报告.docx' })
    expect(first.artifactId).not.toBe(second.artifactId)
    expect(first.name).toBe('同名报告.docx')
    expect((await store.listArtifacts(SESSION)).artifacts.map(row => row.name)).toEqual(['同名报告.docx', '同名报告.docx'])
  })

  it('marks a vanished snapshot as missing', async () => {
    const source = join(workspace, 'gone.txt')
    await writeFile(source, 'gone')
    const artifact = await store.publishArtifact({ sessionId: SESSION, path: source })
    const sessionDir = join(root, 'files', sessionKeyOf(SESSION))
    await rm(join(sessionDir, 'artifacts', artifact.artifactId))
    const listed = await store.listArtifacts(SESSION)
    expect(listed.artifacts[0]?.state).toBe('missing')
    await expect(store.readArtifactChunk({ sessionId: SESSION, artifactId: artifact.artifactId, offset: 0, length: 1 }))
      .rejects.toMatchObject({ code: 'files/not-found' })
  })
})

describe('descriptor contract', () => {
  it('reports the frozen protocol version and limits', () => {
    const describe = store.describe('available')
    expect(describe.protocolVersion).toBe(FILES_PROTOCOL_VERSION)
    expect(describe.deliveryTool).toBe('available')
    expect(describe.limits.chunkBytes).toBe(UPLOAD_CHUNK_BYTES)
  })
})
