import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { callBroker } from '../test-fixtures/filing-agent.js';
import { FILING_BROKER_MCP_TOOLS, startFilingBroker, type FilingBroker, type FilingBrokerEvent } from './filing-broker.js';
import { listGrantFolders } from './folder-grant.js';

let base: string;
let root: string;
let broker: FilingBroker;
let events: FilingBrokerEvent[];
let revoked: boolean;

async function start(maxCalls?: number): Promise<void> {
  broker = await startFilingBroker({
    documents: [
      { id: 'doc-1', path: 'Inbox/scan 1.pdf', sha256: 'a'.repeat(64), pages: 2, title: 'Power', text: 'City Power statement', truncated: false },
    ],
    checkAccess: () => {
      if (revoked) throw new Error('Access to the folder was revoked.');
      return { root };
    },
    listFolders: () => listGrantFolders(root),
    onEvent: (event) => events.push(event),
    ...(maxCalls !== undefined ? { maxCalls } : {}),
  });
}

beforeEach(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adk-filing-broker-')));
  root = path.join(base, 'granted');
  fs.mkdirSync(path.join(root, 'Inbox'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Bills'));
  fs.mkdirSync(path.join(root, '.private'));
  fs.mkdirSync(path.join(base, 'outside'));
  fs.symlinkSync(path.join(base, 'outside'), path.join(root, 'Shortcut'));
  events = [];
  revoked = false;
  await start();
});

afterEach(async () => {
  await broker.close();
  fs.rmSync(base, { recursive: true, force: true });
});

describe('filing broker', () => {
  it('names its tools under one MCP server', () => {
    expect(FILING_BROKER_MCP_TOOLS).toEqual([
      'mcp__agentdeck__list_documents', 'mcp__agentdeck__read_document', 'mcp__agentdeck__list_folders', 'mcp__agentdeck__propose_filing',
    ]);
  });

  it('refuses requests without the per-session token', async () => {
    const response = await fetch(broker.url, { method: 'POST', body: '{}' });
    expect(response.status).toBe(401);
    const wrong = await callBroker({ url: broker.url, token: 'nope' }, 'list_documents').catch(() => 'rejected');
    expect(wrong).toBe('rejected');
  });

  it('lists documents by opaque id and folders without hidden entries or links', async () => {
    expect(JSON.parse((await callBroker(broker, 'list_documents')).text)).toEqual([{ document: 'doc-1', name: 'scan 1.pdf', folder: 'Inbox', pages: 2 }]);
    expect(JSON.parse((await callBroker(broker, 'list_folders')).text)).toEqual({ folders: ['Bills', 'Inbox'], truncated: false });
  });

  it('serves document text labelled as untrusted and records the read', async () => {
    const result = await callBroker(broker, 'read_document', { document: 'doc-1' });
    expect(result.text).toMatch(/^UNTRUSTED DOCUMENT CONTENT/);
    expect(result.text).toContain('City Power statement');
    expect(result.text).not.toContain(root);
    expect(events).toEqual([{ kind: 'document-read', path: 'Inbox/scan 1.pdf' }]);
  });

  it('never accepts a path in place of a document id', async () => {
    for (const document of ['Inbox/scan 1.pdf', '../outside/secret.pdf', '/etc/passwd', 'doc-2']) {
      const result = await callBroker(broker, 'read_document', { document });
      expect(result).toEqual({ isError: true, text: expect.stringMatching(/not one of the selected documents/) });
    }
  });

  it('records a valid proposal and replaces it on a second call', async () => {
    expect(await callBroker(broker, 'propose_filing', { document: 'doc-1', new_name: 'Power.pdf', destination: 'Bills' }))
      .toEqual({ isError: false, text: 'Recorded for review. Nothing was moved.' });
    expect((await callBroker(broker, 'propose_filing', { document: 'doc-1', new_name: 'Power 2026.pdf', destination: 'Bills/2026' })).text)
      .toMatch(/would be created/);
    expect([...broker.requests()]).toEqual([['Inbox/scan 1.pdf', { newName: 'Power 2026.pdf', destination: 'Bills/2026' }]]);
    expect(fs.existsSync(path.join(root, 'Bills', '2026'))).toBe(false);
  });

  it.each([
    [{ new_name: '../../escape.pdf', destination: 'Bills' }, /may not contain/],
    [{ new_name: 'x.pdf', destination: '../outside' }, /not a folder name/],
    [{ new_name: 'x.pdf', destination: '/Users' }, /inside the granted folder/],
    [{ new_name: 'x.pdf', destination: 'Shortcut' }, /link/],
    [{ new_name: 'x.pdf', destination: '.private' }, /dot/],
    [{ new_name: 'x.sh', destination: 'Bills' }, /\.pdf/],
    [{ new_name: 7, destination: 'Bills' }, /text/],
  ])('refuses the unsafe proposal %j', async (args, message) => {
    const result = await callBroker(broker, 'propose_filing', { document: 'doc-1', ...args });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(message);
    expect(broker.requests().size).toBe(0);
    expect(events.at(-1)).toMatchObject({ kind: 'broker-refused', tool: 'propose_filing', path: 'Inbox/scan 1.pdf' });
  });

  it('refuses unknown tools without echoing their names', async () => {
    const result = await callBroker(broker, 'move_file', { from: 'a', to: 'b' });
    expect(result).toEqual({ isError: true, text: 'Refused: unknown tool.' });
    expect(events).toEqual([{ kind: 'broker-refused', tool: 'unknown', reason: 'unknown tool.' }]);
  });

  it('ends the session once the grant is revoked', async () => {
    revoked = true;
    expect((await callBroker(broker, 'read_document', { document: 'doc-1' })).text).toMatch(/revoked/);
    revoked = false;
    expect((await callBroker(broker, 'list_documents')).isError).toBe(true);
    expect(broker.accessLost()).toMatch(/revoked/);
  });

  it('bounds the number of tool calls', async () => {
    await broker.close();
    await start(2);
    await callBroker(broker, 'list_documents');
    await callBroker(broker, 'list_folders');
    expect((await callBroker(broker, 'list_documents')).text).toMatch(/all of its tool calls/);
  });
});
