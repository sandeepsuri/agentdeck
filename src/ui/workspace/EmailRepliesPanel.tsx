// Issue #88: find an email and prepare an editable reply. The owner connects
// one Gmail account on this Mac, asks in their own words, confirms which
// found message they mean from headers and text AgentDeck read itself, and
// edits the reply draft AgentDeck wrote to Gmail. Every save is a durable
// version showing exactly what Gmail holds. Nothing here sends mail.
import { useCallback, useEffect, useState } from 'react';
import type { EmailAccountView, EmailMessageContext, EmailTaskView, ReplyDraftVersionView } from '../../personal-tasks/email/types.js';
import { apiFetch } from '../apiFetch.js';

const POLL_MS = 1500;

const STATUS_LABEL: Record<EmailTaskView['status'], string> = {
  queued: 'Queued',
  running: 'Searching',
  completed: 'Found',
  failed: 'Needs attention',
};

const ACCOUNT_LABEL: Record<EmailAccountView['state'], string> = {
  ready: 'Connected',
  unchecked: 'Not checked',
  'signed-out': 'Signed out',
  'missing-scope': 'Missing permission',
  unsupported: 'Not supported',
  'no-client': 'Not set up',
  unreachable: 'Unreachable',
  'check-failed': 'Check failed',
};

