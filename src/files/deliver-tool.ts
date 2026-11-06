/**
 * `deliver_file` — the Agent-facing half of artifact delivery.
 *
 * ## Why a hand-built definition
 *
 * The installed host (DSH 0.2.1-rc.2) exposes `ctx.tools.register(definition)`
 * from `@deepseek-ai/dsh-tools`, and `register()` validates only the definition's
 * `name`, `output.schema`, `output.render`, and an optional `timeoutMs` — see
 * `ToolRuntime.register()`. `defineTool()` exists to build the same plain object
 * from a friendlier DSL. Building the object directly therefore:
 *
 * - adds no runtime dependency on an official package (this plugin is out of
 *   tree and deliberately takes none), and
 * - stays compatible with the registry contract rather than a helper's identity.
 *
 * `exec.agent.session.id` is the real session identity. The installed
 * `dsh-agent` enforces `agent.id === agent.session.id` when it registers a live
 * agent, so either field names the same session; the session field is used
 * because it is the one the tool runtime hands to every tool body.
 *
 * The model never supplies a `sessionId`. If the host ever stops providing an
 * agent, the tool refuses instead of inventing an owner.
 *
 * @module dsh-node/files/deliver-tool
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionFileStore } from './store.js'
import { fileError, type ArtifactRef } from './types.js'

/** The tool name the model sees. */
export const DELIVER_TOOL_NAME = 'deliver_file'

/** The slice of a tool execution this tool reads. */
export interface ToolExecutionLike {
  readonly agent?: {
    readonly id?: unknown
    readonly session?: {
      readonly id?: unknown
      readonly header?: { readonly cwd?: unknown }
    }
  }
  readonly signal?: AbortSignal
}

/** A JSON Schema object, as the registry accepts it. */
type JsonSchema = Readonly<Record<string, unknown>>

/** One registry-ready definition, structurally. */
export interface ToolDefinitionLike {
  readonly name: string
  readonly description: string
  readonly parameters: JsonSchema
  readonly output: {
    readonly schema: JsonSchema
    readonly render: (args: Readonly<Record<string, unknown>>, value: unknown) => readonly unknown[]
  }
  readonly execute: (args: Readonly<Record<string, unknown>>, exec: ToolExecutionLike) => Promise<unknown>
}

/** The slice of `ctx.tools` this module uses. */
export interface ToolRegistryLike {
  register(definition: ToolDefinitionLike): () => void
}

/** The slice of `ctx.workingDirectory` this module uses. */
export interface WorkingDirectoryLike {
  ensure(agent: unknown, signal?: AbortSignal): Promise<string | undefined>
}

/** Options for {@link createDeliverToolDefinition}. */
export interface DeliverToolOptions {
  /** Store that owns the snapshot and its metadata. */
  readonly store: SessionFileStore
  /** Resolve the session's effective working directory when the service exists. */
  readonly workingDirectory?: WorkingDirectoryLike | undefined
}

/** Parameter schema: exactly `{ path, name? }`. */
const PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Absolute path of the document to deliver. It must be inside this session\'s working directory (or the directory of files the user attached).',
    },
    name: {
      type: 'string',
      description: 'Optional display name shown to the user. Defaults to the file\'s base name.',
    },
  },
  required: ['path'],
  additionalProperties: false,
}

/** Output schema: the artifact reference without any host path. */
const OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    artifactId: { type: 'string' },
    nodeId: { type: 'string' },
    sessionId: { type: 'string' },
    name: { type: 'string' },
    size: { type: 'number' },
    sha256: { type: 'string' },
    createdAt: { type: 'string' },
    expiresAt: { type: 'string' },
    state: { type: 'string' },
  },
  required: ['artifactId', 'nodeId', 'sessionId', 'name', 'size', 'sha256', 'createdAt', 'expiresAt', 'state'],
  additionalProperties: false,
}

/** The description the model reads. It states the boundary, not a path. */
const DESCRIPTION = [
  'Deliver a finished document to the user as a downloadable artifact in this conversation.',
  'After writing the final file, call this tool with the absolute path you actually created.',
  'Only report that the file is downloadable after this tool succeeds; a file path shown in text, a present card, or a diff card does not register a downloadable artifact.',
  'The file must be a regular file inside this session\'s working directory (or inside the directory of files the user attached);',
  'directories, links and files outside it are refused.',
  'The tool stores a read-only snapshot, so later edits to the original do not change what the user downloads.',
  'Do not call it for files that are not the deliverable, and do not call it before the document is complete.',
  'If this tool is unavailable in the session, say that file delivery is unavailable; do not claim a download was created.',
].join(' ')

