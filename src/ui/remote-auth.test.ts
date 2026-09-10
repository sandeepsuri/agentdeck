import { describe, expect, it, vi } from 'vitest';
import { finalizeRemoteAuthentication, resolveConnectionState } from './remote-auth.js';

describe('finalizeRemoteAuthentication', () => {
  it('clears the pre-auth API error and refreshes sessions before opening the gate', async () => {
    const order: string[] = [];
    const clearError = vi.fn(() => { order.push('clear-error'); });
    const refreshSessions = vi.fn(async () => { order.push('refresh-sessions'); });

    await expect(finalizeRemoteAuthentication(
      { kind: 'remote', capabilities: ['view', 'compose', 'control-keys'] },
      refreshSessions,
      clearError,
    )).resolves.toBe(true);

    expect(order).toEqual(['clear-error', 'refresh-sessions']);
    expect(clearError).toHaveBeenCalledOnce();
    expect(refreshSessions).toHaveBeenCalledOnce();
  });

  it('does not clear or refresh for an unaccepted token', async () => {
    const clearError = vi.fn();
    const refreshSessions = vi.fn(async () => undefined);

    await expect(finalizeRemoteAuthentication(
      { kind: 'remote', capabilities: [] }, refreshSessions, clearError,
    )).resolves.toBe(false);
    expect(clearError).not.toHaveBeenCalled();
    expect(refreshSessions).not.toHaveBeenCalled();
  });
});

// The regression this function exists to prevent: a collaborator who had just
// redeemed an invitation code was shown the admin's session view, because the
// two form submissions read the connection differently from the initial probe
// and dropped `principal`. Pinning the reading itself is what keeps all three
// honest, since it is now the only reading there is.
describe('resolveConnectionState', () => {
  it('names the collaborator a device credential resolved to, so the collaborator workspace mounts', () => {
    expect(resolveConnectionState({
      kind: 'remote',
      capabilities: ['view', 'compose', 'control-keys'],
      principal: { id: 'collab-1', displayName: 'Brandon' },
    })).toEqual({ kind: 'remote', gate: 'ready', principal: { id: 'collab-1', displayName: 'Brandon' } });
  });

  // The shared tailnet token authenticates a connection without naming anyone,
  // which is exactly what keeps the admin's own phone on the session tree.
  it('names nobody for the legacy shared tailnet token', () => {
    expect(resolveConnectionState({ kind: 'remote', capabilities: ['view', 'compose'] }))
      .toEqual({ kind: 'remote', gate: 'ready', principal: null });
  });

  it('keeps the gate up for a remote connection that has not authenticated yet', () => {
    expect(resolveConnectionState({ kind: 'remote', capabilities: [] }))
      .toEqual({ kind: 'remote', gate: 'needs-token', principal: null });
  });

  it('reports a denied host as denied rather than as a missing token', () => {
    expect(resolveConnectionState({ kind: 'denied', capabilities: [] }))
      .toEqual({ kind: 'local', gate: 'denied', principal: null });
  });

  it('leaves the ordinary loopback case ready and unnamed, with no extra render', () => {
    expect(resolveConnectionState({ kind: 'local', capabilities: ['view', 'compose', 'control-keys', 'raw-write'] }))
      .toEqual({ kind: 'local', gate: 'ready', principal: null });
  });
});
