#!/usr/bin/env node
/**
 * Install a built `dsh-node` tarball into a throwaway project and prove it works.
 *
 * This is deliberately **not** a check that files exist in the source tree. It
 * unpacks the artifact that would be uploaded to a Release, installs it with pnpm
 * (so production dependencies are resolved the same way an operator's profile
 * resolves them), then:
 *
 * - checks the tarball's entry list (required files present, no tests/logs/source);
 * - validates `build-info.json` against the packaged `package.json`;
 * - imports the installed host bundle and checks the real exports;
 * - checks the client bundle is the classic-script module the host composes;
 * - resolves `ws` / `schemastery` from the installed package, and verifies the host
 *   bundle keeps them external rather than inlining them;
 * - rewrites the installed `build-info.json` and imports the package in a fresh
 *   process, proving a running/next process does not read that file for its
 *   version;
 * - optionally verifies the tarball against `SHA256SUMS`.
 *
 * Usage:
 *   node tools/verify-package.mjs dist/dsh-node-0.2.0.tgz
 *   node tools/verify-package.mjs dist --sums dist/SHA256SUMS
 *
 * @module dsh-node/tools/verify-package
 */

import { execFileSync, execSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CHECKSUMS_FILE, parseChecksums, sha256File, tarballsIn } from './checksums.mjs'
import { BuildInfoError, validateBuildInfo } from './build-info.mjs'

/** A coded verification failure. */
export class VerifyError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'VerifyError'
    this.code = code
  }
}

/** Entries the tarball must contain. */
export const REQUIRED_ENTRIES = Object.freeze([
  'package/package.json',
  'package/build-info.json',
  'package/cordis.patch.yml',
  'package/lib/index.js',
  'package/lib/client.js',
  'package/lib/types/index.d.ts',
])

/** Path fragments that must never be shipped. */
const FORBIDDEN_ENTRIES = Object.freeze([
  /(?:^|\/)node_modules\//u,
  /(?:^|\/)\.github\//u,
  /(?:^|\/)\.tmp\//u,
  /(?:^|\/)src\//u,
  /(?:^|\/)test\//u,
  /(?:^|\/)tools\//u,
  /(?:^|\/)config\.json$/u,
  /(?:^|\/)\.env(?:\.|$)/u,
])

/**
 * Check a tarball entry list.
 * @param {readonly string[]} entries - paths as printed by `tar -tzf`.
 * @param {object} [options]
 * @param {string} [options.version] - version the artifact should carry.
 * @returns {void}
 */
export function assertPackageEntries(entries, options = {}) {
  if (entries.length === 0) throw new VerifyError('empty-tarball', 'the tarball lists no entries')
  for (const entry of entries) {
    if (!entry.startsWith('package/')) {
      throw new VerifyError('invalid-entry', `tarball entry "${entry}" is outside the package/ root`)
    }
  }
  for (const required of REQUIRED_ENTRIES) {
    if (!entries.includes(required)) {
      throw new VerifyError('missing-entry', `the tarball is missing ${required}`)
    }
  }
  for (const entry of entries) {
    if (FORBIDDEN_ENTRIES.some(pattern => pattern.test(entry))) {
      throw new VerifyError('forbidden-entry', `the tarball must not contain ${entry}`)
    }
  }
  if (options.version !== undefined && options.version !== '') {
    if (!entries.includes(`package/build-info.json`)) {
      throw new VerifyError('missing-entry', 'the tarball has no build-info.json')
    }
  }
}

/**
 * Read one installed file as UTF-8.
 * @param {string} file - path.
 * @param {string} code - failure code when it cannot be read.
 * @returns {Promise<string>} contents.
 */
