// The Collaborator workspace's own API surface — the house pattern of
// collaborators.ts: components import these, never apiFetch directly.
//
// Every read here is grant-filtered AND narrowed server-side (see
// server/collaborator-run-view.ts), so nothing in this module needs to know
// what a Collaborator may see. It only knows the shapes.
import { apiFetch, responseJson, responseJsonArray } from './apiFetch.js';
import { submitWorkRun } from './components/RunSubmissionModal.js';
import type { RunFeedbackEntry } from '../types.js';
import type { CollaboratorRunDetail, CollaboratorRunSummary, WorkSpec } from '../work-engine/types.js';

type RunFetcher = (path: string, init?: RequestInit) => Promise<Response>;

export type CollaboratorListState = 'loading' | 'ready' | 'error';

export class CollaboratorRunReadError extends Error {
  constructor(readonly status: number) {
    super(`request failed: ${status}`);
    this.name = 'CollaboratorRunReadError';
  }
}

export function listCollaboratorRuns(fetcher: RunFetcher = apiFetch): Promise<CollaboratorRunSummary[]> {
  return fetcher('/api/runs').then((response) => responseJsonArray<CollaboratorRunSummary>(response));
}

export async function getCollaboratorRun(runId: string, fetcher: RunFetcher = apiFetch): Promise<CollaboratorRunDetail> {
  const response = await fetcher(`/api/runs/${encodeURIComponent(runId)}`);
  if (!response.ok) throw new CollaboratorRunReadError(response.status);
  return responseJson<CollaboratorRunDetail>(response);
}

/**
 * Ticket 67 (B07, docs/specs/run-feedback-review.md): a granted Run's plain
 * commentary — the same grant-scoped 404-never-403 read GET /api/runs/:id
 * itself uses, so a Run outside this collaborator's grant reads as "no such
 * run" here too, not as an empty list.
 */
export function listRunFeedback(runId: string, fetcher: RunFetcher = apiFetch): Promise<RunFeedbackEntry[]> {
  return fetcher(`/api/runs/${encodeURIComponent(runId)}/feedback`).then((response) => {
    if (!response.ok) throw new CollaboratorRunReadError(response.status);
    return responseJsonArray<RunFeedbackEntry>(response);
  });
}

/** Posts one comment, attributed server-side to this collaborator's own Principal — never a caller-supplied name. */
export async function postRunFeedback(runId: string, text: string, fetcher: RunFetcher = apiFetch): Promise<RunFeedbackEntry> {
  const response = await fetcher(`/api/runs/${encodeURIComponent(runId)}/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const body = await response.json().catch(() => ({})) as Partial<RunFeedbackEntry> & { error?: string };
  if (!response.ok) throw new Error(body.error ?? 'Unable to post this comment.');
  return body as RunFeedbackEntry;
}

/** Where the request chain stopped short of a running Attempt, if it did. */
export type RequestWorkStage = 'running' | 'queued';

export interface RequestWorkOutcome {
  readonly runId: string;
  readonly stage: RequestWorkStage;
  /** Present only when `stage` is 'queued' — why the Run exists but is not running. */
  readonly note?: string;
}

async function advance(runId: string, action: 'prepare' | 'start', fetcher: RunFetcher): Promise<string | undefined> {
  const response = await fetcher(`/api/runs/${encodeURIComponent(runId)}/${action}`, { method: 'POST' });
  if (response.ok) return undefined;
  const body = await response.json().catch(() => ({})) as { error?: string };
  return body.error ?? `The Run was created but could not ${action}.`;
}

/**
 * Submit a Run and carry it all the way to a running Attempt.
 *
 * The Work Engine deliberately starts nothing on submit() — a Run is created
 * `queued` and advances only when someone asks it to. Before this, a
 * Collaborator's request therefore sat queued until an admin noticed it,
 * which is not a request for work so much as a note in a drawer.
 *
 * These are three separate authenticated requests on purpose, not one
 * "submit-and-run" route. Each reaches DurableWorkEngine.enforcePolicy
 * independently — submit as {kind:'submit'} (Repository AND Profile must be
 * granted), prepare and start as {kind:'guide'} — so collapsing them
 * server-side would fold three policy decisions into one call site and make
 * it possible to skip two of them. Chaining them here costs two round trips
 * and keeps that boundary intact.
 *
 * A partial chain is never silently lost: the Run exists either way and shows
 * up in its Repository's feed, so `stage: 'queued'` plus `note` is a state
 * the reader can see and retry, not a failure that swallowed their request.
 */
export async function requestWork(spec: WorkSpec, fetcher: RunFetcher = apiFetch): Promise<RequestWorkOutcome> {
  // A submit failure creates nothing, so it throws rather than returning an
  // outcome — there is no Run for the caller to navigate to.
  const run = await submitWorkRun(spec, fetcher as (path: string, init: RequestInit) => Promise<Response>);

  const prepareError = await advance(run.id, 'prepare', fetcher);
  if (prepareError) return { runId: run.id, stage: 'queued', note: prepareError };

  const startError = await advance(run.id, 'start', fetcher);
  if (startError) return { runId: run.id, stage: 'queued', note: startError };

  return { runId: run.id, stage: 'running' };
}
