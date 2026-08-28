import { describe, expect, it, vi } from 'vitest';
import { finalizeRemoteAuthentication } from './remote-auth.js';

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
