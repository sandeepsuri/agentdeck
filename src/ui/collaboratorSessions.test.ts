// The Session API surface, with an injected fetcher — no DOM, no server.
// What a Collaborator is allowed to see or send is enforced server-side
// (routes.ts's grant check, collaborator-session-view.ts's narrowing); this
// file pins down that the right routes are called, that an id is escaped
// before it reaches one, and that a refusal is surfaced rather than swallowed.
import { describe, expect, it } from 'vitest';
import { getSessionCapabilities, listCollaboratorSessions, listSessionMessages, sendSessionMessage } from './collaboratorSessions.js';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Records every path and init called, answering each call with the same reply. */
function recorder(reply: Response | (() => Response)) {
  const calls: { path: string; init?: RequestInit }[] = [];
  const fetcher = (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return Promise.resolve(typeof reply === 'function' ? reply() : reply);
  };
  return { calls, fetcher };
}

describe('listCollaboratorSessions', () => {
  it('reads the grant-scoped session list', async () => {
    const { calls, fetcher } = recorder(() => json(200, [{ id: 'ext-1' }]));
    await expect(listCollaboratorSessions(fetcher)).resolves.toEqual([{ id: 'ext-1' }]);
    expect(calls[0]!.path).toBe('/api/sessions');
  });

  // responseJsonArray's guarantee, restated here because a 403 body is an
  // object and would otherwise be rendered as if it were the agent list.
  it('rejects an error payload rather than letting it reach the UI as data', async () => {
    const { fetcher } = recorder(json(403, { error: 'nope' }));
    await expect(listCollaboratorSessions(fetcher)).rejects.toThrow();
  });
});

describe('listSessionMessages', () => {
  it('reads one Session’s conversation', async () => {
    const { calls, fetcher } = recorder(() => json(200, [{ ts: 't', author: 'agent', event: 'message', text: 'hi' }]));
    await expect(listSessionMessages('ext-1', fetcher)).resolves.toHaveLength(1);
    expect(calls[0]!.path).toBe('/api/sessions/ext-1/messages');
  });

  it('escapes a session id rather than building the path by concatenation', async () => {
    const { calls, fetcher } = recorder(() => json(200, []));
    await listSessionMessages('ext/../secret', fetcher);
    expect(calls[0]!.path).toBe('/api/sessions/ext%2F..%2Fsecret/messages');
  });
});

describe('getSessionCapabilities', () => {
  it('reads whether this Session can be messaged at all', async () => {
    const { calls, fetcher } = recorder(() => json(200, { send: 'queued' }));
    await expect(getSessionCapabilities('ext-1', fetcher)).resolves.toEqual({ send: 'queued' });
    expect(calls[0]!.path).toBe('/api/sessions/ext-1/capabilities');
  });
});

describe('sendSessionMessage', () => {
  it('posts the message and reports how it was delivered', async () => {
    const { calls, fetcher } = recorder(() => json(200, { delivered: 'queued' }));
    await expect(sendSessionMessage('ext-1', 'Any progress?', fetcher)).resolves.toEqual({ delivered: 'queued' });
    expect(calls[0]!.path).toBe('/api/sessions/ext-1/send');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ text: 'Any progress?' });
  });

  it('distinguishes a message typed straight into a managed agent from one queued for an external one', async () => {
    const { fetcher } = recorder(() => json(200, { delivered: 'typed' }));
    await expect(sendSessionMessage('managed-1', 'go', fetcher)).resolves.toEqual({ delivered: 'typed' });
  });

  // The reader needs the server's own reason — "this agent has finished",
  // "not connected yet" — not a generic failure.
  it('surfaces the server’s reason for a refusal', async () => {
    const { fetcher } = recorder(json(400, { error: 'This agent has finished. Its conversation is read-only.' }));
    await expect(sendSessionMessage('ext-1', 'hi', fetcher))
      .rejects.toThrow('This agent has finished. Its conversation is read-only.');
  });

  it('still fails loudly when a refusal carries no readable body', async () => {
    const { fetcher } = recorder(new Response('', { status: 500 }));
    await expect(sendSessionMessage('ext-1', 'hi', fetcher)).rejects.toThrow('Unable to send to this agent.');
  });
});
