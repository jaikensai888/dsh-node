/**
 * Configuration and identity.
 *
 * Covers spec §12.1 items 1-5 and, with them, the security red lines that are
 * decided during configuration: the token never comes from a URL, and a URL that
 * tries to carry one is refused rather than quietly ignored.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ALLOWED_URL_PROTOCOLS,
  BOUNDS,
  COORDINATOR_URL_ENV,
  DEFAULT_NODE_CONFIG,
  IDENTITY_FILE_ENV,
  TOKEN_ENV,
  isAllowedCoordinatorUrl,
  resolveNodeConfig,
} from '../src/config.js'
import {
  IDENTITY_FILE_NAME,
  generateNodeId,
  loadOrCreateIdentity,
  resolveDshHome,
  resolveIdentityDir,
  resolveIdentityFile,
} from '../src/identity.js'
import { createNodeLogger, cordisLogSink, escapeLogFormat, REDACTED, redactUrl, scrubText, scrubValue, statusSnapshot } from '../src/status.js'

const TOKEN = 'super-secret-token-value'
const ENV: NodeJS.ProcessEnv = { [TOKEN_ENV]: TOKEN }
const WS_URL = 'ws://127.0.0.1:8080/node'
const WSS_URL = 'wss://coordinator.example.com/node'

/** A resolution that is expected to succeed. */
function expectOk(raw: unknown, env: NodeJS.ProcessEnv = ENV) {
  const resolution = resolveNodeConfig(raw, env)
  expect(resolution.errors).toEqual([])
  expect(resolution.status).toBe('ok')
  return resolution
}

describe('coordinatorUrl validation (spec §12.1 item 1)', () => {
  it('accepts ws: and wss:', () => {
    expect(ALLOWED_URL_PROTOCOLS).toEqual(new Set(['ws:', 'wss:']))
    expect(expectOk({ coordinatorUrl: WS_URL }).config.coordinatorUrl).toBe(WS_URL)
    expect(expectOk({ coordinatorUrl: WSS_URL }).config.coordinatorUrl).toBe(WSS_URL)
    expect(isAllowedCoordinatorUrl(WS_URL)).toBe(true)
    expect(isAllowedCoordinatorUrl(WSS_URL)).toBe(true)
  })

  it.each(['http://coordinator.example.com/node', 'https://coordinator.example.com/node'])(
    'rejects %s because it is not a WebSocket endpoint',
    url => {
      const resolution = resolveNodeConfig({ coordinatorUrl: url }, ENV)
      expect(resolution.status).toBe('invalid')
      expect(resolution.errors.join('\n')).toMatch(/protocol must be "ws:" or "wss:"/u)
      expect(resolution.config.coordinatorUrl).toBeUndefined()
    },
  )

  it.each(['ftp://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url', '/node'])(
    'rejects %s',
    url => {
      expect(resolveNodeConfig({ coordinatorUrl: url }, ENV).status).toBe('invalid')
    },
  )

  it('rejects a URL carrying embedded credentials', () => {
    const resolution = resolveNodeConfig({ coordinatorUrl: 'wss://user:pass@example.com/node' }, ENV)
    expect(resolution.status).toBe('invalid')
    expect(resolution.errors.join('\n')).toMatch(/must not embed a username or password/u)
  })

  it('refuses to read a token out of the query or the fragment', () => {
    for (const url of [
      `wss://example.com/node?token=${TOKEN}`,
      `wss://example.com/node?access_token=${TOKEN}`,
      `wss://example.com/node#token=${TOKEN}`,
      `wss://example.com/node#apikey=${TOKEN}`,
    ]) {
      // The token IS available through the environment, so a node that read it
      // from the URL would look configured. It must not.
      const resolution = resolveNodeConfig({ coordinatorUrl: url }, ENV)
      expect(resolution.status).toBe('invalid')
      expect(resolution.errors.join('\n')).toMatch(/must not carry a credential/u)
      expect(resolution.config.coordinatorUrl).toBeUndefined()
      // No diagnostic may repeat the secret it just refused. (`config.token` is
      // the resolved credential and is expected to be present.)
      expect(resolution.errors.join('\n')).not.toContain(TOKEN)
    }
  })

  it('allows a non-secret routing parameter', () => {
    const url = 'wss://example.com/node?tenant=acme'
    expect(expectOk({ coordinatorUrl: url }).config.coordinatorUrl).toBe(url)
  })

  it('accepts the URL from the environment too', () => {
    const resolution = resolveNodeConfig({}, { ...ENV, [COORDINATOR_URL_ENV]: WSS_URL })
    expect(resolution.status).toBe('ok')
    expect(resolution.config.coordinatorUrl).toBe(WSS_URL)
  })

  it('prefers an explicit bootstrap value over the environment', () => {
    const resolution = resolveNodeConfig({ coordinatorUrl: WSS_URL }, { ...ENV, [COORDINATOR_URL_ENV]: WS_URL })
    expect(resolution.config.coordinatorUrl).toBe(WSS_URL)
  })

  it('warns, but does not fail, on plaintext ws:', () => {
    const resolution = expectOk({ coordinatorUrl: WS_URL })
    expect(resolution.warnings.join('\n')).toMatch(/plaintext "ws:"/u)
  })
})

