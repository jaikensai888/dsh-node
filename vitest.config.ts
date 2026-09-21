import { defineConfig } from 'vitest/config'

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
  test: {
    pool: 'threads',
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
})
