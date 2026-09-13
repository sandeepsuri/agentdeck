// UsageIndexer: incrementally copies token usage out of the Claude Code and
// Codex logs into SQLite. The logs run to hundreds of MB, so each file keeps
// a byte cursor; a pass reads only what was appended since the last one, cut
// at the final newline so a line still being written is picked up next time.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { UsageFileCursor, UsageRepository } from '../store/usage.js';
import { parseClaudeLines, parseCodexLines } from './parse.js';
import type { RateLimitSnapshot, UsageEvent, UsageProvider } from './types.js';

const CHUNK_BYTES = 4 * 1024 * 1024;
const NEWLINE = 0x0a;

export interface UsageRoots {
  claude: string[];
  codex: string[];
}

export function defaultUsageRoots(env: NodeJS.ProcessEnv = process.env): UsageRoots {
  const home = os.homedir();
  const claudeHome = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const codexHome = env.CODEX_HOME || path.join(home, '.codex');
  return {
    claude: [path.join(claudeHome, 'projects')],
    codex: [path.join(codexHome, 'sessions'), path.join(codexHome, 'archived_sessions')],
  };
}

async function listJsonl(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true, recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

export interface UsageIndexerOptions {
  repository: UsageRepository;
  roots?: UsageRoots;
  intervalMs?: number;
  /** Called after every completed pass (e.g. to detect first-used models). */
  onIndexed?: () => void;
  log?: (message: string, error?: unknown) => void;
}

export class UsageIndexer {
  private readonly repository: UsageRepository;
  private readonly roots: UsageRoots;
  private readonly intervalMs: number;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private lastIndexedAt?: string;
  private stopped = false;

  constructor(private readonly options: UsageIndexerOptions) {
    this.repository = options.repository;
    this.roots = options.roots ?? defaultUsageRoots();
    this.intervalMs = options.intervalMs ?? 60_000;
  }

  get indexedAt(): string | undefined { return this.lastIndexedAt; }
  get indexing(): boolean { return this.running !== undefined; }

  rateLimits(): RateLimitSnapshot[] { return this.repository.getRateLimits(); }

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    // An in-flight pass notices this between files, before the store closes.
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Runs one pass, or joins the pass already in flight. Never rejects. */
  refresh(): Promise<void> {
    this.running ??= this.pass()
      .catch((error: unknown) => this.options.log?.('[agentdeck] usage indexing failed', error))
      .finally(() => { this.running = undefined; });
    return this.running;
  }

  private async pass(): Promise<void> {
    const cursors = this.repository.listFileCursors();
    const providers: [UsageProvider, string[]][] = [['claude', this.roots.claude], ['codex', this.roots.codex]];
    for (const [provider, roots] of providers) {
      for (const root of roots) {
        for (const file of await listJsonl(root)) {
          if (this.stopped) return;
          try {
            await this.scanFile(file, provider, cursors.get(file));
          } catch (error) {
            this.options.log?.(`[agentdeck] usage: skipped ${file}`, error);
          }
        }
      }
    }
    this.lastIndexedAt = new Date().toISOString();
    this.options.onIndexed?.();
  }

  private async scanFile(file: string, provider: UsageProvider, previous: UsageFileCursor | undefined): Promise<void> {
    const stat = await fsp.stat(file);
    if (previous && previous.size === stat.size && Math.floor(previous.mtimeMs) === Math.floor(stat.mtimeMs)) return;
    // A file that shrank was rewritten; start over (event keys dedupe re-reads).
    const resume = previous && stat.size >= previous.offset ? previous : undefined;
    let offset = resume?.offset ?? 0;
    let codexState = resume ? { sessionId: resume.sessionId, cwd: resume.cwd, model: resume.model, lastTotal: resume.lastTotal } : {};
    const events: UsageEvent[] = [];
    let rateLimits: RateLimitSnapshot | undefined;

    const handle = await fsp.open(file, 'r');
    try {
      let carry = Buffer.alloc(0);
      let position = offset;
      while (position < stat.size) {
        const length = Math.min(CHUNK_BYTES, stat.size - position);
        const chunk = Buffer.alloc(length);
        const { bytesRead } = await handle.read(chunk, 0, length, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
        const lastNewline = data.lastIndexOf(NEWLINE);
        if (lastNewline === -1) { carry = data; continue; }
        const lines = data.subarray(0, lastNewline).toString('utf8').split('\n');
        carry = data.subarray(lastNewline + 1);
        offset = position - carry.length;
        if (provider === 'claude') {
          events.push(...parseClaudeLines(lines, file));
        } else {
          const result = parseCodexLines(lines, file, codexState);
          events.push(...result.events);
          codexState = result.state;
          rateLimits = result.rateLimits ?? rateLimits;
        }
      }
    } finally {
      await handle.close();
    }

    this.repository.commitFileScan({
      path: file,
      provider,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      offset,
      ...(provider === 'codex' ? codexState : {}),
    }, events, rateLimits);
  }
}
