import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapHookPayload } from './mapper.js';

const claude = fs.readFileSync(path.resolve(import.meta.dirname, 'fixtures/claude-hook-payloads.jsonl'), 'utf8')
  .trim().split('\n').map((line) => JSON.parse(line) as unknown);
const codex = fs.readFileSync(path.resolve(import.meta.dirname, 'fixtures/codex-notify-payloads.jsonl'), 'utf8')
  .trim().split('\n').map((line) => JSON.parse(line) as unknown);

describe('mapHookPayload', () => {
  it('maps real Claude notification, edit/write, and stop payloads', () => {
    const mapped = claude.map((payload) => mapHookPayload(payload)).filter(Boolean);
    expect(mapped.find((entry) => entry?.status === 'waiting_input')).toMatchObject({ agent: expect.stringMatching(/^claude:/), event: 'status' });
    expect(mapped.find((entry) => entry?.event === 'claim')).toMatchObject({ files: [expect.not.stringMatching(/^\//)] });
    expect(mapped.find((entry) => entry?.event === 'done')).toMatchObject({ status: 'idle' });
  });

  it('maps the real kebab-case Codex notification', () => {
    expect(mapHookPayload(codex[0])).toMatchObject({
      agent: expect.stringMatching(/^codex:/), event: 'status', status: 'idle', message: 'DONE',
    });
  });
});
