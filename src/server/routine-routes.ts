// Issue #92: owner-only routes for saving a PDF or email request as a
// routine and running it again. Like /api/personal/email/*, none of these
// paths is on app.ts's remote, collaborator, or owner-phone allowlists, and
// each handler re-checks that the request comes from the owner at this Mac.
// A run only submits a new task; approving what it proposes stays on the
// task's own routes.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { RoutineError, type RoutineService } from '../personal-tasks/routines/service.js';
import type { PersonalActor } from '../personal-tasks/types.js';

export interface RoutineRouteDeps {
  service: RoutineService;
  /** The owner at this Mac, or undefined for any other caller. */
  resolveOwner: (request: FastifyRequest) => PersonalActor | undefined;
}

const ERROR_STATUS: Record<RoutineError['code'], number> = {
  'not-found': 404,
  'invalid-input': 400,
  'invalid-state': 409,
  'grant-revoked': 409,
  'account-revoked': 409,
};

export function registerRoutineRoutes(app: FastifyInstance, deps: RoutineRouteDeps): void {
  const { service } = deps;

  const handle = (work: (actor: PersonalActor, request: FastifyRequest, reply: FastifyReply) => unknown) => async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = deps.resolveOwner(request);
    if (!actor) return reply.code(403).send({ error: 'Routines are only available to the owner on this Mac.' });
    try {
      return await work(actor, request, reply);
    } catch (error) {
      if (error instanceof RoutineError) return reply.code(ERROR_STATUS[error.code]).send({ error: error.message, code: error.code });
      throw error;
    }
  };
  const id = (request: FastifyRequest) => (request.params as { id: string }).id;
  const body = (request: FastifyRequest) => (request.body ?? {}) as Record<string, unknown>;

  app.get('/api/personal/routines', handle(() => service.list()));
  app.get('/api/personal/routines/:id', handle((_actor, request, reply) => service.get(id(request)) ?? reply.code(404).send({ error: 'No such routine.' })));
  app.post('/api/personal/routines', handle((actor, request, reply) => {
    const { name, source, taskId } = body(request);
    return reply.code(201).send(service.save({ name, source, taskId }, actor));
  }));
  app.patch('/api/personal/routines/:id', handle((_actor, request) => {
    const { name, grantId, accountId } = body(request);
    return service.update(id(request), { name, grantId, accountId });
  }));
  app.delete('/api/personal/routines/:id', handle((_actor, request, reply) => {
    service.remove(id(request));
    return reply.code(204).send();
  }));
  // Rechecks the grant or account and starts one new task, or records why it could not.
  app.post('/api/personal/routines/:id/run', handle(async (actor, request) => ({
    run: await service.run(id(request), actor),
    routine: service.get(id(request)),
  })));
}
