// Issue #88: the Gmail adapter chosen in decision 0002, limited to what
// finding a message and preparing a reply need: search and read one
// account, and create, update, and read back one draft. Issue #89 adds the
// one send of an approved reply, finding that send again in the thread by
// its intent header, and removing the draft it replaces.
//
// Only AgentDeck's own process calls this. The confined agent reaches it
// solely through the email broker; it holds no token and its sandbox's only
// network path is the provider proxy, which does not allow Google.
import { GOOGLE_TOKEN_URL, missingScopes, type OAuthClient } from './gmail-oauth.js';
import { buildReplyMime, INTENT_HEADER, parseAddressList, readGmailPayload, type GmailPayload } from './reply.js';
import type { EmailMessageContext, ReplyDraftContent } from './types.js';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
/** Below the in-flight grace a lost draft write waits out before it is judged absent. */
export const GMAIL_REQUEST_TIMEOUT_MS = 20_000;

export type MailboxErrorCode = 'signed-out' | 'missing-scope' | 'no-client' | 'unreachable' | 'not-found' | 'rejected';

export class MailboxError extends Error {
  constructor(readonly code: MailboxErrorCode, message: string, readonly status?: number) {
    super(message);
    this.name = 'MailboxError';
  }
}

export interface MessageSummary {
  readonly id: string;
  readonly threadId: string;
  readonly from: string;
  readonly subject: string;
  readonly date?: string;
  readonly snippet: string;
}

export interface OutgoingReply {
  readonly content: ReplyDraftContent;
  readonly threadId: string;
  readonly inReplyTo?: string;
  readonly references?: string;
  readonly intentId: string;
  readonly messageId: string;
}

export interface DraftReadBack {
  readonly content: ReplyDraftContent;
  readonly intentId?: string;
}

/** Everything AgentDeck may do with a granted account while preparing a reply. */
export interface Mailbox {
  profile(): Promise<{ address: string; scopes: string[] }>;
  search(query: string, max: number): Promise<MessageSummary[]>;
  message(id: string, excerptChars: number): Promise<EmailMessageContext>;
  createDraft(reply: OutgoingReply): Promise<string>;
  updateDraft(draftId: string, reply: OutgoingReply): Promise<void>;
  /** Null when the draft no longer exists (deleted, or sent from Gmail). */
  readDraft(draftId: string): Promise<DraftReadBack | null>;
  /** The draft carrying this intent header in the thread, if Gmail holds one. */
  findDraftByIntent(intentId: string, threadId: string): Promise<string | undefined>;
  /** Sends exactly this reply in its thread; returns Gmail's message id. Only an approved send calls this. */
  sendReply(reply: OutgoingReply): Promise<string>;
  /**
   * The sent message carrying this intent header, if Gmail holds one: in the
   * reply's thread, or anywhere in mail sent since `since` (Gmail starts a new
   * thread when the subject was changed).
   */
  findSentByIntent(intentId: string, threadId: string, since: string): Promise<string | undefined>;
  /** Removes a draft; one already gone is not an error. */
  deleteDraft(draftId: string): Promise<void>;
}

export interface GmailMailboxOptions {
  readonly client: OAuthClient;
  readonly refreshToken: string;
  readonly address: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailPayload;
}

function header(message: GmailMessage, name: string): string | undefined {
  return message.payload?.headers?.find((entry) => entry.name.toLowerCase() === name.toLowerCase())?.value;
}

export class GmailMailbox implements Mailbox {
  private readonly fetchImpl: typeof fetch;
  private accessToken?: { value: string; expiresAt: number; scopes: string[] };

