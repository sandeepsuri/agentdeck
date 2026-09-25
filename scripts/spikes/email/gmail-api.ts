// Candidate adapter A: the Gmail REST API with an OAuth client the owner
// creates in their own Google Cloud project (Desktop app type). Scopes are the
// minimum the four operations need:
//
//   gmail.readonly — search and read the message being answered, and search
//                    Sent for reconciliation (gmail.metadata cannot use `q`)
//   gmail.compose  — create, update, read, delete, and send drafts
//
// Both are Google "restricted" scopes. See the decision record for what that
// means for pilot versus public distribution.
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { spikeDir, readPrivateJson, writePrivateJson } from './local-state.js';
import { buildMime, contentFromMime, INTENT_HEADER } from './mime.js';
import type { DraftContent, DraftRef, EmailSpikeAdapter, LookupQuery, MessageSummary, SendEvidence } from './types.js';

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
];

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

interface OAuthClient { client_id: string; client_secret: string }
interface StoredToken { refresh_token: string; scope: string; obtained_at: string }

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function clientFile(): string {
  return process.env.AGENTDECK_GMAIL_CLIENT_FILE ?? path.join(spikeDir(), 'gmail-oauth-client.json');
}

function tokenFile(): string {
  return path.join(spikeDir(), 'gmail-token.json');
}

function loadClient(): OAuthClient {
  const file = clientFile();
  const json = readPrivateJson<{ installed?: OAuthClient }>(file);
  if (!json?.installed?.client_id) {
    throw new Error(`No Desktop OAuth client at ${file}. Download it from Google Cloud Console → APIs & Services → Credentials.`);
  }
  return json.installed;
}

/** Interactive consent through a loopback redirect with PKCE. Stores only the refresh token. */
export async function authorizeGmail(): Promise<{ scope: string; elapsedMs: number }> {
  const started = Date.now();
  const client = loadClient();
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('hex');

  const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/') { res.writeHead(404).end(); return; }
      const ok = url.searchParams.get('state') === state && url.searchParams.get('code');
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain' })
        .end(ok ? 'AgentDeck email spike authorized. You can close this tab.' : 'Authorization failed.');
      server.close();
      if (ok) resolve({ code: url.searchParams.get('code')!, redirectUri });
      else reject(new Error(url.searchParams.get('error') ?? 'state mismatch'));
    });
    let redirectUri = '';
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      redirectUri = `http://127.0.0.1:${port}`;
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.search = new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: GMAIL_SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
      }).toString();
      console.log(`Open this URL to grant the spike access:\n${url}\n`);
      execFile('open', [url.toString()], () => {});
    });
  });

  const token = await tokenRequest({
    grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier,
    client_id: client.client_id, client_secret: client.client_secret,
  });
  if (!token.refresh_token) throw new Error('Google returned no refresh token.');
  writePrivateJson(tokenFile(), { refresh_token: token.refresh_token, scope: token.scope, obtained_at: new Date().toISOString() } satisfies StoredToken);
  return { scope: token.scope, elapsedMs: Date.now() - started };
}

async function tokenRequest(form: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; scope: string; expires_in: number }> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  });
  const json = await res.json() as { access_token: string; refresh_token?: string; scope: string; expires_in: number; error?: string; error_description?: string };
  if (!res.ok) throw new HttpError(res.status, `token ${res.status}: ${json.error} ${json.error_description ?? ''}`.trim());
  return json;
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: { headers?: Array<{ name: string; value: string }> };
  raw?: string;
}

export class GmailApiAdapter implements EmailSpikeAdapter {
  readonly name = 'gmail-api';
  private accessToken?: { value: string; expiresAt: number };
  private self?: string;

  async selfAddress(): Promise<string> {
    this.self ??= (await this.call<{ emailAddress: string }>('GET', '/profile')).emailAddress;
    return this.self;
  }

  async lookup(query: LookupQuery, limit: number): Promise<MessageSummary[]> {
    const q = [
      query.from && `from:${query.from}`,
      query.subjectContains && `subject:"${query.subjectContains.replace(/"/g, '')}"`,
      query.messageIdHeader && `rfc822msgid:${stripBrackets(query.messageIdHeader)}`,
    ].filter(Boolean).join(' ');
    const list = await this.call<{ messages?: Array<{ id: string }> }>('GET', `/messages?${new URLSearchParams({ q, maxResults: String(limit) })}`);
    const found: MessageSummary[] = [];
    for (const { id } of list.messages ?? []) {
      const m = await this.metadata(id);
      found.push({ providerId: m.id, threadId: m.threadId, messageIdHeader: header(m, 'Message-ID'), from: header(m, 'From') ?? '', subject: header(m, 'Subject') ?? '', date: header(m, 'Date') });
    }
    return found;
  }

  async createDraft(content: DraftContent, intentId: string, requestedMessageId: string): Promise<DraftRef> {
    const raw = buildMime(content, { from: await this.selfAddress(), messageId: requestedMessageId, intentId });
    const draft = await this.call<{ id: string; message: GmailMessage }>('POST', '/drafts', {
      message: { raw: Buffer.from(raw).toString('base64url'), threadId: content.threadId },
    });
    return this.refFor(draft.id, intentId);
  }

