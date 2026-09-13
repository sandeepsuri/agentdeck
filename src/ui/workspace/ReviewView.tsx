// Redesign spec §07: Run Review and repository Changes become one
// review-and-ship workflow. A Run's review reads from its derived result
// (run-result.ts) and its worktree diff; the decision is the existing
// tagged feedback post (run-review.ts); shipping is the existing explicit,
// admin-authorized apply/publish paths — each behind its own confirmation, so
// nothing is pushed or opened without a deliberate final human action.
import { useEffect, useMemo, useState } from 'react';
import type { FileClaim, Repo, ReviewDecision, Session } from '../../types.js';
import type { RunReviewState } from '../../work-engine/run-review.js';
import { deriveRunResult } from '../../work-engine/run-result.js';
import type { PublicationTarget, WorkRun } from '../../work-engine/types.js';
import { apiFetch } from '../apiFetch.js';
import { postRunFeedback } from '../collaboratorRuns.js';
import { estimateChangeRisk, RISK_LABELS } from '../risk.js';
import { ChangesWorkspace } from './ChangesWorkspace.js';
import { RunFeedbackPanel } from './RunFeedbackPanel.js';
import { attemptLabel, AttemptReport, isPublishableRun, PUBLICATION_STATE_COPY, RunResultPanel } from './RunWorkspace.js';
import { isTerminalRunStatus } from './runModel.js';

export type ReviewTarget = { kind: 'run'; runId: string } | { kind: 'repository'; repositoryId: string };
type ReviewTab = 'summary' | 'changes' | 'tests' | 'activity';
const REVIEW_TABS: { id: ReviewTab; label: string }[] = [
  { id: 'summary', label: 'Summary' },
  { id: 'changes', label: 'Changes' },
  { id: 'tests', label: 'Tests' },
  { id: 'activity', label: 'Activity' },
];

export interface ReviewViewProps {
  runs: readonly WorkRun[];
  repos: readonly Repo[];
  sessions: Session[];
  claims: FileClaim[];
  reviewStates: ReadonlyMap<string, RunReviewState>;
  activeRepositoryId: string | null;
  target: ReviewTarget | null;
  structuredAttemptsEnabled?: boolean;
  onSelectTarget: (target: ReviewTarget) => void;
  onReviewDecided: (runId: string) => void;
  onOpenInWork: (run: WorkRun) => void;
  onApply: (run: WorkRun) => Promise<void> | void;
  onReverify: (run: WorkRun) => void;
  onPreview: (run: WorkRun, path: string) => void;
  onPublish: (run: WorkRun, target: PublicationTarget) => Promise<void> | void;
  onError: (message: string) => void;
}

interface DiffTotals { files: number; additions: number; deletions: number }

function useBranchDiffTotals(repoPath: string | undefined): DiffTotals | null {
  const [totals, setTotals] = useState<DiffTotals | null>(null);
  useEffect(() => {
    setTotals(null);
    if (!repoPath) return;
    let disposed = false;
    apiFetch(`/api/repos/diff?${new URLSearchParams({ repo: repoPath, mode: 'branch' })}`)
      .then((response) => response.ok ? response.json() as Promise<{ files?: { additions: number; deletions: number }[] }> : null)
      .then((body) => {
        if (disposed || !body?.files) return;
        setTotals(body.files.reduce<DiffTotals>((sum, file) => ({ files: sum.files + 1, additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }), { files: 0, additions: 0, deletions: 0 }));
      })
      .catch(() => undefined);
    return () => { disposed = true; };
  }, [repoPath]);
  return totals;
}

function verificationState(run: WorkRun): 'passed' | 'failed' | 'none' {
  const evidence = deriveRunResult(run)?.verificationEvidence ?? [];
  const required = evidence.filter((check) => check.required);
  if (required.length === 0) return 'none';
  return required.every((check) => check.passed) ? 'passed' : 'failed';
}

