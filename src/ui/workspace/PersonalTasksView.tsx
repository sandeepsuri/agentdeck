// Issue #80: the owner's personal tasks, apart from coding Runs and
// Sessions. The owner grants one folder through the native macOS picker
// (the browser never names a path), chooses PDFs in it, and submits an
// inventory that AgentDeck performs itself. Activity and results come from
// the durable server projection, so a reload or restart reopens the same
// task.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { GrantedPdfListing } from '../../personal-tasks/folder-grant.js';
import type { FolderGrantView, PersonalTaskStatus, PersonalTaskView } from '../../personal-tasks/types.js';
import { apiFetch } from '../apiFetch.js';

const POLL_MS = 1500;

const STATUS_LABEL: Record<PersonalTaskStatus, string> = {
  queued: 'Queued',
  running: 'Inspecting',
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
  const [busy, setBusy] = useState(false);

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

  const submit = async () => {
    setBusy(true);
    try {
      const files = listing!.files.map((file) => file.relativePath).filter((file) => selected.has(file));
      onSubmitted(await post<PersonalTaskView>('/api/personal/tasks', { kind: 'pdf-inventory', grantId: grant.id, files }));
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (loadError) return <p className="personal-empty" role="alert">{loadError}</p>;
  if (!listing) return <p className="personal-empty">Looking for PDFs in {grant.name}…</p>;
  if (listing.files.length === 0) return <p className="personal-empty">No PDFs in {grant.name}.</p>;
  const all = listing.files.length === selected.size;
  return (
    <form className="personal-pdf-picker" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
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
      <button className="button button-primary" disabled={busy || selected.size === 0} type="submit">
        {busy ? 'Submitting…' : `Inspect ${selected.size} PDF${selected.size === 1 ? '' : 's'}`}
      </button>
    </form>
  );
}

function TaskDetail({ task, onRetry }: { task: PersonalTaskView; onRetry: () => void }) {
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

      {task.result && (
        <section aria-label="Inventory" className="personal-result">
          <p className="personal-result-summary">
            {task.result.files.length} PDF{task.result.files.length === 1 ? '' : 's'} · {formatBytes(task.result.totalBytes)}
            {task.result.knownPages > 0 ? ` · ${task.result.knownPages} pages` : ''}
          </p>
          <div className="personal-table-scroll">
            <table>
              <thead><tr><th scope="col">File</th><th scope="col">Pages</th><th scope="col">Size</th><th scope="col">Version</th><th scope="col">Fingerprint</th></tr></thead>
              <tbody>
                {task.result.files.map((file) => (
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
          {task.result.skipped.length > 0 && (
            <ul className="personal-skipped" aria-label="Skipped files">
              {task.result.skipped.map((entry) => <li key={entry.path}><strong>{entry.path}</strong>: {entry.reason}</li>)}
            </ul>
          )}
        </section>
      )}

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

  const unsettled = tasks?.some((task) => task.status === 'queued' || task.status === 'running') ?? false;
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

  return (
    <section className="workspace-scroll personal-view">
      <div className="view-heading">
        <div className="view-heading-copy">
          <h1>Personal tasks</h1>
          <span>AgentDeck reads only the folder you choose. No agent sees these files.</span>
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
            {selectedTask && <TaskDetail onRetry={() => void retry(selectedTask)} task={selectedTask} />}
          </div>
        )}
      </section>
    </section>
  );
}