async function readOrFail(file, code) {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    throw new VerifyError(code, `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Run pnpm in a directory.
 *
 * A single command string avoids Node's `shell: true` + argument-array
 * deprecation warning on Windows. Every argument is either a fixed flag or a
 * path this script created; paths with spaces are quoted.
 * @param {string} cwd - working directory.
 * @param {string[]} args - pnpm arguments.
 * @returns {string} combined output, for the failure message.
 */
function pnpm(cwd, args) {
  const quote = (value) => (/^[A-Za-z0-9_./:=+-]+$/u.test(value) ? value : `"${value.replaceAll('"', '\\"')}"`)
  const command = ['pnpm', ...args].map(quote).join(' ')
  try {
    return execSync(command, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const failure = error
    const stderr = typeof failure.stderr === 'string' ? failure.stderr : String(failure.stderr ?? '')
    const stdout = typeof failure.stdout === 'string' ? failure.stdout : String(failure.stdout ?? '')
    throw new VerifyError('install-failed', `${command} failed:\n${stdout}${stderr}`)
  }
}

/**
 * List a tarball's entries.
 * @param {string} tarball - path to the `.tgz`.
 * @returns {string[]} entries.
 */
export function tarballEntries(tarball) {
  try {
    const output = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return output.split(/\r?\n/u).filter(line => line !== '')
  } catch (error) {
    throw new VerifyError('tar-failed', `cannot list ${tarball}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** CLI entry point. */
async function main() {
  const argv = process.argv.slice(2)
  const sumsIndex = argv.indexOf('--sums')
  const sums = sumsIndex === -1 ? undefined : argv[sumsIndex + 1]
  if (sumsIndex !== -1 && (sums === undefined || sums === '' || sums.startsWith('--'))) {
    throw new VerifyError('invalid-argument', '--sums needs a file path')
  }
  const keep = argv.includes('--keep')
  const positional = argv.filter((argument, index) => {
    if (argument.startsWith('--')) return false
    if (sumsIndex !== -1 && index === sumsIndex + 1) return false
    return true
  })
  if (positional.length !== 1) {
    throw new VerifyError('invalid-argument', 'usage: node tools/verify-package.mjs <tgz-or-dir> [--sums SHA256SUMS] [--keep]')
  }

  let tarball = resolve(positional[0])
  if (!tarball.endsWith('.tgz')) {
    const candidates = await tarballsIn(tarball)
    if (candidates.length !== 1) {
      throw new VerifyError('invalid-argument', `${tarball} must contain exactly one .tgz (found ${String(candidates.length)})`)
    }
    tarball = candidates[0]
  }
  const name = basename(tarball)
  console.log(`verify-package: tarball ${tarball}`)

  const digest = await sha256File(tarball)
  console.log(`verify-package: sha256 ${digest}`)
  if (sums !== undefined) {
    const expected = parseChecksums(await readFile(resolve(sums), 'utf8'))
    const listed = expected.get(name)
    if (listed === undefined) throw new VerifyError('checksum-missing', `${CHECKSUMS_FILE} does not list "${name}"`)
    if (listed !== digest) throw new VerifyError('checksum-mismatch', `${name}: expected ${listed}, got ${digest}`)
    console.log(`verify-package: checksum matches ${CHECKSUMS_FILE}`)
  }

  const entries = tarballEntries(tarball)
  const work = await mkdtemp(join(tmpdir(), 'dsh-node-verify-'))
  try {
    const extract = join(work, 'package')
    await mkdir(extract, { recursive: true })
    try {
      execFileSync('tar', ['-xzf', tarball, '-C', extract], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      throw new VerifyError('tar-failed', `cannot extract ${tarball}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const packageDir = join(extract, 'package')
    const manifest = JSON.parse(await readOrFail(join(packageDir, 'package.json'), 'missing-manifest'))
    if (manifest.name !== 'dsh-node') throw new VerifyError('wrong-package', `package name is "${String(manifest.name)}", expected dsh-node`)
    if (typeof manifest.version !== 'string') throw new VerifyError('wrong-package', 'package.json has no version')

    assertPackageEntries(entries, { version: manifest.version })
    if (name !== `dsh-node-${manifest.version}.tgz`) {
      throw new VerifyError('wrong-filename', `tarball is named "${name}", expected "dsh-node-${manifest.version}.tgz"`)
    }
    console.log(`verify-package: entries ok (${String(entries.length)} files)`)

    const info = validateBuildInfo(
      JSON.parse(await readOrFail(join(packageDir, 'build-info.json'), 'missing-build-info')),
      { expectedVersion: manifest.version, source: 'build-info.json' },
    )
    console.log(`verify-package: metadata ${info.version} ${info.channel} commit=${info.commit ?? 'null'} dirty=${info.dirty === null ? 'null' : String(info.dirty)}`)

    // Install the artifact itself, with production dependencies, into a fresh project.
    const install = join(work, 'install')
    await mkdir(install, { recursive: true })
    await writeFile(join(install, 'package.json'), `${JSON.stringify({ name: 'dsh-node-verify', private: true, type: 'module' }, null, 2)}\n`, 'utf8')
    const localTarball = join(work, name)
    await copyFile(tarball, localTarball)
    pnpm(install, [
      'add',
      '--ignore-scripts',
      '--reporter=append-only',
      '--config.auto-install-peers=false',
      '--config.strict-peer-dependencies=false',
      '--save-exact',
      localTarball,
    ])
    console.log('verify-package: installed with production dependencies')

    const installed = join(install, 'node_modules', 'dsh-node')
    // pnpm links the package into `.pnpm/.../node_modules`, where its production
    // dependencies are siblings. Resolve through the link before asking Node to
    // find `ws`, or the lookup would start from the top-level project instead.
    const realInstalled = await realpath(installed)
    const installedManifest = JSON.parse(await readOrFail(join(realInstalled, 'package.json'), 'install-missing'))
    if (installedManifest.version !== manifest.version) {
      throw new VerifyError('install-version', `installed version ${String(installedManifest.version)} != packaged ${manifest.version}`)
    }
    for (const dependency of ['ws', 'schemastery']) {
      if (installedManifest.dependencies?.[dependency] === undefined) {
        throw new VerifyError('missing-dependency', `package.json does not declare ${dependency}`)
      }
      try {
        createRequire(join(realInstalled, 'package.json')).resolve(dependency)
      } catch {
        throw new VerifyError('missing-dependency', `${dependency} was not installed for the package`)
      }
    }

    const hostBundle = await readOrFail(join(realInstalled, 'lib', 'index.js'), 'missing-host-bundle')
    const clientBundle = await readOrFail(join(realInstalled, 'lib', 'client.js'), 'missing-client-bundle')
    for (const dependency of ['ws', 'schemastery']) {
      if (!new RegExp(`["']${dependency}["']`, 'u').test(hostBundle)) {
        throw new VerifyError('inlined-dependency', `the host bundle does not keep ${dependency} as an external import`)
      }
    }
    if (!clientBundle.startsWith('window.__ModuleLoader__.load(')) {
      throw new VerifyError('invalid-client-bundle', 'lib/client.js is not a __ModuleLoader__.load() factory')
    }

    const moduleUrl = pathToFileURL(join(realInstalled, 'lib', 'index.js')).href
    const module = await import(`${moduleUrl}?verify=${String(Date.now())}`)
    if (module.name !== 'dsh-node') throw new VerifyError('invalid-exports', 'the installed package does not export name = "dsh-node"')
    if (typeof module.apply !== 'function') throw new VerifyError('invalid-exports', 'the installed package does not export apply()')
    if (module.PLUGIN_VERSION !== info.version) {
      throw new VerifyError('runtime-version', `PLUGIN_VERSION ${String(module.PLUGIN_VERSION)} != build-info ${info.version}`)
    }
    if (module.BUILD_INFO?.version !== info.version) {
      throw new VerifyError('runtime-version', `BUILD_INFO ${String(module.BUILD_INFO?.version)} != build-info ${info.version}`)
    }
    // The file and the constant must describe the same build, not merely the same
    // version: a stale commit or builtAt would make "installed == running" a lie.
    for (const field of ['version', 'commit', 'builtAt', 'channel', 'dirty']) {
      if (module.BUILD_INFO?.[field] !== info[field]) {
        throw new VerifyError(
          'runtime-metadata',
          `BUILD_INFO.${field} (${JSON.stringify(module.BUILD_INFO?.[field])}) != build-info.${field} (${JSON.stringify(info[field])})`,
        )
      }
    }
    console.log(`verify-package: host loads, exports ok, reports ${String(module.BUILD_INFO.version)}`)

    // Replace the installed metadata, then load the package in a fresh process. The
    // version it reports must still be the one compiled into the bundle.
    await writeFile(
      join(realInstalled, 'build-info.json'),
      `${JSON.stringify({ ...info, version: '9.9.9' }, null, 2)}\n`,
      'utf8',
    )
    const probe = `import(${JSON.stringify(`${moduleUrl}?probe=${String(Date.now())}`)}).then(module => console.log(JSON.stringify(module.BUILD_INFO)))`
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const reported = JSON.parse(output.trim().split(/\r?\n/u).at(-1) ?? 'null')
    if (reported?.version !== info.version) {
      throw new VerifyError(
        'runtime-reads-disk',
        `a fresh process reported ${String(reported?.version)} after build-info.json was replaced; it must report the embedded ${info.version}`,
      )
    }
    // And a bundle compiled with a different constant reports that constant, which
    // is what installing a genuinely newer tarball does on the next load.
    const simulated = module.buildInfoFromEmbedded({ ...info, version: '9.9.9', channel: 'dev', dirty: null })
    if (simulated.version !== '9.9.9') {
      throw new VerifyError('runtime-version', 'buildInfoFromEmbedded did not accept a new embedded value')
    }
    console.log('verify-package: runtime ignores a replaced build-info.json')

    console.log(`verify-package: PASS ${name}`)
    if (keep) console.log(`verify-package: kept ${work}`)
  } finally {
    if (!keep) await rm(work, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('verify-package.mjs')) {
  main().catch((error) => {
    if (error instanceof VerifyError) {
      console.error(`verify-package: ${error.code}: ${error.message}`)
      process.exitCode = 1
    } else if (error instanceof BuildInfoError) {
      console.error(`verify-package: ${error.code}: ${error.message}`)
      process.exitCode = 1
    } else {
      console.error(`verify-package: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      process.exitCode = 1
    }
  })
}
