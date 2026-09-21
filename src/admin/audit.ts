/**
 * Audit trail for the management Remotes.
 *
 * A management Remote lets a Coordinator change this machine, so "what did it
 * ask for, and what happened" has to be answerable afterwards. The trail is a
 * bounded in-memory ring: it survives long enough to diagnose an incident, and
 * it can never grow without limit or need a cleanup job.
 *
 * Two rules keep the trail itself from becoming a leak:
 *
 * - it records **identifier, outcome, code, and counts**, never arguments or file
 *   contents — a rewritten file's body must not end up in a log buffer;
 * - it records the **redacted** subject (a path relative to nothing, a skill name,
 *   a byte count), so a token or an absolute host path cannot ride along.
 *
 * @module dsh-node/admin/audit
 */

/** One recorded management operation. */
export interface AuditRecord {
  /** ISO timestamp. */
  readonly at: string
  /** Endpoint that was invoked, e.g. `nodeAdmin/fsWrite`. */
  readonly endpoint: string
  /** `ok` or the failure code. */
  readonly outcome: 'ok' | 'error'
  /** Failure code when `outcome` is `error`. */
  readonly code?: string
  /** What was acted on, already safe to persist: a name, a kind, a byte count. */
  readonly subject?: string
  /** Bytes read or written, when the operation moved bytes. */
  readonly bytes?: number
  /** Wall-clock duration in milliseconds. */
  readonly durationMs?: number
}

/** A bounded, append-only record of management operations. */
export class AuditLog {
  private readonly records: AuditRecord[] = []
  private readonly capacity: number
  private readonly now: () => number

  /**
   * @param capacity - how many records to retain; older ones are dropped first.
   * @param now - clock, injectable for deterministic tests.
   */
  constructor(capacity = 256, now: () => number = Date.now) {
    this.capacity = Math.max(1, Math.trunc(capacity))
    this.now = now
  }

  /** Timestamp source, so a caller can time one operation with the same clock. */
  timestamp(): string {
    return new Date(this.now()).toISOString()
  }

  /** Record one operation, dropping the oldest when full. */
  append(record: AuditRecord): void {
    this.records.push(record)
    if (this.records.length > this.capacity) this.records.splice(0, this.records.length - this.capacity)
  }

  /**
   * The most recent records, newest first.
   * @param limit - maximum number to return.
   * @returns a copy, so a caller cannot mutate the trail.
   */
  recent(limit = 50): AuditRecord[] {
    const count = Math.max(0, Math.min(Math.trunc(limit), this.records.length))
    return this.records.slice(this.records.length - count).reverse()
  }

  /** How many records are currently retained. */
  get size(): number {
    return this.records.length
  }

  /** Configured capacity. */
  get limit(): number {
    return this.capacity
  }
}
