import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentMessage } from '../types.js';
import { appendAgentMessage, BusWatcher, parseBusLines } from './bus.js';

const dirs: string[] = [];
const message: AgentMessage = {
  ts: '2026-07-17T12:00:00.000Z', agent: 'claude:s1', repo: '/repo',
  event: 'claim', task: 'FE-5', files: ['src/a.ts'], message: 'starting',
};

afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe('coordination bus', () => {
  it('atomically appends JSONL and tolerates malformed lines', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-bus-'));
    dirs.push(repo);
    await appendAgentMessage(repo, message);
    fs.appendFileSync(path.join(repo, '.agents', 'bus.jsonl'), 'not-json\n');
    expect(parseBusLines(fs.readFileSync(path.join(repo, '.agents', 'bus.jsonl'), 'utf8'))).toEqual([message]);
  });

  it('tails newly appended records in order without replaying them', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-watch-'));
    dirs.push(repo);
    const received: AgentMessage[] = [];
    const watcher = new BusWatcher(repo, (entry) => received.push(entry));
    await watcher.start();
    await appendAgentMessage(repo, message);
    await watcher.scan();
    await watcher.scan();
    expect(received).toEqual([message]);
    watcher.stop();
  });
});
