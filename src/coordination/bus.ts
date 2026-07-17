import fs from 'node:fs';
import path from 'node:path';
import type { AgentMessage } from '../types.js';

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
  return typeof entry.ts === 'string' && typeof entry.agent === 'string'
    && typeof entry.repo === 'string' && typeof entry.event === 'string';
}

export function parseBusLines(input: string): AgentMessage[] {
  return input.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
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
