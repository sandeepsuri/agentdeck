// REST routes (T4): session CRUD/lifecycle. Terminal I/O goes over /ws.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import type { AgentDeckConfig } from '../config.js';
import { expandTilde, saveConfig as saveConfigFile } from '../config.js';
import { DEFAULT_MODEL_SETTING_KEY, type ModelCatalog } from '../sessions/model-catalog.js';
import { checkoutBranch, scanRepos, git } from '../git/scan.js';
import { diffFile, diffSummary, resolveRepoFile, type DiffMode } from '../git/diff.js';
import {
  gitPublishService, MAX_COMMIT_SUBJECT_LENGTH, MAX_PR_TITLE_LENGTH,
  MAX_PUBLISH_BODY_LENGTH, type GitPublishService,
} from '../git/publish.js';
import type { SessionManager } from '../sessions/manager.js';
import { resolveAgentExecutable } from '../sessions/executable.js';
import {
  createRuntimeReadinessSource,
  publicRuntimeReadinessReport,
  type RuntimeReadinessSource,
} from '../sessions/runtime-readiness.js';
import type { Store } from '../store/index.js';
import { AutomationDeniedError, type TerminalRegistry } from '../discovery/terminals/index.js';
import type { AgentType, LaunchSpec } from '../types.js';
import type { CoordinationService } from '../coordination/service.js';
import { deriveClaims } from '../coordination/status.js';
import { deriveAttentionItems, deriveCompanionAgents } from '../attention.js';
import os from 'node:os';
import path from 'node:path';
import { installClaudeHooks, installCodexHooks, uninstallClaudeHooks, uninstallCodexHooks } from '../hooks/install.js';
import { deriveConflicts } from '../conflicts/derive.js';
import { appendAgentMessage, appendInboxMessage, parseBusLines } from '../coordination/bus.js';
import type { VsCodeBridge } from '../discovery/terminals/vscode.js';
import type { DiscoveryPoller } from '../discovery/poller.js';
import { publicSession } from './security.js';
import { classify, TOKEN_HEADER } from './connection-trust.js';
import { containsDisallowedControlBytes } from './remote-input.js';

const HOOK_PATH = path.resolve(import.meta.dirname, '../../bin/agentdeck-hook.mjs');
const VSCODE_VSIX_PATH = path.resolve(import.meta.dirname, '../../dist/vscode/agentdeck-vscode-0.1.0.vsix');
const MESSAGE_TAIL_BYTES = 512 * 1024;
const MAX_NAME_LENGTH = 200;
const MAX_PATH_LENGTH = 4096;
const MAX_BRANCH_LENGTH = 1024;
const MAX_PROMPT_LENGTH = 256 * 1024;
const MAX_MESSAGE_LENGTH = 64 * 1024;
const MAX_EXTRA_ARGS = 100;
const MAX_EXTRA_ARG_LENGTH = 16 * 1024;
const MAX_ENV_VARS = 100;
const MAX_ENV_VALUE_LENGTH = 64 * 1024;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_MODEL_ID_LENGTH = 200;
const MAX_API_KEY_LENGTH = 4096;
const execFileAsync = promisify(execFile);

async function readBusTail(repoPath: string) {
  const file = path.join(repoPath, '.agents', 'bus.jsonl');
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(file, 'r');
    const stat = await handle.stat();
    const length = Math.min(stat.size, MESSAGE_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, stat.size - length);
    return parseBusLines(buffer.subarray(0, bytesRead).toString('utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  } finally {
    await handle?.close();
  }
}

function repoHasClaudeHooks(repoPath: string): boolean {
  try {
    return fs.readFileSync(path.join(repoPath, '.claude', 'settings.json'), 'utf8').includes('agentdeck-hook');
  } catch {
    return false;
  }
}

function userHasCodexHooks(): boolean {
  try {
    return fs.readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8').includes('agentdeck-hook');
  } catch {
    return false;
  }
}

function parseRepoPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LENGTH) return undefined;
  const repoPath = expandTilde(value);
  try {
    return fs.statSync(repoPath).isDirectory() && fs.existsSync(path.join(repoPath, '.git'))
      ? repoPath
      : undefined;
  } catch {
    return undefined;
  }
}

async function resolveVsCodeCli(): Promise<string | undefined> {
  const configured = process.env.AGENTDECK_VSCODE_CLI;
  if (configured && fs.existsSync(configured)) return configured;
  try {
    const { stdout } = await execFileAsync('/usr/bin/which', ['code'], { encoding: 'utf8', timeout: 5000 });
    const found = stdout.trim();
    if (found) return found;
  } catch { /* fall through to standard application paths */ }
  return [
    '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
    '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code',
  ].find((candidate) => fs.existsSync(candidate));
}

