// Ticket 11: named collaborators and their individually revocable device
// credentials (CONTEXT.md's Principal, extended past the single local
// bootstrap admin -- see work-engine/principal.ts's comment). Bearer
// secrets (invitation codes, device tokens) never appear on these
// projections; only CollaboratorService.inviteCollaborator/exchangeInvitation
// hand one back, exactly once, at the moment it is minted.

/** The authenticated collaborator identity (CONTEXT.md's Principal), distinct from a device. */
export interface Collaborator {
  readonly id: string;
  readonly displayName: string;
  readonly createdAt: string;
  /** Repository ids this Principal may view (ticket 11) and, together with grantedProfileIds, launch and guide Runs on (ticket 12). Empty until the admin grants one. */
  readonly grantedRepositoryIds: readonly string[];
  /** Ticket 12 AC1: admin-approved Profile ids this Principal may submit a Run against. Empty until the admin grants one. */
  readonly grantedProfileIds: readonly string[];
}

/** A one-time code the bootstrap admin hands a collaborator out of band, exchanged for a DeviceCredential. Never carries the raw code. */
export interface Invitation {
  readonly id: string;
  readonly collaboratorId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly consumedAt?: string;
}

/** An individually revocable bearer credential bound to one collaborator's device. Never carries the raw token. */
export interface DeviceCredential {
  readonly id: string;
  readonly collaboratorId: string;
  readonly deviceLabel: string;
  readonly createdAt: string;
  readonly revokedAt?: string;
}

/**
 * What CollaboratorService.resolveDevice returns for an active device
 * token -- structurally identical to connection-trust.ts's RemoteDevice
 * (which this module deliberately doesn't import, to keep collaborators/
 * free of server/ dependencies) so every caller can pass it straight
 * through as classify()'s `deviceLookup` result with no adapter mapping.
 */
export interface ResolvedDevice {
  readonly id: string;
  readonly label: string;
  readonly principal: { readonly id: string; readonly displayName: string };
  readonly grantedRepositoryIds: readonly string[];
  /** Ticket 12 AC1. */
  readonly grantedProfileIds: readonly string[];
}

export class InvitationExpiredError extends Error {
  constructor() { super('This invitation has expired.'); this.name = 'InvitationExpiredError'; }
}
export class InvitationAlreadyConsumedError extends Error {
  constructor() { super('This invitation has already been used.'); this.name = 'InvitationAlreadyConsumedError'; }
}
export class InvitationNotFoundError extends Error {
  constructor() { super('No such invitation code.'); this.name = 'InvitationNotFoundError'; }
}
export class CollaboratorNotFoundError extends Error {
  constructor() { super('No such collaborator.'); this.name = 'CollaboratorNotFoundError'; }
}
export class DeviceNotFoundError extends Error {
  constructor() { super('No such device.'); this.name = 'DeviceNotFoundError'; }
}
