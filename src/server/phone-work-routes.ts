// Phone work: the routes made for the owner phone's Work tab. The phone
// starts and steers the same Sessions and Runs the Mac does — following,
// messaging, answering and approving go through the Mac's own routes (see
// app.ts's isOwnerWorkRoute). These add only what a phone without a
// WebSocket needs: one compact list of work and what needs the owner,
// Start work in both modes with the choices the Mac already made, a Run
// detail sized for one relay frame, and the Terminal toggle's text and keys.
//
// Every route is for the owner only, at this Mac or from their paired phone.
// Starting work from the phone is narrower than the Mac's launcher on
// purpose: only a Repository the Mac already has, no free path, no
// environment, no extra arguments, and the Repository's checks as set on
// the Mac.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { appendAgentMessage } from '../coordination/bus.js';
import { CONTROL_KEYS } from '../protocol.js';
import type { RuntimeReadinessSource } from '../sessions/runtime-readiness.js';
import type { RuntimeReadinessReport } from '../sessions/runtime-readiness-contract.js';
import type { SessionManager } from '../sessions/manager.js';
import type { Store } from '../store/index.js';
import type { OwnerDeviceAudit } from '../store/owner-devices.js';
import type { AgentType, LaunchSpec, Repo, Session } from '../types.js';
import { InvalidWorkSpecError, PolicyDeniedError } from '../work-engine/engine.js';
import { resolveLocalPrincipal } from '../work-engine/principal.js';
import type { RequestedDeliveryResult, RunActor, WorkEngine, WorkRun, WorkSpec } from '../work-engine/types.js';
import type { PhoneFollowers } from './phone-followers.js';
import { deriveNeeds, phoneRuns, phoneSessions, runDetail, runSummary, type WorkState } from './phone-work.js';
import { launchManagedSession } from './routes.js';
import { publicSession } from './security.js';
import type { SessionScreens } from './session-screen.js';
import { tail } from './session-screen.js';

const MAX_TASK_LENGTH = 64 * 1024;
const MAX_CRITERIA = 20;
const MAX_CRITERION_LENGTH = 1000;
const MAX_BRANCH_LENGTH = 200;
const MAX_KEYS = 16;
const MAX_WALL_CLOCK_MINUTES = 8 * 60;
const KEY_GAP_MS = 120;
const READINESS_TTL_MS = 60_000;
const DELIVERIES: readonly RequestedDeliveryResult[] = ['apply-to-repository', 'local-commit', 'pull-request', 'working-tree'];
const KEYS = new Map(CONTROL_KEYS.map((key) => [key.label, key.data]));

/** Who is asking: the owner at this Mac, or the owner's paired phone. */
export type PhoneWorkCaller = { kind: 'mac' } | { kind: 'phone'; device: { id: string; label: string } };

export interface PhoneWorkRouteDeps {
  manager: SessionManager;
  store?: Store;
  workEngine?: WorkEngine;
  /** Settings → Folder access. */
  allowsPath: (target: string) => boolean;
  resolveCaller: (request: FastifyRequest) => PhoneWorkCaller | undefined;
  audit?: (deviceId: string, action: OwnerDeviceAudit['action'], targetId: string) => void;
  readiness: RuntimeReadinessSource;
  screens: SessionScreens;
  followers?: PhoneFollowers;
  /** Injectable for tests; defaults to the Mac's own launcher. */
  launch?: (spec: LaunchSpec) => Promise<Session>;
  now?: () => number;
}

/** The Mac's current work, as the phone and push notifications read it. */
export function workState(deps: Pick<PhoneWorkRouteDeps, 'manager' | 'store' | 'workEngine' | 'now'>): WorkState {
  const { manager, store } = deps;
  return {
    sessions: manager.listSessions(),
    isLive: (session) => (session.origin === 'managed' ? manager.isLive(session.id) : session.status !== 'exited'),
    interactions: (sessionId) => store?.listSessionInteractions(sessionId) ?? [],
    events: store?.listEvents({ limit: 1000 }) ?? [],
    runs: deps.workEngine?.list() ?? [],
    feedback: (taskId) => store?.listRunFeedback(taskId) ?? [],
    ...(deps.now ? { now: deps.now() } : {}),
  };
}

