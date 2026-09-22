/**
 * The footer entry's brain: status → what the row shows, and the polling cadence.
 *
 * Both are tested without a browser. The mapping is a pure function, and the poller
 * takes its fetcher, its timers, and its visibility probe as options — so these
 * tests drive time by hand and assert the three rules that keep the UI honest:
 * a failed poll is not "unconfigured", unknown is not empty, and an abort is not a
 * failure.
 *
 * @module dsh-node/test/client-status
 */

import { describe, expect, it } from 'vitest'
import { isKnownState, nodeVisual, NODE_ENTRY_LABEL, toneColor, unavailableHint, UNCONFIGURED_HINT } from '../src/client/mapping.js'
import {
  createStatusPoller,
  IDLE_INTERVAL_MS,
  OPEN_INTERVAL_MS,
  type NodeStatusResult,
  type NodeStatusSnapshot,
  type PollerTimers,
} from '../src/client/status-source.js'

/** A manually advanced timer source: nothing fires until the test says so. */
function manualTimers(): PollerTimers & { advance(ms: number): Promise<void>; pending: number } {
  let now = 0
  let seq = 0
  const scheduled = new Map<number, { at: number; callback: () => void }>()
  return {
    get pending() { return scheduled.size },
    setTimeout: (callback, ms) => {
      seq += 1
      const id = seq
      scheduled.set(id, { at: now + ms, callback })
      return { cancel: () => { scheduled.delete(id) } }
    },
    async advance(ms: number) {
      const target = now + ms
      for (;;) {
        const due = [...scheduled.entries()].filter(([, entry]) => entry.at <= target).sort((a, b) => a[1].at - b[1].at)
        const next = due[0]
        if (next === undefined) break
        scheduled.delete(next[0])
        now = next[1].at
        next[1].callback()
        await new Promise<void>(resolve => { setImmediate(resolve) })
      }
      now = target
      await new Promise<void>(resolve => { setImmediate(resolve) })
    },
  }
}

/** A fetcher whose answers the test controls, counting its calls. */
function scriptedFetcher(): {
  readonly calls: () => number
  readonly fetcher: (signal: AbortSignal) => Promise<NodeStatusSnapshot>
  answer(snapshot: NodeStatusSnapshot): void
  fail(message: string): void
  hang(): void
} {
  let calls = 0
  let mode: { kind: 'answer'; snapshot: NodeStatusSnapshot } | { kind: 'fail'; message: string } | { kind: 'hang' } = {
    kind: 'answer',
    snapshot: { state: 'ready' },
  }
  return {
    calls: () => calls,
    fetcher: async (signal) => {
      calls += 1
      if (mode.kind === 'hang') {
        return await new Promise<NodeStatusSnapshot>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
        })
      }
      if (mode.kind === 'fail') throw new Error(mode.message)
      return mode.snapshot
    },
    answer: (snapshot) => { mode = { kind: 'answer', snapshot } },
    fail: (message) => { mode = { kind: 'fail', message } },
    hang: () => { mode = { kind: 'hang' } },
  }
}

