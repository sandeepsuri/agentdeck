import fs from 'node:fs';
import path from 'node:path';
import type { AgentMessage } from '../types.js';

const MAX_BUS_READ_BYTES = 1024 * 1024;
const MAX_BUS_LINE_LENGTH = 64 * 1024;
const EVENTS = new Set<AgentMessage['event']>([
  'status', 'claim', 'release', 'progress', 'blocked', 'done', 'message', 'session_start', 'session_end',
]);
const STATUSES = new Set<NonNullable<AgentMessage['status']>>([
  'starting', 'working', 'waiting_input', 'idle', 'completed', 'exited', 'unknown',
]);

function optionalString(entry: Record<string, unknown>, key: string, maxLength: number): boolean {
  return entry[key] === undefined || (typeof entry[key] === 'string' && entry[key].length <= maxLength);
}

function optionalStrings(entry: Record<string, unknown>, key: string): boolean {
  const value = entry[key];
  return value === undefined || (Array.isArray(value) && value.length <= 1000
    && value.every((item) => typeof item === 'string' && item.length <= 4096));
}

export function agentsDir(repoPath: string): string {
  return path.join(repoPath, '.agents');
}

export async function ensureBus(repoPath: string): Promise<string> {
  const dir = agentsDir(repoPath);
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'bus.jsonl');
  const handle = await fs.promises.open(file, 'a');
  await handle.close();
  return file;
}

export async function appendAgentMessage(repoPath: string, message: AgentMessage): Promise<void> {
  const file = await ensureBus(repoPath);
  const handle = await fs.promises.open(file, 'a');
  try {
    await handle.write(`${JSON.stringify(message)}\n`);
  } finally {
    await handle.close();
  }
}

/**
 * Dashboard → agent messages. Repo-scoped: delivered as context by the
 * UserPromptSubmit hook to whichever hooked Claude session in this repo
 * takes the next turn.
 */
export interface InboxMessage {
  ts: string;
  to: string;
  text: string;
}

export async function appendInboxMessage(repoPath: string, message: InboxMessage): Promise<void> {
  const dir = agentsDir(repoPath);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.appendFile(path.join(dir, 'inbox.jsonl'), `${JSON.stringify(message)}\n`);
}

function isAgentMessage(value: unknown): value is AgentMessage {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.ts === 'string' && entry.ts.length <= 100
    && Number.isFinite(Date.parse(entry.ts))
    && typeof entry.agent === 'string' && entry.agent.length <= 500
    && typeof entry.repo === 'string' && entry.repo.length <= 4096
    && typeof entry.event === 'string' && EVENTS.has(entry.event as AgentMessage['event'])
    && (entry.status === undefined
      || (typeof entry.status === 'string' && STATUSES.has(entry.status as NonNullable<AgentMessage['status']>)))
    && optionalString(entry, 'task', 4096)
    && optionalString(entry, 'message', MAX_BUS_LINE_LENGTH)
    && optionalString(entry, 'summary', MAX_BUS_LINE_LENGTH)
    && optionalString(entry, 'sessionId', 500)
    && optionalString(entry, 'tty', 500)
    && optionalString(entry, 'turnId', 500)
    && optionalStrings(entry, 'files')
    && optionalStrings(entry, 'dependsOn')
    && optionalStrings(entry, 'blockers')
    && (entry.sourcePids === undefined || (Array.isArray(entry.sourcePids)
      && entry.sourcePids.length <= 64
      && entry.sourcePids.every((pid) => typeof pid === 'number' && Number.isInteger(pid) && pid > 0)));
}

export function parseBusLines(input: string): AgentMessage[] {
  return input.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    if (line.length > MAX_BUS_LINE_LENGTH) return [];
    try {
      const value: unknown = JSON.parse(line);
      return isAgentMessage(value) ? [value] : [];
    } catch {
      return [];
    }
  });
}

export class BusWatcher {
  private offset = 0;
  private watcher?: fs.FSWatcher;
  private scanPromise?: Promise<void>;

  constructor(private repoPath: string, private onMessage: (message: AgentMessage) => void) {}

  async start(): Promise<void> {
    const file = await ensureBus(this.repoPath);
    await this.scan();
    this.watcher = fs.watch(file, () => void this.scan().catch(() => undefined));
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = undefined;
  }

  async scan(): Promise<void> {
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = this.performScan().finally(() => {
      this.scanPromise = undefined;
    });
    return this.scanPromise;
  }

  private async performScan(): Promise<void> {
    try {
      const file = await ensureBus(this.repoPath);
      const stat = await fs.promises.stat(file);
      if (stat.size < this.offset) this.offset = 0;
      if (stat.size === this.offset) return;
      // Coordination logs are append-only and may be attacker-controlled in
      // an opened repository. Bound each scan so startup cannot allocate the
      // entire file or replay an unbounded backlog into memory.
      if (stat.size - this.offset > MAX_BUS_READ_BYTES) {
        this.offset = stat.size - MAX_BUS_READ_BYTES;
      }
      const handle = await fs.promises.open(file, 'r');
      try {
        const length = stat.size - this.offset;
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, this.offset);
        this.offset = stat.size;
        for (const message of parseBusLines(buffer.toString('utf8'))) this.onMessage(message);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
