// SessionConversation's pure half — identity resolution and merging the
// human/agent halves of a Session's shared chat into one attributed feed.
// Delivery (routes.ts's POST /api/sessions/:id/chat) is covered end to end
// by collaborator-workspace.integration.test.ts instead, the same split
// collaborator-session-view.test.ts uses for its projection.
import { describe, expect, it } from 'vitest';
import type { AgentMessage, Session } from '../types.js';
import type { StoredSessionChatMessage } from '../store/index.js';
import { mergeConversation, resolveSenderIdentity } from './session-conversation.js';
import type { TrustResult } from './connection-trust.js';

const REPO = '/Users/dev/projects/example';

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'ext-1', origin: 'external', agent: 'claude', repoId: REPO, cwd: `${REPO}/packages/api`,
    startedAt: '2026-09-01T00:00:00.000Z', lastActivityAt: '2026-09-01T00:00:00.000Z',
    status: 'working', statusSource: 'hook', agentSessionId: 'claude:abc',
    ...overrides,
  };
}

function human(overrides: Partial<StoredSessionChatMessage> = {}): StoredSessionChatMessage {
  return {
    id: 'msg-1', sessionId: 'ext-1', sequence: 1, ts: '2026-09-01T00:00:01.000Z', authorKind: 'human',
    principalId: 'device:alice', displayName: 'Alice', text: 'hello', audience: 'chat', ...overrides,
  };
}

describe('resolveSenderIdentity', () => {
  it('names a resolved collaborator device by its Principal', () => {
    const trust: TrustResult = {
      kind: 'remote', capabilities: new Set(),
      device: {
        id: 'device-1', label: "Alice's phone", principal: { id: 'collab-1', displayName: 'Alice' },
        grantedRepositoryIds: [], grantedProfileIds: [],
      },
    };
    expect(resolveSenderIdentity(trust)).toEqual({ principalId: 'collab-1', displayName: 'Alice' });
  });

  it('names the local admin through the same Principal mechanism Runs use', () => {
    const trust: TrustResult = { kind: 'local', capabilities: new Set() };
    const identity = resolveSenderIdentity(trust);
    expect(identity.displayName).toBeTruthy();
    expect(identity.principalId).toMatch(/^local:/);
  });

  it('never presents the legacy shared tailnet token as a named individual', () => {
    const trust: TrustResult = { kind: 'remote', capabilities: new Set() };
    expect(resolveSenderIdentity(trust)).toEqual({ displayName: 'Shared access' });
  });
});

describe('mergeConversation', () => {
  it('attributes each human message to its own sender, never collapsing them into "You"', () => {
    const alice = human({ id: 'm-1', principalId: 'device:alice', displayName: 'Alice', text: 'Any progress?' });
    const bob = human({
      id: 'm-2', sequence: 2, ts: '2026-09-01T00:00:02.000Z', principalId: 'device:bob', displayName: 'Bob', text: 'Checking now',
    });

    const merged = mergeConversation(session(), [alice, bob], []);

    expect(merged).toEqual([
      { id: 'm-1', ts: alice.ts, authorKind: 'human', principalId: 'device:alice', displayName: 'Alice', text: 'Any progress?', audience: 'chat' },
      { id: 'm-2', ts: bob.ts, authorKind: 'human', principalId: 'device:bob', displayName: 'Bob', text: 'Checking now', audience: 'chat' },
    ]);
  });

  it('folds in the agent’s own bus turns, labeled with the runtime, paths rewritten out', () => {
    const busMessages: AgentMessage[] = [{
      ts: '2026-09-01T00:00:03.000Z', agent: 'claude:abc', repo: REPO, event: 'message',
      message: `Patched ${REPO}/src/auth.ts`, sessionId: 'ext-1',
    }];

    const merged = mergeConversation(session(), [], busMessages);

    expect(merged).toEqual([
      { id: 'agent:2026-09-01T00:00:03.000Z', ts: '2026-09-01T00:00:03.000Z', authorKind: 'agent', displayName: 'Claude Code', text: 'Patched ./src/auth.ts', event: 'message' },
    ]);
  });

  it('never surfaces a `dashboard:` bus row as if it were the agent talking', () => {
    const busMessages: AgentMessage[] = [{
      ts: '2026-09-01T00:00:01.000Z', agent: 'dashboard:ext-1', repo: REPO, event: 'message',
      message: 'a message the old /send route recorded', sessionId: 'ext-1',
    }];

    expect(mergeConversation(session(), [], busMessages)).toEqual([]);
  });

  it('orders human and agent turns chronologically together', () => {
    const alice = human({ id: 'm-1', ts: '2026-09-01T00:00:01.000Z', text: 'ping' });
    const busMessages: AgentMessage[] = [{
      ts: '2026-09-01T00:00:02.000Z', agent: 'claude:abc', repo: REPO, event: 'message', message: 'pong', sessionId: 'ext-1',
    }];

    expect(mergeConversation(session(), [alice], busMessages).map((m) => m.text)).toEqual(['ping', 'pong']);
  });

  it('carries a not_sent delivery reason through for a human’s agent-addressed post', () => {
    const failed = human({ audience: 'agent', delivery: 'not_sent', deliveryReason: 'This agent has finished.' });

    expect(mergeConversation(session(), [failed], [])).toEqual([
      expect.objectContaining({ audience: 'agent', delivery: 'not_sent', deliveryReason: 'This agent has finished.' }),
    ]);
  });
});
