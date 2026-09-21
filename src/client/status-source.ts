/**
 * Where the footer entry gets its state: one read-only route, polled.
 *
 * Polling rather than a push channel, on purpose. A status dot must not cost
 * anything when nobody is looking at it: the cadence is slow while the entry is
 * closed (15 s), faster while the popover is open (2 s), and every tick is skipped
 * while the window is hidden. There is no socket to go half-open, no reconnect
 * policy, and nothing to clean up if the sidebar remounts the entry.
 *
 * The controller below is deliberately framework-free: the React hook at the
 * bottom is a thin wrapper, so the cadence rules are testable with fake timers and
 * a fake fetch — no DOM, no renderer, no timers left running in a test.
 *
 * @module dsh-node/client/status-source
 */

import type { NodeUiInput } from './mapping.js'

/** The status route this client reads. Relative, so it follows whatever host serves the page. */
export const STATUS_PATH = '/dsh-node/api/status'

/** Cadence while the popover is closed: one poll per 15 seconds. */
export const IDLE_INTERVAL_MS = 15_000

/** Cadence while the popover is open: fast enough to watch a reconnect happen. */
export const OPEN_INTERVAL_MS = 2_000

/** The status payload, as much of it as this UI reads. */
export interface NodeStatusSnapshot {
  readonly state: string
  readonly nodeId?: string
  readonly nodeName?: string
  readonly role?: string
  readonly coordinatorOrigin?: string
  readonly connectionId?: string
  readonly reconnectAttempt?: number
  readonly lastConnectedAt?: string
  readonly lastError?: { readonly code?: string; readonly message?: string; readonly at?: string }
  readonly inFlightRequests?: number
  readonly activeStreams?: number
  readonly pluginVersion?: string
  readonly mode?: string
  readonly uptimeMs?: number
  readonly updatedAt?: string
}

/** The full input the popover renders, beyond the row's mapping. */
export interface NodeStatusResult {
  readonly input: NodeUiInput
  /** Present only when a poll succeeded and the payload was usable. */
  readonly snapshot?: NodeStatusSnapshot
  /** Consecutive successful polls, so the popover can show freshness. */
  readonly polls: number
}

/** Minimal `fetch` surface, so a test can supply one. */
export type StatusFetcher = (signal: AbortSignal) => Promise<NodeStatusSnapshot>

/**
 * Read the status route once.
 * @param signal - abort signal, cancelled when the entry unmounts.
 * @returns the parsed snapshot.
 * @throws Error with a human-readable reason on any failure.
 */
export const fetchNodeStatus: StatusFetcher = async (signal) => {
  const response = await fetch(STATUS_PATH, {
    method: 'GET',
    headers: { accept: 'application/json' },
    // The route sends `no-store`; this keeps an intermediary from disagreeing.
    cache: 'no-store',
    signal,
  })
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  const body = (await response.json()) as { ok?: unknown; value?: unknown; error?: { code?: unknown } }
  if (body.ok !== true || typeof body.value !== 'object' || body.value === null) {
    const code = typeof body.error?.code === 'string' ? body.error.code : 'unknown-error'
    throw new Error(code)
  }
  const value = body.value as NodeStatusSnapshot
  if (typeof value.state !== 'string') throw new Error('响应缺少 state 字段')
  return value
}

/** Timer seam, so tests drive the cadence instead of waiting on it. */
export interface PollerTimers {
  setTimeout(callback: () => void, ms: number): { cancel(): void }
}

const systemPollerTimers: PollerTimers = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms)
    return { cancel: () => { clearTimeout(handle) } }
  },
}

/** Options for {@link createStatusPoller}. */
export interface StatusPollerOptions {
  /** Called with every new input, including the first `loading` one. */
  readonly onResult: (result: NodeStatusResult) => void
  /** How to read the status route. Defaults to {@link fetchNodeStatus}. */
  readonly fetchStatus?: StatusFetcher
  /** Bridge to the host's `setTimeout`. */
  readonly timers?: PollerTimers
  /** Whether the window is hidden right now. Defaults to `document.hidden`. */
  readonly isHidden?: () => boolean
}

/** A running poller. */
export interface StatusPoller {
  /** Poll immediately, then keep polling at the current cadence. */
  start(): void
  /** Stop polling and cancel the pending timer. Idempotent. */
  stop(): void
  /** Switch cadence, e.g. when the popover opens or closes. */
  setOpen(open: boolean): void
  /** Poll once right now, off-cadence (used when the popover opens). */
  refresh(): void
}

/**
 * Create the poller.
 * @param options - result sink, fetcher, timers, and visibility probe.
 * @returns the poller.
 */
export function createStatusPoller(options: StatusPollerOptions): StatusPoller {
  const fetchStatus = options.fetchStatus ?? fetchNodeStatus
  const timers = options.timers ?? systemPollerTimers
  const isHidden = options.isHidden ?? (() => typeof document !== 'undefined' && document.hidden)

  let running = false
  let open = false
  let timer: { cancel(): void } | undefined
  let controller: AbortController | undefined
  let polls = 0
  let lastSnapshot: NodeStatusSnapshot | undefined

  /** Emit one result, keeping the last good snapshot visible across failures. */
  const emit = (input: NodeUiInput): void => {
    options.onResult({
      input,
      ...(lastSnapshot === undefined ? {} : { snapshot: lastSnapshot }),
      polls,
    })
  }

  const poll = async (): Promise<void> => {
    if (!running) return
    controller?.abort()
    controller = new AbortController()
    try {
      const snapshot = await fetchStatus(controller.signal)
      if (!running) return
      lastSnapshot = snapshot
      polls += 1
      emit({ kind: 'status', state: snapshot.state, ...(snapshot.lastError?.code === undefined ? {} : { lastErrorCode: snapshot.lastError.code }), ...(snapshot.reconnectAttempt === undefined ? {} : { reconnectAttempt: snapshot.reconnectAttempt }) })
    } catch (error) {
      if (!running) return
      // An abort is this poller's own doing — a newer poll superseded this one, or
      // the entry unmounted. Reporting it as a failure would flash "unavailable"
      // every time the popover opens fast enough to overlap a tick.
      if ((error as { name?: string }).name === 'AbortError') return
      const reason = error instanceof Error ? error.message : String(error)
      // Rule 1 in mapping.ts: a broken poll is reported as itself, never as a
      // node state. The last good snapshot is kept so the popover can still show
      // what was true a moment ago.
      emit({ kind: 'unavailable', reason })
    }
  }

  const schedule = (): void => {
    timer?.cancel()
    if (!running) return
    timer = timers.setTimeout(() => {
      timer = undefined
      // A hidden window is not looking; skipping the tick keeps a backgrounded
      // app from polling forever for nobody.
      if (!isHidden()) void poll().then(schedule)
      else schedule()
    }, open ? OPEN_INTERVAL_MS : IDLE_INTERVAL_MS)
  }

  return {
    start: () => {
      if (running) return
      running = true
      emit({ kind: 'loading' })
      void poll().then(schedule)
    },
    stop: () => {
      running = false
      timer?.cancel()
      timer = undefined
      controller?.abort()
      controller = undefined
    },
    setOpen: (next) => {
      if (open === next) return
      open = next
      // Re-arm at the new cadence, and refresh at once so opening the popover
      // never shows a value that is up to 15 seconds old.
      if (running) {
        schedule()
        if (next) void poll()
      }
    },
    refresh: () => {
      if (running) void poll()
    },
  }
}
