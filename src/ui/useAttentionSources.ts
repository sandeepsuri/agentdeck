// Inputs to the global Needs You queue (needsYou.ts) that App.tsx does not
// already poll: each settled Run's derived review state
// (GET /api/runs/:id/review) and provider rate-limit windows
// (GET /api/usage/rate-limits). Both are existing, read-only endpoints.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RateLimitSnapshot } from '../usage/types.js';
import type { RunReviewState } from '../work-engine/run-review.js';
import type { WorkRun } from '../work-engine/types.js';
import { apiFetch, responseJsonArray } from './apiFetch.js';
import { getRunReviewState } from './collaboratorRuns.js';
import { isTerminalRunStatus } from './workspace/runModel.js';

const REVIEW_POLL_MS = 30_000;
/** Enough to cover every Run a person could plausibly still be reviewing. */
const MAX_REVIEW_LOOKUPS = 50;

export function useRunReviewStates(runs: readonly WorkRun[], enabled: boolean) {
  const [states, setStates] = useState<ReadonlyMap<string, RunReviewState>>(new Map());
  const settledIds = useMemo(
    () => [...runs].filter((run) => isTerminalRunStatus(run.status))
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
      .slice(0, MAX_REVIEW_LOOKUPS)
      .map((run) => run.id),
    [runs],
  );
  const key = settledIds.join(',');
  const idsRef = useRef(settledIds);
  idsRef.current = settledIds;

  const refresh = useCallback(async (only?: string) => {
    const ids = only ? [only] : idsRef.current;
    const results = await Promise.all(ids.map((id) => getRunReviewState(id).then((state) => [id, state] as const).catch(() => null)));
    setStates((current) => {
      const next = new Map(only ? current : [...current].filter(([id]) => idsRef.current.includes(id)));
      for (const result of results) if (result) next.set(result[0], result[1]);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const id = setInterval(() => void refresh(), REVIEW_POLL_MS);
    return () => clearInterval(id);
  }, [enabled, key, refresh]);

  return { reviewStates: states, refreshReviewState: refresh };
}

export function useRateLimits(enabled: boolean): RateLimitSnapshot[] {
  const [limits, setLimits] = useState<RateLimitSnapshot[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const load = () => apiFetch('/api/usage/rate-limits')
      .then((response) => responseJsonArray<RateLimitSnapshot>(response))
      .then((next) => { if (!disposed) setLimits(next); })
      .catch(() => undefined);
    void load();
    const id = setInterval(load, 60_000);
    return () => { disposed = true; clearInterval(id); };
  }, [enabled]);
  return limits;
}