/** Grouped by what the reviewer should do next, most actionable first. */
function reviewGroups(runs: readonly WorkRun[], reviewStates: ReadonlyMap<string, RunReviewState>) {
  const settled = runs.filter((run) => isTerminalRunStatus(run.status) && deriveRunResult(run));
  const byState = (state: RunReviewState['state']) => settled.filter((run) => (reviewStates.get(run.id)?.state ?? 'not_applicable') === state);
  return [
    { label: 'Ready for review', runs: byState('ready_to_review').filter((run) => run.publication?.state !== 'succeeded') },
    { label: 'Changes requested', runs: byState('changes_requested') },
    { label: 'Reviewed', runs: [...byState('reviewed'), ...byState('ready_to_review').filter((run) => run.publication?.state === 'succeeded')] },
  ];
}

type ShipOption = {
  id: 'leave' | 'apply' | 'push' | 'draft-pull-request';
  label: string;
  available: boolean;
  hint: string;
  confirm?: string;
};

function shipOptions(run: WorkRun): ShipOption[] {
  const result = deriveRunResult(run);
  const commit = result?.commit;
  const publishable = isPublishableRun(run);
  const publication = run.publication;
  const publicationOpen = !publication || publication.state === 'failed' || publication.state === 'ambiguous';
  const publishHint = !publishable
    ? 'Needs a verified local commit first.'
    : !publicationOpen ? PUBLICATION_STATE_COPY[publication!.state] : `Pushes ${commit!.sha.slice(0, 12)} on ${commit!.branch} to origin.`;
  return [
    { id: 'leave', label: 'Leave in working tree', available: true, hint: 'Nothing is committed, pushed or published.' },
    {
      id: 'apply', label: commit ? 'Apply local commit to repository' : 'Create local commit',
      available: Boolean(commit) && result?.delivery?.outcome !== 'applied',
      hint: !commit ? 'This work has no local commit to apply.' : result?.delivery?.outcome === 'applied' ? `Already applied to ${run.spec.repository.name}.` : `Applies ${commit.sha.slice(0, 12)} to ${run.spec.repository.name}.`,
      ...(commit ? { confirm: `Apply commit ${commit.sha.slice(0, 12)} to ${run.spec.repository.name}?` } : {}),
    },
    { id: 'push', label: 'Push branch', available: publishable && publicationOpen, hint: publishHint, ...(commit ? { confirm: `Push ${commit.branch} (${commit.sha.slice(0, 12)}) to origin?` } : {}) },
    { id: 'draft-pull-request', label: 'Open draft pull request', available: publishable && publicationOpen, hint: publishHint, ...(commit ? { confirm: `Push ${commit.branch} and open a draft pull request?` } : {}) },
  ];
}

