// Issue #81: the one provider path allowed to read personal content —
// Claude Code, confined by Seatbelt (decision 0003), offered only the
// filing broker's tools. Access is decided afresh for every Attempt by
// src/confinement/decision.ts against this Mac's recorded live evidence and
// the CLI version installed now; without a pass, no agent process starts.
//
// The confined process is given no grant folder at all: it reads document
// text only through the broker. Its init event's tool list is checked as it
// arrives, and the process is killed before its first tool call if anything
// other than broker tools is offered (0003, remaining risk 1).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultDataDir } from '../config.js';
import { buildConfinedLaunch, prepareConfinedState, type ConfinedCredential } from '../confinement/confined-launch.js';
import { decidePersonalResourceAccess, loadConfinementEvidence } from '../confinement/decision.js';
import { startEgressProxy } from '../confinement/egress-proxy.js';
import type { ConfinementProbeReport } from '../confinement/probe.js';
import { cliVersion, macosVersion } from '../confinement/probe.js';
import { interpretClaudeStream, type ProbeStatus } from '../provider-probe/interpret.js';
import { resolveAgentExecutable } from '../sessions/executable.js';
import { TRUSTED_RUNTIME_PROVIDER_DOMAINS } from '../work-engine/envelope.js';

export interface ConfinedProviderAccess {
  readonly mode: 'agent-confined';
  readonly runtime: 'claude';
  readonly executable: string;
  readonly cliVersion: string;
  readonly credential: ConfinedCredential;
}

export type FilingProviderAccess = ConfinedProviderAccess | { readonly mode: 'deterministic-only'; readonly reason: string };

export interface FilingAgentRequest {
  readonly access: ConfinedProviderAccess;
  readonly prompt: string;
  readonly broker: { readonly url: string; readonly port: number; readonly token: string };
  /** The MCP tool names the agent may be offered; anything else aborts the turn. */
  readonly allowedTools: readonly string[];
}

export interface FilingAgentTurn {
  readonly status: ProbeStatus | 'tool-surface';
  readonly reason: string;
  /** Tools the CLI reported offering the agent, from its init event. */
  readonly toolsOffered: readonly string[];
}

export interface FilingProvider {
  resolveAccess(): Promise<FilingProviderAccess>;
  runTurn(request: FilingAgentRequest): Promise<FilingAgentTurn>;
}

export interface ConfinedClaudeProviderOptions {
  readonly dataDir?: string;
  readonly home?: string;
  /** AgentDeck owns the deadline; the CLI keeps retrying offline for minutes (0001). */
  readonly timeoutMs?: number;
  /** Personal tasks pick a model explicitly rather than the plan default (0001). */
  readonly model?: string;
  /** Test seams. */
  readonly platform?: NodeJS.Platform;
  readonly findExecutable?: () => string | undefined;
  readonly readCliVersion?: (executable: string) => Promise<string>;
  readonly readMacosVersion?: () => Promise<string>;
  readonly loadEvidence?: () => ConfinementProbeReport | undefined;
}

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export function confinedClaudeProvider(options: ConfinedClaudeProviderOptions = {}): FilingProvider {
  const home = options.home ?? os.homedir();
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const model = options.model ?? 'sonnet';

  return {
    async resolveAccess() {
      const platform = options.platform ?? process.platform;
      if (platform !== 'darwin') return { mode: 'deterministic-only', reason: 'Agent confinement is only proven on macOS.' };
      const executable = (options.findExecutable ?? (() => resolveAgentExecutable('claude')))();
      if (!executable) return { mode: 'deterministic-only', reason: 'Claude Code is not installed on this Mac.' };
      const [version, macos] = await Promise.all([
        (options.readCliVersion ?? cliVersion)(executable),
        (options.readMacosVersion ?? macosVersion)(),
      ]);
      const decision = decidePersonalResourceAccess({
        platform,
        macosVersion: macos,
        arch: process.arch,
        runtime: 'claude',
        cliVersion: version,
        evidence: (options.loadEvidence ?? (() => loadConfinementEvidence('claude', options.dataDir ?? defaultDataDir())))(),
      });
      if (decision.mode === 'deterministic-only') return decision;
      if (decision.agentTools !== 'none') {
        return { mode: 'deterministic-only', reason: 'The recorded confinement probe offered the agent a process-spawning tool.' };
      }
      return { mode: 'agent-confined', runtime: 'claude', executable, cliVersion: version, credential: decision.credential };
    },

    async runTurn(request) {
      const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-personal-'));
      const proxy = await startEgressProxy({ allowedDomains: TRUSTED_RUNTIME_PROVIDER_DOMAINS.claude });
      try {
        const state = prepareConfinedState(stateRoot);
        const mcpConfig = path.join(state.root, 'mcp.json');
        fs.writeFileSync(mcpConfig, JSON.stringify({
          mcpServers: { agentdeck: { type: 'http', url: request.broker.url, headers: { Authorization: `Bearer ${request.broker.token}` } } },
        }), { mode: 0o600 });
        const launch = buildConfinedLaunch({
          runtime: 'claude',
          executable: request.access.executable,
          args: [
            '-p', request.prompt, '--model', model,
            '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', mcpConfig,
            '--allowedTools', request.allowedTools.join(','), '--no-session-persistence',
            '--verbose', '--output-format', 'stream-json',
          ],
          state,
          // The agent reads documents only through the broker.
          grantedReadRoots: [],
          proxyPort: proxy.port,
          brokerPort: request.broker.port,
          hostEnv: process.env,
          home,
          credential: request.access.credential,
        });
        return await runStreaming(launch.command, launch.args, launch.env, launch.cwd, timeoutMs, request.allowedTools);
      } finally {
        await proxy.close();
        fs.rmSync(stateRoot, { recursive: true, force: true });
      }
    },
  };
}

function runStreaming(
  command: string, args: readonly string[], env: Record<string, string>, cwd: string, timeoutMs: number, allowedTools: readonly string[],
): Promise<FilingAgentTurn> {
  return new Promise((resolve) => {
    let toolsOffered: string[] = [];
    let toolViolation = false;
    let timedOut = false;
    let stdout = '';
    let pending = '';
    // Its own process group, so a kill also reaches any child still holding stdout.
    const child = spawn(command, args, { env, cwd, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    const kill = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch { /* already gone */ }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);

    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk;
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (!line.startsWith('{')) continue;
        let event: Record<string, unknown>;
        try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        if (event.type === 'system' && event.subtype === 'init') {
          toolsOffered = Array.isArray(event.tools) ? event.tools.filter((tool): tool is string => typeof tool === 'string') : [];
          if (toolsOffered.some((tool) => !allowedTools.includes(tool))) {
            toolViolation = true;
            kill();
          }
        }
      }
    });
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      if (toolViolation) {
        resolve({ status: 'tool-surface', reason: `The provider offered tools beyond AgentDeck's broker (${toolsOffered.join(', ')}).`, toolsOffered });
        return;
      }
      const outcome = interpretClaudeStream(stdout, { code, signal });
      const reason = timedOut && outcome.status !== 'ok' ? `No result within ${Math.round(timeoutMs / 1000)} seconds.` : outcome.reason;
      resolve({ status: outcome.status, reason, toolsOffered });
    };
    child.on('error', () => finish(null, null));
    // A child forked just as the group was signalled can escape that signal
    // and keep stdout open, so the group is signalled again once the CLI
    // exits, and stdout is closed shortly after regardless.
    child.on('exit', () => {
      kill();
      setTimeout(() => child.stdout.destroy(), 1000).unref();
    });
    child.on('close', finish);
  });
}
