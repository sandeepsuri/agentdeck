// ConnectionTrust: classify() is the single place that decides local vs.
// remote vs. denied and what a connection may do. See
// docs/specs/session-persistence-and-remote-access.md, "ConnectionTrust".
import { describe, expect, it } from 'vitest';
import {
  classify,
  isAllowedOrigin,
  isLoopbackHostHeader,
  TOKEN_HEADER,
  TOKEN_QUERY_PARAM,
} from './connection-trust.js';

const REMOTE_HOST = 'my-mac.tailnet-1234.ts.net';
const REMOTE_IP = '100.101.102.103';
const TOKEN = 'a-very-secret-token-value-1234567890';

describe('classify', () => {
  it('grants full capabilities on loopback, token or not', () => {
    const noOpts = classify({ host: '127.0.0.1:4040' }, {});
    expect(noOpts).toEqual({
      kind: 'local',
      capabilities: new Set(['view', 'compose', 'control-keys', 'raw-write']),
    });

    const withRemoteConfigured = classify(
      { host: 'localhost:4040' },
      { remoteHosts: [REMOTE_HOST], token: TOKEN },
    );
    expect(withRemoteConfigured.kind).toBe('local');
    expect(withRemoteConfigured.capabilities).toEqual(
      new Set(['view', 'compose', 'control-keys', 'raw-write']),
    );

    expect(classify({ host: '[::1]:4040' }, {}).kind).toBe('local');
  });

  it('grants view/compose/control-keys (never raw-write) for the tailnet host with a valid token', () => {
    const result = classify(
      { host: `${REMOTE_HOST}:4040`, token: TOKEN },
      { remoteHosts: [REMOTE_HOST], token: TOKEN },
    );
    expect(result.kind).toBe('remote');
    expect(result.capabilities).toEqual(new Set(['view', 'compose', 'control-keys']));
    expect(result.capabilities.has('raw-write')).toBe(false);
  });

  it('matches the tailnet host case-insensitively and ignoring port', () => {
    const result = classify(
      { host: `${REMOTE_HOST.toUpperCase()}:9999`, token: TOKEN },
      { remoteHosts: [REMOTE_HOST], token: TOKEN },
    );
    expect(result.kind).toBe('remote');
    expect(result.capabilities.size).toBe(3);
  });

  it('accepts both MagicDNS and the bound raw IP from one detected interface', () => {
    const opts = { remoteHosts: [REMOTE_HOST, REMOTE_IP], token: TOKEN };
    expect(classify({ host: `${REMOTE_HOST}:4040`, token: TOKEN }, opts).kind).toBe('remote');
    expect(classify({ host: `${REMOTE_IP}:4040`, token: TOKEN }, opts).kind).toBe('remote');
    expect(classify({ host: `${REMOTE_IP}:4040`, origin: `http://${REMOTE_IP}:4040`, token: TOKEN }, opts).kind).toBe('remote');
  });

  it('is remote-but-unauthenticated (empty capabilities, not denied) with a missing token', () => {
    const result = classify(
      { host: `${REMOTE_HOST}:4040` },
      { remoteHosts: [REMOTE_HOST], token: TOKEN },
    );
    expect(result).toEqual({ kind: 'remote', capabilities: new Set() });
  });

  it('is remote-but-unauthenticated with a wrong token', () => {
    const result = classify(
      { host: `${REMOTE_HOST}:4040`, token: 'not-the-right-token-at-all!!' },
      { remoteHosts: [REMOTE_HOST], token: TOKEN },
    );
    expect(result).toEqual({ kind: 'remote', capabilities: new Set() });
  });

  it('is remote-but-unauthenticated when the tailnet host/token are not configured yet', () => {
    // Even a request that *looks* like it hit the eventual tailnet host must
    // not be denied outright before opts.remoteHosts is known — but with no
    // remote hosts configured there is nothing to match, so an arbitrary host
    // is denied, not remote. This case is: hosts configured, token not.
    const result = classify(
      { host: `${REMOTE_HOST}:4040` },
      { remoteHosts: [REMOTE_HOST] },
    );
    expect(result).toEqual({ kind: 'remote', capabilities: new Set() });
  });

  it('denies an unknown host outright', () => {
    const result = classify(
      { host: 'evil.example:4040' },
      { remoteHosts: [REMOTE_HOST], token: TOKEN },
    );
    expect(result).toEqual({ kind: 'denied', capabilities: new Set() });
  });

  it('denies when no remote hosts are configured and the host is not loopback', () => {
    const result = classify({ host: `${REMOTE_HOST}:4040` }, {});
    expect(result.kind).toBe('denied');
  });

  it('denies a mismatched Origin even for an otherwise-loopback host (DNS-rebinding defense)', () => {
    const result = classify(
      { host: '127.0.0.1:4040', origin: 'https://evil.example' },
      {},
    );
    expect(result.kind).toBe('denied');
  });

  it('denies a mismatched Origin for an otherwise-valid remote host+token', () => {
    const result = classify(
      { host: `${REMOTE_HOST}:4040`, origin: 'https://evil.example', token: TOKEN },
      { remoteHosts: [REMOTE_HOST], token: TOKEN },
    );
    expect(result.kind).toBe('denied');
  });

  it('allows a same-origin request from the tailnet host', () => {
    const result = classify(
      { host: `${REMOTE_HOST}:4040`, origin: `http://${REMOTE_HOST}:4040`, token: TOKEN },
      { remoteHosts: [REMOTE_HOST], token: TOKEN },
    );
    expect(result.kind).toBe('remote');
    expect(result.capabilities.size).toBe(3);
  });

  it('does not throw and returns unauthenticated when the token length mismatches (constant-time compare guard)', () => {
    const result = classify(
      { host: `${REMOTE_HOST}:4040`, token: 'short' },
      { remoteHosts: [REMOTE_HOST], token: TOKEN },
    );
    expect(() => result).not.toThrow();
    expect(result).toEqual({ kind: 'remote', capabilities: new Set() });
  });
});

