import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, defaultProjectsDir, expandTilde, loadConfig, saveConfig } from './config.js';

function tmpFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-config-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, content);
  return file;
}

describe('loadConfig', () => {
  it('returns defaults when the file is missing', () => {
    const cfg = loadConfig('/nonexistent/config.json');
    expect(cfg).toEqual(defaultConfig());
    expect(cfg.port).toBe(4040);
    expect(cfg.pollIntervalMs).toBe(5000);
    expect(cfg.projectsDir).toBe(defaultProjectsDir());
  });

  it('merges valid overrides', () => {
    const file = tmpFile(JSON.stringify({ port: 5050, pollIntervalMs: 10000 }));
    const cfg = loadConfig(file);
    expect(cfg.port).toBe(5050);
    expect(cfg.pollIntervalMs).toBe(10000);
    expect(cfg.projectsDir).toBe(defaultConfig().projectsDir); // untouched
  });

  it('expands ~ in path overrides', () => {
    const file = tmpFile(JSON.stringify({ projectsDir: '~/code' }));
    expect(loadConfig(file).projectsDir).toBe(path.join(os.homedir(), 'code'));
  });

  it('ignores invalid values instead of crashing', () => {
    const file = tmpFile(JSON.stringify({ port: 'not-a-port', pollIntervalMs: 1 }));
    const cfg = loadConfig(file);
    expect(cfg.port).toBe(4040);
    expect(cfg.pollIntervalMs).toBe(5000);
  });

  it('survives unparseable JSON', () => {
    const file = tmpFile('{nope');
    expect(loadConfig(file)).toEqual(defaultConfig());
  });
});

describe('defaultProjectsDir', () => {
  it('uses the parent when launched inside a git repo, else the cwd itself', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-projdir-'));
    const repo = path.join(dir, 'my-repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    expect(defaultProjectsDir(repo)).toBe(dir);
    expect(defaultProjectsDir(dir)).toBe(dir);
  });
});

describe('expandTilde', () => {
  it('expands ~ and ~/', () => {
    expect(expandTilde('~')).toBe(os.homedir());
    expect(expandTilde('~/x')).toBe(path.join(os.homedir(), 'x'));
    expect(expandTilde('/abs/x')).toBe('/abs/x');
  });
});

describe('saveConfig', () => {
  function tmpConfigPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-config-save-'));
    return path.join(dir, 'config.json');
  }

  it('creates a new config file at owner-only (0600) permissions', () => {
    const file = tmpConfigPath();
    saveConfig({ openaiApiKey: 'sk-secret' }, file);
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('round-trips a saved key back through loadConfig', () => {
    const file = tmpConfigPath();
    saveConfig({ openaiApiKey: 'sk-secret' }, file);
    expect(loadConfig(file).openaiApiKey).toBe('sk-secret');
  });

  it('merges a patch onto an existing file instead of clobbering other keys', () => {
    const file = tmpConfigPath();
    fs.writeFileSync(file, JSON.stringify({ port: 5050 }));
    saveConfig({ openaiApiKey: 'sk-secret' }, file);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(onDisk.port).toBe(5050);
    expect(onDisk.openaiApiKey).toBe('sk-secret');
  });

  it('removes a key from the file when the patch value is undefined', () => {
    const file = tmpConfigPath();
    saveConfig({ openaiApiKey: 'sk-secret' }, file);
    saveConfig({ openaiApiKey: undefined }, file);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect('openaiApiKey' in onDisk).toBe(false);
    expect(loadConfig(file).openaiApiKey).toBeUndefined();
  });

  it('does not bake unrelated resolved defaults into the file', () => {
    const file = tmpConfigPath();
    saveConfig({ openaiApiKey: 'sk-secret' }, file);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect('dataDir' in onDisk).toBe(false);
    expect('projectsDir' in onDisk).toBe(false);
  });

  it('creates parent directories as needed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-config-save-'));
    const file = path.join(dir, 'nested', 'config.json');
    saveConfig({ openaiApiKey: 'sk-secret' }, file);
    expect(loadConfig(file).openaiApiKey).toBe('sk-secret');
  });
});
