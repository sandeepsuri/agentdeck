import type { AgentType } from '../types.js';

export interface PsRow {
  pid: number;
  ppid: number;
  tty: string;
  state: string;
  cpu: number;
  startedAt: string;
  startEpoch: number;
  command: string;
}

export interface AgentProcess extends PsRow {
  agent: AgentType;
}

// macOS localizes lstart's month/day order (for example en_US uses
// "Sat May 16" while en_CA uses "Sat 16 May"). Capture its five tokens
// without assuming either order and let Date validate the value.
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+([\d.]+)\s+(\S+\s+\S+\s+\S+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/;
const AGENT_COMMAND = /(?:^|[\s/])(claude|codex)(?=\s|$)/i;

export function parsePs(output: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of output.split('\n')) {
    const match = PS_LINE.exec(line);
    if (!match) continue;
    const [, pidText, ppidText, tty, state, cpuText, startedAt, command] = match;
    if (!pidText || !ppidText || !tty || !state || !cpuText || !startedAt || !command) continue;
    const timestamp = new Date(startedAt).getTime();
    if (!Number.isFinite(timestamp)) continue;
    rows.push({
      pid: Number(pidText),
      ppid: Number(ppidText),
      tty,
      state,
      cpu: Number(cpuText),
      startedAt,
      startEpoch: Math.floor(timestamp / 1000),
      command,
    });
  }
  return rows;
}

function agentFor(command: string): AgentType | undefined {
  const match = AGENT_COMMAND.exec(command);
  const value = match?.[1]?.toLowerCase();
  return value === 'claude' || value === 'codex' ? value : undefined;
}

function isNoise(process: AgentProcess): boolean {
  return process.tty === '??'
    || /\/Applications\/[^/]+\.app\//.test(process.command)
    || /\/\.vscode\/extensions\//.test(process.command)
    || /(?:^|[\s/])codex(?=\s|$).*\b(?:app-server|sandbox)\b/i.test(process.command)
    || /\badk_/.test(process.command);
}

export function findAgentProcesses(rows: PsRow[], managedPids: ReadonlySet<number>): AgentProcess[] {
  const matches = rows.flatMap((row) => {
    const agent = agentFor(row.command);
    return agent ? [{ ...row, agent }] : [];
  });
  const matchingPids = new Set(matches.map((process) => process.pid));
  return matches.filter((process) =>
    !matchingPids.has(process.ppid)
    && !managedPids.has(process.pid)
    && !isNoise(process));
}

export function parseLsofCwd(output: string): string | undefined {
  const line = output.split('\n').find((candidate) => candidate.startsWith('n'));
  return line && line.length > 1 ? line.slice(1) : undefined;
}
