// Submission helpers shared by Start work (StartWorkModal.tsx), the
// collaborator request form (RequestWorkModal.tsx, collaboratorRuns.ts) and
// Profile creation (ProfilesPanel.tsx).
import type { RuntimeReadinessReport } from '../../sessions/runtime-readiness-contract.js';
import type { AgentType } from '../../types.js';
import type { RepositoryVerificationPolicy, WorkRun, WorkSpec } from '../../work-engine/types.js';
import { apiFetch } from '../apiFetch.js';

/**
 * Ticket 14 AC6: a runtime whose installation cannot satisfy the managed
 * capability envelope may not be picked for a managed Run at all — the same
 * rule buildRunEnvelope() enforces (work-engine/envelope.ts), applied here
 * so an operator is told why up front instead of watching the Run be
 * refused after it is submitted. Absent readiness evidence never blocks a
 * choice: not knowing yet is not the same as knowing it is unsupported.
 * This reads only the shared readiness report, so it stays one rule for
 * every runtime rather than a per-provider branch (AC8).
 */
export function runtimeSelectableForManagedRun(
  readiness: RuntimeReadinessReport | null,
  runtime: AgentType,
): boolean {
  const entry = readiness?.runtimes.find((item) => item.runtime === runtime);
  return entry === undefined || entry.status === 'managed';
}

type RunFetcher = (path: string, init: RequestInit) => Promise<Response>;

export async function submitWorkRun(spec: WorkSpec, fetcher: RunFetcher = apiFetch): Promise<WorkRun> {
  const response = await fetcher('/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(spec),
  });
  const body = await response.json() as WorkRun & { error?: string };
  if (!response.ok) throw new Error(body.error ?? 'Run submission failed.');
  return body;
}

export async function saveRepositoryVerificationPolicy(
  repoId: string,
  policy: RepositoryVerificationPolicy,
  fetcher: RunFetcher = apiFetch,
): Promise<void> {
  const response = await fetcher('/api/repos/verification-policy', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repoId, policy }),
  });
  const body = await response.json() as { error?: string };
  if (!response.ok) throw new Error(body.error ?? 'Saving the Repository verification policy failed.');
}

/** Every "one item per line" textarea in this app parses the same way. */
export function lines(value: string): string[] {
  return value.split('\n').map((line) => line.trim()).filter(Boolean);
}
