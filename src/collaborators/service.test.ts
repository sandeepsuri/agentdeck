import { describe, expect, it } from 'vitest';
import { CollaboratorService, type CollaboratorRow, type DeviceRow, type InvitationRow, type CollaboratorStore } from './service.js';
import {
  CollaboratorNotFoundError, DeviceNotFoundError, InvitationAlreadyConsumedError, InvitationExpiredError,
  InvitationNotFoundError,
} from './types.js';

/** In-memory fake of the store surface CollaboratorService needs -- keeps this suite a pure unit test of the service's own logic (invitation TTL/consumption, hash-only storage, revocation), not store/index.ts's SQL. */
class FakeCollaboratorStore implements CollaboratorStore {
  collaborators = new Map<string, CollaboratorRow>();
  invitations = new Map<string, InvitationRow>();
  invitationHashes = new Map<string, string>(); // codeHash -> invitationId
  devices = new Map<string, DeviceRow>();
  deviceHashes = new Map<string, string>(); // tokenHash -> deviceId

  createCollaborator(row: CollaboratorRow): void { this.collaborators.set(row.id, { ...row }); }
  getCollaborator(id: string): CollaboratorRow | undefined {
    const row = this.collaborators.get(id);
    return row ? { ...row } : undefined;
  }
  listCollaborators(): CollaboratorRow[] { return [...this.collaborators.values()].map((r) => ({ ...r })); }
  updateCollaboratorGrants(id: string, grants: { repositoryIds: string[]; profileIds: string[] }): void {
    const row = this.collaborators.get(id);
    if (row) { row.grantedRepositoryIds = [...grants.repositoryIds]; row.grantedProfileIds = [...grants.profileIds]; }
  }

  createInvitation(row: InvitationRow, codeHash: string): void {
    this.invitations.set(row.id, { ...row });
    this.invitationHashes.set(codeHash, row.id);
  }
  getInvitationByCodeHash(codeHash: string): InvitationRow | undefined {
    const id = this.invitationHashes.get(codeHash);
    const row = id ? this.invitations.get(id) : undefined;
    return row ? { ...row } : undefined;
  }
  consumeInvitation(id: string, consumedAt: string): void {
    const row = this.invitations.get(id);
    if (row) row.consumedAt = consumedAt;
  }

  createDevice(row: DeviceRow, tokenHash: string): void {
    this.devices.set(row.id, { ...row });
    this.deviceHashes.set(tokenHash, row.id);
  }
  getDeviceByTokenHash(tokenHash: string): DeviceRow | undefined {
    const id = this.deviceHashes.get(tokenHash);
    const row = id ? this.devices.get(id) : undefined;
    return row ? { ...row } : undefined;
  }
  getDevice(id: string): DeviceRow | undefined {
    const row = this.devices.get(id);
    return row ? { ...row } : undefined;
  }
  listDevices(collaboratorId?: string): DeviceRow[] {
    return [...this.devices.values()].filter((r) => !collaboratorId || r.collaboratorId === collaboratorId).map((r) => ({ ...r }));
  }
  revokeDevice(id: string, revokedAt: string): void {
    const row = this.devices.get(id);
    if (row) row.revokedAt = revokedAt;
  }
  removeCollaborator(id: string): void {
    this.collaborators.delete(id);
    for (const [deviceId, row] of this.devices) {
      if (row.collaboratorId === id) this.devices.delete(deviceId);
    }
    for (const [invitationId, row] of this.invitations) {
      if (row.collaboratorId === id) this.invitations.delete(invitationId);
    }
  }
}

function build(now = () => new Date('2026-01-01T00:00:00.000Z')) {
  const store = new FakeCollaboratorStore();
  let counter = 0;
  const service = new CollaboratorService(store, { now, randomId: () => `id-${++counter}` });
  return { store, service };
}

describe('CollaboratorService.inviteCollaborator', () => {
  it('names a new collaborator and returns a one-time code (AC1)', () => {
    const { service } = build();
    const { invitation, code, collaborator } = service.inviteCollaborator({ displayName: 'Alice', grantedRepositoryIds: ['repo-1'] });
    expect(collaborator.displayName).toBe('Alice');
    expect(collaborator.grantedRepositoryIds).toEqual(['repo-1']);
    expect(invitation.collaboratorId).toBe(collaborator.id);
    expect(code.length).toBeGreaterThan(20);
  });

  it('never persists the raw code -- only its hash is stored', () => {
    const { service, store } = build();
    const { code, invitation } = service.inviteCollaborator({ displayName: 'Bob' });
    const stored = JSON.stringify([...store.invitations.values(), ...store.invitationHashes.keys()]);
    expect(stored).not.toContain(code);
    expect(store.invitations.get(invitation.id)).toBeDefined();
  });

  it('issues a second invitation to an existing collaborator via collaboratorId', () => {
    const { service } = build();
    const first = service.inviteCollaborator({ displayName: 'Alice' });
    const second = service.inviteCollaborator({ collaboratorId: first.collaborator.id });
    expect(second.collaborator.id).toBe(first.collaborator.id);
    expect(second.code).not.toBe(first.code);
  });

  it('names a new collaborator with granted Profiles too (ticket 12 AC1)', () => {
    const { service } = build();
    const { collaborator } = service.inviteCollaborator({ displayName: 'Alice', grantedProfileIds: ['profile-1', 'profile-1'] });
    expect(collaborator.grantedProfileIds).toEqual(['profile-1']);
  });

  it('rejects an unknown collaboratorId', () => {
    const { service } = build();
    expect(() => service.inviteCollaborator({ collaboratorId: 'nope' })).toThrow(CollaboratorNotFoundError);
  });

  it('requires a displayName when naming a brand-new collaborator', () => {
    const { service } = build();
    expect(() => service.inviteCollaborator({})).toThrow(/displayName/);
  });
});