/**
 * Build the registry-ready definition.
 * @param options - store plus an optional working-directory resolver.
 * @returns the definition `ctx.tools.register()` accepts.
 */
export function createDeliverToolDefinition(options: DeliverToolOptions): ToolDefinitionLike {
  const store = options.store
  return {
    name: DELIVER_TOOL_NAME,
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const ref = value as ArtifactRef
        return [{
          type: 'text',
          text: `已登记产物「${ref.name}」（${String(ref.size)} 字节，${ref.expiresAt} 到期），用户可以在会话中下载。`,
        }]
      },
    },
    async execute(args, exec) {
      const sessionId = readSessionId(exec)
      const path = typeof args['path'] === 'string' ? args['path'] : ''
      if (path === '') throw fileError('files/invalid-arguments', 'path is required', { field: 'path' })
      const name = typeof args['name'] === 'string' ? args['name'] : undefined
      const cwd = await resolveCwd(options.workingDirectory, exec)
      const ref = await store.publishArtifact({
        sessionId,
        path,
        name,
        ...(cwd === undefined ? {} : { cwd }),
      })
      return {
        artifactId: ref.artifactId,
        nodeId: ref.nodeId,
        sessionId: ref.sessionId,
        name: ref.name,
        size: ref.size,
        sha256: ref.sha256,
        createdAt: ref.createdAt,
        expiresAt: ref.expiresAt,
        state: ref.state,
      }
    },
  }
}

/**
 * Register the tool in the global registry.
 *
 * A host plugin's context is unscoped, and `@deepseek-ai/dsh-scope` resolves an
 * unscoped context to the tools registry's **global** layer — the layer every
 * Agent inherits. That is what makes one registration reach every remote
 * session without touching an Agent preset.
 *
 * @param ctx - the plugin's host context (must be unscoped).
 * @param store - the session file store.
 * @returns a disposer, or `undefined` when this profile has no tools registry.
 */
export function registerDeliverTool(ctx: Context, store: SessionFileStore): (() => void) | undefined {
  const registry = readTools(ctx)
  if (registry === undefined) return undefined
  const workingDirectory = readWorkingDirectory(ctx)
  return registry.register(createDeliverToolDefinition({
    store,
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
  }))
}

/** Read `ctx.tools` defensively; a profile without the registry simply has no tool. */
export function readTools(ctx: Context): ToolRegistryLike | undefined {
  try {
    const tools = (ctx as unknown as { get(key: string, strict?: boolean): unknown }).get('tools', false)
    if (typeof tools !== 'object' || tools === null) return undefined
    const register = (tools as { register?: unknown }).register
    return typeof register === 'function' ? (tools as ToolRegistryLike) : undefined
  } catch {
    return undefined
  }
}

/** Read `ctx.workingDirectory` defensively. */
function readWorkingDirectory(ctx: Context): WorkingDirectoryLike | undefined {
  try {
    const service = (ctx as unknown as { get(key: string, strict?: boolean): unknown }).get('workingDirectory', false)
    if (typeof service !== 'object' || service === null) return undefined
    const ensure = (service as { ensure?: unknown }).ensure
    return typeof ensure === 'function' ? (service as WorkingDirectoryLike) : undefined
  } catch {
    return undefined
  }
}

/** Read the live session id, refusing a model-supplied substitute. */
export function readSessionId(exec: ToolExecutionLike): string {
  const sessionId = exec.agent?.session?.id
  if (typeof sessionId === 'string' && sessionId !== '') return sessionId
  // The installed host keeps `agent.id` and `agent.session.id` equal; the
  // fallback keeps the tool usable against a host that only exposes the id.
  const agentId = exec.agent?.id
  if (typeof agentId === 'string' && agentId !== '') return agentId
  throw fileError('files/forbidden', 'this tool call has no session identity; delivery was refused', {
    reason: 'no-session',
  })
}

/** Resolve the session's working directory from the host service, then the header. */
async function resolveCwd(
  service: WorkingDirectoryLike | undefined,
  exec: ToolExecutionLike,
): Promise<string | undefined> {
  if (service !== undefined && exec.agent !== undefined) {
    try {
      const cwd = await service.ensure(exec.agent, exec.signal)
      if (typeof cwd === 'string' && cwd !== '') return cwd
    } catch {
      // Fall through to the session header: a working-directory failure must not
      // become "cannot deliver" when the session already states its cwd.
    }
  }
  const cwd = exec.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}
