/**
 * The frozen wire contract for `sessionFiles/*`.
 *
 * This module is the node's copy of the contract documented in
 * `dsh-master/docs/superpowers/specs/2026-10-29-session-files-contract.md`. The
 * coordinator and master hold independent copies for the same reason the node
 * speaks `dsh-node/1` without importing the coordinator's types: a second
 * implementation only agrees with the first when the specification is precise
 * enough to copy.
 *
 * All timestamps cross the wire as ISO-8601 strings. `remotePath` is an
 * internal field of an attachment reference: the master host appends it to the
 * prompt, and it is never handed to a browser.
 *
 * @module dsh-node/files/types
 */

/** Version of the `sessionFiles` contract this node speaks. */
export const FILES_PROTOCOL_VERSION = 1

/** Wire namespace of the session-file Remotes. */
export const FILES_NAMESPACE = 'sessionFiles'

/** Cordis service key the owner is provided under. */
export const FILES_SERVICE_KEY = 'sessionFiles'

/** Largest single file a client may upload or an Agent may deliver. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024

/** Most attachments one prompt may carry. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 5

/** Most uploads a node keeps open at once. */
export const MAX_ACTIVE_UPLOADS_PER_NODE = 2

/** Total bytes of attachments, artifacts and in-flight uploads on one node. */
export const NODE_STORAGE_LIMIT_BYTES = 1024 * 1024 * 1024

/** Raw bytes per `writeChunk`; base64 grows this by 4/3. */
export const UPLOAD_CHUNK_BYTES = 256 * 1024

/** Largest base64 string (after decode: {@link UPLOAD_CHUNK_BYTES}) accepted by one RPC. */
export const MAX_RPC_BASE64_BYTES = 512 * 1024

/** Bytes returned by one `readArtifactChunk`. */
export const ARTIFACT_CHUNK_BYTES = 256 * 1024

/** An incomplete upload idle this long is reclaimed. */
export const INCOMPLETE_UPLOAD_TTL_MS = 60 * 60 * 1000

/** Completed attachments and artifact snapshots are kept this long. */
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** Longest display name retained; longer names are truncated. */
export const MAX_DISPLAY_NAME_LENGTH = 180

/** Longest accepted `sessionId`; IDs are hashed, never joined into a path. */
export const MAX_SESSION_ID_LENGTH = 200

/** One node-confirmed attachment. */
export interface AttachmentRef {
  readonly attachmentId: string
  readonly nodeId: string
  readonly sessionId: string
  readonly name: string
  readonly size: number
  readonly sha256: string
  /** Absolute node path. Internal: master appends it to the prompt only. */
  readonly remotePath: string
  readonly createdAt: string
  readonly expiresAt: string
}

/** Why an artifact can no longer be downloaded. */
export type ArtifactState = 'ready' | 'expired' | 'missing'

/** One delivered artifact snapshot. Never carries a host path. */
export interface ArtifactRef {
  readonly artifactId: string
  readonly nodeId: string
  readonly sessionId: string
  readonly name: string
  readonly size: number
  readonly sha256: string
  readonly createdAt: string
  readonly expiresAt: string
  readonly state: ArtifactState
}

/** The limits the node is authoritative for. */
export interface FileLimits {
  readonly maxFileBytes: number
  readonly maxAttachmentsPerMessage: number
  readonly maxActiveUploads: number
  readonly storageLimitBytes: number
  readonly chunkBytes: number
  readonly retentionMs: number
  readonly incompleteUploadTtlMs: number
}

/** `sessionFiles/describe` result. */
export interface FilesDescribe {
  readonly protocolVersion: typeof FILES_PROTOCOL_VERSION
  readonly limits: FileLimits
  /** Whether an Agent in this profile can call `deliver_file` at all. */
  readonly deliveryTool: 'available' | 'unavailable'
}

/** `sessionFiles/beginUpload` result. */
export interface BeginUploadResult {
  readonly uploadId: string
  readonly chunkBytes: number
  /** Bytes already received for this `clientUploadId`, so a retry can resume at it. */
  readonly received: number
}

/** `sessionFiles/writeChunk` result. */
export interface WriteChunkResult {
  readonly nextOffset: number
  readonly received: number
}

/** `sessionFiles/abortUpload` result. */
export interface AbortUploadResult {
  readonly accepted: true
}

/** `sessionFiles/resolveAttachments` result. */
export interface ResolveAttachmentsResult {
  readonly attachments: readonly AttachmentRef[]
}

/** `sessionFiles/listArtifacts` result. */
export interface ListArtifactsResult {
  readonly artifacts: readonly ArtifactRef[]
}

/** `sessionFiles/readArtifactChunk` result. */
export interface ReadArtifactChunkResult {
  readonly base64: string
  readonly nextOffset: number
  readonly totalSize: number
  readonly sha256: string
}

