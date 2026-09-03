import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { deriveRunAttentionItems } from '../attention.js';
import {
  InvalidRunStateError, InvalidWorkSpecError, PolicyDeniedError, RunAttentionNotPendingError, RunNotFoundError,
  RunPreparationError, UnsupportedRuntimeError,
} from '../work-engine/engine.js';
import { isPublicationTarget } from '../work-engine/publication.js';
import type {
  AttentionDecisionInput, PublicationTarget, RunActor, WorkEngine, WorkSpec,
} from '../work-engine/types.js';
import { nonEmptyString } from './validate.js';

export interface WorkRoutesDeps {
  /**
   * Ticket 11 AC4: a collaborator device's granted Repository ids
   * (connection-trust.ts's `TrustResult.device.grantedRepositoryIds`), or
   * undefined for local and legacy-shared-token remote connections, which
   * stay unrestricted exactly as before this ticket. Kept as a plain
   * function rather than importing connection-trust.ts directly so this
   * module's own tests don't need a real Fastify request/ConnectionTrust.
   */
  resolveGrantedRepositoryIds?: (request: FastifyRequest) => readonly string[] | undefined;
  /**
   * Ticket 12 AC1/AC2/AC7: the RunActor a mutating request (submit,
   * prepare, start, cancel, resolveAttention) is made as — undefined for
   * local and legacy-shared-token connections, which stay unrestricted
   * (the Work Engine itself defaults to its own principalSource, exactly
   * pre-ticket-12 behavior). A resolved collaborator device's RunActor
   * carries `grants`, so the SAME DurableWorkEngine.enforcePolicy() every
   * other transport (WebSocket, a direct engine call) reaches makes the
   * actual allow/deny decision here — this route only resolves who's
   * asking, never decides what they may do.
   */
  resolveActor?: (request: FastifyRequest) => RunActor | undefined;
}

/** Ticket 12 AC1/AC4: a PolicyDeniedError is a 403, everywhere it can surface below — never conflated with InvalidWorkSpecError/InvalidRunStateError's 400s, which mean "the request was malformed," not "you're not allowed." */
function handlePolicyDenied(error: unknown, reply: FastifyReply): boolean {
  if (!(error instanceof PolicyDeniedError)) return false;
  reply.code(403).send({ error: error.message, rule: error.rule });
  return true;
}

