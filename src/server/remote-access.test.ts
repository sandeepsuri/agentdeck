import { describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../config.js';
import { configureRemoteAccess, tailscaleHosts } from './remote-access.js';

describe('remote access bootstrap', () => {
  it('keeps both MagicDNS and raw IP as accepted hosts', () => {
    expect(tailscaleHosts({ ip: '100.101.102.103', hostname: 'mac.tail.example.ts.net' }))
      .toEqual(['mac.tail.example.ts.net', '100.101.102.103']);
  });

  it('detects deterministically and persists a generated token once', async () => {
    const config = defaultConfig();
    const save = vi.fn();
    const result = await configureRemoteAccess(config, {
      detect: async () => ({ ip: '100.101.102.103', hostname: 'mac.tail.example.ts.net' }),
      generateToken: () => 'generated-test-token',
      save,
    });
    expect(result).toEqual({
      tailscale: { ip: '100.101.102.103', hostname: 'mac.tail.example.ts.net' },
      hosts: ['mac.tail.example.ts.net', '100.101.102.103'],
      generatedToken: 'generated-test-token',
    });
    expect(config.tailscaleToken).toBe('generated-test-token');
    expect(save).toHaveBeenCalledWith({ tailscaleToken: 'generated-test-token' });
  });

  it('does not regenerate an existing token', async () => {
    const config = { ...defaultConfig(), tailscaleToken: 'existing-token' };
    const save = vi.fn();
    const generateToken = vi.fn(() => 'replacement');
    const result = await configureRemoteAccess(config, { detect: async () => undefined, save, generateToken });
    expect(result.generatedToken).toBeUndefined();
    expect(save).not.toHaveBeenCalled();
    expect(generateToken).not.toHaveBeenCalled();
  });
});
