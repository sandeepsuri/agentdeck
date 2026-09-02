// Ticket 11 REST surface: the bootstrap local admin's Collaborators panel
// (invitation issuance, device listing/revocation, grant edits) plus the
// one route a brand-new collaborator device can reach before it has any
// bearer token at all -- POST /api/collaborators/exchange, exempted from
// the token gate in app.ts's onRequest hook the same way GET /api/connection
// already is (see the comment there).
import type { FastifyInstance } from 'fastify';
import type { CollaboratorService } from '../collaborators/service.js';
import {
  CollaboratorNotFoundError, DeviceNotFoundError, InvitationAlreadyConsumedError, InvitationExpiredError,
  InvitationNotFoundError,
} from '../collaborators/types.js';
import { nonEmptyString } from './validate.js';

const MAX_DISPLAY_NAME_LENGTH = 200;
const MAX_DEVICE_LABEL_LENGTH = 200;
const MAX_CODE_LENGTH = 512;
const MAX_REPOSITORY_IDS = 500;
const MAX_REPOSITORY_ID_LENGTH = 500;

function parseRepositoryIds(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_REPOSITORY_IDS) return undefined;
  if (!value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= MAX_REPOSITORY_ID_LENGTH)) return undefined;
  return value as string[];
}

export function registerCollaboratorRoutes(app: FastifyInstance, collaborators: CollaboratorService): void {
  // AC1: bootstrap local admin action -- local-only (app.ts's
  // isRemoteAllowedRoute never lists these /api/collaborators/* admin
  // routes), so a remote connection can never mint its own invitations or
  // read the collaborator roster.
  app.post('/api/collaborators', async (req, reply) => {
    const body = req.body as { displayName?: unknown; grantedRepositoryIds?: unknown } | null;
    if (!nonEmptyString(body?.displayName, MAX_DISPLAY_NAME_LENGTH)) {
      return reply.code(400).send({ error: 'displayName is required' });
    }
    const grantedRepositoryIds = parseRepositoryIds(body?.grantedRepositoryIds);
    if (grantedRepositoryIds === undefined) return reply.code(400).send({ error: 'grantedRepositoryIds must be an array of strings' });
    const { collaborator, invitation, code } = collaborators.inviteCollaborator({
      displayName: body!.displayName as string, grantedRepositoryIds,
    });
    return reply.code(201).send({ collaborator, invitation, code });
  });

  app.get('/api/collaborators', async () => collaborators.listCollaborators().map((collaborator) => ({
    ...collaborator,
    devices: collaborators.listDevices(collaborator.id),
  })));

  app.patch('/api/collaborators/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { grantedRepositoryIds?: unknown } | null;
    const grantedRepositoryIds = parseRepositoryIds(body?.grantedRepositoryIds);
    if (grantedRepositoryIds === undefined) return reply.code(400).send({ error: 'grantedRepositoryIds must be an array of strings' });
    try {
      return collaborators.updateGrants(id, grantedRepositoryIds);
    } catch (error) {
      if (error instanceof CollaboratorNotFoundError) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });

  app.post('/api/collaborators/:id/invitations', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const { invitation, code, collaborator } = collaborators.inviteCollaborator({ collaboratorId: id });
      return reply.code(201).send({ collaborator, invitation, code });
    } catch (error) {
      if (error instanceof CollaboratorNotFoundError) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });

  // AC5: revoking is immediate -- resolveDevice() re-checks on every
  // request, and CollaboratorService.revokeDevice's onRevoke hook lets
  // ws.ts terminate any already-open WebSocket for this device right now
  // (see attachWs's wiring in server/ws.ts), without disturbing any other
  // device.
  app.post('/api/collaborators/devices/:deviceId/revoke', async (req, reply) => {
    const { deviceId } = req.params as { deviceId: string };
    try {
      return collaborators.revokeDevice(deviceId);
    } catch (error) {
      if (error instanceof DeviceNotFoundError) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });

  // AC1: the one collaborator-facing route -- a brand-new device has no
  // bearer token yet, so this must work pre-authentication, the same
  // exemption app.ts already carves out for GET /api/connection.
  app.post('/api/collaborators/exchange', async (req, reply) => {
    const body = req.body as { code?: unknown; deviceLabel?: unknown } | null;
    if (!nonEmptyString(body?.code, MAX_CODE_LENGTH)) return reply.code(400).send({ error: 'code is required' });
    if (body?.deviceLabel !== undefined && !nonEmptyString(body.deviceLabel, MAX_DEVICE_LABEL_LENGTH)) {
      return reply.code(400).send({ error: 'deviceLabel must be a non-empty string' });
    }
    try {
      const { device, token, collaborator } = collaborators.exchangeInvitation(
        body!.code as string, (body?.deviceLabel as string | undefined) ?? '',
      );
      return reply.code(201).send({ device, token, principal: { id: collaborator.id, displayName: collaborator.displayName } });
    } catch (error) {
      if (
        error instanceof InvitationNotFoundError || error instanceof InvitationAlreadyConsumedError
        || error instanceof InvitationExpiredError
      ) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
  });
}