function ShipMenu({ run, onApply, onPublish }: { run: WorkRun; onApply: ReviewViewProps['onApply']; onPublish: ReviewViewProps['onPublish'] }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<ShipOption | null>(null);
  const [busy, setBusy] = useState(false);
  const options = shipOptions(run);
  const act = async (option: ShipOption) => {
    setBusy(true);
    try {
      if (option.id === 'apply') await onApply(run);
      if (option.id === 'push' || option.id === 'draft-pull-request') await onPublish(run, option.id);
    } finally {
      setBusy(false);
      setPending(null);
      setOpen(false);
    }
  };
  return (
    <div className="ship-menu">
      <button aria-expanded={open} aria-haspopup="menu" className="button button-primary" onClick={() => { setOpen((current) => !current); setPending(null); }} type="button">Ship ▾</button>
      {open && !pending && (
        <div className="ship-menu-options" role="menu">
          {options.map((option) => (
            <button aria-disabled={!option.available} disabled={!option.available} key={option.id} onClick={() => (option.id === 'leave' ? setOpen(false) : setPending(option))} role="menuitem" type="button">
              <strong>{option.label}</strong><small>{option.hint}</small>
            </button>
          ))}
        </div>
      )}
      {pending && (
        <div aria-label="Confirm shipping" className="ship-confirm" role="alertdialog">
          <p>{pending.confirm}</p>
          <div>
            <button className="button" disabled={busy} onClick={() => setPending(null)} type="button">Cancel</button>
            <button className="button button-primary" disabled={busy} onClick={() => void act(pending)} type="button">{busy ? 'Working…' : pending.label}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function DecisionBar({ run, onDecided, onError, onApply, onPublish }: {
  run: WorkRun;
  onDecided: () => void;
  onError: (message: string) => void;
  onApply: ReviewViewProps['onApply'];
  onPublish: ReviewViewProps['onPublish'];
}) {
  const [requesting, setRequesting] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setRequesting(false); setNote(''); }, [run.id]);
  const decide = async (decision: ReviewDecision, text: string) => {
    setBusy(true);
    try {
      await postRunFeedback(run.id, text, { reviewDecision: decision });
      setRequesting(false);
      setNote('');
      onDecided();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <footer className="review-decision-bar">
      {requesting ? (
        <form className="review-request-changes" onSubmit={(event) => { event.preventDefault(); if (note.trim()) void decide('changes_requested', note.trim()); }}>
          <textarea aria-label="What should change?" autoFocus onChange={(event) => setNote(event.target.value)} placeholder="What should change?" rows={2} value={note} />
          <div>
            <button className="button" onClick={() => setRequesting(false)} type="button">Cancel</button>
            <button className="button button-primary" disabled={busy || !note.trim()} type="submit">Send request</button>
          </div>
        </form>
      ) : (
        <>
          <button className="button" disabled={busy} onClick={() => setRequesting(true)} type="button">Request changes</button>
          <span className="review-decision-spacer" />
          <button className="button" disabled={busy} onClick={() => void decide('reviewed', 'Approved.')} type="button">Approve</button>
          <ShipMenu onApply={onApply} onPublish={onPublish} run={run} />
        </>
      )}
    </footer>
  );
}

function RunReview({ run, review, sessions, claims, structuredAttemptsEnabled, onDecided, onOpenInWork, onApply, onReverify, onPreview, onPublish, onError }: {
  run: WorkRun;
  review: RunReviewState | undefined;
  sessions: Session[];
  claims: FileClaim[];
  structuredAttemptsEnabled: boolean;
  onDecided: () => void;
} & Pick<ReviewViewProps, 'onOpenInWork' | 'onApply' | 'onReverify' | 'onPreview' | 'onPublish' | 'onError'>) {
  const [tab, setTab] = useState<ReviewTab>('summary');
  useEffect(() => { setTab('summary'); }, [run.id]);
  const result = deriveRunResult(run);
  const worktree = run.preparation.state === 'ready' ? run.preparation.worktreePath : undefined;
  const totals = useBranchDiffTotals(worktree);
  const verification = verificationState(run);
  const files = totals?.files ?? result?.changedFiles.length ?? 0;
  const risk = estimateChangeRisk({ files, additions: totals?.additions ?? 0, deletions: totals?.deletions ?? 0, verification });
  const evidence = result?.verificationEvidence ?? [];

  return (
    <article className="review-detail">
      <header className="review-detail-header">
        <small>{run.spec.repository.name}</small>
        <h1 title={run.spec.objective}>{run.spec.objective}</h1>
        <button className="text-button" onClick={() => onOpenInWork(run)} type="button">Open in Work ↗</button>
      </header>
      <ul aria-label="Readiness" className="review-checklist">
        <li>{run.spec.acceptanceCriteria.length} acceptance criteri{run.spec.acceptanceCriteria.length === 1 ? 'on' : 'a'}</li>
        {evidence.map((check) => (
          <li className={check.passed ? 'is-pass' : 'is-fail'} key={`${check.gate}-${check.sequence}`}>{check.passed ? '✓' : '✕'} {check.gate}</li>
        ))}
        {evidence.length === 0 && <li className="is-none">No verification ran</li>}
      </ul>
      <dl className="review-facts">
        <div><dt>Files changed</dt><dd>{files}{totals && <> <em className="diff-add">+{totals.additions}</em> <em className="diff-del">−{totals.deletions}</em></>}</dd></div>
        <div><dt>Estimated risk</dt><dd><span className={`risk-badge risk-${risk}`}>{RISK_LABELS[risk]}</span></dd></div>
        {review && review.state !== 'not_applicable' && review.state !== 'ready_to_review' && (
          <div><dt>Review</dt><dd>{review.state === 'reviewed' ? 'Approved' : 'Changes requested'} by {review.reviewedBy}</dd></div>
        )}
        {run.attempts && run.attempts.length > 1 && <div><dt>Retries</dt><dd>{run.attempts.length - 1}</dd></div>}
      </dl>

      <div aria-label="Review sections" className="run-detail-tabs" role="tablist">
        {REVIEW_TABS.map((item) => (
          <button aria-controls={`review-tabpanel-${item.id}`} aria-selected={tab === item.id} className={tab === item.id ? 'is-active' : ''} id={`review-tab-${item.id}`} key={item.id} onClick={() => setTab(item.id)} role="tab" tabIndex={tab === item.id ? 0 : -1} type="button">{item.label}</button>
        ))}
      </div>

      <div aria-labelledby="review-tab-summary" className="run-detail-panel" hidden={tab !== 'summary'} id="review-tabpanel-summary" role="tabpanel">
        <section><h2>Objective</h2><p>{run.spec.objective}</p></section>
        <section><h2>Acceptance criteria</h2><ol>{run.spec.acceptanceCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ol></section>
        <RunResultPanel onPreview={onPreview} onReverify={onReverify} onViewChanges={() => setTab('changes')} run={run} />
        <RunFeedbackPanel runId={run.id} />
      </div>
      <div aria-labelledby="review-tab-changes" className="run-detail-panel review-changes-panel" hidden={tab !== 'changes'} id="review-tabpanel-changes" role="tabpanel">
        {tab === 'changes' && <ChangesWorkspace claims={claims} onError={onError} repoPath={worktree ?? run.spec.repository.path} sessions={sessions} />}
      </div>
      <div aria-labelledby="review-tab-tests" className="run-detail-panel" hidden={tab !== 'tests'} id="review-tabpanel-tests" role="tabpanel">
        {evidence.length > 0 ? (
          <ul className="review-tests">
            {evidence.map((check) => (
              <li className={check.passed ? 'is-pass' : 'is-fail'} key={`${check.gate}-${check.sequence}`}>
                <strong>{check.passed ? '✓' : '✕'} {check.gate}{check.required ? '' : ' (supplemental)'}</strong>
                <code>{check.command}</code>
                <details><summary>Log · exit {check.exitCode}</summary><pre>{check.evidence}</pre></details>
              </li>
            ))}
          </ul>
        ) : <p className="activity-empty">No verification commands ran for this work.</p>}
      </div>
      <div aria-labelledby="review-tab-activity" className="run-detail-panel" hidden={tab !== 'activity'} id="review-tabpanel-activity" role="tabpanel">
        {structuredAttemptsEnabled && run.attempts && run.attempts.length > 0
          ? run.attempts.map((record) => (
            <details className="run-section-detail" key={record.attemptId} open={record.ordinal === run.attempts!.length}>
              <summary>{attemptLabel(record.ordinal)}</summary>
              {record.state.state !== 'idle' && <AttemptReport events={record.state.events} />}
            </details>
          ))
          : run.attempt.state !== 'idle' ? <AttemptReport events={run.attempt.events} /> : <p className="activity-empty">No activity recorded.</p>}
      </div>

      <DecisionBar onApply={onApply} onDecided={onDecided} onError={onError} onPublish={onPublish} run={run} />
    </article>
  );
}

export function ReviewView({
  runs, repos, sessions, claims, reviewStates, activeRepositoryId, target, structuredAttemptsEnabled = false,
  onSelectTarget, onReviewDecided, onOpenInWork, onApply, onReverify, onPreview, onPublish, onError,
}: ReviewViewProps) {
  const scopedRuns = useMemo(() => activeRepositoryId ? runs.filter((run) => run.spec.repository.id === activeRepositoryId) : runs, [activeRepositoryId, runs]);
  const scopedRepos = activeRepositoryId ? repos.filter((repo) => repo.id === activeRepositoryId) : repos;
  const groups = reviewGroups(scopedRuns, reviewStates);
  const dirtyRepos = scopedRepos.filter((repo) => repo.isDirty || (repo.dirtyFiles?.length ?? 0) > 0);
  const selectedRun = target?.kind === 'run' ? runs.find((run) => run.id === target.runId) : undefined;
  const selectedRepo = target?.kind === 'repository' ? repos.find((repo) => repo.id === target.repositoryId) : undefined;
  const repositoryName = repos.find((repo) => repo.id === activeRepositoryId)?.name;

  return (
    <section className="review-workspace">
      <aside aria-label="Reviewable work" className="review-list">
        <div className="view-heading"><h1>{repositoryName ? `Review · ${repositoryName}` : 'Review'}</h1></div>
        {groups.map((group) => group.runs.length > 0 && (
          <div className="review-group" key={group.label}>
            <div className="sidebar-section-label"><span>{group.label}</span><span>{group.runs.length}</span></div>
            {group.runs.map((run) => (
              <button aria-current={selectedRun?.id === run.id ? 'true' : undefined} className={`review-row${selectedRun?.id === run.id ? ' is-selected' : ''}`} key={run.id} onClick={() => onSelectTarget({ kind: 'run', runId: run.id })} type="button">
                <strong title={run.spec.objective}>{run.spec.objective}</strong>
                <small>{run.spec.repository.name} · {deriveRunResult(run)?.changedFiles.length ?? 0} files</small>
              </button>
            ))}
          </div>
        ))}
        {dirtyRepos.length > 0 && (
          <div className="review-group">
            <div className="sidebar-section-label"><span>Uncommitted changes</span><span>{dirtyRepos.length}</span></div>
            {dirtyRepos.map((repo) => (
              <button aria-current={selectedRepo?.id === repo.id ? 'true' : undefined} className={`review-row${selectedRepo?.id === repo.id ? ' is-selected' : ''}`} key={repo.id} onClick={() => onSelectTarget({ kind: 'repository', repositoryId: repo.id })} type="button">
                <strong>{repo.name}</strong>
                <small>⎇ {repo.currentBranch ?? 'unknown'} · {repo.dirtyFiles?.length ?? 0} files</small>
              </button>
            ))}
          </div>
        )}
        {groups.every((group) => group.runs.length === 0) && dirtyRepos.length === 0 && <p className="home-empty">Nothing to review yet.</p>}
      </aside>

      <div className="review-stage">
        {selectedRun ? (
          <RunReview
            claims={claims}
            onApply={onApply}
            onDecided={() => onReviewDecided(selectedRun.id)}
            onError={onError}
            onOpenInWork={onOpenInWork}
            onPreview={onPreview}
            onPublish={onPublish}
            onReverify={onReverify}
            review={reviewStates.get(selectedRun.id)}
            run={selectedRun}
            sessions={sessions}
            structuredAttemptsEnabled={structuredAttemptsEnabled}
          />
        ) : selectedRepo ? (
          <div className="review-repository">
            <header className="review-detail-header"><small>Uncommitted changes</small><h1>{selectedRepo.name}</h1></header>
            <ChangesWorkspace claims={claims} onError={onError} repoPath={selectedRepo.path} sessions={sessions} />
          </div>
        ) : (
          <div className="empty-workspace"><strong>Select work to review</strong><span>Summary, changes, tests and activity appear here, with the ship controls.</span></div>
        )}
      </div>
    </section>
  );
}
