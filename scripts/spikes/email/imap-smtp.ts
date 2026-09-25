// Candidate adapter B: standard IMAP (lookup, Drafts) plus SMTP submission,
// authenticated with an app password kept in the login Keychain. Defaults
// target Gmail; override the hosts and mailbox names for iCloud, Fastmail, etc.
//
// The clients below are deliberately minimal (implicit TLS, LOGIN / AUTH
// PLAIN, the handful of commands the spike needs) so the spike adds no
// dependencies to the repository.
import tls from 'node:tls';
import { keychainSecret } from './local-state.js';
import { buildMime, contentFromMime, parseMime } from './mime.js';
import type { DraftContent, DraftRef, EmailSpikeAdapter, LookupQuery, MessageSummary, SendEvidence } from './types.js';

/** Per-connection idle limit; the protocol's in-flight grace must exceed it. */
const REQUEST_TIMEOUT_MS = 20_000;

interface ImapSmtpConfig {
  user: string;
  password: string;
  imapHost: string;
  smtpHost: string;
  searchMailbox: string;
  draftsMailbox: string;
  sentMailbox: string;
  /** Providers that do not file SMTP submissions into Sent need the client to APPEND a copy. */
  appendToSent: boolean;
}

export function imapSmtpConfigFromEnv(): ImapSmtpConfig {
  const user = process.env.AGENTDECK_MAIL_USER;
  if (!user) throw new Error('Set AGENTDECK_MAIL_USER to the mailbox address.');
  return {
    user,
    password: keychainSecret('agentdeck-email-spike', user, 'AGENTDECK_MAIL_APP_PASSWORD'),
    imapHost: process.env.AGENTDECK_IMAP_HOST ?? 'imap.gmail.com',
    smtpHost: process.env.AGENTDECK_SMTP_HOST ?? 'smtp.gmail.com',
    searchMailbox: process.env.AGENTDECK_IMAP_SEARCH_MAILBOX ?? 'INBOX',
    draftsMailbox: process.env.AGENTDECK_IMAP_DRAFTS ?? '[Gmail]/Drafts',
    sentMailbox: process.env.AGENTDECK_IMAP_SENT ?? '[Gmail]/Sent Mail',
    appendToSent: process.env.AGENTDECK_IMAP_APPEND_SENT === '1',
  };
}

export class ImapSmtpAdapter implements EmailSpikeAdapter {
  readonly name = 'imap-smtp';
  private imap?: ImapConnection;

  constructor(private readonly config: ImapSmtpConfig) {}

  async selfAddress(): Promise<string> {
    return this.config.user;
  }

  async lookup(query: LookupQuery, limit: number): Promise<MessageSummary[]> {
    const imap = await this.connection();
    await imap.select(this.config.searchMailbox);
    const criteria = [
      query.from && `FROM ${quote(query.from)}`,
      query.subjectContains && `SUBJECT ${quote(query.subjectContains)}`,
      query.messageIdHeader && `HEADER Message-ID ${quote(query.messageIdHeader)}`,
    ].filter(Boolean).join(' ') || 'ALL';
    const uids = (await imap.uidSearch(criteria)).slice(-limit).reverse();
    const found: MessageSummary[] = [];
    for (const uid of uids) {
      const { headers } = parseMime(await imap.uidFetch(uid, 'BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)]'));
      found.push({ providerId: `${this.config.searchMailbox}:${uid}`, messageIdHeader: headers.get('message-id'), from: headers.get('from') ?? '', subject: headers.get('subject') ?? '', date: headers.get('date') });
    }
    return found;
  }

  async createDraft(content: DraftContent, intentId: string, requestedMessageId: string): Promise<DraftRef> {
    const imap = await this.connection();
    const raw = buildMime(content, { from: this.config.user, messageId: requestedMessageId, intentId });
    const uid = await imap.append(this.config.draftsMailbox, '(\\Draft \\Seen)', raw);
    return { draftId: String(uid), messageIdHeader: requestedMessageId, intentId };
  }

  async updateDraft(ref: DraftRef, content: DraftContent): Promise<DraftRef> {
    // IMAP messages are immutable: append the new version, then remove the old one.
    const next = await this.createDraft(content, ref.intentId, ref.messageIdHeader);
    await this.deleteDraft(ref);
    return next;
  }

  async readDraft(ref: DraftRef): Promise<DraftContent | null> {
    const raw = await this.draftRaw(ref);
    return raw ? contentFromMime(raw) : null;
  }

  async deleteDraft(ref: DraftRef): Promise<void> {
    const imap = await this.connection();
    await imap.select(this.config.draftsMailbox);
    await imap.uidDelete(Number(ref.draftId));
  }

