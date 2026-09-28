// Issue #88: connecting one Gmail account (decision 0002). Consent runs in the
// system browser through a loopback redirect with PKCE; AgentDeck keeps only
// the refresh token, in the owner's login Keychain (keychain.ts), and the
// mailbox address. The OAuth client is a Desktop client: Google does not treat
// its secret as confidential.
//
// Decision 0002 has AgentDeck ship one owned client. Until it is registered,
// no client is embedded and the owner's own Desktop client file is used
// (AGENTDECK_GMAIL_CLIENT_FILE, or gmail-oauth-client.json in the data
// directory), else the one the Mac app was packaged with; without any,
// email shows the 'no-client' repair state.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import path from 'node:path';

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
] as const;

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

export interface OAuthClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** The AgentDeck-owned client from decision 0002, once it is registered. */
const EMBEDDED_CLIENT: OAuthClient | undefined = undefined;

export const GMAIL_CLIENT_FILE = 'gmail-oauth-client.json';

/**
 * scripts/build-mac-app.mjs copies the packager's client file next to this
 * module, so the people the app is given to never handle one themselves.
 */
export const BUNDLED_GMAIL_CLIENT_FILE = path.join(import.meta.dirname, GMAIL_CLIENT_FILE);

function readClientFile(file: string): OAuthClient | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { installed?: { client_id?: unknown; client_secret?: unknown } };
    const { client_id: clientId, client_secret: clientSecret } = parsed.installed ?? {};
    if (typeof clientId === 'string' && clientId && typeof clientSecret === 'string') return { clientId, clientSecret };
  } catch { /* try the next source */ }
  return undefined;
}

/** The Desktop client to use, or undefined when this build has none. The owner's own file wins over the bundled one. */
export function loadGmailClient(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
  bundledFile: string = BUNDLED_GMAIL_CLIENT_FILE,
): OAuthClient | undefined {
  return readClientFile(env.AGENTDECK_GMAIL_CLIENT_FILE ?? path.join(dataDir, GMAIL_CLIENT_FILE))
    ?? readClientFile(bundledFile)
    ?? EMBEDDED_CLIENT;
}

export function missingScopes(granted: string | readonly string[]): string[] {
  const list = typeof granted === 'string' ? granted.split(/\s+/) : granted;
  return GMAIL_SCOPES.filter((scope) => !list.includes(scope));
}

export class GmailConsentError extends Error {
  constructor(readonly code: 'cancelled' | 'timeout' | 'missing-scope' | 'no-refresh-token' | 'no-client' | 'unreachable', message: string) {
    super(message);
    this.name = 'GmailConsentError';
  }
}

export interface AuthorizeOptions {
  readonly client: OAuthClient;
  /** Opens the consent page in the system browser. */
  readonly openUrl: (url: string) => void;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

export interface GmailConsent {
  readonly refreshToken: string;
  readonly scopes: string[];
}

/** One consent flow. Resolves with the refresh token only when both scopes were granted. */
export async function authorizeGmail(options: AuthorizeOptions): Promise<GmailConsent> {
  const fetchImpl = options.fetch ?? fetch;
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('hex');

  const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
    let redirectUri = '';
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/') {
        response.writeHead(404).end();
        return;
      }
      // Anything but our own state is ignored, so another local page cannot end the flow.
      if (url.searchParams.get('state') !== state) {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('This sign-in link is not the one AgentDeck opened.');
        return;
      }
      const granted = url.searchParams.get('code');
      response.writeHead(granted ? 200 : 400, { 'content-type': 'text/plain; charset=utf-8' })
        .end(granted ? 'Gmail is connected to AgentDeck. You can close this tab.' : 'Gmail was not connected. You can close this tab.');
      finish();
      if (granted) resolve({ code: granted, redirectUri });
      else reject(new GmailConsentError('cancelled', 'Google did not grant access. Nothing was connected.'));
    });
    const timer = setTimeout(() => {
      finish();
      reject(new GmailConsentError('timeout', 'Gmail consent was not finished within 5 minutes. Nothing was connected.'));
    }, options.timeoutMs ?? 5 * 60_000);
    const finish = () => {
      clearTimeout(timer);
      server.closeAllConnections();
      server.close();
    };
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      redirectUri = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
      const url = new URL(GOOGLE_AUTH_URL);
      url.search = new URLSearchParams({
        client_id: options.client.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: GMAIL_SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'false',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
      }).toString();
      options.openUrl(url.toString());
    });
  });

  let response: Response;
  try {
    response = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier,
        client_id: options.client.clientId, client_secret: options.client.clientSecret,
      }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new GmailConsentError('unreachable', 'Google could not be reached to finish connecting Gmail.');
  }
  const token = await response.json().catch(() => ({})) as { refresh_token?: string; scope?: string; error?: string };
  if (!response.ok) {
    if (token.error === 'invalid_client' || token.error === 'unauthorized_client') {
      throw new GmailConsentError('no-client', 'Google rejected the Gmail client this build uses.');
    }
    throw new GmailConsentError('cancelled', 'Google did not complete the connection. Nothing was connected.');
  }
  const scopes = (token.scope ?? '').split(/\s+/).filter(Boolean);
  if (!token.refresh_token) throw new GmailConsentError('no-refresh-token', 'Google returned no lasting sign-in. Try connecting again.');
  if (missingScopes(scopes).length > 0) {
    await revokeGmailToken(token.refresh_token, fetchImpl);
    throw new GmailConsentError('missing-scope', 'Both Gmail permissions are needed: reading mail and managing drafts. Connect again and leave both ticked.');
  }
  return { refreshToken: token.refresh_token, scopes };
}

/** Best effort: asks Google to forget the grant. The Keychain copy is removed separately. */
export async function revokeGmailToken(token: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  try {
    await fetchImpl(GOOGLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
  } catch { /* the owner can also remove access at myaccount.google.com/permissions */ }
}
