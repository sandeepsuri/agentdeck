import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Store } from '../store/index.js';
import type { DiscoveryStatus, Session } from '../types.js';
import { findAgentProcesses, parseLsofCwd, parsePs } from './ps.js';
import type { TerminalRegistry } from './terminals/index.js';
import { reduceStatus } from '../sessions/status.js';

const execFileAsync = promisify(execFile);

export type CommandRunner = (file: string, args: string[]) => Promise<string>;

export interface GitResolution {
  repoId?: string;
  repoPath?: string;
  branch?: string;
}

export interface DiscoveryPollerOptions {
  store: Store;
  getManagedPids: () => ReadonlySet<number>;
  publish: (session: Session) => void;
  remove: (sessionId: string) => void;
  intervalMs?: number;
  run?: CommandRunner;
  resolveGit?: (cwd: string) => Promise<GitResolution>;
  terminals?: TerminalRegistry;
}

async function runCommand(file: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(file, args, {
    encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
  });
  return stdout;
}

async function resolveGitDefault(cwd: string): Promise<GitResolution> {
  let repoPath: string;
  try {
    repoPath = (await runCommand('git', ['-C', cwd, 'rev-parse', '--show-toplevel'])).trim();
  } catch {
    return {};
  }
  try {
    const branch = (await runCommand('git', ['-C', cwd, 'symbolic-ref', '--short', 'HEAD'])).trim();
    return { repoId: repoPath, repoPath, branch };
  } catch {
    return { repoId: repoPath, repoPath };
  }
}

export class DiscoveryPoller {
  private timer?: NodeJS.Timeout;
  private running = false;
  private generation = 0;
  private polling = false;
  private inFlight?: Promise<void>;
  private hotSamples = new Map<string, number>();
  private health: DiscoveryStatus = {
    running: false,
    polling: false,
    scannedProcesses: 0,
    managedPids: 0,
    detectedProcesses: 0,
    publishedSessions: 0,
  };
  private readonly run: CommandRunner;
  private readonly resolveGit: (cwd: string) => Promise<GitResolution>;

  constructor(private options: DiscoveryPollerOptions) {
    this.run = options.run ?? runCommand;
    this.resolveGit = options.resolveGit ?? resolveGitDefault;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const generation = ++this.generation;
    this.health.running = true;
    void this.runScheduled(generation);
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    this.health.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  async poll(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const cycle = this.pollOnce();
    this.inFlight = cycle;
    try {
      await cycle;
    } finally {
      if (this.inFlight === cycle) this.inFlight = undefined;
    }
  }

  status(): DiscoveryStatus {
    return { ...this.health, running: this.running, polling: this.polling };
  }

  private async pollOnce(): Promise<void> {
    this.polling = true;
    this.health.polling = true;
    this.health.lastStartedAt = new Date().toISOString();
    try {
      const psOutput = await this.run('ps', [
        'axo',
        'pid=,ppid=,tty=,state=,%cpu=,lstart=,command=',
      ]);
      const rows = parsePs(psOutput);
      const managedPids = this.options.getManagedPids();
      const processes = findAgentProcesses(rows, managedPids);
      this.health.scannedProcesses = rows.length;
      this.health.managedPids = managedPids.size;
      this.health.detectedProcesses = processes.length;
      const seen = new Set<string>();
      const now = new Date().toISOString();
      let published = 0;

      for (const process of processes) {
        const id = `ext-${process.pid}-${process.startEpoch}`;
        seen.add(id);
        const previous = this.options.store.getSession(id);
        let cwd = previous?.cwd;
        if (!cwd) {
          try {
            cwd = parseLsofCwd(await this.run('lsof', ['-a', '-p', String(process.pid), '-d', 'cwd', '-Fn']));
          } catch {
            continue;
          }
        }
        if (!cwd) continue;

        const git = previous?.repoId || previous?.branch
          ? { repoId: previous.repoId, repoPath: previous.worktreePath, branch: previous.branch }
          : await this.resolveGit(cwd);
        const hotCount = process.cpu > 3 ? (this.hotSamples.get(id) ?? 0) + 1 : 0;
        this.hotSamples.set(id, hotCount);
        const result = reduceStatus({
          alive: true,
          now: Date.now(),
          hook: previous?.statusSource === 'hook'
            ? { status: previous.status, at: Date.parse(previous.lastActivityAt) }
            : undefined,
          cpu: { percent: process.cpu, sustained: hotCount >= 2 },
        });
        const working = result.status === 'working';
        const startedAt = new Date(process.startEpoch * 1000).toISOString();
        const session: Session = {
          ...previous,
          id,
          origin: 'external',
          agent: process.agent,
          cwd,
          pid: process.pid,
          tty: process.tty,
          startedAt,
          lastActivityAt: working ? now : (previous?.lastActivityAt ?? startedAt),
          status: result.status,
          statusSource: result.statusSource,
          terminalApp: previous?.terminalApp ?? 'unknown',
        };
        if (git.repoId) session.repoId = git.repoId;
        if (git.repoPath && git.repoPath !== cwd) session.worktreePath = git.repoPath;
        if (git.branch) session.branch = git.branch;
        const terminal = this.options.terminals?.lookup(process.tty);
        if (terminal) {
          session.terminalApp = terminal.terminalApp;
          session.terminalRef = terminal.terminalRef;
        } else {
          session.terminalApp = 'unknown';
          delete session.terminalRef;
        }
        this.saveAndPublish(session);
        published += 1;
      }

      // A closed terminal means the session is gone — remove its row so it
      // disappears from the dashboard.
      for (const session of this.options.store.listSessions()) {
        if (session.origin !== 'external' || seen.has(session.id)) continue;
        this.hotSamples.delete(session.id);
        this.options.store.deleteSession(session.id);
        this.options.remove(session.id);
      }

      // Terminal automation enriches already-visible sessions. A slow or
      // unavailable adapter must never prevent process discovery itself.
      if (this.options.terminals) {
        await this.options.terminals.refresh();
        for (const process of processes) {
          const id = `ext-${process.pid}-${process.startEpoch}`;
          const session = this.options.store.getSession(id);
          if (!session) continue;
          const terminal = this.options.terminals.lookup(process.tty);
          const previousApp = session.terminalApp;
          const previousRef = JSON.stringify(session.terminalRef);
          if (terminal) {
            session.terminalApp = terminal.terminalApp;
            session.terminalRef = terminal.terminalRef;
          } else {
            session.terminalApp = 'unknown';
            delete session.terminalRef;
          }
          if (previousApp !== session.terminalApp || previousRef !== JSON.stringify(session.terminalRef)) {
            this.saveAndPublish(session);
          }
        }
      }
      this.health.publishedSessions = published;
      this.health.lastCompletedAt = new Date().toISOString();
      delete this.health.lastError;
    } catch (error) {
      this.health.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.polling = false;
      this.health.polling = false;
    }
  }

  private saveAndPublish(session: Session): void {
    this.options.store.upsertSession(session);
    this.options.publish(session);
  }

  private async runScheduled(generation: number): Promise<void> {
    try {
      await this.poll();
    } catch (error) {
      console.warn(`[agentdeck] discovery poll failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (this.running && generation === this.generation) {
        this.timer = setTimeout(() => void this.runScheduled(generation), this.options.intervalMs ?? 5000);
      }
    }
  }
}
