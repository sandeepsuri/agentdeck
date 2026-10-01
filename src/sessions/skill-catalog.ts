// The Claude Code skills and custom slash commands a session can run, for
// the Conversation composer's "/" picker. Read from the same places Claude
// Code looks: the session's project (.claude/skills, .claude/commands), the
// user's config dir (~/.claude or CLAUDE_CONFIG_DIR) and installed plugins.
// Sending the picked "/name" is just text typed into the live CLI — this
// only makes the names discoverable.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type SkillSource = 'project' | 'user' | 'plugin';

export interface SkillEntry {
  /** What follows the slash: `implement`, `ns:cmd` for a nested command, `plugin:skill` for a plugin's. */
  name: string;
  description: string;
  source: SkillSource;
  kind: 'skill' | 'command';
}

const CACHE_MS = 10_000;

export function defaultClaudeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** The `name:` and `description:` of a Markdown file's YAML front-matter, plus the body after it. */
export function readFrontMatter(text: string): { fields: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!field) continue;
    let value = field[2]!.trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    fields[field[1]!] = value;
  }
  return { fields, body: text.slice(match[0].length) };
}

function firstLine(body: string): string {
  return body.split(/\r?\n/).map((line) => line.replace(/^#+\s*/, '').trim()).find(Boolean) ?? '';
}

function readText(file: string): string | undefined {
  try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; }
}

function listDir(dir: string): fs.Dirent[] {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

/** Dirent types don't follow symlinks; skills are often symlinked in. */
function isDirectory(entry: fs.Dirent, parent: string): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try { return fs.statSync(path.join(parent, entry.name)).isDirectory(); } catch { return false; }
}

function isFile(entry: fs.Dirent, parent: string): boolean {
  if (entry.isFile()) return true;
  if (!entry.isSymbolicLink()) return false;
  try { return fs.statSync(path.join(parent, entry.name)).isFile(); } catch { return false; }
}

/** `<dir>/<skill>/SKILL.md` — the folder name is the command unless front-matter names it. */
function scanSkills(dir: string, source: SkillSource, prefix = ''): SkillEntry[] {
  const skills: SkillEntry[] = [];
  for (const entry of listDir(dir)) {
    if (!isDirectory(entry, dir)) continue;
    const text = readText(path.join(dir, entry.name, 'SKILL.md'));
    if (text === undefined) continue;
    const { fields, body } = readFrontMatter(text);
    skills.push({ name: prefix + (fields.name || entry.name), description: fields.description || firstLine(body), source, kind: 'skill' });
  }
  return skills;
}

/** `<dir>/**\/*.md` — a subfolder becomes a `folder:` namespace, as in Claude Code. */
function scanCommands(dir: string, source: SkillSource, prefix = '', depth = 0): SkillEntry[] {
  const commands: SkillEntry[] = [];
  for (const entry of listDir(dir)) {
    if (depth < 3 && isDirectory(entry, dir)) {
      commands.push(...scanCommands(path.join(dir, entry.name), source, `${prefix}${entry.name}:`, depth + 1));
    } else if (entry.name.endsWith('.md') && isFile(entry, dir)) {
      const text = readText(path.join(dir, entry.name)) ?? '';
      const { fields, body } = readFrontMatter(text);
      commands.push({ name: prefix + entry.name.slice(0, -3), description: fields.description || firstLine(body), source, kind: 'command' });
    }
  }
  return commands;
}

function readJson(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

/** Installed plugins' install paths, minus any the user switched off in settings.json. */
function pluginRoots(claudeHome: string): Array<{ plugin: string; root: string }> {
  const installed = readJson(path.join(claudeHome, 'plugins', 'installed_plugins.json')) as
    { plugins?: Record<string, Array<{ installPath?: unknown }>> } | undefined;
  const settings = readJson(path.join(claudeHome, 'settings.json')) as { enabledPlugins?: Record<string, unknown> } | undefined;
  const roots: Array<{ plugin: string; root: string }> = [];
  for (const [id, installs] of Object.entries(installed?.plugins ?? {})) {
    if (settings?.enabledPlugins?.[id] === false || !Array.isArray(installs)) continue;
    const root = installs.find((install) => typeof install?.installPath === 'string')?.installPath as string | undefined;
    if (root) roots.push({ plugin: id.split('@')[0]!, root });
  }
  return roots;
}

export class SkillCatalog {
  private readonly claudeHome: string;
  private readonly now: () => number;
  private readonly cache = new Map<string, { at: number; skills: SkillEntry[] }>();

  constructor(options: { claudeHome?: string; now?: () => number } = {}) {
    this.claudeHome = options.claudeHome ?? defaultClaudeHome();
    this.now = options.now ?? Date.now;
  }

  /** Every skill and command available in `cwd`, sorted by name; a project entry hides a same-named user or plugin one. */
  list(cwd?: string): SkillEntry[] {
    const key = cwd ?? '';
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < CACHE_MS) return cached.skills;
    const found: SkillEntry[] = [];
    if (cwd) {
      found.push(...scanSkills(path.join(cwd, '.claude', 'skills'), 'project'));
      found.push(...scanCommands(path.join(cwd, '.claude', 'commands'), 'project'));
    }
    found.push(...scanSkills(path.join(this.claudeHome, 'skills'), 'user'));
    found.push(...scanCommands(path.join(this.claudeHome, 'commands'), 'user'));
    for (const { plugin, root } of pluginRoots(this.claudeHome)) {
      found.push(...scanSkills(path.join(root, 'skills'), 'plugin', `${plugin}:`));
      found.push(...scanCommands(path.join(root, 'commands'), 'plugin', `${plugin}:`));
    }
    const byName = new Map<string, SkillEntry>();
    for (const entry of found) if (!byName.has(entry.name)) byName.set(entry.name, entry);
    const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    this.cache.set(key, { at: this.now(), skills });
    return skills;
  }
}