describe('mode validation (spec §12.1 item 2)', () => {
  it('accepts the single defined mode', () => {
    expect(expectOk({ coordinatorUrl: WSS_URL, mode: 'full-access' }).config.mode).toBe('full-access')
    expect(expectOk({ coordinatorUrl: WSS_URL }).config.mode).toBe(DEFAULT_NODE_CONFIG.mode)
  })

  it.each(['read-only', 'FULL-ACCESS', 'admin', 'full_access', 'fullaccess'])(
    'rejects the undefined mode %s',
    value => {
      const resolution = resolveNodeConfig({ coordinatorUrl: WSS_URL, mode: value }, ENV)
      expect(resolution.status).toBe('invalid')
      expect(resolution.errors.join('\n')).toMatch(/mode must be exactly "full-access"/u)
    },
  )

  it('treats an empty mode as absent rather than invalid', () => {
    expect(expectOk({ coordinatorUrl: WSS_URL, mode: '' }).config.mode).toBe('full-access')
  })
})

describe('numeric bounds (spec §5.7)', () => {
  it('accepts a fully specified configuration', () => {
    const resolution = expectOk({
      coordinatorUrl: WSS_URL,
      reconnect: { initialDelayMs: 500, maxDelayMs: 5_000, jitterRatio: 0.1, stableResetMs: 1_000 },
      heartbeatIntervalMs: 1_000,
      handshakeTimeoutMs: 2_000,
      requestTimeoutMs: 5_000,
      maxFrameBytes: 65_536,
      maxInFlightRequests: 4,
    })
    expect(resolution.config.reconnect).toEqual({
      initialDelayMs: 500,
      maxDelayMs: 5_000,
      jitterRatio: 0.1,
      stableResetMs: 1_000,
    })
    expect(resolution.config.maxInFlightRequests).toBe(4)
  })

  it.each([
    ['heartbeatIntervalMs', 0],
    ['heartbeatIntervalMs', -1],
    ['heartbeatIntervalMs', Number.POSITIVE_INFINITY],
    ['heartbeatIntervalMs', Number.NaN],
    ['handshakeTimeoutMs', 10_000_000],
    ['maxFrameBytes', 12],
    ['maxInFlightRequests', 0],
    ['maxInFlightRequests', 1_000_000],
    ['requestTimeoutMs', 0],
    ['maxStreams', -5],
  ])('rejects %s = %s', (field, value) => {
    const resolution = resolveNodeConfig({ coordinatorUrl: WSS_URL, [field]: value }, ENV)
    expect(resolution.status).toBe('invalid')
    expect(resolution.errors.join('\n')).toContain(field)
    // The fallback keeps the config usable for diagnosis rather than NaN.
    expect(Number.isFinite((resolution.config as unknown as Record<string, unknown>)[field])).toBe(true)
  })

  it('rejects a non-numeric value instead of coercing it', () => {
    const resolution = resolveNodeConfig({ coordinatorUrl: WSS_URL, heartbeatIntervalMs: 'soon' }, ENV)
    expect(resolution.status).toBe('invalid')
    expect(resolution.errors.join('\n')).toMatch(/must be a finite number/u)
  })

  it('rejects a maxDelayMs below initialDelayMs', () => {
    const resolution = resolveNodeConfig(
      { coordinatorUrl: WSS_URL, reconnect: { initialDelayMs: 5_000, maxDelayMs: 1_000 } },
      ENV,
    )
    expect(resolution.status).toBe('invalid')
    expect(resolution.errors.join('\n')).toMatch(/must be greater than or equal to/u)
  })

  it('keeps every declared bound above zero with a ceiling', () => {
    for (const [field, bounds] of Object.entries(BOUNDS)) {
      expect(bounds.max, field).toBeGreaterThan(bounds.min)
      expect(bounds.max, field).toBeLessThanOrEqual(268_435_456)
      expect(Number.isFinite(bounds.min) && Number.isFinite(bounds.max), field).toBe(true)
    }
  })
})

