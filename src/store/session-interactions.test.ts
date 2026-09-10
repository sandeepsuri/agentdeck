import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from './index.js';

let dir: string;
let store: Store;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-session-interactions-'));
  store = openStore(dir);
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('Session interaction persistence', () => {
  it('deduplicates a provider request and conditionally accepts only its first response', () => {
    const request = {
      id: 'request-1', sessionId: 'session-1', provider: 'claude' as const,
      providerSessionId: 'provider-session', providerRequestId: 'tool-use-1', kind: 'question' as const,
      question: 'Which package manager?', choices: [{ id: 'npm', label: 'npm' }, { id: 'pnpm', label: 'pnpm' }],
      allowsFreeText: true, requestedAt: '2026-09-10T12:00:00.000Z',
    };

    expect(store.upsertSessionInteraction(request).id).toBe('request-1');
    expect(store.upsertSessionInteraction({ ...request, id: 'retry-id' }).id).toBe('request-1');
    expect(store.resolveSessionInteraction('request-1', {
      response: { kind: 'answer', answers: { packageManager: ['pnpm'] } },
      principalId: 'alice', displayName: 'Alice', resolvedAt: '2026-09-10T12:01:00.000Z',
    })).toBe(true);
    expect(store.resolveSessionInteraction('request-1', {
      response: { kind: 'answer', answers: { packageManager: ['npm'] } },
      principalId: 'bob', displayName: 'Bob', resolvedAt: '2026-09-10T12:01:01.000Z',
    })).toBe(false);
    expect(store.acknowledgeSessionInteractionResponse('request-1', '2026-09-10T12:01:02.000Z')).toBe(true);
    expect(store.acknowledgeSessionInteractionResponse('request-1', '2026-09-10T12:01:03.000Z')).toBe(false);
    expect(store.listSessionInteractions('session-1')[0]).toMatchObject({
      status: 'resolved', responseDeliveredAt: '2026-09-10T12:01:02.000Z', responderDisplayName: 'Alice',
      response: { kind: 'answer', answers: { packageManager: ['pnpm'] } },
    });
  });

  it('removes requests with their Session retention record', () => {
    store.upsertSession({ id: 'session-1', origin: 'managed', agent: 'claude', cwd: '/repo', status: 'exited', statusSource: 'process_gone', startedAt: '2026-09-10T12:00:00.000Z', lastActivityAt: '2026-09-10T12:00:00.000Z' });
    store.upsertSessionInteraction({ id: 'request-1', sessionId: 'session-1', provider: 'claude', providerSessionId: 'provider-session',
      providerRequestId: 'tool-1', kind: 'approval', question: 'Approve?', choices: [], allowsFreeText: false, requestedAt: '2026-09-10T12:00:00.000Z' });
    store.deleteSession('session-1');
    expect(store.listSessionInteractions('session-1')).toEqual([]);
  });

  it('recovers a pending request after the store is reopened', () => {
    store.upsertSessionInteraction({
      id: 'request-1', sessionId: 'session-1', provider: 'claude', providerSessionId: 'provider-session',
      providerRequestId: 'tool-1', kind: 'question', question: 'Continue?', choices: [{ id: 'yes', label: 'Yes', questionId: 'Continue?' }],
      allowsFreeText: true, requestedAt: '2026-09-10T12:00:00.000Z',
    });

    store.close();
    store = openStore(dir);

    expect(store.listSessionInteractions('session-1')).toMatchObject([{
      id: 'request-1', status: 'pending', providerRequestId: 'tool-1', question: 'Continue?',
    }]);
  });
});
