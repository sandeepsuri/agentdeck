// Personal tasks (CONTEXT.md): durable owner work on personal files, kept
// apart from coding Runs and Sessions. Everything a browser sees goes
// through the *View projections below; absolute paths, principal ids, and
// device ids stay server-side.
import type { RunActorDevice, RunPrincipal } from '../work-engine/types.js';

/**
 * Bumped whenever the rules a personal task runs under change, so each task
 * records the rules it ran under. 2: a filing proposal may let a confined
 * agent read granted PDFs through the broker (issue #81).
 */
export const PERSONAL_TASK_POLICY_VERSION = 'personal-files/2';

/** The only workspace personal tasks live in today: the owner's own, never a Repository. */
export const OWNER_WORKSPACE = 'owner';

export interface PersonalActor {
  readonly principal: RunPrincipal;
  readonly device: RunActorDevice;
}

export interface FolderGrant {
  readonly id: string;
  /** Canonical (realpath) folder; never sent to a browser as-is. */
  readonly rootPath: string;
  readonly createdAt: string;
  readonly createdBy: PersonalActor;
  readonly revokedAt?: string;
}

export type PersonalTaskKind = 'pdf-inventory' | 'pdf-filing-proposal';

export type PersonalTaskStatus = 'queued' | 'running' | 'completed' | 'failed';

export type PersonalAttemptOutcome = 'completed' | 'failed' | 'interrupted';

export interface PersonalTaskAttempt {
  readonly id: string;
  readonly sequence: number;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly outcome?: PersonalAttemptOutcome;
}

export type PersonalActivityKind =
  | 'submitted'
  | 'retry-requested'
  | 'attempt-started'
  | 'file-inspected'
  | 'file-skipped'
  | 'completed'
  | 'failed'
  | 'interrupted'
  // Filing proposals (issue #81).
  | 'access-checked'
  | 'provider-started'
  | 'document-read'
  | 'filing-proposed'
  | 'broker-refused'
  | 'proposal-ready';

export interface PersonalTaskActivity {
  readonly sequence: number;
  readonly at: string;
  readonly kind: PersonalActivityKind;
  readonly message: string;
  readonly attemptId?: string;
  /** Path relative to the grant, when the entry is about one file. */
  readonly path?: string;
}

export interface PdfInventoryEntry {
  path: string;
  name: string;
  size: number;
  modifiedAt: string;
  sha256: string;
  pdfVersion?: string;
  /** Undefined when the page tree could not be read without decompressing. */
  pageCount?: number;
  encrypted: boolean;
}

export interface PdfInventoryResult {
  readonly attemptId: string;
  readonly completedAt: string;
  readonly files: readonly PdfInventoryEntry[];
  readonly skipped: readonly { path: string; reason: string }[];
  readonly totalBytes: number;
  /** Sum over files whose page count is known. */
  readonly knownPages: number;
}

export type FilingWarningKind =
  /** Something already has the target name and would be replaced. */
  | 'overwrite'
  /** A file with identical content already sits at the target. */
  | 'already-filed'
  /** Another file in this proposal is headed for the same target. */
  | 'same-target'
  /** Another selected file has identical content. */
  | 'duplicate-content'
  /** The destination folder does not exist yet and would be created. */
  | 'new-folder'
  /** The file would stay exactly where it is. */
  | 'unchanged';

export interface FilingWarning {
  kind: FilingWarningKind;
  /** Written by AgentDeck, never by the agent. */
  message: string;
}

/**
 * One proposed move, built only from the broker's validated, typed
 * parameters and the digest AgentDeck computed for the bytes the agent was
 * shown. No agent-authored prose is kept.
 */
export interface FilingPlanEntry {
  /** Current path, relative to the grant. */
  source: string;
  sourceSha256: string;
  newName: string;
  /** Folder relative to the grant; '' is the granted folder itself. */
  destination: string;
  /** destination/newName, relative to the grant. */
  target: string;
  warnings: FilingWarning[];
}

export interface FilingProposalResult {
  readonly kind: 'pdf-filing-proposal';
  readonly attemptId: string;
  readonly completedAt: string;
  /**
   * SHA-256 over the grant id and every entry's source, digest, destination
   * and name. Any change to the plan changes it, so a decision bound to one
   * digest cannot carry over to a different plan.
   */
  readonly planDigest: string;
  readonly provider: { runtime: 'claude'; cliVersion: string; confinement: 'macos-seatbelt' };
  readonly entries: readonly FilingPlanEntry[];
  /** Readable files the plan leaves where they are, with AgentDeck's reason. */
  readonly unplanned: readonly { path: string; reason: string }[];
  readonly skipped: readonly { path: string; reason: string }[];
}

export type PersonalTaskResult = PdfInventoryResult | FilingProposalResult;

export function isFilingProposal(result: PersonalTaskResult): result is FilingProposalResult {
  return 'kind' in result && result.kind === 'pdf-filing-proposal';
}

export interface PersonalTask {
  readonly id: string;
  readonly kind: PersonalTaskKind;
  readonly workspace: string;
  readonly grantId: string;
  readonly policyVersion: string;
  /** Paths relative to the grant, fixed at submission. */
  readonly files: readonly string[];
  readonly submittedAt: string;
  readonly submittedBy: PersonalActor;
  readonly status: PersonalTaskStatus;
  readonly updatedAt: string;
  readonly failure?: string;
  readonly result?: PersonalTaskResult;
}

// --- browser projections ------------------------------------------------------

export interface FolderGrantView {
  id: string;
  name: string;
  /** The folder with the home directory shown as `~`. */
  displayPath: string;
  createdAt: string;
  revokedAt?: string;
}

export interface PersonalTaskView {
  id: string;
  kind: PersonalTaskKind;
  title: string;
  status: PersonalTaskStatus;
  workspace: string;
  policyVersion: string;
  grant: { id: string; name: string; revoked: boolean };
  files: readonly string[];
  submittedAt: string;
  updatedAt: string;
  submittedBy: { displayName: string; device: string };
  attempts: readonly PersonalTaskAttempt[];
  activity: readonly PersonalTaskActivity[];
  failure?: string;
  result?: PersonalTaskResult;
}
