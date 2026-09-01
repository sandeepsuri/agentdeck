import { WORKSPACE_VIEWS, type WorkspaceView } from './workspace/model.js';

export interface InitialNavigation {
  sessionId?: string;
  /** Ticket 07: the native companion's openRun deep-link (CompanionStore.swift) — ?run=<id>, same shape as ?session=. */
  runId?: string;
  view?: WorkspaceView;
}

export function parseInitialNavigation(search: string): InitialNavigation {
  const params = new URLSearchParams(search);
  const sessionId = params.get('session')?.trim();
  const runId = params.get('run')?.trim();
  const requestedView = params.get('view');
  const view = WORKSPACE_VIEWS.some((candidate) => candidate.id === requestedView)
    ? requestedView as WorkspaceView
    : undefined;
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(runId ? { runId } : {}),
    ...(view ? { view } : {}),
  };
}
