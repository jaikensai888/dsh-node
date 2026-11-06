/**
 * Durable session-scoped storage for uploaded files and delivered artifacts.
 *
 * ## Layout
 *
 * ```text
 * <DSH_HOME>/dsh-node/files/
 *   <sha256(sessionId)>/
 *     incoming/<uploadId>.part
 *     attachments/<attachmentId>
 *     artifacts/<artifactId>
 *     manifests/uploads/<uploadId>.json      (never retained across a restart)
 *     manifests/attachments/<attachmentId>.json
 *     manifests/artifacts/<artifactId>.json
 * ```
 *
 * The session id is **hashed** before it becomes a directory name. A remote
 * caller cannot choose a path, and the manifest still records the original id
 * so a lookup is `(nodeId, sessionId, id)` rather than "the id exists
 * somewhere".
 *
 * ## Invariants
 *
 * 1. A file is only ever named by a server-generated UUID; the client's name is
 *    display metadata.
 * 2. A half-written upload is never visible as an attachment: bytes land in
 *    `incoming/`, are fsynced, then renamed into `attachments/` after the size
 *    and SHA-256 have been verified.
 * 3. An artifact is a **read-only snapshot**. The source file's identity
 *    (dev/ino/size/mtime) is checked around the copy, and the recorded hash is
 *    the hash of the bytes actually copied.
 * 4. Expiry deletes bytes and keeps metadata, so the UI can say "expired"
 *    instead of silently forgetting the row.
 * 5. Every mutating operation runs through one promise chain. Node's event loop
 *    interleaves awaits, and an offset check that races a write would let a
 *    retried chunk corrupt a file even though each individual check passed.
 *
 * @module dsh-node/files/store
 */

import { createHash, randomUUID } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { decidePath } from '../admin/path-policy.js'
import {
  ARTIFACT_CHUNK_BYTES,
  FILE_LIMITS,
  MAX_FILE_BYTES,
  UPLOAD_CHUNK_BYTES,
  decodeBase64,
  displayName,
  fileError,
  isSessionId,
  requireCount,
  requireSha256,
  requireString,
  type AbortUploadResult,
  type ArtifactRef,
  type AttachmentRef,
  type BeginUploadResult,
  type FileLimits,
  type FilesDescribe,
  type ListArtifactsResult,
  type ReadArtifactChunkResult,
  type ResolveAttachmentsResult,
  type WriteChunkResult,
} from './types.js'

/** Directories created under the store root. */
const KIND_DIRS = ['incoming', 'attachments', 'artifacts'] as const

/** Artifact state, as persisted in a manifest. */
type StoredArtifactState = 'ready' | 'expired' | 'missing'

/** One attachment manifest on disk. */
interface AttachmentManifest {
  readonly kind: 'attachment'
  readonly attachmentId: string
  readonly nodeId: string
  readonly sessionId: string
  readonly name: string
  readonly size: number
  readonly sha256: string
  readonly createdAt: string
  readonly expiresAt: string
  readonly state: 'ready' | 'expired' | 'missing'
}

/** One artifact manifest on disk. */
interface ArtifactManifest {
  readonly kind: 'artifact'
  readonly artifactId: string
  readonly nodeId: string
  readonly sessionId: string
  readonly name: string
  readonly size: number
  readonly sha256: string
  readonly createdAt: string
  readonly expiresAt: string
  readonly state: StoredArtifactState
}

/** An upload that has been opened (and maybe committed) in this process. */
interface UploadRecord {
  readonly uploadId: string
  readonly clientUploadId: string
  readonly sessionId: string
  readonly sessionKey: string
  readonly name: string
  readonly size: number
  readonly createdAt: number
  lastAt: number
  readonly partPath: string
  handle: FileHandle | undefined
  readonly hash: ReturnType<typeof createHash>
  written: number
  committed: boolean
  ref: AttachmentRef | undefined
}

/** Construction options for {@link SessionFileStore}. */
export interface SessionFileStoreOptions {
  /** Absolute store root, normally `<DSH_HOME>/dsh-node/files`. */
  readonly root: string
  /** Current node id, used on every reference this store mints. */
  readonly nodeId: () => string
  /** Resolve one live session's working directory. */
  readonly sessionCwd?: (sessionId: string) => string | undefined | Promise<string | undefined>
  /** Clock, injectable for tests. */
  readonly now?: () => number
  /** Override the advertised limits (tests use smaller values). */
  readonly limits?: Partial<FileLimits>
}

/** How many rows one cleanup pass reclaimed. */
export interface FilesCleanupReport {
  readonly uploads: number
  readonly attachments: number
  readonly artifacts: number
}

/** Hash a session id into a fixed, path-safe directory name. */
export function sessionKeyOf(sessionId: string): string {
  return createHash('sha256').update(sessionId, 'utf8').digest('hex')
}

/** Whether a filesystem error means "no such thing". */
function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Create a directory and keep it private to the running user where POSIX modes exist. */
async function secureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  if (process.platform === 'win32') return
  try {
    await chmod(path, 0o700)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // A pre-existing directory owned by another user is not this store's to
    // repair; refusing here would stop every upload on a shared home. A
    // permission failure on a directory this process created is reported.
    if (code !== 'EPERM' && code !== 'EACCES') throw error
  }
}

/** Write every byte: FileHandle.write may legitimately complete only part of a buffer. */
async function writeAll(handle: FileHandle, bytes: Buffer, position: number): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, position + offset)
    if (bytesWritten <= 0 || bytesWritten > bytes.byteLength - offset) {
      throw Object.assign(new Error('disk write did not advance within the buffer'), { code: 'EIO' })
    }
    offset += bytesWritten
  }
}

/** Write one JSON document atomically: temp sibling, fsync, rename. */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await secureDir(dirname(path))
  const temp = `${path}.tmp-${randomUUID()}`
  const text = `${JSON.stringify(value)}\n`
  await writeFile(temp, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  await rename(temp, path)
}

