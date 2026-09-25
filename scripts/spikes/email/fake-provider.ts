// In-memory provider that models the two behaviours that decide whether an
// uncertain send can be reconciled safely:
//
//   - draft-consuming send (Gmail API `drafts.send`): the draft disappears in
//     the same provider operation that creates the sent message, so "the draft
//     still exists" is positive proof the send did not happen.
//   - submit-then-cleanup send (SMTP + IMAP Drafts): submission and draft
//     removal are separate, so a surviving draft proves nothing.
//
// It also models a lagging sent index and a provider that rewrites
// Message-ID. It counts every accepted send so scenarios can assert that no
// sequence of faults produced a duplicate.
import type { DraftContent, DraftRef, EmailSpikeAdapter, LookupQuery, MessageSummary, SendEvidence } from './types.js';

export interface FakeProviderOptions {
  semantics: 'draft-consuming' | 'submit-then-cleanup';
  /** Reconcile/search calls that miss a sent message before it becomes visible. */
  sentIndexLag?: number;
  /** When true the provider replaces the Message-ID on the sent copy, as some servers do. */
  rewritesMessageId?: boolean;
  /** Yield to the event loop before committing a send, so concurrent callers genuinely overlap. */
  sendLatency?: boolean;
  /**
   * The first send times out on the client, but the provider commits it after
   * this many further reconcile checks: the late-commit race.
   */
  lateCommitAfterChecks?: number;
}

interface StoredMessage {
  id: string;
  threadId: string;
  messageIdHeader: string;
  intentId?: string;
  from: string;
  to: string[];
  subject: string;
  body: string;
  sentAtMs: number;
  /** Search calls left before this message is visible. */
  hiddenFor: number;
}

interface StoredDraft {
  id: string;
  intentId: string;
  messageIdHeader: string;
  threadId: string;
  content: DraftContent;
}

export class FakeProvider implements EmailSpikeAdapter {
  readonly name: string;
  readonly inbox: StoredMessage[] = [];
  readonly sent: StoredMessage[] = [];
  readonly drafts = new Map<string, StoredDraft>();
  private nextId = 1;
  private lateCommit?: { ref: DraftRef; checksLeft: number };

  constructor(private readonly options: FakeProviderOptions, private readonly self = 'owner@example.test') {
    this.name = `fake:${options.semantics}`;
  }

  async selfAddress(): Promise<string> {
    return this.self;
  }

  /** Seed an incoming message, as if someone had written to the owner. */
  deliver(from: string, subject: string, body: string): StoredMessage {
    const id = this.id('m');
    const message: StoredMessage = {
      id, threadId: this.id('t'), messageIdHeader: `<${id}@sender.example.test>`, from, to: [this.self],
      subject, body, sentAtMs: Date.now(), hiddenFor: 0,
    };
    this.inbox.push(message);
    return message;
  }

  async lookup(query: LookupQuery, limit: number): Promise<MessageSummary[]> {
    return [...this.inbox, ...this.sent]
      .filter((m) => this.visible(m))
      .filter((m) => !query.from || m.from.includes(query.from))
      .filter((m) => !query.subjectContains || m.subject.includes(query.subjectContains))
      .filter((m) => !query.messageIdHeader || m.messageIdHeader === query.messageIdHeader)
      .slice(0, limit)
      .map((m) => ({ providerId: m.id, threadId: m.threadId, messageIdHeader: m.messageIdHeader, from: m.from, subject: m.subject }));
  }

  async createDraft(content: DraftContent, intentId: string, requestedMessageId: string): Promise<DraftRef> {
    const messageIdHeader = requestedMessageId;
    const draft: StoredDraft = { id: this.id('d'), intentId, messageIdHeader, threadId: content.threadId ?? this.id('t'), content };
    this.drafts.set(draft.id, draft);
    return { draftId: draft.id, messageIdHeader, intentId, threadId: draft.threadId };
  }

