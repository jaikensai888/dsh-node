/**
 * The node half of the usage contract: types, strict parsers, and the normalizer.
 *
 * This mirrors `dsh-coordinator/src/usage/types.ts` field for field. The two
 * packages are separate repositories that do not import each other at runtime, so
 * the contract is duplicated on purpose — and the cross-implementation test feeds a
 * node payload into the Coordinator's parser to prove the copies agree.
 *
 * The rules worth remembering:
 *
 * - A bucket the provider did not report is `null`, never `0`.
 * - `inputTokens` from the runtime is the *uncached* input; cache reads and writes
 *   are separate, mutually exclusive buckets.
 * - Totals are decimal strings; `bigint` is used for arithmetic.
 *
 * @module dsh-node/usage/types
 */

import { invalidArguments } from './errors.js'

/** A non-negative integer as a decimal string. */
export type Decimal = string

/** A UTC ISO-8601 timestamp with millisecond precision. */
export type IsoTime = string

/** The terminal (or not yet terminal) state of one runtime attempt. */
export type AttemptState = 'running' | 'completed' | 'failed' | 'cancelled' | 'process_interrupted'

/** Why the runtime made the call. */
export type Purpose = 'conversation' | 'compaction' | 'session-title' | 'other'

/** One usage sample. Every bucket is independently nullable. */
export interface UsageSample {
  readonly uncachedInputTokens: Decimal | null
  readonly cacheReadTokens: Decimal | null
  readonly cacheWriteTokens: Decimal | null
  readonly outputTokens: Decimal | null
  readonly reasoningTokens: Decimal | null
  readonly totalTokens: Decimal | null
}

/** One runtime attempt, as this node last saw it. */
export interface AttemptSnapshot {
  readonly attemptId: string
  readonly startedAt: IsoTime
  readonly endedAt: IsoTime | null
  readonly provider: string | null
  readonly model: string | null
  readonly sessionId: string | null
  readonly purpose: Purpose
  readonly state: AttemptState
  readonly usageReported: boolean
  readonly usage: UsageSample
  readonly source: 'runtime'
}

/** One immutable event in the collector's sequence. */
export type UsageEvent =
  | {
    readonly seq: Decimal
    readonly recordedAt: IsoTime
    readonly kind: 'attempt'
    readonly attempt: AttemptSnapshot
  }
  | {
    readonly seq: Decimal
    readonly recordedAt: IsoTime
    readonly kind: 'gap'
    readonly fromAt: IsoTime
    readonly toAt: IsoTime
    readonly reason: 'storage-failure' | 'capacity-limit' | 'collector-reset'
  }

/** A sequence range this node can no longer replay. */
export interface ReplayGap {
  readonly fromSeq: Decimal
  readonly throughSeq: Decimal
  readonly reason: 'pruned' | 'restore'
}

/** What this node reports about its collector. */
export interface UsageStatus {
  readonly schemaVersion: 1
  readonly enabled: boolean
  readonly state: 'ready' | 'disabled' | 'unsupported' | 'degraded'
  readonly collectorId: string | null
  readonly startedAt: IsoTime | null
  readonly earliestAvailableSeq: Decimal
  readonly latestIssuedSeq: Decimal
  readonly ackedThroughSeq: Decimal
  readonly pendingCount: Decimal
  readonly pendingBytes: Decimal
  readonly coverage: 'complete' | 'incomplete' | 'unknown'
  readonly degradedSince: IsoTime | null
  readonly issueCode: string | null
}

/** One page of events for the Coordinator. */
export interface UsageBatch {
  readonly schemaVersion: 1
  readonly collectorId: string
  readonly events: readonly UsageEvent[]
  readonly gaps: readonly ReplayGap[]
  readonly nextSeq: Decimal
  readonly hasMore: boolean
  readonly status: UsageStatus
}

/** A request to read a page. */
export interface UsageReadRequest {
  readonly collectorId: string
  readonly afterSeq: Decimal
  readonly limit: number
  readonly maxBytes: number
}

/** A request to acknowledge a prefix. */
export interface UsageAckRequest {
  readonly collectorId: string
  readonly throughSeq: Decimal
}

