import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../store/index.js';
import { UsageQueries } from './aggregate.js';
import { UsageIndexer } from './indexer.js';
import { DEFAULT_PRICING } from './pricing.js';

let dir: string;
let store: Store;

const assistant = (id: string, output: number, timestamp = '2026-09-10T12:00:00.000Z') => `${JSON.stringify({
  type: 'assistant', sessionId: 's1', cwd: '/repos/app', timestamp,
  message: { id, model: 'claude-sonnet-5', usage: { input_tokens: 100, output_tokens: output } },
})}\n`;

function setup() {
  const claudeDir = path.join(dir, 'claude', 'projects', '-repos-app');
  const codexDir = path.join(dir, 'codex', 'sessions', '2026', '09', '10');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });
  const indexer = new UsageIndexer({
    repository: store.usage,
    roots: { claude: [path.join(dir, 'claude', 'projects')], codex: [path.join(dir, 'codex', 'sessions')] },
  });
  const queries = new UsageQueries({ repository: store.usage, getPricing: () => DEFAULT_PRICING, now: () => new Date('2026-09-12T12:00:00Z') });
  return { claudeFile: path.join(claudeDir, 's1.jsonl'), codexFile: path.join(codexDir, 'rollout-x.jsonl'), indexer, queries };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-usage-'));
  store = new Store(':memory:');
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('UsageIndexer', () => {
  it('reads only appended bytes and leaves a partial trailing line for the next pass', async () => {
    const { claudeFile, indexer, queries } = setup();
    fs.writeFileSync(claudeFile, assistant('msg_1', 10) + assistant('msg_1', 50));
    await indexer.refresh();
    expect(queries.summary().allTime).toMatchObject({ events: 1, outputTokens: 50 });

    const next = assistant('msg_2', 70);
    fs.appendFileSync(claudeFile, next.slice(0, 40));
    await indexer.refresh();
    expect(queries.summary().allTime.events).toBe(1);

    fs.appendFileSync(claudeFile, next.slice(40));
    await indexer.refresh();
    expect(queries.summary().allTime).toMatchObject({ events: 2, outputTokens: 120, inputTokens: 200 });
  });

  it('starts over when a file shrinks, without double counting', async () => {
    const { claudeFile, indexer, queries } = setup();
    fs.writeFileSync(claudeFile, assistant('msg_1', 10) + assistant('msg_2', 10));
    await indexer.refresh();
    fs.writeFileSync(claudeFile, assistant('msg_3', 5));
    await indexer.refresh();
    expect(queries.summary().allTime.events).toBe(3);
  });

  it('indexes Codex logs and keeps the latest plan-limit snapshot', async () => {
    const { codexFile, indexer, queries } = setup();
    const lines = [
      { timestamp: '2026-09-10T12:00:00.000Z', type: 'session_meta', payload: { id: 'cx', cwd: '/repos/api' } },
      { timestamp: '2026-09-10T12:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.5' } },
      {
        timestamp: '2026-09-10T12:00:02.000Z', type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { total_tokens: 1100 }, last_token_usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100 } },
          rate_limits: { plan_type: 'plus', primary: { used_percent: 12, window_minutes: 10080 } },
        },
      },
    ];
    fs.writeFileSync(codexFile, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    await indexer.refresh();
    const [model] = queries.models('all');
    expect(model).toMatchObject({ provider: 'codex', model: 'gpt-5.5', totalTokens: 1100 });
    expect(model?.costUsd).toBeCloseTo((1000 * 5 + 100 * 30) / 1_000_000);
    expect(indexer.rateLimits()).toEqual([expect.objectContaining({ provider: 'codex', planType: 'plus', primary: { usedPercent: 12, windowMinutes: 10080 } })]);
  });
});
