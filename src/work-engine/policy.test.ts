import { describe, expect, it } from 'vitest';
import { decidePolicy } from './policy.js';
import type { RunActor } from './types.js';

const admin: RunActor = { principal: { id: 'local:sandeep', displayName: 'sandeep' } };
const collaborator: RunActor = {
  principal: { id: 'collab-1', displayName: 'Alice' },
  device: { id: 'device-1', label: "Alice's phone" },
  grants: { repositoryIds: ['repo-1'], profileIds: ['profile-1'] },
};

describe('decidePolicy', () => {
  it('allows every action for an admin actor (no grants) unconditionally', () => {
    expect(decidePolicy(admin, { kind: 'submit', repositoryId: 'repo-9', profileId: undefined })).toEqual({
      allowed: true, rule: 'admin-full-authority', reason: expect.any(String),
    });
    expect(decidePolicy(admin, { kind: 'guide', repositoryId: 'repo-9' })).toEqual({
      allowed: true, rule: 'admin-full-authority', reason: expect.any(String),
    });
  });

  it('allows a collaborator to submit against a granted Repository and Profile', () => {
    const decision = decidePolicy(collaborator, { kind: 'submit', repositoryId: 'repo-1', profileId: 'profile-1' });
    expect(decision).toEqual({ allowed: true, rule: 'collaborator-within-grants', reason: expect.any(String) });
  });

  it('allows a collaborator to guide a Run on a granted Repository, with no Profile involved', () => {
    const decision = decidePolicy(collaborator, { kind: 'guide', repositoryId: 'repo-1' });
    expect(decision.allowed).toBe(true);
  });

  it('denies submit for an ungranted Repository, naming the rule', () => {
    const decision = decidePolicy(collaborator, { kind: 'submit', repositoryId: 'repo-9', profileId: 'profile-1' });
    expect(decision).toEqual({ allowed: false, rule: 'repository-not-granted', reason: expect.stringContaining('Alice') });
  });

  it('denies guide for an ungranted Repository', () => {
    const decision = decidePolicy(collaborator, { kind: 'guide', repositoryId: 'repo-9' });
    expect(decision.allowed).toBe(false);
    expect(decision.rule).toBe('repository-not-granted');
  });

  it('denies submit with no profileId at all — AC4: cannot select an unapproved runtime', () => {
    const decision = decidePolicy(collaborator, { kind: 'submit', repositoryId: 'repo-1', profileId: undefined });
    expect(decision).toEqual({ allowed: false, rule: 'profile-required', reason: expect.any(String) });
  });

  it('denies submit for an ungranted Profile even when the Repository is granted', () => {
    const decision = decidePolicy(collaborator, { kind: 'submit', repositoryId: 'repo-1', profileId: 'profile-9' });
    expect(decision).toEqual({ allowed: false, rule: 'profile-not-granted', reason: expect.stringContaining('Alice') });
  });

  it('checks Repository before Profile — an ungranted Repository is refused even with a valid Profile id', () => {
    const decision = decidePolicy(collaborator, { kind: 'submit', repositoryId: 'repo-9', profileId: 'profile-1' });
    expect(decision.rule).toBe('repository-not-granted');
  });
});
