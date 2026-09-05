// The Session projection, as a pure unit — the sibling of
// collaborator-run-view.test.ts. Its job is the field-level guarantee: what a
// Session carries about the operator's machine must not survive the narrowing,
// no matter what routes.ts does around it.
import { describe, expect, it } from 'vitest';
import type { AgentMessage, Session } from '../types.js';
import {
  collaboratorMessages, collaboratorSendCapability, collaboratorSession, collaboratorSessionMessages,
} from './collaborator-session-view.js';

const REPO = '/Users/dev/projects/example';

function session(overrides: Partial<Session> = {}): Session & { repoId: string } {
  return {
    id: 'ext-4711-1',
    origin: 'external',
    agent: 'claude',
    name: 'Claude on auth',
    repoId: REPO,
    cwd: `${REPO}/packages/api`,
    branch: 'feat/auth',
    worktreePath: '/Users/dev/.agentdeck/worktrees/run-1',
    pid: 4711,
    startedAt: '2026-09-01T00:00:00.000Z',
    lastActivityAt: '2026-09-01T00:05:00.000Z',
    status: 'working',
    statusSource: 'hook',
    tty: 'ttys004',
    terminalApp: 'VSCode',
    tmuxTarget: 'agentdeck:0.1',
    agentSessionId: 'claude:0e655530-853a-4693',
    launchSpec: { agent: 'claude', cwd: REPO, initialPrompt: 'the admin’s private prompt' },
    ...overrides,
  } as Session & { repoId: string };
}

describe('collaboratorSession', () => {
  it('keeps what describes the work', () => {
    expect(collaboratorSession(session())).toEqual({
      id: 'ext-4711-1',
      origin: 'external',
      agent: 'claude',
      name: 'Claude on auth',
      repoId: REPO,
      branch: 'feat/auth',
      status: 'working',
      statusSource: 'hook',
      startedAt: '2026-09-01T00:00:00.000Z',
      lastActivityAt: '2026-09-01T00:05:00.000Z',
    });
  });

  // The field-level guarantee, asserted by absence rather than by shape, so a
  // field added to Session later cannot quietly ride along in a rewrite of the
  // equality above.
  it.each([
    'cwd', 'worktreePath', 'pid', 'tty', 'terminalApp', 'tmuxTarget', 'launchSpec', 'agentSessionId', 'backend',
  ])('drops %s — a Repository grant says "you may see this Repository\'s work", not how this machine is laid out', (field) => {
    expect(collaboratorSession(session())).not.toHaveProperty(field);
  });

  it('omits optional fields entirely rather than sending them undefined', () => {
    const narrowed = collaboratorSession(session({ name: undefined, branch: undefined }));
    expect(narrowed).not.toHaveProperty('name');
    expect(narrowed).not.toHaveProperty('branch');
  });

  it('carries endedAt when the agent has finished, so the reader can see it is over', () => {
    expect(collaboratorSession(session({ status: 'exited', endedAt: '2026-09-01T01:00:00.000Z' })))
      .toMatchObject({ status: 'exited', endedAt: '2026-09-01T01:00:00.000Z' });
  });
});

describe('collaboratorMessages', () => {
  function message(overrides: Partial<AgentMessage> = {}): AgentMessage {
    return {
      ts: '2026-09-01T00:01:00.000Z', agent: 'claude:0e655530', repo: REPO,
      event: 'message', message: 'Looking at it now.', ...overrides,
    };
  }

  it('drops the raw row and keeps the turn', () => {
    expect(collaboratorMessages([message()], [REPO])).toEqual([{
      ts: '2026-09-01T00:01:00.000Z', author: 'agent', event: 'message', text: 'Looking at it now.',
    }]);
  });

  it('never carries the bus row’s repo path or the agent CLI’s own session id', () => {
    const [turn] = collaboratorMessages([message()], [REPO]);
    expect(turn).not.toHaveProperty('repo');
    expect(turn).not.toHaveProperty('agent');
    expect(turn).not.toHaveProperty('sessionId');
  });

  it('attributes anything sent through AgentDeck’s own composer to the human, whoever sent it', () => {
    const turns = collaboratorMessages([
      message({ agent: 'dashboard:ext-4711-1', message: 'Any progress?' }),
      message({ agent: 'claude:0e655530', message: 'Yes.' }),
    ], [REPO]);
    expect(turns.map((turn) => turn.author)).toEqual(['human', 'agent']);
  });

  it('rewrites this Session’s own roots out of free text, and masks any other absolute path left behind', () => {
    const [turn] = collaboratorMessages(
      [message({ message: `Patched ${REPO}/src/auth.ts using /Users/dev/.ssh/config` })],
      [REPO],
    );
    expect(turn!.text).toContain('./src/auth.ts');
    expect(turn!.text).not.toContain('/Users/dev/.ssh/config');
  });

  it('takes a completion summary as the turn when a done row carries no message', () => {
    expect(collaboratorMessages([message({ event: 'done', message: undefined, summary: 'Fixed the race.' })], [REPO]))
      .toEqual([{ ts: '2026-09-01T00:01:00.000Z', author: 'agent', event: 'done', text: 'Fixed the race.' }]);
  });

  it('drops rows with no usable text rather than rendering them blank', () => {
    expect(collaboratorMessages([message({ message: '   ' }), message({ message: undefined })], [REPO])).toEqual([]);
  });

  it('drops rows that are not conversation at all', () => {
    expect(collaboratorMessages([message({ event: 'claim' }), message({ event: 'status' })], [REPO])).toEqual([]);
  });

  it('keeps only the most recent turns, the same tail the admin route reads', () => {
    const many = Array.from({ length: 140 }, (_unused, index) => message({ message: `turn ${index}` }));
    const turns = collaboratorMessages(many, [REPO]);
    expect(turns).toHaveLength(100);
    expect(turns[99]!.text).toBe('turn 139');
  });

  it('derives a Session’s roots from the Session itself, so a route cannot forget to pass them', () => {
    const [turn] = collaboratorSessionMessages(
      session(),
      [message({ message: 'Wrote /Users/dev/.agentdeck/worktrees/run-1/src/auth.ts' })],
    );
    // The worktree is nested under nothing here, but it is the longer root, so
    // it must win over repoId rather than being half-rewritten.
    expect(turn!.text).toBe('Wrote ./src/auth.ts');
  });
});

describe('collaboratorSendCapability', () => {
  it('lets a managed agent be typed to directly', () => {
    expect(collaboratorSendCapability(session({ origin: 'managed' }))).toEqual({ send: 'managed' });
  });

  it('queues for an external Claude session that has completed its hook handshake', () => {
    expect(collaboratorSendCapability(session())).toEqual({ send: 'queued' });
  });

  it('explains, rather than silently failing, when an external Claude session has not connected yet', () => {
    const result = collaboratorSendCapability(session({ agentSessionId: undefined }));
    expect(result.send).toBe('unavailable');
    expect(result.reason).toContain('has not finished connecting');
  });

  it('explains that a non-Claude external terminal cannot receive messages at all', () => {
    const result = collaboratorSendCapability(session({ agent: 'codex', agentSessionId: undefined }));
    expect(result.send).toBe('unavailable');
    expect(result.reason).toContain('cannot receive messages');
  });

  // Checked before origin, so an exited managed session is read-only too --
  // otherwise the composer would be offered for a PTY that is gone.
  it('is read-only once the agent has exited, whatever its origin', () => {
    for (const origin of ['managed', 'external'] as const) {
      expect(collaboratorSendCapability(session({ origin, status: 'exited' })).send).toBe('unavailable');
    }
  });
});
