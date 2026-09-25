// Issue #78 spike: the smallest contract every candidate email adapter must
// satisfy so the same scenarios can be run against each one. This is spike
// code, not a production interface — the decision record in
// docs/adr/0001-first-email-adapter.md says what should survive.

export interface MessageSummary {
  providerId: string;
  threadId?: string;
  /** RFC 5322 Message-ID as the provider stored it, angle brackets included. */
  messageIdHeader?: string;
  from: string;
  subject: string;
  date?: string;
}

export interface LookupQuery {
  from?: string;
  subjectContains?: string;
  messageIdHeader?: string;
}

export interface DraftContent {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
  /** Provider thread to keep the reply in, when the provider has threads. */
  threadId?: string;
}

/** What the spike needs to find a draft, or the message it became, again. */
export interface DraftRef {
  draftId: string;
  /** Message-ID actually stored by the provider, which may differ from the one we asked for. */
  messageIdHeader: string;
  /** Spike-owned identity carried in an X-AgentDeck-Intent header. */
  intentId: string;
  threadId?: string;
}

/**
 * What the provider can prove about one send intent. `not_sent` must only be
 * returned when the provider positively shows the send did not happen (for
 * example, the draft a send would have consumed still exists); a missing
 * search hit on its own is `unknown`, never `not_sent`.
 */
export type SendEvidence =
  | { state: 'sent'; providerMessageId: string; via: string }
  | { state: 'not_sent'; via: string }
  | { state: 'unknown'; via: string };

export interface EmailSpikeAdapter {
  readonly name: string;
  selfAddress(): Promise<string>;
  lookup(query: LookupQuery, limit: number): Promise<MessageSummary[]>;
  createDraft(content: DraftContent, intentId: string, requestedMessageId: string): Promise<DraftRef>;
  updateDraft(ref: DraftRef, content: DraftContent): Promise<DraftRef>;
  /** Null when the draft no longer exists. */
  readDraft(ref: DraftRef): Promise<DraftContent | null>;
  deleteDraft(ref: DraftRef): Promise<void>;
  sendDraft(ref: DraftRef): Promise<{ providerMessageId: string }>;
  reconcile(ref: DraftRef, sinceMs: number): Promise<SendEvidence>;
  /** Provider-side count of sent copies for this intent: the duplicate check. */
  sentCopies(ref: DraftRef, sinceMs: number): Promise<number>;
  close?(): Promise<void>;
}
