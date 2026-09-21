/**
 * Browser-trust fence for the `/dsh-node` routes.
 *
 * These routes are reachable **without** the browser-session cookie — that is how
 * DSH plugin prefixes work — so the fence is what stands between them and a
 * hostile page. The threat is a rebound hostname: a page on `evil.example` whose
 * DNS answer is `127.0.0.1` can make the browser send same-machine requests with
 * `Host: evil.example`. The fence refuses those, and refuses cross-site browser
 * markers, while allowing the app's own window and any authority the deployment
 * declared trusted (the LAN/phone-connection feature adds those).
 *
 * This is a **DNS-rebinding / cross-site defense, not authentication**: it decides
 * whether a request came from a page that is allowed to talk to this plugin's
 * routes at all. Nothing here is a substitute for the coordinator's token, and
 * nothing it protects is secret — the status payload carries no credential.
 *
 * @module dsh-node/net/trust-fence
 */

import type { IncomingHttpHeaders } from 'node:http'

/** The request facts this fence reads. Structural, so tests need no HTTP server. */
export interface TrustFenceRequest {
  readonly headers: IncomingHttpHeaders
}

/** Read one header, ignoring array-valued duplicates. */
function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/** Parse a `host`-style authority, or `undefined` when it is not one. */
function parseAuthority(authority: string): URL | undefined {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/** Whether a hostname names this machine's loopback interface. */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
}

/** `hostname` or `hostname:port`, matching what `new URL` normalizes to. */
function canonicalAuthority(hostname: string, port: string): string {
  return port === '' ? hostname : `${hostname}:${port}`
}

/**
 * Whether the request authority is one the deployment declared it serves.
 *
 * A `trustedHosts` entry without a port matches any port on that hostname; an
 * entry with a port must match exactly. That asymmetry is deliberate: the
 * deployment knows its hostname, not which port a proxy will land on.
 */
function isTrustedAuthority(hostUrl: URL, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    const entryPort = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
    return canonicalAuthority(entryUrl.hostname, entryPort) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : canonicalAuthority(entryUrl.hostname, entryPort) === canonicalAuthority(hostUrl.hostname, hostUrl.port)
  })
}

/**
 * Decide whether one `/dsh-node` request may reach the plugin's routes.
 *
 * An absent `Origin` passes: a same-origin `fetch` from the app window may omit
 * it, and the `Host` fence above has already bound the authority. A present
 * `Origin` must name the same hostname — comparing hostnames rather than hosts
 * because some Chromium builds serialize a loopback origin without its port, and
 * refusing those would break the app's own window. The literal `"null"` origin
 * (sandboxed iframe, `file:` page) is opaque and refused.
 *
 * @param request - request facts (headers).
 * @param trustedHosts - extra authorities this deployment serves.
 * @returns true when the request may be answered.
 */
export function isTrustedNodeRequest(request: TrustFenceRequest, trustedHosts: readonly string[]): boolean {
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).hostname === hostUrl.hostname
  } catch {
    return false
  }
}
