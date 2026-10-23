/**
 * The node's durable usage queue.
 *
 * One SQLite file per profile, one collector identity, one monotonically increasing
 * sequence. Everything the Coordinator can ever read is an immutable event in
 * `outbox`; `attempts` is only a convenience copy of the newest snapshot, and
 * `collector_meta` is the watermark state.
 *
 * The properties that matter, and why they are implemented this way:
 *
 * - **Sequence allocation and the event commit together.** A sequence number that
 *   was consumed by a failed write would leave a permanent hole the Coordinator
 *   cannot distinguish from data loss.
 * - **A revision is an event, not an update.** An attempt moves running -> completed
 *   by appending a new sequence carrying the full snapshot. A reader that missed
 *   the first revision still ends up with the right answer.
 * - **ACK is a watermark, not a delete.** Acknowledging advances a counter; cleanup
 *   only removes events older than the 24-hour safety window, so a Coordinator that
 *   lost its ACK can re-read the page.
 * - **Never delete unacknowledged data.** Not on capacity pressure, not on rotation,
 *   not on close.
 *
 * @module dsh-node/usage/store
 */

import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { storageUnavailable, UsageError } from './errors.js'
import { inTransaction, openSqliteDatabase, type SqlDatabase, type SqlDriverName } from './sqlite.js'
import {
  decimal,
  eventBytes,
  MAX_EVENT_BYTES,
  MAX_READ_LIMIT,
  MAX_SQLITE_INTEGER,
  parseDecimal,
  type AttemptSnapshot,
  type ReplayGap,
  type UsageAckRequest,
  type UsageAckResult,
  type UsageBatch,
  type UsageEvent,
  type UsageReadRequest,
  type UsageStatus,
} from './types.js'

/** The default capacity ceiling: the database plus its WAL. */
export const DEFAULT_MAX_BYTES = 268_435_456

/** How long acknowledged events are kept for a late or restarted reader. */
export const ACK_RETENTION_MS = 24 * 60 * 60 * 1000

/** The fraction of the ceiling at which the UI is warned. */
export const CAPACITY_WARN_RATIO = 0.9

/** Options for {@link NodeUsageStore}. */
export interface NodeUsageStoreOptions {
  /** Absolute path to `usage.sqlite`. */
  readonly file: string
  /** The node identity this queue belongs to. */
  readonly nodeId: string
  /** Injectable clock. */
  readonly now?: () => number
  /** Capacity ceiling for the database plus WAL. */
  readonly maxBytes?: number
  /** How long acknowledged events are retained. */
  readonly retentionMs?: number
}

/** What a persisted gap names. */
export interface GapInput {
  readonly fromAt: string
  readonly toAt: string
  readonly reason: 'storage-failure' | 'capacity-limit' | 'collector-reset'
}

/** The collector's stored watermark state. */
interface MetaRow {
  collector_id: string
  node_id: string
  next_seq: number | bigint
  latest_issued_seq: number | bigint
  acked_through_seq: number | bigint
  delivered_through_seq: number | bigint
  started_at: string
  coverage: string
  degraded_since: string | null
  issue_code: string | null
  last_recorded_at: string | null
}

/** An event before the store assigns its sequence and timestamp. */
type EventDraft =
  | { readonly kind: 'attempt'; readonly attempt: AttemptSnapshot }
  | {
    readonly kind: 'gap'
    readonly fromAt: string
    readonly toAt: string
    readonly reason: 'storage-failure' | 'capacity-limit' | 'collector-reset'
  }

/**
 * The durable queue.
 */
export class NodeUsageStore {
  readonly #db: SqlDatabase
  readonly #file: string
  readonly #nodeId: string
  readonly #now: () => number
  readonly #maxBytes: number
  readonly #retentionMs: number
  readonly #lockFile: string
  #enabled = true
  #unsupportedReason: string | null = null
  #closed = false

  private constructor(db: SqlDatabase, options: NodeUsageStoreOptions) {
    this.#db = db
    this.#file = options.file
    this.#nodeId = options.nodeId
    this.#now = options.now ?? (() => Date.now())
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.#retentionMs = options.retentionMs ?? ACK_RETENTION_MS
    this.#lockFile = `${options.file}.lock`
  }