/** Read one JSON document, or `undefined` when it is absent or unreadable. */
async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

/** Validate a stored timestamp; `undefined` when it is not ISO-8601. */
function readIso(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined
}

/**
 * Session-scoped file storage and transfer.
 *
 * The store is deliberately independent of the transport: it knows nothing
 * about a Coordinator, a WebSocket, or an HTTP route. That is what keeps its
 * tests able to drive a 20 MiB round-trip without a listener.
 */
export class SessionFileStore {
  /** Absolute store root. */
  readonly root: string
  /** Effective limits, as `describe` reports them. */
  readonly limits: FileLimits

  readonly #nodeId: () => string
  readonly #sessionCwd: ((sessionId: string) => string | undefined | Promise<string | undefined>) | undefined
  readonly #now: () => number

  readonly #uploads = new Map<string, UploadRecord>()
  readonly #clientIndex = new Map<string, string>()
  readonly #manifestCache = new Map<string, AttachmentManifest | ArtifactManifest>()
  #usedBytes = 0
  #opened: Promise<void> | undefined
  #queue: Promise<unknown> = Promise.resolve()
  #closed = false

  /**
   * @param options - root, node identity, session cwd resolver, clock, limits.
   */
  constructor(options: SessionFileStoreOptions) {
    this.root = options.root
    this.#nodeId = options.nodeId
    this.#now = options.now ?? Date.now
    this.limits = { ...FILE_LIMITS, ...options.limits }
    this.#sessionCwd = options.sessionCwd
  }

  /** Bytes currently occupied by attachments, artifacts and open uploads. */
  get usedBytes(): number {
    return this.#usedBytes
  }

  /** Number of uploads not yet committed. */
  get activeUploads(): number {
    let active = 0
    for (const upload of this.#uploads.values()) if (!upload.committed) active += 1
    return active
  }

  /** `sessionFiles/describe`. */
  describe(deliveryTool: 'available' | 'unavailable'): FilesDescribe {
    return {
      protocolVersion: 1,
      limits: this.limits,
      deliveryTool,
    }
  }

  /**
   * Create the directory tree and reconcile metadata with the filesystem.
   *
   * Safe to call repeatedly; the work runs once. A crash can leave an
   * `incoming/*.part` with no manifest, or a manifest whose bytes are gone. The
   * first is deleted (a restart is not a resumable upload), the second becomes
   * `missing` so the UI can explain it.
   */
  async open(): Promise<void> {
    if (this.#opened === undefined) this.#opened = this.#open()
    return this.#opened
  }

  async #open(): Promise<void> {
    try {
      await secureDir(this.root)
    } catch (error) {
      throw this.#io('create the file store root', error)
    }
    let sessions: string[] = []
    try {
      sessions = (await readdir(this.root, { withFileTypes: true }))
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
    } catch (error) {
      if (!isMissing(error)) throw this.#io('read the file store root', error)
    }

    for (const sessionKey of sessions) {
      const sessionDir = join(this.root, sessionKey)
      for (const kind of KIND_DIRS) await secureDir(join(sessionDir, kind))
      await secureDir(join(sessionDir, 'manifests', 'uploads'))
      await secureDir(join(sessionDir, 'manifests', 'attachments'))
      await secureDir(join(sessionDir, 'manifests', 'artifacts'))

      // Incomplete uploads are not resumable, and their manifests would claim
      // bytes that no longer form a complete file.
      await this.#clearDirectory(join(sessionDir, 'incoming'))
      await this.#clearDirectory(join(sessionDir, 'manifests', 'uploads'))
      await this.#removeTemps(join(sessionDir, 'attachments'))
      await this.#removeTemps(join(sessionDir, 'artifacts'))

      await this.#loadAttachmentManifests(sessionDir)
      await this.#loadArtifactManifests(sessionDir)
      await this.#removeOrphanBytes(sessionDir, 'attachments')
      await this.#removeOrphanBytes(sessionDir, 'artifacts')
    }
    this.#usedBytes = Math.max(0, this.#usedBytes)
  }

  /**
   * Delete a final file whose metadata write never landed.
   *
   * The crash window is one `rename` wide: bytes exist under their final UUID
   * but no manifest does. Such a file is unreachable (downloads are by
   * artifact id) and would quietly consume quota, so it is reclaimed here.
   */
  async #removeOrphanBytes(sessionDir: string, kind: 'attachments' | 'artifacts'): Promise<void> {
    let known: Set<string>
    try {
      known = new Set(
        (await readdir(join(sessionDir, 'manifests', kind)))
          .filter(name => name.endsWith('.json'))
          .map(name => name.slice(0, -'.json'.length)),
      )
    } catch {
      return
    }
    let entries: string[]
    try {
      entries = await readdir(join(sessionDir, kind))
    } catch {
      return
    }
    for (const entry of entries) {
      if (known.has(entry)) continue
      await rm(join(sessionDir, kind, entry), { force: true }).catch(() => undefined)
    }
  }

