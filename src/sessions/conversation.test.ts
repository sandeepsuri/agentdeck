import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentMessage, Session } from '../types.js';
import {
  claudeProjectDirName, ConversationReader, locateTranscript, mergeSentConversationTurns, parseClaudeConversation, parseCodexConversation,
} from './conversation.js';

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-conversation-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const jsonl = (...records: unknown[]) => records.map((record) => JSON.stringify(record)).join('\n');

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'managed-1', origin: 'managed', agent: 'claude', cwd: '/Users/me/Code/app',
    startedAt: '2026-09-27T20:00:00.000Z', lastActivityAt: '2026-09-27T20:00:00.000Z',
    status: 'running', statusSource: 'pty', ...overrides,
  } as Session;
}

const claudeLines = jsonl(
  { type: 'user', uuid: 'u0', isMeta: true, timestamp: '2026-09-27T20:00:01Z', message: { role: 'user', content: 'meta' } },
  { type: 'user', uuid: 'u1', timestamp: '2026-09-27T20:00:02Z', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
  { type: 'user', uuid: 'u2', timestamp: '2026-09-27T20:00:03Z', message: { role: 'user', content: 'Fix the login bug' } },
  { type: 'assistant', uuid: 'a1', timestamp: '2026-09-27T20:00:04Z', message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Looking now.' }] } },
  { type: 'assistant', uuid: 'a2', timestamp: '2026-09-27T20:00:05Z', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } }] } },
  { type: 'user', uuid: 'r1', timestamp: '2026-09-27T20:00:06Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
  { type: 'assistant', uuid: 'a3', timestamp: '2026-09-27T20:00:07Z', message: { content: [{ type: 'text', text: 'Tests pass.' }] } },
  { type: 'assistant', uuid: 'a4', timestamp: '2026-09-27T20:00:08Z', message: { content: [{ type: 'text', text: 'Fixed.' }] } },
  'not json',
);

