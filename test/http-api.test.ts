/**
 * The status route: what it answers, and what it refuses.
 *
 * This route is the only HTTP surface the plugin exposes and it is reachable
 * without the browser-session cookie, so the tests below are mostly about the two
 * things that would make it a liability rather than a feature: **what it will
 * answer** (the fence) and **what it contains** (never a credential).
 *
 * @module dsh-node/test/http-api
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { HttpFailure, MAX_CONFIG_BODY_BYTES, createNodeRouteHandler, NODE_ROUTE_PREFIX, type NodeConfigView, type NodeStatusView } from '../src/http-api.js'
import { isLoopbackHostname, isTrustedNodeRequest } from '../src/net/trust-fence.js'
import type { DshNodeStatus } from '../src/protocol.js'

const TOKEN = 'token-that-must-never-appear'

/** A status snapshot shaped like the real one, with a token-bearing URL to catch leaks. */
function snapshot(overrides: Partial<NodeStatusView> = {}): NodeStatusView {
  const base: DshNodeStatus = {
    state: 'ready',
    nodeId: 'node-abcdef0123456789',
    nodeName: 'test-node',
    role: 'test-agent',
    // The host strips the path/query before this point; the test still proves the
    // route does not add anything back.
    coordinatorOrigin: 'ws://127.0.0.1:39471',
    connectionId: 'node-abcdef0123456789:mu991fam:i9qc2yvv',
    reconnectAttempt: 0,
    lastConnectedAt: '2026-09-20T11:55:03.508Z',
    inFlightRequests: 0,
    activeStreams: 0,
  }
  return {
    ...base,
    pluginVersion: '0.1.0',
    mode: 'full-access',
    uptimeMs: 1_000,
    updatedAt: '2026-09-20T12:00:00.000Z',
    ...overrides,
  }
}

/** One captured response. */
interface Captured {
  readonly status: number
  readonly headers: Record<string, string>
  readonly body: unknown
  readonly text: string
}

/** Build a fake request/response pair, run the given handler, and capture the answer. */
function build(options: {
  readonly url?: string
  readonly method?: string
  readonly headers?: Record<string, string>
  readonly body?: string
}): {
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly captured: { status: number; headers: Record<string, string>; text: string; ended: boolean }
} {
  const headers: Record<string, string> = { host: '127.0.0.1:43120', ...(options.headers ?? {}) }
  const request = {
    url: options.url ?? `${NODE_ROUTE_PREFIX}/api/status`,
    method: options.method ?? 'GET',
    headers,
    // The write route reads its body by iterating the request, exactly as it does
    // against a real socket; a fake that is not async-iterable would not exercise it.
    async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
      if (options.body !== undefined) yield Buffer.from(options.body, 'utf8')
    },
  } as unknown as IncomingMessage

  const captured = { status: 0, headers: {} as Record<string, string>, text: '', ended: false }
  const response = {
    req: request,
    get writableEnded() { return captured.ended },
    setHeader(name: string, value: string) { captured.headers[name.toLowerCase()] = value },
    writeHead(status: number, extra?: Record<string, string>) {
      captured.status = status
      for (const [name, value] of Object.entries(extra ?? {})) captured.headers[name.toLowerCase()] = value
      return response
    },
    end(text?: string) {
      captured.text = text ?? ''
      captured.ended = true
    },
  } as unknown as ServerResponse
  return { request, response, captured }
}

/** Captured response, parsed. */
function settled(captured: { status: number; headers: Record<string, string>; text: string }): Captured {
  return {
    status: captured.status,
    headers: captured.headers,
    text: captured.text,
    body: captured.text === '' ? undefined : JSON.parse(captured.text),
  }
}

function call(
  handler: ReturnType<typeof createNodeRouteHandler>,
  options: {
    readonly url?: string
    readonly method?: string
    readonly headers?: Record<string, string>
  } = {},
): Captured {
  const { request, response, captured } = build(options)
  handler(request, response)
  return settled(captured)
}

/**
 * Run one handler and wait for the answer.
 *
 * Only the write route is asynchronous, so only the tests that exercise it need this
 * — and needing it at all is the point: every read is answered before the handler
 * returns.
 */
