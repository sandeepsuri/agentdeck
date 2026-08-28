import { describe, expect, it } from 'vitest';
import { devUiListeners } from './dev-ui.js';

describe('devUiListeners', () => {
  it('preserves the loopback UI when Tailscale is absent', () => {
    expect(devUiListeners(4040)).toEqual([
      { bindHost: '127.0.0.1', allowedHosts: ['127.0.0.1', 'localhost'], url: 'http://127.0.0.1:4040', label: 'loopback' },
    ]);
  });

  it('adds a concrete tailnet-IP listener on the public UI port and advertises MagicDNS', () => {
    expect(devUiListeners(4040, { ip: '100.101.102.103', hostname: 'mac.tail.example.ts.net' })).toEqual([
      { bindHost: '127.0.0.1', allowedHosts: ['127.0.0.1', 'localhost'], url: 'http://127.0.0.1:4040', label: 'loopback' },
      { bindHost: '100.101.102.103', allowedHosts: ['100.101.102.103', 'mac.tail.example.ts.net'], url: 'http://mac.tail.example.ts.net:4040', label: 'remote' },
    ]);
  });

  it('never emits a wildcard listener', () => {
    expect(devUiListeners(4040, { ip: '100.101.102.103' }).map((listener) => listener.bindHost))
      .not.toContain('0.0.0.0');
  });
});
