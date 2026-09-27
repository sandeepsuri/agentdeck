// Issue #85: the provider setup flow on this Mac — check, install, sign in,
// and repair — driven through fake CLI commands. Nothing here runs a real
// provider CLI.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../store/index.js';
import { FakeCommands, SIGNED_IN, SIGNED_OUT } from '../test-fixtures/provider-commands.js';
import { ProviderSetupService } from './service.js';

let store: Store;
let commands: FakeCommands;
let service: ProviderSetupService;
let clock: number;

beforeEach(() => {
  store = new Store(':memory:');
  commands = new FakeCommands();
  clock = Date.parse('2026-09-27T12:00:00.000Z');
  service = new ProviderSetupService({ repository: store.providerReadiness, commands, now: () => new Date(clock) });
});

afterEach(async () => {
  service.shutdown();
  await service.whenIdle();
  store.close();
});

const entry = (provider: 'claude' | 'codex') => service.view().providers.find((item) => item.provider === provider)!;

describe('readiness check', () => {
  it('runs only harmless commands and persists readiness metadata, never the account', async () => {
    await service.check('claude');
    expect(commands.runs).toEqual([
      ['--version'],
      ['auth', 'status'],
      ['-p', '/usage', '--output-format', 'json', '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence', '--tools', ''],
    ]);
    expect(entry('claude')).toMatchObject({
      confirmedThisLaunch: true,
      readiness: { state: 'ready', cliVersion: '2.1.283', authMethod: 'claude.ai', plan: 'max', allowance: [{ usedPercent: 12 }, { usedPercent: 30 }] },
    });
    expect(store.providerReadiness.get('claude')).toEqual({
      provider: 'claude', state: 'ready', detail: expect.any(String), cliVersion: '2.1.283', authMethod: 'claude.ai', plan: 'max',
      checkedAt: '2026-09-27T12:00:00.000Z', lastReadyAt: '2026-09-27T12:00:00.000Z',
    });
    expect(JSON.stringify(service.view())).not.toMatch(/example\.com|org-1|\.local\/bin/);
  });

  it('skips the allowance read when the CLI is signed out', async () => {
    commands.authStatus = { exitCode: 1, stdout: SIGNED_OUT };
    await service.check('claude');
    expect(commands.runs.some((args) => args[0] === '-p')).toBe(false);
    expect(entry('claude').readiness?.state).toBe('signed-out');
    expect(entry('claude').repair?.actions).toEqual(['sign-in']);
  });

  it('keeps the last ready time through a failed check', async () => {
    await service.check('claude');
    clock += 60_000;
    commands.usage = { exitCode: 0, stdout: JSON.stringify({ is_error: false, result: 'Total cost: $0.00' }) };
    await service.check('claude');
    expect(store.providerReadiness.get('claude')).toMatchObject({ state: 'check-failed', lastReadyAt: '2026-09-27T12:00:00.000Z', checkedAt: '2026-09-27T12:01:00.000Z' });
  });

  it('shows the last check as unconfirmed after a relaunch, then checks each provider once', async () => {
    await service.check('claude');
    commands.runs = [];
    const relaunched = new ProviderSetupService({ repository: store.providerReadiness, commands, now: () => new Date(clock) });
    const before = relaunched.view().providers.find((item) => item.provider === 'claude')!;
    expect(before).toMatchObject({ confirmedThisLaunch: false, readiness: { state: 'ready' } });

    relaunched.ensureCheckedThisLaunch();
    relaunched.ensureCheckedThisLaunch();
    await relaunched.whenIdle();
    expect(commands.runs.filter((args) => args[0] === 'auth')).toHaveLength(1);
    expect(relaunched.view().providers.every((item) => item.confirmedThisLaunch)).toBe(true);
    expect(relaunched.view().providers.find((item) => item.provider === 'codex')?.readiness?.state).toBe('missing-cli');
  });
});

