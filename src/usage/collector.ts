/**
 * The runtime observation point: one listener on the `llm/stream` waterfall.
 *
 * Measured on the real host (Electron 44.7.0 / Node 24.21.0, DSH `@deepseek-ai/dsh-llm`),
 * the runtime builds a stream like this:
 *
 * ```ts
 * streamWithRegistration(options, prepared) {
 *   return this.ctx.waterfall(this, 'llm/stream', options, () => this.adapterStream(options, prepared))
 * }
 * ```
 *
 * so a listener sees the exact `GenerateOptions` of the call — `provider`, `model`,
 * optional `sessionId`, optional `purpose` — and can wrap the adapter's iterable.
 * That is the widest point that still covers **every** model call: the agent loop,
 * retries (each re-run is a new `stream()` call), compaction, session-title
 * generation, and native sub-agent calls all arrive here, because this service is
 * the only supported path into a provider adapter.
 *
 * What this listener must not do is change the stream. Every chunk is yielded
 * unchanged, exceptions propagate, an early `return()` by the consumer closes the
 * adapter's iterator exactly as before, and a storage failure only produces an issue
 * callback — never a different chunk, and never a swallowed error.
 *
 * @module dsh-node/usage/collector
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { NodeUsageStore } from './store.js'
import {
  emptyUsage,
  normalizeUsage,
  type AttemptSnapshot,
  type AttemptState,
  type Purpose,
  type UsageSample,
} from './types.js'

/** The part of a `GenerateOptions` this collector reads. */
interface GenerateOptionsLike {
  readonly provider?: unknown
  readonly model?: unknown
  readonly sessionId?: unknown
  readonly purpose?: unknown
  readonly signal?: unknown
}

/** The chunk shapes this collector inspects. */
interface ChunkLike {
  readonly type?: unknown
  readonly usage?: unknown
  readonly reason?: unknown
}

/** Options for {@link installUsageCollector}. */
export interface UsageCollectorOptions {
  /** Injectable clock. */
  readonly now?: () => number
  /** Called with a short, secret-free description when recording fails. */
  readonly onIssue?: (issue: { readonly code: string; readonly message: string }) => void
}

/** What installing produced. */
export interface UsageCollector {
  /** Remove the listener. Async because a Cordis disposer may be. */
  dispose(): Promise<void>
  /** How many attempts have been recorded since installation. */
  readonly recorded: number
}

/**
 * Install the observer on a plugin-level effect.
 *
 * Exactly one listener, installed once, independent of the connection: pausing the
 * network, rebuilding the transport host, or changing the Coordinator URL must not
 * stop local collection, and it must not install a second observer either.
 * @param ctx - the Cordis context.
 * @param store - the durable queue.
 * @param options - clock and issue sink.
 * @returns a handle that removes the listener.
 */
