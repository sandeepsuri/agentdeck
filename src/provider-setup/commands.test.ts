// Issue #85: the real process runner, exercised with stand-in shell scripts
// instead of a provider CLI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { macProviderCommands, providerEnvironment } from './commands.js';

let base: string;
beforeEach(() => { base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adk-provider-commands-'))); });
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

function script(name: string, body: string): string {
  const file = path.join(base, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

describe('providerEnvironment', () => {
  it('keeps what a CLI needs to find its own sign-in and drops keys and tokens', () => {
    const env = providerEnvironment('/Users/owner/.local/bin/claude', {
      HOME: '/Users/owner', USER: 'owner', PATH: '/usr/local/bin', CODEX_HOME: '/Users/owner/.codex',
      ANTHROPIC_API_KEY: 'sk-ant-secret', OPENAI_API_KEY: 'sk-secret', GITHUB_TOKEN: 'ghp_secret',
    });
    expect(env).toMatchObject({ HOME: '/Users/owner', USER: 'owner', CODEX_HOME: '/Users/owner/.codex' });
    expect(JSON.stringify(env)).not.toMatch(/secret/);
    expect(env.PATH!.split(':')[0]).toBe('/Users/owner/.local/bin');
    expect(env.PATH).toContain('/usr/bin');
  });
});

describe('macProviderCommands', () => {
  const commands = macProviderCommands({ locate: () => undefined });

  it('reports the exit code and output of a short command, run outside any repository', async () => {
    const cli = script('cli', 'pwd; echo "$ANTHROPIC_API_KEY"; exit 3');
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-leak';
    try {
      const result = await commands.run(cli, [], { timeoutMs: 5000 });
      expect(result.exitCode).toBe(3);
      expect(result.stdout).toContain('agentdeck-provider-check-');
      expect(result.stdout).not.toContain('sk-ant-leak');
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it('stops a command that does not finish, children included', async () => {
    const marker = path.join(base, 'child-alive');
    const cli = script('slow', `(sleep 2; touch "${marker}") & sleep 30`);
    const result = await commands.run(cli, [], { timeoutMs: 300 });
    expect(result).toMatchObject({ exitCode: null, failure: 'timed out' });
    await new Promise((resolve) => { setTimeout(resolve, 2500); });
    expect(fs.existsSync(marker)).toBe(false);
  }, 10_000);

  it('stops a running check on shutdown', async () => {
    const cli = script('hang', 'sleep 30');
    const pending = commands.run(cli, [], { timeoutMs: 20_000 });
    await new Promise((resolve) => { setTimeout(resolve, 200); });
    commands.stopAll!();
    expect((await pending).exitCode).not.toBe(0);
  }, 10_000);

  it('streams a long process’s output, accepts input, and reports its exit', async () => {
    const cli = script('login', 'echo "visit: https://claude.com/x"; read code; echo "got $code"; exit 0');
    const child = commands.start(cli, [], { stdin: true });
    let output = '';
    child.onOutput((text) => { output += text; });
    const exited = new Promise<number | null>((resolve) => { child.onExit(resolve); });
    child.write('abc12345\n');
    expect(await exited).toBe(0);
    expect(output).toContain('got abc12345');
  });
});
