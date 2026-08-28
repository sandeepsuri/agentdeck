import type { TailscaleInterface } from './tailscale.js';

export interface DevUiListener {
  bindHost: string;
  allowedHosts: string[];
  url: string;
  label: 'loopback' | 'remote';
}

/** Concrete listeners only: never wildcard-bind the development UI. */
export function devUiListeners(port: number, tailscale?: TailscaleInterface): DevUiListener[] {
  const listeners: DevUiListener[] = [{
    bindHost: '127.0.0.1', allowedHosts: ['127.0.0.1', 'localhost'],
    url: `http://127.0.0.1:${port}`, label: 'loopback',
  }];
  if (tailscale) {
    listeners.push({
      bindHost: tailscale.ip,
      allowedHosts: [tailscale.ip, ...(tailscale.hostname ? [tailscale.hostname] : [])],
      url: `http://${tailscale.hostname ?? tailscale.ip}:${port}`,
      label: 'remote',
    });
  }
  return listeners;
}