function installed(report: RuntimeReadinessReport | undefined, runtime: AgentType): boolean {
  const entry = report?.runtimes.find((item) => item.runtime === runtime);
  return entry === undefined || entry.status !== 'unavailable';
}

function managedReady(report: RuntimeReadinessReport | undefined, runtime: AgentType): boolean {
  const entry = report?.runtimes.find((item) => item.runtime === runtime);
  return entry === undefined || entry.status === 'managed';
}

/** The first line of the task, as the Mac names a Quick session. */
function taskName(task: string): string | undefined {
  const firstLine = task.trim().split('\n')[0]?.replace(/\s+/g, ' ').trim();
  if (!firstLine) return undefined;
  return firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine;
}

function parseAgent(value: unknown): 'auto' | AgentType | undefined {
  if (value === undefined || value === 'auto') return 'auto';
  return value === 'claude' || value === 'codex' ? value : undefined;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function registerPhoneWorkRoutes(app: FastifyInstance, deps: PhoneWorkRouteDeps): void {
  const { manager, store } = deps;

  const caller = (request: FastifyRequest, reply: FastifyReply): PhoneWorkCaller | undefined => {
    const who = deps.resolveCaller(request);
    if (!who) { void reply.code(403).send({ error: 'Work from the phone is only available to the owner.' }); return undefined; }
    // A phone's request is refused before any effect when it cannot be audited.
    if (who.kind === 'phone' && !deps.audit) { void reply.code(503).send({ error: 'Owner phone audit is unavailable.' }); return undefined; }
    return who;
  };
  const audit = (who: PhoneWorkCaller, action: OwnerDeviceAudit['action'], targetId: string) => {
    if (who.kind === 'phone') deps.audit!(who.device.id, action, targetId);
  };
  const actor = (who: PhoneWorkCaller): RunActor | undefined =>
    (who.kind === 'phone' ? { principal: resolveLocalPrincipal(), device: who.device } : undefined);

  const knownRepo = (repositoryId: unknown): Repo | undefined => {
    if (typeof repositoryId !== 'string' || !store) return undefined;
    const repo = store.listRepos().find((item) => item.id === repositoryId);
    return repo && deps.allowsPath(repo.path) ? repo : undefined;
  };
  // Probing runs each CLI, so one answer serves the phone for a minute.
  let cached: { at: number; report: RuntimeReadinessReport } | undefined;
  const readiness = async () => {
    const now = deps.now?.() ?? Date.now();
    if (cached && now - cached.at < READINESS_TTL_MS) return cached.report;
    try {
      cached = { at: now, report: await deps.readiness.get() };
      return cached.report;
    } catch { return undefined; }
  };

  app.get('/api/phone/work', async (request, reply) => {
    if (!caller(request, reply)) return reply;
    const state = workState(deps);
    const needs = deriveNeeds(state);
    return { sessions: phoneSessions(state, needs), runs: phoneRuns(state), needs };
  });

  app.get('/api/phone/repos', async (request, reply) => {
    if (!caller(request, reply)) return reply;
    const report = await readiness();
    const repos = (store?.listRepos() ?? []).filter((repo) => deps.allowsPath(repo.path))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((repo) => {
        const policy = store?.getRepositoryVerificationPolicy(repo.id);
        return {
          id: repo.id, name: repo.name,
          ...(repo.currentBranch ? { currentBranch: repo.currentBranch } : {}),
          checks: !policy ? 'missing' : policy.kind === 'required' ? 'required' : 'none',
          ...(policy?.kind === 'required' ? { checkNames: policy.gates.map((gate) => gate.name) } : {}),
        };
      });
    return {
      repos,
      agents: (['claude', 'codex'] as const).map((runtime) => ({
        agent: runtime, quick: installed(report, runtime), structured: managedReady(report, runtime),
      })),
    };
  });

  // Quick: a live Session in the Repository, opening with the task.
  app.post('/api/phone/sessions', async (request, reply) => {
    const who = caller(request, reply);
    if (!who) return reply;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const repo = knownRepo(body.repositoryId);
    if (!repo) return reply.code(404).send({ error: 'Choose a repository this Mac already has.' });
    const task = typeof body.task === 'string' ? body.task.trim() : '';
    if (!task) return reply.code(400).send({ error: 'Say what the agent should do.' });
    if (task.length > MAX_TASK_LENGTH) return reply.code(400).send({ error: 'The task is too long.' });
    const permissionMode = body.permissionMode ?? 'default';
    if (permissionMode !== 'default' && permissionMode !== 'acceptEdits' && permissionMode !== 'plan') {
      return reply.code(400).send({ error: 'Permissions must be default, acceptEdits or plan.' });
    }
    const branch = typeof body.branch === 'string' ? body.branch.trim() : '';
    if (branch.length > MAX_BRANCH_LENGTH || branch.startsWith('-')) return reply.code(400).send({ error: 'That branch name is not valid.' });
    const choice = parseAgent(body.agent);
    if (!choice) return reply.code(400).send({ error: 'Agent must be auto, claude or codex.' });
    const report = await readiness();
    const agent: AgentType = choice !== 'auto' ? choice : (['claude', 'codex'] as const).find((runtime) => installed(report, runtime)) ?? 'claude';

    const name = taskName(task);
    const spec: LaunchSpec = {
      agent, cwd: repo.path, initialPrompt: task, permissionMode,
      ...(name ? { name } : {}),
      ...(branch ? { branch, ...(body.createBranch === true ? { createBranchIfMissing: true } : {}) } : {}),
    };
    audit(who, 'session-start', repo.id);
    try {
      const session = await (deps.launch ?? ((launchSpec) => launchManagedSession(manager, launchSpec)))(spec);
      // The first message is typed by the launcher; recording it marks it as
      // sent from the phone on both screens.
      if (who.kind === 'phone' && spec.initialPrompt) {
        await appendAgentMessage(repo.path, {
          ts: session.startedAt, agent: `dashboard:${session.id}`, repo: repo.path, event: 'message',
          message: spec.initialPrompt, sessionId: session.id, via: 'phone',
        }).catch(() => undefined);
      }
      return reply.code(201).send(publicSession(session));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Structured: submit, prepare and start a Run in one step. The Repository's
  // checks are the ones the owner set on the Mac; the phone never edits them.
  app.post('/api/phone/runs', async (request, reply) => {
    const who = caller(request, reply);
    if (!who) return reply;
    if (!deps.workEngine || !store) return reply.code(503).send({ error: 'Runs are unavailable on this Mac.' });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const repo = knownRepo(body.repositoryId);
    if (!repo) return reply.code(404).send({ error: 'Choose a repository this Mac already has.' });
    const objective = typeof body.objective === 'string' ? body.objective.trim() : '';
    if (!objective) return reply.code(400).send({ error: 'Say what the Run should do.' });
    if (objective.length > MAX_TASK_LENGTH) return reply.code(400).send({ error: 'The objective is too long.' });
    const criteria = Array.isArray(body.acceptanceCriteria)
      ? body.acceptanceCriteria.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
      : [];
    if (criteria.length === 0) return reply.code(400).send({ error: 'Add at least one "done when" line.' });
    if (criteria.length > MAX_CRITERIA || criteria.some((item) => item.length > MAX_CRITERION_LENGTH)) {
      return reply.code(400).send({ error: 'Too many or too long "done when" lines.' });
    }
    if (!store.getRepositoryVerificationPolicy(repo.id)) {
      return reply.code(409).send({ error: `Set ${repo.name}'s checks on the Mac first (Start work › Structured).`, code: 'checks-missing' });
    }
    const delivery = body.delivery ?? 'apply-to-repository';
    if (!DELIVERIES.includes(delivery as RequestedDeliveryResult)) return reply.code(400).send({ error: 'That delivery is not available.' });
    const minutes = body.wallClockMinutes === undefined ? 60 : Number(body.wallClockMinutes);
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > MAX_WALL_CLOCK_MINUTES) {
      return reply.code(400).send({ error: `The time limit must be 5 to ${MAX_WALL_CLOCK_MINUTES} minutes.` });
    }
    const base = typeof body.baseReference === 'string' && body.baseReference.trim() ? body.baseReference.trim() : repo.currentBranch ?? 'HEAD';
    if (base.length > MAX_BRANCH_LENGTH || base.startsWith('-')) return reply.code(400).send({ error: 'That base branch is not valid.' });
    const choice = parseAgent(body.agent);
    if (!choice) return reply.code(400).send({ error: 'Agent must be auto, claude or codex.' });
    const report = await readiness();
    const runtimes = (choice === 'auto' ? ['codex', 'claude'] as AgentType[] : [choice]).filter((runtime) => managedReady(report, runtime));
    if (runtimes.length === 0) return reply.code(409).send({ error: 'No agent on this Mac can run Structured work yet.' });

    const spec: WorkSpec = {
      objective,
      acceptanceCriteria: criteria,
      repository: { id: repo.id, name: repo.name, path: repo.path },
      requestedBaseReference: base,
      runtimePreference: runtimes,
      budget: { maxWallClockMs: minutes * 60_000, maxModelTurns: 50 },
      verificationIntent: { required: false, commands: [] },
      requestedDeliveryResult: delivery as RequestedDeliveryResult,
    };
    audit(who, 'run-submit', repo.id);
    let run: WorkRun;
    try {
      run = await deps.workEngine.submit(spec, actor(who));
    } catch (error) {
      if (error instanceof PolicyDeniedError) return reply.code(403).send({ error: error.message });
      if (error instanceof InvalidWorkSpecError) return reply.code(400).send({ error: error.message });
      throw error;
    }
    // Submitted is durable; preparing or starting can still fail, and the
    // Run then shows why on both screens with Try again.
    let startError: string | undefined;
    try {
      run = await deps.workEngine.prepare(run.id, actor(who));
      run = await deps.workEngine.start(run.id, actor(who));
    } catch (error) {
      startError = error instanceof Error ? error.message : String(error);
      run = deps.workEngine.get(run.id) ?? run;
    }
    return reply.code(201).send({ ...runSummary(run, store.listRunFeedback(run.taskId)), ...(startError ? { startError } : {}) });
  });

  app.get('/api/phone/runs/:id', async (request, reply) => {
    if (!caller(request, reply)) return reply;
    const { id } = request.params as { id: string };
    const run = deps.workEngine?.get(id);
    if (!run) return reply.code(404).send({ error: 'No such Run.' });
    return runDetail(run, store?.listRunFeedback(run.taskId) ?? [], deps.now?.());
  });

  // The Terminal toggle: plain text, never raw bytes, long-polled.
  app.get('/api/phone/sessions/:id/screen', async (request, reply) => {
    const who = caller(request, reply);
    if (!who) return reply;
    const { id } = request.params as { id: string };
    const session = manager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'No such session.' });
    if (who.kind === 'phone') deps.followers?.touch(id);
    if (session.origin !== 'managed') return { seq: 0, text: '', live: false, available: false };
    if (!manager.isLive(id)) {
      const scrollback = await manager.readScrollback(id).catch(() => undefined);
      return { seq: 1, text: tail(scrollback ?? ''), live: false, available: scrollback !== undefined };
    }
    const query = request.query as { after?: string; wait?: string };
    const after = Number(query.after ?? -1);
    const wait = Number(query.wait ?? 0);
    const screen = await deps.screens.next(id, Number.isFinite(after) ? after : -1, Number.isFinite(wait) ? wait : 0);
    return { ...screen, live: true, available: true };
  });

  // The key bar and Interrupt: only the fixed control keys, by name.
  app.post('/api/phone/sessions/:id/keys', async (request, reply) => {
    const who = caller(request, reply);
    if (!who) return reply;
    const { id } = request.params as { id: string };
    const session = manager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'No such session.' });
    if (session.origin !== 'managed' || !manager.isLive(id)) return reply.code(400).send({ error: 'This session is not running here.' });
    const keys = (request.body as { keys?: unknown } | null)?.keys;
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_KEYS
      || !keys.every((key) => typeof key === 'string' && KEYS.has(key))) {
      return reply.code(400).send({ error: `Keys must be some of: ${[...KEYS.keys()].join(', ')}.` });
    }
    audit(who, 'session-input', id);
    for (const [index, key] of (keys as string[]).entries()) {
      if (index > 0) await sleep(KEY_GAP_MS);
      manager.write(id, KEYS.get(key)!);
    }
    return { ok: true };
  });
}