  async updateDraft(ref: DraftRef, content: DraftContent): Promise<DraftRef> {
    const draft = this.drafts.get(ref.draftId);
    if (!draft) throw new Error('404 draft not found');
    draft.content = content;
    return ref;
  }

  async readDraft(ref: DraftRef): Promise<DraftContent | null> {
    return this.drafts.get(ref.draftId)?.content ?? null;
  }

  async deleteDraft(ref: DraftRef): Promise<void> {
    this.drafts.delete(ref.draftId);
  }

  async sendDraft(ref: DraftRef): Promise<{ providerMessageId: string }> {
    if (this.options.lateCommitAfterChecks !== undefined && !this.lateCommit) {
      this.lateCommit = { ref, checksLeft: this.options.lateCommitAfterChecks };
      throw new Error('simulated client timeout; the provider is still processing the request');
    }
    this.flushLateCommit(true);
    if (this.options.sendLatency) await new Promise((resolve) => setImmediate(resolve));
    return this.commitSend(ref);
  }

  /** A pending late commit lands after its reconcile checks run out, or before any new send reaches the provider. */
  private flushLateCommit(force: boolean): void {
    if (!this.lateCommit || (!force && this.lateCommit.checksLeft-- > 0)) return;
    const { ref } = this.lateCommit;
    this.lateCommit = undefined;
    this.commitSend(ref);
  }

  private commitSend(ref: DraftRef): { providerMessageId: string } {
    const draft = this.drafts.get(ref.draftId);
    if (!draft) throw new Error('404 draft not found');
    const message: StoredMessage = {
      id: this.id('m'), threadId: draft.threadId, intentId: draft.intentId,
      // A rewrite at submission leaves the caller holding a Message-ID the sent copy no longer has.
      messageIdHeader: this.options.rewritesMessageId ? `<${this.id('rw')}@provider.example.test>` : draft.messageIdHeader,
      from: this.self, to: draft.content.to, subject: draft.content.subject, body: draft.content.body,
      sentAtMs: Date.now(), hiddenFor: this.options.sentIndexLag ?? 0,
    };
    this.sent.push(message);
    // Submit-then-cleanup leaves the draft in place: the worst case for a
    // client that died between SMTP acceptance and the IMAP delete.
    if (this.options.semantics === 'draft-consuming') this.drafts.delete(draft.id);
    return { providerMessageId: message.id };
  }

  async reconcile(ref: DraftRef, sinceMs: number): Promise<SendEvidence> {
    this.flushLateCommit(false);
    const hit = this.searchSent(ref, sinceMs);
    if (hit) return { state: 'sent', providerMessageId: hit.id, via: 'sent-search' };
    if (this.options.semantics === 'draft-consuming' && this.drafts.has(ref.draftId)) {
      return { state: 'not_sent', via: 'draft-still-exists' };
    }
    return { state: 'unknown', via: this.drafts.has(ref.draftId) ? 'draft-exists-but-not-proof' : 'draft-gone-no-sent-hit' };
  }

  async sentCopies(ref: DraftRef): Promise<number> {
    // Ground truth, ignoring index lag: this is the assertion, not a provider query.
    return this.sent.filter((m) => m.intentId === ref.intentId).length;
  }

  /**
   * Message-ID search everywhere; the intent-header match models the Gmail
   * adapter's thread search, which IMAP has no equivalent for.
   */
  private searchSent(ref: DraftRef, sinceMs: number): StoredMessage | undefined {
    const byIntent = this.options.semantics === 'draft-consuming';
    return this.sent.find((m) => this.visible(m) && m.sentAtMs >= sinceMs
      && (m.messageIdHeader === ref.messageIdHeader || (byIntent && m.intentId === ref.intentId)));
  }

  /** Each look at a lagging message counts down toward it becoming searchable. */
  private visible(message: StoredMessage): boolean {
    if (message.hiddenFor <= 0) return true;
    message.hiddenFor -= 1;
    return false;
  }

  private id(prefix: string): string {
    return `${prefix}${this.nextId++}`;
  }
}