describe('unconfigured is a normal state, not an error (spec §12.1 item 3)', () => {
  it.each([
    ['nothing at all', {}, {}],
    ['a URL but no token', { coordinatorUrl: WSS_URL }, {}],
    ['a token but no URL', {}, { [TOKEN_ENV]: TOKEN }],
  ])('reports unconfigured for %s', (_label, raw, env) => {
    const resolution = resolveNodeConfig(raw, env)
    expect(resolution.status).toBe('unconfigured')
    expect(resolution.errors).toEqual([])
  })

  it('never falls back to the URL as a token source', () => {
    const resolution = resolveNodeConfig({ coordinatorUrl: 'wss://example.com/node?tenant=acme' }, {})
    expect(resolution.status).toBe('unconfigured')
    expect(resolution.config.token).toBeUndefined()
  })

  it('treats a blank token as absent', () => {
    const resolution = resolveNodeConfig({ coordinatorUrl: WSS_URL, auth: { token: '   ' } }, {})
    expect(resolution.status).toBe('unconfigured')
  })
})

describe('unknown keys never reach the connector', () => {
  it('drops a key schemastery would otherwise pass through', () => {
    const resolution = expectOk({ coordinatorUrl: WSS_URL, bogus: 1, shellCommand: 'rm -rf /' })
    expect(Object.hasOwn(resolution.config, 'bogus')).toBe(false)
    expect(Object.hasOwn(resolution.config, 'shellCommand')).toBe(false)
    expect(JSON.stringify(resolution.config)).not.toContain('rm -rf')
  })

  it('ignores a data: URL supplied under an unexpected key', () => {
    const resolution = expectOk({ coordinatorUrl: WSS_URL, url: 'http://evil.example.com' })
    expect(resolution.config.coordinatorUrl).toBe(WSS_URL)
  })
})

