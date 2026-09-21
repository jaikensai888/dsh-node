/**
 * Fake Coordinator — a local, loopback-only stand-in for the real Coordinator,
 * used to smoke-test `dsh-node` end to end before one exists.
 *
 * It answers `hello` with `hello.ok`, answers `ping` with `pong`, records every
 * frame it sees, and can optionally invoke endpoints on the node so you can watch
 * a real Remote call go out and its result come back.
 *
 * ## Two properties this fixture has to keep
 *
 * 1. **Loopback only.** The listener is bound to `127.0.0.1` and the host is not
 *    configurable. A test fixture must never be reachable from the network.
 * 2. **The credential never reaches disk.** `hello.auth.token` is replaced before
 *    anything is written, and a token is only ever compared, never printed. Read
 *    `--expect-token-env` for how to check the token without putting it in argv.
 *
 * Not part of the published package: this is a development tool, so it stays out
 * of `package.json#files`. It is plain JavaScript on purpose — no build step, so
 * `node tools/fake-coordinator.mjs` always works, even from a dirty tree.
 *
 *   node tools/fake-coordinator.mjs --help
 */

import { appendFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { WebSocketServer } from 'ws'

/** The only protocol version this fixture speaks. */
export const PROTOCOL_VERSION = 'dsh-node/1'

/** The only interface this fixture ever binds. */
export const LOOPBACK_HOST = '127.0.0.1'

const USAGE = `
fake Coordinator for dsh-node — smoke-test the node without a real Coordinator.

Usage:
  node tools/fake-coordinator.mjs [options]

Options:
  --port <n>              listen on this loopback port            (default 39471)
  --log <path>            append every event to this file         (default .tmp/fake-coordinator.log)
  --probe <a,b,...>       after the node reports ready, send one rpc.request per endpoint
  --probe-args <json>     args object for every probe             (default {})
  --probe-stream <a,b,..> after ready, send one stream.open per endpoint
  --cancel-after <n>      cancel each probed stream after n data frames
  --expect-token-env <V>  compare the token with $V; never passed as a value,
                          so the secret stays out of argv and shell history
  --help                  print this text

Examples:
  # watch a node connect and complete the handshake
  node tools/fake-coordinator.mjs

  # verify the node really uses DSH_NODE_TOKEN
  node tools/fake-coordinator.mjs --expect-token-env DSH_NODE_TOKEN

  # prove a registered Remote is reachable, and that an unregistered one is not
  node tools/fake-coordinator.mjs --probe pluginInventory/list,nope/missing

  # open a stream and watch seq / end, then exercise cancellation
  node tools/fake-coordinator.mjs --probe-stream session/follow --probe-args '{"sessionId":"s-1"}' --cancel-after 3

It binds 127.0.0.1 only. It never writes the token anywhere.
`.trim()

/**
 * Parse this tool's argv.
 * @param argv - arguments after the script path.
 * @returns resolved options.
 * @throws when an unknown option or a malformed value is given.
 */
export function parseArgs(argv) {
  const options = {
    port: 39471,
    log: '.tmp/fake-coordinator.log',
    probe: undefined,
    probeStream: undefined,
    probeArgs: {},
    cancelAfter: undefined,
    expectTokenEnv: undefined,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    const take = () => {
      if (value === undefined) throw new Error(`${flag} requires a value`)
      index += 1
      return value
    }
    const list = () => take().split(',').map(part => part.trim()).filter(part => part !== '')
    switch (flag) {
      case '--port': {
        const port = Number(take())
        if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`--port must be 1..65535, got ${value}`)
        options.port = port
        break
      }
      case '--log':
        options.log = take()
        break
      case '--probe':
        options.probe = list()
        break
      case '--probe-stream':
        options.probeStream = list()
        break
      case '--probe-args': {
        const raw = take()
        const parsed = JSON.parse(raw)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('--probe-args must be a JSON object')
        }
        options.probeArgs = parsed
        break
      }
      case '--cancel-after': {
        const count = Number(take())
        if (!Number.isInteger(count) || count < 0) throw new Error(`--cancel-after must be a non-negative integer, got ${value}`)
        options.cancelAfter = count
        break
      }
      case '--expect-token-env':
        options.expectTokenEnv = take()
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        throw new Error(`unknown option ${JSON.stringify(flag)}`)
    }
  }
  return options
}

/**
 * Replace every credential in a frame before it can be written anywhere.
 *
 * A `hello` frame carries the bearer token, and this tool's log is a file on
 * disk. The token is replaced outright; only its presence and length survive,
 * which is enough to debug "the node sent no token" without ever storing one.
 * @param frame - any decoded frame.
 * @returns a copy safe to persist.
 */
