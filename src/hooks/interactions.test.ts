import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const hook = path.resolve(import.meta.dirname, '../../bin/agentdeck-hook.mjs');
let server: http.Server | undefined;
afterEach(() => server?.close());

function runHook(payload: unknown, response: unknown): Promise<{ stdout: string; posts: unknown[] }> {
  const posts: unknown[] = [];
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += String(chunk); });
      req.on('end', () => {
        if (req.method === 'POST' && req.url === '/api/provider/claude/interactions') {
          posts.push(JSON.parse(body));
          res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'interaction-1', status: 'pending' }));
        } else {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'resolved', response }));
        }
      });
    }).listen(0, '127.0.0.1', () => {
      const address = server!.address() as { port: number };
      const child = spawn(process.execPath, [hook], { env: { ...process.env, AGENTDECK_HOOK_URL: `http://127.0.0.1:${address.port}` } });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve({ stdout, posts }) : reject(new Error(stderr)));
      child.stdin.end(JSON.stringify(payload));
    });
  });
}

describe('Claude hook Session interaction bridge', () => {
  it('returns selected answers to the same AskUserQuestion tool invocation', async () => {
    const payload = { hook_event_name: 'PreToolUse', session_id: 'provider-session', tool_use_id: 'tool-1',
      tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which package manager?', options: [{ label: 'pnpm' }] }] } };
    const { stdout, posts } = await runHook(payload, { kind: 'answer', answers: { 'Which package manager?': ['pnpm'] } });
    expect(posts).toEqual([expect.objectContaining(payload)]);
    expect(JSON.parse(stdout)).toMatchObject({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow',
      updatedInput: { answers: { 'Which package manager?': 'pnpm' } } } });
  });

  it('returns an explicit denial to a PermissionRequest without auto-approving', async () => {
    const { stdout, posts } = await runHook({ hook_event_name: 'PermissionRequest', session_id: 'provider-session',
      tool_name: 'Bash', tool_input: { command: 'npm test' } }, { kind: 'approval', decision: 'deny' });
    expect((posts[0] as { agentdeck_request_id?: string }).agentdeck_request_id).toBeTruthy();
    expect(JSON.parse(stdout)).toMatchObject({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } } });
  });
});
