// Persistence for the shared session chat (docs/specs/shared-session-chat.md).
// Its own file, sibling to store.test.ts, so this durable-storage seam has a
// focused home rather than growing that file's already-large fixture set.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, Store } from './index.js';

let dir: string;
let store: Store;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-store-chat-'));
  store = openStore(dir);
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('appendSessionChatMessage / listSessionChatMessages', () => {
  it('assigns a monotonic sequence per session, starting at 1', () => {
    const first = store.appendSessionChatMessage({
      id: 'msg-1', sessionId: 'sess-1', ts: '2026-09-01T00:00:00.000Z',
      principalId: 'device:alice', displayName: 'Alice', text: 'hello', audience: 'chat',
    });
    const second = store.appendSessionChatMessage({
      id: 'msg-2', sessionId: 'sess-1', ts: '2026-09-01T00:00:01.000Z',
      principalId: 'device:bob', displayName: 'Bob', text: 'hi Alice', audience: 'chat',
    });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(first.authorKind).toBe('human');
  });

  it('keeps sequences independent per session', () => {
    store.appendSessionChatMessage({
      id: 'a-1', sessionId: 'sess-a', ts: '2026-09-01T00:00:00.000Z', displayName: 'Alice', text: 'hi', audience: 'chat',
    });
    const first = store.appendSessionChatMessage({
      id: 'b-1', sessionId: 'sess-b', ts: '2026-09-01T00:00:00.000Z', displayName: 'Bob', text: 'hi', audience: 'chat',
    });

    expect(first.sequence).toBe(1);
  });

  it('reads a session’s messages back in post order', () => {
    store.appendSessionChatMessage({
      id: 'msg-1', sessionId: 'sess-1', ts: '2026-09-01T00:00:00.000Z', displayName: 'Alice', text: 'first', audience: 'chat',
    });
    store.appendSessionChatMessage({
      id: 'msg-2', sessionId: 'sess-1', ts: '2026-09-01T00:00:01.000Z', displayName: 'Bob', text: 'second', audience: 'chat',
    });

    expect(store.listSessionChatMessages('sess-1').map((m) => m.text)).toEqual(['first', 'second']);
  });

  it('never mixes one session’s messages into another’s', () => {
    store.appendSessionChatMessage({
      id: 'a-1', sessionId: 'sess-a', ts: '2026-09-01T00:00:00.000Z', displayName: 'Alice', text: 'in A', audience: 'chat',
    });
    store.appendSessionChatMessage({
      id: 'b-1', sessionId: 'sess-b', ts: '2026-09-01T00:00:00.000Z', displayName: 'Bob', text: 'in B', audience: 'chat',
    });

    expect(store.listSessionChatMessages('sess-a').map((m) => m.text)).toEqual(['in A']);
  });

  it('preserves an agent-addressed message’s delivery outcome, and omits it for chat-only posts', () => {
    store.appendSessionChatMessage({
      id: 'msg-1', sessionId: 'sess-1', ts: '2026-09-01T00:00:00.000Z', displayName: 'Alice',
      text: 'can you review the code?', audience: 'chat',
    });
    store.appendSessionChatMessage({
      id: 'msg-2', sessionId: 'sess-1', ts: '2026-09-01T00:00:01.000Z', displayName: 'Alice',
      text: '@agent please review', audience: 'agent', delivery: 'queued',
    });
    store.appendSessionChatMessage({
      id: 'msg-3', sessionId: 'sess-1', ts: '2026-09-01T00:00:02.000Z', displayName: 'Alice',
      text: '@agent again', audience: 'agent', delivery: 'not_sent', deliveryReason: 'This agent has finished.',
    });

    const [chatOnly, queued, failed] = store.listSessionChatMessages('sess-1');
    expect(chatOnly!.delivery).toBeUndefined();
    expect(queued).toMatchObject({ audience: 'agent', delivery: 'queued' });
    expect(failed).toMatchObject({ audience: 'agent', delivery: 'not_sent', deliveryReason: 'This agent has finished.' });
  });

  it('caps how many messages are returned, keeping the most recent', () => {
    for (let i = 0; i < 5; i += 1) {
      store.appendSessionChatMessage({
        id: `msg-${i}`, sessionId: 'sess-1', ts: `2026-09-01T00:00:0${i}.000Z`, displayName: 'Alice', text: `#${i}`, audience: 'chat',
      });
    }

    expect(store.listSessionChatMessages('sess-1', 2).map((m) => m.text)).toEqual(['#3', '#4']);
  });

  it('survives a reopen of the same database file', () => {
    store.appendSessionChatMessage({
      id: 'msg-1', sessionId: 'sess-1', ts: '2026-09-01T00:00:00.000Z', displayName: 'Alice', text: 'hello', audience: 'chat',
    });
    store.close();

    store = openStore(dir);

    expect(store.listSessionChatMessages('sess-1').map((m) => m.text)).toEqual(['hello']);
  });
});
