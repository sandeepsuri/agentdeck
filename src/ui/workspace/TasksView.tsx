// Ticket 48 (B02): explicit, cross-Repository browsing of existing Runs by
// their objective, plus a clearly separate entry to ended Session History.
//
// This is deliberately not a new Task record or persistence model — a "Task"
// here is exactly an existing WorkRun's objective (work-engine/types.ts's
// WorkRun.taskId is, today, one-to-one with WorkRun.id; there is no
// independent Task object, editing, or multi-Run-per-Task support to browse
// into). Selecting a row hands off to the same RunWorkspace detail every
// other entry point (sidebar, Overview, command palette) already opens, and
// deletion reuses the sidebar's own RunRow — same confirmation copy, same
// terminal-status gating — rather than inventing a second deletion path.
//
// Unlike Overview (ticket 47), which groups Runs under the Repository you
// pick first, this is a flat list across every Repository: "what has been
// asked for, anywhere" rather than "what is happening in this Repository."
import { useState } from 'react';
import type { RunStatus, WorkRun } from '../../work-engine/types.js';
import { formatRunLabel, orderRuns, RUN_STATUS_OPTIONS } from './runModel.js';
import { RunRow } from './SessionSidebar.js';

export interface Props {
  runs: WorkRun[];
  selectedRunId?: string | null;
  onSelectRun: (run: WorkRun) => void;
  onDeleteRun?: (run: WorkRun) => void;
  onViewHistory: () => void;
  /** Ended Sessions count for the History link — purely descriptive, never a personal queue. */
  historyCount?: number;
}

export function TasksView({ runs, selectedRunId = null, onSelectRun, onDeleteRun, onViewHistory, historyCount = 0 }: Props) {
  const ordered = orderRuns(runs);
  const [statusFilter, setStatusFilter] = useState<'all' | RunStatus>('all');
  const visible = statusFilter === 'all' ? ordered : ordered.filter((run) => run.status === statusFilter);
  return (
    <section className="workspace-scroll tasks-view">
      <div className="view-heading tasks-view-heading">
        <span>
          <h1>Tasks</h1>
          <span className="tasks-view-subtitle">Objectives represented by existing Runs — not a separate record</span>
        </span>
        <label className="work-status-filter">
          <span>Run status</span>
          <select aria-label="Filter Runs by status" onChange={(event) => setStatusFilter(event.target.value as 'all' | RunStatus)} value={statusFilter}>
            <option value="all">All statuses</option>
            {RUN_STATUS_OPTIONS.map((status) => <option key={status} value={status}>{formatRunLabel(status)}</option>)}
          </select>
        </label>
        <button className="button tasks-history-link" onClick={onViewHistory} type="button">
          Session history{historyCount > 0 ? ` (${historyCount})` : ''} ↗
        </button>
      </div>

      <div className="tasks-view-list">
        {visible.map((run) => (
          <RunRow key={run.id} onDelete={onDeleteRun} onSelect={() => onSelectRun(run)} run={run} selected={run.id === selectedRunId} />
        ))}
        {ordered.length === 0 && (
          <div className="empty-workspace">
            <strong>No Runs have been requested yet</strong>
            <span>Submit a Run to see its objective, progress, and result here.</span>
          </div>
        )}
        {ordered.length > 0 && visible.length === 0 && (
          <div className="empty-workspace">
            <strong>No Runs match {formatRunLabel(statusFilter)}</strong>
            <span>Choose another status to see existing Runs.</span>
          </div>
        )}
      </div>
    </section>
  );
}
