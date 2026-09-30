// Issue #92: routines — PDF and email requests the owner saved from a task
// that worked, to run again. Each run starts a new task, shown here with where
// it stands; a run that could not start shows why, and a routine whose
// folder or Gmail account was revoked offers one chosen again. Approving a
// move or a send stays on each run's own task.
import { useCallback, useEffect, useState } from 'react';
import type { EmailAccountView } from '../../personal-tasks/email/types.js';
import { REPOINT_CODES, type RoutineKind, type RoutineTaskSource, type RoutineView } from '../../personal-tasks/routines/types.js';
import type { FolderGrantView, PersonalTaskStatus } from '../../personal-tasks/types.js';
import { apiFetch } from '../apiFetch.js';

const POLL_MS = 1500;

const KIND_LABEL: Record<RoutineKind, string> = {
  'pdf-filing-proposal': 'Filing plan for new PDFs',
  'pdf-inventory': 'PDF inventory',
  'email-reply': 'Email reply',
};

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

const send = <T,>(method: string, url: string, payload?: unknown) => request<T>(url, {
  method,
  ...(payload === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
});

const time = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** "Save as routine" on a task that worked: names the routine, then saves it. */
export function SaveRoutine({ source, taskId, defaultName, onSaved }: {
  source: RoutineTaskSource;
  taskId: string;
  defaultName: string;
  onSaved?: (routine: RoutineView) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const routine = await send<RoutineView>('POST', '/api/personal/routines', { name, source, taskId });
      setSaved(routine.name);
      setOpen(false);
      onSaved?.(routine);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="routine-save">
        <button className="button" onClick={() => { setName(defaultName); setOpen(true); }} type="button">Save as routine</button>
        {saved && <span className="personal-note">Saved “{saved}” to Routines.</span>}
      </div>
    );
  }
  return (
    <form className="routine-save" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label>Routine name
        <input maxLength={80} onChange={(event) => setName(event.target.value)} value={name} />
      </label>
      <button className="button button-primary" disabled={busy || !name.trim()} type="submit">{busy ? 'Saving…' : 'Save'}</button>
      <button className="text-button" onClick={() => setOpen(false)} type="button">Cancel</button>
      <p className="personal-note">Each run starts a new task. Moving files or sending mail still waits for your approval on that run.</p>
      {error && <p className="personal-error" role="alert">{error}</p>}
    </form>
  );
}