/** Local admin REST adapter; all behavior remains owned by WorkEngine. */
export function registerWorkRoutes(app: FastifyInstance, workEngine: WorkEngine, deps: WorkRoutesDeps = {}): void {
  const scopeRuns = (request: FastifyRequest) => {
    const granted = deps.resolveGrantedRepositoryIds?.(request);
    const runs = workEngine.list();
    return granted ? runs.filter((run) => granted.includes(run.spec.repository.id)) : runs;
  };

  app.get('/api/runs', async (request) => scopeRuns(request));

  // Ticket 07: the one minimal, remote-safe read a mobile client needs to
  // act on a pending Run attention request — never the Repository path,
  // budget, envelope, or full spec GET /api/runs/:id returns (local-only,
  // see app.ts's isRemoteAllowedRoute). Registered before the /:id route
  // below; Fastify's router prefers a static path segment over a
  // parametric one regardless of registration order, but this keeps intent
  // obvious to a reader.
  //
  // Ticket 12 AC3: a collaborator device must be able to see and resolve
  // its own granted Run's pending attention too, so this now reuses
  // scopeRuns' same grant filter — never the unfiltered, system-wide queue
  // the legacy shared-token/local paths still get (app.ts's
  // isRemoteAllowedRoute keeps granting that unfiltered read to those,
  // unchanged).
  app.get('/api/runs/attention', async (request) => deriveRunAttentionItems(scopeRuns(request)));

  app.get('/api/runs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = workEngine.get(id);
    if (!run) return reply.code(404).send({ error: 'no such run' });
    // AC4: a Run outside a collaborator device's grants doesn't exist as
    // far as it's concerned — 404, not 403, so an id it can't view never
    // leaks even the fact that it exists.
    const granted = deps.resolveGrantedRepositoryIds?.(request);
    if (granted && !granted.includes(run.spec.repository.id)) return reply.code(404).send({ error: 'no such run' });
    return run;
  });

  // Ticket 12 AC5: how the admin actually observes who did what to a
  // collaborator's Run — never on isCollaboratorAllowedRoute (app.ts), so
  // this stays local-only exactly like GET /api/runs/:id's full spec.
  app.get('/api/runs/:id/activity', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!workEngine.get(id)) return reply.code(404).send({ error: 'no such run' });
    return workEngine.listActivity(id);
  });

  app.post('/api/runs', async (request, reply) => {
    try {
      const run = await workEngine.submit(request.body as WorkSpec, deps.resolveActor?.(request));
      return reply.code(201).send(run);
    } catch (error) {
      if (handlePolicyDenied(error, reply)) return;
      if (error instanceof InvalidWorkSpecError) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post('/api/runs/:id/prepare', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await workEngine.prepare(id, deps.resolveActor?.(request));
    } catch (error) {
      if (handlePolicyDenied(error, reply)) return;
      if (error instanceof RunNotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof InvalidRunStateError || error instanceof RunPreparationError) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post('/api/runs/:id/start', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await workEngine.start(id, deps.resolveActor?.(request));
    } catch (error) {
      if (handlePolicyDenied(error, reply)) return;
      if (error instanceof RunNotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof InvalidRunStateError || error instanceof UnsupportedRuntimeError) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post('/api/runs/:id/reverify', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await workEngine.reverify(id, deps.resolveActor?.(request));
    } catch (error) {
      if (handlePolicyDenied(error, reply)) return;
      if (error instanceof RunNotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof InvalidRunStateError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });

  app.post('/api/runs/:id/apply', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await workEngine.apply(id, deps.resolveActor?.(request));
    } catch (error) {
      if (handlePolicyDenied(error, reply)) return;
      if (error instanceof RunNotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof InvalidRunStateError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });

  // Ticket 13 AC2: publication is local-admin-only — never on app.ts's
  // remote or collaborator allowlists, and DurableWorkEngine.publish() itself
  // refuses any collaborator actor through the same decidePolicy() every
  // transport shares, so a collaborator device reaching this path by any
  // route still gets the same 403.
  app.post('/api/runs/:id/publish', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { target?: unknown } | undefined | null;
    if (body?.target !== undefined && !isPublicationTarget(body.target)) {
      return reply.code(400).send({ error: 'target must be push or draft-pull-request' });
    }
    try {
      return await workEngine.publish(id, { target: body?.target as PublicationTarget | undefined }, deps.resolveActor?.(request));
    } catch (error) {
      if (handlePolicyDenied(error, reply)) return;
      if (error instanceof RunNotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof InvalidRunStateError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });

  // Ticket 12 AC1/AC4: admin-only, exactly like publish — enforced inside
  // DurableWorkEngine.remove() via the same decidePolicy() every transport
  // reaches, never a REST-only check. A Run still in progress is refused
  // (400), never silently stopped and removed in one step.
  app.delete('/api/runs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await workEngine.remove(id, deps.resolveActor?.(request));
      return reply.code(204).send();
    } catch (error) {
      if (handlePolicyDenied(error, reply)) return;
      if (error instanceof RunNotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof InvalidRunStateError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });

  app.post('/api/runs/:id/cancel', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await workEngine.cancel(id, deps.resolveActor?.(request));
    } catch (error) {
      if (handlePolicyDenied(error, reply)) return;
      if (error instanceof RunNotFoundError) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });

  // Ticket 07 AC2: the one policy path every transport's approve/deny/
  // provide-input command reaches — local UI and mobile UI both call these
  // three REST routes (see app.ts's isRemoteAllowedRoute for the mobile
  // allowlist entry), and the WS 'run_attention_resolve' frame (ws.ts) calls
  // the exact same workEngine.resolveAttention() method, not a parallel
  // implementation.
  const resolveAttention = async (
    request: FastifyRequest,
    reply: FastifyReply,
    decision: AttentionDecisionInput,
  ) => {
    const { id, attentionId } = request.params as { id: string; attentionId: string };
    try {
      return await workEngine.resolveAttention(id, attentionId, decision, deps.resolveActor?.(request));
    } catch (error) {
      if (handlePolicyDenied(error, reply)) return;
      if (error instanceof RunNotFoundError || error instanceof RunAttentionNotPendingError) {
        return reply.code(404).send({ error: error.message });
      }
      if (error instanceof InvalidRunStateError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  };

  app.post('/api/runs/:id/attention/:attentionId/approve', async (request, reply) => resolveAttention(request, reply, { kind: 'approve' }));
  app.post('/api/runs/:id/attention/:attentionId/deny', async (request, reply) => resolveAttention(request, reply, { kind: 'deny' }));
  app.post('/api/runs/:id/attention/:attentionId/input', async (request, reply) => {
    const body = request.body as { value?: unknown } | undefined;
    if (!nonEmptyString(body?.value)) return reply.code(400).send({ error: 'value must be a non-empty string' });
    return resolveAttention(request, reply, { kind: 'input', value: body.value });
  });
}