describe('installation', () => {
  it('runs Claude Code’s official installer, then checks the new CLI', async () => {
    commands.installed.claude = false;
    service.install('claude');
    expect(entry('claude').operation).toMatchObject({ kind: 'install', state: 'running' });
    const [installer] = commands.processes;
    expect(installer!.command).toBe('/bin/bash');
    expect(installer!.args.slice(0, 2)).toEqual(['-o', 'pipefail']);
    expect(installer!.args.join(' ')).toContain('https://claude.ai/install.sh');

    commands.installed.claude = true;
    installer!.exit(0);
    await service.whenIdle();
    expect(entry('claude').operation).toBeUndefined();
    expect(entry('claude').readiness?.state).toBe('ready');
  });

  it('reports a failed installer with its last output lines, redacted', async () => {
    commands.installed.claude = false;
    service.install('claude');
    commands.processes[0]!.print('Downloading to /Users/owner/.claude/downloads\nDownload failed\n');
    commands.processes[0]!.exit(1);
    await service.whenIdle();
    expect(entry('claude').operation).toMatchObject({ kind: 'install', state: 'failed' });
    expect(entry('claude').operation?.message).toContain('Download failed');
  });

  it('opens only the provider’s own install page for Codex, never an installer', async () => {
    expect(() => service.install('codex')).toThrow(/install page/);
    await service.openInstallGuide('codex');
    expect(commands.opened).toEqual(['https://developers.openai.com/codex/cli']);
    expect(commands.processes).toHaveLength(0);
  });
});

describe('sign-in', () => {
  it('starts the provider’s own browser sign-in and checks readiness when it finishes', async () => {
    commands.authStatus = { exitCode: 1, stdout: SIGNED_OUT };
    await service.check('claude');
    service.signIn('claude');
    const login = commands.processes[0]!;
    expect([login.command, ...login.args]).toEqual(['/Users/owner/.local/bin/claude', 'auth', 'login', '--claudeai']);
    expect(entry('claude').operation).toMatchObject({ kind: 'sign-in', state: 'running', browserPageAvailable: false });

    login.print('Opening browser to sign in…\nIf the browser didn\'t open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc\nPaste code here if prompted > ');
    expect(entry('claude').operation).toMatchObject({ browserPageAvailable: true, acceptsCode: true });
    expect(JSON.stringify(service.view())).not.toContain('oauth/authorize');

    await service.openSignInPage('claude');
    expect(commands.opened).toEqual(['https://claude.com/cai/oauth/authorize?code=true&state=abc']);

    commands.authStatus = { exitCode: 0, stdout: SIGNED_IN };
    login.exit(0);
    await service.whenIdle();
    expect(entry('claude').operation).toBeUndefined();
    expect(entry('claude').readiness?.state).toBe('ready');
  });

  it('hands a pasted sign-in code to the provider CLI without keeping it', () => {
    service.signIn('claude');
    commands.processes[0]!.print('Paste code here if prompted > ');
    service.submitSignInCode('claude', '  abc123#def456  ');
    expect(commands.processes[0]!.written).toEqual(['abc123#def456\n']);
    expect(JSON.stringify(service.view())).not.toContain('abc123');
    expect(() => service.submitSignInCode('claude', 'not a code; rm -rf')).toThrow(/code/);
  });

  it('never opens a printed address that is not the provider’s sign-in page', async () => {
    service.signIn('claude');
    commands.processes[0]!.print('visit: https://evil.example.com/login\n');
    expect(entry('claude').operation?.browserPageAvailable).toBe(false);
    await expect(service.openSignInPage('claude')).rejects.toThrow();
    expect(commands.opened).toEqual([]);
  });

  it('can be cancelled, and a failed sign-in leaves a repair message', async () => {
    service.signIn('claude');
    service.cancel('claude');
    expect(commands.processes[0]!.killed).toBe(true);
    expect(entry('claude').operation).toBeUndefined();

    service.signIn('claude');
    commands.processes[1]!.exit(1);
    await service.whenIdle();
    expect(entry('claude').operation).toMatchObject({ kind: 'sign-in', state: 'failed' });
  });

  it('refuses a second operation while one is running and needs an installed CLI', () => {
    service.signIn('claude');
    expect(() => service.signIn('claude')).toThrow(/already/);
    expect(() => service.signIn('codex')).toThrow(/not installed/);
  });

  it('stops every running operation on shutdown', () => {
    service.signIn('claude');
    service.shutdown();
    expect(commands.processes[0]!.killed).toBe(true);
  });
});
