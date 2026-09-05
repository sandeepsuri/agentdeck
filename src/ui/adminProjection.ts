// Three endpoints answer two different shapes, and this is where the client
// picks the one its desktop state is typed for.
//
// GET /api/sessions, /api/runs and /api/repos are the same routes the local
// admin uses, and a collaborator device gets a narrowed projection from each
// (server/collaborator-session-view.ts, collaborator-run-view.ts, and
// routes.ts's scopeRepos) with the machine-describing fields dropped. Those
// three are the whole overlap between the collaborator allowlist (app.ts's
// isCollaboratorAllowedRoute) and the state App's desktop tree reads — the
// rest of that allowlist has no desktop equivalent to land in.
//
// The overlap matters because of when App fetches. `connectionKind` starts
// 'local' so the desktop tree can render immediately, which means the desktop
// refreshers all fire once before GET /api/connection has said what kind of
// device this is. On a collaborator's phone that put narrowed payloads into
// admin-shaped state, and the desktop tree threw on the next render:
// `session.cwd.split('/')` for Sessions, `run.spec.objective` for Runs. Repos
// did not throw only because every read of `path`/`dirtyFiles` happens to be
// optional-chained — the same lie, quieter.
//
// So each guard here filters to the field its consumers actually require. A
// collaborator's own agents, Runs and Repositories reach the UI through their
// separate `collaborator*` state, never these lists, so the result for them is
// an empty list rather than a broken one — exactly what these held before
// those routes opened. Guarding at the fetch is deliberate: the alternative,
// deferring the desktop refreshers until the probe resolves, would leave the
// desktop with no data at all whenever GET /api/connection fails, which today
// it survives.
import type { Repo, Session } from '../types.js';
import type { WorkRun } from '../work-engine/types.js';

/** `cwd` is required by sessionLabel, repoPathOf and repoDisplayName (workspace/model.tsx). */
export function adminSessions(sessions: readonly Session[]): Session[] {
  return sessions.filter((session) => typeof session.cwd === 'string');
}

/** `spec` is required by SessionSidebar and RunWorkspace, which read run.spec.objective directly. */
export function adminRuns(runs: readonly WorkRun[]): WorkRun[] {
  return runs.filter((run) => typeof run.spec?.objective === 'string');
}

/** `path` is required by LaunchModal's repo picker, App's change count, and repoDisplayName. */
export function adminRepos(repos: readonly Repo[]): Repo[] {
  return repos.filter((repo) => typeof repo.path === 'string');
}