export interface VsCodeInstallResult {
  installed: true;
  reloadRequired: true;
}

export async function installVsCodeExtension(): Promise<VsCodeInstallResult> {
  if (!fs.existsSync(VSCODE_VSIX_PATH)) {
    throw new Error('The bundled VS Code helper is missing. Run npm run build and try again.');
  }
  const cli = await resolveVsCodeCli();
  if (!cli) throw new Error('VS Code CLI was not found. Install VS Code or add the code command to PATH.');
  await execFileAsync(cli, ['--install-extension', VSCODE_VSIX_PATH, '--force'], {
    encoding: 'utf8', timeout: 30_000,
  });
  return { installed: true, reloadRequired: true };
}

function parseLaunchSpec(body: unknown): LaunchSpec | string {
  if (typeof body !== 'object' || body === null) return 'body must be a JSON object';
  const b = body as Record<string, unknown>;
  if (b.agent !== 'claude' && b.agent !== 'codex') return 'agent must be "claude" or "codex"';
  if (typeof b.cwd !== 'string' || b.cwd === '') return 'cwd is required';
  if (b.cwd.length > MAX_PATH_LENGTH) return 'cwd is too long';
  const cwd = expandTilde(b.cwd);
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    return `cwd is not a directory: ${cwd}`;
  }
  const spec: LaunchSpec = { agent: b.agent as AgentType, cwd };
  if (b.initialPrompt !== undefined && typeof b.initialPrompt !== 'string') return 'initialPrompt must be a string';
  if (typeof b.initialPrompt === 'string' && b.initialPrompt.length > MAX_PROMPT_LENGTH) return 'initialPrompt is too long';
  if (typeof b.initialPrompt === 'string' && b.initialPrompt !== '') spec.initialPrompt = b.initialPrompt;
  if (b.permissionMode !== undefined) {
    if (b.permissionMode !== 'default' && b.permissionMode !== 'acceptEdits' && b.permissionMode !== 'plan') {
      return 'permissionMode must be "default", "acceptEdits", or "plan"';
    }
    spec.permissionMode = b.permissionMode;
  }
  if (b.name !== undefined && typeof b.name !== 'string') return 'name must be a string';
  if (typeof b.name === 'string' && b.name.length > MAX_NAME_LENGTH) return 'name is too long';
  if (typeof b.name === 'string' && b.name !== '') spec.name = b.name;
  if (b.branch !== undefined && typeof b.branch !== 'string') return 'branch must be a string';
  if (typeof b.branch === 'string' && b.branch.length > MAX_BRANCH_LENGTH) return 'branch is too long';
  if (typeof b.branch === 'string' && b.branch !== '') spec.branch = b.branch;
  if (b.createBranchIfMissing !== undefined && typeof b.createBranchIfMissing !== 'boolean') {
    return 'createBranchIfMissing must be a boolean';
  }
  if (b.createBranchIfMissing === true) {
    if (!spec.branch) return 'createBranchIfMissing requires a branch';
    spec.createBranchIfMissing = true;
  }
  if (b.extraArgs !== undefined) {
    if (!Array.isArray(b.extraArgs) || b.extraArgs.length > MAX_EXTRA_ARGS
      || !b.extraArgs.every((arg) => typeof arg === 'string' && arg.length <= MAX_EXTRA_ARG_LENGTH)) {
      return 'extraArgs must contain at most 100 bounded strings';
    }
    spec.extraArgs = b.extraArgs as string[];
  }
  if (b.env !== undefined) {
    if (typeof b.env !== 'object' || b.env === null || Array.isArray(b.env)) {
      return 'env must be an object';
    }
    const entries = Object.entries(b.env as Record<string, unknown>);
    if (entries.length > MAX_ENV_VARS) return 'env contains too many variables';
    const env: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [k, v] of entries) {
      if (!ENV_NAME.test(k)) return `invalid environment variable name: ${k}`;
      if (typeof v !== 'string') return `environment variable ${k} must be a string`;
      if (v.length > MAX_ENV_VALUE_LENGTH) return `environment variable ${k} is too long`;
      env[k] = v;
    }
    spec.env = env;
  }
  return spec;
}