describe('state → visual', () => {
  it('maps every node state to a distinct, described tone', () => {
    const states = ['unconfigured', 'stopped', 'connecting', 'authenticating', 'ready', 'backoff', 'auth_failed', 'closing'] as const
    const tones = new Map<string, string>()
    for (const state of states) {
      const visual = nodeVisual({ kind: 'status', state })
      expect(visual.detail, state).toContain(NODE_ENTRY_LABEL)
      expect(visual.label, state).not.toBe('')
      tones.set(state, `${visual.tone}/${visual.dot}`)
    }
    // Every state has a shape of its own: colour alone never carries the meaning.
    expect(new Set(tones.values()).size).toBeGreaterThanOrEqual(4)
    expect(nodeVisual({ kind: 'status', state: 'ready' })).toMatchObject({ tone: 'ok', dot: 'solid', label: '已连接' })
    expect(nodeVisual({ kind: 'status', state: 'unconfigured' })).toMatchObject({ tone: 'idle', dot: 'hollow' })
    expect(nodeVisual({ kind: 'status', state: 'connecting' })).toMatchObject({ tone: 'pending', dot: 'ring', animated: true })
    expect(nodeVisual({ kind: 'status', state: 'auth_failed' })).toMatchObject({ tone: 'bad', dot: 'alert' })
  })

  it('explains why, and how many retries, in the tooltip', () => {
    expect(nodeVisual({ kind: 'status', state: 'unconfigured' }).detail).toContain('coordinatorUrl')
    expect(nodeVisual({ kind: 'status', state: 'auth_failed', lastErrorCode: 'node/auth-failed' }).detail)
      .toContain('node/auth-failed')
    expect(nodeVisual({ kind: 'status', state: 'backoff', reconnectAttempt: 3, lastErrorCode: 'node/handshake-timeout' }).detail)
      .toContain('第 3 次')
    expect(nodeVisual({ kind: 'status', state: 'stopped' }).detail).toContain('人工')
  })

  it('says "reading" before the first answer, and never guesses a state', () => {
    const visual = nodeVisual({ kind: 'loading' })
    expect(visual.label).toBe('读取中')
    expect(visual.tone).toBe('unknown')
    expect(visual.detail).toContain('正在读取')
  })

  it('reports a failed poll as unavailable, never as unconfigured', () => {
    // The rule that keeps a UI bug from masquerading as a configuration problem.
    const visual = nodeVisual({ kind: 'unavailable', reason: 'HTTP 404' })
    expect(visual.tone).toBe('unknown')
    expect(visual.label).toBe('状态不可用')
    expect(visual.detail).toContain('HTTP 404')
    expect(visual.detail).not.toContain('未配置')
  })

  it('admits an unknown state instead of inventing a tone for it', () => {
    const visual = nodeVisual({ kind: 'status', state: 'quantum' })
    expect(visual.label).toBe('未知状态')
    expect(visual.detail).toContain('quantum')
    expect(isKnownState('quantum')).toBe(false)
    expect(isKnownState('ready')).toBe(true)
    // A prototype key must not be mistaken for a state.
    expect(isKnownState('constructor')).toBe(false)
  })

  it('gives every tone a theme variable, so it follows light and dark', () => {
    for (const tone of ['idle', 'pending', 'ok', 'bad', 'unknown'] as const) {
      expect(toneColor(tone)).toContain('var(--dsw-alias')
    }
  })

  it('tells an unconfigured operator exactly what to do, form first and file second', () => {
    // The copy lives with the mapping so the panel and the tooltip cannot drift
    // apart; this is also the text the user asked for when they clicked the row.
    //
    // Order matters and is asserted: the form sits directly under this sentence, so
    // naming a YAML file *before* it (which is what this text used to do) taught
    // people to ignore the thing that would have fixed their node in one click.
    expect(UNCONFIGURED_HINT.indexOf('协调器地址')).toBeLessThan(UNCONFIGURED_HINT.indexOf('cordis.patch.yml'))
    // And the file / environment route stays documented as the alternative.
    expect(UNCONFIGURED_HINT).toContain('cordis.patch.yml')
    expect(UNCONFIGURED_HINT).toContain('coordinatorUrl')
    expect(UNCONFIGURED_HINT).toContain('auth.token')
    expect(UNCONFIGURED_HINT).toContain('DSH_NODE_TOKEN')
    // A save applies immediately now, so the sentence must not send anyone to a
    // restart they do not need.
    expect(UNCONFIGURED_HINT).toContain('不用重启 DSH')
    expect(UNCONFIGURED_HINT).toContain('优先级最高')
  })

  it('separates "the panel could not read" from "the node is not configured"', () => {
    const hint = unavailableHint('HTTP 500')
    expect(hint).toContain('HTTP 500')
    expect(hint).toContain('不代表节点未配置')
  })
})