/** Every stable `files/*` failure code. */
export const FILES_ERROR_CODES = [
  'files/invalid-arguments',
  'files/unsupported',
  'files/too-large',
  'files/quota-exceeded',
  'files/not-found',
  'files/forbidden',
  'files/expired',
  'files/hash-mismatch',
  'files/offset-conflict',
  'files/io-error',
] as const

/** One stable `files/*` failure category. */
export type FilesErrorCode = (typeof FILES_ERROR_CODES)[number]

/** The limits every consumer sees from `describe`. */
export const FILE_LIMITS: FileLimits = {
  maxFileBytes: MAX_FILE_BYTES,
  maxAttachmentsPerMessage: MAX_ATTACHMENTS_PER_MESSAGE,
  maxActiveUploads: MAX_ACTIVE_UPLOADS_PER_NODE,
  storageLimitBytes: NODE_STORAGE_LIMIT_BYTES,
  chunkBytes: UPLOAD_CHUNK_BYTES,
  retentionMs: RETENTION_MS,
  incompleteUploadTtlMs: INCOMPLETE_UPLOAD_TTL_MS,
}

/**
 * Whether a value is a usable `sessionId`.
 *
 * The id is hashed before it becomes a directory name, so the only reasons to
 * validate it are protocol sanity and log hygiene: a caller cannot traverse
 * with a slash, and a control character cannot rewrite a terminal line.
 * @param value - candidate id.
 * @returns `true` when it is a non-empty, bounded, path-free string.
 */
export function isSessionId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_SESSION_ID_LENGTH
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && !value.includes('/')
    && !value.includes('\\')
    && value !== '.'
    && value !== '..'
}

/**
 * Reduce a client-supplied display name to something safe to render.
 *
 * A display name is never used as a path, so this is a presentation guard, not
 * a security boundary: strip control characters and separators, bound the
 * length, and fall back rather than reject so an odd file name does not make an
 * upload impossible.
 * @param value - candidate name.
 * @param fallback - used when nothing usable remains.
 * @returns a printable, bounded name.
 */
export function displayName(value: unknown, fallback = 'file'): string {
  const raw = typeof value === 'string' ? value : ''
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .replace(/[\\/]+/gu, '_')
    .trim()
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return fallback
  return cleaned.length > MAX_DISPLAY_NAME_LENGTH
    ? cleaned.slice(0, MAX_DISPLAY_NAME_LENGTH)
    : cleaned
}

/**
 * Decode canonical base64 with a byte ceiling.
 *
 * The strict alphabet and padding check is what turns "almost base64" into a
 * refusal instead of `Buffer.from` silently dropping characters. Whitespace is
 * refused rather than skipped for the same reason: a truncated or re-wrapped
 * chunk must not look valid.
 * @param value - candidate string.
 * @param maxBytes - ceiling on decoded length.
 * @returns the decoded bytes.
 * @throws Error with `files/invalid-arguments` when the shape or size is wrong.
 */
export function decodeBase64(value: unknown, maxBytes: number): Buffer {
  if (typeof value !== 'string' || value === '') {
    throw fileError('files/invalid-arguments', 'base64 must be a non-empty string', { field: 'base64' })
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw fileError('files/invalid-arguments', 'base64 must be canonical base64 without whitespace', { field: 'base64' })
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.byteLength > maxBytes) {
    throw fileError('files/too-large', `chunk decodes to ${bytes.byteLength} bytes, over the ${maxBytes} byte limit`, {
      bytes: bytes.byteLength,
      maxBytes,
    })
  }
  if (bytes.byteLength === 0) {
    throw fileError('files/invalid-arguments', 'base64 decoded to zero bytes', { field: 'base64' })
  }
  return bytes
}

/** A field must be a finite non-negative safe integer. */
export function requireCount(value: unknown, field: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw fileError('files/invalid-arguments', `${field} must be an integer between 0 and ${max}`, { field })
  }
  return value
}

/** A field must be a non-empty string. */
export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw fileError('files/invalid-arguments', `${field} must be a non-empty string`, { field })
  }
  return value
}

/** A field must be a lowercase/uppercase hex SHA-256. */
export function requireSha256(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/iu.test(value)) {
    throw fileError('files/invalid-arguments', 'sha256 must be 64 hexadecimal characters', { field: 'sha256' })
  }
  return value.toLowerCase()
}

/**
 * Raise a failure the DSH Gateway treats as a declared Remote failure.
 *
 * Mirrors `remoteError` in `src/errors.ts` but lives here so the file modules do
 * not need to import the transport error module just for one helper.
 * @param code - stable `files/*` code.
 * @param message - correction-oriented, path-free diagnostic.
 * @param details - non-sensitive JSON context.
 * @returns an error carrying the structural `isDSHRemoteError` marker.
 */
export function fileError(
  code: FilesErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): Error {
  const error = new Error(message) as Error & {
    code: string
    details: Record<string, unknown>
    isDSHRemoteError: boolean
  }
  error.name = 'SessionFilesError'
  error.code = code
  error.details = details
  error.isDSHRemoteError = true
  return error
}