/** The result of an acknowledgement. */
export interface UsageAckResult {
  readonly collectorId: string
  readonly ackedThroughSeq: Decimal
}

/** The largest value a SQLite INTEGER can hold. */
export const MAX_SQLITE_INTEGER = 9223372036854775807n

/** The largest event payload the wire contract permits. */
export const MAX_EVENT_BYTES = 16 * 1024

/** The largest page the contract allows. */
export const MAX_READ_LIMIT = 200

/** The largest page in bytes the contract allows. */
export const MAX_READ_BYTES = 262_144

/** The largest string an identifier field may carry. */
export const MAX_ID_LENGTH = 128

/** The largest provider/model/session string the contract permits. */
export const MAX_TEXT_LENGTH = 256

const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/u

/**
 * Parse a contract Decimal.
 * @param value - the value to parse.
 * @returns the integer, or undefined when it is not a contract Decimal.
 */
export function parseDecimal(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return value >= 0n ? value : undefined
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : undefined
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) return undefined
  try {
    return BigInt(value)
  } catch {
    return undefined
  }
}

/**
 * Render an integer as a contract Decimal.
 * @param value - the integer.
 * @returns the decimal string.
 */
export function decimal(value: bigint | number): Decimal {
  return typeof value === 'bigint' ? value.toString(10) : String(Math.trunc(value))
}

/** The result of normalizing one usage sample. */
export interface NormalizedUsage {
  readonly usage: UsageSample
  /** True when at least one provider field was present and usable. */
  readonly reported: boolean
  readonly issues: readonly string[]
}

/** The all-null sample. */
export function emptyUsage(): UsageSample {
  return {
    uncachedInputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    totalTokens: null,
  }
}

/**
 * Normalize the runtime's `usage` chunk into the contract's buckets.
 *
 * Accepts both vocabularies because the runtime says `inputTokens` where the
 * contract says `uncachedInputTokens`; the DeepSeek adapter adds the two cache
 * buckets on top of that input to reach its total, so the mapping is the one the
 * provider arithmetic already assumes.
 * @param value - the raw usage object.
 * @returns the normalized sample plus whether anything was reported.
 */
export function normalizeUsage(value: unknown): NormalizedUsage {
  const issues: string[] = []
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { usage: emptyUsage(), reported: false, issues: ['usage was not an object'] }
  }
  const raw = value as Record<string, unknown>
  let reported = false

  const bucket = (names: readonly string[], label: string): bigint | null => {
    for (const name of names) {
      if (!Object.prototype.hasOwnProperty.call(raw, name)) continue
      const candidate = raw[name]
      if (candidate === null || candidate === undefined) continue
      reported = true
      const parsed = parseDecimal(candidate)
      if (parsed === undefined || parsed > MAX_SQLITE_INTEGER) {
        issues.push(`${label} was not a non-negative safe integer`)
        return null
      }
      return parsed
    }
    return null
  }

  const uncached = bucket(['uncachedInputTokens', 'inputTokens'], 'uncachedInputTokens')
  const cacheRead = bucket(['cacheReadTokens'], 'cacheReadTokens')
  const cacheWrite = bucket(['cacheWriteTokens'], 'cacheWriteTokens')
  const output = bucket(['outputTokens'], 'outputTokens')
  const reasoning = bucket(['reasoningTokens'], 'reasoningTokens')
  const providerTotal = bucket(['totalTokens'], 'totalTokens')

  let reasoningValid = reasoning
  if (reasoning !== null && output !== null && reasoning > output) {
    issues.push('reasoningTokens exceeded outputTokens and was discarded')
    reasoningValid = null
  }

  const buckets = [uncached, cacheRead, cacheWrite, output]
  const bucketsKnown = buckets.every(entry => entry !== null)
  const bucketSum = buckets.reduce<bigint>((sum, entry) => sum + (entry ?? 0n), 0n)

  let total: bigint | null = providerTotal
  let inconsistentTotal = false
  if (total !== null && bucketsKnown && total < bucketSum) {
    issues.push('totalTokens was smaller than the known buckets and was discarded')
    total = null
    inconsistentTotal = true
  }
  if (total === null && !inconsistentTotal && bucketsKnown) total = bucketSum

  return {
    usage: {
      uncachedInputTokens: uncached === null ? null : decimal(uncached),
      cacheReadTokens: cacheRead === null ? null : decimal(cacheRead),
      cacheWriteTokens: cacheWrite === null ? null : decimal(cacheWrite),
      outputTokens: output === null ? null : decimal(output),
      reasoningTokens: reasoningValid === null ? null : decimal(reasoningValid),
      totalTokens: total === null ? null : decimal(total),
    },
    reported: reported || providerTotal !== null,
    issues,
  }
}

