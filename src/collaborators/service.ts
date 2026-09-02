// Ticket 11: the bootstrap local admin invites named collaborators and
// issues individually revocable device access for viewing authorized Runs
// and Repositories over the tailnet. This module owns the whole lifecycle
// -- invitation, exchange, resolution, revocation -- so connection-trust.ts
// (the single place a connection's authority is decided, see its own header
// comment) only ever needs one lookup function, never SQL or hashing of its
// own.
//
// Bearer secrets (invitation codes, device tokens) are high-entropy random
// values, generated fresh and returned to the caller exactly once. Only a
// SHA-256 hash is ever persisted (CollaboratorStore), so a stolen database
// reveals no bearer value that was ever issued -- unlike a password, a
// stolen hash cannot be replayed as the secret itself, and offline
// brute-force is infeasible against 192 bits of entropy, so no
// slow/salted KDF (bcrypt/scrypt) is needed the way it would be for a
// user-chosen password.
import crypto from 'node:crypto';
import type {
  Collaborator, DeviceCredential, Invitation, ResolvedDevice,
} from './types.js';
import {
  CollaboratorNotFoundError, DeviceNotFoundError, InvitationAlreadyConsumedError,
  InvitationExpiredError, InvitationNotFoundError,
} from './types.js';

export interface CollaboratorRow {
  id: string;
  displayName: string;
  createdAt: string;
  grantedRepositoryIds: string[];
}

export interface InvitationRow {
  id: string;
  collaboratorId: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
}

export interface DeviceRow {
  id: string;
  collaboratorId: string;
  deviceLabel: string;
  createdAt: string;
  revokedAt?: string;
}

/** The persistence surface CollaboratorService needs -- implemented by store/index.ts's Store. Kept narrow and store-agnostic so this module stays unit-testable with an in-memory fake (see service.test.ts). */
export interface CollaboratorStore {
  createCollaborator(row: CollaboratorRow): void;
  getCollaborator(id: string): CollaboratorRow | undefined;
  listCollaborators(): CollaboratorRow[];
  updateCollaboratorGrants(id: string, grantedRepositoryIds: string[]): void;

  createInvitation(row: InvitationRow, codeHash: string): void;
  getInvitationByCodeHash(codeHash: string): InvitationRow | undefined;
  consumeInvitation(id: string, consumedAt: string): void;

  createDevice(row: DeviceRow, tokenHash: string): void;
  getDeviceByTokenHash(tokenHash: string): DeviceRow | undefined;
  getDevice(id: string): DeviceRow | undefined;
  listDevices(collaboratorId?: string): DeviceRow[];
  revokeDevice(id: string, revokedAt: string): void;
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function randomBearer(bytes: number): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

function toCollaborator(row: CollaboratorRow): Collaborator {
  return {
    id: row.id, displayName: row.displayName, createdAt: row.createdAt,
    grantedRepositoryIds: row.grantedRepositoryIds,
  };
}

function toInvitation(row: InvitationRow): Invitation {
  const invitation: Invitation = {
    id: row.id, collaboratorId: row.collaboratorId, createdAt: row.createdAt, expiresAt: row.expiresAt,
  };
  return row.consumedAt !== undefined ? { ...invitation, consumedAt: row.consumedAt } : invitation;
}

function toDevice(row: DeviceRow): DeviceCredential {
  const device: DeviceCredential = {
    id: row.id, collaboratorId: row.collaboratorId, deviceLabel: row.deviceLabel, createdAt: row.createdAt,
  };
  return row.revokedAt !== undefined ? { ...device, revokedAt: row.revokedAt } : device;
}

const INVITATION_TTL_MS = 24 * 60 * 60 * 1000;

export class CollaboratorService {
  private readonly revokeListeners = new Set<(deviceId: string) => void>();

  constructor(
    private readonly store: CollaboratorStore,
    private readonly deps: { now?: () => Date; randomId?: () => string } = {},
  ) {}

  /**
   * AC5: lets ws.ts terminate any already-open WebSocket for a device the
   * instant it's revoked, without ws.ts and the REST revoke route needing a
   * direct reference to each other. REST access needs no equivalent hook --
   * resolveDevice() is re-checked fresh on every request, so a revoked
   * device's next REST call fails on its own.
   */
  onRevoke(listener: (deviceId: string) => void): void {
    this.revokeListeners.add(listener);
  }

  private now(): Date { return this.deps.now?.() ?? new Date(); }
  private randomId(): string { return this.deps.randomId?.() ?? crypto.randomUUID(); }

  listCollaborators(): Collaborator[] {
    return this.store.listCollaborators().map(toCollaborator);
  }

  listDevices(collaboratorId?: string): DeviceCredential[] {
    return this.store.listDevices(collaboratorId).map(toDevice);
  }

  updateGrants(collaboratorId: string, grantedRepositoryIds: readonly string[]): Collaborator {
    if (!this.store.getCollaborator(collaboratorId)) throw new CollaboratorNotFoundError();
    const unique = [...new Set(grantedRepositoryIds)];
    this.store.updateCollaboratorGrants(collaboratorId, unique);
    return toCollaborator(this.store.getCollaborator(collaboratorId)!);
  }

