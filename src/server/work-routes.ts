import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { deriveRunAttentionItems } from '../attention.js';
import { collaboratorRunDetail, collaboratorRunSummary } from './collaborator-run-view.js';
import {
  InvalidRunStateError, InvalidWorkSpecError, PolicyDeniedError, RunAttentionNotPendingError, RunNotFoundError,
  RunPreparationError, UnsupportedRuntimeError,
} from '../work-engine/engine.js';
import { resolveLocalPrincipal } from '../work-engine/principal.js';
import { isPublicationTarget } from '../work-engine/publication.js';
import { derivePreviewCandidates } from '../work-engine/run-preview.js';
import { deriveRunResult } from '../work-engine/run-result.js';
import type {
  AttentionDecisionInput, PublicationTarget, RunActor, WorkEngine, WorkRun, WorkSpec,
} from '../work-engine/types.js';
import { listRunFeedback, postRunFeedback, type RunFeedbackStore } from './run-feedback.js';
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
   * Ticket 12 AC1/AC2/AC7: the RunActor a request is made as — undefined for
   * local and legacy-shared-token connections, which stay unrestricted
   * (the Work Engine itself defaults to its own principalSource, exactly
   * pre-ticket-12 behavior). A resolved collaborator device's RunActor
   * carries `grants`, so the SAME DurableWorkEngine.enforcePolicy() every
   * other transport (WebSocket, a direct engine call) reaches makes the
   * actual allow/deny decision here — this route only resolves who's
   * asking, never decides what they may do.
   */
  resolveActor?: (request: FastifyRequest) => RunActor | undefined;
  /**
   * B07: who to attribute a feedback post to — resolved the same way
   * session-conversation.ts's resolveSenderIdentity already does (a
   * collaborator device's own Principal, the local admin's principal, or
   * the label "Shared access" for the legacy tailnet token, which has no
   * individual identity to attribute to). Deliberately not derived from
   * resolveActor above: that resolves to undefined for both the local admin
   * and the legacy shared token, which is the right default for Work
   * Engine authority (both stay unrestricted) but is not enough to tell
   * those two apart for attribution, which the design doc requires.
   * Undefined falls back to the local operator's own principal — the same
   * default DurableWorkEngine.resolveActor uses internally.
   */
  resolveAuthor?: (request: FastifyRequest) => { principalId?: string; displayName: string };
  /** B07: the durable-storage seam POST/GET .../feedback read and write through — Store (store/index.ts) already implements this. */
  runFeedbackStore?: RunFeedbackStore;
  /** Ticket 70 (B10): the ephemeral preview listener POST .../preview starts sessions on — RunPreviewServer (server/run-preview-server.ts) already implements this. */
  runPreviewServer?: RunPreviewStarter;
}

/** The minimal seam POST .../preview needs — satisfied by the real RunPreviewServer, and by a fake in this module's own tests. */
export interface RunPreviewStarter {
  start(input: { runId: string; worktreePath: string; entryPath: string }): Promise<{ previewUrl: string; expiresAt: string }>;
}

function defaultAuthor(): { principalId?: string; displayName: string } {
  const principal = resolveLocalPrincipal();
  return { principalId: principal.id, displayName: principal.displayName };
}

/** Ticket 12 AC1/AC4: a PolicyDeniedError is a 403, everywhere it can surface below — never conflated with InvalidWorkSpecError/InvalidRunStateError's 400s, which mean "the request was malformed," not "you're not allowed." */
function handlePolicyDenied(error: unknown, reply: FastifyReply): boolean {
  if (!(error instanceof PolicyDeniedError)) return false;
  reply.code(403).send({ error: error.message, rule: error.rule });
  return true;
}

