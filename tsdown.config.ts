import type { UserConfig } from 'tsdown'

const PACKAGE_ID = 'dsh-node'

/**
 * Specifiers a DSH client bundle may `require()` at runtime.
 *
 * This is the platform module table of `@deepseek-ai/dsh-client-modules`. Anything
 * else must be bundled in, because a specifier that is not in the table throws when
 * the page materialises the factory — the failure mode that silently removed a
 * neighbouring plugin's footer entry on this machine.
 *
 * Deliberately absent: bare `cordis` and `@deepseek-ai/dsh-client-runtime` — the
 * latter no longer exists in `@deepseek-ai/* 0.1.5-rc.2`, and requiring it is
 * exactly how a client half stops loading without saying so.
 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
]

/**
 * Build the classic-script client bundle.
 *
 * The banner/intro/footer trio is the whole protocol: `lib/client.js` must be a
 * `window.__ModuleLoader__.load({...})` call whose factory only *registers* the
 * module — component code runs when the factory is materialised, not at parse time.
 * @param entryFile - output file name inside `outDir`.
 * @param moduleId - the id the page's module system keys this bundle by.
 * @returns the tsdown config for the client half.
 */
function clientBundle(entryFile: string, moduleId: string): UserConfig {
  return {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    sourcemap: true,
    // Never clean: DSH Desktop holds `lib/*.js` open, and in-place overwrite is
    // what lets the client HMR watcher hot-swap the half.
    clean: false,
    external: CLIENT_EXTERNALS,
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    },
    outputOptions: {
      entryFileNames: entryFile,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(moduleId)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }
}

/**
 * Two halves, two bundles.
 *
 * The host half is ESM for Node and keeps `ws` / `schemastery` as real imports:
 * bundling them would inline a WebSocket client and a schema validator and hide two
 * runtime dependencies from `files`. The client half is the classic-script bundle
 * above; it exists only to paint one footer row.
 *
 * `clean` is false on purpose — DSH Desktop holds `lib/*.js` open while the profile
 * is mounted, so removing the directory fails with EPERM on Windows.
 */
export default [
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    dts: false,
    sourcemap: true,
    clean: false,
    external: ['ws', 'schemastery'],
  },
  clientBundle('client.js', PACKAGE_ID),
] satisfies UserConfig[]