  async sendDraft(ref: DraftRef): Promise<{ providerMessageId: string }> {
    const raw = await this.draftRaw(ref);
    if (!raw) throw new Error('draft not found');
    const content = contentFromMime(raw);
    const queued = await smtpSubmit(this.config, [...content.to, ...(content.cc ?? [])].map(address), raw);
    // Not atomic with the submission above: a failure from here on leaves a
    // sent message and a surviving draft, which is why `reconcile` can never
    // treat a surviving draft as proof of absence.
    if (this.config.appendToSent) await (await this.connection()).append(this.config.sentMailbox, '(\\Seen)', raw);
    await this.deleteDraft(ref);
    return { providerMessageId: `smtp:${queued}` };
  }

  async reconcile(ref: DraftRef): Promise<SendEvidence> {
    const uids = await this.sentUids(ref);
    if (uids.length > 0) return { state: 'sent', providerMessageId: `${this.config.sentMailbox}:${uids[0]}`, via: 'sent-header-search' };
    return { state: 'unknown', via: (await this.draftRaw(ref)) ? 'draft-exists-but-not-proof' : 'draft-gone-no-sent-hit' };
  }

  async sentCopies(ref: DraftRef): Promise<number> {
    return (await this.sentUids(ref)).length;
  }

  async close(): Promise<void> {
    await this.imap?.logout();
    this.imap = undefined;
  }

  private async sentUids(ref: DraftRef): Promise<number[]> {
    const imap = await this.connection();
    await imap.select(this.config.sentMailbox);
    return imap.uidSearch(`HEADER Message-ID ${quote(ref.messageIdHeader)}`);
  }

  private async draftRaw(ref: DraftRef): Promise<string | null> {
    const imap = await this.connection();
    await imap.select(this.config.draftsMailbox);
    const uid = Number(ref.draftId);
    if (!(await imap.uidSearch(`UID ${uid}`)).includes(uid)) return null;
    return imap.uidFetch(uid, 'BODY.PEEK[]');
  }

  private async connection(): Promise<ImapConnection> {
    if (!this.imap) {
      // Quoted strings are ASCII-only in IMAP4rev1; app passwords always are.
      if (!/^[\x20-\x7e]*$/.test(this.config.password)) throw new Error('The spike only supports ASCII app passwords.');
      this.imap = await ImapConnection.open(this.config.imapHost);
      await this.imap.command(`LOGIN ${quote(this.config.user)} ${quote(this.config.password)}`);
    }
    return this.imap;
  }
}

function quote(value: string): string {
  return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}

function address(value: string): string {
  return /<([^>]+)>/.exec(value)?.[1] ?? value.trim();
}

interface ImapResponse { text: string; literals: Buffer[] }

class ImapConnection {
  private buffer = Buffer.alloc(0);
  private wake?: () => void;
  private closed?: Error;
  private tag = 0;

  private constructor(private readonly socket: tls.TLSSocket) {
    socket.on('data', (chunk: Buffer) => { this.buffer = Buffer.concat([this.buffer, chunk]); this.wake?.(); });
    socket.on('error', (error) => { this.closed = error; this.wake?.(); });
    socket.on('close', () => { this.closed ??= new Error('IMAP connection closed'); this.wake?.(); });
  }

