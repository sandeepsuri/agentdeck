import crypto from 'node:crypto';
import http, { type Server as HttpServer } from 'node:http';
import type { AgentDeckConfig } from '../config.js';
import { saveConfig } from '../config.js';
import { detectTailscaleInterface, type TailscaleInterface } from './tailscale.js';

export interface RemoteAccess {
  tailscale?: TailscaleInterface;
  hosts: string[];
  generatedToken?: string;
}

export function tailscaleHosts(tailscale: TailscaleInterface | undefined): string[] {
  if (!tailscale) return [];
  return [...new Set([tailscale.hostname, tailscale.ip].filter((host): host is string => Boolean(host)))];
}

export async function configureRemoteAccess(
  config: AgentDeckConfig,
  deps: {
    detect?: typeof detectTailscaleInterface;
    save?: typeof saveConfig;
    generateToken?: () => string;
  } = {},
): Promise<RemoteAccess> {
  const tailscale = await (deps.detect ?? detectTailscaleInterface)();
  let generatedToken: string | undefined;
  if (!config.tailscaleToken) {
    generatedToken = (deps.generateToken ?? (() => crypto.randomBytes(24).toString('base64url')))();
    (deps.save ?? saveConfig)({ tailscaleToken: generatedToken });
    config.tailscaleToken = generatedToken;
  }
  return { tailscale, hosts: tailscaleHosts(tailscale), generatedToken };
}

/**
 * Reuse Fastify's request listener on a second concrete interface. A bind
 * failure is recoverable: loopback remains available and startup continues.
 */
export async function listenOnTailnet(
  loopbackServer: HttpServer,
  port: number,
  tailscale: TailscaleInterface | undefined,
): Promise<HttpServer | undefined> {
  if (!tailscale) return undefined;
  const requestListener = loopbackServer.listeners('request')[0] as
    ((req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void) | undefined;
  if (!requestListener) return undefined;

  const server = http.createServer(requestListener);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, tailscale.ip, resolve);
    });
    return server;
  } catch (error) {
    if (server.listening) server.close();
    console.error('[agentdeck] failed to bind the Tailscale interface; continuing on loopback only', error);
    return undefined;
  }
}