export function installUsageCollector(
  ctx: Context,
  store: NodeUsageStore,
  options: UsageCollectorOptions = {},
): UsageCollector {
  const now = options.now ?? (() => Date.now())
  let recorded = 0

  /** Record one revision, never letting a storage failure reach the stream. */
  const persist = (snapshot: AttemptSnapshot): void => {
    try {
      store.appendAttempt(snapshot)
      recorded += 1
    } catch (error) {
      const failure = error as { code?: unknown; message?: unknown }
      options.onIssue?.({
        code: typeof failure.code === 'string' ? failure.code : 'nodeUsage/storage-unavailable',
        message: typeof failure.message === 'string' ? failure.message : String(error),
      })
    }
  }

  const listener = (generateOptions: GenerateOptionsLike, next: () => AsyncIterable<ChunkLike>): AsyncIterable<ChunkLike> => {
    /*
      Written as an async generator so nothing is recorded until the consumer
      actually iterates: the contract counts *executed* runtime calls, and a
      `ctx.llm.stream()` that is created and dropped was never one.
    */
    return (async function* observe(): AsyncGenerator<ChunkLike> {
      const startedAt = new Date(now()).toISOString()
      const attemptId = randomUUID()
      const base = {
        attemptId,
        startedAt,
        provider: textOrNull(generateOptions.provider),
        model: textOrNull(generateOptions.model),
        sessionId: textOrNull(generateOptions.sessionId),
        purpose: purposeOf(generateOptions),
        source: 'runtime' as const,
      }
      let usage: UsageSample = emptyUsage()
      let usageReported = false
      let terminal = false
      let endedAt: string | null = null

      const snapshot = (state: AttemptState): AttemptSnapshot => ({
        ...base,
        endedAt,
        state,
        usageReported,
        usage,
      })

      persist(snapshot('running'))

      const iterator = next()[Symbol.asyncIterator]()
      try {
        for (;;) {
          const item = await iterator.next()
          if (item.done === true) {
            /*
              A stream that ended without a `finish` chunk violates the runtime's
              own protocol ("every stream ends in exactly one terminal finish").
              Recording it as failed is the honest reading: something ended it
              early, and it was not a normal completion.
            */
            if (!terminal) {
              terminal = true
              endedAt = new Date(now()).toISOString()
              const state: AttemptState = signalAborted(generateOptions.signal) ? 'cancelled' : 'failed'
              persist(snapshot(state))
              options.onIssue?.({ code: 'nodeUsage/no-finish', message: 'the stream ended without a finish chunk' })
            }
            return
          }
          const chunk = item.value
          const type = chunk?.type
          if (type === 'usage') {
            const normalized = normalizeUsage(chunk.usage)
            usage = normalized.usage
            // `reported` is what separates "the provider said nothing" from "the
            // provider said zero"; it is not inferred from the buckets.
            usageReported = usageReported || normalized.reported
            for (const issue of normalized.issues) {
              options.onIssue?.({ code: 'nodeUsage/usage-invalid', message: issue })
            }
            // A revision, not an addition: the same attempt's later sample
            // replaces the earlier one.
            if (!terminal) persist(snapshot('running'))
          } else if (type === 'finish') {
            terminal = true
            endedAt = new Date(now()).toISOString()
            persist(snapshot(stateOf(chunk.reason)))
          }
          yield chunk
        }
      } catch (error) {
        if (!terminal) {
          terminal = true
          endedAt = new Date(now()).toISOString()
          // `return()` by the consumer arrives here as a return, not a throw, so a
          // throw means the adapter or the consumer failed.
          const state: AttemptState = signalAborted(generateOptions.signal) ? 'cancelled' : 'failed'
          persist(snapshot(state))
        }
        throw error
      } finally {
        /*
          An early exit — `break`, `return()`, an aborted signal — leaves the
          attempt without a terminal chunk. Closing the source iterator is the
          runtime's own contract; recording the cancellation is ours.
        */
        if (!terminal) {
          terminal = true
          endedAt = new Date(now()).toISOString()
          persist(snapshot('cancelled'))
        }
        const close = iterator.return?.bind(iterator)
        if (close !== undefined) {
          try {
            await close()
          } catch {
            // The consumer is already gone; a close failure changes nothing it can see.
          }
        }
      }
    })()
  }

  // Installed globally: the waterfall is serviced by the LLM runtime's own
  // context, and the node's plugin fiber is not its parent.
  const events = ctx as unknown as {
    on(
      name: string,
      handler: (options: GenerateOptionsLike, next: () => AsyncIterable<ChunkLike>) => AsyncIterable<ChunkLike>,
      listenerOptions: { readonly global: true },
    ): () => boolean
  }
  const disposeListener = events.on('llm/stream', listener, { global: true })

  return {
    dispose: async () => {
      disposeListener()
    },
    get recorded() {
      return recorded
    },
  }
}

/** Map the runtime's finish reason onto the contract's attempt state. */
export function stateOf(reason: unknown): AttemptState {
  if (typeof reason !== 'object' || reason === null) return 'failed'
  const kind = (reason as { kind?: unknown }).kind
  if (kind === 'error') return 'failed'
  if (kind === 'aborted') return 'cancelled'
  // `stop`, `tool-calls`, `max-tokens`: the model finished normally. A length stop
  // is a completed call, not a transport failure.
  return 'completed'
}

/** Derive the purpose, per the contract's fallback order. */
function purposeOf(options: GenerateOptionsLike): Purpose {
  const raw = options.purpose
  if (raw === 'compaction' || raw === 'session-title') return raw
  if (raw !== undefined && raw !== null) return 'other'
  return options.sessionId === undefined || options.sessionId === null ? 'other' : 'conversation'
}

/** Whether the call's signal was aborted. */
function signalAborted(signal: unknown): boolean {
  return typeof signal === 'object' && signal !== null && (signal as { aborted?: unknown }).aborted === true
}

/** A bounded string or null. */
function textOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null
  return value.length > 256 ? value.slice(0, 256) : value
}
