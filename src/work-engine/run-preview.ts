// Ticket 70 (B10, docs/specs/run-result-application-previews.md): the
// smallest supported preview artifact — a single already-produced static
// HTML file (plus same-directory relative assets), discovered from a
// settled Run's own RunResult.changedFiles. No build step, no dev-server
// process, no framework detection — see the design doc's own rationale for
// why this is deliberately the entire first slice, not a placeholder.
import type { RunResult } from './types.js';

/** A previewable file within a Run's own result — derived live, never stored. */
export interface RunPreviewCandidate {
  /** Repository-relative, exactly as changedFiles already reports it. */
  readonly path: string;
}

/**
 * Pure: every `changedFiles` entry ending in `.html`, in that array's own
 * order. `undefined` input (an unsettled Attempt — deriveRunResult's own
 * contract, run-result.ts) and a settled result with no `.html` entries
 * both yield `[]` — the ordinary case for most Runs, never an error.
 */
export function derivePreviewCandidates(result: RunResult | undefined): readonly RunPreviewCandidate[] {
  if (!result) return [];
  return result.changedFiles
    .filter((path) => path.endsWith('.html'))
    .map((path) => ({ path }));
}
