// Issue #80: the owner's personal tasks, apart from coding Runs and
// Sessions. The owner grants one folder through the native macOS picker
// (the browser never names a path), chooses PDFs in it, and submits an
// inventory that AgentDeck performs itself, or (issue #81) asks a confined
// agent for a filing proposal that moves nothing until the owner approves
// that exact plan (issue #82); AgentDeck then moves the files itself and
// shows a receipt for each one. Activity and results come
// from the durable server projection, so a reload or restart reopens the
// same task.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { GrantedPdfListing } from '../../personal-tasks/folder-grant.js';
import {
  isFilingProposal, type FilingApprovalView, type FilingPlanEntry, type FilingProposalResult, type FilingReceiptState, type FolderGrantView, type PdfInventoryResult, type PersonalTaskKind,
  type PersonalTaskStatus, type PersonalTaskView,
} from '../../personal-tasks/types.js';
import { apiFetch } from '../apiFetch.js';
import { EmailRepliesPanel } from './EmailRepliesPanel.js';
import { RoutinesPanel, SaveRoutine } from './RoutinesPanel.js';

const POLL_MS = 1500;

const STATUS_LABEL: Record<PersonalTaskStatus, string> = {
  queued: 'Queued',
  running: 'Working',
  completed: 'Done',
  failed: 'Needs attention',
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(url, init);
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status}).`);
  return body;
}

const post = <T,>(url: string, payload?: unknown) => request<T>(url, {
  method: 'POST',
  ...(payload === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
});

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const time = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function PdfSelection({ grant, onSubmitted, onError }: {
  grant: FolderGrantView;
  onSubmitted: (task: PersonalTaskView) => void;
  onError: (message: string) => void;
}) {
  const [listing, setListing] = useState<GrantedPdfListing | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<PersonalTaskKind | null>(null);

  useEffect(() => {
    let disposed = false;
    setListing(null);
    setLoadError(null);
    request<GrantedPdfListing>(`/api/personal/grants/${encodeURIComponent(grant.id)}/pdfs`)
      .then((next) => {
        if (disposed) return;
        setListing(next);
        setSelected(new Set(next.files.map((file) => file.relativePath)));
      })
      .catch((error: Error) => { if (!disposed) setLoadError(error.message); });
    return () => { disposed = true; };
  }, [grant.id]);

  const toggle = (file: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(file)) next.delete(file); else next.add(file);
    return next;
  });

  const submit = async (kind: PersonalTaskKind) => {
    setBusy(kind);
    try {
      const files = listing!.files.map((file) => file.relativePath).filter((file) => selected.has(file));
      onSubmitted(await post<PersonalTaskView>('/api/personal/tasks', { kind, grantId: grant.id, files }));
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (loadError) return <p className="personal-empty" role="alert">{loadError}</p>;
  if (!listing) return <p className="personal-empty">Looking for PDFs in {grant.name}…</p>;
  if (listing.files.length === 0) return <p className="personal-empty">No PDFs in {grant.name}.</p>;
  const all = listing.files.length === selected.size;
  return (
    <form className="personal-pdf-picker" onSubmit={(event) => { event.preventDefault(); void submit('pdf-inventory'); }}>
      <fieldset>
        <legend>PDFs in {grant.name}</legend>
        <label className="personal-pdf-all">
          <input
            checked={all}
            onChange={() => setSelected(all ? new Set() : new Set(listing.files.map((file) => file.relativePath)))}
            type="checkbox"
          />
          Select all
        </label>
        <ul>
          {listing.files.map((file) => (
            <li key={file.relativePath}>
              <label>
                <input checked={selected.has(file.relativePath)} onChange={() => toggle(file.relativePath)} type="checkbox" />
                <span className="personal-pdf-name">{file.relativePath}</span>
                <small>{formatBytes(file.size)}</small>
              </label>
            </li>
          ))}
        </ul>
        {listing.truncated && <p className="personal-note">Only the first {listing.files.length} PDFs are shown.</p>}
      </fieldset>
      <div className="personal-pdf-actions">
        <button className="button button-primary" disabled={busy !== null || selected.size === 0} type="submit">
          {busy === 'pdf-inventory' ? 'Submitting…' : `Inspect ${selected.size} PDF${selected.size === 1 ? '' : 's'}`}
        </button>
        <button className="button" disabled={busy !== null || selected.size === 0} onClick={() => void submit('pdf-filing-proposal')} type="button">
          {busy === 'pdf-filing-proposal' ? 'Submitting…' : 'Propose filing plan'}
        </button>
      </div>
      <p className="personal-note">A filing plan lets a confined agent read the selected PDFs through AgentDeck and suggest names and folders. Nothing is moved until you approve the plan.</p>
    </form>
  );
}

function InventoryResult({ result }: { result: PdfInventoryResult }) {
  return (
    <section aria-label="Inventory" className="personal-result">
      <p className="personal-result-summary">
        {result.files.length} PDF{result.files.length === 1 ? '' : 's'} · {formatBytes(result.totalBytes)}
        {result.knownPages > 0 ? ` · ${result.knownPages} pages` : ''}
      </p>
      <div className="personal-table-scroll">
        <table>
          <thead><tr><th scope="col">File</th><th scope="col">Pages</th><th scope="col">Size</th><th scope="col">Version</th><th scope="col">Fingerprint</th></tr></thead>
          <tbody>
            {result.files.map((file) => (
              <tr key={file.path}>
                <th scope="row" title={file.path}>{file.path}{file.encrypted ? ' 🔒' : ''}</th>
                <td>{file.pageCount ?? 'Unknown'}</td>
                <td>{formatBytes(file.size)}</td>
                <td>{file.pdfVersion ?? '—'}</td>
                <td><code title={file.sha256}>{file.sha256.slice(0, 12)}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {result.skipped.length > 0 && (
        <ul className="personal-skipped" aria-label="Skipped files">
          {result.skipped.map((entry) => <li key={entry.path}><strong>{entry.path}</strong>: {entry.reason}</li>)}
        </ul>
      )}
    </section>
  );
}

const REPLACES = new Set(['overwrite', 'already-filed']);
const replacesFile = (entry: FilingPlanEntry) => entry.warnings.some((warning) => REPLACES.has(warning.kind));
const unchanged = (entry: FilingPlanEntry) => entry.warnings.some((warning) => warning.kind === 'unchanged');

const RECEIPT_LABEL: Record<FilingReceiptState, string> = {
  pending: 'Waiting',
  moving: 'Moving',
  moved: 'Moved',
  skipped: 'Left in place',
  failed: 'Not moved',
  uncertain: 'Check folder',
};

function filingHeadline(filing: FilingApprovalView): string {
  const planned = filing.receipts.filter((receipt) => receipt.state !== 'skipped');
  const moved = planned.filter((receipt) => receipt.state === 'moved' && receipt.undoState !== 'undone').length;
  const restored = planned.filter((receipt) => receipt.undoState === 'undone').length;
  const uncertain = planned.filter((receipt) => receipt.state === 'uncertain').length;
  if (filing.state === 'approved' || filing.state === 'executing') return `Moving… ${moved} of ${planned.length} moved so far.`;
  if (filing.state === 'expired') return 'The approval expired before the moves started. Nothing was moved.';
  const notMoved = planned.length - moved - restored - uncertain;
  return `Moved ${moved} of ${planned.length} PDF${planned.length === 1 ? '' : 's'}`
    + `${restored ? ` · ${restored} restored` : ''}${notMoved ? ` · ${notMoved} not moved` : ''}`
    + `${uncertain ? ` · ${uncertain} uncertain` : ''}.`;
}

/** Rendered only from the typed plan entries, digests, and receipts; the agent's own words never appear here. */
function FilingProposal({ result, filing, onApprove, onFilingAction }: {
  result: FilingProposalResult;
  filing?: FilingApprovalView;
  onApprove: (overwrite: string[]) => Promise<void>;
  onFilingAction: (action: 'retry' | 'undo') => Promise<void>;
}) {
  const [replace, setReplace] = useState<ReadonlySet<string>>(new Set());
  const [approving, setApproving] = useState(false);
  const warned = result.entries.filter((entry) => entry.warnings.some((warning) => warning.kind !== 'new-folder')).length;
  const receipts = new Map(filing?.receipts.map((receipt) => [receipt.source, receipt]));
  const moving = result.entries.filter((entry) => !unchanged(entry) && (!replacesFile(entry) || replace.has(entry.source))).length;

  const toggle = (source: string) => setReplace((current) => {
    const next = new Set(current);
    if (next.has(source)) next.delete(source); else next.add(source);
    return next;
  });

  const approve = async () => {
    setApproving(true);
    try {
      await onApprove(result.entries.filter((entry) => replace.has(entry.source)).map((entry) => entry.source));
    } finally {
      setApproving(false);
    }
  };

  return (
    <section aria-label="Filing proposal" className="personal-result">
      <p className="personal-result-summary">
        {result.entries.length} PDF{result.entries.length === 1 ? '' : 's'} to file
        {warned > 0 ? ` · ${warned} with warnings` : ''}
        {result.unplanned.length > 0 ? ` · ${result.unplanned.length} left in place` : ''}
        {' · '}<strong>{filing ? filingHeadline(filing) : 'Nothing has been moved.'}</strong>
      </p>
      <div className="personal-table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Now</th><th scope="col">New name</th><th scope="col">Folder</th><th scope="col">Warnings</th>
              {filing && <th scope="col">Outcome</th>}
            </tr>
          </thead>
          <tbody>
            {result.entries.map((entry) => {
              const receipt = receipts.get(entry.source);
              return (
                <tr key={entry.source}>
                  <th scope="row" title={`${entry.source} · ${entry.sourceSha256}`}>{entry.source}</th>
                  <td>{entry.newName}</td>
                  <td>{entry.destination || 'Top of folder'}</td>
                  <td className="personal-warnings">
                    {entry.warnings.length === 0 ? '—' : (
                      <ul>
                        {entry.warnings.map((warning) => (
                          <li className={`is-${warning.kind}`} key={warning.kind}>{warning.message}</li>
                        ))}
                      </ul>
                    )}
                    {!filing && replacesFile(entry) && (
                      <label className="personal-replace">
                        <input checked={replace.has(entry.source)} onChange={() => toggle(entry.source)} type="checkbox" />
                        Replace the existing file
                      </label>
                    )}
                  </td>
                  {filing && (
                    <td className="personal-receipt">
                      {receipt ? (
                        <>
                          <span className={`personal-receipt-state is-${receipt.state}`}>{RECEIPT_LABEL[receipt.state]}</span>
                          {receipt.reason && <small>{receipt.reason}</small>}
                          {receipt.undoState && <small>{receipt.undoState === 'undone' ? 'Restored to original name' : receipt.undoState === 'undoing' ? 'Restoring…' : `Undo conflict: ${receipt.undoReason}`}</small>}
                        </>
                      ) : '—'}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {result.unplanned.length > 0 && (
        <ul className="personal-skipped" aria-label="Left in place">
          {result.unplanned.map((entry) => <li key={entry.path}><strong>{entry.path}</strong>: {entry.reason}</li>)}
        </ul>
      )}
      {result.skipped.length > 0 && (
        <ul className="personal-skipped" aria-label="Skipped files">
          {result.skipped.map((entry) => <li key={entry.path}><strong>{entry.path}</strong>: {entry.reason}</li>)}
        </ul>
      )}
      {filing ? (
        <div className="personal-approve">
          <p className="personal-note">Approved by {filing.approvedBy.displayName} on {filing.approvedBy.device} at {time(filing.approvedAt)} for plan <code title={filing.planDigest}>{filing.planDigest.slice(0, 12)}</code>.</p>
          {filing.state === 'finished' && <div className="personal-pdf-actions">
            {filing.receipts.some((receipt) => receipt.state === 'failed') && <button className="button" onClick={() => void onFilingAction('retry')} type="button">Retry files not moved</button>}
            {filing.receipts.some((receipt) => receipt.state === 'moved' && receipt.undoState !== 'undone') && <button className="button" onClick={() => void onFilingAction('undo')} type="button">Undo recorded moves</button>}
          </div>}
        </div>
      ) : (
        <div className="personal-approve">
          <button className="button button-primary" disabled={approving || moving === 0} onClick={() => void approve()} type="button">
            {approving ? 'Approving…' : `Approve and move ${moving} PDF${moving === 1 ? '' : 's'}`}
          </button>
          <p className="personal-note">
            Approves exactly this plan (fingerprint <code title={result.planDigest}>{result.planDigest.slice(0, 12)}</code>), once.
            AgentDeck moves the files itself and checks each one again first: a file that changed, a link, or a name that is now taken is left where it is.
            Proposed by confined Claude Code {result.provider.cliVersion.split(' ')[0]}.
          </p>
        </div>
      )}
    </section>
  );
}

function TaskDetail({ task, onRetry, onApprove, onFilingAction, onRoutineSaved }: {
  task: PersonalTaskView;
  onRetry: () => void;
  onApprove: (overwrite: string[]) => Promise<void>;
  onFilingAction: (action: 'retry' | 'undo') => Promise<void>;
  onRoutineSaved?: () => void;
}) {
  return (
    <article aria-labelledby={`personal-task-${task.id}`} className="personal-task-detail">
      <header>
        <h3 id={`personal-task-${task.id}`}>{task.title}</h3>
        <span className={`personal-status is-${task.status}`}>{STATUS_LABEL[task.status]}</span>
      </header>
      <dl className="personal-task-meta">
        <div><dt>Requested by</dt><dd>{task.submittedBy.displayName} on {task.submittedBy.device}</dd></div>
        <div><dt>Folder</dt><dd>{task.grant.name}{task.grant.revoked ? ' (access revoked)' : ''}</dd></div>
        <div><dt>Submitted</dt><dd>{time(task.submittedAt)}</dd></div>
        <div><dt>Attempts</dt><dd>{task.attempts.length}</dd></div>
        <div><dt>Rules</dt><dd>{task.policyVersion}</dd></div>
      </dl>

      {task.failure && (
        <div className="personal-failure" role="alert">
          <p>{task.failure}</p>
          {task.status === 'failed' && <button className="button" onClick={onRetry} type="button">Try again</button>}
        </div>
      )}

      {task.status === 'completed' && (task.kind === 'pdf-inventory' || task.filing?.state === 'finished') && (
        <SaveRoutine
          defaultName={task.kind === 'pdf-filing-proposal' ? `File new PDFs in ${task.grant.name}` : `Inspect PDFs in ${task.grant.name}`}
          key={`routine-${task.id}`}
          source="personal"
          taskId={task.id}
          {...(onRoutineSaved ? { onSaved: onRoutineSaved } : {})}
        />
      )}

      {task.result && (isFilingProposal(task.result)
        ? <FilingProposal key={task.id} onApprove={onApprove} onFilingAction={onFilingAction} result={task.result} {...(task.filing ? { filing: task.filing } : {})} />
        : <InventoryResult result={task.result} />)}

      <section aria-label="Activity">
        <h4>Activity</h4>
        <ol className="personal-activity">
          {task.activity.map((entry) => (
            <li className={`is-${entry.kind}`} key={entry.sequence}>
              <time dateTime={entry.at}>{new Date(entry.at).toLocaleTimeString()}</time>
              <span>{entry.message}</span>
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
}

export function PersonalTasksView({ active = true }: { active?: boolean }) {
  const [grants, setGrants] = useState<FolderGrantView[] | null>(null);
  const [tasks, setTasks] = useState<PersonalTaskView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedGrantId, setSelectedGrantId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [routineSignal, setRoutineSignal] = useState(0);
  const [emailSignal, setEmailSignal] = useState(0);
  const [emailFocus, setEmailFocus] = useState<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const [nextGrants, nextTasks] = await Promise.all([
        request<FolderGrantView[]>('/api/personal/grants'),
        request<PersonalTaskView[]>('/api/personal/tasks'),
      ]);
      setGrants(nextGrants);
      setTasks(nextTasks);
      setLoadError(null);
    } catch (caught) {
      setLoadError((caught as Error).message);
    }
  }, []);

  useEffect(() => { if (active) void refresh(); }, [active, refresh]);

  const unsettled = tasks?.some((task) => task.status === 'queued' || task.status === 'running'
    || task.filing?.state === 'approved' || task.filing?.state === 'executing') ?? false;
  useEffect(() => {
    if (!active || !unsettled) return undefined;
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [active, unsettled, refresh]);

  const activeGrants = useMemo(() => (grants ?? []).filter((grant) => !grant.revokedAt), [grants]);
  const selectedGrant = activeGrants.find((grant) => grant.id === selectedGrantId);
  const selectedTask = tasks?.find((task) => task.id === selectedTaskId) ?? tasks?.[0];

  const run = async (action: () => Promise<void>) => {
    setError(null);
    try { await action(); } catch (caught) { setError((caught as Error).message); }
  };

  const pick = () => run(async () => {
    setPicking(true);
    try {
      const result = await post<{ grant?: FolderGrantView; cancelled?: boolean }>('/api/personal/grants/pick');
      if (result.grant) {
        setSelectedGrantId(result.grant.id);
        await refresh();
      }
    } finally {
      setPicking(false);
    }
  });

  const revoke = (grant: FolderGrantView) => run(async () => {
    await post(`/api/personal/grants/${encodeURIComponent(grant.id)}/revoke`);
    if (selectedGrantId === grant.id) setSelectedGrantId(null);
    await refresh();
  });

  const retry = (task: PersonalTaskView) => run(async () => {
    await post(`/api/personal/tasks/${encodeURIComponent(task.id)}/retry`);
    await refresh();
  });

  const approve = (task: PersonalTaskView, overwrite: string[]) => run(async () => {
    const result = task.result;
    if (!result || !isFilingProposal(result)) return;
    await post(`/api/personal/tasks/${encodeURIComponent(task.id)}/filing/approve`, { planDigest: result.planDigest, overwrite });
    await refresh();
  });

  const filingAction = (task: PersonalTaskView, action: 'retry' | 'undo') => run(async () => {
    await post(`/api/personal/tasks/${encodeURIComponent(task.id)}/filing/${action}`, { idempotencyKey: crypto.randomUUID() });
    await refresh();
  });

  return (
    <section className="workspace-scroll personal-view">
      <div className="view-heading">
        <div className="view-heading-copy">
          <h1>Personal tasks</h1>
          <span>AgentDeck reads only the folder you choose. An agent sees these files only for a filing plan you ask for, and never moves them; only a plan you approve is moved, by AgentDeck itself.</span>
        </div>
      </div>

      {(error || loadError) && <p className="personal-error" role="alert">{error ?? `Personal tasks are unavailable: ${loadError}`}</p>}

      <section aria-labelledby="personal-folders" className="home-section">
        <header className="home-section-header">
          <h2 id="personal-folders">Folders</h2>
          <button className="button" disabled={picking} onClick={() => void pick()} type="button">
            {picking ? 'Choose a folder on this Mac…' : 'Choose a folder…'}
          </button>
        </header>
        {grants === null ? (!loadError && <p className="personal-empty">Loading…</p>) : grants.length === 0 ? (
          <p className="personal-empty">No folders yet. Choose one folder, such as a folder of statements, to inspect its PDFs.</p>
        ) : (
          <ul className="personal-grants">
            {grants.map((grant) => (
              <li className={grant.revokedAt ? 'is-revoked' : grant.id === selectedGrantId ? 'is-selected' : ''} key={grant.id}>
                <button
                  aria-pressed={grant.id === selectedGrantId}
                  className="personal-grant-open"
                  disabled={Boolean(grant.revokedAt)}
                  onClick={() => setSelectedGrantId(grant.id)}
                  type="button"
                >
                  <strong>{grant.name}</strong>
                  <small>{grant.revokedAt ? 'Access revoked' : grant.displayPath}</small>
                </button>
                {!grant.revokedAt && (
                  <button aria-label={`Revoke access to ${grant.name}`} className="text-button" onClick={() => void revoke(grant)} type="button">Revoke access</button>
                )}
              </li>
            ))}
          </ul>
        )}
        {selectedGrant && (
          <PdfSelection
            grant={selectedGrant}
            key={selectedGrant.id}
            onError={setError}
            onSubmitted={(task) => {
              setSelectedGrantId(null);
              setSelectedTaskId(task.id);
              void refresh();
            }}
          />
        )}
      </section>

      <RoutinesPanel
        active={active}
        onOpenTask={(source, taskId) => {
          if (source === 'personal') {
            setSelectedTaskId(taskId);
            void refresh();
          } else setEmailFocus(taskId);
        }}
        onRan={(source) => { if (source === 'email') setEmailSignal((n) => n + 1); else void refresh(); }}
        refreshSignal={routineSignal}
      />

      <section aria-labelledby="personal-tasks" className="home-section">
        <header className="home-section-header"><h2 id="personal-tasks">Tasks</h2></header>
        {tasks === null ? null : tasks.length === 0 ? (
          <p className="personal-empty">No personal tasks yet.</p>
        ) : (
          <div className="personal-task-layout">
            <ul aria-label="Personal tasks" className="personal-task-list">
              {tasks.map((task) => (
                <li key={task.id}>
                  <button aria-current={task.id === selectedTask?.id ? 'true' : undefined} onClick={() => setSelectedTaskId(task.id)} type="button">
                    <strong>{task.title}</strong>
                    <span className={`personal-status is-${task.status}`}>{STATUS_LABEL[task.status]}</span>
                    <small>{time(task.submittedAt)}</small>
                  </button>
                </li>
              ))}
            </ul>
            {selectedTask && (
              <TaskDetail
                onApprove={(overwrite) => approve(selectedTask, overwrite)}
                onFilingAction={(action) => filingAction(selectedTask, action)}
                onRetry={() => void retry(selectedTask)}
                onRoutineSaved={() => setRoutineSignal((n) => n + 1)}
                task={selectedTask}
              />
            )}
          </div>
        )}
      </section>

      <EmailRepliesPanel
        active={active}
        focusTaskId={emailFocus}
        onRoutineSaved={() => setRoutineSignal((n) => n + 1)}
        refreshSignal={emailSignal}
      />
    </section>
  );
}
