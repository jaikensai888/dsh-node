/**
 * The session projection that reports the most recent successful turn.
 *
 * `dsh-master`'s follow list needs one fact per session: the durable seq of the
 * latest `turn/end` whose reason is `completed`. `running` cannot answer it —
 * a short turn can start and finish between two list polls, and failure or
 * cancellation must not raise the reminder — so the node publishes it as a
 * session-projection summary value (`projections.values.lastCompletedSeq`),
 * which the coordinator forwards verbatim inside `session/list`.
 *
 * The contract is `number | null`:
 *
 * - a non-negative safe integer: the seq of the latest successful turn end;
 * - `null`: this node supports the summary and no turn has succeeded yet;
 * - absent: no summary is available (an older node), so the caller keeps its
 *   own baseline instead of inventing one.
 *
 * The fold is monotonic and reference-stable: every event that is not a
 * successful `turn/end` returns the same state object, which is what suppresses
 * downstream work in the projection registry.
 *
 * @module dsh-node/completion
 */

import type { Context } from '@deepseek-ai/cordis'

/** The value this projection publishes: the latest successful turn-end seq. */
export type LastCompletedSeq = number | null

/** One committed session event, reduced to what the fold reads. */
export interface CompletionEventLike {
  readonly type?: string
  readonly seq?: number
  readonly data?: {
    readonly reason?: { readonly kind?: string }
  }
}

/**
 * The parse-only schema surface the projection registry uses.
 *
 * The registry validates persisted state and wire views with `zod`, but only
 * ever calls `parse`. Declaring the two methods we need keeps this plugin free
 * of a `zod` dependency and of a second schema ecosystem; the state is a single
 * nullable integer, so the check is total and cheap.
 */
export interface ParseOnlySchema<T> {
  parse(value: unknown): T
}

/** Schema for {@link LastCompletedSeq}. */
export const lastCompletedSeqSchema: ParseOnlySchema<LastCompletedSeq> = {
  parse(value: unknown): LastCompletedSeq {
    if (value === null) return null
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
    throw new Error(`lastCompletedSeq must be null or a non-negative safe integer, got ${describe(value)}`)
  },
}

/**
 * The projection definition, shaped like `ProjectionDefinition` without
 * importing it: this plugin stays independent of the host's DSH package set and
 * talks to `ctx.sessionProjections` structurally, exactly like it talks to the
 * Typert Gateway.
 */
export const lastCompletedSeqProjection = {
  key: 'lastCompletedSeq',
  stateSchema: lastCompletedSeqSchema,
  init: (): LastCompletedSeq => null,
  /**
   * Fold one committed event.
   *
   * Only `turn/end` with `reason.kind === 'completed'` counts: `aborted`,
   * `error`, `blocked`, `max-tokens` and `interrupted` all leave the previous
   * success (or `null`) untouched, so a failed retry can never look like an
   * unread result.
   * @param state - state covering every earlier event.
   * @param event - the next committed event.
   * @returns the next state; the same reference when this event is not a success.
   */
  apply(state: LastCompletedSeq, event: CompletionEventLike): LastCompletedSeq {
    if (event.type !== 'turn/end' || event.data?.reason?.kind !== 'completed') return state
    const seq = event.seq
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return state
    // Events are ordered, but a fork can replay an inherited prefix; keep the max
    // so a replayed older success cannot move the watermark backwards.
    return state === null || seq > state ? seq : state
  },
  wire: {
    viewSchema: lastCompletedSeqSchema,
    view: (state: LastCompletedSeq): LastCompletedSeq => state,
  },
  stateVersion: 1,
}

/** The registration surface of `ctx.sessionProjections` this module needs. */
export interface SessionProjectionRegistryLike {
  /**
   * Register the unit; the returned hybrid value is both a promise for the ready
   * handle and the effect disposer.
   * @param definition - the projection definition.
   */
  register(definition: unknown): Promise<{ dispose(): Promise<void> }> & (() => Promise<void>)
}

/** What this module reads off the Cordis context. */
export interface CompletionHostContext {
  inject(names: readonly string[], callback: (scoped: Context) => void): void
}

/** Where registration problems go; the node must keep working without the summary. */
export interface CompletionProjectionOptions {
  readonly onFailure?: (error: unknown) => void
}

/**
 * Register the completion projection on the host, once.
 *
 * The service is injected rather than required: a profile without the projection
 * registry (or an older DSH that has no such seam) simply gets no summary field,
 * and `dsh-master` falls back to its previous behaviour.
 *
 * @param ctx - the plugin context.
 * @param options - failure sink; registration failures are reported, never thrown.
 * @returns a disposer that releases the registration.
 */
export function registerCompletionProjection(
  ctx: CompletionHostContext,
  options: CompletionProjectionOptions = {},
): () => void {
  let disposed = false
  let release: (() => Promise<void>) | undefined
  ctx.inject(['sessionProjections'], (scoped: Context) => {
    if (disposed) return
    const registry = (scoped as unknown as { sessionProjections?: SessionProjectionRegistryLike }).sessionProjections
    if (registry === undefined) return
    const registration = registry.register(lastCompletedSeqProjection)
    void registration.catch((error: unknown) => {
      options.onFailure?.(error)
    })
    scoped.effect(() => () => {
      disposed = true
      release = undefined
      void registration().catch((error: unknown) => {
        options.onFailure?.(error)
      })
    }, 'dsh-node: lastCompletedSeq projection')
    release = () => registration()
  })
  return () => {
    disposed = true
    if (release !== undefined) void release()
  }
}

/** Render an arbitrary value for one error message without trusting its shape. */
function describe(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  return typeof value
}
