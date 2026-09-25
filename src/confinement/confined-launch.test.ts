import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildConfinedLaunch, prepareConfinedState } from './confined-launch.js';

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

function fixture() {
  tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-launch-')));
  const prefix = path.join(tempRoot, 'prefix');
  const packageBin = path.join(prefix, 'lib', 'node_modules', 'cli', 'bin');
  fs.mkdirSync(packageBin, { recursive: true });
  fs.mkdirSync(path.join(prefix, 'bin'));
  fs.writeFileSync(path.join(packageBin, 'cli.exe'), '\x7fELF');
  fs.symlinkSync(path.join(packageBin, 'cli.exe'), path.join(prefix, 'bin', 'claude'));
  const granted = path.join(tempRoot, 'granted');
  const home = path.join(tempRoot, 'home');
  fs.mkdirSync(granted);
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{}');
  fs.mkdirSync(path.join(home, 'Library', 'Keychains'), { recursive: true });
  const state = prepareConfinedState(path.join(tempRoot, 'state'));
  return { prefix, granted, home, state, executable: path.join(prefix, 'bin', 'claude') };
}

const hostEnv = {
  PATH: '/host/bin', HOME: '/Users/owner', LANG: 'en_US.UTF-8', TERM: 'xterm', USER: 'owner',
  SSH_AUTH_SOCK: '/private/tmp/agent.sock', AWS_SECRET_ACCESS_KEY: 'host-secret', ANTHROPIC_API_KEY: 'sk-host',
  GITHUB_TOKEN: 'ghp-host', CLAUDE_CODE_OAUTH_TOKEN: 'host-token',
};

describe('buildConfinedLaunch', () => {
  it('wraps the resolved CLI in sandbox-exec with a generated profile', () => {
    const f = fixture();
    const launch = buildConfinedLaunch({
      runtime: 'claude', executable: f.executable, args: ['-p', 'hi'], state: f.state,
      grantedReadRoots: [f.granted], proxyPort: 41000, brokerPort: 41001, hostEnv, home: f.home,
    });
    expect(launch.command).toBe('/usr/bin/sandbox-exec');
    expect(launch.args.slice(0, 2)).toEqual(['-p', launch.profile]);
    expect(launch.args.slice(2)).toEqual([fs.realpathSync(f.executable), '-p', 'hi']);
    expect(launch.profile).toContain(`(subpath "${f.granted}")`);
    expect(launch.profile).toContain(`(allow file-read* file-write* (subpath "${f.state.root}"))`);
    expect(launch.profile).toContain('"localhost:41000"');
    expect(launch.profile).toContain('"localhost:41001"');
    expect(launch.cwd).toBe(f.state.work);
  });

  it('passes no host secret or socket through the environment', () => {
    const f = fixture();
    const { env } = buildConfinedLaunch({
      runtime: 'claude', executable: f.executable, args: [], state: f.state,
      grantedReadRoots: [], proxyPort: 41000, hostEnv, home: f.home,
    });
    const values = Object.values(env).join('\n');
    for (const secret of ['host-secret', 'sk-host', 'ghp-host', 'host-token', 'agent.sock', '/host/bin']) {
      expect(values).not.toContain(secret);
    }
    expect(env.HOME).toBe(f.state.home);
    expect(env.TMPDIR).toBe(`${f.state.tmp}/`);
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:41000');
    expect(env.NO_PROXY).toBe('127.0.0.1,localhost');
    expect(env.LANG).toBe('en_US.UTF-8');
  });

  it('gives Claude its private temp directory and the keychain only when asked', () => {
    const f = fixture();
    const base = {
      runtime: 'claude' as const, executable: f.executable, args: [], state: f.state,
      grantedReadRoots: [], proxyPort: 41000, hostEnv, home: f.home,
    };
    const closed = buildConfinedLaunch(base);
    expect(closed.env.CLAUDE_CODE_TMPDIR).toBe(f.state.tmp);
    expect(closed.profile).not.toContain('SecurityServer');
    const keychain = buildConfinedLaunch({ ...base, credential: 'macos-keychain' });
    expect(keychain.profile).toContain('com.apple.SecurityServer');
    expect(fs.readlinkSync(path.join(f.state.home, 'Library', 'Keychains'))).toBe(path.join(f.home, 'Library', 'Keychains'));
    expect(fs.readdirSync(f.state.home).sort()).toEqual(['Library']);
  });

  it('gives Codex a private CODEX_HOME whose only link out is its own login file, read-only', () => {
    const f = fixture();
    const launch = buildConfinedLaunch({
      runtime: 'codex', executable: f.executable, args: [], state: f.state,
      grantedReadRoots: [], proxyPort: 41000, hostEnv, home: f.home,
    });
    const auth = path.join(f.home, '.codex', 'auth.json');
    expect(launch.env.CODEX_HOME).toBe(path.join(f.state.home, '.codex'));
    expect(fs.readlinkSync(path.join(f.state.home, '.codex', 'auth.json'))).toBe(auth);
    expect(launch.profile).toContain(`(allow file-read* (literal "${auth}"))`);
    expect(launch.profile).not.toMatch(new RegExp(`file-write\\*[^\\n]*${f.home}/\\.codex`));
    expect(launch.env.CODEX_CA_CERTIFICATE).toBe('/private/etc/ssl/cert.pem');
  });

  it('refuses an install tree that would expose the home folder', () => {
    const f = fixture();
    const exposed = path.join(f.home, 'bin', 'claude');
    fs.mkdirSync(path.dirname(exposed), { recursive: true });
    fs.writeFileSync(exposed, '\x7fELF');
    expect(() => buildConfinedLaunch({
      runtime: 'claude', executable: exposed, args: [], state: f.state,
      grantedReadRoots: [], proxyPort: 41000, hostEnv, home: f.home,
    })).toThrow(/home folder/);
  });

  it('reads the CLI install tree, not the directory its launcher link sits in', () => {
    const f = fixture();
    const launch = buildConfinedLaunch({
      runtime: 'claude', executable: f.executable, args: [], state: f.state,
      grantedReadRoots: [], proxyPort: 41000, hostEnv, home: f.home,
    });
    expect(launch.profile).toContain(`(subpath "${path.join(f.prefix, 'lib', 'node_modules', 'cli')}")`);
    expect(launch.profile).not.toContain(`(subpath "${f.prefix}")`);
  });
});