export interface RouteContext {
  manager: SessionManager;
  config: AgentDeckConfig;
  store?: Store;
  terminals?: TerminalRegistry;
  coordination?: CoordinationService;
  vscode?: VsCodeBridge;
  discovery?: DiscoveryPoller;
  installVsCode?: () => Promise<VsCodeInstallResult>;
  publish?: GitPublishService;
  /** Ticket 12: the runtime-fetched, allowlist-filtered, cached model catalog. Undefined only in tests that don't exercise it — GET /api/models degrades to an empty list rather than erroring. */
  modelCatalog?: ModelCatalog;
  /** Capability-only probe used by GET /api/runtime-readiness. It never starts a managed Run. */
  runtimeReadiness?: RuntimeReadinessSource;
  /** Injectable for tests, like installVsCode above — defaults to the real config.json writer (owner-only 0600 file). Never routed through Store; the API key must never reach SQLite. */
  saveConfig?: (patch: Partial<AgentDeckConfig>) => void;
  /** Ticket 05: the detected Tailscale hostname and IP, feeding classify() for GET /api/connection. Empty/undefined when no tailnet interface was found. */
  remoteHosts?: readonly string[];
}

export function registerRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { manager } = ctx;
  const runtimeReadiness = ctx.runtimeReadiness ?? createRuntimeReadinessSource();
  const requestTrust = (req: FastifyRequest) => classify(
    {
      host: req.headers.host,
      origin: req.headers.origin,
      token: req.headers[TOKEN_HEADER] as string | undefined,
    },
    { remoteHosts: ctx.remoteHosts, token: ctx.config.tailscaleToken },
  );

  // Ticket 05: how the client discovers "you're remote, please enter a
  // token" in the first place. Deliberately exempt from the token gate in
  // app.ts's onRequest hook (see the comment there) — it never returns
  // anything sensitive, only the classification a phone needs to decide
  // whether to show the token-entry screen.
  app.get('/api/connection', async (req) => {
    const trust = requestTrust(req);
    return { kind: trust.kind, capabilities: [...trust.capabilities] };
  });

  app.get('/api/runtime-readiness', async () => publicRuntimeReadinessReport(await runtimeReadiness.get()));

  app.get('/api/sessions', async (req) => {
    const sessions = manager.listSessions();
    return (requestTrust(req).kind === 'remote'
      ? sessions.filter((session) => session.origin === 'managed')
      : sessions).map(publicSession);
  });
  app.get('/api/companion', async () => {
    const sessions = manager.listSessions().map(publicSession);
    const events = ctx.store?.listEvents({ limit: 1000 }) ?? [];
    const attention = deriveAttentionItems(sessions, events);
    return {
      sessions,
      attention,
      agents: deriveCompanionAgents(sessions, events, attention),
      uiVisible: false,
    };
  });

  // Ticket 12: the summary model picker's data source. ModelCatalog itself
  // owns the runtime fetch, allowlist filter, and cache; this route is a
  // thin pass-through so a new provider never needs a route change.
  app.get('/api/models', async () => ctx.modelCatalog ? ctx.modelCatalog.list() : []);

  // Ticket 12 settings: the default summary model (store.setSetting, a
  // plain app setting) and the OpenAI API key (config.json at 0600, never
  // SQLite). GET never echoes the key — only whether one is configured.
  app.get('/api/settings', async () => ({
    defaultModel: ctx.store?.getSetting<string>(DEFAULT_MODEL_SETTING_KEY),
    openaiKeyConfigured: Boolean(ctx.config.openaiApiKey),
  }));

  app.patch('/api/settings', async (req, reply) => {
    if (typeof req.body !== 'object' || req.body === null) {
      return reply.code(400).send({ error: 'body must be a JSON object' });
    }
    const { defaultModel, openaiApiKey } = req.body as { defaultModel?: unknown; openaiApiKey?: unknown };
    if (defaultModel !== undefined) {
      if (typeof defaultModel !== 'string' || defaultModel.length === 0 || defaultModel.length > MAX_MODEL_ID_LENGTH) {
        return reply.code(400).send({ error: 'defaultModel must be a non-empty string' });
      }
      ctx.store?.setSetting(DEFAULT_MODEL_SETTING_KEY, defaultModel);
    }
    if (openaiApiKey !== undefined) {
      if (openaiApiKey !== null && typeof openaiApiKey !== 'string') {
        return reply.code(400).send({ error: 'openaiApiKey must be a string or null' });
      }
      if (typeof openaiApiKey === 'string' && openaiApiKey.length > MAX_API_KEY_LENGTH) {
        return reply.code(400).send({ error: 'openaiApiKey is too long' });
      }
      // Empty string or null clears the key. Never logged, never included
      // in this or any other response body — only the presence boolean is.
      const trimmed = typeof openaiApiKey === 'string' ? openaiApiKey.trim() : '';
      const value = trimmed.length > 0 ? trimmed : undefined;
      ctx.config.openaiApiKey = value;
      try {
        (ctx.saveConfig ?? saveConfigFile)({ openaiApiKey: value });
      } catch (error) {
        return reply.code(400).send({ error: `Failed to save settings: ${error instanceof Error ? error.message : String(error)}` });
      }
      // A newly-configured (or cleared) key changes what OpenAI's model
      // source can report — don't make the picker wait out the cache TTL.
      ctx.modelCatalog?.invalidate();
    }
    return {
      ok: true,
      defaultModel: ctx.store?.getSetting<string>(DEFAULT_MODEL_SETTING_KEY),
      openaiKeyConfigured: Boolean(ctx.config.openaiApiKey),
    };
  });

  app.get('/api/discovery/status', async () => ctx.discovery?.status() ?? {
    running: false, polling: false, scannedProcesses: 0, managedPids: 0,
    detectedProcesses: 0, publishedSessions: 0,
  });

  app.post('/api/discovery/refresh', async (_req, reply) => {
    if (!ctx.discovery) return reply.code(503).send({ error: 'discovery is unavailable' });
    try {
      await ctx.discovery.poll();
      return ctx.discovery.status();
    } catch {
      return reply.code(503).send(ctx.discovery.status());
    }
  });

  app.patch('/api/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (typeof req.body !== 'object' || req.body === null) {
      return reply.code(400).send({ error: 'body must be a JSON object' });
    }
    const { name } = req.body as { name?: unknown };
    if (name !== undefined && typeof name !== 'string') {
      return reply.code(400).send({ error: 'name must be a string' });
    }
    if (typeof name === 'string' && name.length > MAX_NAME_LENGTH) {
      return reply.code(400).send({ error: 'name is too long' });
    }
    const session = manager.renameSession(id, name?.trim() || undefined);
    return session ? publicSession(session) : reply.code(404).send({ error: 'no such session' });
  });

  app.get('/api/repos', async () => {
    if (!ctx.store) return [];
    try {
      const repos = await scanRepos(ctx.config.projectsDir, ctx.store);
      await ctx.coordination?.syncRepos(repos);
      return repos;
    } catch {
      return ctx.store.listRepos();
    }
  });

  app.post('/api/launch/preflight', async (req, reply) => {
    const body = req.body as { agent?: unknown; cwd?: unknown; branch?: unknown; createBranchIfMissing?: unknown } | null;
    const agent = body?.agent;
    const cwdValue = body?.cwd;
    const branch = typeof body?.branch === 'string' ? body.branch.trim() : '';
    const checks: { label: string; ok: boolean; detail?: string }[] = [];
    const cwd = typeof cwdValue === 'string' && cwdValue.length <= MAX_PATH_LENGTH ? expandTilde(cwdValue) : '';
    const directoryOk = Boolean(cwd) && fs.existsSync(cwd) && fs.statSync(cwd).isDirectory();
    checks.push({ label: 'Working directory found', ok: directoryOk, ...(!directoryOk ? { detail: 'Choose an existing directory.' } : {}) });
    const gitRepo = directoryOk && fs.existsSync(path.join(cwd, '.git'));
    checks.push({ label: 'Repository available', ok: gitRepo || !branch, ...(!gitRepo && branch ? { detail: 'A branch requires a Git repository.' } : {}) });
    let branchOk = !branch;
    if (directoryOk && gitRepo && branch) {
      try {
        await git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
        branchOk = true;
      } catch {
        branchOk = body?.createBranchIfMissing === true;
      }
    }
    checks.push({ label: branch ? 'Branch available' : 'Keep current branch', ok: branchOk, ...(!branchOk ? { detail: 'Enable “Create branch if missing” or choose an existing branch.' } : {}) });
    const executable = agent === 'claude' || agent === 'codex' ? agent : '';
    const cliPath = executable ? resolveAgentExecutable(executable) : undefined;
    const cliOk = Boolean(cliPath);
    checks.push({ label: `${agent === 'codex' ? 'Codex' : 'Claude'} CLI detected`, ok: cliOk, ...(!cliOk ? { detail: `${executable || 'Agent'} could not be resolved from PATH or common install locations.` } : {}) });
    checks.push({ label: 'PTY engine available', ok: true });
    return reply.send({ ready: checks.every((check) => check.ok), checks });
  });

  // Only paths already known to the repo store may be diffed — never run git
  // against an arbitrary request-supplied directory.
  const knownRepoPath = (repo: string | undefined): string | undefined => {
    if (!repo || repo.length > MAX_PATH_LENGTH || !ctx.store) return undefined;
    const repos = ctx.store.listRepos();
    if (repos.some((item) => item.id === repo)) return repo;
    return repos.some((item) => item.worktrees?.some((worktree) => worktree.path === repo))
      ? repo
      : undefined;
  };

  const parseDiffMode = (mode: string | undefined): DiffMode | undefined =>
    mode === undefined || mode === 'uncommitted' ? 'uncommitted' : mode === 'branch' ? 'branch' : undefined;

  app.get('/api/repos/diff', async (req, reply) => {
    const { repo, mode } = req.query as { repo?: string; mode?: string };
    const repoPath = knownRepoPath(repo);
    if (!repoPath) return reply.code(404).send({ error: 'no such repo' });
    const diffMode = parseDiffMode(mode);
    if (!diffMode) return reply.code(400).send({ error: 'mode must be "uncommitted" or "branch"' });
    try {
      return await diffSummary(repoPath, diffMode);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/repos/diff/file', async (req, reply) => {
    const { repo, mode, path: filePath, ignoreWhitespace } = req.query as { repo?: string; mode?: string; path?: string; ignoreWhitespace?: string };
    const repoPath = knownRepoPath(repo);
    if (!repoPath) return reply.code(404).send({ error: 'no such repo' });
    const diffMode = parseDiffMode(mode);
    if (!diffMode) return reply.code(400).send({ error: 'mode must be "uncommitted" or "branch"' });
    if (typeof filePath !== 'string' || filePath === '' || filePath.length > MAX_PATH_LENGTH) {
      return reply.code(400).send({ error: 'path is required' });
    }
    try {
      return await diffFile(repoPath, filePath, diffMode, ignoreWhitespace === 'true');
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/repos/file-action', async (req, reply) => {
    const body = req.body as { repo?: unknown; path?: unknown; action?: unknown } | null;
    const repoPath = knownRepoPath(typeof body?.repo === 'string' ? body.repo : undefined);
    if (!repoPath) return reply.code(404).send({ error: 'no such repo' });
    if (typeof body?.path !== 'string' || body.path.length === 0 || body.path.length > MAX_PATH_LENGTH) {
      return reply.code(400).send({ error: 'path is required' });
    }
    const resolvedFile = resolveRepoFile(repoPath, body.path);
    if (!resolvedFile) return reply.code(400).send({ error: 'path is outside the repository' });
    if (body.action !== 'stage' && body.action !== 'unstage' && body.action !== 'discard') {
      return reply.code(400).send({ error: 'action must be stage, unstage, or discard' });
    }
    try {
      if (body.action === 'stage') await git(repoPath, ['add', '--', body.path]);
      if (body.action === 'unstage') await git(repoPath, ['reset', '--', body.path]);
      if (body.action === 'discard') {
        const status = await git(repoPath, ['status', '--porcelain', '--', body.path]);
        if (status.startsWith('??')) await fs.promises.unlink(resolvedFile);
        else {
          await git(repoPath, ['reset', '--', body.path]);
          await git(repoPath, ['checkout', '--', body.path]);
        }
      }
      return { ok: true };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/repos/publish-status', async (req, reply) => {
    const { repo } = req.query as { repo?: string };
    const repoPath = knownRepoPath(repo);
    if (!repoPath) return reply.code(404).send({ error: 'no such repo' });
    try {
      return await (ctx.publish ?? gitPublishService).status(repoPath);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/repos/commit', async (req, reply) => {
    const body = req.body as { repo?: unknown; subject?: unknown; body?: unknown } | null;
    const repoPath = knownRepoPath(typeof body?.repo === 'string' ? body.repo : undefined);
    if (!repoPath) return reply.code(404).send({ error: 'no such repo' });
    if (typeof body?.subject !== 'string' || body.subject.trim().length === 0) {
      return reply.code(400).send({ error: 'commit subject is required' });
    }
    if (body.subject.trim().length > MAX_COMMIT_SUBJECT_LENGTH) {
      return reply.code(400).send({ error: `commit subject must be ${MAX_COMMIT_SUBJECT_LENGTH} characters or fewer` });
    }
    if (body.body !== undefined && typeof body.body !== 'string') {
      return reply.code(400).send({ error: 'commit body must be a string' });
    }
    if (typeof body.body === 'string' && body.body.length > MAX_PUBLISH_BODY_LENGTH) {
      return reply.code(400).send({ error: 'commit body is too long' });
    }
    try {
      return await (ctx.publish ?? gitPublishService).commit(repoPath, body.subject, body.body as string | undefined);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/repos/push', async (req, reply) => {
    const body = req.body as { repo?: unknown } | null;
    const repoPath = knownRepoPath(typeof body?.repo === 'string' ? body.repo : undefined);
    if (!repoPath) return reply.code(404).send({ error: 'no such repo' });
    try {
      return await (ctx.publish ?? gitPublishService).push(repoPath);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/repos/pull-request', async (req, reply) => {
    const body = req.body as { repo?: unknown; base?: unknown; title?: unknown; body?: unknown; draft?: unknown } | null;
    const repoPath = knownRepoPath(typeof body?.repo === 'string' ? body.repo : undefined);
    if (!repoPath) return reply.code(404).send({ error: 'no such repo' });
    if (typeof body?.base !== 'string' || body.base.trim().length === 0 || body.base.length > MAX_BRANCH_LENGTH) {
      return reply.code(400).send({ error: 'base branch is required' });
    }
    if (typeof body.title !== 'string' || body.title.trim().length === 0) {
      return reply.code(400).send({ error: 'pull request title is required' });
    }
    if (body.title.trim().length > MAX_PR_TITLE_LENGTH) {
      return reply.code(400).send({ error: `pull request title must be ${MAX_PR_TITLE_LENGTH} characters or fewer` });
    }
    if (typeof body.body !== 'string' || body.body.length > MAX_PUBLISH_BODY_LENGTH) {
      return reply.code(400).send({ error: typeof body.body === 'string' ? 'pull request description is too long' : 'pull request description must be a string' });
    }
    if (typeof body.draft !== 'boolean') return reply.code(400).send({ error: 'draft must be a boolean' });
    try {
      return await (ctx.publish ?? gitPublishService).createPullRequest(repoPath, {
        base: body.base, title: body.title, body: body.body, draft: body.draft,
      });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/repos/open-file', async (req, reply) => {
    const body = req.body as { repo?: unknown; path?: unknown; line?: unknown } | null;
    const repoPath = knownRepoPath(typeof body?.repo === 'string' ? body.repo : undefined);
    if (!repoPath) return reply.code(404).send({ error: 'no such repo' });
    if (typeof body?.path !== 'string' || body.path.length === 0 || body.path.length > MAX_PATH_LENGTH) {
      return reply.code(400).send({ error: 'path is required' });
    }
    const resolvedFile = resolveRepoFile(repoPath, body.path);
    if (!resolvedFile || !fs.existsSync(resolvedFile)) return reply.code(404).send({ error: 'file not found' });
    const line = typeof body.line === 'number' && Number.isInteger(body.line) && body.line > 0 ? body.line : undefined;
    try {
      await execFileAsync('code', ['--goto', `${resolvedFile}${line ? `:${line}` : ''}`], { encoding: 'utf8', timeout: 10_000 });
      return { ok: true };
    } catch {
      return reply.code(503).send({ error: 'VS Code CLI is unavailable. Install the “code” shell command to open files from AgentDeck.' });
    }
  });

  app.get('/api/events', async (req) => {
    const { repo, limit } = req.query as { repo?: string; limit?: string };
    const parsedLimit = Number(limit);
    return ctx.store?.listEvents({
      ...(repo ? { repo } : {}),
      limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 1000) : 100,
    }) ?? [];
  });
  app.get('/api/claims', async () => deriveClaims(ctx.store?.listEvents({ limit: 1000 }) ?? []));
  app.get('/api/conflicts', async () => ctx.store ? deriveConflicts(
    manager.listSessions(), ctx.store.listRepos(),
    deriveClaims(ctx.store.listEvents({ limit: 1000 })), ctx.store.listTasks(),
  ) : []);

  app.get('/api/terminals/status', async () => ({
    automationHint: ctx.terminals?.automationHint(),
  }));

  app.get('/api/integrations/vscode/status', async () => ({
    ...(ctx.vscode?.status() ?? { connected: false, windows: 0, terminals: 0 }),
    installable: fs.existsSync(VSCODE_VSIX_PATH) && Boolean(await resolveVsCodeCli()),
  }));

  app.post('/api/integrations/vscode/install', async (_req, reply) => {
    try {
      return await (ctx.installVsCode ?? installVsCodeExtension)();
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/sessions', async (req, reply) => {
    const spec = parseLaunchSpec(req.body);
    if (typeof spec === 'string') return reply.code(400).send({ error: spec });
    try {
      if (spec.branch) await checkoutBranch(spec.cwd, spec.branch, spec.createBranchIfMissing === true);
      if (spec.agent === 'claude' && spec.permissionMode) {
        if (spec.permissionMode !== 'default') {
          spec.extraArgs = [...(spec.extraArgs ?? []), '--permission-mode', spec.permissionMode];
        }
      }
      if (spec.agent === 'codex') {
        if (spec.permissionMode === 'default') {
          spec.extraArgs = [
            ...(spec.extraArgs ?? []),
            '--sandbox', 'read-only',
            '--ask-for-approval', 'on-request',
          ];
        } else if (spec.permissionMode === 'acceptEdits') {
          spec.extraArgs = [
            ...(spec.extraArgs ?? []),
            '--sandbox', 'workspace-write',
            '--ask-for-approval', 'on-request',
          ];
        } else if (spec.permissionMode === 'plan') {
          spec.initialPrompt = spec.initialPrompt ? `/plan ${spec.initialPrompt}` : '/plan';
        }
        spec.extraArgs = [...(spec.extraArgs ?? []), '-c', `notify=${JSON.stringify(['node', HOOK_PATH])}`];
      }
      const session = await manager.launch(spec);
      return reply.code(201).send(publicSession(session));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(400).send({ error: message });
    }
  });

  app.post('/api/hooks/install', async (req, reply) => {
    const body = req.body as { repoPath?: unknown; user?: unknown } | null;
    const repoPath = parseRepoPath(body?.repoPath);
    if (!repoPath) return reply.code(400).send({ error: 'repoPath must be an existing Git repository' });
    try {
      installClaudeHooks(repoPath, HOOK_PATH);
      if (body?.user === true) installCodexHooks(path.join(os.homedir(), '.codex', 'config.toml'), HOOK_PATH);
      return { ok: true, restartRequired: true };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/hooks/uninstall', async (req, reply) => {
    const body = req.body as { repoPath?: unknown; user?: unknown } | null;
    const repoPath = parseRepoPath(body?.repoPath);
    if (!repoPath) return reply.code(400).send({ error: 'repoPath must be an existing Git repository' });
    try {
      uninstallClaudeHooks(repoPath);
      if (body?.user === true) uninstallCodexHooks(path.join(os.homedir(), '.codex', 'config.toml'));
      return { ok: true, restartRequired: true };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/sessions/:id/stop', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!manager.getSession(id)) return reply.code(404).send({ error: 'no such session' });
    // Stopping only makes sense for a live process; an already-ended
    // session has nothing left to stop (ticket 04: live-only actions are
    // unavailable once ended).
    if (!manager.isLive(id)) return reply.code(400).send({ error: 'session has already ended' });
    await manager.stop(id);
    return { ok: true }; // the row is kept, marked ended
  });

  // Ticket 09: reopening an ended managed session. There is no WS path for
  // this — attach/replay only serve a live transcript snapshot, and an
  // ended session has no live PTY behind it — so a REST read of the
  // compacted scrollback.txt is the natural fit. History is managed-only
  // per the spec's non-goals (external sessions have no PTY, so no stored
  // bytes to read).
  app.get('/api/sessions/:id/scrollback', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = manager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'no such session' });
    if (session.origin !== 'managed') {
      return reply.code(400).send({ error: 'scrollback is only available for managed sessions' });
    }
    const scrollback = await manager.readScrollback(id);
    if (scrollback === undefined) {
      return reply.code(404).send({
        error: manager.isLive(id)
          ? 'session is still running; scrollback is produced once it ends'
          : 'no scrollback is available for this session',
      });
    }
    return { sessionId: id, scrollback };
  });

  // Ticket 11: wrap-up. Manual-only by design (spec: "Manual summary
  // trigger only" — automatic summarization on exit would fire N summaries
  // at once when the dev server stops, the exact case where a summary is
  // least wanted). This route is the *only* caller of manager.summarize()
  // in the whole server — it is never invoked from handleExit, shutdown(),
  // or boot reconciliation.
  app.post('/api/sessions/:id/summarize', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = manager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'no such session' });
    if (session.origin !== 'managed') {
      return reply.code(400).send({ error: 'summarization is only available for managed sessions' });
    }
    if (manager.isLive(id)) {
      return reply.code(400).send({ error: 'session has not ended yet' });
    }
    const body = req.body as { model?: unknown } | null;
    if (body?.model !== undefined && typeof body.model !== 'string') {
      return reply.code(400).send({ error: 'model must be a string' });
    }
    try {
      const summary = await manager.summarize(id, body?.model ? { model: body.model } : {});
      return { sessionId: id, summary };
    } catch (error) {
      // Covers both validation-shaped failures (no scrollback yet) and
      // subprocess failures (claude -p missing/erroring/timing out) — either
      // way the scrollback and any previous summary are untouched (ticket
      // 11: manager.summarize() only writes after the call succeeds), so
      // reporting the failure here is safe and the session stays usable.
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Read path for the stored summary, deliberately mirroring the scrollback
  // route's shape (dedicated GET endpoint, not folded into the session
  // object) rather than adding a `summary` field to Session — same
  // rationale as scrollback: the summary lives as a file
  // (sessions/<id>/summary.md), not in the row.
  app.get('/api/sessions/:id/summary', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = manager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'no such session' });
    if (session.origin !== 'managed') {
      return reply.code(400).send({ error: 'summary is only available for managed sessions' });
    }
    const summary = await manager.readSummary(id);
    if (summary === undefined) return reply.code(404).send({ error: 'no summary has been generated for this session' });
    return { sessionId: id, summary, summaryGeneratedAt: session.summaryGeneratedAt };
  });

  app.post('/api/sessions/:id/restart', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = manager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'no such session' });
    if (session.origin !== 'managed') {
      return reply.code(400).send({ error: 'session is not restartable' });
    }
    try {
      return publicSession(await manager.restart(id));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/sessions/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = manager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'no such session' });
    const repoPath = session.worktreePath ?? session.repoId ?? session.cwd;
    const messages = await readBusTail(repoPath);
    return messages.filter((message) => {
      if (message.agent.startsWith('dashboard:')) {
        return message.agent === `dashboard:${session.id}` && message.event === 'message';
      }
      const belongsToSession = message.sessionId === session.id
        || (session.agentSessionId !== undefined && message.agent === session.agentSessionId);
      return belongsToSession && (message.event === 'done' || message.event === 'message')
        && typeof message.message === 'string' && message.message.trim().length > 0;
    }).slice(-100);
  });

  app.get('/api/sessions/:id/capabilities', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = manager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'no such session' });
    const repoPath = session.worktreePath ?? session.repoId ?? session.cwd;
    const replyCapture = session.agent === 'claude'
      ? repoHasClaudeHooks(repoPath)
      : userHasCodexHooks();
    const send = session.origin === 'managed'
      ? 'managed'
      : session.terminalApp === 'VSCode'
        ? 'vscode'
        : session.terminalApp === 'Terminal' || session.terminalApp === 'iTerm2'
          ? 'terminal'
          : session.agent === 'claude' && session.agentSessionId
            ? 'queued'
            : 'unavailable';
    return { send, replyCapture };
  });

  app.post('/api/sessions/:id/send', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = manager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'no such session' });
    const body = req.body as { text?: unknown } | null;
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) return reply.code(400).send({ error: 'text is required' });
    if (text.length > MAX_MESSAGE_LENGTH) return reply.code(400).send({ error: 'text is too long' });
    // Code-review finding: this route writes `text` to the PTY verbatim
    // (below, for a managed session), and ticket 05 made it reachable by an
    // authenticated remote connection — without this check a remote client
    // could smuggle raw control bytes (Ctrl-C, Esc, ...) through the
    // free-text composer, bypassing the WS 'input' path's control-key
    // allowlist (ticket 14, remote-input.ts) through a different door.
    // Local connections are unaffected; a valid remote token authenticates
    // the connection, it doesn't grant it raw-write.
    const trust = requestTrust(req);
    if (trust.kind === 'remote' && session.origin !== 'managed') {
      return reply.code(403).send({ error: 'external sessions are not available on a remote connection' });
    }
    if (!trust.capabilities.has('raw-write') && containsDisallowedControlBytes(text)) {
      return reply.code(400).send({ error: 'raw control characters are not permitted from this connection' });
    }

    const repoPath = session.worktreePath ?? session.repoId ?? session.cwd;
    const recordSend = () => appendAgentMessage(repoPath, {
      ts: new Date().toISOString(), agent: `dashboard:${session.id}`, repo: repoPath,
      event: 'message', message: text, sessionId: session.id,
    });

    if (session.origin === 'managed') {
      if (!manager.isLive(id)) return reply.code(400).send({ error: 'session is not running' });
      manager.write(id, text);
      // both agent TUIs debounce paste-then-submit
      setTimeout(() => { try { manager.write(id, '\r'); } catch { /* exited meanwhile */ } }, 300);
      await recordSend();
      return { delivered: 'typed' };
    }

    if (session.terminalApp && session.terminalApp !== 'unknown' && ctx.terminals) {
      try {
        await ctx.terminals.sendText(session, text);
        await recordSend();
        return { delivered: 'typed' };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.code(error instanceof AutomationDeniedError ? 403 : 400).send({ error: message });
      }
    }

    if (session.agent === 'claude') {
      if (!session.agentSessionId) {
        return reply.code(409).send({
          error: 'This Claude session has not completed its AgentDeck hook handshake yet. Run one turn in that terminal, then try again.',
        });
      }
      await appendInboxMessage(repoPath, {
        ts: new Date().toISOString(), to: session.agentSessionId, text,
      });
      await recordSend();
      return { delivered: 'queued', hooked: repoHasClaudeHooks(repoPath) };
    }

    return reply.code(400).send({
      error: 'This session runs in a terminal that cannot be scripted; only Claude sessions with AgentDeck hooks can receive queued messages.',
    });
  });

  app.post('/api/sessions/:id/focus', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = manager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'no such session' });
    if (session.origin !== 'external') return reply.code(400).send({ error: 'only external sessions can be focused' });
    if (!ctx.terminals) return reply.code(503).send({ error: 'terminal adapters are unavailable' });
    try {
      await ctx.terminals.focus(session);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(error instanceof AutomationDeniedError ? 403 : 400).send({ error: message });
    }
  });
}
