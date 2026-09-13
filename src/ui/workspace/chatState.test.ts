import { describe, expect, it } from 'vitest';
import type { SessionChatMessage } from '../../types.js';
import { draftForRecipient, isAgentWorking, recipientForDraft } from './chatState.js';

describe('composer recipient', () => {
  it('reads the recipient from the draft so typing a mention switches to the agent', () => {
    expect(recipientForDraft('Looks good to me')).toBe('team');
    expect(recipientForDraft('@agent please rerun the tests')).toBe('agent');
    expect(recipientForDraft('`@agent` in code is not a mention')).toBe('team');
  });

  it('choosing a recipient rewrites the draft the server will route', () => {
    expect(draftForRecipient('please rerun the tests', 'agent')).toBe('@agent please rerun the tests');
    expect(draftForRecipient('@agent please rerun', 'agent')).toBe('@agent please rerun');
    expect(draftForRecipient('', 'agent')).toBe('@agent ');
    expect(draftForRecipient('@agent please rerun @agent now', 'team')).toBe('please rerun now');
  });
});

describe('isAgentWorking', () => {
  const sentAt = '2026-09-10T10:00:00.000Z';
  const agentReply = (ts: string): SessionChatMessage => ({ id: ts, ts, authorKind: 'agent', displayName: 'Claude', text: 'Done', event: 'message' });

  it('shows working immediately after delivery and until the agent answers', () => {
    expect(isAgentWorking({ processingState: 'idle', awaitingSince: sentAt, messages: [] })).toBe(true);
    expect(isAgentWorking({ processingState: 'delivery_pending', awaitingSince: sentAt, messages: [agentReply('2026-09-10T09:59:00.000Z')] })).toBe(true);
    expect(isAgentWorking({ processingState: 'idle', awaitingSince: sentAt, messages: [agentReply('2026-09-10T10:00:05.000Z')] })).toBe(false);
  });

  it('stops once the agent blocks, fails or exits', () => {
    for (const processingState of ['waiting_answer', 'waiting_approval', 'failed', 'disconnected', 'finished'] as const) {
      expect(isAgentWorking({ processingState, awaitingSince: sentAt, messages: [] })).toBe(false);
    }
  });

  it('follows the server when nothing was just sent', () => {
    expect(isAgentWorking({ processingState: 'working', awaitingSince: null, messages: [] })).toBe(true);
    expect(isAgentWorking({ processingState: 'idle', awaitingSince: null, messages: [] })).toBe(false);
    expect(isAgentWorking({ processingState: undefined, awaitingSince: null, messages: [] })).toBe(false);
  });
});