const codexLines = (cwd: string, timestamp: string) => jsonl(
  { timestamp, type: 'session_meta', payload: { id: 'thread-1', timestamp, cwd } },
  { timestamp, type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules' }] } },
  { timestamp, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n<cwd>x</cwd>' }] } },
  { timestamp, type: 'response_item', payload: { type: 'message', id: 'm1', role: 'user', content: [{ type: 'input_text', text: 'Add dark mode' }] } },
  { timestamp, type: 'response_item', payload: { type: 'reasoning', summary: [] } },
  { timestamp, type: 'response_item', payload: { type: 'function_call', id: 'f1', name: 'shell', arguments: '{"command":["rg","theme"]}' } },
  { timestamp, type: 'response_item', payload: { type: 'function_call_output', output: 'lots' } },
  { timestamp, type: 'response_item', payload: { type: 'message', id: 'm2', role: 'assistant', content: [{ type: 'output_text', text: 'Done — added a toggle.' }] } },
  { timestamp, type: 'event_msg', payload: { type: 'token_count' } },
);

describe('parseClaudeConversation', () => {
  it('keeps what the user typed, the replies and tool calls, and drops meta, harness wrappers, thinking and tool results', () => {
    const turns = parseClaudeConversation(claudeLines.split('\n'));
    expect(turns.map(({ role, text, toolName }) => ({ role, text, ...(toolName ? { toolName } : {}) }))).toEqual([
      { role: 'user', text: 'Fix the login bug' },
      { role: 'assistant', text: 'Looking now.' },
      { role: 'tool', toolName: 'Bash', text: 'npm test' },
      { role: 'assistant', text: 'Tests pass.\n\nFixed.' },
    ]);
  });
});

describe('parseCodexConversation', () => {
  it('keeps user and assistant messages and tool calls, dropping developer, context and reasoning items', () => {
    const turns = parseCodexConversation(codexLines('/x', '2026-09-27T20:00:01Z').split('\n'));
    expect(turns.map(({ role, text, toolName }) => ({ role, text, ...(toolName ? { toolName } : {}) }))).toEqual([
      { role: 'user', text: 'Add dark mode' },
      { role: 'tool', toolName: 'shell', text: 'rg theme' },
      { role: 'assistant', text: 'Done — added a toggle.' },
    ]);
  });
});

describe('locateTranscript', () => {
  it('finds a Claude transcript by the hook-reported id, else by the session start time in the cwd folder', async () => {
    const root = tempDir();
    const project = path.join(root, claudeProjectDirName('/Users/me/Code/app'));
    fs.mkdirSync(project);
    expect(claudeProjectDirName('/Users/me/Code/my.app')).toBe('-Users-me-Code-my-app');
    const older = path.join(project, 'older.jsonl');
    const ours = path.join(project, 'ours.jsonl');
    fs.writeFileSync(older, jsonl({ type: 'user', timestamp: '2026-09-27T18:00:00Z' }));
    fs.writeFileSync(ours, jsonl({ type: 'user', timestamp: '2026-09-27T20:00:03Z' }));
    const roots = { claude: [root], codex: [] };

    expect(await locateTranscript(session({ agentSessionId: 'older' }), roots)).toBe(older);
    expect(await locateTranscript(session({ agentSessionId: 'claude:older' }), roots)).toBe(older);
    expect(await locateTranscript(session(), roots)).toBe(ours);
    expect(await locateTranscript(session({ startedAt: '2026-09-28T00:00:00.000Z' }), roots)).toBeUndefined();
  });

  it('finds a Codex rollout by thread id, else by matching cwd and start time', async () => {
    const root = tempDir();
    const startedAt = '2026-09-27T20:00:00.000Z';
    const local = new Date(startedAt);
    const day = path.join(root, String(local.getFullYear()), String(local.getMonth() + 1).padStart(2, '0'), String(local.getDate()).padStart(2, '0'));
    fs.mkdirSync(day, { recursive: true });
    const other = path.join(day, 'rollout-2026-09-27T16-00-01-thread-9.jsonl');
    const ours = path.join(day, 'rollout-2026-09-27T16-00-02-thread-1.jsonl');
    fs.writeFileSync(other, codexLines('/Users/me/Code/other', '2026-09-27T20:00:01Z'));
    fs.writeFileSync(ours, codexLines('/Users/me/Code/app', '2026-09-27T20:00:02Z'));
    const roots = { claude: [], codex: [root] };

    expect(await locateTranscript(session({ agent: 'codex', agentSessionId: 'thread-9' }), roots)).toBe(other);
    expect(await locateTranscript(session({ agent: 'codex', agentSessionId: 'codex:thread-9' }), roots)).toBe(other);
    expect(await locateTranscript(session({ agent: 'codex' }), roots)).toBe(ours);
  });
});

describe('ConversationReader', () => {
  it('reports not found until the transcript exists, then follows it as it grows', async () => {
    const root = tempDir();
    const reader = new ConversationReader({ claude: [root], codex: [] });
    expect(await reader.read(session())).toEqual({ found: false, turns: [] });

    const project = path.join(root, claudeProjectDirName('/Users/me/Code/app'));
    fs.mkdirSync(project);
    const file = path.join(project, 'ours.jsonl');
    fs.writeFileSync(file, jsonl({ type: 'user', uuid: 'u', timestamp: '2026-09-27T20:00:03Z', message: { content: 'hello' } }));
    expect((await reader.read(session())).turns.map((turn) => turn.text)).toEqual(['hello']);

    fs.appendFileSync(file, `\n${jsonl({ type: 'assistant', uuid: 'a', timestamp: '2026-09-27T20:00:04Z', message: { content: [{ type: 'text', text: 'hi!' }] } })}`);
    expect((await reader.read(session())).turns.map((turn) => turn.text)).toEqual(['hello', 'hi!']);
  });

  it('switches from a provisional time match to the hook-identified transcript', async () => {
    const root = tempDir();
    const project = path.join(root, claudeProjectDirName('/Users/me/Code/app'));
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'other.jsonl'), jsonl(
      { type: 'assistant', uuid: 'a', timestamp: '2026-09-27T20:00:01Z', message: { content: [{ type: 'text', text: 'other session' }] } },
    ));
    fs.writeFileSync(path.join(project, 'ours.jsonl'), jsonl(
      { type: 'assistant', uuid: 'b', timestamp: '2026-09-27T20:00:02Z', message: { content: [{ type: 'text', text: 'agent reply' }] } },
    ));
    const reader = new ConversationReader({ claude: [root], codex: [] });
    expect((await reader.read(session())).turns.map((turn) => turn.text)).toEqual(['other session']);
    expect((await reader.read(session({ agentSessionId: 'claude:ours' }))).turns.map((turn) => turn.text)).toEqual(['agent reply']);
  });
});

describe('mergeSentConversationTurns', () => {
  it('shows a recorded send until the transcript contains it, without duplicating repeated messages', () => {
    const current = session();
    const sent: AgentMessage[] = [1, 2].map((second) => ({
      ts: `2026-09-27T20:00:0${second}.000Z`, agent: `dashboard:${current.id}`, repo: current.cwd,
      event: 'message' as const, message: 'retry', sessionId: current.id,
    }));
    const transcript = { found: true, turns: [{
      id: 'u1', role: 'user' as const, text: 'retry', ts: '2026-09-27T20:00:01.500Z',
    }] };
    expect(mergeSentConversationTurns(transcript, current, sent).turns.map((turn) => turn.text)).toEqual(['retry', 'retry']);
    expect(mergeSentConversationTurns({ found: false, turns: [] }, current, sent).turns).toHaveLength(2);
    expect(mergeSentConversationTurns(transcript, current, [
      { ...sent[0]!, sessionId: 'another-session' },
    ]).turns).toHaveLength(1);
  });
});
