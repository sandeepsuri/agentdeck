// Issue #88: finding an email and preparing a reply. An Email account grant
// is one Gmail account the owner connected on this Mac; an email reply task
// is a Personal task that asks the confined agent to find one message in it
// and suggest a reply, then keeps every version of the editable reply draft
// AgentDeck wrote to Gmail. Nothing here sends mail: sending is issue #89.
import type { PersonalActor, PersonalTaskActivity, PersonalTaskAttempt, PersonalTaskStatus } from '../types.js';

/**
 * The rules an email task runs under. 1: a confined agent may search and read
 * one granted Gmail account through the email broker and suggest a reply
 * body; AgentDeck alone chooses recipients and writes drafts; nothing sends.
 */
export const EMAIL_TASK_POLICY_VERSION = 'personal-email/1';

export type EmailProvider = 'gmail';

/**
 * Where a connected account stands, with repair steps for everything but
 * 'ready'. 'unchecked' is a grant whose sign-in has not been tried since the
 * service started.
 */
export type EmailAccountState =
  | 'ready'
  | 'unchecked'
  | 'signed-out'
  | 'missing-scope'
  | 'unsupported'
  | 'no-client'
  | 'unreachable'
  | 'check-failed';

export interface EmailAccountGrant {
  readonly id: string;
  readonly provider: EmailProvider;
  /** The mailbox address Google reported at consent. */
  readonly address: string;
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly createdBy: PersonalActor;
  readonly revokedAt?: string;
  readonly state: EmailAccountState;
  readonly stateDetail?: string;
  readonly checkedAt?: string;
}

/** Headers and text of one message, fetched by AgentDeck's own code. */
export interface EmailMessageContext {
  /** Provider message id. */
  readonly id: string;
  readonly threadId: string;
  readonly from: string;
  readonly replyTo?: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly date?: string;
  readonly subject: string;
  /** RFC 5322 Message-ID of the message being answered. */
  readonly messageIdHeader?: string;
  readonly references?: string;
  /** The start of the plain-text body, enough to recognise the message. */
  readonly excerpt: string;
  readonly excerptTruncated: boolean;
}

export interface EmailFindResult {
  readonly kind: 'email-reply-proposal';
  readonly attemptId: string;
  readonly completedAt: string;
  readonly provider: { runtime: 'claude'; cliVersion: string; confinement: 'macos-seatbelt' };
  /** Every message the agent was shown, in the order it first saw them. */
  readonly candidates: readonly EmailMessageContext[];
  /** The candidate the agent chose, if it chose one. */
  readonly proposedMessageId?: string;
  /** The agent's suggested reply text; only ever a starting point the owner edits. */
  readonly suggestedBody?: string;
}

export interface ReplyAttachment {
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
}

/** Exactly what a reply draft holds: the fields an approval (issue #89) binds to. */
export interface ReplyDraftContent {
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly subject: string;
  readonly body: string;
  readonly attachments: readonly ReplyAttachment[];
}

/**
 * 'writing' is recorded before the one provider write, so a crash or lost
 * response is settled from what Gmail holds and never written twice.
 */
export type ReplyDraftState = 'writing' | 'saved' | 'failed' | 'uncertain';

export interface ReplyDraftVersion {
  readonly version: number;
  readonly state: ReplyDraftState;
  /** 'gmail' when AgentDeck found the owner changed the draft in Gmail itself. */
  readonly origin: 'agentdeck' | 'gmail';
  /** What was asked for while writing; what Gmail read back once saved. */
  readonly content: ReplyDraftContent;
  /** SHA-256 of the saved content; absent until saved. */
  readonly digest?: string;
  readonly providerDraftId?: string;
  /** Carried in X-AgentDeck-Intent so a draft can be found again after a lost response. */
  readonly intentId: string;
  readonly createdAt: string;
  readonly createdBy: PersonalActor;
  readonly updatedAt: string;
  readonly reason?: string;
}

export interface EmailTask {
  readonly id: string;
  readonly accountId: string;
  readonly workspace: string;
  readonly policyVersion: string;
  /** The owner's own words: which email, and what to say. */
  readonly request: string;
  readonly submittedAt: string;
  readonly submittedBy: PersonalActor;
  readonly status: PersonalTaskStatus;
  readonly updatedAt: string;
  readonly failure?: string;
  readonly result?: EmailFindResult;
  /** The message the owner confirmed they are answering. */
  readonly confirmed?: EmailMessageContext;
  readonly confirmedAt?: string;
  readonly confirmedBy?: PersonalActor;
}

// --- browser projections ------------------------------------------------------

export interface EmailAccountView {
  id: string;
  provider: EmailProvider;
  address: string;
  createdAt: string;
  revokedAt?: string;
  state: EmailAccountState;
  detail?: string;
  /** What the owner can do about a state other than 'ready'. */
  repair?: string;
  checkedAt?: string;
}

export interface ReplyDraftVersionView {
  version: number;
  state: ReplyDraftState;
  origin: 'agentdeck' | 'gmail';
  content: ReplyDraftContent;
  digest?: string;
  createdAt: string;
  createdBy: { displayName: string; device: string };
  updatedAt: string;
  reason?: string;
}

export interface EmailTaskView {
  id: string;
  title: string;
  status: PersonalTaskStatus;
  workspace: string;
  policyVersion: string;
  request: string;
  account: { id: string; address: string; revoked: boolean };
  submittedAt: string;
  updatedAt: string;
  submittedBy: { displayName: string; device: string };
  attempts: readonly PersonalTaskAttempt[];
  activity: readonly PersonalTaskActivity[];
  failure?: string;
  result?: EmailFindResult;
  confirmed?: EmailMessageContext;
  confirmedAt?: string;
  confirmedBy?: { displayName: string; device: string };
  /** Newest first. Never sent: sending is a separate, later approval. */
  drafts: ReplyDraftVersionView[];
}
