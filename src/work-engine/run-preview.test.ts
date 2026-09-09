// Ticket 70 (B10, docs/specs/run-result-application-previews.md): a pure,
// derived (never stored) candidate list — no Store, no engine, so this is
// exercised as plain unit tests over fixture RunResult values.
import { describe, expect, it } from 'vitest';
import type { RunResult } from './types.js';
import { derivePreviewCandidates } from './run-preview.js';

function baseResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    objective: 'Build the landing page',
    acceptanceCriteria: ['Looks right'],
    outcome: 'completed_unverified',
    changedFiles: [],
    verificationEvidence: [],
    approvals: [],
    budget: {},
    ...overrides,
  };
}

describe('derivePreviewCandidates', () => {
  it('returns [] for undefined — an unsettled Attempt has no RunResult yet', () => {
    expect(derivePreviewCandidates(undefined)).toEqual([]);
  });

  it('returns [] when changedFiles has no .html entry — the ordinary case, never an error', () => {
    const result = baseResult({ changedFiles: ['src/index.ts', 'src/index.test.ts', 'README.md'] });
    expect(derivePreviewCandidates(result)).toEqual([]);
  });

  it('returns every .html entry, in changedFiles\' own order', () => {
    const result = baseResult({ changedFiles: ['src/index.ts', 'dist/index.html', 'dist/about.html'] });
    expect(derivePreviewCandidates(result)).toEqual([
      { path: 'dist/index.html' },
      { path: 'dist/about.html' },
    ]);
  });

  it('is case-sensitive and does not match a non-.html suffix that merely contains "html"', () => {
    const result = baseResult({ changedFiles: ['dist/index.HTML', 'dist/index.htmlx', 'dist/index.html'] });
    expect(derivePreviewCandidates(result)).toEqual([{ path: 'dist/index.html' }]);
  });
});
