/**
 * The build this process is actually running.
 *
 * The value is **embedded at bundle time** by `tsdown.config.ts` from the same
 * object that is written to `build-info.json`. It is deliberately not read from
 * disk at runtime: replacing `build-info.json` under an installed package (or
 * installing a new package over it) must not make an already-running process
 * claim a version it never loaded. The next process to load the new bundle
 * reports the new value because its constant was compiled from the new file.
 *
 * `package.json` remains the single source of the version; the generator
 * (`tools/build-info.mjs`) is the only place that reads it for a build.
 *
 * @module dsh-node/build-info
 */

/** Which release channel produced this build. */
export type BuildChannel = 'stable' | 'preview' | 'dev'

/** Metadata shared by the package file and the running bundle. */
export interface BuildInfo {
  /** `package.json` version. */
  readonly version: string
  /** Full Git commit, or `null` when the build had no Git metadata. */
  readonly commit: string | null
  /** Actual build time, UTC ISO 8601. */
  readonly builtAt: string
  /**
   * `stable`/`preview` only for a tag-validated release build; every other build
   * (local, CI on a branch, watch mode) is `dev`.
   */
  readonly channel: BuildChannel
  /** Whether the source tree had uncommitted changes; `null` when unknown. */
  readonly dirty: boolean | null
}

/**
 * The JSON text injected by the bundler.
 *
 * It is a string rather than an object so a bundler define can carry it without
 * depending on how that bundler parses replacement expressions.
 */
declare const __DSH_NODE_BUILD_INFO_JSON__: string | undefined

/** Used only when this module is executed without the bundler's define (e.g. `tsx`). */
const UNBUNDLED_BUILD_INFO: BuildInfo = Object.freeze({
  version: '0.0.0-dev',
  commit: null,
  builtAt: '1970-01-01T00:00:00.000Z',
  channel: 'dev',
  dirty: null,
})

/**
 * Turn an embedded constant into the validated runtime view.
 *
 * Exported so a test can prove that a *different* embedded value produces a
 * different reported version: that is what loading a newly built bundle does.
 *
 * @param embedded - the object compiled into the bundle, or `undefined` when unbundled.
 * @returns frozen build metadata.
 */
export function buildInfoFromEmbedded(embedded: BuildInfo | undefined): BuildInfo {
  if (embedded === undefined) return UNBUNDLED_BUILD_INFO
  if (typeof embedded.version !== 'string' || embedded.version === '') {
    throw new Error('dsh-node: embedded build info has no version')
  }
  if (embedded.channel !== 'stable' && embedded.channel !== 'preview' && embedded.channel !== 'dev') {
    throw new Error(`dsh-node: embedded build info has an unknown channel: ${String(embedded.channel)}`)
  }
  if (typeof embedded.builtAt !== 'string' || Number.isNaN(new Date(embedded.builtAt).getTime())) {
    throw new Error('dsh-node: embedded build info has an invalid builtAt')
  }
  return Object.freeze({
    version: embedded.version,
    commit: typeof embedded.commit === 'string' ? embedded.commit : null,
    builtAt: embedded.builtAt,
    channel: embedded.channel,
    dirty: typeof embedded.dirty === 'boolean' ? embedded.dirty : null,
  })
}

/**
 * Read the embedded value, if this build has one.
 * @returns the parsed object, or `undefined` when the define was absent.
 */
function readEmbedded(): BuildInfo | undefined {
  if (typeof __DSH_NODE_BUILD_INFO_JSON__ === 'undefined') return undefined
  return JSON.parse(__DSH_NODE_BUILD_INFO_JSON__) as BuildInfo
}

/** The build this bundle was compiled from. */
export const BUILD_INFO: BuildInfo = buildInfoFromEmbedded(readEmbedded())

/** Backwards-compatible version export; equal to `BUILD_INFO.version`. */
export const PLUGIN_VERSION: string = BUILD_INFO.version
