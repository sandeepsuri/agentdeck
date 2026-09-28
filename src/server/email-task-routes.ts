// Issues #88 and #89: owner-only routes for connecting Gmail, finding an
// email, preparing an editable reply draft, and approving the one send of a
// saved version. Like /api/personal/*, none of these paths is on app.ts's
// remote, collaborator, or owner-phone allowlists, and each handler re-checks
// that the request comes from the owner at this Mac.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { EmailTaskError, type EmailTaskService } from '../personal-tasks/email/service.js';
import type { PersonalActor } from '../personal-tasks/types.js';

export interface EmailTaskRouteDeps {
  service: EmailTaskService;
  /** The owner at this Mac, or undefined for any other caller. */
  resolveOwner: (request: FastifyRequest) => PersonalActor | undefined;
}

const ERROR_STATUS: Record<EmailTaskError['code'], number> = {
  'not-found': 404,
  'account-revoked': 409,
  'invalid-input': 400,
  'invalid-state': 409,
  'stale-draft': 409,
  'account-unavailable': 409,
  'no-client': 503,
  unsupported: 422,
  'consent-failed': 409,
  'send-exists': 409,
};

function sendError(error: unknown, reply: FastifyReply): FastifyReply {
  if (error instanceof EmailTaskError) return reply.code(ERROR_STATUS[error.code]).send({ error: error.message, code: error.code });
  throw error;
}

export function registerEmailTaskRoutes(app: FastifyInstance, deps: EmailTaskRouteDeps): void {
  const { service } = deps;

  const owner = (request: FastifyRequest, reply: FastifyReply): PersonalActor | undefined => {
    const actor = deps.resolveOwner(request);
    if (!actor) void reply.code(403).send({ error: 'Email replies are only available to the owner on this Mac.' });
    return actor;
  };

  const handle = (work: (actor: PersonalActor, request: FastifyRequest) => unknown) => async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = owner(request, reply);
    if (!actor) return reply;
    try {
      return await work(actor, request);
    } catch (error) {
      return sendError(error, reply);
    }
  };
  const id = (request: FastifyRequest) => (request.params as { id: string }).id;
  const body = (request: FastifyRequest) => (request.body ?? {}) as Record<string, unknown>;

  app.get('/api/personal/email/accounts', handle(() => service.listAccounts()));
  // Holds the request open while the owner finishes consent in the browser.
  app.post('/api/personal/email/accounts/connect', async (request, reply) => {
    const actor = owner(request, reply);
    if (!actor) return reply;
    try {
      return reply.code(201).send({ account: await service.connectAccount(actor) });
    } catch (error) {
      return sendError(error, reply);
    }
  });
  app.post('/api/personal/email/accounts/:id/check', handle((_actor, request) => service.checkAccount(id(request))));
  app.post('/api/personal/email/accounts/:id/revoke', handle((_actor, request) => service.revokeAccount(id(request))));

  app.get('/api/personal/email/tasks', handle(() => service.list()));
  app.get('/api/personal/email/tasks/:id', async (request, reply) => {
    if (!owner(request, reply)) return reply;
    return service.get(id(request)) ?? reply.code(404).send({ error: 'No such task.' });
  });
  app.post('/api/personal/email/tasks', async (request, reply) => {
    const actor = owner(request, reply);
    if (!actor) return reply;
    try {
      const { accountId, request: words } = body(request);
      return reply.code(201).send(service.submit({ accountId, request: words }, actor));
    } catch (error) {
      return sendError(error, reply);
    }
  });
  app.post('/api/personal/email/tasks/:id/retry', handle((_actor, request) => service.retry(id(request))));
  app.post('/api/personal/email/tasks/:id/confirm', handle((actor, request) => service.confirm(id(request), { messageId: body(request).messageId }, actor)));
  app.post('/api/personal/email/tasks/:id/draft', handle((actor, request) => {
    const { baseVersion, to, cc, subject, body: text } = body(request);
    return service.saveDraft(id(request), { baseVersion, to, cc, subject, body: text }, actor);
  }));
  app.post('/api/personal/email/tasks/:id/draft/check', handle((actor, request) => service.checkDraft(id(request), actor)));
  // Approves one saved version by its digest and sends it once; repeating the same approval returns the send on record.
  app.post('/api/personal/email/tasks/:id/send', handle((actor, request) => {
    const { version, digest } = body(request);
    return service.approveSend(id(request), { version, digest }, actor);
  }));
}
