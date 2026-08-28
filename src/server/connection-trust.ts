// ConnectionTrust (ticket 05): the single place that decides whether a
// connection is local, remote (tailnet), or denied, and what it may do.
// See docs/specs/session-persistence-and-remote-access.md, "ConnectionTrust".
//
// isLoopbackHostHeader/isAllowedOrigin used to live in server/app.ts. They
// moved here so classify() can reuse them without app.ts importing this
// module while this module imports app.ts back — app.ts re-exports both for
// its existing callers (ws.test.ts imports them from './app.js').
//
// This module takes only plain strings, never Fastify/`ws` request types, so
// it is unit-testable with no server (see connection-trust.test.ts).
import { timingSafeEqual } from 'node:crypto';
import { TOKEN_HEADER, TOKEN_QUERY_PARAM } from '../protocol.js';

export type ConnectionKind = 'local' | 'remote' | 'denied';
export type Capability = 'view' | 'compose' | 'control-keys' | 'raw-write';
export interface TrustResult { kind: ConnectionKind; capabilities: Set<Capability> }

// Re-exported from protocol.ts (not defined here) so the browser bundle can
// import these two constants (src/ui/connection.ts) without pulling
// node:crypto into the client build — see the comment on their definition
// in protocol.ts. Ticket 14's raw-write enforcement imports them from here.
export { TOKEN_HEADER, TOKEN_QUERY_PARAM };

const ALL_CAPABILITIES: Capability[] = ['view', 'compose', 'control-keys', 'raw-write'];
const REMOTE_CAPABILITIES: Capability[] = ['view', 'compose', 'control-keys'];

function hostnameOf(host: string | undefined): string {
  if (!host) return '';
  return host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0] ?? '';
}

/**
 * The server binds to 127.0.0.1 (and, when Tailscale is detected, the
 * tailnet interface — never 0.0.0.0), but browsers will happily send
 * requests here from any web page (DNS rebinding defeats same-origin for
 * the REST API; WebSocket upgrades skip CORS entirely). Only loopback Host
 * values are "local"; requests without an Origin (curl, CLI) are fine
 * because they already run as the local user.
 */
export function isLoopbackHostHeader(host: string | undefined): boolean {
  const hostname = hostnameOf(host);
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

function isRemoteHostHeader(host: string | undefined, remoteHosts: readonly string[] | undefined): boolean {
  if (!host || !remoteHosts) return false;
  const hostname = hostnameOf(host).toLowerCase();
  return remoteHosts.some((remoteHost) => hostname === remoteHost.toLowerCase());
}

/**
 * `requestHost` is the request's own Host header — the Origin must name the
 * exact host (and port) the request came in on, loopback or the configured
 * tailnet host. `remoteHosts` is optional so existing loopback-only callers
 * (and their tests) see unchanged behavior when it's omitted.
 */
export function isAllowedOrigin(
  origin: string | undefined,
  requestHost?: string,
  remoteHosts?: readonly string[],
): boolean {
  if (origin === undefined) return true; // non-browser client
  try {
    const parsed = new URL(origin);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.origin !== origin) return false;
    if (!isLoopbackHostHeader(parsed.host) && !isRemoteHostHeader(parsed.host, remoteHosts)) return false;
    if (requestHost === undefined) return true;
    const requested = new URL(`${parsed.protocol}//${requestHost}`);
    return parsed.hostname === requested.hostname && parsed.port === requested.port;
  } catch {
    return false;
  }
}

/**
 * Constant-time token comparison. `crypto.timingSafeEqual` throws on a
 * buffer length mismatch, so that case is checked before comparing (a
 * missing/undefined token is treated the same way — no comparison, no
 * throw). This does not make the whole check perfectly constant-time (an
 * attacker learns "wrong length" a hair faster than "right length, wrong
 * bytes"), but it avoids the worst leak: comparing byte-by-byte with an
 * early exit on the first mismatch.
 */
function tokensMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Decide once, ask everywhere: the REST origin/host check, the WebSocket
 * upgrade, and the CSP `connect-src` header all defer to this function so a
 * newly allowed host (the tailnet address) can never be added in one place
 * and forgotten in another — see the spec's "ConnectionTrust" module design.
 *
 * `opts.remoteHosts` contains both the detected Tailscale hostname and IP (see
 * tailscale.ts); `opts.token` is the configured tailnet access token (see
 * config.ts's `tailscaleToken`). Both may be undefined before the server has
 * finished startup detection/generation.
 */
export function classify(
  input: { host?: string; origin?: string; token?: string },
  opts: { remoteHosts?: readonly string[]; token?: string },
): TrustResult {
  const denied: TrustResult = { kind: 'denied', capabilities: new Set() };

  if (isLoopbackHostHeader(input.host)) {
    if (!isAllowedOrigin(input.origin, input.host, opts.remoteHosts)) return denied;
    return { kind: 'local', capabilities: new Set(ALL_CAPABILITIES) };
  }

  if (isRemoteHostHeader(input.host, opts.remoteHosts)) {
    if (!isAllowedOrigin(input.origin, input.host, opts.remoteHosts)) return denied;
    // Missing/wrong token (or no token configured yet) is "remote, no
    // capabilities" — this is the state the client's token-entry screen
    // needs to detect (GET /api/connection), not a hard denial.
    const authenticated = Boolean(opts.token) && tokensMatch(input.token, opts.token);
    return { kind: 'remote', capabilities: authenticated ? new Set(REMOTE_CAPABILITIES) : new Set() };
  }

  return denied;
}