describe('CollaboratorService.exchangeInvitation', () => {
  it('exchanges a valid code for a device credential and returns the bearer token once (AC1)', () => {
    const { service } = build();
    const { code } = service.inviteCollaborator({ displayName: 'Alice' });
    const { device, token, collaborator } = service.exchangeInvitation(code, "Alice's phone");
    expect(collaborator.displayName).toBe('Alice');
    expect(device.deviceLabel).toBe("Alice's phone");
    expect(token.length).toBeGreaterThan(20);
  });

  it('never persists the raw device token -- only its hash is stored (AC2)', () => {
    const { service, store } = build();
    const { code } = service.inviteCollaborator({ displayName: 'Alice' });
    const { token, device } = service.exchangeInvitation(code, 'device');
    const stored = JSON.stringify([...store.devices.values()]);
    expect(stored).not.toContain(token);
    expect(store.devices.get(device.id)?.revokedAt).toBeUndefined();
  });

  it('rejects an unknown code', () => {
    const { service } = build();
    expect(() => service.exchangeInvitation('not-a-real-code', 'device')).toThrow(InvitationNotFoundError);
  });

  it('rejects a code that has already been consumed', () => {
    const { service } = build();
    const { code } = service.inviteCollaborator({ displayName: 'Alice' });
    service.exchangeInvitation(code, 'first device');
    expect(() => service.exchangeInvitation(code, 'second device')).toThrow(InvitationAlreadyConsumedError);
  });

  it('rejects an expired code', () => {
    let clock = new Date('2026-01-01T00:00:00.000Z');
    const { service } = build(() => clock);
    const { code } = service.inviteCollaborator({ displayName: 'Alice', ttlMs: 1000 });
    clock = new Date('2026-01-01T00:00:02.000Z'); // 2s later, past the 1s TTL
    expect(() => service.exchangeInvitation(code, 'device')).toThrow(InvitationExpiredError);
  });

  it('defaults an empty device label to a placeholder rather than storing blank', () => {
    const { service } = build();
    const { code } = service.inviteCollaborator({ displayName: 'Alice' });
    const { device } = service.exchangeInvitation(code, '   ');
    expect(device.deviceLabel).toBe('Unnamed device');
  });
});

describe('CollaboratorService.resolveDevice', () => {
  it('resolves an active device token to its Principal and device id (AC3)', () => {
    const { service } = build();
    const { code } = service.inviteCollaborator({ displayName: 'Alice', grantedRepositoryIds: ['repo-1'] });
    const { token, device, collaborator } = service.exchangeInvitation(code, 'phone');
    const resolved = service.resolveDevice(token);
    expect(resolved).toEqual({
      id: device.id,
      label: 'phone',
      principal: { id: collaborator.id, displayName: 'Alice' },
      grantedRepositoryIds: ['repo-1'],
      grantedProfileIds: [],
    });
  });

  it('resolves granted Profile ids too (ticket 12 AC1)', () => {
    const { service } = build();
    const { code } = service.inviteCollaborator({ displayName: 'Alice', grantedProfileIds: ['profile-1'] });
    const { token } = service.exchangeInvitation(code, 'phone');
    expect(service.resolveDevice(token)?.grantedProfileIds).toEqual(['profile-1']);
  });

  it('returns undefined for an unknown token, fail-closed', () => {
    const { service } = build();
    expect(service.resolveDevice('bogus-token')).toBeUndefined();
  });

  it('returns undefined for a missing token', () => {
    const { service } = build();
    expect(service.resolveDevice(undefined)).toBeUndefined();
  });

  it('returns undefined once the device has been revoked, without needing to know the collaborator (AC5)', () => {
    const { service } = build();
    const { code } = service.inviteCollaborator({ displayName: 'Alice' });
    const { token, device } = service.exchangeInvitation(code, 'phone');
    expect(service.resolveDevice(token)).toBeDefined();
    service.revokeDevice(device.id);
    expect(service.resolveDevice(token)).toBeUndefined();
  });

  it('reflects a later grant change on the very next resolution', () => {
    const { service } = build();
    const { code, collaborator } = service.inviteCollaborator({ displayName: 'Alice' });
    const { token } = service.exchangeInvitation(code, 'phone');
    service.updateGrants(collaborator.id, { repositoryIds: ['repo-9'] });
    expect(service.resolveDevice(token)?.grantedRepositoryIds).toEqual(['repo-9']);
  });
});

