import { describe, expect, it } from 'vitest';
import { deriveAttentionItems, deriveCompanionAgents } from './attention.js';
import type { AgentMessage, Session } from './types.js';

const session = {
  id: 'managed-1',
  origin: 'managed',
  agent: 'claude',
  name: 'Review dashboard',
  repoId: '/repos/agentdeck',
  cwd: '/repos/agentdeck',
  branch: 'feature/notch',
  startedAt: '2026-07-23T10:00:00.000Z',
  lastActivityAt: '2026-07-23T10:05:00.000Z',
  status: 'idle',
  statusSource: 'hook',
  agentSessionId: 'claude:abc',
} satisfies Session;

describe('deriveAttentionItems', () => {
  it('prioritizes actions and maps replies to the exact session', () => {
    const codex = {
      ...session,
      id: 'external-2',
      agent: 'codex',
      name: 'Build API',
      agentSessionId: 'codex:def',
    } satisfies Session;
    const events = [
      {
        eventId: 1, ts: '2026-07-23T10:01:00.000Z', agent: 'claude:abc',
        repo: session.cwd, event: 'done', status: 'idle', message: 'Ready to review.',
        attention: 'reply',
      },
      {
        eventId: 2, ts: '2026-07-23T10:02:00.000Z', agent: 'codex:def',
        repo: session.cwd, event: 'status', status: 'waiting_input',
        attention: 'action_required', message: 'Approve command?',
      },
    ] satisfies (AgentMessage & { eventId: number })[];
    expect(deriveAttentionItems([session, codex], events)).toMatchObject([
      { sessionId: 'external-2', kind: 'action_required', repoName: 'agentdeck' },
      { sessionId: 'managed-1', kind: 'reply', message: 'Ready to review.' },
    ]);
  });

  it('clears old attention when the same session starts working again', () => {
    const events = [
      {
        eventId: 1, ts: '2026-07-23T10:01:00.000Z', agent: 'claude:abc',
        repo: session.cwd, event: 'done', attention: 'reply',
      },
      {
        eventId: 2, ts: '2026-07-23T10:02:00.000Z', agent: 'claude:abc',
        repo: session.cwd, event: 'status', status: 'working',
      },
    ] satisfies (AgentMessage & { eventId: number })[];
    expect(deriveAttentionItems([{ ...session, status: 'working' }], events)).toEqual([]);
  });

  it('creates a fallback action for waiting sessions without a correlated event', () => {
    expect(deriveAttentionItems([{ ...session, status: 'waiting_input' }], []))
      .toMatchObject([{ sessionId: 'managed-1', kind: 'action_required' }]);
  });

  it('normalizes active agents, explicit progress, task copy, and status priority', () => {
    const working = { ...session, id: 'working', status: 'working', agentSessionId: 'codex:work', agent: 'codex' } satisfies Session;
    const starting = { ...session, id: 'starting', status: 'starting', agentSessionId: 'claude:start' } satisfies Session;
    const idle = { ...session, id: 'idle', status: 'idle', agentSessionId: 'claude:idle' } satisfies Session;
    const events = [
      {
        eventId: 1, ts: '2026-07-23T10:01:00.000Z', agent: 'codex:work',
        repo: session.cwd, event: 'progress', status: 'working',
        message: 'Refactoring session list', progress: 48,
      },
      {
        eventId: 2, ts: '2026-07-23T10:02:00.000Z', agent: 'claude:start',
        repo: session.cwd, event: 'status', status: 'starting', message: 'Booting dev server',
      },
    ] satisfies (AgentMessage & { eventId: number })[];
    expect(deriveCompanionAgents([idle, starting, working], events)).toMatchObject([
      { id: 'working', name: 'Codex', task: 'Refactoring session list', progress: 48, status: 'working' },
      { id: 'starting', name: 'Claude Code', task: 'Booting dev server', status: 'starting' },
    ]);
  });

  it('surfaces attention ahead of working sessions and never fabricates progress', () => {
    const working = { ...session, id: 'working', status: 'working', agentSessionId: 'codex:work', agent: 'codex' } satisfies Session;
    const events = [{
      eventId: 1, ts: '2026-07-23T10:03:00.000Z', agent: 'claude:abc',
      repo: session.cwd, event: 'status', status: 'waiting_input',
      attention: 'response_required', message: 'Which schema should I use?',
    }] satisfies (AgentMessage & { eventId: number })[];
    const agents = deriveCompanionAgents([{ ...session, status: 'waiting_input' }, working], events);
    expect(agents).toMatchObject([
      { id: 'managed-1', status: 'waiting', task: 'Which schema should I use?' },
      { id: 'working', status: 'working' },
    ]);
    expect(agents[1]).not.toHaveProperty('progress');
  });
});
