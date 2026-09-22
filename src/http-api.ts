/**
 * The one HTTP surface this plugin exposes: a status route, a diagnostics route, and
 * exactly one write route that stores the node's own connection settings.
 *
 * It exists for exactly one consumer — the footer entry the client half renders —
 * and it is deliberately the smallest thing that can serve it:
 *
 * - **almost read-only**: `GET`/`HEAD` everywhere, plus a single `POST` on
 *   `/api/config`. That POST is the only way anything is ever written, it is
 *   reachable only through the same trust fence, and it writes one file whose path
 *   the host decided. There is no generic "write" endpoint and no caller-supplied path;
 * - **secret-free on read**: the status payload is the node's own already-redacted
 *   snapshot plus build metadata, and the configuration view reports only whether a
 *   token is stored (`tokenSet`), never the token. Tests assert both against real data;
 * - **fenced**: every request passes {@link isTrustedNodeRequest}, the same
 *   rebinding/cross-site defense the other plugin prefixes use, because these
 *   routes are reachable without the browser-session cookie;
 * - **one prefix route**: `webServer.register` throws on a duplicate
 *   `(kind, path)` pair and that failure takes the whole plugin tree down, so all
 *   sub-paths are dispatched from a single handler.
 *
 * @module dsh-node/http-api
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ConnectionIntent } from './config-file.js'
import type { DshNodeStatus } from './protocol.js'
import { isTrustedNodeRequest } from './net/trust-fence.js'

/** The single prefix this plugin registers. */
export const NODE_ROUTE_PREFIX = '/dsh-node'

/** The status payload the browser reads. Everything here is safe to publish. */
export interface NodeStatusView extends DshNodeStatus {
  /** Plugin version, so the UI can show a version skew instead of guessing. */
  readonly pluginVersion?: string
  /** The one mode this build supports (spec: a second level cannot be forged). */
  readonly mode?: string
  /** Milliseconds since the host was constructed. */
  readonly uptimeMs?: number
  /** When this snapshot was produced, so a stale poll is detectable. */
  readonly updatedAt: string
}

/** What the route handler needs. Injected, so the route is testable without a host. */
export interface NodeRouteDeps {
  /** The current, redacted status snapshot. Read per request, never cached. */
  readonly status: () => NodeStatusView
  /** Non-loopback authorities this deployment serves (from `webRuntime`). */
  readonly trustedHosts: () => readonly string[]
  /**
   * Read-only view of the client-module composition.
   *
   * It exists because that composition fails **silently**: a plugin whose manifest
   * the composer cannot locate keeps running on the host and simply never appears in
   * the browser, with nothing logged anywhere. One route that names the reason is
   * worth more than any amount of guessing from outside the process.
   */
  readonly diagnostics?: () => NodeDiagnostics
  /**
   * The configuration surface, present only when the host wired a config file.
   *
   * It is optional so that a host without a resolvable home still serves status
   * instead of failing to register its route. When it is absent, `/api/config`
   * answers 404 and every method stays read-only, which is why the method gate
   * keys off this field rather than off the path.
   */
  readonly config?: NodeConfigSurface
  /** Manual transport control, present when the host can persist connection intent. */
  readonly connection?: NodeConnectionSurface
}

/** A coded failure, the shape the client already knows how to render. */
interface RemoteFailure {
  readonly code: string
  readonly message: string
  readonly details: Record<string, unknown>
}

/** A JSON envelope, matching the shape the Coordinator and DSH use. */
interface Envelope {
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: RemoteFailure
}

/** What the host's client-module composer currently thinks, for diagnosis. */
export interface NodeDiagnostics {
  /** Whether the `clientModules` service was found at all. */
  readonly clientModulesService: boolean
  /** Every client module id the composer put in the boot manifest. */
  readonly entries: readonly string[]
  /** Whether this plugin's own client half made it into that list. */
  readonly selfComposed: boolean
  /** The bundle path the composer resolved, or null when it resolved none. */
  readonly selfClientPath: string | null
  /** Set when reading the service threw; the rest of the payload is then empty. */
  readonly readError?: string
}

/** Read and write the node's own configuration, as the route needs it. */
export interface NodeConfigSurface {
  /** The current view. Must never include the token. */
  read: () => NodeConfigView
  /**
   * Validate, persist, and apply a submitted configuration.
   *
   * Resolves with the fresh view on success. Rejects with an {@link HttpFailure} for
   * anything the operator can fix, so the panel renders the reason and stays editable.
   */
  write: (input: Record<string, unknown>) => Promise<NodeConfigView>
}