  async updateDraft(ref: DraftRef, content: DraftContent): Promise<DraftRef> {
    const raw = buildMime(content, { from: await this.selfAddress(), messageId: ref.messageIdHeader, intentId: ref.intentId });
    await this.call('PUT', `/drafts/${ref.draftId}`, {
      id: ref.draftId,
      message: { raw: Buffer.from(raw).toString('base64url'), threadId: content.threadId ?? ref.threadId },
    });
    return this.refFor(ref.draftId, ref.intentId);
  }

  async readDraft(ref: DraftRef): Promise<DraftContent | null> {
    try {
      const draft = await this.call<{ message: GmailMessage }>('GET', `/drafts/${ref.draftId}?format=raw`);
      return { ...contentFromMime(Buffer.from(draft.message.raw ?? '', 'base64url').toString('utf8')), threadId: draft.message.threadId };
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return null;
      throw error;
    }
  }

  async deleteDraft(ref: DraftRef): Promise<void> {
    await this.call('DELETE', `/drafts/${ref.draftId}`);
  }

  async sendDraft(ref: DraftRef): Promise<{ providerMessageId: string }> {
    const sent = await this.call<GmailMessage>('POST', '/drafts/send', { id: ref.draftId });
    return { providerMessageId: sent.id };
  }

  async reconcile(ref: DraftRef, sinceMs: number): Promise<SendEvidence> {
    const sent = await this.sentMatches(ref, sinceMs);
    if (sent.length > 0) return { state: 'sent', providerMessageId: sent[0]!.id, via: sent[0]!.via };
    // drafts.send consumes the draft in the same operation that creates the
    // sent message, so a draft that still exists proves the send did not happen.
    if (await this.readDraft(ref)) return { state: 'not_sent', via: 'draft-still-exists' };
    return { state: 'unknown', via: 'draft-gone-no-sent-hit' };
  }

  async sentCopies(ref: DraftRef, sinceMs: number): Promise<number> {
    return (await this.sentMatches(ref, sinceMs)).length;
  }

  /** Sent messages for this intent, by Message-ID search and by intent header within the thread. */
  async sentMatches(ref: DraftRef, sinceMs: number): Promise<Array<{ id: string; via: string; messageIdHeader?: string }>> {
    const matches = new Map<string, { id: string; via: string; messageIdHeader?: string }>();
    const list = await this.call<{ messages?: Array<{ id: string }> }>('GET',
      `/messages?${new URLSearchParams({ q: `rfc822msgid:${stripBrackets(ref.messageIdHeader)}`, includeSpamTrash: 'true' })}`);
    for (const { id } of list.messages ?? []) {
      const m = await this.metadata(id);
      if (m.labelIds?.includes('SENT')) matches.set(m.id, { id: m.id, via: 'rfc822msgid-search', messageIdHeader: header(m, 'Message-ID') });
    }
    if (ref.threadId) {
      const thread = await this.call<{ messages?: GmailMessage[] }>('GET',
        `/threads/${ref.threadId}?${new URLSearchParams([['format', 'metadata'], ['metadataHeaders', INTENT_HEADER], ['metadataHeaders', 'Message-ID']])}`);
      for (const m of thread.messages ?? []) {
        const recent = Number(m.internalDate ?? 0) >= sinceMs - 60_000;
        if (recent && m.labelIds?.includes('SENT') && header(m, INTENT_HEADER) === ref.intentId && !matches.has(m.id)) {
          matches.set(m.id, { id: m.id, via: 'thread-intent-header', messageIdHeader: header(m, 'Message-ID') });
        }
      }
    }
    return [...matches.values()];
  }

  private async refFor(draftId: string, intentId: string): Promise<DraftRef> {
    const draft = await this.call<{ id: string; message: GmailMessage }>('GET',
      `/drafts/${draftId}?${new URLSearchParams([['format', 'metadata'], ['metadataHeaders', 'Message-ID']])}`);
    return { draftId, intentId, messageIdHeader: header(draft.message, 'Message-ID') ?? '', threadId: draft.message.threadId };
  }

  private metadata(id: string): Promise<GmailMessage> {
    const params = new URLSearchParams([['format', 'metadata'], ...['From', 'Subject', 'Date', 'Message-ID', INTENT_HEADER].map((h) => ['metadataHeaders', h])]);
    return this.call<GmailMessage>('GET', `/messages/${id}?${params}`);
  }

  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 30_000) return this.accessToken.value;
    const stored = readPrivateJson<StoredToken>(tokenFile());
    if (!stored) throw new Error('Not authorized. Run: npx tsx scripts/spikes/email/run.ts gmail-auth');
    const client = loadClient();
    const token = await tokenRequest({ grant_type: 'refresh_token', refresh_token: stored.refresh_token, client_id: client.client_id, client_secret: client.client_secret });
    this.accessToken = { value: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 };
    return token.access_token;
  }

  private async call<T = unknown>(method: string, route: string, body?: unknown): Promise<T> {
    const res = await fetch(`${API}${route}`, {
      method,
      headers: { authorization: `Bearer ${await this.token()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new HttpError(res.status, `${method} ${route.split('?')[0]} → ${res.status} ${(await res.text()).slice(0, 300)}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }
}

function header(message: GmailMessage, name: string): string | undefined {
  return message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

function stripBrackets(messageId: string): string {
  return messageId.replace(/^<|>$/g, '');
}
