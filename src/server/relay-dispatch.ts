// Issue #90: what the Mac does with a request that arrived through the relay.
// The channel has already proven which key sent it (mac-link.ts); this decides
// what that key may do, then runs the request through the same Fastify app,
// onRequest gate, and owner-phone routes a direct connection uses. Nothing is
// trusted because it came through the relay.
//
// - An unknown key may only pair: join, confirm, and collect, with the key the
//   handshake proved bound as the new phone's key (never one from the body).
// - A paired phone's key must come with that same phone's bearer credential,
//   and may reach only /api/connection, the personal-task routes, the
//   window view (issue #91), and its push token. Enrolling or rotating a key needs a direct connection.
import type { FastifyInstance } from 'fastify';
import type { OwnerPairingService } from '../owner-pairing/service.js';
import type { RelayPeer, RelayRequest, RelayResponse } from '../relay/mac-link.js';
import { isOwnerPersonalRoute } from './app.js';
import { isOwnerWindowViewRoute } from './window-view-routes.js';
import { RELAY_HOST, TOKEN_HEADER } from './connection-trust.js';

const PAIRING_ROUTES = new Set(['/api/owner-pairing/join', '/api/owner-pairing/phone-confirm', '/api/owner-pairing/collect']);

const refuse = (status: number, error: string): RelayResponse => ({ status, body: { error } });

export function relayDispatcher(app: FastifyInstance, pairing: OwnerPairingService) {
  return async (request: RelayRequest, peer: RelayPeer): Promise<RelayResponse> => {
    const method = request.method.toUpperCase();
    const [pathname = ''] = request.path.split('?');
    if ((method !== 'GET' && method !== 'POST') || !pathname.startsWith('/api/') || pathname.includes('..') || request.path.length > 2048) {
      return refuse(400, 'That request cannot be sent through the relay.');
    }
    let body = request.body;
    if (!peer.deviceId) {
      if (pathname !== '/api/connection' && !(method === 'POST' && PAIRING_ROUTES.has(pathname))) {
        return refuse(403, 'This phone is not paired with this Mac. Pair it again from Settings › Owner phones.');
      }
      if (pathname === '/api/owner-pairing/join') body = { ...(body && typeof body === 'object' ? body : {}), publicKey: peer.phoneKey };
    } else {
      const allowed = pathname === '/api/connection' || isOwnerPersonalRoute(method, pathname) || isOwnerWindowViewRoute(method, pathname)
        || (method === 'POST' && pathname === '/api/owner-pairing/push-token');
      if (!allowed) return refuse(403, 'This is not available away from home.');
      if (pathname !== '/api/connection' && (!request.token || pairing.resolve(request.token)?.id !== peer.deviceId)) {
        return refuse(403, 'This phone is no longer paired with this Mac.');
      }
    }
    const response = await app.inject({
      method,
      url: request.path,
      headers: {
        host: RELAY_HOST,
        ...(request.token ? { [TOKEN_HEADER]: request.token } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    let parsed: unknown = response.body;
    try { parsed = JSON.parse(response.body); } catch { /* not JSON: pass the text through */ }
    return { status: response.statusCode, body: parsed };
  };
}