function Repair({ routine, grants, accounts, onRepoint }: {
  routine: RoutineView;
  grants: FolderGrantView[];
  accounts: EmailAccountView[];
  onRepoint: (targetId: string) => Promise<void>;
}) {
  const email = routine.kind === 'email-reply';
  const choices = email
    ? accounts.filter((account) => !account.revokedAt && account.id !== routine.target.id).map((account) => ({ id: account.id, label: account.address }))
    : grants.filter((grant) => !grant.revokedAt && grant.id !== routine.target.id).map((grant) => ({ id: grant.id, label: `${grant.name} (${grant.displayPath})` }));
  const [chosen, setChosen] = useState(choices[0]?.id ?? '');
  const repointable = routine.repair && REPOINT_CODES.includes(routine.repair.code);
  const current = choices.find((choice) => choice.id === chosen) ?? choices[0];
  return (
    <div className="personal-failure" role="alert">
      <p>{routine.repair!.message}</p>
      {repointable && (current ? (
        <form className="routine-repair" onSubmit={(event) => { event.preventDefault(); void onRepoint(current.id); }}>
          <label>{email ? 'Use account' : 'Use folder'}
            <select onChange={(event) => setChosen(event.target.value)} value={current.id}>
              {choices.map((choice) => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
            </select>
          </label>
          <button className="button" type="submit">Use this {email ? 'account' : 'folder'}</button>
        </form>
      ) : (
        <p className="personal-note">{email ? 'Connect Gmail again under Email replies, then come back here.' : 'Choose the folder again under Folders, then come back here.'}</p>
      ))}
    </div>
  );
}

export function RoutinesPanel({ active = true, refreshSignal = 0, onOpenTask, onRan }: {
  active?: boolean;
  /** Changes whenever a routine may have been saved elsewhere on the page. */
  refreshSignal?: number;
  onOpenTask?: (source: RoutineTaskSource, taskId: string) => void;
  /** After a run starts a task, so the task lists can show it. */
  onRan?: (source: RoutineTaskSource) => void;
}) {
  const [routines, setRoutines] = useState<RoutineView[] | null>(null);
  const [grants, setGrants] = useState<FolderGrantView[]>([]);
  const [accounts, setAccounts] = useState<EmailAccountView[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRoutines(await request<RoutineView[]>('/api/personal/routines'));
      setUnavailable(false);
    } catch {
      setUnavailable(true);
      return;
    }
    // Only needed to offer a replacement folder or account; either list may be off.
    const [nextGrants, nextAccounts] = await Promise.all([
      request<FolderGrantView[]>('/api/personal/grants').catch(() => []),
      request<EmailAccountView[]>('/api/personal/email/accounts').catch(() => []),
    ]);
    setGrants(nextGrants);
    setAccounts(nextAccounts);
  }, []);

  useEffect(() => { if (active) void refresh(); }, [active, refresh, refreshSignal]);

  const unsettled = routines?.some((routine) => routine.runs.some((run) => run.task?.status === 'queued' || run.task?.status === 'running')) ?? false;
  useEffect(() => {
    if (!active || !unsettled) return undefined;
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [active, unsettled, refresh]);

  const act = async (action: () => Promise<void>) => {
    setError(null);
    try { await action(); } catch (caught) { setError((caught as Error).message); }
    await refresh();
  };

  const runRoutine = (routine: RoutineView) => act(async () => {
    setRunning(routine.id);
    try {
      const { run } = await send<{ run: RoutineView['runs'][number] }>('POST', `/api/personal/routines/${encodeURIComponent(routine.id)}/run`);
      if (run.task) {
        onRan?.(run.task.source);
        onOpenTask?.(run.task.source, run.task.id);
      }
    } finally {
      setRunning(null);
    }
  });

  const repoint = (routine: RoutineView, targetId: string) => act(async () => {
    await send('PATCH', `/api/personal/routines/${encodeURIComponent(routine.id)}`, routine.kind === 'email-reply' ? { accountId: targetId } : { grantId: targetId });
  });

  const remove = (routine: RoutineView) => act(async () => {
    await send('DELETE', `/api/personal/routines/${encodeURIComponent(routine.id)}`);
  });

  if (unavailable) return null;
  return (
    <section aria-labelledby="personal-routines" className="home-section">
      <header className="home-section-header"><h2 id="personal-routines">Routines</h2></header>
      {error && <p className="personal-error" role="alert">{error}</p>}
      {routines === null ? null : routines.length === 0 ? (
        <p className="personal-empty">No routines yet. Once a filing plan is carried out or an email reply is sent, choose “Save as routine” on it to run it again later.</p>
      ) : (
        <ul aria-label="Routines" className="routine-list">
          {routines.map((routine) => {
            const last = routine.runs[0];
            const busy = running === routine.id || last?.task?.status === 'queued' || last?.task?.status === 'running';
            return (
              <li className="routine-card" key={routine.id}>
                <header>
                  <div>
                    <strong>{routine.name}</strong>
                    <small>{KIND_LABEL[routine.kind]} · {routine.target.label}{routine.target.revoked ? ' (access revoked)' : ''}</small>
                    {routine.request && <small className="routine-request">“{routine.request}”</small>}
                  </div>
                  <div className="routine-actions">
                    <button className="button button-primary" disabled={busy || (routine.repair !== undefined && REPOINT_CODES.includes(routine.repair.code))} onClick={() => void runRoutine(routine)} type="button">
                      {running === routine.id ? 'Starting…' : 'Run again'}
                    </button>
                    <button aria-label={`Delete routine ${routine.name}`} className="text-button" onClick={() => void remove(routine)} type="button">Delete</button>
                  </div>
                </header>
                {routine.repair && <Repair accounts={accounts} grants={grants} key={`${routine.target.id}-${grants.length}-${accounts.length}`} onRepoint={(id) => repoint(routine, id)} routine={routine} />}
                {routine.runs.length > 0 && (
                  <ol aria-label={`Runs of ${routine.name}`} className="routine-runs">
                    {routine.runs.slice(0, 5).map((run) => (
                      <li className={`is-${run.outcome}`} key={run.id}>
                        <time dateTime={run.at}>{time(run.at)}</time>
                        {run.task ? (
                          <button className="text-button" onClick={() => onOpenTask?.(run.task!.source, run.task!.id)} type="button">
                            {run.task.title} — <span className={`personal-status is-${run.task.status}`}>{STATUS_LABEL[run.task.status]}</span>
                          </button>
                        ) : (
                          <span>Did not start: {run.block?.message}</span>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
                <p className="personal-note">Deleting a routine keeps every task it started.</p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
