import { describe, expect, it } from 'vitest';
import type { ConversationTurn, ConversationView } from '../../sessions/conversation.js';
import type { Session } from '../../types.js';
import { currentTool, describeTool, diffTotals, isWorking, needsInput, planProgress, recentTools } from './inspectorModel.js';

const tool = (id: string, toolName: string, text: string): ConversationTurn => ({ id, role: 'tool', toolName, text, ts: '2026-09-27T17:20:00Z' });
const session = (overrides: Partial<Session> = {}): Session => ({
  id: 's1', origin: 'managed', agent: 'claude', cwd: '/repos/app', status: 'working', statusSource: 'hook',
  startedAt: '2026-09-27T17:00:00Z', lastActivityAt: '2026-09-27T17:20:00Z', ...overrides,
});

describe('describeTool', () => {
  it('names what the agent is doing in words, with the command or path underneath', () => {
    expect(describeTool(tool('1', 'Bash', 'npm test -- --confinement'))).toMatchObject({ kind: 'command', present: 'Running test suite', detail: 'npm test -- --confinement' });
    expect(describeTool(tool('2', 'Bash', 'git status'))).toMatchObject({ present: 'Running command', past: 'Ran command' });
    expect(describeTool(tool('3', 'Edit', 'src/setup/gmail.ts'))).toMatchObject({ kind: 'edit', present: 'Editing gmail.ts', past: 'Edited gmail.ts' });
    expect(describeTool(tool('4', 'Read', 'src/confinement/probe.ts'))).toMatchObject({ kind: 'read', past: 'Read probe.ts' });
    expect(describeTool(tool('5', 'TodoWrite', '{"todos":[]}'))).toBeNull();
  });
});

describe('currentTool and recentTools', () => {
  const turns: ConversationTurn[] = [
    tool('a', 'Read', 'src/a.ts'),
    { id: 'm', role: 'assistant', text: 'Now editing.', ts: '' },
    tool('b', 'Edit', 'src/b.ts'),
    tool('c', 'TodoWrite', '{}'),
  ];
  it('treats the trailing tool call as in progress, skipping bookkeeping', () => {
    expect(currentTool(turns)?.id).toBe('b');
    expect(currentTool([...turns, { id: 'r', role: 'assistant', text: 'Done.', ts: '' }])).toBeNull();
  });
  it('lists tool calls newest first', () => {
    expect(recentTools(turns, 4).map((entry) => entry.id)).toEqual(['b', 'a']);
  });
});

describe('planProgress', () => {
  it('counts completed steps and finds the current one', () => {
    const progress = planProgress([
      { label: 'Read', status: 'completed' }, { label: 'Fix', status: 'in_progress', activeForm: 'Fixing' }, { label: 'Test', status: 'pending' },
    ]);
    expect(progress).toMatchObject({ done: 1, total: 3, current: { label: 'Fix' } });
    expect(planProgress(undefined)).toBeNull();
    expect(planProgress([])).toBeNull();
  });
});

describe('needsInput and isWorking', () => {
  const question: ConversationView['question'] = { id: 'q', questions: [{ question: 'Which client?', options: [] }, { question: 'Scope?', options: [] }] } as unknown as ConversationView['question'];
  it('raises an open question, or a bare waiting status, and stops the working animation', () => {
    const asking = needsInput(session(), { found: true, turns: [], question });
    expect(asking).toMatchObject({ count: 2, hasQuestion: true });
    expect(asking?.text).toContain('Which client?');
    expect(isWorking(session(), asking)).toBe(false);
    expect(needsInput(session({ status: 'waiting_input' }), null)).toMatchObject({ count: 1, hasQuestion: false });
    expect(isWorking(session(), null)).toBe(true);
    expect(isWorking(session({ status: 'idle' }), null)).toBe(false);
  });
  it('never asks on behalf of an ended session', () => {
    expect(needsInput(session({ status: 'exited' }), { found: true, turns: [], question })).toBeNull();
  });
});

describe('diffTotals', () => {
  it('sums additions and deletions', () => {
    expect(diffTotals([{ path: 'a', additions: 48, deletions: 12 }, { path: 'b', additions: 34, deletions: 9 }])).toMatchObject({ additions: 82, deletions: 21 });
  });
});