describe('token redaction (spec §12.1 item 4)', () => {
  it('never exposes the token through an error or a warning', () => {
    // `resolution.config.token` is the resolved credential and legitimately
    // holds it; every diagnostic channel must not.
    for (const raw of [
      { coordinatorUrl: WSS_URL },
      { coordinatorUrl: 'https://bad.example.com' },
      { coordinatorUrl: WSS_URL, heartbeatIntervalMs: -1 },
      { coordinatorUrl: 'wss://user:pass@example.com' },
      { coordinatorUrl: WS_URL },
      { coordinatorUrl: WSS_URL, mode: 'admin', identityFile: 'relative.json' },
    ]) {
      const resolution = resolveNodeConfig(raw, ENV)
      expect(resolution.errors.join('\n')).not.toContain(TOKEN)
      expect(resolution.warnings.join('\n')).not.toContain(TOKEN)
    }
  })

  it('scrubs the token out of a log message and out of nested fields', () => {
    const lines: string[] = []
    const logger = createNodeLogger({
      secrets: [TOKEN],
      env: {},
      sink: (_level, message, fields) => { lines.push(`${message} ${JSON.stringify(fields)}`) },
    })

    logger.error(`handshake failed for ${TOKEN}`)
    logger.error('hello frame', { auth: { type: 'bearer', token: TOKEN }, note: `token=${TOKEN}` })
    logger.error('flat', { token: TOKEN })
    logger.error('array', { list: [TOKEN, { nested: TOKEN }] })
    logger.error('error object', { cause: new Error(`bad token ${TOKEN}`) })

    const output = lines.join('\n')
    expect(output).not.toContain(TOKEN)
    expect(output).toContain(REDACTED)
  })

  it('scrubs at any depth without looping forever on a cyclic value', () => {
    const cyclic: Record<string, unknown> = { token: TOKEN }
    cyclic['self'] = cyclic
    const scrubbed = JSON.stringify(scrubValue(cyclic, [TOKEN]))
    expect(scrubbed).not.toContain(TOKEN)
    expect(scrubbed).toContain('depth-limit')
  })

  it('reduces a URL to its origin, dropping path, query, and fragment', () => {
    expect(redactUrl(`wss://user:pass@example.com:8443/node?token=${TOKEN}#token=${TOKEN}`))
      .toBe('wss://example.com:8443')
    expect(redactUrl('not a url')).toBeUndefined()
    expect(redactUrl(undefined)).toBeUndefined()
    expect(redactUrl('')).toBeUndefined()
  })

  it('keeps the token out of the status snapshot and its serialization', () => {
    const snapshot = statusSnapshot({
      state: 'auth_failed',
      nodeId: 'node-abc',
      nodeName: 'test-agent',
      role: 'test-agent',
      coordinatorUrl: `wss://example.com/node?tenant=acme`,
      connectionId: 'conn-1',
      reconnectAttempt: 3,
      lastConnectedAt: '2026-09-18T00:00:00.000Z',
      lastError: { code: 'node/auth-failed', message: `refused credential ${TOKEN}`, at: '2026-09-18T00:00:01.000Z' },
      inFlightRequests: 2,
      activeStreams: 0,
      secrets: [TOKEN],
    })
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain(TOKEN)
    // A snapshot is returned verbatim, so an error message that echoed the
    // credential is scrubbed inside `statusSnapshot` itself.
    expect(snapshot.lastError?.message).toContain(REDACTED)
    expect(snapshot.coordinatorOrigin).toBe('wss://example.com')
    expect(serialized).not.toContain('/node')
    expect(serialized).not.toContain('tenant')

    // A snapshot built without a secret list is still URL-safe.
    const bare = statusSnapshot({
      state: 'stopped',
      nodeId: 'node-abc',
      coordinatorUrl: WSS_URL,
      reconnectAttempt: 0,
      inFlightRequests: 0,
      activeStreams: 0,
    })
    expect(bare.coordinatorOrigin).toBe('wss://coordinator.example.com')
    expect(Object.hasOwn(bare, 'lastError')).toBe(false)
    expect(Object.hasOwn(bare, 'nodeName')).toBe(false)
    expect(Object.hasOwn(bare, 'connectionId')).toBe(false)
  })
})

