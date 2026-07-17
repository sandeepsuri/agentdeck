// End-to-end test of dashboard→agent message delivery: the hook script is
// spawned exactly as Claude Code would run it.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendInboxMessage } from '../coordination/bus.js';

const HOOK = path.resolve(import.meta.dirname, '../../bin/agentdeck-hook.mjs');

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-inbox-'));
  execFileSync('git', ['-C', dir, 'init', '--quiet']);
  return fs.realpathSync(dir);
}

function runHook(payload: unknown): string {
  const result = spawnSync('node', [HOOK], { input: JSON.stringify(payload), encoding: 'utf8' });
  expect(result.status).toBe(0);
  return result.stdout;
}

describe('dashboard inbox delivery via UserPromptSubmit hook', () => {
  it('drains queued messages into additionalContext, then stays silent', async () => {
    const repo = makeRepo();
    await appendInboxMessage(repo, { ts: '2026-07-17T00:00:00Z', to: 'claude:s-1', text: 'please rebase first' });
    await appendInboxMessage(repo, { ts: '2026-07-17T00:01:00Z', to: 'claude:s-1', text: 'then run the tests' });
    await appendInboxMessage(repo, { ts: '2026-07-17T00:02:00Z', to: 'claude:s-2', text: 'not for this terminal' });

    const payload = { cwd: repo, hook_event_name: 'UserPromptSubmit', session_id: 's-1', prompt: 'hi' };
    const stdout = runHook(payload);
    const parsed = JSON.parse(stdout) as { systemMessage: string; hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('please rebase first');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('then run the tests');
    expect(parsed.systemMessage).toContain('2 dashboard message(s)');
    expect(parsed.systemMessage).toContain('please rebase first');
    expect(fs.readFileSync(path.join(repo, '.agents', 'inbox.jsonl'), 'utf8')).toContain('not for this terminal');

    // second turn: inbox already drained → no output at all
    expect(runHook(payload).trim()).toBe('');
    expect(fs.readFileSync(path.join(repo, '.agents', 'inbox.jsonl'), 'utf8')).toContain('claude:s-2');
  });

  it('drains queued messages on SessionStart so a restart picks them up', async () => {
    const repo = makeRepo();
    await appendInboxMessage(repo, { ts: '2026-07-17T00:00:00Z', to: 'claude:s-1', text: 'hello from the dashboard' });

    const payload = { cwd: repo, hook_event_name: 'SessionStart', session_id: 's-1' };
    const stdout = runHook(payload);
    const parsed = JSON.parse(stdout) as { systemMessage: string; hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('hello from the dashboard');
    expect(parsed.systemMessage).toContain('hello from the dashboard');
    expect(fs.readFileSync(path.join(repo, '.agents', 'inbox.jsonl'), 'utf8').trim()).toBe('');

    // SessionStart still records its bus event, but stdout stays silent once drained
    expect(runHook(payload).trim()).toBe('');
    const bus = fs.readFileSync(path.join(repo, '.agents', 'bus.jsonl'), 'utf8').trim().split('\n');
    expect(bus).toHaveLength(2);
    expect(JSON.parse(bus[0]!)).toMatchObject({
      agent: 'claude:s-1', event: 'session_start', sourcePids: expect.any(Array),
    });
  });

  it('extracts the agent reply from the transcript on Stop', () => {
    const repo = makeRepo();
    const transcript = path.join(repo, 'transcript.jsonl');
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'do the thing' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'All done — the thing is finished.' }] } }),
      '',
    ].join('\n'));

    runHook({ cwd: repo, hook_event_name: 'Stop', session_id: 's-1', transcript_path: transcript });
    const bus = fs.readFileSync(path.join(repo, '.agents', 'bus.jsonl'), 'utf8').trim();
    const event = JSON.parse(bus) as { event: string; message?: string; summary?: string };
    expect(event.event).toBe('done');
    expect(event.message).toBe('All done — the thing is finished.');
    expect(event.summary).toBe('All done — the thing is finished.');
  });

  it('produces no output when there is no inbox file', () => {
    const repo = makeRepo();
    const stdout = runHook({ cwd: repo, hook_event_name: 'UserPromptSubmit', session_id: 's-1', prompt: 'hi' });
    expect(stdout.trim()).toBe('');
  });
});
