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
    await appendInboxMessage(repo, { ts: '2026-07-17T00:00:00Z', to: 'claude', text: 'please rebase first' });
    await appendInboxMessage(repo, { ts: '2026-07-17T00:01:00Z', to: 'claude', text: 'then run the tests' });

    const payload = { cwd: repo, hook_event_name: 'UserPromptSubmit', session_id: 's-1', prompt: 'hi' };
    const stdout = runHook(payload);
    const parsed = JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('please rebase first');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('then run the tests');
    expect(fs.readFileSync(path.join(repo, '.agents', 'inbox.jsonl'), 'utf8').trim()).toBe('');

    // second turn: inbox already drained → no output at all
    expect(runHook(payload).trim()).toBe('');
  });

  it('produces no output when there is no inbox file', () => {
    const repo = makeRepo();
    const stdout = runHook({ cwd: repo, hook_event_name: 'UserPromptSubmit', session_id: 's-1', prompt: 'hi' });
    expect(stdout.trim()).toBe('');
  });
});