/** The tokens a call is known to have used. */
export function knownTokensOf(usage: UsageSample): bigint {
  const total = parseDecimal(usage.totalTokens)
  if (total !== undefined) return total
  return [usage.uncachedInputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.outputTokens]
    .reduce<bigint>((sum, entry) => sum + (parseDecimal(entry ?? undefined) ?? 0n), 0n)
}

/** The canonical JSON of a sample. */
export function canonicalUsage(usage: UsageSample): string {
  return JSON.stringify([
    usage.uncachedInputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
    usage.outputTokens,
    usage.reasoningTokens,
    usage.totalTokens,
  ])
}

/** Require a bounded string. */
function requireText(value: unknown, field: string, max = MAX_TEXT_LENGTH): string {
  if (typeof value !== 'string') throw invalidArguments(`"${field}" must be a string`, { field })
  if (value.length > max) throw invalidArguments(`"${field}" is longer than ${max} characters`, { field })
  return value
}

/** Require a Decimal. */
function requireDecimal(value: unknown, field: string): bigint {
  const parsed = parseDecimal(value)
  if (parsed === undefined) throw invalidArguments(`"${field}" must be a non-negative decimal integer`, { field })
  if (parsed > MAX_SQLITE_INTEGER) throw invalidArguments(`"${field}" exceeds the SQLite INTEGER range`, { field })
  return parsed
}

/**
 * Parse a `nodeUsage/read` request.
 * @param value - the decoded `request` object.
 * @returns the validated request.
 * @throws UsageError `nodeUsage/invalid-arguments`.
 */
export function parseReadRequest(value: unknown): UsageReadRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidArguments('"request" must be an object')
  }
  const raw = value as Record<string, unknown>
  const collectorId = requireText(raw['collectorId'], 'collectorId', MAX_ID_LENGTH)
  if (collectorId === '') throw invalidArguments('"collectorId" must not be empty')
  const afterSeq = decimal(requireDecimal(raw['afterSeq'], 'afterSeq'))
  const limitRaw = raw['limit']
  const limit = limitRaw === undefined ? MAX_READ_LIMIT : Number(limitRaw)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_READ_LIMIT) {
    throw invalidArguments(`"limit" must be an integer between 1 and ${MAX_READ_LIMIT}`, { limit: String(limitRaw) })
  }
  const maxBytesRaw = raw['maxBytes']
  const maxBytes = maxBytesRaw === undefined ? MAX_READ_BYTES : Number(maxBytesRaw)
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_READ_BYTES) {
    throw invalidArguments(`"maxBytes" must be an integer between 1 and ${MAX_READ_BYTES}`, { maxBytes: String(maxBytesRaw) })
  }
  return { collectorId, afterSeq, limit, maxBytes }
}

/**
 * Parse a `nodeUsage/ack` request.
 * @param value - the decoded `request` object.
 * @returns the validated request.
 * @throws UsageError `nodeUsage/invalid-arguments`.
 */
export function parseAckRequest(value: unknown): UsageAckRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidArguments('"request" must be an object')
  }
  const raw = value as Record<string, unknown>
  const collectorId = requireText(raw['collectorId'], 'collectorId', MAX_ID_LENGTH)
  if (collectorId === '') throw invalidArguments('"collectorId" must not be empty')
  return { collectorId, throughSeq: decimal(requireDecimal(raw['throughSeq'], 'throughSeq')) }
}

/** The bytes one serialized event occupies on the wire. */
export function eventBytes(event: UsageEvent): number {
  return Buffer.byteLength(JSON.stringify(event), 'utf8')
}
