import type { FastifyInstance, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { OwnerPairingService, PairingError } from '../owner-pairing/service.js';
import { classify } from './connection-trust.js';

const body = (req: FastifyRequest) => (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
const field = (value: unknown) => typeof value === 'string' ? value : '';

export function registerOwnerPairingRoutes(
  app: FastifyInstance,
  service: OwnerPairingService,
  remoteHosts: readonly string[] | undefined,
  publicPort: number,
): void {
  const local = (req: FastifyRequest) => classify({ host: req.headers.host, origin: req.headers.origin }, { remoteHosts }).kind === 'local';
  const remote = (req: FastifyRequest) => classify({ host: req.headers.host, origin: req.headers.origin }, { remoteHosts }).kind === 'remote';
  const handle = (error: unknown) => ({ status: error instanceof PairingError ? 409 : 500, message: error instanceof Error ? error.message : 'Pairing failed.' });

  app.post('/api/owner-pairing/challenges', async (req, reply) => {
    if (!local(req)) return reply.code(403).send({ error: 'Local owner required.' });
    const host = remoteHosts?.find((candidate) => candidate.toLowerCase().endsWith('.ts.net'));
    if (!host) return reply.code(409).send({ error: 'A Tailscale MagicDNS name is required to pair a phone.' });
    const challenge = service.create();
    const url = new URL('agentdeck://pair');
    url.searchParams.set('base', `http://${host}:${publicPort}`);
    url.searchParams.set('id', challenge.id);
    url.searchParams.set('secret', challenge.secret);
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
    try { return service.join(field(data.id), field(data.secret), field(data.label)); }
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
    try { return service.collect(field(data.id), field(data.nonce)) ?? { pending: true }; }
    catch (error) { const result = handle(error); return reply.code(result.status).send({ error: result.message }); }
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
