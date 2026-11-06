import { defineConfig } from 'vitest/config'
import { createBuildInfo } from './tools/build-info.mjs'

/**
 * Tests import the host source directly, so the build-time define that tsdown
 * injects must exist here too. It is a normal development build: version from
 * `package.json`, channel `dev`. No `build-info.json` is written.
 */
const testBuildInfo = createBuildInfo()

/**
 * Vitest configuration.
 *
 * `pool: 'threads'` is deliberate. Vitest's default `forks` pool starts a child
 * process per test file with piped stdio, and a confined Windows sandbox (the
 * one this plugin is developed under, and the same one that breaks `esbuild`'s
 * postinstall) rejects that spawn with `EPERM` — the suite reports "no tests"
 * before a single file is collected. Worker threads run in-process, so the same
 * tests execute without needing wider filesystem or process permissions.
 *
 * `integration.test.ts` binds a real loopback WebSocket server; that is
 * in-process I/O and needs no extra permission.
 */
export default defineConfig({
  define: {
    __DSH_NODE_BUILD_INFO_JSON__: JSON.stringify(JSON.stringify(testBuildInfo)),
  },
  test: {
    pool: 'threads',
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
})