  constructor(private readonly options: GmailMailboxOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async profile(): Promise<{ address: string; scopes: string[] }> {
    const profile = await this.call<{ emailAddress: string }>('GET', '/profile');
    return { address: profile.emailAddress, scopes: this.accessToken?.scopes ?? [] };
  }

  async search(query: string, max: number): Promise<MessageSummary[]> {
    const list = await this.call<{ messages?: Array<{ id: string }> }>('GET', `/messages?${new URLSearchParams({ q: query, maxResults: String(max) })}`);
    const found: MessageSummary[] = [];
    for (const { id } of list.messages ?? []) {
      const params = new URLSearchParams([['format', 'metadata'], ...['From', 'Subject', 'Date'].map((name) => ['metadataHeaders', name])]);
      const message = await this.call<GmailMessage>('GET', `/messages/${encodeURIComponent(id)}?${params}`);
      // Unsent drafts and chats are not mail the owner received.
      if (message.labelIds?.some((label) => label === 'DRAFT' || label === 'CHAT')) continue;
      found.push({
        id: message.id,
        threadId: message.threadId,
        from: header(message, 'From') ?? '',
        subject: header(message, 'Subject') ?? '',
        ...(header(message, 'Date') ? { date: header(message, 'Date') } : {}),
        snippet: message.snippet ?? '',
      });
    }
    return found;
  }

  async message(id: string, excerptChars: number): Promise<EmailMessageContext> {
    const message = await this.call<GmailMessage>('GET', `/messages/${encodeURIComponent(id)}?format=full`);
    const read = readGmailPayload(message.payload ?? {});
    const optional = (name: string, key: keyof EmailMessageContext) => {
      const value = read.header(name);
      return value ? { [key]: value } : {};
    };
    return {
      id: message.id,
      threadId: message.threadId,
      from: read.header('from') ?? '',
      ...optional('reply-to', 'replyTo'),
      to: parseAddressList(read.header('to')),
      cc: parseAddressList(read.header('cc')),
      ...optional('date', 'date'),
      subject: read.header('subject') ?? '',
      ...optional('message-id', 'messageIdHeader'),
      ...optional('references', 'references'),
      excerpt: read.content.body.slice(0, excerptChars),
      excerptTruncated: read.content.body.length > excerptChars,
    } as EmailMessageContext;
  }

  async createDraft(reply: OutgoingReply): Promise<string> {
    const draft = await this.call<{ id: string }>('POST', '/drafts', { message: this.rawMessage(reply) });
    return draft.id;
  }

  async updateDraft(draftId: string, reply: OutgoingReply): Promise<void> {
    await this.call('PUT', `/drafts/${encodeURIComponent(draftId)}`, { id: draftId, message: this.rawMessage(reply) });
  }

  async readDraft(draftId: string): Promise<DraftReadBack | null> {
    try {
      const draft = await this.call<{ message: GmailMessage }>('GET', `/drafts/${encodeURIComponent(draftId)}?format=full`);
      const read = readGmailPayload(draft.message.payload ?? {});
      const intentId = read.header(INTENT_HEADER);
      return { content: read.content, ...(intentId ? { intentId } : {}) };
    } catch (error) {
      if (error instanceof MailboxError && error.code === 'not-found') return null;
      throw error;
    }
  }

  async findDraftByIntent(intentId: string, threadId: string): Promise<string | undefined> {
    let pageToken: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const params = new URLSearchParams({ maxResults: '100', ...(pageToken ? { pageToken } : {}) });
      const list = await this.call<{ drafts?: Array<{ id: string; message?: { threadId?: string } }>; nextPageToken?: string }>('GET', `/drafts?${params}`);
      for (const draft of list.drafts ?? []) {
        if (draft.message?.threadId !== threadId) continue;
        const found = await this.readDraft(draft.id);
        if (found?.intentId === intentId) return draft.id;
      }
      pageToken = list.nextPageToken;
      if (!pageToken) break;
    }
    return undefined;
  }

  async sendReply(reply: OutgoingReply): Promise<string> {
    const sent = await this.call<{ id: string }>('POST', '/messages/send', this.rawMessage(reply));
    return sent.id;
  }

