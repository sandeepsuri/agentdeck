import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startEgressProxy, type EgressProxy } from './egress-proxy.js';

let proxy: EgressProxy | undefined;
let upstream: net.Server | undefined;

afterEach(async () => {
  await proxy?.close();
  proxy = undefined;
  await new Promise<void>((resolve) => (upstream ? upstream.close(() => resolve()) : resolve()));
  upstream = undefined;
});

async function startEchoUpstream(): Promise<number> {
  upstream = net.createServer((socket) => socket.pipe(socket));
  await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', resolve));
  return (upstream.address() as net.AddressInfo).port;
}

function connectThrough(port: number, target: string): Promise<{ status: number; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: target });
    request.on('connect', (response, socket) => resolve({ status: response.statusCode ?? 0, socket }));
    request.on('error', reject);
    request.end();
  });
}

describe('startEgressProxy', () => {
  it('tunnels CONNECT to an allowlisted domain or its subdomain', async () => {
    const upstreamPort = await startEchoUpstream();
    proxy = await startEgressProxy({
      allowedDomains: ['provider.test'],
      connect: (_host, _port) => net.connect(upstreamPort, '127.0.0.1'),
    });
    const { status, socket } = await connectThrough(proxy.port, 'api.provider.test:443');
    expect(status).toBe(200);
    const echoed = await new Promise<string>((resolve) => {
      socket.once('data', (chunk) => resolve(chunk.toString()));
      socket.write('ping');
    });
    socket.destroy();
    expect(echoed).toBe('ping');
    expect(proxy.decisions()).toEqual([{ host: 'api.provider.test', port: 443, allowed: true }]);
  });

  it('refuses an ungranted domain without ever dialling it', async () => {
    let dialled = false;
    proxy = await startEgressProxy({
      allowedDomains: ['provider.test'],
      connect: () => { dialled = true; return new net.Socket(); },
    });
    const { status, socket } = await connectThrough(proxy.port, 'evil-provider.test:443');
    socket.destroy();
    expect(status).toBe(403);
    expect(dialled).toBe(false);
    expect(proxy.decisions()).toEqual([{ host: 'evil-provider.test', port: 443, allowed: false }]);
  });

  it('refuses plain HTTP forwarding so every request is a checked CONNECT', async () => {
    proxy = await startEgressProxy({ allowedDomains: ['provider.test'] });
    const status = await new Promise<number>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: proxy!.port, path: 'http://provider.test/' }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      }).on('error', reject);
    });
    expect(status).toBe(403);
  });

  it('listens on loopback only', async () => {
    proxy = await startEgressProxy({ allowedDomains: [] });
    expect(proxy.host).toBe('127.0.0.1');
  });
});
