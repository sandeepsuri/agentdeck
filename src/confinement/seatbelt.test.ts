import { describe, expect, it } from 'vitest';
import { buildSeatbeltProfile, SeatbeltProfileError } from './seatbelt.js';

const spec = {
  runtimeRoots: ['/opt/runtime'],
  readRoots: ['/Users/owner/Granted'],
  readFiles: ['/Users/owner/.codex/auth.json'],
  writeRoots: ['/private/var/folders/task/work'],
  loopbackPorts: [47711, 47712],
};

describe('buildSeatbeltProfile', () => {
  it('closes by default and lets child processes inherit the same policy', () => {
    const profile = buildSeatbeltProfile(spec);
    expect(profile).toMatch(/^\(version 1\)\n\(deny default\)/);
    expect(profile).toContain('(allow process-fork process-exec)');
    expect(profile).toContain('(allow signal (target same-sandbox))');
  });

  it('grants only the named roots, with writes limited to write roots', () => {
    const profile = buildSeatbeltProfile(spec);
    expect(profile).toContain('(allow file-read* file-map-executable (subpath "/opt/runtime"))');
    expect(profile).toContain('(allow file-read* (subpath "/Users/owner/Granted"))');
    expect(profile).toContain('(allow file-read* (literal "/Users/owner/.codex/auth.json"))');
    expect(profile).toContain('(allow file-read* file-write* (subpath "/private/var/folders/task/work"))');
    expect(profile).not.toMatch(/file-write\*[^)]*"\/Users\/owner\/Granted"/);
  });

  it('allows network only to the named loopback ports — no DNS, no remote hosts', () => {
    const profile = buildSeatbeltProfile(spec);
    const networkRules = profile.split('\n').filter((line) => line.includes('network'));
    expect(networkRules).toEqual([
      '(allow network-outbound (remote tcp "localhost:47711"))',
      '(allow network-outbound (remote tcp "localhost:47712"))',
    ]);
    expect(profile).not.toContain('mDNSResponder');
  });

  it('never opens the keychain, Apple Events, pasteboard, or launch services', () => {
    const profile = buildSeatbeltProfile(spec);
    for (const service of ['SecurityServer', 'securityd', 'appleevents', 'pasteboard', 'lsd', 'trustd']) {
      expect(profile).not.toContain(service);
    }
  });

  it('opens SecurityServer and the keychain directory only when a keychain directory is named', () => {
    const profile = buildSeatbeltProfile({ ...spec, keychainDirectory: '/Users/owner/Library/Keychains' });
    expect(profile).toContain('(global-name "com.apple.SecurityServer")');
    expect(profile).toContain('(allow file-read* (subpath "/Users/owner/Library/Keychains"))');
  });

  it('rejects relative paths and characters that could escape an SBPL string', () => {
    expect(() => buildSeatbeltProfile({ ...spec, readRoots: ['relative/dir'] })).toThrow(SeatbeltProfileError);
    expect(() => buildSeatbeltProfile({ ...spec, readRoots: ['/a"))(allow default)'] })).toThrow(SeatbeltProfileError);
    expect(() => buildSeatbeltProfile({ ...spec, writeRoots: ['/a\\b'] })).toThrow(SeatbeltProfileError);
    expect(() => buildSeatbeltProfile({ ...spec, writeRoots: ['/a\nb'] })).toThrow(SeatbeltProfileError);
  });

  it('refuses to grant the filesystem root or an invalid port', () => {
    expect(() => buildSeatbeltProfile({ ...spec, readRoots: ['/'] })).toThrow(SeatbeltProfileError);
    expect(() => buildSeatbeltProfile({ ...spec, loopbackPorts: [0] })).toThrow(SeatbeltProfileError);
    expect(() => buildSeatbeltProfile({ ...spec, loopbackPorts: [70000] })).toThrow(SeatbeltProfileError);
  });
});
