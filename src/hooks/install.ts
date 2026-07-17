import fs from 'node:fs';
import path from 'node:path';

type Json = Record<string, unknown>;
const MARKER = '# agentdeck-previous-notify:';

function hook(command: string, matcher?: string): Json {
  const item: Json = { hooks: [{ type: 'command', command }] };
  if (matcher) item.matcher = matcher;
  return item;
}

export function mergeClaudeSettings(raw: string, command: string): string {
  const settings = raw.trim() ? JSON.parse(raw) as Json : {};
  const hooks = (settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {}) as Record<string, unknown[]>;
  const add = (event: string, matcher?: string) => {
    const list = hooks[event] ?? [];
    if (!JSON.stringify(list).includes('agentdeck-hook')) list.push(hook(command, matcher));
    hooks[event] = list;
  };
  add('Notification'); add('Stop'); add('PostToolUse', 'Edit|Write'); add('PreToolUse'); add('SessionStart'); add('UserPromptSubmit');
  settings.hooks = hooks;
  return `${JSON.stringify(settings, null, 2)}\n`;
}

export function removeClaudeSettings(raw: string): string {
  const settings = raw.trim() ? JSON.parse(raw) as Json : {};
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (hooks) {
    for (const [event, list] of Object.entries(hooks)) {
      hooks[event] = list.filter((item) => !JSON.stringify(item).includes('agentdeck-hook'));
      if (hooks[event]?.length === 0) delete hooks[event];
    }
  }
  return `${JSON.stringify(settings, null, 2)}\n`;
}

export function installCodexNotify(raw: string, hookPath: string): string {
  if (raw.includes(MARKER)) return raw;
  const lines = raw.split(/(?<=\n)/);
  const index = lines.findIndex((line) => /^\s*notify\s*=/.test(line));
  const original = index >= 0 ? lines[index]! : '';
  const previous = original.replace(/^\s*notify\s*=\s*/, '').trim();
  const encoded = Buffer.from(previous).toString('base64');
  const next = `notify = ["node", ${JSON.stringify(hookPath)}, "--forward-base64", ${JSON.stringify(encoded)}]\n`;
  const marker = `${MARKER}${Buffer.from(original).toString('base64')}\n`;
  if (index >= 0) lines.splice(index, 1, marker, next);
  else lines.push(marker, next);
  return lines.join('');
}

export function uninstallCodexNotify(raw: string): string {
  const lines = raw.split(/(?<=\n)/);
  const markerIndex = lines.findIndex((line) => line.startsWith(MARKER));
  if (markerIndex < 0) return raw;
  const original = Buffer.from(lines[markerIndex]!.slice(MARKER.length).trim(), 'base64').toString('utf8');
  lines.splice(markerIndex, 2, original);
  return lines.join('');
}

function backup(file: string): void {
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.agentdeck-backup-${Date.now()}`);
}

export function installClaudeHooks(repoPath: string, hookPath: string): void {
  const file = path.join(repoPath, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  backup(file);
  fs.writeFileSync(file, mergeClaudeSettings(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '', `node ${JSON.stringify(hookPath)}`));
}

export function uninstallClaudeHooks(repoPath: string): void {
  const file = path.join(repoPath, '.claude', 'settings.json');
  if (!fs.existsSync(file)) return;
  backup(file);
  fs.writeFileSync(file, removeClaudeSettings(fs.readFileSync(file, 'utf8')));
}

export function installCodexHooks(configFile: string, hookPath: string): void {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  backup(configFile);
  fs.writeFileSync(configFile, installCodexNotify(fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '', hookPath));
}

export function uninstallCodexHooks(configFile: string): void {
  if (!fs.existsSync(configFile)) return;
  backup(configFile);
  fs.writeFileSync(configFile, uninstallCodexNotify(fs.readFileSync(configFile, 'utf8')));
}
