/** Remote bridge for DSH's session-scoped `user-questions/request` waterfall. */

import { randomUUID } from 'node:crypto'
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'

export const QUESTIONS_SERVICE_KEY = 'nodeQuestions'
export const QUESTIONS_NAMESPACE = 'nodeQuestions'
const SESSION_VIEW_LEASE_MS = 15_000

export interface QuestionOption {
  readonly label: string
  readonly description?: string
}

export interface QuestionItem {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly header?: string
  readonly options?: readonly QuestionOption[]
  readonly multiSelect?: boolean
  readonly intent?: { readonly kind: 'plan-review'; readonly approve: string }
}

export interface QuestionAnswerItem {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

export interface QuestionAnswer {
  readonly answers: readonly QuestionAnswerItem[]
}

export interface PendingQuestionRequest {
  readonly requestId: string
  readonly sessionId: string
  readonly questions: readonly QuestionItem[]
}

interface UserQuestionRequest {
  readonly questions: readonly QuestionItem[]
  readonly agent?: { readonly id?: unknown }
  readonly signal?: AbortSignal
}

interface PendingEntry extends PendingQuestionRequest {
  readonly resolve: (answer: QuestionAnswer) => void
  readonly reject: (error: Error) => void
  readonly signal?: AbortSignal
  readonly onAbort?: () => void
}

function remoteFailure(code: string, message: string): Error {
  return Object.assign(new Error(message), {
    name: 'NodeQuestionsError',
    code: `nodeQuestions/${code}`,
    details: {},
    isDSHRemoteError: true,
  })
}

function questionFailure(code: 'ASK_ABORTED' | 'ASK_CANCELLED', message: string): Error {
  return Object.assign(new Error(message), { name: 'UserQuestionError', code })
}

function jsonParameter(name: string): InvocationDescriptor['parameters'][number] {
  return { name, wire: name, source: 'json', codec: { mode: 'src-json' } }
}

function descriptor(method: string, parameters: readonly string[]): InvocationDescriptor {
  return {
    id: `dsh-node/questions#${method}`,
    service: QUESTIONS_SERVICE_KEY,
    namespace: QUESTIONS_NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters: parameters.map(jsonParameter),
    result: { mode: 'src-json' },
  }
}

export const QUESTIONS_DESCRIPTORS: readonly InvocationDescriptor[] = [
  descriptor('pending', ['sessionId']),
  descriptor('answer', ['sessionId', 'requestId', 'answer']),
  descriptor('cancel', ['sessionId', 'requestId']),
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw remoteFailure('invalid-arguments', `${field} must be a non-empty string`)
  }
  return value
}

function projectQuestions(questions: readonly QuestionItem[]): QuestionItem[] {
  return questions.map((question) => ({
    id: question.id,
    question: question.question,
    ...(question.detail === undefined ? {} : { detail: question.detail }),
    ...(question.header === undefined ? {} : { header: question.header }),
    ...(question.options === undefined ? {} : {
      options: question.options.map(option => ({
        label: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
      })),
    }),
    ...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect }),
    ...(question.intent === undefined ? {} : { intent: { ...question.intent } }),
  }))
}

/** Owns pending requests across node reconnects, while each installed Remote is boot-scoped. */
export class NodeQuestionBridge {
  readonly typertRemote: { readonly service: unknown; readonly serviceKey: string; readonly namespace: string }
    = Object.freeze({
      service: this,
      serviceKey: QUESTIONS_SERVICE_KEY,
      namespace: QUESTIONS_NAMESPACE,
    })

  readonly #pending = new Map<string, PendingEntry>()
  readonly #viewedSessions = new Map<string, number>()
  #disposed = false

  /** Ask the remote UI, resolving only when its structured answer arrives. */
  ask(request: UserQuestionRequest): Promise<QuestionAnswer> {
    const sessionId = request.agent?.id
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      return Promise.reject(questionFailure('ASK_ABORTED', 'remote questions require a session-bound agent'))
    }
    if (this.#disposed) {
      return Promise.reject(questionFailure('ASK_ABORTED', 'the remote question bridge has been disposed'))
    }
    if (request.signal?.aborted === true) {
      return Promise.reject(questionFailure('ASK_ABORTED', 'the agent cancelled this question'))
    }