/** The two actions exposed by the node's status popover. */
export interface NodeConnectionSurface {
  readonly state: () => ConnectionIntent
  readonly connect: () => Promise<ConnectionIntent> | ConnectionIntent
  readonly disconnect: () => Promise<ConnectionIntent> | ConnectionIntent
}

/** A coded failure carrying the HTTP status the route should answer with. */
export class HttpFailure extends Error {
  readonly status: number
  readonly failure: RemoteFailure

  constructor(status: number, failure: RemoteFailure) {
    super(failure.message)
    this.name = 'HttpFailure'
    this.status = status
    this.failure = failure
  }
}

/** Send one JSON response. */
function sendJson(response: ServerResponse, status: number, envelope: Envelope): void {
  if (response.writableEnded) return
  const text = JSON.stringify(envelope)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text, 'utf8'),
    // A status dot polls this; a cached answer would show yesterday's state.
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(response.req.method === 'HEAD' ? undefined : text)
}

/** Refuse one request with a coded error. */
function sendError(response: ServerResponse, status: number, code: string, message: string): void {
  sendJson(response, status, { ok: false, error: { code, message, details: {} } })
}

/** Largest configuration body accepted. A URL, a token, and two labels fit easily. */
export const MAX_CONFIG_BODY_BYTES = 64 * 1024

/**
 * Read a bounded JSON object body.
 * @param request - the incoming request.
 * @returns the parsed object, or a coded failure.
 */
async function readJsonBody(request: IncomingMessage): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; status: number; failure: RemoteFailure }> {
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
      bytes += buffer.byteLength
      if (bytes > MAX_CONFIG_BODY_BYTES) {
        return {
          ok: false,
          status: 413,
          failure: {
            code: 'invalid-arguments',
            message: `the configuration body exceeds ${String(MAX_CONFIG_BODY_BYTES)} bytes`,
            details: {},
          },
        }
      }
      chunks.push(buffer)
    }
  } catch (error) {
    return {
      ok: false,
      status: 400,
      failure: { code: 'invalid-arguments', message: `the body could not be read: ${(error as Error).message}`, details: {} },
    }
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return { ok: true, value: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, status: 400, failure: { code: 'invalid-arguments', message: 'the body is not valid JSON', details: {} } }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, status: 400, failure: { code: 'invalid-arguments', message: 'the body must be a JSON object', details: {} } }
  }
  return { ok: true, value: parsed as Record<string, unknown> }
}

/** The read-only configuration view the panel renders. Never contains the token. */
export interface NodeConfigView {
  /** The configured endpoint, or undefined when the node has none. */
  readonly coordinatorUrl?: string
  /** Whether a credential is stored. The value itself never leaves the host. */
  readonly tokenSet: boolean
  readonly nodeName?: string
  readonly role?: string
  /** The persisted manual connection decision; absent means active for old hosts. */
  readonly connectionIntent?: ConnectionIntent
  /** So an operator can register this node on the Coordinator side. */
  readonly nodeId: string
  /** Absolute path of the file a save writes, so it can be found and protected. */
  readonly configFile: string
  /** Non-fatal complaint about the stored file, e.g. it was corrupt and ignored. */
  readonly configFileError?: string
  /** Where each effective value came from, since three layers can provide one. */
  readonly sources: {
    readonly coordinatorUrl: 'panel' | 'profile' | 'environment' | 'none'
    readonly token: 'panel' | 'profile' | 'environment' | 'none'
  }
}

/**
 * Build the `/dsh-node` dispatcher.
 *
 * Reads are answered **synchronously**, exactly as they were when this route was
 * read-only: the response is fully written before the handler returns, so nothing
 * about a poll depends on a microtask queue. Only the one write route returns a
 * promise, because only it has a request body to read.
 * @param deps - status provider, trusted authorities, and the configuration surface.
 * @returns the route handler `webServer.register` wants.
 */
