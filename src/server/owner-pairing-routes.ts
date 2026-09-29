import type { FastifyInstance, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { OwnerPairingService, PairingError } from '../owner-pairing/service.js';
import type { RelayControl } from '../relay/protocol.js';
import { classify, RELAY_HOST, TOKEN_HEADER } from './connection-trust.js';

export type { RelayControl };

/** The Mac app's switch for listening on Tailscale; absent for the CLI, which always may. */
export interface PhoneAccessControl {
  enabled: () => boolean;
  /** Persists the choice, then restarts the service so it binds (or drops) the tailnet. */
  set: (enabled: boolean) => void;
}

/** A relay URL the owner may save: wss:// anywhere, ws:// only to this Mac (a local relay while developing). */
export function checkRelayUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new PairingError('Enter the relay address, starting with wss://.'); }
  // The same two names AgentDeck Phone accepts for a development relay.
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback)) throw new PairingError('The relay address must start with wss:// so the connection is encrypted in transit too.');
  if (url.username || url.password || url.search || url.hash) throw new PairingError('The relay address cannot include a user name, query, or fragment.');
  return url.toString().replace(/\/+$/, '');
}

const body = (req: FastifyRequest) => (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
const field = (value: unknown) => typeof value === 'string' ? value : '';

export function registerOwnerPairingRoutes(
  app: FastifyInstance,
  service: OwnerPairingService,
  remoteHosts: readonly string[] | undefined,
  publicPort: number,
  phoneAccess?: PhoneAccessControl,
  relay?: RelayControl,
): void {
  const local = (req: FastifyRequest) => classify({ host: req.headers.host, origin: req.headers.origin }, { remoteHosts }).kind === 'local';
  const remote = (req: FastifyRequest) => classify({ host: req.headers.host, origin: req.headers.origin }, { remoteHosts }).kind === 'remote';
  const ownerDevice = (req: FastifyRequest) => classify(
    { host: req.headers.host, origin: req.headers.origin, token: req.headers[TOKEN_HEADER] as string | undefined },
    { remoteHosts, ownerLookup: service.resolve.bind(service) },
  ).ownerDevice;
  const viaRelay = (req: FastifyRequest) => (req.headers.host ?? '').split(':')[0] === RELAY_HOST;
  const relayReady = () => relay?.status().state === 'connected';
  const handle = (error: unknown) => ({ status: error instanceof PairingError ? 409 : 500, message: error instanceof Error ? error.message : 'Pairing failed.' });

  const magicDnsHost = () => remoteHosts?.find((candidate) => candidate.toLowerCase().endsWith('.ts.net'));
  const availability = () => ({
    state: magicDnsHost() || relayReady() ? 'ready' : phoneAccess && !phoneAccess.enabled() ? 'off' : 'no-tailscale',
    canToggle: Boolean(phoneAccess),
    phoneAccess: phoneAccess?.enabled() ?? true,
    relay: relay?.status() ?? { state: 'off' },
  });

  app.get('/api/owner-pairing/availability', async (req, reply) => {
    if (!local(req)) return reply.code(403).send({ error: 'Local owner required.' });
    return availability();
  });

  app.post('/api/owner-pairing/phone-access', async (req, reply) => {
    if (!local(req)) return reply.code(403).send({ error: 'Local owner required.' });
    if (!phoneAccess) return reply.code(409).send({ error: 'Phone access is managed by Tailscale for this install.' });
    const enabled = body(req).enabled;
    if (typeof enabled !== 'boolean') return reply.code(400).send({ error: 'enabled must be true or false.' });
    // Restart only after the reply is out, or the page never learns it worked.
    reply.raw.once('finish', () => phoneAccess.set(enabled));
    return { restarting: true };
  });

  app.post('/api/owner-pairing/challenges', async (req, reply) => {
    if (!local(req)) return reply.code(403).send({ error: 'Local owner required.' });
    const host = magicDnsHost();
    const link = relayReady() ? relay?.link() : undefined;
    if (!host && !link) return reply.code(409).send({ error: availability().state === 'off'
      ? 'Turn on phone access or set up the relay to pair a phone.'
      : 'Pairing needs Tailscale (a MagicDNS name) or a connected relay. Set up the relay under Away from home.' });
    const challenge = service.create();
    const url = new URL('agentdeck://pair');
    if (host) url.searchParams.set('base', `http://${host}:${publicPort}`);
    url.searchParams.set('id', challenge.id);
    url.searchParams.set('secret', challenge.secret);
    // Issue #90: the phone can pair and later reach the Mac through the relay.
    // The Mac's key comes by camera from this screen, so the relay cannot swap it.
    if (link) {
      url.searchParams.set('relay', link.url);
      url.searchParams.set('mailbox', link.mailbox);
      url.searchParams.set('mac', link.macKey);
    }
    const svg = await QRCode.toString(url.toString(), { type: 'svg', margin: 1, width: 256 });
    return { id: challenge.id, expiresAt: challenge.expiresAt, pairingUrl: url.toString(), qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` };
  });

  app.get<{ Params: { id: string } }>('/api/owner-pairing/challenges/:id', async (req, reply) => {
    if (!local(req)) return reply.code(403).send({ error: 'Local owner required.' });
    try { return service.status(req.params.id); }
    catch (error) { const result = handle(error); return reply.code(result.status).send({ error: result.message }); }
  });

  app.post<{ Params: { id: string } }>('/api/owner-pairing/challenges/:id/confirm', async (req, reply) => {
    if (!local(req)) return reply.code(403).send({ error: 'Local owner required.' });
    try { service.confirmOwner(req.params.id, field(body(req).code)); return { ok: true }; }
    catch (error) { const result = handle(error); return reply.code(result.status).send({ error: result.message }); }
  });

  app.post('/api/owner-pairing/join', async (req, reply) => {
    if (!remote(req)) return reply.code(403).send({ error: 'Phone connection required.' });
    const data = body(req);
    const publicKey = typeof data.publicKey === 'string' ? data.publicKey : undefined;
    try { return service.join(field(data.id), field(data.secret), field(data.label), publicKey); }
    catch (error) { const result = handle(error); return reply.code(result.status).send({ error: result.message }); }
  });

  app.post('/api/owner-pairing/phone-confirm', async (req, reply) => {
    if (!remote(req)) return reply.code(403).send({ error: 'Phone connection required.' });
    const data = body(req);
    try { service.confirmPhone(field(data.id), field(data.nonce), field(data.code)); return { ok: true }; }
    catch (error) { const result = handle(error); return reply.code(result.status).send({ error: result.message }); }
  });

  app.post('/api/owner-pairing/collect', async (req, reply) => {
    if (!remote(req)) return reply.code(403).send({ error: 'Phone connection required.' });
    const data = body(req);
    try {
      const issued = service.collect(field(data.id), field(data.nonce));
      if (!issued) return { pending: true };
      const link = relay?.link();
      return { ...issued, ...(link ? { relay: link } : {}) };
    } catch (error) { const result = handle(error); return reply.code(result.status).send({ error: result.message }); }
  });

  // Issue #90: a phone paired before the relay existed (or before it was set
  // up) enrolls its channel key and learns how to reach the Mac through the
  // relay. Only over a direct connection: the relay may never change a key.
  app.post('/api/owner-pairing/relay-key', async (req, reply) => {
    const device = ownerDevice(req);
    if (!device || viaRelay(req)) return reply.code(403).send({ error: 'Enroll this phone on the same network as the Mac.' });
    try {
      service.enrollKey(device.id, field(body(req).publicKey));
      return { relay: relay?.link() ?? null };
    } catch (error) { const result = handle(error); return reply.code(result.status).send({ error: result.message }); }
  });

  app.post('/api/owner-pairing/push-token', async (req, reply) => {
    const device = ownerDevice(req);
    if (!device) return reply.code(403).send({ error: 'Owner phone required.' });
    const data = body(req);
    try {
      service.setPushToken(device.id, field(data.token), data.environment === 'production' ? 'production' : 'sandbox');
      return { ok: true };
    } catch (error) { const result = handle(error); return reply.code(result.status).send({ error: result.message }); }
  });

  app.get('/api/owner-pairing/relay', async (req, reply) => {
    if (!local(req)) return reply.code(403).send({ error: 'Local owner required.' });
    return relay?.status() ?? { state: 'off' };
  });

  app.post('/api/owner-pairing/relay', async (req, reply) => {
    if (!local(req)) return reply.code(403).send({ error: 'Local owner required.' });
    if (!relay) return reply.code(409).send({ error: 'This install has no relay support.' });
    const url = body(req).url;
    try {
      await relay.setUrl(typeof url === 'string' && url.trim() ? checkRelayUrl(url) : undefined);
      return relay.status();
    } catch (error) {
      // A relay that cannot start (its keys unreadable) is a state to repair, not a server fault.
      const result = handle(error);
      return reply.code(result.status === 500 ? 409 : result.status).send({ error: result.message });
    }
  });

  app.get('/api/owner-devices', async (req, reply) => {
    if (!local(req)) return reply.code(403).send({ error: 'Local owner required.' });
    return service.list();
  });

  app.get<{ Params: { id: string } }>('/api/owner-devices/:id/audit', async (req, reply) => {
    if (!local(req)) return reply.code(403).send({ error: 'Local owner required.' });
    if (!service.list().some((device) => device.id === req.params.id)) return reply.code(404).send({ error: 'Owner device not found.' });
    return service.listAudit(req.params.id);
  });

  app.post<{ Params: { id: string } }>('/api/owner-devices/:id/revoke', async (req, reply) => {
    if (!local(req)) return reply.code(403).send({ error: 'Local owner required.' });
    if (!service.revoke(req.params.id)) return reply.code(404).send({ error: 'Owner device not found or already revoked.' });
    return { ok: true };
  });
}
