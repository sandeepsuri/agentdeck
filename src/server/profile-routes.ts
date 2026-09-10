// Ticket 12 AC1: admin-approved Profiles a collaborator may be granted and
// then submit a Run against. Profiles are immutable once created — no
// update route, only a new Profile — exactly like a Run's own frozen
// WorkSpec (see store/index.ts's createProfile).
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Store } from '../store/index.js';
import type { AgentType } from '../types.js';
import type { RequestedDeliveryResult, RunBudget } from '../work-engine/types.js';
import { nonEmptyString } from './validate.js';

const MAX_NAME_LENGTH = 200;
const MAX_RUNTIME_PREFERENCE = 10;
const MAX_VERIFICATION_COMMANDS = 100;
const MAX_COMMAND_LENGTH = 4096;
const RUNTIMES: AgentType[] = ['codex', 'claude'];
const DELIVERY_RESULTS: RequestedDeliveryResult[] = ['working-tree', 'local-commit', 'apply-to-repository', 'pull-request'];
// Every field RunBudget (work-engine/types.ts) actually declares — unlike
// engine.ts's own validateWorkSpec (which only checks budget *values*, not
// key names, for every WorkSpec including an admin's own), this admin-only
// creation route rejects a stray or misspelled key outright rather than
// silently persisting and then ignoring it forever inside an immutable
// Profile.
const RUN_BUDGET_KEYS = new Set<keyof RunBudget>([
  'maxWallClockMs', 'maxModelTurns', 'maxInputTokens', 'maxOutputTokens', 'maxChildRuns', 'maxToolCalls',
  'maxConcurrentProcesses', 'maxCostUsd', 'maxRepairAttempts',
]);

function parseRuntimePreference(value: unknown): AgentType[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_RUNTIME_PREFERENCE) return undefined;
  if (!value.every((item): item is AgentType => RUNTIMES.includes(item as AgentType))) return undefined;
  return value as AgentType[];
}

function parseBudget(value: unknown): RunBudget | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.every(([key, limit]) => RUN_BUDGET_KEYS.has(key as keyof RunBudget)
    && typeof limit === 'number' && Number.isFinite(limit) && limit > 0)) return undefined;
  return Object.fromEntries(entries) as RunBudget;
}

function parseVerificationIntent(value: unknown): { required: boolean; commands: string[] } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { required, commands } = value as Record<string, unknown>;
  if (typeof required !== 'boolean') return undefined;
  if (!Array.isArray(commands) || commands.length > MAX_VERIFICATION_COMMANDS
    || !commands.every((c) => nonEmptyString(c, MAX_COMMAND_LENGTH))) return undefined;
  if (required && commands.length === 0) return undefined;
  return { required, commands: commands as string[] };
}

/**
 * Ticket 12 AC1/AC4: a collaborator device only ever sees the Profiles it
 * was granted — never the full admin roster — mirroring GET /api/repos'
 * grant filter from ticket 11 exactly.
 */
export function registerProfileRoutes(
  app: FastifyInstance,
  store: Store,
  resolveGrantedProfileIds?: (request: FastifyRequest) => readonly string[] | undefined,
): void {
  // Local-admin-only: not on isCollaboratorAllowedRoute's POST allowlist
  // (app.ts), so a remote connection can never mint its own Profile.
  app.post('/api/profiles', async (request, reply) => {
    const body = request.body as {
      name?: unknown; runtimePreference?: unknown; budget?: unknown; verificationIntent?: unknown; requestedDeliveryResult?: unknown;
    } | null;
    if (!nonEmptyString(body?.name, MAX_NAME_LENGTH)) return reply.code(400).send({ error: 'name is required' });
    const runtimePreference = parseRuntimePreference(body?.runtimePreference);
    if (!runtimePreference) return reply.code(400).send({ error: 'runtimePreference must contain codex or claude' });
    const budget = parseBudget(body?.budget);
    if (!budget) return reply.code(400).send({ error: 'budget limits must be positive finite numbers' });
    const verificationIntent = parseVerificationIntent(body?.verificationIntent);
    if (!verificationIntent) return reply.code(400).send({ error: 'verificationIntent must include required and string commands' });
    if (!DELIVERY_RESULTS.includes(body?.requestedDeliveryResult as RequestedDeliveryResult)) {
      return reply.code(400).send({ error: 'requestedDeliveryResult is invalid' });
    }
    const profile = {
      id: randomUUID(),
      name: (body!.name as string).trim(),
      runtimePreference,
      budget,
      verificationIntent,
      requestedDeliveryResult: body!.requestedDeliveryResult as RequestedDeliveryResult,
      createdAt: new Date().toISOString(),
    };
    store.createProfile(profile);
    return reply.code(201).send(profile);
  });

  app.get('/api/profiles', async (request) => {
    const granted = resolveGrantedProfileIds?.(request);
    const profiles = store.listProfiles();
    return granted ? profiles.filter((profile) => granted.includes(profile.id)) : profiles;
  });
}