describe('CollaboratorService.revokeDevice', () => {
  it('revokes exactly the named device, leaving the collaborator\'s other devices resolvable (AC5)', () => {
    const { service } = build();
    const { code: codeA } = service.inviteCollaborator({ displayName: 'Alice' });
    const { token: tokenA, device: deviceA, collaborator } = service.exchangeInvitation(codeA, 'phone');
    const { code: codeB } = service.inviteCollaborator({ collaboratorId: collaborator.id });
    const { token: tokenB } = service.exchangeInvitation(codeB, 'laptop');

    service.revokeDevice(deviceA.id);

    expect(service.resolveDevice(tokenA)).toBeUndefined();
    expect(service.resolveDevice(tokenB)).toBeDefined();
  });

  it('is idempotent -- revoking twice does not throw or change the revocation time', () => {
    const { service } = build();
    const { code } = service.inviteCollaborator({ displayName: 'Alice' });
    const { device } = service.exchangeInvitation(code, 'phone');
    const first = service.revokeDevice(device.id);
    const second = service.revokeDevice(device.id);
    expect(second.revokedAt).toBe(first.revokedAt);
  });

  it('rejects an unknown device id', () => {
    const { service } = build();
    expect(() => service.revokeDevice('nope')).toThrow(DeviceNotFoundError);
  });

  it('notifies onRevoke listeners exactly once per actual revocation, letting ws.ts drop live sockets (AC5)', () => {
    const { service } = build();
    const { code } = service.inviteCollaborator({ displayName: 'Alice' });
    const { device } = service.exchangeInvitation(code, 'phone');
    const seen: string[] = [];
    service.onRevoke((deviceId) => seen.push(deviceId));

    service.revokeDevice(device.id);
    service.revokeDevice(device.id); // idempotent re-revoke must not notify again

    expect(seen).toEqual([device.id]);
  });
});

describe('CollaboratorService.updateGrants', () => {
  it('replaces the granted repository set and de-duplicates', () => {
    const { service } = build();
    const { collaborator } = service.inviteCollaborator({ displayName: 'Alice' });
    const updated = service.updateGrants(collaborator.id, { repositoryIds: ['repo-1', 'repo-1', 'repo-2'] });
    expect(updated.grantedRepositoryIds).toEqual(['repo-1', 'repo-2']);
  });

  it('replaces the granted Profile set independently of the Repository set (ticket 12 AC1)', () => {
    const { service } = build();
    const { collaborator } = service.inviteCollaborator({ displayName: 'Alice', grantedRepositoryIds: ['repo-1'] });
    const updated = service.updateGrants(collaborator.id, { profileIds: ['profile-1', 'profile-1'] });
    expect(updated.grantedProfileIds).toEqual(['profile-1']);
    expect(updated.grantedRepositoryIds).toEqual(['repo-1']); // untouched — only profileIds was passed
  });

  it('leaves both grant sets untouched when neither is passed', () => {
    const { service } = build();
    const { collaborator } = service.inviteCollaborator({ displayName: 'Alice', grantedRepositoryIds: ['repo-1'], grantedProfileIds: ['profile-1'] });
    const updated = service.updateGrants(collaborator.id, {});
    expect(updated).toEqual(expect.objectContaining({ grantedRepositoryIds: ['repo-1'], grantedProfileIds: ['profile-1'] }));
  });

  it('rejects an unknown collaborator', () => {
    const { service } = build();
    expect(() => service.updateGrants('nope', { repositoryIds: ['repo-1'] })).toThrow(CollaboratorNotFoundError);
  });
});

describe('CollaboratorService.removeCollaborator', () => {
  it('deletes the collaborator outright -- gone from the roster, not merely revoked', () => {
    const { service, store } = build();
    const { collaborator } = service.inviteCollaborator({ displayName: 'Alice' });
    service.removeCollaborator(collaborator.id);
    expect(store.getCollaborator(collaborator.id)).toBeUndefined();
    expect(service.listCollaborators()).toEqual([]);
  });

  it('revokes every active device and notifies onRevoke listeners so a live session ends immediately', () => {
    const { service } = build();
    const { code } = service.inviteCollaborator({ displayName: 'Alice' });
    const { token, device } = service.exchangeInvitation(code, 'phone');
    const seen: string[] = [];
    service.onRevoke((deviceId) => seen.push(deviceId));

    service.removeCollaborator(device.collaboratorId);

    expect(seen).toEqual([device.id]);
    expect(service.resolveDevice(token)).toBeUndefined();
  });

  it('does not affect any other collaborator', () => {
    const { service } = build();
    const { collaborator: alice } = service.inviteCollaborator({ displayName: 'Alice' });
    const { collaborator: bob } = service.inviteCollaborator({ displayName: 'Bob' });
    service.removeCollaborator(alice.id);
    expect(service.listCollaborators()).toEqual([bob]);
  });

  it('rejects an unknown collaborator id', () => {
    const { service } = build();
    expect(() => service.removeCollaborator('nope')).toThrow(CollaboratorNotFoundError);
  });
});