  async findSentByIntent(intentId: string, threadId: string, since: string): Promise<string | undefined> {
    const metadata = new URLSearchParams([['format', 'metadata'], ['metadataHeaders', INTENT_HEADER]]);
    // A draft of the same reply can carry an intent too; only mail Gmail sent counts.
    const isSent = (message: GmailMessage) => message.labelIds?.includes('SENT') && !message.labelIds.includes('DRAFT')
      && header(message, INTENT_HEADER) === intentId;
    try {
      const thread = await this.call<{ messages?: GmailMessage[] }>('GET', `/threads/${encodeURIComponent(threadId)}?${metadata}`);
      const found = thread.messages?.find(isSent);
      if (found) return found.id;
    } catch (error) {
      if (!(error instanceof MailboxError && error.code === 'not-found')) throw error;
    }
    // Gmail search cannot match a custom header, so read each message sent since the send began.
    const after = Math.floor(Date.parse(since) / 1000) - 5 * 60;
    let pageToken: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const params = new URLSearchParams({ q: `in:sent after:${after}`, maxResults: '100', ...(pageToken ? { pageToken } : {}) });
      const list = await this.call<{ messages?: Array<{ id: string }>; nextPageToken?: string }>('GET', `/messages?${params}`);
      for (const { id } of list.messages ?? []) {
        const message = await this.call<GmailMessage>('GET', `/messages/${encodeURIComponent(id)}?${metadata}`);
        if (isSent(message)) return message.id;
      }
      pageToken = list.nextPageToken;
      if (!pageToken) break;
    }
    return undefined;
  }

  async deleteDraft(draftId: string): Promise<void> {
    try {
      await this.call('DELETE', `/drafts/${encodeURIComponent(draftId)}`);
    } catch (error) {
      if (!(error instanceof MailboxError && error.code === 'not-found')) throw error;
    }
  }

  private rawMessage(reply: OutgoingReply): { raw: string; threadId: string } {
    const raw = buildReplyMime(reply.content, {
      from: this.options.address,
      messageId: reply.messageId,
      intentId: reply.intentId,
      ...(reply.inReplyTo ? { inReplyTo: reply.inReplyTo } : {}),
      ...(reply.references ? { references: reply.references } : {}),
    });
    return { raw: Buffer.from(raw, 'utf8').toString('base64url'), threadId: reply.threadId };
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.options.timeoutMs ?? GMAIL_REQUEST_TIMEOUT_MS) });
    } catch {
      throw new MailboxError('unreachable', 'Gmail could not be reached.');
    }
  }

  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 30_000) return this.accessToken.value;
    const response = await this.request(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: this.options.refreshToken,
        client_id: this.options.client.clientId, client_secret: this.options.client.clientSecret,
      }).toString(),
    });
    const body = await response.json().catch(() => ({})) as { access_token?: string; expires_in?: number; scope?: string; error?: string };
    if (!response.ok || !body.access_token) {
      if (body.error === 'invalid_grant') throw new MailboxError('signed-out', 'The Gmail sign-in expired or was removed in your Google account.', response.status);
      if (body.error === 'invalid_client' || body.error === 'unauthorized_client') {
        throw new MailboxError('no-client', 'Google rejected the Gmail client this build uses.', response.status);
      }
      if (response.status >= 500 || response.status === 429) throw new MailboxError('unreachable', 'Google sign-in is not answering right now.', response.status);
      throw new MailboxError('rejected', 'Google refused to renew the Gmail sign-in.', response.status);
    }
    const scopes = (body.scope ?? '').split(/\s+/).filter(Boolean);
    if (missingScopes(scopes).length > 0) {
      throw new MailboxError('missing-scope', 'Gmail was connected without permission to read mail and manage drafts.', response.status);
    }
    this.accessToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000, scopes };
    return body.access_token;
  }

  private async call<T = unknown>(method: string, route: string, body?: unknown): Promise<T> {
    const token = await this.token();
    const response = await this.request(`${API}${route}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.ok) return (response.status === 204 ? undefined : await response.json()) as T;
    const where = `${method} ${route.split('?')[0]}`;
    if (response.status === 401) {
      this.accessToken = undefined;
      throw new MailboxError('signed-out', 'Gmail no longer accepts this sign-in.', 401);
    }
    if (response.status === 403) throw new MailboxError('missing-scope', `Gmail refused ${where}: permission missing.`, 403);
    if (response.status === 404) throw new MailboxError('not-found', `Gmail has no such item (${where}).`, 404);
    if (response.status === 429 || response.status >= 500) throw new MailboxError('unreachable', `Gmail is busy (${response.status}).`, response.status);
    throw new MailboxError('rejected', `Gmail refused ${where} (${response.status}).`, response.status);
  }
}