  /**
   * AC1: the bootstrap local admin creates a named invitation. `collaboratorId`
   * reuses an existing collaborator (issuing them a second device); omit it
   * to name a brand-new collaborator. The returned `code` is the only time
   * this bearer value ever leaves this module -- callers must hand it to
   * the collaborator out of band and never log or persist it themselves.
   */
  inviteCollaborator(input: {
    displayName?: string;
    collaboratorId?: string;
    grantedRepositoryIds?: readonly string[];
    ttlMs?: number;
  }): { invitation: Invitation; code: string; collaborator: Collaborator } {
    const now = this.now();
    let collaboratorRow: CollaboratorRow;
    if (input.collaboratorId) {
      const existing = this.store.getCollaborator(input.collaboratorId);
      if (!existing) throw new CollaboratorNotFoundError();
      collaboratorRow = existing;
    } else {
      if (!input.displayName || input.displayName.trim().length === 0) {
        throw new Error('displayName is required to name a new collaborator.');
      }
      collaboratorRow = {
        id: this.randomId(),
        displayName: input.displayName.trim(),
        createdAt: now.toISOString(),
        grantedRepositoryIds: [...new Set(input.grantedRepositoryIds ?? [])],
      };
      this.store.createCollaborator(collaboratorRow);
    }

    const code = randomBearer(24);
    const invitationRow: InvitationRow = {
      id: this.randomId(),
      collaboratorId: collaboratorRow.id,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + (input.ttlMs ?? INVITATION_TTL_MS)).toISOString(),
    };
    this.store.createInvitation(invitationRow, sha256Hex(code));
    return { invitation: toInvitation(invitationRow), code, collaborator: toCollaborator(collaboratorRow) };
  }

  /**
   * AC1/AC2: exchanges a one-time invitation code for a durable, individually
   * revocable device credential. The returned `token` is the only time this
   * bearer value ever leaves this module -- only its hash is stored
   * (AC2), so it cannot be recovered or displayed again after this call
   * returns.
   */
  exchangeInvitation(code: string, deviceLabel: string): { device: DeviceCredential; token: string; collaborator: Collaborator } {
    const invitationRow = this.store.getInvitationByCodeHash(sha256Hex(code));
    if (!invitationRow) throw new InvitationNotFoundError();
    if (invitationRow.consumedAt !== undefined) throw new InvitationAlreadyConsumedError();
    const now = this.now();
    if (new Date(invitationRow.expiresAt).getTime() <= now.getTime()) throw new InvitationExpiredError();

    const collaboratorRow = this.store.getCollaborator(invitationRow.collaboratorId);
    if (!collaboratorRow) throw new CollaboratorNotFoundError();

    this.store.consumeInvitation(invitationRow.id, now.toISOString());

    const token = randomBearer(32);
    const label = deviceLabel.trim().length > 0 ? deviceLabel.trim() : 'Unnamed device';
    const deviceRow: DeviceRow = {
      id: this.randomId(), collaboratorId: collaboratorRow.id, deviceLabel: label, createdAt: now.toISOString(),
    };
    this.store.createDevice(deviceRow, sha256Hex(token));
    return { device: toDevice(deviceRow), token, collaborator: toCollaborator(collaboratorRow) };
  }

  /**
   * AC3: every authenticated remote request resolving through a device
   * credential reaches here. A revoked or unknown token resolves to
   * `undefined` -- same fail-closed shape ConnectionTrust.classify() already
   * uses for a missing/wrong shared token (connection-trust.ts).
   *
   * An arrow-function property (not a prototype method) so every caller —
   * app.ts, routes.ts, ws.ts, index.ts — can pass `ctx.collaborators?.resolveDevice`
   * straight through as classify()'s `deviceLookup` opt with no
   * `(token) => service.resolveDevice(token)` wrapper repeated at each
   * site; a plain method reference would lose its `this` binding once
   * detached like that.
   */
  resolveDevice = (token: string | undefined): ResolvedDevice | undefined => {
    if (!token) return undefined;
    const deviceRow = this.store.getDeviceByTokenHash(sha256Hex(token));
    if (!deviceRow || deviceRow.revokedAt !== undefined) return undefined;
    const collaboratorRow = this.store.getCollaborator(deviceRow.collaboratorId);
    if (!collaboratorRow) return undefined;
    return {
      id: deviceRow.id,
      principal: { id: collaboratorRow.id, displayName: collaboratorRow.displayName },
      grantedRepositoryIds: collaboratorRow.grantedRepositoryIds,
    };
  };

  /** AC5: revocation is immediate and scoped to exactly this device -- every other device (this collaborator's or anyone else's) keeps working. */
  revokeDevice(deviceId: string): DeviceCredential {
    const row = this.store.getDevice(deviceId);
    if (!row) throw new DeviceNotFoundError();
    if (row.revokedAt === undefined) {
      this.store.revokeDevice(deviceId, this.now().toISOString());
      for (const listener of this.revokeListeners) listener(deviceId);
    }
    return toDevice(this.store.getDevice(deviceId)!);
  }
}