describe('classify with a collaborator deviceLookup (ticket 11)', () => {
  const DEVICE = {
    id: 'device-1',
    principal: { id: 'collab-1', displayName: 'Alice' },
    grantedRepositoryIds: ['repo-1'],
  };

  it('resolves a device credential to its Principal and device when the shared token does not match', () => {
    const deviceLookup = (token: string) => (token === 'alices-device-token' ? DEVICE : undefined);
    const result = classify(
      { host: `${REMOTE_HOST}:4040`, token: 'alices-device-token' },
      { remoteHosts: [REMOTE_HOST], token: TOKEN, deviceLookup },
    );
    expect(result.kind).toBe('remote');
    expect(result.capabilities).toEqual(new Set(['view', 'compose', 'control-keys']));
    expect(result.device).toEqual(DEVICE);
  });

  it('prefers the legacy shared token when it matches, never consulting deviceLookup', () => {
    const deviceLookup = () => { throw new Error('should not be called'); };
    const result = classify(
      { host: `${REMOTE_HOST}:4040`, token: TOKEN },
      { remoteHosts: [REMOTE_HOST], token: TOKEN, deviceLookup },
    );
    expect(result.kind).toBe('remote');
    expect(result.device).toBeUndefined();
  });

  it('is remote-but-unauthenticated (fail-closed) when neither the shared token nor deviceLookup match', () => {
    const deviceLookup = () => undefined;
    const result = classify(
      { host: `${REMOTE_HOST}:4040`, token: 'a-revoked-or-unknown-token' },
      { remoteHosts: [REMOTE_HOST], token: TOKEN, deviceLookup },
    );
    expect(result).toEqual({ kind: 'remote', capabilities: new Set() });
  });

  it('never calls deviceLookup with an undefined token', () => {
    const deviceLookup = () => { throw new Error('should not be called'); };
    const result = classify(
      { host: `${REMOTE_HOST}:4040` },
      { remoteHosts: [REMOTE_HOST], token: TOKEN, deviceLookup },
    );
    expect(result).toEqual({ kind: 'remote', capabilities: new Set() });
  });

  it('still denies a mismatched Origin before ever consulting deviceLookup', () => {
    const deviceLookup = () => { throw new Error('should not be called'); };
    const result = classify(
      { host: `${REMOTE_HOST}:4040`, origin: 'https://evil.example', token: 'alices-device-token' },
      { remoteHosts: [REMOTE_HOST], token: TOKEN, deviceLookup },
    );
    expect(result.kind).toBe('denied');
  });
});

describe('isLoopbackHostHeader / isAllowedOrigin (moved from app.ts, same behavior)', () => {
  it('still recognizes loopback host headers', () => {
    expect(isLoopbackHostHeader('127.0.0.1:4040')).toBe(true);
    expect(isLoopbackHostHeader('localhost:4040')).toBe(true);
    expect(isLoopbackHostHeader('[::1]:4040')).toBe(true);
    expect(isLoopbackHostHeader('evil.example')).toBe(false);
    expect(isLoopbackHostHeader(undefined)).toBe(false);
  });

  it('accepts a remote-host origin only when remote hosts are passed', () => {
    expect(isAllowedOrigin(`http://${REMOTE_HOST}:4040`, `${REMOTE_HOST}:4040`)).toBe(false);
    expect(isAllowedOrigin(`http://${REMOTE_HOST}:4040`, `${REMOTE_HOST}:4040`, [REMOTE_HOST])).toBe(true);
  });
});

describe('shared token constants', () => {
  it('exports the query param and header names ticket 14 and the client will import', () => {
    expect(TOKEN_QUERY_PARAM).toBe('token');
    expect(TOKEN_HEADER).toBe('x-agentdeck-token');
  });
});
