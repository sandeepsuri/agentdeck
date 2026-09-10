import { describe, expect, it } from 'vitest';
import type { Session } from '../types.js';
import {
  parseClaudeInteraction, projectSessionInteractions, validateInteractionResponse,
} from './session-interactions.js';

const session: Session = {
  id: 'session-1', origin: 'external', agent: 'claude', cwd: '/repo', repoId: '/repo',
  agentSessionId: 'claude:provider-session', status: 'working', statusSource: 'hook',
  startedAt: '2026-09-10T12:00:00.000Z', lastActivityAt: '2026-09-10T12:00:00.000Z',
};

describe('Claude Session interaction adapter', () => {
  it('preserves question ids and advertised choices without exposing provider Session identity', () => {
    const parsed = parseClaudeInteraction({
      hook_event_name: 'PreToolUse', session_id: 'provider-session', tool_use_id: 'tool-1',
      tool_name: 'AskUserQuestion', cwd: '/repo',
      tool_input: { questions: [{ id: 'packageManager', question: 'Which package manager?', header: 'Package manager', multiSelect: false,
        options: [{ label: 'npm', description: 'Use npm.' }, { label: 'pnpm', description: 'Use pnpm.' }] }] },
    }, [session], () => 'interaction-1', () => new Date('2026-09-10T12:01:00.000Z'));

    expect(parsed).toMatchObject({
      id: 'interaction-1', sessionId: 'session-1', providerRequestId: 'tool-1', kind: 'question',
      question: 'Which package manager?', choices: [
        { id: 'npm', label: 'npm', description: 'Use npm.', questionId: 'Which package manager?' },
        { id: 'pnpm', label: 'pnpm', description: 'Use pnpm.', questionId: 'Which package manager?' },
      ],
    });
    expect(JSON.stringify(projectSessionInteractions(session, [parsed!], true))).not.toContain('provider-session');
  });

  it('distinguishes a permission approval and reduces its context to a safe summary', () => {
    expect(parseClaudeInteraction({
      hook_event_name: 'PermissionRequest', session_id: 'provider-session', tool_use_id: 'tool-2',
      tool_name: 'Bash', cwd: '/repo', tool_input: { command: 'npm test', secret: 'not rendered' },
    }, [session])!).toMatchObject({ kind: 'approval', question: 'Claude Code wants approval to use Bash.', context: 'npm test' });
  });

  it('correlates a managed Claude process using its existing AgentDeck Session id', () => {
    const managed = { ...session, origin: 'managed' as const, agentSessionId: undefined };
    expect(parseClaudeInteraction({
      hook_event_name: 'PreToolUse', session_id: 'provider-session-not-yet-known', agentdeck_session_id: 'session-1',
      tool_use_id: 'tool-1', tool_name: 'AskUserQuestion', cwd: '/repo',
      tool_input: { questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }] },
    }, [managed])).toMatchObject({ sessionId: 'session-1', providerSessionId: 'provider-session-not-yet-known' });
  });

  it('validates question choices and approval decisions at the provider boundary', () => {
    const question = parseClaudeInteraction({
      hook_event_name: 'PreToolUse', session_id: 'provider-session', tool_use_id: 'tool-1', tool_name: 'AskUserQuestion', cwd: '/repo',
      tool_input: { questions: [{ id: 'pm', question: 'Package manager?', options: [{ label: 'pnpm' }] }] },
    }, [session])!;
    expect(validateInteractionResponse(question, { answers: { 'Package manager?': ['pnpm'] } })).toEqual({ kind: 'answer', answers: { 'Package manager?': ['pnpm'] } });
    expect(() => validateInteractionResponse(question, { answers: { 'Package manager?': ['yarn'] } })).toThrow('not an available choice');
  });

  it('derives waiting and working states from requests and Session events, not chat posts', () => {
    const approval = parseClaudeInteraction({ hook_event_name: 'PermissionRequest', session_id: 'provider-session', tool_use_id: 'tool-2', tool_name: 'Bash', cwd: '/repo', tool_input: { command: 'npm test' } }, [session])!;
    expect(projectSessionInteractions(session, [approval], false).processingState).toBe('waiting_approval');
    expect(projectSessionInteractions(session, [{ ...approval, status: 'resolved', response: { kind: 'approval', decision: 'approve' } }], false).processingState).toBe('delivery_pending');
    expect(projectSessionInteractions(session, [{ ...approval, status: 'resolved', response: { kind: 'approval', decision: 'approve' }, responseDeliveredAt: '2026-09-10T12:02:00.000Z' }], false).processingState).toBe('working');
    expect(projectSessionInteractions({ ...session, status: 'idle' }, [{ ...approval, status: 'resolved', resolvedAt: '2026-09-10T12:01:00.000Z', response: { kind: 'approval', decision: 'approve' } }], false, true, [{
      ts: '2026-09-10T12:02:00.000Z', agent: 'claude:provider-session', repo: '/repo', event: 'done', message: 'Complete.',
    }]).processingState).toBe('finished');
    expect(projectSessionInteractions(session, [], false).processingState).toBe('working');
    expect(projectSessionInteractions({ ...session, status: 'exited' }, [], false).processingState).toBe('disconnected');
    expect(projectSessionInteractions({ ...session, status: 'idle' }, [], false, true, [{
      ts: '2026-09-10T12:02:00.000Z', agent: 'claude:provider-session', repo: '/repo', event: 'done', message: 'Complete.',
    }]).processingState).toBe('finished');
    expect(projectSessionInteractions({ ...session, status: 'idle' }, [], false, true, [{
      ts: '2026-09-10T12:02:00.000Z', agent: 'claude:provider-session', repo: '/repo', event: 'failed', message: 'Provider connection lost.',
    }])).toMatchObject({ processingState: 'failed', processingReason: 'Provider connection lost.' });
    const chat = { id: 'chat-1', sessionId: 'session-1', sequence: 1, ts: '2026-09-10T12:03:00.000Z',
      authorKind: 'human' as const, displayName: 'Alice', text: 'hello', audience: 'chat' as const };
    expect(projectSessionInteractions({ ...session, status: 'idle' }, [], false, true, [], [chat]).processingState).toBe('idle');
    expect(projectSessionInteractions({ ...session, status: 'idle' }, [], false, true, [], [{
      ...chat, audience: 'agent', delivery: 'sent', text: '@agent hello',
    }]).processingState).toBe('delivery_pending');
  });
});
