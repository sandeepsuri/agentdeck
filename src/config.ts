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
  /**
   * OpenAI API key used by the summary model catalog/picker (ticket 12).
   * Lives only in config.json at owner-only (0600) permissions, written via
   * saveConfig() below. Never written to SQLite (Store has no column for
   * it), never included in a REST response or WebSocket frame, and never
   * logged. Undefined means "not configured" — OpenAI models then show as
   * visible-but-disabled in the picker with a hint to configure one.
   */
  openaiApiKey?: string;
  /**
   * Second-factor token gating tailnet (remote) access (ticket 05). Same
   * storage contract as openaiApiKey above: config.json only, 0600, never
   * SQLite, never logged. Unlike openaiApiKey it is also never returned by
   * any REST/WS response — not even a presence boolean — since it's the
   * whole authentication story for remote access; see server/index.ts's
   * startServer() for the one-time console.log on first generation, which
   * is the only place this value is ever surfaced outside this file.
   */
  tailscaleToken?: string;
  /**
   * Feature gate for the structured Codex Attempt UI (ticket 05). Off by
   * default — the underlying capability is still experimental (no budget
   * enforcement, approvals, or restart recovery yet), so it stays opt-in via
   * config.json until ticket 15 ships the full managed-work release.
   */
  structuredAttemptsEnabled?: boolean;
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
  if (typeof o.openaiApiKey === 'string' && o.openaiApiKey.length > 0) {
    cfg.openaiApiKey = o.openaiApiKey;
  }
  if (typeof o.tailscaleToken === 'string' && o.tailscaleToken.length > 0) {
    cfg.tailscaleToken = o.tailscaleToken;
  }
  if (typeof o.structuredAttemptsEnabled === 'boolean') {
    cfg.structuredAttemptsEnabled = o.structuredAttemptsEnabled;
  }
  return cfg;
}

/**
 * Write a partial patch into ~/.agentdeck/config.json (or `configPath` in
 * tests), merged onto whatever raw JSON is already on disk. Unlike
 * loadConfig()'s in-memory result, this never bakes computed defaults
 * (dataDir, projectsDir, ...) into the file — only the keys actually
 * present in `patch` are touched, and a key set to `undefined` is removed.
 * This is currently the only write path into config.json; it exists for
 * ticket 12's API key storage. Follows Store's constructor pattern
 * (src/store/index.ts) for owner-only (0600) file permissions: create the
 * file at 0600 before writing, and re-chmod even if it already existed
 * with looser permissions.
 */
export function saveConfig(patch: Partial<AgentDeckConfig>, configPath?: string): void {
  const file = configPath ?? path.join(defaultDataDir(), 'config.json');
  let existing: Record<string, unknown> = {};
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof raw === 'object' && raw !== null) existing = raw as Record<string, unknown>;
  } catch {
    // missing or unparseable — start fresh, same permissive stance as loadConfig
  }
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.closeSync(fs.openSync(file, 'a', 0o600));
  fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
