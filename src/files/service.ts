/**
 * `sessionFiles` — the node's upload/download Remotes.
 *
 * The owner is a plain object with a hand-built `typertRemote` binding, exactly
 * like {@link NodeAdminOwner}: the Gateway only needs `ctx.get('sessionFiles')`
 * to return an object whose binding points at itself, and building it by hand
 * keeps this out-of-tree plugin free of runtime imports from official packages.
 *
 * Every method validates its own arguments even though the descriptor declares
 * them. The Gateway treats a `src-json` parameter as omissible, so a `{}` payload
 * reaches the method; validating here keeps every file failure on one code
 * vocabulary (`files/*`) instead of splitting it with `gateway/arguments-invalid`.
 *
 * The store-backed methods are `async` even where validation could throw
 * synchronously, so a malformed call is always a rejected Promise — the Gateway
 * awaits the callable's return value.
 *
 * @module dsh-node/files/service
 */

import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'
import {
  FILES_NAMESPACE,
  FILES_PROTOCOL_VERSION,
  FILES_SERVICE_KEY,
  fileError,
  isSessionId,
  type AbortUploadResult,
  type ArtifactRef,
  type AttachmentRef,
  type BeginUploadResult,
  type FilesDescribe,
  type ListArtifactsResult,
  type ReadArtifactChunkResult,
  type ResolveAttachmentsResult,
  type WriteChunkResult,
} from './types.js'
import type { SessionFileStore } from './store.js'

/** A JSON parameter the Gateway tolerates omitting, validated by the method. */
function jsonParameter(name: string): InvocationDescriptor['parameters'][number] {
  return { name, wire: name, source: 'json', codec: { mode: 'src-json' } }
}

/** Build one descriptor of the `sessionFiles` surface. */
function filesDescriptor(method: string, parameters: readonly string[]): InvocationDescriptor {
  return {
    id: `dsh-node/sessionFiles#${method}`,
    service: FILES_SERVICE_KEY,
    namespace: FILES_NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters: parameters.map(jsonParameter),
    result: { mode: 'src-json' },
  }
}

/**
 * The complete `sessionFiles` surface.
 *
 * Exported as data so a test can assert the exact list: an endpoint added here
 * without a decision shows up in review, and a test can prove the node exposes
 * nothing else.
 */
export const FILES_DESCRIPTORS: readonly InvocationDescriptor[] = [
  filesDescriptor('describe', ['sessionId']),
  filesDescriptor('beginUpload', ['sessionId', 'name', 'size', 'clientUploadId']),
  filesDescriptor('writeChunk', ['sessionId', 'uploadId', 'offset', 'base64']),
  filesDescriptor('commitUpload', ['sessionId', 'uploadId', 'size', 'sha256']),
  filesDescriptor('abortUpload', ['sessionId', 'uploadId']),
  filesDescriptor('resolveAttachments', ['sessionId', 'attachmentIds']),
  filesDescriptor('listArtifacts', ['sessionId']),
  filesDescriptor('readArtifactChunk', ['sessionId', 'artifactId', 'offset', 'length']),
]

/** Construction options for {@link SessionFilesOwner}. */
export interface SessionFilesOwnerOptions {
  /** Durable store this owner drives. */
  readonly store: SessionFileStore
  /** Whether the delivery tool is registered in this profile right now. */
  readonly deliveryToolAvailable?: () => boolean
}

/**
 * The `sessionFiles` Remote owner.
 *
 * Deliberately asynchronous: every method returns a Promise because the store
 * touches the disk. The Gateway awaits whatever a callable returns, so a
 * `src-json` result is the resolved value.
 */
export class SessionFilesOwner {
  /** Gateway binding, read structurally by `validateBinding` and `collectSrcClaims`. */
  readonly typertRemote: { readonly service: unknown; readonly serviceKey: string; readonly namespace: string }

  readonly #store: SessionFileStore
  readonly #deliveryToolAvailable: () => boolean

