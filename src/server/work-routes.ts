import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { deriveRunAttentionItems } from '../attention.js';
import {
  InvalidRunStateError, InvalidWorkSpecError, RunAttentionNotPendingError, RunNotFoundError, RunPreparationError,
  UnsupportedRuntimeError,
} from '../work-engine/engine.js';
import type { AttentionDecisionInput, WorkEngine, WorkSpec } from '../work-engine/types.js';
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
  app.get('/api/runs/attention', async () => deriveRunAttentionItems(workEngine.list()));

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

  app.post('/api/runs', async (request, reply) => {
    try {
      const run = await workEngine.submit(request.body as WorkSpec);
      return reply.code(201).send(run);
    } catch (error) {
      if (error instanceof InvalidWorkSpecError) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post('/api/runs/:id/prepare', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await workEngine.prepare(id);
    } catch (error) {
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
      return await workEngine.start(id);
    } catch (error) {
      if (error instanceof RunNotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof InvalidRunStateError || error instanceof UnsupportedRuntimeError) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post('/api/runs/:id/cancel', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await workEngine.cancel(id);
    } catch (error) {
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
      return await workEngine.resolveAttention(id, attentionId, decision);
    } catch (error) {
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
