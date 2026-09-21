/**
 * The panel's two routes, and what a refusal looks like to an operator.
 *
 * The host refuses a save for reasons the operator can act on — a missing token, an
 * `http://` URL, a trigger-happy trust fence — and every one of those arrives as a
 * coded envelope. This is the test that the codes become sentences: a panel that says
 * only "请求失败" turns a one-line fix into a hunt.
 *
 * @module dsh-node/test/client-config
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CONFIG_PATH,
  describeConfigFailure,
  fetchNodeConfig,
  saveNodeConfig,
  type NodeConfigSnapshot,
} from '../src/client/config-source.js'

/** The address the panel would have typed. */
const URL_VALUE = 'ws://127.0.0.1:39472/node'

const VIEW: NodeConfigSnapshot = {
  coordinatorUrl: URL_VALUE,
  tokenSet: true,
  nodeId: 'node-abcdef0123456789',
  configFile: 'C:/Users/someone/.dsh/storages/dsh-node/config.json',
  sources: { coordinatorUrl: 'panel', token: 'panel' },
}

/** Replace `fetch` for one test and record what it was asked for. */
function stubFetch(reply: { readonly status?: number; readonly body: unknown; readonly raw?: string }) {
  const calls: { readonly url: string; readonly init: RequestInit | undefined }[] = []
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return Promise.resolve({
      ok: (reply.status ?? 200) < 400,
      status: reply.status ?? 200,
      json: async () => {
        if (reply.raw !== undefined) return JSON.parse(reply.raw) as unknown
        return reply.body
      },
    })
  })
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('reading the configuration', () => {
  it('unwraps the envelope and asks for no cache', async () => {
    const calls = stubFetch({ body: { ok: true, value: VIEW } })
    const view = await fetchNodeConfig(new AbortController().signal)
    expect(view).toEqual(VIEW)
    expect(calls[0]?.url).toBe(CONFIG_PATH)
    expect(calls[0]?.init?.method).toBe('GET')
    expect(calls[0]?.init?.cache).toBe('no-store')
  })

  it('turns a coded refusal into a readable message', async () => {
    stubFetch({
      status: 403,
      body: { ok: false, error: { code: 'forbidden', message: 'the request did not pass the dsh-node trust fence' } },
    })
    await expect(fetchNodeConfig(new AbortController().signal)).rejects.toThrow(/信任校验/u)
  })

  it('reports a non-JSON answer as itself instead of pretending it parsed', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token <') },
    }))
    await expect(fetchNodeConfig(new AbortController().signal)).rejects.toThrow('响应不是 JSON')
  })
})

describe('saving the configuration', () => {
  it('posts the draft as JSON and returns the view the host produced', async () => {
    const calls = stubFetch({ body: { ok: true, value: VIEW } })
    const view = await saveNodeConfig({ coordinatorUrl: URL_VALUE, token: 'typed-token', nodeName: 'desk' })
    expect(view).toEqual(VIEW)
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[0]?.init?.headers).toMatchObject({ 'content-type': 'application/json' })
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      coordinatorUrl: URL_VALUE,
      token: 'typed-token',
      nodeName: 'desk',
    })
  })

  it('sends an explicit null when the token is meant to be cleared', async () => {
    const calls = stubFetch({ body: { ok: true, value: { ...VIEW, tokenSet: false } } })
    await saveNodeConfig({ token: null })
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ token: null })
  })

  it('carries the host\'s own reason for a refused save', async () => {
    stubFetch({
      status: 400,
      body: {
        ok: false,
        error: { code: 'node/config-incomplete', message: 'the node still has no token; both are required' },
      },
    })
    await expect(saveNodeConfig({ coordinatorUrl: URL_VALUE })).rejects.toThrow(/还缺少必要信息/u)
  })

  it('says the file was saved when only the restart failed', async () => {
    stubFetch({
      status: 500,
      body: {
        ok: false,
        error: { code: 'node/reconfigure-failed', message: 'identity file is unreadable' },
      },
    })
    // The distinction matters: the operator must not retype a saved configuration.
    await expect(saveNodeConfig({ coordinatorUrl: URL_VALUE, token: 'x' }))
      .rejects.toThrow(/已保存到配置文件，但节点重启失败/u)
  })

  it('explains a host that is too old to have the route at all', async () => {
    stubFetch({ status: 404, body: { ok: false, error: { code: 'not-found', message: 'unknown route' } } })
    await expect(saveNodeConfig({ coordinatorUrl: URL_VALUE })).rejects.toThrow(/重新启动 DSH/u)
  })
})

describe('failure messages', () => {
  it.each([
    ['forbidden', /信任校验/u],
    ['not-found', /重新启动 DSH/u],
    ['method-not-allowed', /重新启动 DSH/u],
    ['node/config-incomplete', /还缺少必要信息/u],
    ['node/config-invalid', /未通过校验/u],
    ['node/config-write-failed', /写入失败/u],
    ['node/reconfigure-failed', /重启失败/u],
  ])('maps %s to something an operator can act on', (code, pattern) => {
    expect(describeConfigFailure(code, 'detail')).toMatch(pattern)
  })

  it('keeps an unknown code visible rather than swallowing it', () => {
    expect(describeConfigFailure('node/something-new', 'detail')).toBe('node/something-new：detail')
  })
})