  /**
   * @param options - store plus a delivery-tool availability probe.
   */
  constructor(options: SessionFilesOwnerOptions) {
    this.#store = options.store
    this.#deliveryToolAvailable = options.deliveryToolAvailable ?? (() => false)
    this.typertRemote = Object.freeze({
      service: this,
      serviceKey: FILES_SERVICE_KEY,
      namespace: FILES_NAMESPACE,
    })
  }

  /** The capacity and tool facts a client needs before offering "＋". */
  describe(sessionId?: unknown): FilesDescribe {
    if (sessionId !== undefined && !isSessionId(sessionId)) {
      throw fileError('files/invalid-arguments', 'sessionId is not a usable session identifier', { field: 'sessionId' })
    }
    return {
      protocolVersion: FILES_PROTOCOL_VERSION,
      limits: this.#store.limits,
      deliveryTool: this.#deliveryToolAvailable() ? 'available' : 'unavailable',
    }
  }

  /** Open one upload. */
  async beginUpload(
    sessionId: unknown,
    name: unknown,
    size: unknown,
    clientUploadId: unknown,
  ): Promise<BeginUploadResult> {
    return this.#store.beginUpload({
      sessionId: requireSession(sessionId),
      name: typeof name === 'string' ? name : '',
      size: typeof size === 'number' ? size : Number.NaN,
      clientUploadId: typeof clientUploadId === 'string' ? clientUploadId : '',
    })
  }

  /** Append one chunk. */
  async writeChunk(
    sessionId: unknown,
    uploadId: unknown,
    offset: unknown,
    base64: unknown,
  ): Promise<WriteChunkResult> {
    return this.#store.writeChunk({
      sessionId: requireSession(sessionId),
      uploadId: typeof uploadId === 'string' ? uploadId : '',
      offset: typeof offset === 'number' ? offset : Number.NaN,
      base64: typeof base64 === 'string' ? base64 : '',
    })
  }

  /** Commit one verified upload. */
  async commitUpload(
    sessionId: unknown,
    uploadId: unknown,
    size: unknown,
    sha256: unknown,
  ): Promise<AttachmentRef> {
    return this.#store.commitUpload({
      sessionId: requireSession(sessionId),
      uploadId: typeof uploadId === 'string' ? uploadId : '',
      size: typeof size === 'number' ? size : Number.NaN,
      sha256: typeof sha256 === 'string' ? sha256 : '',
    })
  }

  /** Abort one uncommitted upload. */
  async abortUpload(sessionId: unknown, uploadId: unknown): Promise<AbortUploadResult> {
    return this.#store.abortUpload({
      sessionId: requireSession(sessionId),
      uploadId: typeof uploadId === 'string' ? uploadId : '',
    })
  }

  /** Resolve attachment ids for a prompt. */
  async resolveAttachments(sessionId: unknown, attachmentIds: unknown): Promise<ResolveAttachmentsResult> {
    return this.#store.resolveAttachments({
      sessionId: requireSession(sessionId),
      attachmentIds: Array.isArray(attachmentIds)
        ? attachmentIds.filter((id): id is string => typeof id === 'string')
        : [],
    })
  }

  /** List one session's delivered artifacts. */
  async listArtifacts(sessionId: unknown): Promise<ListArtifactsResult> {
    return this.#store.listArtifacts(requireSession(sessionId))
  }

  /** Read one bounded artifact chunk. */
  async readArtifactChunk(
    sessionId: unknown,
    artifactId: unknown,
    offset: unknown,
    length: unknown,
  ): Promise<ReadArtifactChunkResult> {
    return this.#store.readArtifactChunk({
      sessionId: requireSession(sessionId),
      artifactId: typeof artifactId === 'string' ? artifactId : '',
      offset: typeof offset === 'number' ? offset : Number.NaN,
      length: typeof length === 'number' ? length : Number.NaN,
    })
  }
}

/** Read a required session id, with the store's own error vocabulary. */
function requireSession(value: unknown): string {
  if (!isSessionId(value)) {
    throw fileError('files/invalid-arguments', 'sessionId is not a usable session identifier', { field: 'sessionId' })
  }
  return value
}
