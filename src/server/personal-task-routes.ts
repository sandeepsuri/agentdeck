// Issue #80: owner-only routes for folder grants and personal tasks. None of
// these paths is on app.ts's remote or collaborator allowlists, so a remote
// request is refused before it reaches here; resolveOwner repeats the check
// so the routes stay owner-only even if an allowlist later widens.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { GrantPathError } from '../personal-tasks/folder-grant.js';
import { FolderPickerUnavailableError, type FolderPicker } from '../personal-tasks/folder-picker.js';
import { PersonalTaskError, type PersonalTaskService } from '../personal-tasks/service.js';
import type { PersonalActor } from '../personal-tasks/types.js';
import { resolveLocalPrincipal } from '../work-engine/principal.js';

export interface PersonalTaskRouteDeps {
  service: PersonalTaskService;
  pickFolder: FolderPicker;
  /** The owner acting at this Mac, or undefined for any other caller. */
  resolveOwner: (request: FastifyRequest) => PersonalActor | undefined;
}

export function localOwnerActor(): PersonalActor {
  return { principal: resolveLocalPrincipal(), device: { id: 'local', label: 'This Mac' } };
}

const PERSONAL_TASK_ERROR_STATUS: Record<PersonalTaskError['code'], number> = {
  'not-found': 404,
  'grant-revoked': 409,
  'invalid-input': 400,
  'invalid-state': 409,
};

function sendError(error: unknown, reply: FastifyReply): FastifyReply {
  if (error instanceof GrantPathError) return reply.code(400).send({ error: error.message, code: error.code });
  if (error instanceof PersonalTaskError) {
    return reply.code(PERSONAL_TASK_ERROR_STATUS[error.code]).send({ error: error.message, code: error.code });
  }
  if (error instanceof FolderPickerUnavailableError) return reply.code(503).send({ error: error.message, code: 'picker-unavailable' });
  throw error;
}

export function registerPersonalTaskRoutes(app: FastifyInstance, deps: PersonalTaskRouteDeps): void {
  const { service } = deps;
  let pickerOpen = false;

  const owner = (request: FastifyRequest, reply: FastifyReply): PersonalActor | undefined => {
    const actor = deps.resolveOwner(request);
    if (!actor) void reply.code(403).send({ error: 'Personal tasks are only available to the owner on this Mac.' });
    return actor;
  };

  app.get('/api/personal/grants', async (request, reply) => {
    if (!owner(request, reply)) return reply;
    return service.listGrants();
  });

  app.post('/api/personal/grants/pick', async (request, reply) => {
    const actor = owner(request, reply);
    if (!actor) return reply;
    if (pickerOpen) return reply.code(409).send({ error: 'The folder picker is already open on this Mac.', code: 'picker-open' });
    pickerOpen = true;
    try {
      const selected = await deps.pickFolder();
      if (selected === undefined) return { cancelled: true };
      return reply.code(201).send({ grant: service.createGrant(selected, actor) });
    } catch (error) {
      return sendError(error, reply);
    } finally {
      pickerOpen = false;
    }
  });

  app.post('/api/personal/grants/:id/revoke', async (request, reply) => {
    if (!owner(request, reply)) return reply;
    const { id } = request.params as { id: string };
    service.revokeGrant(id);
    const grant = service.getGrant(id);
    return grant ? { grant } : reply.code(404).send({ error: 'No such folder grant.' });
  });

  app.get('/api/personal/grants/:id/pdfs', async (request, reply) => {
    if (!owner(request, reply)) return reply;
    try {
      return service.listGrantPdfs((request.params as { id: string }).id);
    } catch (error) {
      if (error instanceof GrantPathError) return reply.code(409).send({ error: error.message, code: error.code });
      return sendError(error, reply);
    }
  });

  app.get('/api/personal/tasks', async (request, reply) => {
    if (!owner(request, reply)) return reply;
    return service.list();
  });

  app.get('/api/personal/tasks/:id', async (request, reply) => {
    if (!owner(request, reply)) return reply;
    const task = service.get((request.params as { id: string }).id);
    return task ?? reply.code(404).send({ error: 'No such task.' });
  });

  app.post('/api/personal/tasks', async (request, reply) => {
    const actor = owner(request, reply);
    if (!actor) return reply;
    const body = (request.body ?? {}) as { kind?: unknown; grantId?: unknown; files?: unknown };
    if (body.kind !== 'pdf-inventory') return reply.code(400).send({ error: 'kind must be pdf-inventory', code: 'invalid-input' });
    if (typeof body.grantId !== 'string' || !body.grantId) return reply.code(400).send({ error: 'grantId is required', code: 'invalid-input' });
    if (!Array.isArray(body.files)) return reply.code(400).send({ error: 'files must be a list of PDFs', code: 'invalid-input' });
    try {
      return reply.code(201).send(service.submitInventory({ grantId: body.grantId, files: body.files as string[] }, actor));
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.post('/api/personal/tasks/:id/retry', async (request, reply) => {
    if (!owner(request, reply)) return reply;
    try {
      return service.retry((request.params as { id: string }).id);
    } catch (error) {
      return sendError(error, reply);
    }
  });
}