  static async open(host: string): Promise<ImapConnection> {
    const socket = tls.connect({ host, port: 993, servername: host });
    await new Promise<void>((resolve, reject) => socket.once('secureConnect', resolve).once('error', reject));
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy(new Error('IMAP timed out')));
    const connection = new ImapConnection(socket);
    const greeting = await connection.readResponse();
    if (!greeting.text.startsWith('* OK')) throw new Error(`IMAP greeting: ${greeting.text}`);
    return connection;
  }

  async command(text: string, literal?: Buffer): Promise<ImapResponse[]> {
    const tag = `S${++this.tag}`;
    if (literal) {
      this.socket.write(`${tag} ${text} {${literal.length}}\r\n`);
      const next = await this.readResponse();
      if (!next.text.startsWith('+')) throw new Error(`IMAP refused literal: ${next.text}`);
      this.socket.write(Buffer.concat([literal, Buffer.from('\r\n')]));
    } else {
      this.socket.write(`${tag} ${text}\r\n`);
    }
    const untagged: ImapResponse[] = [];
    for (;;) {
      const response = await this.readResponse();
      if (response.text.startsWith(`${tag} `)) {
        if (!response.text.startsWith(`${tag} OK`)) throw new Error(`IMAP ${text.split(' ')[0]}: ${response.text}`);
        untagged.push(response);
        return untagged;
      }
      untagged.push(response);
    }
  }

  async select(mailbox: string): Promise<void> {
    await this.command(`SELECT ${quote(mailbox)}`);
  }

  async uidSearch(criteria: string): Promise<number[]> {
    const responses = await this.command(`UID SEARCH ${criteria}`);
    const line = responses.find((r) => r.text.startsWith('* SEARCH'));
    return line ? line.text.slice('* SEARCH'.length).trim().split(/\s+/).filter(Boolean).map(Number) : [];
  }

  async uidFetch(uid: number, item: string): Promise<string> {
    const responses = await this.command(`UID FETCH ${uid} (${item})`);
    const literal = responses.find((r) => r.literals.length > 0)?.literals[0];
    if (!literal) throw new Error(`IMAP FETCH returned no body for UID ${uid}`);
    return literal.toString('utf8');
  }

  async append(mailbox: string, flags: string, message: string): Promise<number> {
    const responses = await this.command(`APPEND ${quote(mailbox)} ${flags}`, Buffer.from(message, 'utf8'));
    const uid = /APPENDUID \d+ (\d+)/.exec(responses.at(-1)?.text ?? '')?.[1];
    if (!uid) throw new Error('Server did not return APPENDUID (UIDPLUS is required by this spike).');
    return Number(uid);
  }

  async uidDelete(uid: number): Promise<void> {
    await this.command(`UID STORE ${uid} +FLAGS.SILENT (\\Deleted)`);
    await this.command(`UID EXPUNGE ${uid}`);
  }

  async logout(): Promise<void> {
    try { await this.command('LOGOUT'); } catch { /* the server closes on LOGOUT */ }
    this.socket.end();
  }

  private async readResponse(): Promise<ImapResponse> {
    let text = '';
    const literals: Buffer[] = [];
    for (;;) {
      const line = await this.readLine();
      text += line;
      const size = /\{(\d+)\}$/.exec(line)?.[1];
      if (!size) return { text, literals };
      literals.push(await this.readBytes(Number(size)));
    }
  }

  private async readLine(): Promise<string> {
    for (;;) {
      const end = this.buffer.indexOf('\r\n');
      if (end >= 0) {
        const line = this.buffer.subarray(0, end).toString('utf8');
        this.buffer = this.buffer.subarray(end + 2);
        return line;
      }
      await this.more();
    }
  }

  private async readBytes(count: number): Promise<Buffer> {
    while (this.buffer.length < count) await this.more();
    const bytes = this.buffer.subarray(0, count);
    this.buffer = this.buffer.subarray(count);
    return bytes;
  }

  private more(): Promise<void> {
    if (this.closed) return Promise.reject(this.closed);
    return new Promise<void>((resolve) => { this.wake = () => { this.wake = undefined; resolve(); }; });
  }
}

/** One SMTP submission over implicit TLS (port 465). Returns the server's acceptance text. */
async function smtpSubmit(config: ImapSmtpConfig, recipients: string[], raw: string): Promise<string> {
  const socket = tls.connect({ host: config.smtpHost, port: 465, servername: config.smtpHost });
  await new Promise<void>((resolve, reject) => socket.once('secureConnect', resolve).once('error', reject));
  socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy(new Error('SMTP timed out')));
  let buffer = '';
  let failure: Error | undefined;
  let wake: (() => void) | undefined;
  socket.on('data', (chunk: Buffer) => { buffer += chunk.toString('utf8'); wake?.(); });
  socket.on('error', (error) => { failure = error; wake?.(); });
  socket.on('close', () => { failure ??= new Error('SMTP connection closed'); wake?.(); });
  const reply = async (expect: number): Promise<string> => {
    for (;;) {
      // A complete reply ends with a line of the form "250 text" (space, not hyphen).
      const match = /(?:^|\r\n)(\d{3}) [^\r\n]*\r\n$/.exec(buffer);
      if (match) {
        const text = buffer;
        buffer = '';
        if (Number(match[1]) !== expect) throw new Error(`SMTP expected ${expect}, got: ${text.trim()}`);
        return text.trim();
      }
      if (failure) throw failure;
      await new Promise<void>((resolve) => { wake = resolve; });
    }
  };
  const send = (line: string) => socket.write(`${line}\r\n`);
  try {
    await reply(220);
    send('EHLO agentdeck-spike.local'); await reply(250);
    send(`AUTH PLAIN ${Buffer.from(`\0${config.user}\0${config.password}`).toString('base64')}`); await reply(235);
    send(`MAIL FROM:<${config.user}>`); await reply(250);
    for (const recipient of recipients) { send(`RCPT TO:<${recipient}>`); await reply(250); }
    send('DATA'); await reply(354);
    // The message already ends in CRLF, so the terminator is just ".\r\n".
    const data = raw.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    socket.write(`${data}${data.endsWith('\r\n') ? '' : '\r\n'}.\r\n`);
    const accepted = await reply(250);
    send('QUIT');
    return accepted;
  } finally {
    socket.end();
  }
}