  async #loadAttachmentManifests(sessionDir: string): Promise<void> {
    for (const name of await this.#listManifests(sessionDir, 'attachments')) {
      const path = join(sessionDir, 'manifests', 'attachments', name)
      const raw = await readJson(path)
      const manifest = readAttachmentManifest(raw)
      if (manifest === undefined) continue
      const bytes = join(sessionDir, 'attachments', manifest.attachmentId)
      const state = await this.#stateOf(manifest.expiresAt, bytes)
      const next: AttachmentManifest = { ...manifest, state }
      this.#manifestCache.set(attachmentKey(manifest.sessionId, manifest.attachmentId), next)
      if (next.state === 'ready') this.#usedBytes += manifest.size
      else await this.#deleteBytes(join(sessionDir, 'attachments', manifest.attachmentId))
      if (state !== manifest.state) await writeJsonAtomic(path, next)
    }
  }

  async #loadArtifactManifests(sessionDir: string): Promise<void> {
    for (const name of await this.#listManifests(sessionDir, 'artifacts')) {
      const path = join(sessionDir, 'manifests', 'artifacts', name)
      const raw = await readJson(path)
      const manifest = readArtifactManifest(raw)
      if (manifest === undefined) continue
      const bytes = join(sessionDir, 'artifacts', manifest.artifactId)
      const state = await this.#stateOf(manifest.expiresAt, bytes)
      const next: ArtifactManifest = { ...manifest, state }
      this.#manifestCache.set(artifactKey(manifest.sessionId, manifest.artifactId), next)
      if (next.state === 'ready') this.#usedBytes += manifest.size
      else await this.#deleteBytes(join(sessionDir, 'artifacts', manifest.artifactId))
      if (state !== manifest.state) await writeJsonAtomic(path, next)
    }
  }

  async #stateOf(expiresAt: string, path: string): Promise<'ready' | 'expired' | 'missing'> {
    if (Date.parse(expiresAt) <= this.#now()) return 'expired'
    try {
      const info = await stat(path)
      return info.isFile() ? 'ready' : 'missing'
    } catch {
      return 'missing'
    }
  }

  async #listManifests(sessionDir: string, kind: 'attachments' | 'artifacts'): Promise<string[]> {
    try {
      return (await readdir(join(sessionDir, 'manifests', kind))).filter(name => name.endsWith('.json'))
    } catch (error) {
      if (isMissing(error)) return []
      throw this.#io(`list ${kind} metadata`, error)
    }
  }

  async #clearDirectory(path: string): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(path)
    } catch (error) {
      if (isMissing(error)) return
      throw this.#io('scan an incoming directory', error)
    }
    for (const entry of entries) await rm(join(path, entry), { force: true, recursive: true }).catch(() => undefined)
  }

  async #removeTemps(path: string): Promise<void> {
    try {
      for (const entry of await readdir(path)) {
        if (entry.includes('.tmp-')) await rm(join(path, entry), { force: true }).catch(() => undefined)
      }
    } catch {
      // A directory that does not exist yet has nothing to clean.
    }
  }

  /** Resolve one session's directory, creating it on first use. */
  async #sessionDir(sessionId: string): Promise<string> {
    const dir = join(this.root, sessionKeyOf(sessionId))
    await secureDir(dir)
    for (const kind of KIND_DIRS) await secureDir(join(dir, kind))
    await secureDir(join(dir, 'manifests', 'uploads'))
    await secureDir(join(dir, 'manifests', 'attachments'))
    await secureDir(join(dir, 'manifests', 'artifacts'))
    return dir
  }

  /** Serialize one mutating operation. */
  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task)
    this.#queue = run.then(() => undefined, () => undefined)
    return run
  }

  /** Open one upload. */
  async beginUpload(input: {
    readonly sessionId: string
    readonly name: string
    readonly size: number
    readonly clientUploadId: string
  }): Promise<BeginUploadResult> {
    await this.open()
    return this.#serial(async () => {
      this.#assertOpen()
      const sessionId = requireSessionId(input.sessionId)
      const name = displayName(input.name)
      if (typeof input.size === 'number' && input.size > this.limits.maxFileBytes) {
        throw fileError('files/too-large', `file is ${input.size} bytes, over the ${this.limits.maxFileBytes} byte limit`, {
          bytes: input.size,
          maxBytes: this.limits.maxFileBytes,
        })
      }
      const size = requireCount(input.size, 'size')
      const clientUploadId = requireString(input.clientUploadId, 'clientUploadId').slice(0, 200)

      const indexKey = clientKey(sessionId, clientUploadId)
      const existingId = this.#clientIndex.get(indexKey)
      if (existingId !== undefined) {
        const existing = this.#uploads.get(existingId)
        if (existing !== undefined && existing.sessionId === sessionId) {
          if (existing.name !== name || existing.size !== size) {
            throw fileError('files/offset-conflict', 'clientUploadId was already used with a different name or size', {
              clientUploadId,
              received: existing.written,
            })
          }
          return { uploadId: existing.uploadId, chunkBytes: this.limits.chunkBytes, received: existing.written }
        }
      }

      if (this.activeUploads >= this.limits.maxActiveUploads) {
        throw fileError('files/quota-exceeded', 'this node already has the maximum number of open uploads', {
          activeUploads: this.activeUploads,
          maxActiveUploads: this.limits.maxActiveUploads,
        })
      }
      if (this.#usedBytes + size > this.limits.storageLimitBytes) {
        throw fileError('files/quota-exceeded', 'the node file store has no room for this upload', {
          usedBytes: this.#usedBytes,
          requested: size,
          storageLimitBytes: this.limits.storageLimitBytes,
        })
      }

      const sessionDir = await this.#sessionDir(sessionId)
      const uploadId = randomUUID()
      const partPath = join(sessionDir, 'incoming', `${uploadId}.part`)
      let handle: FileHandle
      try {
        handle = await open(partPath, 'wx+', 0o600)
      } catch (error) {
        throw this.#io('create an upload staging file', error)
      }
      const record: UploadRecord = {
        uploadId,
        clientUploadId,
        sessionId,
        sessionKey: sessionKeyOf(sessionId),
        name,
        size,
        createdAt: this.#now(),
        lastAt: this.#now(),
        partPath,
        handle,
        hash: createHash('sha256'),
        written: 0,
        committed: false,
        ref: undefined,
      }
      this.#uploads.set(uploadId, record)
      this.#clientIndex.set(indexKey, uploadId)
      return { uploadId, chunkBytes: this.limits.chunkBytes, received: 0 }
    })
  }

  /** Append one chunk, idempotently for a retried offset. */
  async writeChunk(input: {
    readonly sessionId: string
    readonly uploadId: string
    readonly offset: number
    readonly base64: string
  }): Promise<WriteChunkResult> {
    await this.open()
    return this.#serial(async () => {
      this.#assertOpen()
      const sessionId = requireSessionId(input.sessionId)
      const uploadId = requireString(input.uploadId, 'uploadId')
      const offset = requireCount(input.offset, 'offset', MAX_FILE_BYTES)
      const bytes = decodeBase64(input.base64, Math.min(UPLOAD_CHUNK_BYTES, this.limits.chunkBytes))
      const upload = this.#uploads.get(uploadId)
      if (upload === undefined || upload.sessionId !== sessionId) {
        throw fileError('files/not-found', `upload ${uploadId} does not belong to this session`, { uploadId })
      }
      upload.lastAt = this.#now()

      if (upload.committed) {
        if (offset === upload.size) return { nextOffset: offset, received: upload.written }
        throw fileError('files/offset-conflict', 'the upload has already been committed', {
          offset,
          received: upload.written,
        })
      }
      if (offset > upload.written) {
        throw fileError('files/offset-conflict', `chunk offset ${offset} skips the ${upload.written} bytes already received`, {
          offset,
          received: upload.written,
        })
      }
      if (offset + bytes.byteLength > upload.size) {
        throw fileError('files/too-large', 'chunk would extend past the declared file size', {
          offset,
          bytes: bytes.byteLength,
          size: upload.size,
        })
      }


      if (offset < upload.written) {
        if (offset + bytes.byteLength > upload.written || upload.handle === undefined) {
          throw fileError('files/offset-conflict', 'chunk overlaps bytes this upload has not received', {
            offset,
            bytes: bytes.byteLength,
            received: upload.written,
          })
        }
        const existing = Buffer.alloc(bytes.byteLength)
        const read = await upload.handle.read(existing, 0, bytes.byteLength, offset)
        if (read.bytesRead !== bytes.byteLength || !existing.equals(bytes)) {
          throw fileError('files/offset-conflict', `chunk at offset ${offset} differs from the bytes already received`, {
            offset,
            received: upload.written,
          })
        }
        return { nextOffset: offset + bytes.byteLength, received: upload.written }
      }

      if (this.#usedBytes + bytes.byteLength > this.limits.storageLimitBytes) {
        throw fileError('files/quota-exceeded', 'the node file store has no room for this chunk', {
          usedBytes: this.#usedBytes,
          requested: bytes.byteLength,
          storageLimitBytes: this.limits.storageLimitBytes,
        })
      }
      const handle = upload.handle
      if (handle === undefined) {
        throw fileError('files/io-error', 'the upload staging file is no longer open', { uploadId })
      }
      try {
        await writeAll(handle, bytes, offset)
      } catch (error) {
        // A partially written chunk must never be retried over a dirty staging file.
        await this.#discardUpload(upload)
        throw this.#io('write an upload chunk', error)
      }
      upload.hash.update(bytes)
      upload.written += bytes.byteLength
      this.#usedBytes += bytes.byteLength
      return { nextOffset: upload.written, received: upload.written }
    })
  }

  /** Verify and commit one upload into an attachment. */
  async commitUpload(input: {
    readonly sessionId: string
    readonly uploadId: string
    readonly size: number
    readonly sha256: string
  }): Promise<AttachmentRef> {
    await this.open()
    return this.#serial(async () => {
      this.#assertOpen()
      const sessionId = requireSessionId(input.sessionId)
      const uploadId = requireString(input.uploadId, 'uploadId')
      const size = requireCount(input.size, 'size', this.limits.maxFileBytes)
      const sha256 = requireSha256(input.sha256)
      const upload = this.#uploads.get(uploadId)
      if (upload === undefined || upload.sessionId !== sessionId) {
        throw fileError('files/not-found', `upload ${uploadId} does not belong to this session`, { uploadId })
      }
      if (upload.committed) {
        const ref = upload.ref
        if (ref === undefined) throw fileError('files/io-error', 'the committed upload lost its reference', { uploadId })
        if (ref.size !== size || ref.sha256 !== sha256) {
          throw fileError('files/offset-conflict', 'this upload was already committed with different bytes', {
            uploadId,
          })
        }
        return ref
      }
      if (size !== upload.size) {
        throw fileError('files/invalid-arguments', `commit size ${size} does not match the declared ${upload.size}`, {
          size,
          declaredSize: upload.size,
        })
      }
      if (upload.written !== upload.size) {
        throw fileError('files/invalid-arguments', 'the upload is not complete', {
          received: upload.written,
          size: upload.size,
        })
      }
      const diskSize = (await upload.handle?.stat())?.size
      if (diskSize !== size) {
        await this.#discardUpload(upload)
        throw fileError('files/io-error', 'the staging file size does not match the received bytes', {})
      }
      const actual = upload.hash.copy().digest('hex')
      if (actual !== sha256) {
        throw fileError('files/hash-mismatch', 'the committed sha256 does not match the received bytes', {
          expected: sha256,
          actual,
        })
      }

      const sessionDir = await this.#sessionDir(sessionId)
      const attachmentId = randomUUID()
      const target = join(sessionDir, 'attachments', attachmentId)
      const handle = upload.handle
      upload.handle = undefined
      try {
        await handle?.sync()
        await handle?.close()
        await rename(upload.partPath, target)
        if (process.platform !== 'win32') await chmod(target, 0o600)
      } catch (error) {
        await this.#discardUpload(upload)
        throw this.#io('commit an upload', error)
      }

      const createdAt = this.#now()
      const ref: AttachmentRef = {
        attachmentId,
        nodeId: this.#nodeId(),
        sessionId,
        name: upload.name,
        size: upload.size,
        sha256,
        remotePath: target,
        createdAt: new Date(createdAt).toISOString(),
        expiresAt: new Date(createdAt + this.limits.retentionMs).toISOString(),
      }
      const manifest: AttachmentManifest = {
        kind: 'attachment',
        attachmentId,
        nodeId: ref.nodeId,
        sessionId,
        name: ref.name,
        size: ref.size,
        sha256: ref.sha256,
        createdAt: ref.createdAt,
        expiresAt: ref.expiresAt,
        state: 'ready',
      }
      try {
        await writeJsonAtomic(join(sessionDir, 'manifests', 'attachments', `${attachmentId}.json`), manifest)
      } catch (error) {
        await rm(target, { force: true }).catch(() => undefined)
        await this.#discardUpload(upload)
        throw this.#io('write attachment metadata', error)
      }
      this.#manifestCache.set(attachmentKey(sessionId, attachmentId), manifest)
      upload.committed = true
      upload.ref = ref
      upload.lastAt = createdAt
      return ref
    })
  }

  /** Discard an uncommitted upload. A committed attachment is untouched. */
  async abortUpload(input: { readonly sessionId: string; readonly uploadId: string }): Promise<AbortUploadResult> {
    await this.open()
    return this.#serial(async () => {
      this.#assertOpen()
      const sessionId = requireSessionId(input.sessionId)
      const uploadId = requireString(input.uploadId, 'uploadId')
      const upload = this.#uploads.get(uploadId)
      if (upload === undefined || upload.sessionId !== sessionId) {
        throw fileError('files/not-found', `upload ${uploadId} does not belong to this session`, { uploadId })
      }
      if (!upload.committed) await this.#discardUpload(upload)
      return { accepted: true }
    })
  }

  /** Resolve attachment ids for one session, preserving request order. */
  async resolveAttachments(input: {
    readonly sessionId: string
    readonly attachmentIds: readonly string[]
  }): Promise<ResolveAttachmentsResult> {
    await this.open()
    return this.#serial(async () => {
      this.#assertOpen()
      const sessionId = requireSessionId(input.sessionId)
      const ids = input.attachmentIds
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > this.limits.maxAttachmentsPerMessage) {
        throw fileError('files/invalid-arguments', `attachmentIds must contain 1 to ${this.limits.maxAttachmentsPerMessage} ids`, {
          count: Array.isArray(ids) ? ids.length : 0,
        })
      }
      if (ids.some(id => typeof id !== 'string' || id === '')) {
        throw fileError('files/invalid-arguments', 'every attachmentId must be a non-empty string', {})
      }
      const unique = new Set(ids)
      if (unique.size !== ids.length) {
        throw fileError('files/invalid-arguments', 'attachmentIds must not repeat', {})
      }
      const attachments: AttachmentRef[] = []
      for (const attachmentId of ids) {
        attachments.push(await this.#resolveAttachment(sessionId, attachmentId))
      }
      return { attachments }
    })
  }

  async #resolveAttachment(sessionId: string, attachmentId: string): Promise<AttachmentRef> {
    const manifest = await this.#attachmentManifest(sessionId, attachmentId)
    if (manifest === undefined) {
      throw fileError('files/not-found', `attachment ${attachmentId} does not belong to this session`, { attachmentId })
    }
    const sessionDir = join(this.root, sessionKeyOf(sessionId))
    const path = join(sessionDir, 'attachments', attachmentId)
    const state = await this.#stateOf(manifest.expiresAt, path)
    if (state === 'expired') {
      await this.#expireManifest('attachments', sessionDir, manifest)
      throw fileError('files/expired', `attachment ${attachmentId} has expired`, { attachmentId })
    }
    if (state === 'missing') {
      await this.#markMissing('attachments', sessionDir, manifest)
      throw fileError('files/not-found', `attachment ${attachmentId} is no longer stored on this node`, { attachmentId })
    }
    return {
      attachmentId,
      nodeId: manifest.nodeId,
      sessionId: manifest.sessionId,
      name: manifest.name,
      size: manifest.size,
      sha256: manifest.sha256,
      remotePath: path,
      createdAt: manifest.createdAt,
      expiresAt: manifest.expiresAt,
    }
  }

  /** List one session's artifacts, oldest first. */
  async listArtifacts(sessionIdInput: string): Promise<ListArtifactsResult> {
    await this.open()
    return this.#serial(async () => {
      this.#assertOpen()
      const sessionId = requireSessionId(sessionIdInput)
      const sessionDir = join(this.root, sessionKeyOf(sessionId))
      try {
        await readdir(sessionDir)
      } catch {
        return { artifacts: [] }
      }
      const artifacts: ArtifactRef[] = []
      for (const name of await this.#listManifests(sessionDir, 'artifacts')) {
        const manifest = await this.#artifactManifest(sessionId, name.replace(/\.json$/u, ''))
        if (manifest === undefined) continue
        artifacts.push(await this.#artifactRef(sessionDir, manifest))
      }
      artifacts.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
      return { artifacts }
    })
  }

  async #artifactRef(sessionDir: string, manifest: ArtifactManifest): Promise<ArtifactRef> {
    const path = join(sessionDir, 'artifacts', manifest.artifactId)
    const state = await this.#stateOf(manifest.expiresAt, path)
    if (state === 'expired') await this.#expireManifest('artifacts', sessionDir, manifest)
    else if (state === 'missing') await this.#markMissing('artifacts', sessionDir, manifest)
    return {
      artifactId: manifest.artifactId,
      nodeId: manifest.nodeId,
      sessionId: manifest.sessionId,
      name: manifest.name,
      size: manifest.size,
      sha256: manifest.sha256,
      createdAt: manifest.createdAt,
      expiresAt: manifest.expiresAt,
      state,
    }
  }

  /**
   * Snapshot one file from the session workspace (or its attachment directory).
   *
   * @param input - session, absolute source path, optional display name, cwd.
   * @returns the artifact reference.
   */
  async publishArtifact(input: {
    readonly sessionId: string
    readonly path: string
    readonly name?: string | undefined
    readonly cwd?: string | undefined
  }): Promise<ArtifactRef> {
    await this.open()
    return this.#serial(async () => {
      this.#assertOpen()
      const sessionId = requireSessionId(input.sessionId)
      const requested = requireString(input.path, 'path')
      const sessionDir = await this.#sessionDir(sessionId)
      const attachmentRoot = join(sessionDir, 'attachments')
      const cwd = input.cwd ?? (this.#sessionCwd === undefined ? undefined : await this.#sessionCwd(sessionId))
      if (cwd === undefined || cwd === '') {
        throw fileError('files/forbidden', 'this session has no working directory to deliver from', { sessionId })
      }

      // The source must be a regular file *and* not a link. `decidePath` already
      // realpaths both sides, so a linked parent that escapes the workspace is
      // refused; the explicit link check also refuses an in-workspace link,
      // which is what the plan promises.
      let link
      try {
        const entry = await lstat(requested)
        if (entry.isSymbolicLink()) {
          throw fileError('files/forbidden', 'a link cannot be delivered; pass the real file path', { reason: 'link' })
        }
        if (!entry.isFile()) {
          throw fileError('files/forbidden', 'only a regular file can be delivered', { reason: 'not-a-file' })
        }
        link = await open(requested, 'r')
      } catch (error) {
        if (isFilesError(error)) throw error
        if (isMissing(error)) throw fileError('files/not-found', 'the file to deliver does not exist', { reason: 'not-found' })
        throw this.#io('open the file to deliver', error)
      }
      try {
        const before = await link.stat()
        if (!before.isFile()) {
          throw fileError('files/forbidden', 'only a regular file can be delivered', { reason: 'not-a-file' })
        }
        if (before.size > this.limits.maxFileBytes) {
          throw fileError('files/too-large', 'the file is larger than the delivery limit', {
            bytes: before.size,
            maxBytes: this.limits.maxFileBytes,
          })
        }
        const decision = await decidePath([cwd, attachmentRoot], requested)
        if (!decision.allowed) {
          throw fileError('files/forbidden', 'the file is outside the session workspace and its attachment directory', {
            reason: decision.reason,
          })
        }
        const sourceInfo = await stat(decision.path)
        if (!sourceInfo.isFile()) {
          throw fileError('files/forbidden', 'only a regular file can be delivered', { reason: 'not-a-file' })
        }
        if (this.#usedBytes + sourceInfo.size > this.limits.storageLimitBytes) {
          throw fileError('files/quota-exceeded', 'the node file store has no room for this artifact', {
            usedBytes: this.#usedBytes,
            requested: sourceInfo.size,
            storageLimitBytes: this.limits.storageLimitBytes,
          })
        }

        const artifactId = randomUUID()
        const temp = join(sessionDir, 'artifacts', `${artifactId}.tmp-${randomUUID()}`)
        const target = join(sessionDir, 'artifacts', artifactId)
        const hash = createHash('sha256')
        let written = 0
        let output: FileHandle | undefined
        try {
          output = await open(temp, 'wx', 0o600)
          const buffer = Buffer.alloc(64 * 1024)
          for (;;) {
            const { bytesRead } = await link.read(buffer, 0, buffer.byteLength, null)
            if (bytesRead === 0) break
            const slice = buffer.subarray(0, bytesRead)
            await writeAll(output, slice, written)
            hash.update(slice)
            written += bytesRead
          }
          const after = await link.stat()
          if (!sameIdentity(before, after) || written !== before.size) {
            throw fileError('files/io-error', 'the source file changed while it was being delivered; retry the delivery', {
              reason: 'source-changed',
            })
          }
          await output.sync()
          await output.close()
          output = undefined
          if (process.platform !== 'win32') await chmod(temp, 0o400)
          await rename(temp, target)
        } catch (error) {
          await output?.close().catch(() => undefined)
          await rm(temp, { force: true }).catch(() => undefined)
          if (isFilesError(error)) throw error
          throw this.#io('snapshot the file to deliver', error)
        } finally {
          await link.close().catch(() => undefined)
        }

        const createdAt = this.#now()
        const name = displayName(input.name ?? basename(decision.path), basename(decision.path))
        const ref: ArtifactRef = {
          artifactId,
          nodeId: this.#nodeId(),
          sessionId,
          name,
          size: written,
          sha256: hash.digest('hex'),
          createdAt: new Date(createdAt).toISOString(),
          expiresAt: new Date(createdAt + this.limits.retentionMs).toISOString(),
          state: 'ready',
        }
        const manifest: ArtifactManifest = { kind: 'artifact', ...ref }
        try {
          await writeJsonAtomic(join(sessionDir, 'manifests', 'artifacts', `${artifactId}.json`), manifest)
        } catch (error) {
          await rm(target, { force: true }).catch(() => undefined)
          throw this.#io('write artifact metadata', error)
        }
        this.#manifestCache.set(artifactKey(sessionId, artifactId), manifest)
        this.#usedBytes += written
        return ref
      } finally {
        await link.close().catch(() => undefined)
      }
    })
  }

  /** Read one bounded artifact chunk. */
  async readArtifactChunk(input: {
    readonly sessionId: string
    readonly artifactId: string
    readonly offset: number
    readonly length: number
  }): Promise<ReadArtifactChunkResult> {
    await this.open()
    return this.#serial(async () => {
      this.#assertOpen()
      const sessionId = requireSessionId(input.sessionId)
      const artifactId = requireString(input.artifactId, 'artifactId')
      const offset = requireCount(input.offset, 'offset', MAX_FILE_BYTES)
      const length = requireCount(input.length, 'length', ARTIFACT_CHUNK_BYTES)
      const manifest = await this.#artifactManifest(sessionId, artifactId)
      if (manifest === undefined) {
        throw fileError('files/not-found', `artifact ${artifactId} does not belong to this session`, { artifactId })
      }
      const sessionDir = join(this.root, sessionKeyOf(sessionId))
      const path = join(sessionDir, 'artifacts', artifactId)
      const state = await this.#stateOf(manifest.expiresAt, path)
      if (state === 'expired') {
        await this.#expireManifest('artifacts', sessionDir, manifest)
        throw fileError('files/expired', `artifact ${artifactId} has expired`, { artifactId })
      }
      if (state === 'missing') {
        await this.#markMissing('artifacts', sessionDir, manifest)
        throw fileError('files/not-found', `artifact ${artifactId} is no longer stored on this node`, { artifactId })
      }
      if (offset > manifest.size) {
        throw fileError('files/invalid-arguments', 'offset is past the end of the artifact', {
          offset,
          size: manifest.size,
        })
      }
      const remaining = manifest.size - offset
      const wanted = Math.min(length, remaining)
      if (wanted === 0 && remaining > 0) {
        throw fileError('files/invalid-arguments', 'length must be greater than zero before the end of the artifact', {
          offset,
          remaining,
        })
      }
      let base64 = ''
      if (wanted > 0) {
        let handle: FileHandle | undefined
        try {
          handle = await open(path, 'r')
          const buffer = Buffer.alloc(wanted)
          const { bytesRead } = await handle.read(buffer, 0, wanted, offset)
          if (bytesRead !== wanted) {
            throw fileError('files/io-error', 'the artifact ended before the requested chunk', {
              offset,
              requested: wanted,
              read: bytesRead,
            })
          }
          base64 = buffer.toString('base64')
        } catch (error) {
          if (isFilesError(error)) throw error
          throw this.#io('read an artifact chunk', error)
        } finally {
          await handle?.close().catch(() => undefined)
        }
      }
      return {
        base64,
        nextOffset: offset + wanted,
        totalSize: manifest.size,
        sha256: manifest.sha256,
      }
    })
  }

  /** Reclaim idle uploads and expired bytes. */
  async cleanup(): Promise<FilesCleanupReport> {
    await this.open()
    return this.#serial(async () => {
      this.#assertOpen()
      const now = this.#now()
      let uploads = 0
      for (const upload of [...this.#uploads.values()]) {
        if (upload.committed || now - upload.lastAt <= this.limits.incompleteUploadTtlMs) continue
        await this.#discardUpload(upload)
        uploads += 1
      }
      let attachments = 0
      let artifacts = 0
      let sessions: string[] = []
      try {
        sessions = (await readdir(this.root, { withFileTypes: true }))
          .filter(entry => entry.isDirectory())
          .map(entry => entry.name)
      } catch {
        return { uploads, attachments, artifacts }
      }
      for (const sessionKey of sessions) {
        const sessionDir = join(this.root, sessionKey)
        for (const name of await this.#listManifests(sessionDir, 'attachments')) {
          const manifest = readAttachmentManifest(await readJson(join(sessionDir, 'manifests', 'attachments', name)))
          if (manifest === undefined || manifest.state !== 'ready') continue
          const path = join(sessionDir, 'attachments', manifest.attachmentId)
          const state = await this.#stateOf(manifest.expiresAt, path)
          if (state === 'ready') continue
          if (state === 'expired') await this.#expireManifest('attachments', sessionDir, manifest)
          else await this.#markMissing('attachments', sessionDir, manifest)
          attachments += 1
        }
        for (const name of await this.#listManifests(sessionDir, 'artifacts')) {
          const manifest = readArtifactManifest(await readJson(join(sessionDir, 'manifests', 'artifacts', name)))
          if (manifest === undefined || manifest.state !== 'ready') continue
          const path = join(sessionDir, 'artifacts', manifest.artifactId)
          const state = await this.#stateOf(manifest.expiresAt, path)
          if (state === 'ready') continue
          if (state === 'expired') await this.#expireManifest('artifacts', sessionDir, manifest)
          else await this.#markMissing('artifacts', sessionDir, manifest)
          artifacts += 1
        }
      }
      return { uploads, attachments, artifacts }
    })
  }

  /** Close every open upload handle. Committed bytes stay on disk. */
  async close(): Promise<void> {
    this.#closed = true
    for (const upload of this.#uploads.values()) {
      await upload.handle?.close().catch(() => undefined)
      upload.handle = undefined
    }
    this.#uploads.clear()
    this.#clientIndex.clear()
  }

  async #discardUpload(upload: UploadRecord): Promise<void> {
    await upload.handle?.close().catch(() => undefined)
    upload.handle = undefined
    await rm(upload.partPath, { force: true }).catch(() => undefined)
    this.#usedBytes = Math.max(0, this.#usedBytes - (upload.committed ? 0 : upload.written))
    this.#uploads.delete(upload.uploadId)
    const indexKey = clientKey(upload.sessionId, upload.clientUploadId)
    if (this.#clientIndex.get(indexKey) === upload.uploadId) this.#clientIndex.delete(indexKey)
  }

  async #attachmentManifest(sessionId: string, attachmentId: string): Promise<AttachmentManifest | undefined> {
    const key = attachmentKey(sessionId, attachmentId)
    const cached = this.#manifestCache.get(key)
    if (cached !== undefined && cached.kind === 'attachment') return cached
    const path = join(this.root, sessionKeyOf(sessionId), 'manifests', 'attachments', `${attachmentId}.json`)
    const manifest = readAttachmentManifest(await readJson(path))
    if (manifest === undefined || manifest.sessionId !== sessionId) return undefined
    this.#manifestCache.set(key, manifest)
    return manifest
  }

  async #artifactManifest(sessionId: string, artifactId: string): Promise<ArtifactManifest | undefined> {
    const key = artifactKey(sessionId, artifactId)
    const cached = this.#manifestCache.get(key)
    if (cached !== undefined && cached.kind === 'artifact') return cached
    const path = join(this.root, sessionKeyOf(sessionId), 'manifests', 'artifacts', `${artifactId}.json`)
    const manifest = readArtifactManifest(await readJson(path))
    if (manifest === undefined || manifest.sessionId !== sessionId) return undefined
    this.#manifestCache.set(key, manifest)
    return manifest
  }

  async #expireManifest(
    kind: 'attachments' | 'artifacts',
    sessionDir: string,
    manifest: AttachmentManifest | ArtifactManifest,
  ): Promise<void> {
    const id = kind === 'attachments'
      ? (manifest as AttachmentManifest).attachmentId
      : (manifest as ArtifactManifest).artifactId
    await this.#deleteBytes(join(sessionDir, kind, id))
    if (manifest.state === 'ready') this.#usedBytes = Math.max(0, this.#usedBytes - manifest.size)
    const next = { ...manifest, state: 'expired' as const }
    this.#remember(next)
    await writeJsonAtomic(join(sessionDir, 'manifests', kind, `${id}.json`), next).catch(() => undefined)
  }

  async #markMissing(
    kind: 'attachments' | 'artifacts',
    sessionDir: string,
    manifest: AttachmentManifest | ArtifactManifest,
  ): Promise<void> {
    const id = kind === 'attachments'
      ? (manifest as AttachmentManifest).attachmentId
      : (manifest as ArtifactManifest).artifactId
    if (manifest.state === 'ready') this.#usedBytes = Math.max(0, this.#usedBytes - manifest.size)
    const next = { ...manifest, state: 'missing' as const }
    this.#remember(next)
    await writeJsonAtomic(join(sessionDir, 'manifests', kind, `${id}.json`), next).catch(() => undefined)
  }

  #remember(manifest: AttachmentManifest | ArtifactManifest): void {
    const key = manifest.kind === 'attachment'
      ? attachmentKey(manifest.sessionId, manifest.attachmentId)
      : artifactKey(manifest.sessionId, manifest.artifactId)
    this.#manifestCache.set(key, manifest)
  }

  async #deleteBytes(path: string): Promise<void> {
    await rm(path, { force: true }).catch(() => undefined)
  }

  #assertOpen(): void {
    if (this.#closed) throw fileError('files/io-error', 'the node file store is closed', { reason: 'closed' })
  }

  #io(action: string, error: unknown): Error {
    // The OS message carries the absolute path, which must not cross the wire.
    const code = (error as NodeJS.ErrnoException).code
    return fileError('files/io-error', `the node could not ${action}`, {
      reason: typeof code === 'string' ? code : 'unknown',
    })
  }
}

