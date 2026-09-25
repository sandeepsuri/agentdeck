import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startProbeBroker, type ProbeBroker } from './probe-broker.js';

let broker: ProbeBroker | undefined;
let tempRoot: string | undefined;

afterEach(async () => {
  await broker?.close();
  broker = undefined;
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

async function setup() {
  tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-broker-')));
  const granted = path.join(tempRoot, 'granted');
  fs.mkdirSync(granted);
  fs.writeFileSync(path.join(granted, 'note.txt'), 'granted-content');
  fs.writeFileSync(path.join(tempRoot, 'outside.txt'), 'outside-content');
  fs.symlinkSync(path.join(tempRoot, 'outside.txt'), path.join(granted, 'link.txt'));
  broker = await startProbeBroker({ grantedRoot: granted });
  return broker;
}

async function rpc(target: ProbeBroker, method: string, params: unknown = {}, token = target.token) {
  const response = await fetch(target.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: response.status, body: response.status === 200 ? await response.json() as any : undefined };
}

describe('startProbeBroker', () => {
  it('speaks enough MCP for a CLI to discover its one tool', async () => {
    const target = await setup();
    const init = await rpc(target, 'initialize', { protocolVersion: '2025-06-18' });
    expect(init.body.result.protocolVersion).toBe('2025-06-18');
    expect(init.body.result.capabilities).toEqual({ tools: {} });
    const listed = await rpc(target, 'tools/list');
    expect(listed.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['read_granted_file']);
  });

  it('performs the granted read and records it', async () => {
    const target = await setup();
    const call = await rpc(target, 'tools/call', { name: 'read_granted_file', arguments: { name: 'note.txt' } });
    expect(call.body.result.content).toEqual([{ type: 'text', text: 'granted-content' }]);
    expect(target.operations()).toEqual([{ tool: 'read_granted_file', name: 'note.txt', allowed: true }]);
  });

  it('refuses traversal and symlinks that leave the granted root', async () => {
    const target = await setup();
    for (const name of ['../outside.txt', 'link.txt', '/etc/hosts']) {
      const call = await rpc(target, 'tools/call', { name: 'read_granted_file', arguments: { name } });
      expect(call.body.result.isError).toBe(true);
      expect(JSON.stringify(call.body)).not.toContain('outside-content');
    }
    expect(target.operations().every((operation) => !operation.allowed)).toBe(true);
  });

  it('rejects a request without the per-launch bearer token', async () => {
    const target = await setup();
    expect((await rpc(target, 'tools/list', {}, 'wrong')).status).toBe(401);
  });
});
