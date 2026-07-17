import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Store } from '../store/index.js';
import type { Session } from '../types.js';
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
  const { stdout } = await execFileAsync(file, args, { encoding: 'utf8', timeout: 10_000 });
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
  private interval?: NodeJS.Timeout;
  private polling = false;
  private hotSamples = new Map<string, number>();
  private readonly run: CommandRunner;
  private readonly resolveGit: (cwd: string) => Promise<GitResolution>;

  constructor(private options: DiscoveryPollerOptions) {
    this.run = options.run ?? runCommand;
    this.resolveGit = options.resolveGit ?? resolveGitDefault;
  }

  start(): void {
    if (this.interval) return;
    this.pollSafely();
    this.interval = setInterval(() => this.pollSafely(), this.options.intervalMs ?? 5000);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
  }

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const psOutput = await this.run('ps', [
        'axo',
        'pid=,ppid=,tty=,state=,%cpu=,lstart=,command=',
      ]);
      const processes = findAgentProcesses(parsePs(psOutput), this.options.getManagedPids());
      await this.options.terminals?.refresh();
      const seen = new Set<string>();
      const now = new Date().toISOString();

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
      }

      // A closed terminal means the session is gone — remove its row so it
      // disappears from the dashboard.
      for (const session of this.options.store.listSessions()) {
        if (session.origin !== 'external' || seen.has(session.id)) continue;
        this.hotSamples.delete(session.id);
        this.options.store.deleteSession(session.id);
        this.options.remove(session.id);
      }
    } finally {
      this.polling = false;
    }
  }

  private saveAndPublish(session: Session): void {
    this.options.store.upsertSession(session);
    this.options.publish(session);
  }

  private pollSafely(): void {
    void this.poll().catch((error) => {
      console.warn(`[agentdeck] discovery poll failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}