    return new Promise((resolve, reject) => {
      const requestId = randomUUID()
      const entry: PendingEntry = {
        requestId,
        sessionId,
        questions: projectQuestions(request.questions),
        resolve,
        reject,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(request.signal === undefined ? {} : {
          onAbort: () => { this.#settle(requestId, pending => {
            pending.reject(questionFailure('ASK_ABORTED', 'the agent cancelled this question'))
          }) },
        }),
      }
      this.#pending.set(requestId, entry)
      if (entry.signal !== undefined && entry.onAbort !== undefined) {
        entry.signal.addEventListener('abort', entry.onAbort, { once: true })
        if (entry.signal.aborted) entry.onAbort()
      }
    })
  }

  /** Return pending requests for exactly one session. */
  pending(sessionIdValue: unknown): { readonly requests: readonly PendingQuestionRequest[] } {
    const sessionId = requiredString(sessionIdValue, 'sessionId')
    const now = Date.now()
    for (const [viewedSessionId, expiresAt] of this.#viewedSessions) {
      if (expiresAt <= now) this.#viewedSessions.delete(viewedSessionId)
    }
    this.#viewedSessions.set(sessionId, now + SESSION_VIEW_LEASE_MS)
    return {
      requests: [...this.#pending.values()]
        .filter(request => request.sessionId === sessionId)
        .map(({ requestId, sessionId: owner, questions }) => ({ requestId, sessionId: owner, questions })),
    }
  }

  /** Whether dsh-master has recently refreshed this session's question view. */
  isSessionViewed(sessionIdValue: unknown): boolean {
    if (typeof sessionIdValue !== 'string' || sessionIdValue.trim() === '') return false
    const expiresAt = this.#viewedSessions.get(sessionIdValue)
    if (expiresAt === undefined) return false
    if (expiresAt <= Date.now()) {
      this.#viewedSessions.delete(sessionIdValue)
      return false
    }
    return true
  }

  /** Resolve one waiting request after validating its owner and complete answer set. */
  answer(sessionIdValue: unknown, requestIdValue: unknown, answerValue: unknown): { readonly accepted: true } {
    const entry = this.#entry(sessionIdValue, requestIdValue)
    const answer = this.#validatedAnswer(entry, answerValue)
    this.#settle(entry.requestId, pending => { pending.resolve(answer) })
    return { accepted: true }
  }

  /** Reject one waiting request as a user cancellation. */
  cancel(sessionIdValue: unknown, requestIdValue: unknown): { readonly accepted: true } {
    const entry = this.#entry(sessionIdValue, requestIdValue)
    this.#settle(entry.requestId, pending => {
      pending.reject(questionFailure('ASK_CANCELLED', 'the user cancelled this question'))
    })
    return { accepted: true }
  }

  /** Reject all waiters when the owning DSH plugin is unloaded. */
  dispose(): void {
    this.#disposed = true
    this.#viewedSessions.clear()
    for (const requestId of this.#pending.keys()) {
      this.#settle(requestId, entry => {
        entry.reject(questionFailure('ASK_ABORTED', 'the remote question bridge has been disposed'))
      })
    }
  }

  #entry(sessionIdValue: unknown, requestIdValue: unknown): PendingEntry {
    const sessionId = requiredString(sessionIdValue, 'sessionId')
    const requestId = requiredString(requestIdValue, 'requestId')
    const entry = this.#pending.get(requestId)
    if (entry === undefined || entry.sessionId !== sessionId) {
      throw remoteFailure('not-found', 'the pending question does not belong to this session or has already settled')
    }
    return entry
  }

  #validatedAnswer(entry: PendingEntry, value: unknown): QuestionAnswer {
    if (!isRecord(value) || !Array.isArray(value['answers'])) {
      throw remoteFailure('invalid-answer', 'answer must contain an answers array')
    }
    const supplied = new Map<string, QuestionAnswerItem>()
    for (const item of value['answers']) {
      if (!isRecord(item) || typeof item['id'] !== 'string' || !Array.isArray(item['selected'])
        || !item['selected'].every(option => typeof option === 'string')
        || (item['custom'] !== undefined && typeof item['custom'] !== 'string')) {
        throw remoteFailure('invalid-answer', 'each answer needs an id, string selections, and optional custom text')
      }
      const id = item['id']
      if (supplied.has(id)) throw remoteFailure('invalid-answer', `question ${id} was answered more than once`)
      supplied.set(id, {
        id,
        selected: [...item['selected']] as string[],
        ...(typeof item['custom'] === 'string' ? { custom: item['custom'] } : {}),
      })
    }

    if (supplied.size !== entry.questions.length) {
      throw remoteFailure('invalid-answer', 'answers must cover every pending question exactly once')
    }
    const answers = entry.questions.map((question) => {
      const answer = supplied.get(question.id)
      if (answer === undefined) throw remoteFailure('invalid-answer', `question ${question.id} has no answer`)
      const labels = question.options?.map(option => option.label)
      if ((question.multiSelect !== true && answer.selected.length > 1)
        || (labels === undefined && answer.selected.length > 0)
        || (labels !== undefined && answer.selected.some(label => !labels.includes(label)))) {
        throw remoteFailure('invalid-answer', `question ${question.id} contains an unavailable selection`)
      }
      return answer
    })
    return { answers }
  }

  #settle(requestId: string, settle: (entry: PendingEntry) => void): boolean {
    const entry = this.#pending.get(requestId)
    if (entry === undefined) return false
    this.#pending.delete(requestId)
    if (entry.signal !== undefined && entry.onAbort !== undefined) {
      entry.signal.removeEventListener('abort', entry.onAbort)
    }
    settle(entry)
    return true
  }
}
