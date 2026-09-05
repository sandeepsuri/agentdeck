// The reload crashes these guards exist to prevent, one per overlapping
// endpoint. App fires the desktop refreshers once before GET /api/connection
// has said what kind of device this is, so on a collaborator's phone each of
// these three routes answered with a narrowed projection that the desktop tree
// then rendered — "undefined is not an object (evaluating 'Zt.cwd.split')" for
// Sessions, "(evaluating 'e.spec.objective')" for Runs.
//
// Each case pins both halves: the narrowed shape is dropped, AND the consumer
// it would have reached actually throws on it, so these never decay into
// filters whose reason nobody remembers.
import { describe, expect, it } from 'vitest';
import type { Repo, Session } from '../types.js';
import type { WorkRun } from '../work-engine/types.js';
import { adminRepos, adminRuns, adminSessions } from './adminProjection.js';
import { repoDisplayName, sessionLabel } from './workspace/model.js';

const REPO = '/Users/dev/projects/example';

const fullSession = {
  id: 'managed-1', origin: 'managed', agent: 'claude', cwd: `${REPO}/packages/api`, repoId: REPO,
  startedAt: '2026-09-01T00:00:00.000Z', lastActivityAt: '2026-09-01T00:05:00.000Z',
  status: 'working', statusSource: 'hook',
} as Session;

/** Exactly what server/collaborator-session-view.ts produces. */
const narrowedSession = {
  id: 'ext-4711-1', origin: 'external', agent: 'claude', repoId: REPO,
  startedAt: '2026-09-01T00:00:00.000Z', lastActivityAt: '2026-09-01T00:05:00.000Z',
  status: 'working', statusSource: 'hook',
} as unknown as Session;

const fullRun = {
  id: 'run-1', status: 'running', submittedAt: '2026-09-01T00:00:00.000Z',
  spec: { objective: 'Fix the flaky auth test', repository: { id: REPO, name: 'example', path: REPO } },
  preparation: { state: 'ready' },
} as unknown as WorkRun;

/** Exactly what server/collaborator-run-view.ts produces — objective at the top level, no spec. */
const narrowedRun = {
  id: 'run-2', status: 'running', objective: 'Fix the flaky auth test', acceptanceCriteria: [],
  repository: { id: REPO, name: 'example' }, submittedAt: '2026-09-01T00:00:00.000Z',
  requestedBy: 'Brandon', preparation: { state: 'ready' }, attemptState: 'running',
} as unknown as WorkRun;

const fullRepo: Repo = { id: REPO, name: 'example', path: REPO, currentBranch: 'main' };
/** Exactly what routes.ts's scopeRepos produces. */
const narrowedRepo = { id: REPO, name: 'example', currentBranch: 'main' } as unknown as Repo;

describe('adminSessions', () => {
  it('keeps a Session the desktop views can read', () => {
    expect(adminSessions([fullSession])).toEqual([fullSession]);
  });

  it('drops a collaborator’s narrowed Session, which sessionLabel cannot read', () => {
    expect(adminSessions([narrowedSession])).toEqual([]);
    expect(() => sessionLabel(narrowedSession)).toThrow();
    expect(() => sessionLabel(fullSession)).not.toThrow();
  });

  it('drops repoDisplayName’s hazard too, not only sessionLabel’s', () => {
    expect(() => repoDisplayName(narrowedSession, [])).toThrow();
  });

  it('keeps the admin’s own sessions when both shapes arrive together', () => {
    expect(adminSessions([narrowedSession, fullSession]).map((s) => s.id)).toEqual(['managed-1']);
  });
});

describe('adminRuns', () => {
  it('keeps a Run the desktop views can read', () => {
    expect(adminRuns([fullRun])).toEqual([fullRun]);
  });

  // The reported crash: SessionSidebar and RunWorkspace both read
  // run.spec.objective directly.
  it('drops a collaborator’s narrowed Run, which has its objective at the top level and no spec', () => {
    expect(adminRuns([narrowedRun])).toEqual([]);
    expect(() => (narrowedRun as WorkRun).spec.objective).toThrow();
    expect(fullRun.spec.objective).toBe('Fix the flaky auth test');
  });

  it('keeps the admin’s own runs when both shapes arrive together', () => {
    expect(adminRuns([narrowedRun, fullRun]).map((r) => r.id)).toEqual(['run-1']);
  });
});

describe('adminRepos', () => {
  it('keeps a Repository the desktop views can read', () => {
    expect(adminRepos([fullRepo])).toEqual([fullRepo]);
  });

  // This one never threw — every read of `path` is optional-chained — so it
  // silently produced a repo picker of undefined values instead.
  it('drops a collaborator’s narrowed Repository, which carries no path', () => {
    expect(adminRepos([narrowedRepo])).toEqual([]);
    expect(narrowedRepo.path).toBeUndefined();
  });

  it('keeps the admin’s own repositories when both shapes arrive together', () => {
    expect(adminRepos([narrowedRepo, fullRepo]).map((r) => r.id)).toEqual([REPO]);
  });
});

// Empty, not broken: a collaborator's own agents, Runs and Repositories reach
// the UI through their separate collaborator* state, never these lists.
describe('a collaborator device’s payloads', () => {
  it('leave every admin-shaped list empty rather than half-populated', () => {
    expect(adminSessions([narrowedSession, narrowedSession])).toEqual([]);
    expect(adminRuns([narrowedRun, narrowedRun])).toEqual([]);
    expect(adminRepos([narrowedRepo, narrowedRepo])).toEqual([]);
  });
});