/** Local admin REST adapter; all behavior remains owned by WorkEngine. */
export function registerWorkRoutes(app: FastifyInstance, workEngine: WorkEngine, deps: WorkRoutesDeps = {}): void {
  const resolveCollaboratorReadContext = (request: FastifyRequest) => {
    const actor = deps.resolveActor?.(request);
    const granted = deps.resolveGrantedRepositoryIds?.(request);
    if (granted && !actor?.grants) throw new Error('Collaborator Run reads require an authenticated Principal.');
    return { granted, principalId: granted ? actor!.principal.id : undefined };
  };

  /**
   * Resolves, exactly once per request, both halves of "what may this
   * caller read": whether grants apply at all, and the Runs left after
   * filtering. `granted` being defined (even as an empty array) is what
   * marks a named collaborator device -- local and legacy-shared-token
   * connections get `undefined` and, below, the unchanged full WorkRun.
   * Returning both together is deliberate: the filter and the projection
   * must key off the same value, or a caller could be filtered but not
   * narrowed, or narrowed but not filtered.
   */
  const resolveScope = (request: FastifyRequest) => {
    const { granted, principalId } = resolveCollaboratorReadContext(request);
    const runs = workEngine.list();
    return { granted, principalId, runs: granted ? runs.filter((run) => granted.includes(run.spec.repository.id)) : runs };
  };
  const scopeRuns = (request: FastifyRequest) => resolveScope(request).runs;

  /**
   * The shared 404-never-403 grant check GET /api/runs/:id itself
   * establishes: a Run outside a collaborator device's grants doesn't
   * exist as far as it's concerned. Returns undefined for both "no such
   * run" and "ungranted," so every route below that only needs "does this
   * caller get to see this Run at all" (feedback, preview) has one shared
   * place for it, rather than re-deriving the same two-line check each
   * time. GET /api/runs/:id itself still does this inline, since it also
   * needs `principalId` for collaboratorRunDetail — not a fit for this
   * narrower helper.
   */
  const resolveGrantedRun = (request: FastifyRequest, id: string): WorkRun | undefined => {
    const run = workEngine.get(id);
    if (!run) return undefined;
    const { granted } = resolveCollaboratorReadContext(request);
    if (granted && !granted.includes(run.spec.repository.id)) return undefined;
    return run;
  };

  // A collaborator device gets collaborator-run-view.ts's projection rather
  // than the raw WorkRun -- see that module's header for what it drops and
  // why. The admin and legacy-shared-token paths are byte-identical to
  // before, because `granted` is undefined for them.
  app.get('/api/runs', async (request) => {
    const { granted, principalId, runs } = resolveScope(request);
    return granted ? runs.map((run) => collaboratorRunSummary(run, principalId!)) : runs;
  });

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
    const { granted, principalId } = resolveCollaboratorReadContext(request);
    if (granted && !granted.includes(run.spec.repository.id)) return reply.code(404).send({ error: 'no such run' });
    // The Run conversation a collaborator's workspace reads. Narrated, not
    // the raw event log -- a tool-activity summary is the literal command a
    // runtime ran (collaborator-run-view.ts).
    return granted ? collaboratorRunDetail(run, principalId!) : run;
  });

  // Ticket 12 AC5: how the admin actually observes who did what to a
  // collaborator's Run — never on isCollaboratorAllowedRoute (app.ts), so
  // this stays local-only exactly like GET /api/runs/:id's full spec.
  app.get('/api/runs/:id/activity', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!workEngine.get(id)) return reply.code(404).send({ error: 'no such run' });
    return workEngine.listActivity(id);
  });

  /**
   * B07 (docs/specs/run-feedback-review.md): every feedback entry posted
   * against this Run's Task — never restricted to `running`/`completed`,
   * since plain commentary is never routed to a live runtime and must stay
   * readable for any status, including every terminal failure. Grant check
   * is byte-identical to GET /api/runs/:id's own (404, never 403, so a Run
   * outside a collaborator's grant never leaks even its existence).
   */
  app.get('/api/runs/:id/feedback', async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = resolveGrantedRun(request, id);
    if (!run) return reply.code(404).send({ error: 'no such run' });
    if (!deps.runFeedbackStore) return [];
    return listRunFeedback(deps.runFeedbackStore, run.taskId);
  });

  app.post('/api/runs/:id/feedback', async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = resolveGrantedRun(request, id);
    if (!run) return reply.code(404).send({ error: 'no such run' });
    if (!deps.runFeedbackStore) return reply.code(500).send({ error: 'feedback storage is not configured' });
    const body = request.body as { text?: unknown } | null;
    const author = deps.resolveAuthor?.(request) ?? defaultAuthor();
    const result = postRunFeedback(deps.runFeedbackStore, {
      taskId: run.taskId, runId: run.id, principalId: author.principalId, displayName: author.displayName, text: body?.text,
    });
    if (!result.ok) return reply.code(400).send({ error: result.error });
    return reply.code(201).send(result.entry);
  });

  /**
   * Ticket 70 (B10, docs/specs/run-result-application-previews.md): mints a
   * fresh, ephemeral, loopback-only preview session for one already-
   * produced static HTML file (plus same-directory assets) from a settled
   * Run's own result. Deliberately a read-shaped grant check
   * (`resolveCollaboratorReadContext`, byte-identical to GET .../feedback
   * above), not a `decidePolicy`/'guide' call — previewing is "can you see
   * this Run's result," not "can you guide its execution," and
   * `policy.ts`'s own header comment is explicit that `engine.ts` is meant
   * to stay `decidePolicy`'s only caller, so a second, route-level policy
   * path is deliberately not introduced here. In this first slice this
   * makes no practical difference either way: the preview listener never
   * binds the tailnet interface, so a remote collaborator cannot reach it
   * regardless of the grant check's outcome.
   */
  app.post('/api/runs/:id/preview', async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = resolveGrantedRun(request, id);
    if (!run) return reply.code(404).send({ error: 'no such run' });
    if (!deps.runPreviewServer) return reply.code(500).send({ error: 'preview server is not configured' });
    const body = request.body as { path?: unknown } | null;
    if (typeof body?.path !== 'string' || !body.path) return reply.code(400).send({ error: 'path is required' });
    const candidates = derivePreviewCandidates(deriveRunResult(run));
    if (!candidates.some((candidate) => candidate.path === body.path)) {
      return reply.code(400).send({ error: 'path is not a previewable file for this Run' });
    }
    if (run.preparation.state !== 'ready' || !run.preparation.worktreePath) {
      return reply.code(400).send({ error: 'this Run has no prepared worktree to preview' });
    }
    return deps.runPreviewServer.start({ runId: run.id, worktreePath: run.preparation.worktreePath, entryPath: body.path });
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

  // Ticket 68 (B12, docs/specs/run-retry-attempt-history.md): a genuinely
  // new Attempt — a separate resource under the Run, never overloading
  // /start (which keeps its own precise meaning: the Run's first Attempt).
  app.post('/api/runs/:id/attempts', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await workEngine.retryAttempt(id, deps.resolveActor?.(request));
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

  // Ticket 54 (B11): the smallest local-admin transport around the existing
  // engine pause()/resume() — never on isRemoteAllowedRoute or
  // isCollaboratorAllowedRoute (app.ts), so a legacy-shared-token remote
  // connection or a named collaborator device cannot reach either route.
  // All policy (who may guide this Run), safe-boundary timing (pause takes
  // effect only at the engine's next safe boundary, not immediately), and
  // idempotency (repeating pause/resume against an already-settled state)
  // are owned entirely by DurableWorkEngine.pause()/resume() — this adapter
  // only resolves the actor and maps engine errors to HTTP status, exactly
  // like every other route above.
  app.post('/api/runs/:id/pause', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await workEngine.pause(id, deps.resolveActor?.(request));
    } catch (error) {
      if (handlePolicyDenied(error, reply)) return;
      if (error instanceof RunNotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof InvalidRunStateError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });

  app.post('/api/runs/:id/resume', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await workEngine.resume(id, deps.resolveActor?.(request));
    } catch (error) {
      if (handlePolicyDenied(error, reply)) return;
      if (error instanceof RunNotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof InvalidRunStateError) return reply.code(400).send({ error: error.message });
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
