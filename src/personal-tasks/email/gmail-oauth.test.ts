import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authorizeGmail, GMAIL_SCOPES, loadGmailClient } from './gmail-oauth.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-gmail-oauth-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('loadGmailClient', () => {
  it('reads a Desktop client file from the data directory or the environment, and has none otherwise', () => {
    expect(loadGmailClient(dir, {})).toBeUndefined();
    fs.writeFileSync(path.join(dir, 'gmail-oauth-client.json'), JSON.stringify({ installed: { client_id: 'cid', client_secret: 's' } }));
    expect(loadGmailClient(dir, {})).toEqual({ clientId: 'cid', clientSecret: 's' });
    const other = path.join(dir, 'other.json');
    fs.writeFileSync(other, JSON.stringify({ installed: { client_id: 'env', client_secret: '' } }));
    expect(loadGmailClient(dir, { AGENTDECK_GMAIL_CLIENT_FILE: other })).toEqual({ clientId: 'env', clientSecret: '' });
  });
});

function consent(tokenBody: Record<string, unknown>, redirect: (url: URL) => Record<string, string>) {
  const tokenRequests: URLSearchParams[] = [];
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const form = new URLSearchParams(String(init?.body));
    tokenRequests.push(form);
    return new Response(JSON.stringify(tokenBody), { status: 'error' in tokenBody ? 400 : 200 });
  }) as typeof fetch;
  let opened: URL | undefined;
  const flow = authorizeGmail({
    client: { clientId: 'cid', clientSecret: 'secret' },
    fetch: fetchImpl,
    timeoutMs: 5_000,
    openUrl: (url) => {
      opened = new URL(url);
      const back = new URL(opened.searchParams.get('redirect_uri')!);
      // A stray request with the wrong state is ignored, then Google redirects.
      void fetch(`${back.origin}/?state=wrong&code=evil`).then(() => fetch(`${back.origin}/?${new URLSearchParams(redirect(opened!))}`));
    },
  });
  return { flow, tokenRequests, opened: () => opened! };
}

describe('authorizeGmail', () => {
  it('asks for exactly the two scopes with PKCE and returns the refresh token', async () => {
    const { flow, tokenRequests, opened } = consent(
      { refresh_token: 'rt', scope: GMAIL_SCOPES.join(' ') },
      (url) => ({ state: url.searchParams.get('state')!, code: 'the-code' }),
    );
    await expect(flow).resolves.toEqual({ refreshToken: 'rt', scopes: [...GMAIL_SCOPES] });
    const url = opened();
    expect(url.searchParams.get('scope')).toBe(GMAIL_SCOPES.join(' '));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const form = tokenRequests[0]!;
    expect(form.get('code')).toBe('the-code');
    expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(url.searchParams.get('code_challenge'));
  });

  it('refuses a consent missing a scope and revokes what was granted', async () => {
    const { flow, tokenRequests } = consent(
      { refresh_token: 'rt', scope: GMAIL_SCOPES[0] },
      (url) => ({ state: url.searchParams.get('state')!, code: 'c' }),
    );
    await expect(flow).rejects.toMatchObject({ code: 'missing-scope' });
    expect(tokenRequests.at(-1)!.get('token')).toBe('rt');
  });

  it('ends when the owner declines at Google', async () => {
    const { flow } = consent({}, (url) => ({ state: url.searchParams.get('state')!, error: 'access_denied' }));
    await expect(flow).rejects.toMatchObject({ code: 'cancelled' });
  });
});
