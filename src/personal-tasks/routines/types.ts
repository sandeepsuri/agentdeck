// Routines (issue #92): a saved PDF or email request the owner can run
// again. A routine is only the request — which operation, and which Folder
// grant or Email account grant it uses. It never carries an approval: each
// run creates a new personal task or email task, and any move or send on it
// needs the owner's decision on that run's own proposal or draft.
import type { PersonalActor, PersonalTaskStatus } from '../types.js';

export type RoutineConfig =
  | { readonly kind: 'pdf-filing-proposal' | 'pdf-inventory'; readonly grantId: string }
  | { readonly kind: 'email-reply'; readonly accountId: string; readonly request: string };

export type RoutineKind = RoutineConfig['kind'];

export interface Routine {
  readonly id: string;
  readonly name: string;
  readonly config: RoutineConfig;
  readonly sourceTaskId?: string;
  readonly createdAt: string;
  readonly createdBy: PersonalActor;
  readonly updatedAt: string;
  readonly deletedAt?: string;
}

/** Why a run did not start. Every code but 'nothing-to-run' has a repair the owner can make. */
export type RoutineBlockCode =
  | 'folder-revoked'
  | 'folder-unavailable'
  | 'account-revoked'
  | 'account-needs-repair'
  | 'nothing-to-run';

export interface RoutineBlock {
  readonly code: RoutineBlockCode;
  /** Owner-facing: what is wrong and what to do about it. */
  readonly message: string;
}

export type RoutineTaskSource = 'personal' | 'email';

export interface RoutineRun {
  readonly id: string;
  readonly routineId: string;
  readonly sequence: number;
  readonly at: string;
  readonly by: PersonalActor;
  readonly config: RoutineConfig;
  readonly outcome: 'started' | 'blocked';
  readonly task?: { readonly source: RoutineTaskSource; readonly id: string };
  readonly block?: RoutineBlock;
}

// --- browser projections ------------------------------------------------------

export interface RoutineRunView {
  id: string;
  sequence: number;
  at: string;
  by: { displayName: string; device: string };
  outcome: 'started' | 'blocked';
  block?: RoutineBlock;
  /** The work item this run created, with where it stands now. */
  task?: { source: RoutineTaskSource; id: string; title: string; status: PersonalTaskStatus };
}

export interface RoutineView {
  id: string;
  name: string;
  kind: RoutineKind;
  /** The folder or mailbox the routine uses, as the owner knows it. */
  target: { id: string; label: string; revoked: boolean };
  /** The email request, in the owner's own words. */
  request?: string;
  createdAt: string;
  updatedAt: string;
  /** Set when the next run cannot start as things stand, with what to fix. */
  repair?: RoutineBlock;
  runs: RoutineRunView[];
}
