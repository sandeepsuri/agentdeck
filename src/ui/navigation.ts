import { WORKSPACE_VIEWS, type WorkspaceView } from './workspace/model.js';

export interface InitialNavigation {
  sessionId?: string;
  /** Ticket 07: the native companion's openRun deep-link (CompanionStore.swift) — ?run=<id>, same shape as ?session=. */
  runId?: string;
  view?: WorkspaceView;
}

/**
 * Redesign spec §14: destinations retired from primary navigation. Deep links
 * (the notch companion still sends view=terminal / view=operations) resolve
 * to the destination that absorbed them rather than being dropped.
 * `overview` is a real destination again (Developer tools › Overview, #79).
 */
const LEGACY_VIEWS: Record<string, WorkspaceView> = {
  tasks: 'work',
  operations: 'work',
  terminal: 'work',
  grid: 'work',
  history: 'work',
  signals: 'work',
  changes: 'review',
};

export function parseInitialNavigation(search: string): InitialNavigation {
  const params = new URLSearchParams(search);
  const sessionId = params.get('session')?.trim();
  const runId = params.get('run')?.trim();
  const requestedView = params.get('view') ?? '';
  const view = WORKSPACE_VIEWS.some((candidate) => candidate.id === requestedView)
    ? requestedView as WorkspaceView
    : LEGACY_VIEWS[requestedView];
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(runId ? { runId } : {}),
    ...(view ? { view } : {}),
  };
}

/** A Session inspector belongs only beside an opened Session's detail inside Work. */
export function isInspectorRelevant(view: WorkspaceView, hasOpenSession: boolean): boolean {
  return hasOpenSession && view === 'work';
}
