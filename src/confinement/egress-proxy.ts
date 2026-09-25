// Loopback egress proxy for a confined personal task (issue #77). Seatbelt
// cannot filter by domain name — only by address — so the profile allows
// TCP to this proxy's loopback port and nothing else, and this proxy decides
// by name. Only CONNECT tunnels to an allowlisted domain (or a subdomain of
// one) are dialled; plain-HTTP forwarding is refused so there is no
// unchecked path. Decisions are recorded for the probe report.
import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { assertNetworkDomainAllowed, CapabilityEnvelopeViolation } from '../work-engine/envelope.js';

export interface EgressDecision {
  readonly host: string;
  readonly port: number;
  readonly allowed: boolean;
}

export interface EgressProxy {
  readonly host: '127.0.0.1';
  readonly port: number;
  decisions(): EgressDecision[];
  close(): Promise<void>;
}

export interface EgressProxyOptions {
  readonly allowedDomains: readonly string[];
  /** Test seam: how an allowed tunnel reaches its upstream. */
  readonly connect?: (host: string, port: number) => net.Socket;
}

function parseAuthority(authority: string | undefined): { host: string; port: number } | undefined {
  const match = /^([A-Za-z0-9.-]+):(\d{1,5})$/.exec(authority ?? '');
  if (!match) return undefined;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return undefined;
  return { host: match[1]!.toLowerCase(), port };
}

function isAllowed(allowedDomains: readonly string[], host: string): boolean {
  try {
    assertNetworkDomainAllowed({ allowedNetworkDomains: allowedDomains }, host);
    return true;
  } catch (error) {
    if (error instanceof CapabilityEnvelopeViolation) return false;
    throw error;
  }
}

export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  const decisions: EgressDecision[] = [];
  const openSockets = new Set<Duplex>();
  const dial = options.connect ?? ((host: string, port: number) => net.connect(port, host));

  const server = http.createServer((_request, response) => {
    response.writeHead(403, { 'content-type': 'text/plain' }).end('Only CONNECT to an allowed domain is permitted.\n');
  });

  server.on('connect', (request: http.IncomingMessage, client: Duplex, head: Buffer) => {
    openSockets.add(client);
    client.on('close', () => openSockets.delete(client));
    client.on('error', () => client.destroy());
    const authority = parseAuthority(request.url);
    if (!authority || !isAllowed(options.allowedDomains, authority.host)) {
      if (authority) decisions.push({ ...authority, allowed: false });
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    decisions.push({ ...authority, allowed: true });
    const upstream = dial(authority.host, authority.port);
    openSockets.add(upstream);
    upstream.on('close', () => openSockets.delete(upstream));
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => {
      client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      upstream.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as net.AddressInfo;

  return {
    host: '127.0.0.1',
    port,
    decisions: () => decisions.map((decision) => ({ ...decision })),
    close: () => new Promise<void>((resolve) => {
      for (const socket of openSockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}