describe('logging destination under DSH', () => {
  /** A recording stand-in for `ctx.logger`, callable like the real one. */
  function recordingLogger() {
    const calls: { level: string; args: unknown[] }[] = []
    const make = (level: string) => (...args: unknown[]) => { calls.push({ level, args }) }
    const logger = Object.assign(() => logger, {
      error: make('error'),
      warn: make('warn'),
      info: make('info'),
      debug: make('debug'),
    })
    return { logger, calls }
  }

  /**
   * Cordis's own rendering loop, reproduced from `Logger.format`.
   *
   * Every recognized placeholder calls `args.shift()`, which is exactly how a
   * `%s` inside a message can swallow the fields object that followed it.
   */
  function renderCordisStyle(args: unknown[]): string {
    const rest = [...args]
    let format = String(rest.shift())
    const formatters: Record<string, (value: unknown) => string> = {
      s: value => String(value),
      d: value => String(Math.trunc(Number(value))),
      o: value => JSON.stringify(value),
      O: value => JSON.stringify(value),
      c: () => '',
      C: value => String(value),
    }
    format = format.replace(/%([a-zA-Z%])/g, (match, char: string) => {
      if (match === '%%') return '%'
      const formatter = formatters[char]
      return formatter === undefined ? match : formatter(rest.shift())
    })
    for (const arg of rest) format += ` ${typeof arg === 'object' && arg ? JSON.stringify(arg) : String(arg)}`
    return format
  }

  it('accepts a callable logger, which is what ctx.logger actually is', () => {
    // Regression: `ctx.logger('subsystem')` returns a named facade, so the real
    // value is a function. A guard that only accepted objects silently fell back
    // to `console`, i.e. the node logged nowhere.
    const { logger } = recordingLogger()
    expect(typeof logger).toBe('function')
    expect(cordisLogSink(logger)).toBeTypeOf('function')
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'logger'],
    ['a number', 7],
    ['an object without info', { warn: () => {} }],
  ])('refuses %s', (_label, value) => {
    expect(cordisLogSink(value)).toBeUndefined()
  })

  it('routes every level to the matching method', () => {
    const { logger, calls } = recordingLogger()
    const sink = cordisLogSink(logger)!
    sink('debug', 'd', {})
    sink('info', 'i', {})
    sink('warn', 'w', {})
    sink('error', 'e', {})
    expect(calls.map(call => call.level)).toEqual(['debug', 'info', 'warn', 'error'])
  })

  it('skips a level the logger does not implement', () => {
    const calls: unknown[] = []
    const partial = { info: (...args: unknown[]) => { calls.push(args) } }
    const sink = cordisLogSink(partial)!
    expect(() => { sink('debug', 'd', {}) }).not.toThrow()
    expect(calls).toHaveLength(0)
    sink('info', 'i', {})
    expect(calls).toHaveLength(1)
  })

  it('escapes %, so a message cannot swallow the fields argument', () => {
    const { logger, calls } = recordingLogger()
    const sink = cordisLogSink(logger)!
    // A peer-supplied close reason is exactly this shape in practice.
    sink('warn', 'closed: 100% of %s and %o', { requestId: 'req-1' })

    const rendered = renderCordisStyle(calls[0]!.args)
    // The message survives verbatim…
    expect(rendered).toContain('closed: 100% of %s and %o')
    // …and the fields are still rendered as data, not consumed as substitutions.
    expect(rendered).toContain('{"requestId":"req-1"}')
    expect(rendered).not.toContain('undefined')
  })

  it('omits the placeholder entirely when there are no fields', () => {
    const { logger, calls } = recordingLogger()
    const sink = cordisLogSink(logger)!
    sink('info', 'dsh-node/state-changed', {})
    expect(calls[0]!.args).toEqual(['dsh-node/state-changed'])
    expect(renderCordisStyle(calls[0]!.args)).toBe('dsh-node/state-changed')
  })

  it('round-trips a message made only of percent signs', () => {
    const { logger, calls } = recordingLogger()
    cordisLogSink(logger)!('info', '%%%', { a: 1 })
    expect(renderCordisStyle(calls[0]!.args)).toContain('%%% {"a":1}')
  })

  it('leaves text without percent signs untouched', () => {
    expect(escapeLogFormat('dsh-node/connected')).toBe('dsh-node/connected')
    expect(escapeLogFormat('100%')).toBe('100%%')
    expect(escapeLogFormat('a%b%c')).toBe('a%%b%%c')
  })
})