/** Whether two stats describe the same unchanged regular file. */
function sameIdentity(before: { size: number; mtimeMs: number; ino: number; dev: number }, after: { size: number; mtimeMs: number; ino: number; dev: number }): boolean {
  return before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ino === after.ino
    && before.dev === after.dev
}

function clientKey(sessionId: string, clientUploadId: string): string {
  return `${sessionId}\u0000${clientUploadId}`
}

function attachmentKey(sessionId: string, attachmentId: string): string {
  return `a\u0000${sessionId}\u0000${attachmentId}`
}

function artifactKey(sessionId: string, artifactId: string): string {
  return `r\u0000${sessionId}\u0000${artifactId}`
}

function requireSessionId(value: unknown): string {
  if (!isSessionId(value)) {
    throw fileError('files/invalid-arguments', 'sessionId is not a usable session identifier', { field: 'sessionId' })
  }
  return value
}

function isFilesError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code
  return (error as { isDSHRemoteError?: unknown }).isDSHRemoteError === true
    && typeof code === 'string'
    && code.startsWith('files/')
}

function readAttachmentManifest(raw: unknown): AttachmentManifest | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const row = raw as Record<string, unknown>
  if (row['kind'] !== 'attachment') return undefined
  const attachmentId = typeof row['attachmentId'] === 'string' ? row['attachmentId'] : undefined
  const nodeId = typeof row['nodeId'] === 'string' ? row['nodeId'] : undefined
  const sessionId = typeof row['sessionId'] === 'string' ? row['sessionId'] : undefined
  const name = typeof row['name'] === 'string' ? row['name'] : undefined
  const size = typeof row['size'] === 'number' && Number.isSafeInteger(row['size']) && row['size'] >= 0
    ? row['size']
    : undefined
  const sha256 = typeof row['sha256'] === 'string' && /^[0-9a-f]{64}$/u.test(row['sha256']) ? row['sha256'] : undefined
  const createdAt = readIso(row['createdAt'])
  const expiresAt = readIso(row['expiresAt'])
  if (attachmentId === undefined || nodeId === undefined || sessionId === undefined || name === undefined
    || size === undefined || sha256 === undefined || createdAt === undefined || expiresAt === undefined) return undefined
  const state = row['state'] === 'expired' || row['state'] === 'missing' ? row['state'] : 'ready'
  return { kind: 'attachment', attachmentId, nodeId, sessionId, name, size, sha256, createdAt, expiresAt, state }
}