export function createNodeRouteHandler(deps: NodeRouteDeps): (request: IncomingMessage, response: ServerResponse) => void {
  /** Turn any thrown value into a coded response. */
  const fail = (response: ServerResponse, error: unknown): void => {
    if (error instanceof HttpFailure) {
      // The operator can fix this one; show the reason, not a bare 500.
      sendJson(response, error.status, { ok: false, error: error.failure })
      return
    }
    // A throw here would become a bare 500 from the webserver with no envelope; the
    // client maps a coded failure to "status unavailable" and shows why.
    sendError(response, 500, 'internal', error instanceof Error ? error.message : String(error))
  }

  /** Validate one submitted document, persist it, and report the rebuilt node. */
  const writeConfig = async (
    request: IncomingMessage,
    response: ServerResponse,
    config: NodeConfigSurface,
  ): Promise<void> => {
    const body = await readJsonBody(request)
    if (!body.ok) {
      sendJson(response, body.status, { ok: false, error: body.failure })
      return
    }
    const view = await config.write(body.value)
    sendJson(response, 200, { ok: true, value: view })
  }

  const changeConnection = async (
    request: IncomingMessage,
    response: ServerResponse,
    action: 'connect' | 'disconnect',
  ): Promise<void> => {
    if (deps.connection === undefined) {
      sendError(response, 404, 'not-found', `unknown dsh-node route: ${request.url ?? ''}`)
      return
    }
    const intent = action === 'connect'
      ? await deps.connection.connect()
      : await deps.connection.disconnect()
    sendJson(response, 200, { ok: true, value: { connectionIntent: intent } })
  }

  /**
   * Answer one request.
   * @returns a promise only for the write route; `undefined` means "already answered".
   */
  const handle = (request: IncomingMessage, response: ServerResponse): Promise<void> | undefined => {
    if (!isTrustedNodeRequest(request, deps.trustedHosts())) {
      sendError(response, 403, 'forbidden', 'the request did not pass the dsh-node trust fence')
      return undefined
    }

    const method = request.method ?? 'GET'
    const pathname = new URL(request.url ?? '/', 'http://dsh.invalid').pathname
    const subPath = pathname.startsWith(NODE_ROUTE_PREFIX) ? pathname.slice(NODE_ROUTE_PREFIX.length) : pathname
    const writable = deps.config !== undefined && subPath === '/api/config'
    const connectionAction = subPath === '/api/connect' || subPath === '/api/disconnect'
    const connectionWritable = deps.connection !== undefined && connectionAction

    if (connectionAction && deps.connection === undefined) {
      sendError(response, 404, 'not-found', `unknown dsh-node route: ${pathname}`)
      return undefined
    }

    if (method !== 'GET' && method !== 'HEAD' && !(method === 'POST' && (writable || connectionWritable))) {
      // Exactly one route accepts a write; everything else is a read.
      response.setHeader('allow', writable ? 'GET, HEAD, POST' : connectionAction ? 'POST' : 'GET, HEAD')
      sendError(
        response,
        405,
        'method-not-allowed',
        writable
          ? `${NODE_ROUTE_PREFIX}/api/config accepts GET, HEAD, POST`
          : connectionAction
            ? `${NODE_ROUTE_PREFIX}${subPath} accepts POST`
            : `${NODE_ROUTE_PREFIX} is read-only`,
      )
      return undefined
    }

    // `''` (bare prefix), `'/'`, and `'/ping'` all mean "is this route alive".
    // A trailing slash is not a different resource here, and answering 404 to it
    // would make a hand-typed URL look like a missing plugin.
    if (subPath === '' || subPath === '/' || subPath === '/ping') {
      const snapshot = deps.status()
      sendJson(response, 200, {
        ok: true,
        value: { plugin: 'dsh-node', pluginVersion: snapshot.pluginVersion, state: snapshot.state },
      })
      return undefined
    }

    if (subPath === '/api/config' && deps.config !== undefined) {
      if (method === 'POST') return writeConfig(request, response, deps.config)
      sendJson(response, 200, { ok: true, value: deps.config.read() })
      return undefined
    }
    if (connectionAction) {
      if (method !== 'POST') {
        response.setHeader('allow', 'POST')
        sendError(response, 405, 'method-not-allowed', `${NODE_ROUTE_PREFIX}${subPath} accepts POST`)
        return undefined
      }
      return changeConnection(request, response, subPath === '/api/connect' ? 'connect' : 'disconnect')
    }
    if (subPath === '/api/status') {
      sendJson(response, 200, { ok: true, value: deps.status() })
      return undefined
    }
    if (subPath === '/api/diagnostics' && deps.diagnostics !== undefined) {
      sendJson(response, 200, { ok: true, value: deps.diagnostics() })
      return undefined
    }
    sendError(response, 404, 'not-found', `unknown dsh-node route: ${pathname}`)
    return undefined
  }

  return (request, response) => {
    let pending: Promise<void> | undefined
    try {
      pending = handle(request, response)
    } catch (error) {
      fail(response, error)
      return
    }
    if (pending === undefined) return
    void pending.catch((error: unknown) => { fail(response, error) })
  }
}