describe('identity persistence (spec §12.1 item 5, §5.8)', () => {
  let dir: string
  let file: string

  beforeEach(async () => {
    // Inside the project, not `os.tmpdir()`: the workspace is the only location
    // this session is guaranteed to be allowed to write.
    await mkdir(join(process.cwd(), '.tmp'), { recursive: true })
    dir = await mkdtemp(join(process.cwd(), '.tmp', 'identity-'))
    file = join(dir, 'identity.json')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('generates exactly once and stays stable across restarts', async () => {
    const first = await loadOrCreateIdentity({ file })
    const second = await loadOrCreateIdentity({ file })
    const third = await loadOrCreateIdentity({ file })

    expect(first.nodeId).toMatch(/^node-[0-9a-f]{32}$/u)
    expect(second.nodeId).toBe(first.nodeId)
    expect(third.nodeId).toBe(first.nodeId)

    const persisted = JSON.parse(await readFile(file, 'utf8')) as { nodeId: string }
    expect(persisted.nodeId).toBe(first.nodeId)
  })

  it('mints only one identity when two instances start together', async () => {
    const results = await Promise.all([
      loadOrCreateIdentity({ file }),
      loadOrCreateIdentity({ file }),
      loadOrCreateIdentity({ file }),
    ])
    const ids = new Set(results.map(entry => entry.nodeId))
    expect(ids.size).toBe(1)
  })

  it('prefers a configured nodeId and does not persist it', async () => {
    const identity = await loadOrCreateIdentity({ file, configuredNodeId: 'node-operator-chosen' })
    expect(identity.nodeId).toBe('node-operator-chosen')
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('quarantines a corrupt file instead of silently rewriting it', async () => {
    await writeFile(file, '{ not json', 'utf8')
    const identity = await loadOrCreateIdentity({ file })
    expect(identity.nodeId).toMatch(/^node-[0-9a-f]{32}$/u)
    const persisted = JSON.parse(await readFile(file, 'utf8')) as { nodeId: string }
    expect(persisted.nodeId).toBe(identity.nodeId)
  })

  it('quarantines a structurally valid file that carries no usable id', async () => {
    await writeFile(file, JSON.stringify({ nodeId: '' }), 'utf8')
    const identity = await loadOrCreateIdentity({ file })
    expect(identity.nodeId).not.toBe('')
  })

  it('resolves the identity file under the harness home', () => {
    const env = { DSH_HOME: 'C:\\dsh-home' }
    expect(resolveDshHome(env)).toBe('C:\\dsh-home')
    expect(resolveIdentityDir(env)).toBe(join('C:\\dsh-home', 'storages', 'dsh-node'))
    expect(resolveIdentityFile(env)).toBe(join('C:\\dsh-home', 'storages', 'dsh-node', IDENTITY_FILE_NAME))
  })

  it('ignores a blank DSH_HOME rather than resolving to the cwd', () => {
    const fromBlank = resolveDshHome({ DSH_HOME: '   ' })
    expect(fromBlank).not.toBe(process.cwd())
    expect(fromBlank.endsWith('.dsh')).toBe(true)
  })

  it('honours an absolute identityFile override and refuses a relative one', async () => {
    const override = join(dir, 'custom', 'id.json')
    expect(resolveIdentityFile({}, override)).toBe(override)
    expect(() => resolveIdentityFile({}, 'relative/id.json')).toThrow(/absolute path/u)

    const resolution = resolveNodeConfig({ coordinatorUrl: WSS_URL, identityFile: override }, ENV)
    expect(resolution.status).toBe('ok')
    expect(resolution.config.identityFile).toBe(override)

    const bad = resolveNodeConfig({ coordinatorUrl: WSS_URL, identityFile: 'relative/id.json' }, ENV)
    expect(bad.status).toBe('invalid')
  })

  it('accepts the identity file from the environment', () => {
    const override = join(dir, 'env-identity.json')
    expect(resolveNodeConfig({ coordinatorUrl: WSS_URL }, { ...ENV, [IDENTITY_FILE_ENV]: override }).config.identityFile)
      .toBe(override)
  })

  it('mints ids from the injected random source', () => {
    expect(generateNodeId(size => Buffer.alloc(size, 0xab))).toBe(`node-${'ab'.repeat(16)}`)
  })
})

describe('nodeName and role are display metadata only (spec §5.8)', () => {
  it('is carried through as-is and never substitutes for nodeId', () => {
    const resolution = expectOk({ coordinatorUrl: WSS_URL, nodeName: 'test-agent-a', role: 'test-agent' })
    expect(resolution.config.nodeName).toBe('test-agent-a')
    expect(resolution.config.role).toBe('test-agent')
    expect(resolution.config.nodeId).toBeUndefined()
  })
})