export function redactFrame(frame) {
  if (frame === null || typeof frame !== 'object') return frame
  const copy = { ...frame }
  if (copy.auth !== undefined && typeof copy.auth === 'object' && copy.auth !== null) {
    const token = copy.auth.token
    copy.auth = {
      type: copy.auth.type,
      token: typeof token === 'string' && token !== '' ? '«redacted»' : '«absent»',
    }
  }
  return copy
}

/** Describe a token without disclosing it. */
function describeToken(token) {
  return typeof token === 'string' && token !== '' ? `present(${token.length} chars)` : 'absent'
}

/**
 * Start the fixture.
 * @param options - parsed options from {@link parseArgs}.
 * @param env - environment used by `--expect-token-env`.
 * @returns handles for the running fixture.
 */
export function createCoordinator(options, env = process.env) {
  writeFileSync(options.log, '')
  const expectedToken = options.expectTokenEnv === undefined ? undefined : env[options.expectTokenEnv]

  const log = message => {
    const line = `${new Date().toISOString()}  ${message}`
    appendFileSync(options.log, `${line}\n`)
    console.log(line)
  }

  let connections = 0
  let probed = false
  let probedStream = false
  /** Per-stream count of `stream.data` frames actually received. */
  const dataCounts = new Map()
  /** Stream ids that have been acknowledged and not yet terminated. */
  const seenStreams = new Set()
  const server = new WebSocketServer({ host: LOOPBACK_HOST, port: options.port })

  server.on('listening', () => {
    log(`LISTENING ws://${LOOPBACK_HOST}:${options.port}/node  (log: ${options.log})`)
    if (options.expectTokenEnv !== undefined) {
      log(`EXPECT-TOKEN from env ${options.expectTokenEnv}: ${describeToken(expectedToken)}`)
    }
  })

  server.on('connection', (socket, request) => {
    connections += 1
    const id = connections
    log(`#${id} CONNECT from ${request.socket.remoteAddress} (total ${connections})`)

    socket.on('message', data => {
      let frame
      try {
        frame = JSON.parse(data.toString())
      } catch {
        log(`#${id} RECV <unparseable ${data.length} bytes>`)
        return
      }
      log(`#${id} RECV ${JSON.stringify(redactFrame(frame))}`)

      if (frame.type === 'hello') {
        const token = frame.auth?.token
        log(
          `#${id} HELLO nodeId=${frame.nodeId} mode=${frame.mode} `
          + `nodeName=${frame.nodeName ?? '-'} role=${frame.role ?? '-'} token=${describeToken(token)}`,
        )
        if (expectedToken !== undefined && token !== expectedToken) {
          log(`#${id} TOKEN MISMATCH — refusing the handshake (expected the value of $${options.expectTokenEnv})`)
          socket.close(4401, 'token mismatch')
          return
        }
        socket.send(JSON.stringify({
          type: 'hello.ok',
          protocolVersion: PROTOCOL_VERSION,
          nodeId: frame.nodeId,
          connectionId: `fake-conn-${id}`,
          acceptedMode: 'full-access',
        }))
        log(`#${id} SENT hello.ok connectionId=fake-conn-${id}`)
        return
      }

      if (frame.type === 'ping') {
        socket.send(JSON.stringify({
          type: 'pong',
          protocolVersion: PROTOCOL_VERSION,
          nodeId: frame.nodeId,
          ...(frame.messageId === undefined ? {} : { messageId: frame.messageId }),
        }))
        return
      }

      if (frame.type === 'ready') {
        const remotes = frame.capabilities?.remotes ?? []
        log(`#${id} READY endpoints=${remotes.length} hash=${frame.capabilities?.remoteSurfaceHash ?? 'none'}`)
        log(`#${id} SURFACE namespaces=${JSON.stringify(frame.capabilities?.namespaces ?? [])}`)
        log(`#${id} SURFACE sample=${JSON.stringify(remotes.slice(0, 6).map(entry => `${entry.mode} ${entry.endpoint}`))}`)
        if (options.probe !== undefined && !probed) {
          probed = true
          for (const [index, endpoint] of options.probe.entries()) {
            const requestId = `probe-${index}-${Date.now()}`
            log(`#${id} PROBE -> ${endpoint} args=${JSON.stringify(options.probeArgs)}`)
            socket.send(JSON.stringify({
              type: 'rpc.request',
              protocolVersion: PROTOCOL_VERSION,
              nodeId: frame.nodeId,
              requestId,
              endpoint,
              payload: { args: options.probeArgs },
            }))
          }
        }
        if (options.probeStream !== undefined && !probedStream) {
          probedStream = true
          for (const [index, endpoint] of options.probeStream.entries()) {
            const streamId = `probe-s${index}-${Date.now()}`
            log(`#${id} STREAM-OPEN -> ${endpoint} streamId=${streamId} args=${JSON.stringify(options.probeArgs)}`)
            socket.send(JSON.stringify({
              type: 'stream.open',
              protocolVersion: PROTOCOL_VERSION,
              nodeId: frame.nodeId,
              streamId,
              requestId: `probe-s${index}`,
              endpoint,
              payload: { args: options.probeArgs },
            }))
          }
        }
        return
      }

      if (frame.type === 'rpc.result') {
        const { ok, value, error } = frame.result ?? {}
        if (ok) {
          const text = JSON.stringify(value)
          const out = `${options.log}.result.json`
          writeFileSync(out, text)
          log(`#${id} RESULT requestId=${frame.requestId} ok=true bytes=${text.length} -> ${out}`)
        } else {
          log(
            `#${id} RESULT requestId=${frame.requestId} ok=false code=${error?.code} `
            + `message=${error?.message} details=${JSON.stringify(error?.details ?? {})}`,
          )
        }
        return
      }

      if (frame.type === 'stream.ready') {
        seenStreams.add(frame.streamId)
        dataCounts.set(frame.streamId, 0)
        log(`#${id} STREAM-READY streamId=${frame.streamId} requestId=${frame.requestId ?? '-'}`)
        return
      }

      if (frame.type === 'stream.data') {
        // Log the sequence number and the encoded size, never the value: a
        // stream may carry prompts, file contents, or credentials.
        const count = (dataCounts.get(frame.streamId) ?? 0) + 1
        dataCounts.set(frame.streamId, count)
        log(`#${id} STREAM-DATA streamId=${frame.streamId} seq=${frame.seq} bytes=${JSON.stringify(frame.value ?? null).length}`)
        if (options.cancelAfter !== undefined && count === options.cancelAfter) {
          log(`#${id} STREAM-CANCEL -> ${frame.streamId} after ${count} frames`)
          socket.send(JSON.stringify({
            type: 'stream.cancel',
            protocolVersion: PROTOCOL_VERSION,
            nodeId: frame.nodeId,
            streamId: frame.streamId,
            reason: 'fake coordinator reached its cancel-after threshold',
          }))
        }
        return
      }

      if (frame.type === 'stream.end') {
        log(`#${id} STREAM-END streamId=${frame.streamId} count=${frame.count} (frames seen ${dataCounts.get(frame.streamId) ?? 0})`)
        seenStreams.delete(frame.streamId)
        return
      }

      if (frame.type === 'stream.error') {
        log(
          `#${id} STREAM-ERROR streamId=${frame.streamId} count=${frame.count} `
          + `code=${frame.error?.code} message=${frame.error?.message} details=${JSON.stringify(frame.error?.details ?? {})}`,
        )
        seenStreams.delete(frame.streamId)
        return
      }

      if (frame.type === 'close') {
        log(`#${id} CLOSE code=${frame.code ?? '-'} reason=${frame.reason ?? '-'} reconnect=${frame.reconnect ?? '-'}`)
      }
    })

    socket.on('close', (code, reason) => {
      log(`#${id} DISCONNECT code=${code} reason=${reason.toString()}`)
    })
    socket.on('error', error => {
      log(`#${id} ERROR ${error.message}`)
    })
  })

  server.on('error', error => {
    log(`SERVER ERROR ${error.message}`)
    if (error.code === 'EADDRINUSE') {
      log(`hint: port ${options.port} is already in use — pick another with --port`)
    }
  })

  return {
    server,
    /** Stop listening and drop every node connection. */
    async close() {
      for (const socket of server.clients) socket.terminate()
      await new Promise(resolve => { server.close(() => { resolve() }) })
      log('STOPPED')
    },
  }
}

/** Run the CLI when this file is executed directly. */
function main(argv) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`fake-coordinator: ${error.message}\n`)
    console.error(USAGE)
    process.exitCode = 2
    return
  }
  if (options.help) {
    console.log(USAGE)
    return
  }

  const coordinator = createCoordinator(options)
  const stop = () => {
    coordinator.close().then(() => { process.exit(0) }, () => { process.exit(1) })
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

// Only start a server when run as a program; importing this module for its
// helpers must have no side effects.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
}
