// Issue #80: owner-only routes for folder grants and personal tasks
// (inventories, filing proposals from issue #81, and approving and carrying
// out a proposal from issue #82). None of these paths is on app.ts's remote
// or collaborator allowlists. Issue #87 opens the task and decision routes,
// and nothing else, to a paired owner phone; resolveOwner repeats the check
// so the routes stay owner-only even if an allowlist later widens, and
// choosing or revoking a folder stays on the Mac.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { GrantPathError } from '../personal-tasks/folder-grant.js';
import { FolderPickerUnavailableError, type FolderPicker } from '../personal-tasks/folder-picker.js';
import { PersonalTaskError, type PersonalTaskService } from '../personal-tasks/service.js';
import type { PersonalActor } from '../personal-tasks/types.js';
import type { OwnerDeviceAudit } from '../store/owner-devices.js';
import { resolveLocalPrincipal } from '../work-engine/principal.js';

export interface PersonalTaskRouteDeps {
  service: PersonalTaskService;
  pickFolder: FolderPicker;
  /** The owner acting at this Mac or from a paired owner phone, or undefined for any other caller. */
  resolveOwner: (request: FastifyRequest) => PersonalActor | undefined;
  /** Records what a paired owner phone asked for (issue #87). */
  audit?: (deviceId: string, action: OwnerDeviceAudit['action'], targetId: string) => void;
}

/** The device id of the owner acting at this Mac rather than from a paired phone. */
const THIS_MAC = 'local';

export function localOwnerActor(): PersonalActor {
  return { principal: resolveLocalPrincipal(), device: { id: THIS_MAC, label: 'This Mac' } };
}

/** The same owner Principal as at the Mac, attributed to the phone that acted. */
export function ownerPhoneActor(device: { id: string; label: string }): PersonalActor {
  return { principal: resolveLocalPrincipal(), device: { id: device.id, label: device.label } };
}

const PERSONAL_TASK_ERROR_STATUS: Record<PersonalTaskError['code'], number> = {
  'not-found': 404,
  'grant-revoked': 409,
  'invalid-input': 400,
  'invalid-state': 409,
  'stale-plan': 409,
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
    // A phone's request is refused before any effect when it cannot be audited.
    else if (actor.device.id !== THIS_MAC && !deps.audit) {
      void reply.code(503).send({ error: 'Owner phone audit is unavailable.' });
      return undefined;
    }
    return actor;
  };

  /** Folder choice needs the native picker, so it is never made from a phone. */
  const ownerAtMac = (request: FastifyRequest, reply: FastifyReply): PersonalActor | undefined => {
    const actor = owner(request, reply);
    if (actor && actor.device.id !== THIS_MAC) {
      void reply.code(403).send({ error: 'Choose or revoke folders on the Mac.' });
      return undefined;
    }
    return actor;
  };

  const audit = (actor: PersonalActor, action: OwnerDeviceAudit['action'], taskId: string) => {
    if (actor.device.id !== THIS_MAC) deps.audit?.(actor.device.id, action, taskId);
  };

  app.get('/api/personal/grants', async (request, reply) => {
    if (!owner(request, reply)) return reply;
    return service.listGrants();
  });

  app.post('/api/personal/grants/pick', async (request, reply) => {
    const actor = ownerAtMac(request, reply);
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
    if (!ownerAtMac(request, reply)) return reply;
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
    if (body.kind !== 'pdf-inventory' && body.kind !== 'pdf-filing-proposal') {
      return reply.code(400).send({ error: 'kind must be pdf-inventory or pdf-filing-proposal', code: 'invalid-input' });
    }
    if (typeof body.grantId !== 'string' || !body.grantId) return reply.code(400).send({ error: 'grantId is required', code: 'invalid-input' });
    if (!Array.isArray(body.files)) return reply.code(400).send({ error: 'files must be a list of PDFs', code: 'invalid-input' });
    try {
      const input = { grantId: body.grantId, files: body.files as string[] };
      const task = body.kind === 'pdf-inventory' ? service.submitInventory(input, actor) : service.submitFilingProposal(input, actor);
      audit(actor, 'personal-task-submit', task.id);
      return reply.code(201).send(task);
    } catch (error) {
      return sendError(error, reply);
    }
  });

  // Issue #82: approve the exact plan the owner reviewed (by its digest) and
  // carry it out. Repeating the same approval returns the one on record.
  app.post('/api/personal/tasks/:id/filing/approve', async (request, reply) => {
    const actor = owner(request, reply);
    if (!actor) return reply;
    const body = (request.body ?? {}) as { planDigest?: unknown; overwrite?: unknown };
    const { id } = request.params as { id: string };
    try {
      const task = service.approveFiling(id, { planDigest: body.planDigest, overwrite: body.overwrite }, actor);
      audit(actor, 'filing-approve', id);
      return task;
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.post('/api/personal/tasks/:id/filing/:action', async (request, reply) => {
    const actor = owner(request, reply);
    if (!actor) return reply;
    const { id, action } = request.params as { id: string; action: string };
    if (action !== 'retry' && action !== 'undo') return reply.code(404).send({ error: 'No such filing action.' });
    const body = (request.body ?? {}) as { idempotencyKey?: unknown };
    try {
      const result = service.filingAction(id, action, body.idempotencyKey);
      audit(actor, action === 'retry' ? 'filing-retry' : 'filing-undo', id);
      return result;
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.post('/api/personal/tasks/:id/retry', async (request, reply) => {
    const actor = owner(request, reply);
    if (!actor) return reply;
    const { id } = request.params as { id: string };
    try {
      const task = service.retry(id);
      audit(actor, 'personal-task-retry', id);
      return task;
    } catch (error) {
      return sendError(error, reply);
    }
  });
}