  /**
   * Open (or create) the queue and take ownership of it.
   * @param options - path, node identity, clock, and limits.
   * @returns the open store.
   * @throws UsageError `nodeUsage/storage-unavailable` when another process owns it,
   * the schema cannot be created, or the file belongs to another node.
   */
  static open(options: NodeUsageStoreOptions): NodeUsageStore {
    const lock = acquireLock(`${options.file}.lock`)
    let db: SqlDatabase
    try {
      db = openSqliteDatabase(options.file)
    } catch (error) {
      releaseLock(lock)
      throw error
    }
    const store = new NodeUsageStore(db, options)
    try {
      store.#migrate()
      store.#seed(options.nodeId)
      // A previous process that stopped without finishing an attempt left it
      // "running" forever. Declaring it interrupted is honest, and it happens
      // before the collector starts so no new attempt can be confused with it.
      store.interruptRunning()
    } catch (error) {
      try {
        db.close()
      } finally {
        releaseLock(lock)
      }
      throw error
    }
    return store
  }

  /** The collector identity of this queue. */
  get collectorId(): string {
    return String(this.#meta().collector_id)
  }

  /** Which driver is loaded. */
  get driver(): SqlDriverName {
    return this.#db.driver
  }

  /** The database path, for diagnostics. */
  get file(): string {
    return this.#file
  }

  /** The bound node identity. */
  get nodeId(): string {
    return this.#nodeId
  }

  /** Enable or disable collection without losing the queue. */
  setEnabled(enabled: boolean, reason?: string): void {
    this.#enabled = enabled
    this.#unsupportedReason = enabled ? null : (reason ?? null)
  }

  /** Create the schema. Idempotent. */
  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS collector_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        collector_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        next_seq INTEGER NOT NULL,
        latest_issued_seq INTEGER NOT NULL,
        acked_through_seq INTEGER NOT NULL,
        delivered_through_seq INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        coverage TEXT NOT NULL,
        degraded_since TEXT,
        issue_code TEXT,
        last_recorded_at TEXT
      );
      CREATE TABLE IF NOT EXISTS attempts (
        attempt_id TEXT PRIMARY KEY,
        latest_seq INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox (
        seq INTEGER PRIMARY KEY,
        event_json TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        recorded_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outbox_recorded ON outbox(recorded_at);
      CREATE TABLE IF NOT EXISTS coverage_state (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_at TEXT NOT NULL,
        to_at TEXT,
        reason TEXT NOT NULL
      );
    `)
  }

  /** Bind the queue to a node identity, or refuse to reuse another node's data. */
  #seed(nodeId: string): void {
    const row = this.#db.prepare('SELECT * FROM collector_meta WHERE singleton = 1').get()
    if (row === undefined) {
      this.#db.prepare(
        `INSERT INTO collector_meta
           (singleton, collector_id, node_id, next_seq, latest_issued_seq, acked_through_seq,
            delivered_through_seq, started_at, coverage)
         VALUES (1, ?, ?, 0, 0, 0, 0, ?, 'complete')`,
      ).run(randomUUID(), nodeId, new Date(this.#now()).toISOString())
      return
    }
    if (String(row['node_id']) !== nodeId) {
      throw storageUnavailable(
        `the usage queue at ${this.#file} belongs to node ${String(row['node_id'])}, not ${nodeId}; use a separate usage.databaseFile or reset the queue explicitly`,
        { file: this.#file, queueNodeId: String(row['node_id']), nodeId },
      )
    }
  }

  /** The current metadata row. */
  #meta(): MetaRow {
    const row = this.#db.prepare('SELECT * FROM collector_meta WHERE singleton = 1').get()
    if (row === undefined) {
      throw storageUnavailable('the usage queue has no collector state', { file: this.#file })
    }
    return row as unknown as MetaRow
  }

  /**
   * Append one attempt snapshot.
   *
   * The sequence number is allocated inside the same transaction that inserts the
   * event, so a failed write consumes nothing.
   * @param snapshot - the complete snapshot.
   * @returns the sequence number of the new event.
   * @throws UsageError `nodeUsage/storage-unavailable` or `nodeUsage/record-too-large`.
   */
  appendAttempt(snapshot: AttemptSnapshot): string {
    this.#assertOpen()
    if (this.#capacityExceeded()) {
      this.#enterDegraded('capacity-limit', 'capacity-limit')
      throw new UsageError('nodeUsage/storage-full', 'the usage queue is at its capacity limit', {
        file: this.#file,
        maxBytes: decimal(this.#maxBytes),
      })
    }
    // Recovery comes first: the gap must be recorded before the next attempt, or
    // the Coordinator would see a silent hole.
    this.#recoverIfDegraded()
    return this.#appendEvent({ kind: 'attempt', attempt: snapshot })
  }

  /**
   * Append an explicit gap event.
   * @param input - the interval and reason.
   * @returns the sequence number of the gap event.
   */
  appendGap(input: GapInput): string {
    this.#assertOpen()
    return this.#appendEvent({
      kind: 'gap',
      fromAt: input.fromAt,
      toAt: input.toAt,
      reason: input.reason,
    })
  }

  /** Insert one event, allocating its sequence inside the transaction. */
  #appendEvent(event: EventDraft): string {
    try {
      return inTransaction(this.#db, () => {
        const meta = this.#meta()
        const metaSeq = toBigInt(meta.latest_issued_seq)
        if (metaSeq >= MAX_SQLITE_INTEGER) {
          throw new UsageError('nodeUsage/sequence-exhausted', 'the collector sequence reached the SQLite limit', {})
        }
        const seq = toBigInt(meta.next_seq) + 1n
        const recordedAt = new Date(this.#now()).toISOString()
        const full = { seq: decimal(seq), recordedAt, ...event } as UsageEvent
        const json = JSON.stringify(full)
        const bytes = Buffer.byteLength(json, 'utf8')
        if (bytes > MAX_EVENT_BYTES) {
          throw new UsageError('nodeUsage/record-too-large', `one usage event is ${bytes} bytes, over the ${MAX_EVENT_BYTES}-byte limit`, {
            bytes,
          })
        }
        this.#db.prepare('INSERT INTO outbox (seq, event_json, bytes, recorded_at) VALUES (?, ?, ?, ?)')
          .run(seq, json, bytes, recordedAt)
        if (event.kind === 'attempt') {
          /*
            The copy stored here is the *attempt*, not the event envelope.

            `interruptRunning` re-reads this column to build the interrupted
            revision, and a copy that held the envelope would silently lose the
            attempt id — which is exactly the failure this line caused once.
          */
          this.#db.prepare(
            `INSERT INTO attempts (attempt_id, latest_seq, snapshot_json, state, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(attempt_id) DO UPDATE SET
               latest_seq = excluded.latest_seq,
               snapshot_json = excluded.snapshot_json,
               state = excluded.state,
               updated_at = excluded.updated_at`,
          ).run(event.attempt.attemptId, seq, JSON.stringify(event.attempt), event.attempt.state, recordedAt)
        } else {
          this.#db.prepare('INSERT INTO coverage_state (from_at, to_at, reason) VALUES (?, ?, ?)')
            .run(event.fromAt, event.toAt, event.reason)
        }
        this.#db.prepare(
          `UPDATE collector_meta SET next_seq = ?, latest_issued_seq = ?, last_recorded_at = ? WHERE singleton = 1`,
        ).run(seq, seq, recordedAt)
        return decimal(seq)
      })
    } catch (error) {
      if (error instanceof UsageError) throw error
      throw storageUnavailable(`the usage event could not be stored: ${(error as Error).message}`, { file: this.#file })
    }
  }

  /** Mark every attempt the previous process left running as interrupted. */
  interruptRunning(): number {
    const rows = this.#db.prepare('SELECT attempt_id, snapshot_json FROM attempts WHERE state = ?').all('running')
    let count = 0
    for (const row of rows) {
      const parsed = safeSnapshot(row['snapshot_json'])
      if (parsed === undefined) continue
      const snapshot: AttemptSnapshot = {
        ...parsed,
        state: 'process_interrupted',
        endedAt: new Date(this.#now()).toISOString(),
      }
      this.#appendEvent({ kind: 'attempt', attempt: snapshot })
      count += 1
    }
    return count
  }

  /** The collector's status. */
  status(): UsageStatus {
    const meta = this.#meta()
    const latest = toBigInt(meta.latest_issued_seq)
    const acked = toBigInt(meta.acked_through_seq)
    const earliestRow = this.#db.prepare('SELECT MIN(seq) AS seq FROM outbox').get()
    const earliest = earliestRow?.['seq'] === null || earliestRow?.['seq'] === undefined
      ? latest + 1n
      : toBigInt(earliestRow['seq'])
    const pending = this.#db.prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM outbox WHERE seq > ?`,
    ).get(acked)
    const gaps = this.#db.prepare('SELECT COUNT(*) AS count FROM coverage_state').get()
    const gapCount = toBigInt(gaps?.['count'] ?? 0)
    const coverage = gapCount > 0
      ? 'incomplete'
      : meta.issue_code !== null
        ? 'unknown'
        : 'complete'
    return {
      schemaVersion: 1,
      enabled: this.#enabled,
      state: !this.#enabled ? 'disabled' : this.#unsupportedReason !== null ? 'unsupported' : meta.issue_code !== null ? 'degraded' : 'ready',
      collectorId: meta.collector_id,
      startedAt: meta.started_at,
      earliestAvailableSeq: decimal(earliest),
      latestIssuedSeq: decimal(latest),
      ackedThroughSeq: decimal(acked),
      pendingCount: decimal(toBigInt(pending?.['count'] ?? 0)),
      pendingBytes: decimal(toBigInt(pending?.['bytes'] ?? 0)),
      coverage,
      degradedSince: meta.degraded_since,
      issueCode: meta.issue_code ?? this.#unsupportedReason,
    }
  }

  /**
   * Read one page.
   *
   * A caller whose cursor predates the oldest retained event gets an explicit
   * `pruned` gap and the page starting at the oldest event — never a silent skip.
   * @param request - collector id, cursor, and bounds.
   * @returns the page.
   * @throws UsageError `nodeUsage/collector-mismatch`, `nodeUsage/record-too-large`,
   * or `nodeUsage/disabled`.
   */
  read(request: UsageReadRequest): UsageBatch {
    this.#assertOpen()
    const meta = this.#requireCollector(request.collectorId)
    const status = this.status()
    const after = parseDecimal(request.afterSeq)
    if (after === undefined) {
      throw new UsageError('nodeUsage/invalid-arguments', '"afterSeq" is not a decimal sequence number', {})
    }
    if (!this.#enabled) {
      throw new UsageError('nodeUsage/disabled', 'usage collection is disabled on this node', { collectorId: meta.collector_id })
    }

    const earliest = BigInt(status.earliestAvailableSeq)
    const gaps: ReplayGap[] = []
    let from = after
    if (earliest > 0n && after + 1n < earliest) {
      gaps.push({ fromSeq: decimal(after + 1n), throughSeq: decimal(earliest - 1n), reason: 'pruned' })
      from = earliest - 1n
    }

    const limit = Math.max(1, Math.min(MAX_READ_LIMIT, Math.trunc(request.limit)))
    const rows = this.#db.prepare('SELECT seq, event_json, bytes FROM outbox WHERE seq > ? ORDER BY seq ASC LIMIT ?')
      .all(from, limit) as unknown as { seq: number | bigint; event_json: string; bytes: number | bigint }[]

    const envelopeOverhead = 256
    let used = envelopeOverhead
    const events: UsageEvent[] = []
    for (const row of rows) {
      const bytes = Number(row.bytes)
      if (events.length === 0 && bytes + envelopeOverhead > request.maxBytes) {
        // The first record alone does not fit. Refusing is the contract's answer:
        // skipping it would advance the cursor past data nobody stored.
        this.#degrade('record-too-large', 'record-too-large')
        throw new UsageError(
          'nodeUsage/record-too-large',
          `the next usage event is ${bytes} bytes and does not fit in ${request.maxBytes} bytes`,
          { bytes, maxBytes: request.maxBytes },
        )
      }
      if (used + bytes > request.maxBytes) break
      events.push(JSON.parse(row.event_json) as UsageEvent)
      used += bytes
    }

    const lastEvent = events[events.length - 1]
    const lastGap = gaps[gaps.length - 1]
    const nextSeq = lastEvent !== undefined
      ? parseDecimal(lastEvent.seq) as bigint
      : lastGap !== undefined
        ? parseDecimal(lastGap.throughSeq) as bigint
        : after
    const moreRow = this.#db.prepare('SELECT 1 AS more FROM outbox WHERE seq > ? LIMIT 1').get(nextSeq)
    const hasMore = moreRow !== undefined

    const delivered = toBigInt(meta.delivered_through_seq)
    if (nextSeq > delivered) {
      this.#db.prepare('UPDATE collector_meta SET delivered_through_seq = ? WHERE singleton = 1').run(nextSeq)
    }
    return {
      schemaVersion: 1,
      collectorId: meta.collector_id,
      events,
      gaps,
      nextSeq: decimal(nextSeq),
      hasMore,
      status: this.status(),
    }
  }

  /**
   * Acknowledge a delivered prefix.
   *
   * Cumulative and idempotent: an older ACK returns the current watermark instead of
   * lowering it, and an ACK beyond what was delivered is refused because it would
   * authorise deleting data the Coordinator never received.
   * @param request - collector id and watermark.
   * @returns the resulting watermark.
   */
  ack(request: UsageAckRequest): UsageAckResult {
    this.#assertOpen()
    const meta = this.#requireCollector(request.collectorId)
    const through = parseDecimal(request.throughSeq)
    if (through === undefined) {
      throw new UsageError('nodeUsage/invalid-arguments', '"throughSeq" is not a decimal sequence number', {})
    }
    const delivered = toBigInt(meta.delivered_through_seq)
    const current = toBigInt(meta.acked_through_seq)
    if (through > delivered) {
      throw new UsageError(
        'nodeUsage/invalid-arguments',
        'the acknowledgement is beyond what this node delivered',
        { throughSeq: decimal(through), deliveredThroughSeq: decimal(delivered) },
      )
    }
    const next = through > current ? through : current
    if (next !== current) {
      this.#db.prepare('UPDATE collector_meta SET acked_through_seq = ? WHERE singleton = 1').run(next)
    }
    // Cleanup is asynchronous on purpose: the ACK is already durable, and deleting
    // rows is not something the caller should wait for.
    const timer = setTimeout(() => { this.#cleanup() }, 0)
    timer.unref?.()
    return { collectorId: meta.collector_id, ackedThroughSeq: decimal(next) }
  }

  /** Delete events acknowledged longer ago than the retention window. */
  #cleanup(): void {
    if (this.#closed) return
    const cutoff = new Date(this.#now() - this.#retentionMs).toISOString()
    try {
      inTransaction(this.#db, () => {
        const meta = this.#meta()
        const acked = toBigInt(meta.acked_through_seq)
        this.#db.prepare('DELETE FROM outbox WHERE seq <= ? AND recorded_at < ?').run(acked, cutoff)
        // A terminal attempt whose newest revision is acknowledged and old enough
        // can go; a running one cannot, because its last word has not been said.
        this.#db.prepare(
          `DELETE FROM attempts
            WHERE state <> 'running' AND latest_seq <= ? AND updated_at < ?`,
        ).run(acked, cutoff)
        // Coverage rows are the durable explanation of a gap; they are not deleted
        // with the events, because the Coordinator may still need to account for
        // them after it reads past the range.
      })
    } catch {
      // A cleanup failure is not a data-loss event: the rows are still there, and
      // the next ACK tries again.
    }
  }

  /** Throw when another node id asks for this collector's data. */
  #requireCollector(collectorId: string): MetaRow {
    const meta = this.#meta()
    if (meta.collector_id !== collectorId) {
      throw new UsageError('nodeUsage/collector-mismatch', 'the collector id does not match this node', {
        expected: meta.collector_id,
        received: collectorId,
      })
    }
    return meta
  }

  /** The current size of the database plus WAL and shared-memory files. */
  #queueBytes(): number {
    let total = 0
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        total += statSync(`${this.#file}${suffix}`).size
      } catch {
        // A file that does not exist yet contributes nothing.
      }
    }
    return total
  }

  /** Whether the queue is over its ceiling. */
  #capacityExceeded(): boolean {
    return this.#queueBytes() >= this.#maxBytes
  }

  /** Record a degraded state, opening a coverage interval once. */
  #enterDegraded(code: string, reason: string): void {
    const meta = this.#meta()
    if (meta.degraded_since !== null) return
    const at = new Date(this.#now()).toISOString()
    try {
      inTransaction(this.#db, () => {
        this.#db.prepare('UPDATE collector_meta SET degraded_since = ?, issue_code = ? WHERE singleton = 1').run(at, code)
        this.#db.prepare('INSERT INTO coverage_state (from_at, to_at, reason) VALUES (?, NULL, ?)').run(at, reason)
      })
    } catch {
      // If even this write fails the queue is unusable; status() will keep saying
      // degraded because the size check keeps failing.
    }
  }

  /** Record a non-capacity issue. */
  #degrade(code: string, reason: string): void {
    this.#enterDegraded(code, reason)
  }

  /** Close the coverage interval and emit the gap event that explains it. */
  #recoverIfDegraded(): void {
    const meta = this.#meta()
    if (meta.degraded_since === null) return
    const from = meta.degraded_since
    const to = new Date(this.#now()).toISOString()
    const open = this.#db.prepare('SELECT id FROM coverage_state WHERE to_at IS NULL ORDER BY id DESC LIMIT 1').get()
    this.#db.prepare('UPDATE coverage_state SET to_at = ? WHERE id = ?').run(to, Number(open?.['id'] ?? -1))
    // The explicit gap comes before the next attempt: the Coordinator has to be
    // able to account for the degraded interval, and it can only do that if the
    // marker is in the sequence before the data resumes.
    this.#appendEvent({
      kind: 'gap',
      fromAt: from,
      toAt: to,
      reason: meta.issue_code === 'capacity-limit' ? 'capacity-limit' : 'storage-failure',
    })
    this.#db.prepare('UPDATE collector_meta SET degraded_since = NULL, issue_code = NULL WHERE singleton = 1').run()
  }

  /** Whether the queue has reached the warning threshold. */
  get capacityWarning(): boolean {
    return this.#queueBytes() >= this.#maxBytes * CAPACITY_WARN_RATIO
  }

  /** Release the database and the ownership lock. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    try {
      this.#db.close()
    } finally {
      releaseLock(this.#lockFile)
    }
  }

  /** Throw when the store has been closed. */
  #assertOpen(): void {
    if (this.#closed) throw storageUnavailable('the usage queue is closed', { file: this.#file })
  }
}

