import { describe, expect, it } from 'vitest';
import type { AgentMessage, Session } from '../types.js';
import { deriveActivityTimeline } from './activityTimeline.js';

const session: Session = {
  id: 'session-1', origin: 'managed', agent: 'claude', cwd: '/repos/web', repoId: '/repos/web',
  agentSessionId: 'claude:abc', startedAt: '2026-09-10T10:00:00.000Z', lastActivityAt: '2026-09-10T10:30:00.000Z',
  status: 'exited', statusSource: 'hook',
};

function event(overrides: Partial<AgentMessage>): AgentMessage {
  return { ts: '2026-09-10T10:01:00.000Z', agent: 'claude:abc', repo: '/repos/web', event: 'progress', sessionId: 'session-1', ...overrides };
}

describe('deriveActivityTimeline', () => {
  it('describes observable actions — reading, editing, testing, waiting, retrying, asking — in order', () => {
    const entries = deriveActivityTimeline([
      event({ ts: '2026-09-10T10:00:00.000Z', event: 'session_start' }),
      event({ ts: '2026-09-10T10:01:00.000Z', message: 'Reading the dashboard components' }),
      event({ ts: '2026-09-10T10:02:00.000Z', event: 'claim', files: ['src/Dashboard.tsx', 'src/api.ts'] }),
      event({ ts: '2026-09-10T10:03:00.000Z', message: 'Running vitest for the dashboard' }),
      event({ ts: '2026-09-10T10:04:00.000Z', message: 'Retrying the flaky test' }),
      event({ ts: '2026-09-10T10:05:00.000Z', event: 'status', status: 'waiting_input' }),
      event({ ts: '2026-09-10T10:06:00.000Z', event: 'message', attention: 'response_required', message: 'Should I keep the old chart?' }),
      event({ ts: '2026-09-10T10:07:00.000Z', event: 'blocked', blockers: ['API schema not merged'] }),
      event({ ts: '2026-09-10T10:08:00.000Z', event: 'done', summary: 'Dashboard updated' }),
      event({ ts: '2026-09-10T10:09:00.000Z', event: 'session_end' }),
    ], session);

    expect(entries.map(({ verb, label, detail }) => ({ verb, label, ...(detail ? { detail } : {}) }))).toEqual([
      { verb: 'started', label: 'Started' },
      { verb: 'reading', label: 'Reading', detail: 'Reading the dashboard components' },
      { verb: 'editing', label: 'Editing 2 files', detail: 'src/Dashboard.tsx, src/api.ts' },
      { verb: 'testing', label: 'Testing', detail: 'Running vitest for the dashboard' },
      { verb: 'retrying', label: 'Retrying', detail: 'Retrying the flaky test' },
      { verb: 'waiting', label: 'Waiting for input' },
      { verb: 'asking', label: 'Asked a question', detail: 'Should I keep the old chart?' },
      { verb: 'blocked', label: 'Blocked', detail: 'API schema not merged' },
      { verb: 'done', label: 'Finished', detail: 'Dashboard updated' },
      { verb: 'ended', label: 'Agent exited' },
    ]);
  });

  it('only includes events for this session and survives the agent exiting', () => {
    const entries = deriveActivityTimeline([
      event({ sessionId: 'other', agent: 'codex:zzz', message: 'Editing someone else' }),
      event({ sessionId: undefined, agent: 'claude:abc', message: 'Editing via hook correlation' }),
      event({ agent: 'dashboard:session-1', event: 'message', message: 'human chat is not activity' }),
    ], session);
    expect(entries.map((entry) => entry.detail)).toEqual(['Editing via hook correlation']);
  });

  it('collapses repeated identical status noise', () => {
    const entries = deriveActivityTimeline([
      event({ ts: '2026-09-10T10:05:00.000Z', event: 'status', status: 'waiting_input' }),
      event({ ts: '2026-09-10T10:05:10.000Z', event: 'status', status: 'waiting_input' }),
      event({ ts: '2026-09-10T10:05:20.000Z', event: 'status', status: 'working' }),
    ], session);
    expect(entries.map((entry) => entry.label)).toEqual(['Waiting for input']);
  });
});