describe('the status poller', () => {
  /** Build a poller with a fake fetcher and manual timers. */
  function create(options: { readonly hidden?: () => boolean } = {}) {
    const results: NodeStatusResult[] = []
    const fetcher = scriptedFetcher()
    const timers = manualTimers()
    const poller = createStatusPoller({
      onResult: result => results.push(result),
      fetchStatus: fetcher.fetcher,
      timers,
      isHidden: options.hidden ?? (() => false),
    })
    return { poller, results, fetcher, timers, latest: () => results.at(-1) }
  }

  it('emits loading first, then the first observed state', async () => {
    const { poller, results, fetcher, latest } = create()
    poller.start()
    expect(latest()?.input).toEqual({ kind: 'loading' })
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(latest()?.input).toEqual({ kind: 'status', state: 'ready' })
    expect(latest()?.polls).toBe(1)
    expect(fetcher.calls()).toBe(1)
    poller.stop()
    expect(results.length).toBeGreaterThanOrEqual(2)
  })

  it('polls slowly while closed and quickly while open, and refreshes on open', async () => {
    const { poller, fetcher, timers } = create()
    poller.start()
    await new Promise<void>(resolve => { setImmediate(resolve) })
    const afterFirst = fetcher.calls()

    // Closed: nothing happens until the idle interval elapses.
    await timers.advance(IDLE_INTERVAL_MS - 1)
    expect(fetcher.calls()).toBe(afterFirst)
    await timers.advance(1)
    expect(fetcher.calls()).toBe(afterFirst + 1)

    // Opening refreshes immediately and switches to the fast cadence.
    poller.setOpen(true)
    await new Promise<void>(resolve => { setImmediate(resolve) })
    const afterOpen = fetcher.calls()
    expect(afterOpen).toBeGreaterThan(afterFirst + 1)
    await timers.advance(OPEN_INTERVAL_MS)
    expect(fetcher.calls()).toBe(afterOpen + 1)
    poller.stop()
  })

  it('skips a tick while the window is hidden, and resumes without help', async () => {
    let hidden = true
    const { poller, fetcher, timers } = create({ hidden: () => hidden })
    poller.start()
    await new Promise<void>(resolve => { setImmediate(resolve) })
    const afterFirst = fetcher.calls()

    await timers.advance(IDLE_INTERVAL_MS * 3)
    // Nothing was fetched while hidden — but the timer kept re-arming, so the next
    // tick after the window is shown is already scheduled.
    expect(fetcher.calls()).toBe(afterFirst)
    hidden = false
    await timers.advance(IDLE_INTERVAL_MS)
    expect(fetcher.calls()).toBe(afterFirst + 1)
    poller.stop()
  })

  it('keeps the last good snapshot when a poll fails, and reports the reason', async () => {
    const { poller, latest, fetcher, timers } = create()
    poller.start()
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(latest()?.snapshot?.state).toBe('ready')

    fetcher.fail('HTTP 500')
    await timers.advance(IDLE_INTERVAL_MS)
    expect(latest()?.input).toEqual({ kind: 'unavailable', reason: 'HTTP 500' })
    // The popover can still show what was true a moment ago.
    expect(latest()?.snapshot?.state).toBe('ready')
    poller.stop()
  })

  it('does not report its own abort as a failure', async () => {
    const { poller, results, fetcher } = create()
    fetcher.hang()
    poller.start()
    await new Promise<void>(resolve => { setImmediate(resolve) })

    // A second poll supersedes the first; the aborted one must stay silent.
    fetcher.answer({ state: 'backoff' })
    poller.refresh()
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(results.some(result => result.input.kind === 'unavailable')).toBe(false)
    expect(results.at(-1)?.input).toEqual({ kind: 'status', state: 'backoff' })
    poller.stop()
  })

  it('stops cleanly: no pending timer, and a late answer is ignored', async () => {
    const { poller, results, fetcher, timers } = create()
    fetcher.hang()
    poller.start()
    await new Promise<void>(resolve => { setImmediate(resolve) })
    const before = results.length

    poller.stop()
    expect(timers.pending).toBe(0)
    fetcher.answer({ state: 'ready' })
    await new Promise<void>(resolve => { setImmediate(resolve) })
    // Nothing new was emitted: a stopped poller is silent.
    expect(results.length).toBe(before)
  })

  it('ignores a second start, so a remount cannot double the cadence', async () => {
    const { poller, fetcher } = create()
    poller.start()
    poller.start()
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(fetcher.calls()).toBe(1)
    poller.stop()
  })
})