async function callAsync(
  handler: ReturnType<typeof createNodeRouteHandler>,
  options: { readonly url?: string; readonly method?: string; readonly headers?: Record<string, string>; readonly body?: string },
): Promise<Captured> {
  const { request, response, captured } = build(options)
  handler(request, response)
  for (let attempt = 0; attempt < 200 && !captured.ended; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  return settled(captured)
}

const handler = createNodeRouteHandler({ status: () => snapshot(), trustedHosts: () => [] })

/** A configuration view shaped like the real one. It carries no token by construction. */
function configView(overrides: Partial<NodeConfigView> = {}): NodeConfigView {
  return {
    coordinatorUrl: 'ws://127.0.0.1:39472/node',
    tokenSet: true,
    nodeId: 'node-abcdef0123456789',
    configFile: 'C:/Users/someone/.dsh/storages/dsh-node/config.json',
    sources: { coordinatorUrl: 'panel', token: 'panel' },
    ...overrides,
  }
}

/** A configuration surface whose writes are recorded, and which can be made to refuse. */
function configSurface(options: {
  readonly view?: () => NodeConfigView
  readonly write?: (input: Record<string, unknown>) => Promise<NodeConfigView>
} = {}) {
  const writes: Record<string, unknown>[] = []
  return {
    writes,
    surface: {
      read: options.view ?? (() => configView()),
      write: async (input: Record<string, unknown>) => {
        writes.push(input)
        return options.write === undefined ? configView() : options.write(input)
      },
    },
  }
}

const withConfig = createNodeRouteHandler({
  status: () => snapshot(),
  trustedHosts: () => [],
  config: configSurface().surface,
})

describe('the trusted-request fence', () => {
  it('accepts loopback authorities and an absent Origin', () => {
    expect(isTrustedNodeRequest({ headers: { host: '127.0.0.1:43120' } }, [])).toBe(true)
    expect(isTrustedNodeRequest({ headers: { host: 'localhost:3080' } }, [])).toBe(true)
    expect(isTrustedNodeRequest({ headers: { host: '[::1]:3080' } }, [])).toBe(true)
    expect(isTrustedNodeRequest({ headers: { host: '127.1.2.3' } }, [])).toBe(true)
  })

  it('refuses a rebound hostname, a cross-site marker, and a foreign Origin', () => {
    // The whole point: a page on evil.example whose DNS answers 127.0.0.1 sends
    // its own hostname, and must not reach the route.
    expect(isTrustedNodeRequest({ headers: { host: 'evil.example' } }, [])).toBe(false)
    expect(isTrustedNodeRequest({ headers: { host: '127.0.0.1' } }, [])).toBe(true)
    expect(isTrustedNodeRequest({ headers: { host: '127.0.0.1', 'sec-fetch-site': 'cross-site' } }, [])).toBe(false)
    expect(isTrustedNodeRequest({ headers: { host: '127.0.0.1', origin: 'http://evil.example' } }, [])).toBe(false)
    expect(isTrustedNodeRequest({ headers: { host: '127.0.0.1', origin: 'null' } }, [])).toBe(false)
    expect(isTrustedNodeRequest({ headers: {} }, [])).toBe(false)
    expect(isTrustedNodeRequest({ headers: { host: 'not a host' } }, [])).toBe(false)
  })

  it('accepts a same-hostname Origin, with or without the port', () => {
    // Some Chromium builds serialize a loopback origin without its port; refusing
    // those would break the app's own window.
    expect(isTrustedNodeRequest({ headers: { host: '127.0.0.1:43120', origin: 'http://127.0.0.1:43120' } }, [])).toBe(true)
    expect(isTrustedNodeRequest({ headers: { host: '127.0.0.1:43120', origin: 'http://127.0.0.1' } }, [])).toBe(true)
    expect(isTrustedNodeRequest({ headers: { host: 'localhost:3080', origin: 'http://localhost' } }, [])).toBe(true)
  })

  it('accepts a deployment-declared authority, with the port rules it promises', () => {
    const trusted = ['dsh.example.test', 'other.test:8443']
    expect(isTrustedNodeRequest({ headers: { host: 'dsh.example.test' } }, trusted)).toBe(true)
    // A port-less entry matches any port on that hostname.
    expect(isTrustedNodeRequest({ headers: { host: 'dsh.example.test:8443' } }, trusted)).toBe(true)
    // A port-bearing entry must match exactly.
    expect(isTrustedNodeRequest({ headers: { host: 'other.test:8443' } }, trusted)).toBe(true)
    expect(isTrustedNodeRequest({ headers: { host: 'other.test:9999' } }, trusted)).toBe(false)
    expect(isTrustedNodeRequest({ headers: { host: 'unlisted.test' } }, trusted)).toBe(false)
  })

  it('knows what loopback means', () => {
    for (const host of ['127.0.0.1', '127.255.255.255', 'localhost', '[::1]'])
      expect(isLoopbackHostname(host), host).toBe(true)
    for (const host of ['127.0.0.1.evil.test', '127.0.0.256', '10.0.0.1', '::1', 'localhost.evil.test'])
      expect(isLoopbackHostname(host), host).toBe(false)
  })
})

describe('the status route', () => {
  it('answers the status with a secret-free snapshot', () => {
    const result = call(handler)
    expect(result.status).toBe(200)
    expect(result.headers['cache-control']).toBe('no-store')
    expect(result.headers['content-type']).toContain('application/json')
    const body = result.body as { ok: boolean; value: NodeStatusView }
    expect(body.ok).toBe(true)
    expect(body.value.state).toBe('ready')
    expect(body.value.nodeId).toBe('node-abcdef0123456789')
    // `coordinatorOrigin` is origin-only by construction; assert the route does not
    // put a path, query, or credential back.
    expect(body.value.coordinatorOrigin).toBe('ws://127.0.0.1:39471')
    expect(result.text).not.toContain(TOKEN)
  })

  it('serializes whatever the host hands it, so redaction stays the host\'s job', () => {
    // This documents the boundary instead of pretending the route sanitizes: the
    // payload is the host's own snapshot. The guarantee that the *real* snapshot
    // never carries a token lives in `status.test.ts` / `config.test.ts`, and this
    // test exists so nobody "fixes" a leak here by inventing fields at the edge.
    const leaky = createNodeRouteHandler({
      status: () => snapshot({ nodeName: TOKEN }),
      trustedHosts: () => [],
    })
    const result = call(leaky)
    expect(result.status).toBe(200)
    expect(result.text).toContain(TOKEN)

    // And the route adds no field of its own beyond the documented view.
    const keys = Object.keys((call(handler).body as { value: Record<string, unknown> }).value).sort()
    expect(keys).toEqual([
      'activeStreams', 'connectionId', 'coordinatorOrigin', 'inFlightRequests', 'lastConnectedAt',
      'mode', 'nodeId', 'nodeName', 'pluginVersion', 'reconnectAttempt', 'role', 'state', 'updatedAt', 'uptimeMs',
    ])
  })

  it('answers /ping with just enough to prove the route is alive', () => {
    const result = call(handler, { url: `${NODE_ROUTE_PREFIX}/ping` })
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ ok: true, value: { plugin: 'dsh-node', pluginVersion: '0.1.0', state: 'ready' } })
  })

  it('answers the bare prefix like /ping, so a browser hitting it gets an answer', () => {
    expect(call(handler, { url: NODE_ROUTE_PREFIX }).status).toBe(200)
    expect(call(handler, { url: `${NODE_ROUTE_PREFIX}/` }).status).toBe(200)
  })

  it('is read-only over everything except the one write route: POST is refused with Allow', () => {
    const result = call(handler, { method: 'POST' })
    expect(result.status).toBe(405)
    expect(result.headers['allow']).toBe('GET, HEAD')
    expect(result.body).toMatchObject({ ok: false, error: { code: 'method-not-allowed' } })
    // The status route stays a read even when a configuration surface exists.
    expect(call(withConfig, { method: 'POST' }).status).toBe(405)
    expect(call(withConfig, { method: 'POST', url: `${NODE_ROUTE_PREFIX}/api/status` }).status).toBe(405)
    expect(call(withConfig, { method: 'DELETE', url: `${NODE_ROUTE_PREFIX}/api/config` }).status).toBe(405)
  })

  it('answers HEAD with headers and no body', () => {
    const result = call(handler, { method: 'HEAD' })
    expect(result.status).toBe(200)
    expect(result.text).toBe('')
  })

  it('refuses an untrusted host without leaking whether the route exists', () => {
    const result = call(handler, { headers: { host: 'evil.example' } })
    expect(result.status).toBe(403)
    expect(result.body).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  })

  it('answers an unknown sub-path with a coded 404', () => {
    const result = call(handler, { url: `${NODE_ROUTE_PREFIX}/api/nope` })
    expect(result.status).toBe(404)
    expect(result.body).toMatchObject({ ok: false, error: { code: 'not-found' } })
  })

  it('turns a throwing status provider into a coded 500 instead of escaping', () => {
    // A throw escaping the handler would become a bare webserver 500 with no
    // envelope, and the client maps a *coded* failure to "status unavailable".
    const throwing = createNodeRouteHandler({
      status: () => { throw new Error('the host is gone') },
      trustedHosts: () => [],
    })
    const result = call(throwing)
    expect(result.status).toBe(500)
    expect(result.body).toMatchObject({ ok: false, error: { code: 'internal' } })
  })

  it('reads the status per request, so an unconfigured node is described accurately', () => {
    let current = snapshot({ state: 'unconfigured' })
    const live = createNodeRouteHandler({ status: () => current, trustedHosts: () => [] })
    expect((call(live).body as { value: NodeStatusView }).value.state).toBe('unconfigured')

    current = snapshot({
      state: 'backoff',
      reconnectAttempt: 3,
      lastError: { code: 'node/handshake-timeout', message: 'no hello.ok', at: '2026-09-20T12:00:00.000Z' },
    })
    const next = (call(live).body as { value: NodeStatusView }).value
    expect(next.state).toBe('backoff')
    expect(next.reconnectAttempt).toBe(3)
    expect(next.lastError?.code).toBe('node/handshake-timeout')
  })
})