function readArtifactManifest(raw: unknown): ArtifactManifest | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const row = raw as Record<string, unknown>
  if (row['kind'] !== 'artifact') return undefined
  const artifactId = typeof row['artifactId'] === 'string' ? row['artifactId'] : undefined
  const nodeId = typeof row['nodeId'] === 'string' ? row['nodeId'] : undefined
  const sessionId = typeof row['sessionId'] === 'string' ? row['sessionId'] : undefined
  const name = typeof row['name'] === 'string' ? row['name'] : undefined
  const size = typeof row['size'] === 'number' && Number.isSafeInteger(row['size']) && row['size'] >= 0
    ? row['size']
    : undefined
  const sha256 = typeof row['sha256'] === 'string' && /^[0-9a-f]{64}$/u.test(row['sha256']) ? row['sha256'] : undefined
  const createdAt = readIso(row['createdAt'])
  const expiresAt = readIso(row['expiresAt'])
  if (artifactId === undefined || nodeId === undefined || sessionId === undefined || name === undefined
    || size === undefined || sha256 === undefined || createdAt === undefined || expiresAt === undefined) return undefined
  const state = row['state'] === 'expired' || row['state'] === 'missing' ? row['state'] : 'ready'
  return { kind: 'artifact', artifactId, nodeId, sessionId, name, size, sha256, createdAt, expiresAt, state }
}