/** Take the single-owner lock, removing a stale one left by a dead process. */
function acquireLock(file: string): string {
  if (existsSync(file)) {
    const contents = safeRead(file)
    const pid = Number(contents.split(/\s+/u)[0] ?? '')
    /*
      A live pid owns the queue — including this one. Two stores in one process are
      the same double-writer bug as two processes, and treating "it is me" as safe
      would let a plugin hot-reload open the file while the previous store still
      holds its WAL.
    */
    if (Number.isInteger(pid) && pid > 0 && processAlive(pid)) {
      throw storageUnavailable(
        `the usage queue at ${file.replace(/\.lock$/u, '')} is in use by process ${pid}`,
        { lockFile: file, pid },
      )
    }
    try {
      unlinkSync(file)
    } catch {
      // Someone else removed it first; the create below decides.
    }
  }
  try {
    writeFileSync(file, `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    throw storageUnavailable(`the usage queue lock could not be taken: ${(error as Error).message}`, { lockFile: file })
  }
  return file
}

/** Remove the lock, but only if this process still owns it. */
function releaseLock(file: string): void {
  const contents = safeRead(file)
  const pid = Number(contents.split(/\s+/u)[0] ?? '')
  if (pid !== process.pid) return
  try {
    unlinkSync(file)
  } catch {
    // Already gone.
  }
}

/** Read a small file, returning '' when it cannot be read. */
function safeRead(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** Whether a pid is alive (best effort; a signal probe needs no privileges). */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Read a numeric column that may arrive as number or bigint. */
function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value))
  if (typeof value === 'string' && /^\d+$/u.test(value)) return BigInt(value)
  return 0n
}

/** Parse a stored snapshot defensively. */
function safeSnapshot(value: unknown): AttemptSnapshot | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const parsed = JSON.parse(value) as AttemptSnapshot
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Re-exported so the service and tests agree on the event size rule. */
export { eventBytes }
