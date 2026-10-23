/**
 * The `nodeUsage` Remotes: status, read, and ack.
 *
 * Three unary calls, one namespace, one request parameter each — the wire shape the
 * contract fixes. They are the *only* way a Coordinator can pull this node's queue,
 * which keeps the surface reviewable: there is no "dump everything" method, and no
 * method that can name a host path.
 *
 * The owner is a plain object carrying a hand-built `typertRemote` binding, the same
 * pattern `nodeAdmin` uses, so this plugin keeps taking no runtime dependency on an
 * official package.
 *
 * @module dsh-node/usage/service
 */

import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'
import { remoteError } from '../errors.js'
import { isUsageError } from './errors.js'
import type { NodeUsageStore } from './store.js'
import {
  parseAckRequest,
  parseReadRequest,
  type UsageAckResult,
  type UsageBatch,
  type UsageStatus,
} from './types.js'

/** Wire namespace of the usage Remotes. */
export const USAGE_NAMESPACE = 'nodeUsage'

/** Cordis service key the owner is provided under. */
export const USAGE_SERVICE_KEY = 'nodeUsage'

/** Build one descriptor of the `nodeUsage` surface. */
function usageDescriptor(method: string, parameters: readonly string[]): InvocationDescriptor {
  return {
    id: `dsh-node/usage#${method}`,
    service: USAGE_SERVICE_KEY,
    namespace: USAGE_NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters: parameters.map(name => ({
      name,
      wire: name,
      source: 'json' as const,
      codec: { mode: 'src-json' as const },
    })),
    result: { mode: 'src-json' },
  }
}

/** The complete `nodeUsage` surface. */
export const USAGE_DESCRIPTORS: readonly InvocationDescriptor[] = [
  usageDescriptor('status', []),
  usageDescriptor('read', ['request']),
  usageDescriptor('ack', ['request']),
]

/** Options for {@link NodeUsageOwner}. */
export interface NodeUsageOwnerOptions {
  readonly store: NodeUsageStore
  /** Whether collection is enabled. False answers `disabled`, not an empty page. */
  readonly enabled?: boolean
  /** Why this host cannot collect at all, when it cannot. */
  readonly unsupportedReason?: string
}

/**
 * The `nodeUsage` Remote owner.
 */
export class NodeUsageOwner {
  /** Gateway binding, read structurally by `validateBinding` and `collectSrcClaims`. */
  readonly typertRemote: { readonly service: unknown; readonly serviceKey: string; readonly namespace: string }

  readonly #store: NodeUsageStore
  readonly #enabled: boolean
  readonly #unsupportedReason: string | undefined

  /** @param options - store and capability switches. */
  constructor(options: NodeUsageOwnerOptions) {
    this.#store = options.store
    this.#enabled = options.enabled ?? true
    this.#unsupportedReason = options.unsupportedReason
    this.typertRemote = Object.freeze({
      service: this,
      serviceKey: USAGE_SERVICE_KEY,
      namespace: USAGE_NAMESPACE,
    })
  }

  /** What this collector can do right now. */
  status(): UsageStatus {
    try {
      const status = this.#store.status()
      if (this.#unsupportedReason !== undefined) {
        return { ...status, enabled: false, state: 'unsupported', issueCode: this.#unsupportedReason }
      }
      if (!this.#enabled) return { ...status, enabled: false, state: 'disabled' }
      return status
    } catch (error) {
      throw wireFailure(error, 'the usage queue could not be read')
    }
  }

  /**
   * Read one page.
   * @param request - `{collectorId, afterSeq, limit?, maxBytes?}`.
   * @returns the page.
   */
  read(request: unknown): UsageBatch {
    try {
      return this.#store.read(parseReadRequest(request))
    } catch (error) {
      throw wireFailure(error, 'the usage page could not be read')
    }
  }

  /**
   * Acknowledge a prefix.
   * @param request - `{collectorId, throughSeq}`.
   * @returns the new watermark.
   */
  ack(request: unknown): UsageAckResult {
    try {
      return this.#store.ack(parseAckRequest(request))
    } catch (error) {
      throw wireFailure(error, 'the acknowledgement could not be recorded')
    }
  }
}

/**
 * Turn one failure into a declared Remote failure without leaking host detail.
 *
 * `nodeUsage/*` codes survive because DSH recognises a business failure
 * structurally; anything unexpected becomes `nodeUsage/storage-unavailable` rather
 * than an internal error, because the caller's next move (retry later) is the same.
 */
function wireFailure(error: unknown, fallback: string): Error {
  if (isUsageError(error)) {
    return remoteError(error.code, error.message, error.details)
  }
  const message = error instanceof Error ? error.message : String(error)
  return remoteError('nodeUsage/storage-unavailable', `${fallback}: ${message}`, {})
}
