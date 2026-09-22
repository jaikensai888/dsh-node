/**
 * Where the panel reads and writes the node's configuration.
 *
 * Two routes, one shape: the same envelope the status route uses, the same
 * `no-store`, and the same rule that a failure is reported as itself. The only new
 * idea here is that a **rejection is expected traffic**: the host refuses an
 * incomplete or invalid configuration with a coded reason, and that reason is the
 * content the operator needs. So the save path turns an error envelope into a
 * message instead of throwing it away as "请求失败".
 *
 * @module dsh-node/client/config-source
 */

/** The configuration route, relative so it follows whatever host serves the page. */
export const CONFIG_PATH = '/dsh-node/api/config'

/** Which layer supplied an effective value. */
export type ConfigSource = 'panel' | 'profile' | 'environment' | 'none'

/** The configuration view the host publishes. It never contains the token. */
export interface NodeConfigSnapshot {
  readonly coordinatorUrl?: string
  /** Whether a credential is stored. The value itself is never returned. */
  readonly tokenSet: boolean
  readonly nodeName?: string
  readonly role?: string
  /** The persisted manual connection decision, when supported by the host. */
  readonly connectionIntent?: 'active' | 'paused'
  readonly nodeId: string
  /** Absolute path of the file a save writes. */
  readonly configFile: string
  /** Set when the stored file exists but was unusable and ignored. */
  readonly configFileError?: string
  readonly sources: {
    readonly coordinatorUrl: ConfigSource
    readonly token: ConfigSource
  }
}

/** A field the operator can change. */
export interface NodeConfigDraft {
  readonly coordinatorUrl?: string
  /** Omit to keep the stored token; `null` clears it. */
  readonly token?: string | null
  readonly nodeName?: string
  readonly role?: string
}

/** Read the current configuration. */
export type ConfigFetcher = (signal: AbortSignal) => Promise<NodeConfigSnapshot>

/** Persist a draft and return the view after the node was rebuilt. */
export type ConfigSaver = (draft: NodeConfigDraft) => Promise<NodeConfigSnapshot>

/** Human-readable text for one coded failure, in the language of the panel. */
export function describeConfigFailure(code: string, message: string): string {
  switch (code) {
    case 'forbidden':
      return '请求未通过本机信任校验：请直接在 DSH 窗口里操作。'
    case 'not-found':
    case 'method-not-allowed':
      return '当前运行中的 DSH 还没有配置接口（插件是旧版本）。请完全退出并重新启动 DSH 后再试。'
    case 'node/config-incomplete':
      return `还缺少必要信息。${message}`
    case 'node/config-invalid':
      return `配置未通过校验：${message}`
    case 'node/config-write-failed':
      return `配置文件写入失败：${message}`
    case 'node/reconfigure-failed':
      return `已保存到配置文件，但节点重启失败：${message}`
    default:
      return `${code}：${message}`
  }
}

/** Unwrap one envelope, throwing a readable error for a coded failure. */
async function readEnvelope(response: Response): Promise<unknown> {
  let body: { ok?: unknown; value?: unknown; error?: { code?: unknown; message?: unknown } }
  try {
    body = (await response.json()) as typeof body
  } catch {
    throw new Error(response.ok ? '响应不是 JSON' : `HTTP ${String(response.status)}`)
  }
  if (body.ok === true) return body.value
  const code = typeof body.error?.code === 'string' ? body.error.code : `http-${String(response.status)}`
  const message = typeof body.error?.message === 'string' ? body.error.message : '没有更多信息'
  throw new Error(describeConfigFailure(code, message))
}

/** Read the configuration route once. */
export const fetchNodeConfig: ConfigFetcher = async (signal) => {
  const response = await fetch(CONFIG_PATH, {
    method: 'GET',
    headers: { accept: 'application/json' },
    cache: 'no-store',
    signal,
  })
  const value = await readEnvelope(response)
  if (typeof value !== 'object' || value === null) throw new Error('响应缺少配置内容')
  return value as NodeConfigSnapshot
}

/** Save a draft. A refusal arrives as a thrown `Error` carrying the host's reason. */
export const saveNodeConfig: ConfigSaver = async (draft) => {
  const response = await fetch(CONFIG_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(draft),
  })
  const value = await readEnvelope(response)
  if (typeof value !== 'object' || value === null) throw new Error('响应缺少配置内容')
  return value as NodeConfigSnapshot
}