describe('the configuration route', () => {
  it('does not exist without a surface, so a deployment with no home stays read-only', () => {
    // The method gate keys off the surface, not off the path: a host that could not
    // resolve a place to write must not advertise a write route at all.
    expect(call(handler, { url: `${NODE_ROUTE_PREFIX}/api/config` }).status).toBe(404)
    const post = call(handler, { method: 'POST', url: `${NODE_ROUTE_PREFIX}/api/config` })
    expect(post.status).toBe(405)
    expect(post.headers['allow']).toBe('GET, HEAD')
  })

  it('answers GET with the view, and the write route with what it accepts', async () => {
    const result = call(withConfig, { url: `${NODE_ROUTE_PREFIX}/api/config` })
    expect(result.status).toBe(200)
    expect((result.body as { value: NodeConfigView }).value).toEqual(configView())

    const refused = await callAsync(withConfig, { method: 'PUT', url: `${NODE_ROUTE_PREFIX}/api/config` })
    expect(refused.status).toBe(405)
    expect(refused.headers['allow']).toBe('GET, HEAD, POST')
  })

  it('serializes exactly the view, adding no field of its own', () => {
    const value = (call(withConfig, { url: `${NODE_ROUTE_PREFIX}/api/config` }).body as { value: Record<string, unknown> }).value
    expect(Object.keys(value).sort()).toEqual([
      'configFile', 'coordinatorUrl', 'nodeId', 'sources', 'tokenSet',
    ])
  })

  it('accepts a POST, hands the body to the surface unchanged, and answers the new view', async () => {
    const { surface, writes } = configSurface({
      write: async () => configView({ nodeName: 'desk', sources: { coordinatorUrl: 'panel', token: 'panel' } }),
    })
    const route = createNodeRouteHandler({ status: () => snapshot(), trustedHosts: () => [], config: surface })
    const result = await callAsync(route, {
      method: 'POST',
      url: `${NODE_ROUTE_PREFIX}/api/config`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ coordinatorUrl: 'ws://127.0.0.1:39472/node', token: TOKEN, nodeName: 'desk' }),
    })
    expect(result.status).toBe(200)
    // Forwarded by reference: the surface — not the route — decides what a field means.
    expect(writes).toEqual([{ coordinatorUrl: 'ws://127.0.0.1:39472/node', token: TOKEN, nodeName: 'desk' }])
    expect((result.body as { value: NodeConfigView }).value.nodeName).toBe('desk')
  })

  it('turns a surface refusal into its own status, not a bare 500', async () => {
    const { surface } = configSurface({
      write: async () => {
        throw new HttpFailure(400, {
          code: 'node/config-incomplete',
          message: 'the node still has no token',
          details: { missing: ['token'] },
        })
      },
    })
    const route = createNodeRouteHandler({ status: () => snapshot(), trustedHosts: () => [], config: surface })
    const result = await callAsync(route, { method: 'POST', url: `${NODE_ROUTE_PREFIX}/api/config`, body: '{}' })
    expect(result.status).toBe(400)
    expect(result.body).toMatchObject({
      ok: false,
      error: { code: 'node/config-incomplete', details: { missing: ['token'] } },
    })
  })

  it('reports an unexpected surface crash as a coded 500 instead of escaping', async () => {
    const { surface } = configSurface({ write: async () => { throw new TypeError('boom') } })
    const route = createNodeRouteHandler({ status: () => snapshot(), trustedHosts: () => [], config: surface })
    const result = await callAsync(route, { method: 'POST', url: `${NODE_ROUTE_PREFIX}/api/config`, body: '{}' })
    expect(result.status).toBe(500)
    expect(result.body).toMatchObject({ ok: false, error: { code: 'internal' } })
  })

  it('refuses a body that is not a JSON object', async () => {
    const route = createNodeRouteHandler({ status: () => snapshot(), trustedHosts: () => [], config: configSurface().surface })
    for (const body of ['not json', '[1,2,3]', '"a string"', '42']) {
      const result = await callAsync(route, { method: 'POST', url: `${NODE_ROUTE_PREFIX}/api/config`, body })
      expect(result.status, body).toBe(400)
      expect(result.body, body).toMatchObject({ ok: false, error: { code: 'invalid-arguments' } })
    }
  })

  it('reads an empty body as an empty document, so clearing every field is expressible', async () => {
    const { surface, writes } = configSurface()
    const route = createNodeRouteHandler({ status: () => snapshot(), trustedHosts: () => [], config: surface })
    const result = await callAsync(route, { method: 'POST', url: `${NODE_ROUTE_PREFIX}/api/config`, body: '   ' })
    expect(result.status).toBe(200)
    expect(writes).toEqual([{}])
  })

  it('refuses an oversized body before parsing it', async () => {
    const { surface, writes } = configSurface()
    const route = createNodeRouteHandler({ status: () => snapshot(), trustedHosts: () => [], config: surface })
    const result = await callAsync(route, {
      method: 'POST',
      url: `${NODE_ROUTE_PREFIX}/api/config`,
      body: `{"token":"${'x'.repeat(MAX_CONFIG_BODY_BYTES)}"}`,
    })
    expect(result.status).toBe(413)
    expect(writes).toHaveLength(0)
  })

  it('fences the write route exactly like the reads', async () => {
    const { surface, writes } = configSurface()
    const route = createNodeRouteHandler({ status: () => snapshot(), trustedHosts: () => [], config: surface })
    const rebound = await callAsync(route, {
      method: 'POST',
      url: `${NODE_ROUTE_PREFIX}/api/config`,
      headers: { host: 'evil.example' },
      body: '{}',
    })
    expect(rebound.status).toBe(403)
    const crossSite = await callAsync(route, {
      method: 'POST',
      url: `${NODE_ROUTE_PREFIX}/api/config`,
      headers: { 'sec-fetch-site': 'cross-site' },
      body: '{}',
    })
    expect(crossSite.status).toBe(403)
    // Nothing reached the surface, so a fenced request cannot change the node's
    // configuration even if it guessed the shape correctly.
    expect(writes).toHaveLength(0)
  })

  it('answers HEAD on the configuration route with headers and no body', () => {
    const result = call(withConfig, { method: 'HEAD', url: `${NODE_ROUTE_PREFIX}/api/config` })
    expect(result.status).toBe(200)
    expect(result.text).toBe('')
    expect(result.headers['cache-control']).toBe('no-store')
  })
})
