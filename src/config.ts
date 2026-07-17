// Config module: ~/.agentdeck/config.json with defaults. Every value is
// overridable in that file; tests pass an explicit path/overrides instead.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface AgentDeckConfig {
  /** Port the app is reachable on (UI + API). */
  port: number;
  /** Directory scanned for git repos (launch form, repo attribution). */
  projectsDir: string;
  /** External-discovery poll interval. */
  pollIntervalMs: number;
  /** Where app state lives (config.json, agentdeck.db). */
  dataDir: string;
}

export function defaultDataDir(): string {
  return path.join(os.homedir(), '.agentdeck');
}

/**
 * With no configured projectsDir, derive it from where agentdeck was
 * launched: inside a git repo → the repo's parent (so sibling projects are
 * scanned too); anywhere else → the cwd itself.
 */
export function defaultProjectsDir(cwd: string = process.cwd()): string {
  return fs.existsSync(path.join(cwd, '.git')) ? path.dirname(cwd) : cwd;
}

export function defaultConfig(): AgentDeckConfig {
  return {
    port: 4040,
    projectsDir: defaultProjectsDir(),
    pollIntervalMs: 5000,
    dataDir: defaultDataDir(),
  };
}

export function expandTilde(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Load config from `configPath` (default: ~/.agentdeck/config.json).
 * Missing file or unknown/invalid keys fall back to defaults — a broken
 * config file must never prevent startup.
 */
export function loadConfig(configPath?: string): AgentDeckConfig {
  const cfg = defaultConfig();
  const file = configPath ?? path.join(defaultDataDir(), 'config.json');
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return cfg; // missing or unparseable → defaults
  }
  if (typeof raw !== 'object' || raw === null) return cfg;
  const o = raw as Record<string, unknown>;
  if (typeof o.port === 'number' && Number.isInteger(o.port) && o.port > 0 && o.port < 65536) {
    cfg.port = o.port;
  }
  if (typeof o.projectsDir === 'string' && o.projectsDir.length > 0) {
    cfg.projectsDir = expandTilde(o.projectsDir);
  }
  if (typeof o.pollIntervalMs === 'number' && o.pollIntervalMs >= 500) {
    cfg.pollIntervalMs = o.pollIntervalMs;
  }
  if (typeof o.dataDir === 'string' && o.dataDir.length > 0) {
    cfg.dataDir = expandTilde(o.dataDir);
  }
  return cfg;
}