const DRAFT_LABEL: Record<ReplyDraftVersionView['state'], string> = {
  writing: 'Saving to Gmail…',
  saved: 'Saved in Gmail',
  failed: 'Not saved',
  uncertain: 'Checking Gmail',
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

const time = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const lines = (value: string) => value.split(/\n|,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((entry) => entry.trim()).filter(Boolean);
const bare = (address: string) => (/<([^>]+)>/.exec(address)?.[1] ?? address).trim().toLowerCase();

function MessageCard({ message, suggested }: { message: EmailMessageContext; suggested?: boolean }) {
  const elsewhere = message.replyTo && bare(message.replyTo) !== bare(message.from);
  return (
    <div className="email-message">
      <dl className="personal-task-meta">
        <div><dt>From</dt><dd>{message.from}</dd></div>
        {message.replyTo && <div><dt>Reply-To</dt><dd>{message.replyTo}</dd></div>}
        <div><dt>To</dt><dd>{message.to.join(', ') || '—'}</dd></div>
        {message.cc.length > 0 && <div><dt>Cc</dt><dd>{message.cc.join(', ')}</dd></div>}
        {message.date && <div><dt>Date</dt><dd>{message.date}</dd></div>}
        <div><dt>Subject</dt><dd>{message.subject || '(no subject)'}{suggested ? <span className="email-suggested">Suggested</span> : null}</dd></div>
      </dl>
      {elsewhere && <p className="email-warning">Replies go to {message.replyTo}, not the sender&apos;s address.</p>}
      <blockquote className="email-excerpt">{message.excerpt || '(No text.)'}{message.excerptTruncated ? ' …' : ''}</blockquote>
    </div>
  );
}

function DraftEditor({ task, onSave, onCheck }: {
  task: EmailTaskView;
  onSave: (fields: { baseVersion: number; to: string[]; cc: string[]; subject: string; body: string }) => Promise<void>;
  onCheck: () => Promise<void>;
}) {
  const latest = task.drafts[0];
  const shown = task.drafts.find((draft) => draft.state === 'saved') ?? latest;
  const [to, setTo] = useState(shown?.content.to.join('\n') ?? '');
  const [cc, setCc] = useState(shown?.content.cc.join('\n') ?? '');
  const [subject, setSubject] = useState(shown?.content.subject ?? (task.confirmed ? `Re: ${task.confirmed.subject}` : ''));
  const [body, setBody] = useState(shown?.content.body ?? '');
  const [busy, setBusy] = useState(false);
  const unsettled = latest && (latest.state === 'writing' || latest.state === 'uncertain');

  // Take the newest saved version whenever it changes (a save, or a change made in Gmail).
  useEffect(() => {
    if (!shown) return;
    setTo(shown.content.to.join('\n'));
    setCc(shown.content.cc.join('\n'));
    setSubject(shown.content.subject);
    setBody(shown.content.body);
  }, [shown?.version, shown?.state]);

  const save = async () => {
    setBusy(true);
    try {
      await onSave({ baseVersion: latest?.version ?? 0, to: lines(to), cc: lines(cc), subject, body });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Reply draft" className="email-draft">
      <h4>Reply draft</h4>
      {shown && (
        <div className="email-exact" aria-label="Exactly what Gmail holds">
          <p className="personal-note">
            <span className={`email-draft-state is-${shown.state}`}>{DRAFT_LABEL[shown.state]}</span>
            {' '}Version {shown.version}{shown.digest ? <> · <code title={shown.digest}>{shown.digest.slice(0, 12)}</code></> : null}
            {shown.origin === 'gmail' ? ' · changed in Gmail' : ''}
          </p>
          <dl className="personal-task-meta">
            <div><dt>To</dt><dd>{shown.content.to.join(', ') || '—'}</dd></div>
            <div><dt>Cc</dt><dd>{shown.content.cc.join(', ') || '—'}</dd></div>
            <div><dt>Subject</dt><dd>{shown.content.subject}</dd></div>
            <div><dt>Attachments</dt><dd>{shown.content.attachments.length ? shown.content.attachments.map((file) => `${file.name} (${file.size} B)`).join(', ') : 'None'}</dd></div>
          </dl>
          <pre className="email-body">{shown.content.body || '(empty)'}</pre>
        </div>
      )}
      {latest && latest !== shown && latest.reason && <p className="email-warning" role="status">Version {latest.version}: {DRAFT_LABEL[latest.state]}. {latest.reason}</p>}
      {latest?.state === 'failed' && latest === shown && latest.reason && <p className="email-warning" role="status">{latest.reason}</p>}
      <form className="email-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label>To <small>one address per line</small><textarea onChange={(event) => setTo(event.target.value)} rows={2} value={to} /></label>
        <label>Cc<textarea onChange={(event) => setCc(event.target.value)} rows={1} value={cc} /></label>
        <label>Subject<input onChange={(event) => setSubject(event.target.value)} type="text" value={subject} /></label>
        <label>Message<textarea onChange={(event) => setBody(event.target.value)} rows={8} value={body} /></label>
        <div className="personal-pdf-actions">
          <button className="button button-primary" disabled={busy || Boolean(unsettled)} type="submit">{busy ? 'Saving…' : latest ? 'Save draft' : 'Write draft to Gmail'}</button>
          <button className="button" disabled={busy} onClick={() => void onCheck()} type="button">Check Gmail</button>
        </div>
      </form>
      <p className="personal-note">Saving updates the draft in Gmail and keeps every version here. Nothing is sent; sending needs its own approval.</p>
      {task.drafts.length > 1 && (
        <details>
          <summary>Earlier versions</summary>
          <ol className="email-versions">
            {task.drafts.slice(1).map((draft) => (
              <li key={draft.version}>
                <strong>v{draft.version}</strong> {DRAFT_LABEL[draft.state]} · {draft.origin === 'gmail' ? 'changed in Gmail' : `${draft.createdBy.displayName} on ${draft.createdBy.device}`} · {time(draft.createdAt)}
                {draft.reason ? <small> — {draft.reason}</small> : null}
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}

function EmailTaskDetail({ task, onRetry, onConfirm, onSave, onCheck }: {
  task: EmailTaskView;
  onRetry: () => void;
  onConfirm: (messageId: string) => Promise<void>;
  onSave: (fields: { baseVersion: number; to: string[]; cc: string[]; subject: string; body: string }) => Promise<void>;
  onCheck: () => Promise<void>;
}) {
  const candidates = task.result?.candidates ?? [];
  const [chosen, setChosen] = useState<string | undefined>(task.result?.proposedMessageId ?? candidates[0]?.id);
  const [confirming, setConfirming] = useState(false);
  const selected = candidates.find((candidate) => candidate.id === chosen);

  const confirm = async () => {
    if (!chosen) return;
    setConfirming(true);
    try { await onConfirm(chosen); } finally { setConfirming(false); }
  };

  return (
    <article aria-labelledby={`email-task-${task.id}`} className="personal-task-detail">
      <header>
        <h3 id={`email-task-${task.id}`}>{task.title}</h3>
        <span className={`personal-status is-${task.status}`}>{STATUS_LABEL[task.status]}</span>
      </header>
      <dl className="personal-task-meta">
        <div><dt>You asked</dt><dd>{task.request}</dd></div>
        <div><dt>Account</dt><dd>{task.account.address}{task.account.revoked ? ' (access revoked)' : ''}</dd></div>
        <div><dt>Requested by</dt><dd>{task.submittedBy.displayName} on {task.submittedBy.device}</dd></div>
        <div><dt>Rules</dt><dd>{task.policyVersion}</dd></div>
      </dl>

      {task.failure && (
        <div className="personal-failure" role="alert">
          <p>{task.failure}</p>
          {task.status === 'failed' && !task.confirmed && <button className="button" onClick={onRetry} type="button">Try again</button>}
        </div>
      )}

      {task.confirmed ? (
        <>
          <section aria-label="Answering">
            <h4>Answering{task.confirmedBy ? ` · confirmed by ${task.confirmedBy.displayName} on ${task.confirmedBy.device}` : ''}</h4>
            <MessageCard message={task.confirmed} />
          </section>
          <DraftEditor key={task.id} onCheck={onCheck} onSave={onSave} task={task} />
        </>
      ) : task.result && (
        candidates.length === 0 ? <p className="personal-empty">No matching email was found. Ask again with other words.</p> : (
          <section aria-label="Confirm the email" className="email-candidates">
            <h4>Which email do you mean?</h4>
            <ul>
              {candidates.map((candidate) => (
                <li key={candidate.id}>
                  <label>
                    <input checked={candidate.id === chosen} name={`email-${task.id}`} onChange={() => setChosen(candidate.id)} type="radio" />
                    <span><strong>{candidate.subject || '(no subject)'}</strong> — {candidate.from}{candidate.date ? ` · ${candidate.date}` : ''}</span>
                  </label>
                </li>
              ))}
            </ul>
            {selected && <MessageCard message={selected} suggested={selected.id === task.result.proposedMessageId} />}
            {selected && selected.id === task.result.proposedMessageId && task.result.suggestedBody && (
              <p className="personal-note">Suggested reply: “{task.result.suggestedBody}”</p>
            )}
            <button className="button button-primary" disabled={!selected || confirming} onClick={() => void confirm()} type="button">
              {confirming ? 'Preparing…' : 'This is the email — prepare a reply draft'}
            </button>
            <p className="personal-note">AgentDeck addresses the reply to this message&apos;s sender and writes it to your Gmail drafts for you to edit. Nothing is sent.</p>
          </section>
        )
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

export function EmailRepliesPanel({ active = true }: { active?: boolean }) {
  const [accounts, setAccounts] = useState<EmailAccountView[] | null>(null);
  const [tasks, setTasks] = useState<EmailTaskView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [asking, setAsking] = useState(false);
  const [words, setWords] = useState('');
  const [accountId, setAccountId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextAccounts, nextTasks] = await Promise.all([
        request<EmailAccountView[]>('/api/personal/email/accounts'),
        request<EmailTaskView[]>('/api/personal/email/tasks'),
      ]);
      setAccounts(nextAccounts);
      setTasks(nextTasks);
      setLoadError(null);
    } catch (caught) {
      setLoadError((caught as Error).message);
    }
  }, []);

  useEffect(() => { if (active) void refresh(); }, [active, refresh]);

  const unsettled = tasks?.some((task) => task.status === 'queued' || task.status === 'running'
    || task.drafts[0]?.state === 'writing' || task.drafts[0]?.state === 'uncertain') ?? false;
  useEffect(() => {
    if (!active || !unsettled) return undefined;
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [active, unsettled, refresh]);

  const run = async (action: () => Promise<void>) => {
    setError(null);
    try { await action(); } catch (caught) { setError((caught as Error).message); }
  };

  const activeAccounts = (accounts ?? []).filter((account) => !account.revokedAt);
  const askAccount = activeAccounts.find((account) => account.id === accountId) ?? activeAccounts[0];
  const selectedTask = tasks?.find((task) => task.id === selectedTaskId) ?? tasks?.[0];

  const connect = () => run(async () => {
    setConnecting(true);
    try {
      await post('/api/personal/email/accounts/connect');
      await refresh();
    } finally {
      setConnecting(false);
    }
  });

  const ask = () => run(async () => {
    if (!askAccount) return;
    setAsking(true);
    try {
      const task = await post<EmailTaskView>('/api/personal/email/tasks', { accountId: askAccount.id, request: words });
      setWords('');
      setSelectedTaskId(task.id);
      await refresh();
    } finally {
      setAsking(false);
    }
  });

  const perform = (url: string, payload?: unknown) => run(async () => {
    await post(url, payload);
    await refresh();
  });

  return (
    <section aria-labelledby="email-replies" className="home-section">
      <header className="home-section-header">
        <h2 id="email-replies">Email replies</h2>
        <button className="button" disabled={connecting} onClick={() => void connect()} type="button">
          {connecting ? 'Finish connecting in your browser…' : 'Connect Gmail…'}
        </button>
      </header>
      <p className="personal-note">
        Connecting opens Google in your browser; expect a “Google hasn’t verified this app” screen during the pilot, and keep both permissions ticked.
        An agent searches only the account you connect, through AgentDeck, and never chooses who a reply goes to. Nothing is sent from here.
      </p>
      {(error || loadError) && <p className="personal-error" role="alert">{error ?? `Email replies are unavailable: ${loadError}`}</p>}

      {accounts !== null && accounts.length > 0 && (
        <ul className="personal-grants" aria-label="Gmail accounts">
          {accounts.map((account) => (
            <li className={account.revokedAt ? 'is-revoked' : ''} key={account.id}>
              <div className="personal-grant-open">
                <strong>{account.address}</strong>
                <small>{account.revokedAt ? 'Access revoked' : `${ACCOUNT_LABEL[account.state]}${account.repair ? ` — ${account.repair}` : ''}`}</small>
              </div>
              {!account.revokedAt && (
                <>
                  <button className="text-button" onClick={() => void perform(`/api/personal/email/accounts/${encodeURIComponent(account.id)}/check`)} type="button">Check</button>
                  <button aria-label={`Revoke access to ${account.address}`} className="text-button" onClick={() => void perform(`/api/personal/email/accounts/${encodeURIComponent(account.id)}/revoke`)} type="button">Revoke access</button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {askAccount && (
        <form className="email-form" onSubmit={(event) => { event.preventDefault(); void ask(); }}>
          {activeAccounts.length > 1 && (
            <label>Account
              <select onChange={(event) => setAccountId(event.target.value)} value={askAccount.id}>
                {activeAccounts.map((account) => <option key={account.id} value={account.id}>{account.address}</option>)}
              </select>
            </label>
          )}
          <label>Which email, and what should the reply say?
            <textarea maxLength={1000} onChange={(event) => setWords(event.target.value)} placeholder="The email from Pat about the lease renewal. Say I’ll sign by Friday." rows={2} value={words} />
          </label>
          <div className="personal-pdf-actions">
            <button className="button button-primary" disabled={asking || !words.trim()} type="submit">{asking ? 'Asking…' : 'Find email'}</button>
          </div>
        </form>
      )}

      {tasks !== null && tasks.length > 0 && (
        <div className="personal-task-layout">
          <ul aria-label="Email replies" className="personal-task-list">
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
            <EmailTaskDetail
              key={selectedTask.id}
              onCheck={() => perform(`/api/personal/email/tasks/${encodeURIComponent(selectedTask.id)}/draft/check`)}
              onConfirm={(messageId) => perform(`/api/personal/email/tasks/${encodeURIComponent(selectedTask.id)}/confirm`, { messageId })}
              onRetry={() => void perform(`/api/personal/email/tasks/${encodeURIComponent(selectedTask.id)}/retry`)}
              onSave={(fields) => perform(`/api/personal/email/tasks/${encodeURIComponent(selectedTask.id)}/draft`, fields)}
              task={selectedTask}
            />
          )}
        </div>
      )}
    </section>
  );
}
