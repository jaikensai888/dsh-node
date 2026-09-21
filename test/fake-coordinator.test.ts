/**
 * The fake Coordinator fixture's own guarantees.
 *
 * This tool is a development fixture, but two of its properties are
 * security-relevant and easy to lose in a refactor, so they are locked here:
 *
 * 1. the credential is stripped before a frame reaches the log file, and
 * 2. the token is never taken from `argv` (it comes from an environment
 *    variable), so it cannot end up in shell history or a process listing.
 */

import { describe, expect, it } from 'vitest'
import { LOOPBACK_HOST, parseArgs, redactFrame } from '../tools/fake-coordinator.mjs'

const TOKEN = 'super-secret-token-value'

describe('credential redaction', () => {
  it('replaces the hello token and keeps only its presence', () => {
    const redacted = redactFrame({
      type: 'hello',
      protocolVersion: 'dsh-node/1',
      nodeId: 'node-1',
      mode: 'full-access',
      auth: { type: 'bearer', token: TOKEN },
    })
    expect(JSON.stringify(redacted)).not.toContain(TOKEN)
    expect(redacted.auth).toEqual({ type: 'bearer', token: '«redacted»' })
    // The original frame is untouched, so redaction cannot corrupt the reply.
    expect(JSON.stringify(redacted)).toContain('node-1')
  })

  it('marks an absent token distinctly from a present one', () => {
    expect(redactFrame({ auth: { type: 'bearer' } }).auth).toEqual({ type: 'bearer', token: '«absent»' })
    expect(redactFrame({ auth: { type: 'bearer', token: '' } }).auth).toEqual({ type: 'bearer', token: '«absent»' })
    expect(redactFrame({ auth: null }).auth).toBe(null)
  })

  it('passes a frame without auth through unchanged', () => {
    const frame = { type: 'rpc.result', requestId: 'r-1', result: { ok: true, value: { a: 1 } } }
    expect(redactFrame(frame)).toEqual(frame)
  })

  it('is safe on non-objects', () => {
    expect(redactFrame(null)).toBe(null)
    expect(redactFrame('hello')).toBe('hello')
    expect(redactFrame(7)).toBe(7)
  })
})

describe('argument parsing', () => {
  it('defaults to a loopback port and a .tmp log', () => {
    const options = parseArgs([])
    expect(options.port).toBe(39471)
    expect(options.log).toBe('.tmp/fake-coordinator.log')
    expect(options.probe).toBeUndefined()
    expect(options.probeStream).toBeUndefined()
    expect(options.cancelAfter).toBeUndefined()
    expect(options.probeArgs).toEqual({})
    expect(options.expectTokenEnv).toBeUndefined()
  })

  it('accepts a comma-separated probe list, trimming blanks', () => {
    expect(parseArgs(['--probe', 'pluginInventory/list, nope/missing ,']).probe)
      .toEqual(['pluginInventory/list', 'nope/missing'])
    expect(parseArgs(['--probe-stream', 'session/follow,session/control']).probeStream)
      .toEqual(['session/follow', 'session/control'])
  })

  it('accepts a cancel-after threshold and rejects nonsense', () => {
    expect(parseArgs(['--cancel-after', '3']).cancelAfter).toBe(3)
    expect(parseArgs(['--cancel-after', '0']).cancelAfter).toBe(0)
    expect(() => parseArgs(['--cancel-after', '-1'])).toThrow(/non-negative integer/u)
    expect(() => parseArgs(['--cancel-after', '1.5'])).toThrow(/non-negative integer/u)
  })

  it('leaves stream and unary probing independent', () => {
    const options = parseArgs(['--probe', 'a/b', '--probe-stream', 'c/d', '--probe-args', '{"x":1}'])
    expect(options.probe).toEqual(['a/b'])
    expect(options.probeStream).toEqual(['c/d'])
    expect(options.probeArgs).toEqual({ x: 1 })
  })

  it('parses probe args as a JSON object', () => {
    expect(parseArgs(['--probe-args', '{"sessionId":"s-1"}']).probeArgs).toEqual({ sessionId: 's-1' })
  })

  it.each(['[]', 'null', '"x"', '3'])('rejects a non-object probe-args value %s', raw => {
    expect(() => parseArgs(['--probe-args', raw])).toThrow(/must be a JSON object/u)
  })

  it('takes the expected token from an environment variable name, not a value', () => {
    // There is deliberately no `--expect-token` flag: a value on the command
    // line would land in shell history and in the process listing.
    expect(parseArgs(['--expect-token-env', 'DSH_NODE_TOKEN']).expectTokenEnv).toBe('DSH_NODE_TOKEN')
    expect(() => parseArgs(['--expect-token', TOKEN])).toThrow(/unknown option/u)
  })

  it.each([['--port', '0'], ['--port', '70000'], ['--port', 'abc'], ['--port', '-1']])(
    'rejects %s %s',
    (flag, value) => {
      expect(() => parseArgs([flag, value])).toThrow(/--port must be/u)
    },
  )

  it('rejects an unknown option and a missing value', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown option/u)
    expect(() => parseArgs(['--log'])).toThrow(/requires a value/u)
  })

  it('recognises --help', () => {
    expect(parseArgs(['--help']).help).toBe(true)
    expect(parseArgs(['-h']).help).toBe(true)
  })
})

describe('binding policy', () => {
  it('exposes loopback as the only interface, with no host option', () => {
    expect(LOOPBACK_HOST).toBe('127.0.0.1')
    // A test fixture reachable from the network would be a security problem, so
    // the host is a constant rather than a flag.
    expect(() => parseArgs(['--host', '0.0.0.0'])).toThrow(/unknown option/u)
  })
})
