import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { ConversationView } from '../../sessions/conversation.js';
import type { AgentMessage, Repo, Session } from '../../types.js';
import type { Model } from '../../sessions/model-catalog.js';
import { deriveActivityTimeline } from '../activityTimeline.js';
import { apiFetch } from '../apiFetch.js';
import { listCollaborators } from '../collaborators.js';
import {
  currentTool, diffTotals, type DiffTotals, isLive, isWorking, needsInput as deriveNeedsInput, planProgress, recentTools,
  type ToolKind,
} from './inspectorModel.js';
import { ElapsedTime, STATUS_LABELS, isEndedSession, repoDisplayName, repoPathOf, sessionLabel } from './model.js';
import type { SessionView } from './TerminalWorkspace.js';

interface Props {
  selected: Session | null;
  onAction: (session: Session, action: 'stop' | 'restart' | 'focus') => void;
  onRename: (session: Session, name: string) => void;
  onError: (message: string) => void;
  /** Permanently removes an ended session (App.tsx's deleteSession → DELETE /api/sessions/:id). Absent means the action is not offered at all. */
  onDelete?: (session: Session) => void;
  /** Durable bus events: the Recent activity fallback when the transcript has no tool calls yet. */
  events?: readonly AgentMessage[];
  repos?: readonly Repo[];
  /** Switches the session's center tab (Conversation, Activity, Terminal). */
  onOpenView?: (view: SessionView, options?: { focusComposer?: boolean }) => void;
  /** Opens Review on the session's repository. */
  onReviewChanges?: (repositoryId: string) => void;
}

const CONVERSATION_POLL_MS = 3000;
const DIFF_POLL_MS = 5000;
const RECENT_LIMIT = 4;

const TOOL_GLYPHS: Record<ToolKind, string> = { command: '>_', edit: '✎', read: '▤', search: '⌕', other: '•' };

function Meta({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return <div className="inspector-meta"><span>{label}</span><strong className={mono ? 'mono' : ''}>{value}</strong></div>;
}

function MessageSelected({ session, onError }: { session: Session; onError: (message: string) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(false);
  const sessionIdRef = useRef(session.id);
  sessionIdRef.current = session.id;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const send = async () => {
    if (!text.trim() || busy) return;
    const sessionId = session.id;
    setBusy(true);
    try {
      const response = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/send`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: text.trim() }),
      });
      const body = await response.json() as { error?: string };
      if (!mountedRef.current || sessionIdRef.current !== sessionId) return;
      if (!response.ok) onError(body.error ?? 'Message failed.'); else setText('');
    } catch {
      if (mountedRef.current && sessionIdRef.current === sessionId) onError('Message failed.');
    } finally {
      if (mountedRef.current && sessionIdRef.current === sessionId) setBusy(false);
    }
  };
  return (
    <div className="rail-message-box">
      <input onChange={(event) => setText(event.target.value)} onKeyDown={(event) => {
        if (event.key === 'Enter') { event.preventDefault(); void send(); }
      }} placeholder="Send to selected session…" value={text} />
      <button disabled={busy || !text.trim()} onClick={() => void send()} type="button">➤</button>
    </div>
  );
}

/**
 * Ticket 11: wrap-up. Manual only — the button is the entire trigger
 * surface for POST /api/sessions/:id/summarize; nothing else in the UI
 * calls that route. Loads any existing stored summary on selection so a
 * reopened session shows it immediately, and shows a busy state on the
 * button while the (potentially slow, real-wall-clock) request is in
 * flight — that in-flight state is the "progress shown" acceptance
 * criterion; no streaming/websocket progress is needed for a one-shot
 * REST call.
 *
 * Ticket 12 extends this same component with a per-summary model
 * override: a select fed by GET /api/models (the runtime-fetched,
 * allowlist-filtered, cached catalog), defaulting to "Use default" — i.e.
 * no `model` in the POST body, which lets SessionManager.summarize() fall
 * back to the stored default (Settings) the way it already does when
 * nothing overrides it. Picking a specific model here affects only this
 * one wrap-up; it is never written back to the stored default.
 */
function WrapUp({ session, onError }: { session: Session; onError: (message: string) => void }) {
  const [summary, setSummary] = useState<string | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [models, setModels] = useState<Model[]>([]);
  const [overrideModel, setOverrideModel] = useState('');

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/models')
      .then((response) => response.json() as Promise<Model[]>)
      .then((body) => { if (!cancelled) setModels(body); })
      .catch(() => { /* the picker just won't offer an override; the default-model wrap-up still works */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setSummary(undefined);
    setFailure(undefined);
    setOverrideModel('');
    apiFetch(`/api/sessions/${encodeURIComponent(session.id)}/summary`)
      .then(async (response) => {
        if (cancelled) return;
        // A 404 here just means no summary has been generated yet — not an
        // error state, nothing to surface.
        if (response.ok) {
          const body = await response.json() as { summary: string };
          if (!cancelled) setSummary(body.summary);
        }
      })
      .catch(() => { /* stored-summary lookup failing quietly is fine; wrap-up still offers to generate one */ })
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [session.id]);

  const wrapUp = async () => {
    setGenerating(true);
    setFailure(undefined);
    try {
      const response = await apiFetch(`/api/sessions/${encodeURIComponent(session.id)}/summarize`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(overrideModel ? { model: overrideModel } : {}),
      });
      const body = await response.json() as { summary?: string; error?: string };
      if (!response.ok) {
        const message = body.error ?? 'Summary failed.';
        setFailure(message);
        onError(message);
      } else if (body.summary) {
        setSummary(body.summary);
      }
    } catch {
      const message = 'Summary failed. Check your connection and try again.';
      setFailure(message);
      onError(message);
    }
    setGenerating(false);
  };

  return (
    <div className="rail-summary">
      {models.length > 0 && (
        <label className="rail-model-override">
          <span>Model</span>
          <select disabled={generating} onChange={(event) => setOverrideModel(event.target.value)} value={overrideModel}>
            <option value="">Use default</option>
            {models.map((model) => (
              <option disabled={!model.available} key={model.id} title={model.unavailableReason} value={model.id}>
                {model.displayName}{model.available ? '' : ' — unavailable'}
              </option>
            ))}
          </select>
        </label>
      )}
      <button className="rail-action" disabled={generating} onClick={() => void wrapUp()} type="button">
        {generating ? 'Summarizing…' : summary ? 'Regenerate summary' : 'Wrap up'}
        <span>{generating ? '⟳' : '✎'}</span>
      </button>
      {failure && <div className="rail-error">{failure} The stored scrollback is unaffected — you can try again.</div>}
      {loaded && summary && <div className="rail-summary-text">{summary}</div>}
      {loaded && !summary && !failure && <div className="rail-empty">No summary yet — press Wrap up to generate one.</div>}
    </div>
  );
}

/** Polls the transcript view and the working-tree diff for the selected session. Live sessions poll; ended ones load once. */
function useInspectorData(session: Session) {
  const [conversation, setConversation] = useState<ConversationView | null>(null);
  const [diff, setDiff] = useState<DiffTotals | null>(null);
  const live = isLive(session);
  const repoPath = repoPathOf(session);

  useEffect(() => {
    let cancelled = false;
    setConversation(null);
    const load = () => apiFetch(`/api/sessions/${encodeURIComponent(session.id)}/conversation`)
      .then(async (response) => {
        if (!response.ok) return;
        const body = await response.json() as ConversationView;
        if (!cancelled && Array.isArray(body.turns)) setConversation(body);
      })
      .catch(() => { /* offline — keep what we have */ });
    void load();
    if (!live) return () => { cancelled = true; };
    const timer = setInterval(() => void load(), CONVERSATION_POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [session.id, session.startedAt, live]);

  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    const load = () => apiFetch(`/api/repos/diff?${new URLSearchParams({ repo: repoPath, mode: 'uncommitted' })}`)
      .then(async (response) => {
        if (!response.ok) return;
        const body = await response.json() as { files?: { path: string; additions: number; deletions: number }[] };
        if (!cancelled && Array.isArray(body.files)) setDiff(diffTotals(body.files));
      })
      .catch(() => { /* the card just stays hidden */ });
    void load();
    if (!live) return () => { cancelled = true; };
    const timer = setInterval(() => void load(), DIFF_POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [repoPath, live]);

  return { conversation, diff };
}

/** Collaborators granted the session's repository; the owner is always "You". */
function useRepositoryCollaborators(repositoryId: string | undefined): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setCount(0);
    if (!repositoryId) return undefined;
    listCollaborators()
      .then((collaborators) => {
        if (!cancelled) setCount(collaborators.filter((collaborator) => collaborator.grantedRepositoryIds.includes(repositoryId)).length);
      })
      .catch(() => { /* shows just "You" */ });
    return () => { cancelled = true; };
  }, [repositoryId]);
  return count;
}

function Wave({ className, bars }: { className: string; bars: number }) {
  return <span aria-hidden="true" className={className}>{Array.from({ length: bars }, (_, index) => <i key={index} />)}</span>;
}

function SectionHeading({ label, trailing }: { label: string; trailing?: ReactNode }) {
  return <div className="inspector-heading"><h3>{label}</h3>{trailing}</div>;
}

function ViewAll({ onClick }: { onClick: () => void }) {
  return <button className="inspector-view-all" onClick={onClick} type="button">View all <span aria-hidden="true">→</span></button>;
}

/** The ⋯ menu: things the panel keeps but no longer leads with. Stays mounted so a Send-to-terminal draft survives closing it. */
function OverflowMenu({ session, onAction, onError }: Pick<Props, 'onAction' | 'onError'> & { session: Session }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) ref.current.open = false;
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <details className="inspector-menu" onToggle={(event) => setOpen(event.currentTarget.open)} ref={ref}>
      <summary aria-label="More session options" title="More">⋯</summary>
      <div className="inspector-menu-panel">
        {session.origin === 'external' && <button className="rail-action" onClick={() => onAction(session, 'focus')} type="button">Focus terminal <span>⌖</span></button>}
        {/* Redesign spec §06: process identity is Advanced details, never default. */}
        <details className="rail-technical-detail">
          <summary>Advanced details</summary>
          <Meta label="Directory" value={session.cwd} />
          <Meta label="Origin" value={session.origin} />
          <Meta label="PID" value={String(session.pid ?? '—')} />
          <Meta label="TTY" value={session.tty ?? (session.origin === 'managed' ? 'managed PTY' : 'unknown')} />
        </details>
        {/* Sending input is a live-only action: an ended session has no
            process left to receive it (ticket 04). */}
        {!isEndedSession(session) && (
          <>
            <div className="inspector-menu-label">Send to terminal</div>
            <MessageSelected key={session.id} onError={onError} session={session} />
          </>
        )}
      </div>
    </details>
  );
}

const formatStarted = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const formatClock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function InspectorRail({ selected, ...props }: Props) {
  if (!selected) return <aside className="inspector-rail"><div className="rail-empty">Select work to inspect it.</div></aside>;
  return <SessionInspector key={selected.id} session={selected} {...props} />;
}

function SessionInspector({
  session, onAction, onRename, onError, onDelete, events = [], repos = [], onOpenView, onReviewChanges,
}: Omit<Props, 'selected'> & { session: Session }) {
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState('');
  const [changesOpen, setChangesOpen] = useState(false);
  const { conversation, diff } = useInspectorData(session);
  const path = repoPathOf(session);
  const repository = repos.find((repo) => repo.id === path || repo.path === path);
  const collaborators = useRepositoryCollaborators(repository?.id);

  const ended = isEndedSession(session);
  const live = isLive(session);
  const input = deriveNeedsInput(session, conversation);
  const working = isWorking(session, input);
  const turns = conversation?.turns ?? [];
  const now = live ? currentTool(turns) : null;
  const progress = planProgress(conversation?.plan);
  const agentName = session.agent === 'claude' ? 'Claude Code' : 'Codex CLI';
  const subtitle = (live && progress?.current?.activeForm) || progress?.current?.label || sessionLabel(session);
  const pill = input ? { tone: 'is-attention', label: 'Needs input' }
    : working ? { tone: 'is-working', label: 'Working' }
    : { tone: `status-${session.status}`, label: ended ? 'Ended' : STATUS_LABELS[session.status] };

  const tools = recentTools(turns, RECENT_LIMIT);
  const recent = tools.length > 0
    ? tools.map((tool, index) => ({ id: tool.id, at: tool.at, glyph: TOOL_GLYPHS[tool.kind], tone: `tool-${tool.kind}`,
      label: index === 0 && now?.id === tool.id && working ? tool.present : tool.past, detail: tool.detail }))
    : deriveActivityTimeline(events, session).slice(-RECENT_LIMIT).reverse().map((entry) => ({
      id: entry.id, at: entry.at, glyph: '•', tone: `verb-${entry.verb}`, label: entry.label, detail: entry.detail ?? '',
    }));

  const openView = (view: SessionView, options?: { focusComposer?: boolean }) => onOpenView?.(view, options);

  return (
    <aside className={`inspector-rail inspector-session${working ? ' is-live-working' : ''}${input ? ' is-needs-input' : ''}`}>
      <header className="inspector-header">
        <span aria-hidden="true" className={`inspector-agent-mark is-${session.agent}`}>{session.agent === 'claude' ? '✳' : '◎'}</span>
        <div className="inspector-title">
          <div className="inspector-title-row">
            <strong>{agentName}</strong>
            <span className={`inspector-status-pill ${pill.tone}`}><i aria-hidden="true" />{pill.label}</span>
            {live && <span className="inspector-elapsed" title={`Started ${formatStarted(session.startedAt)}`}><span aria-hidden="true">◷</span> <ElapsedTime startedAt={session.startedAt} /></span>}
          </div>
          <p className="inspector-subtitle" title={subtitle}>{subtitle}</p>
        </div>
        <OverflowMenu onAction={onAction} onError={onError} session={session} />
      </header>

      {ended ? (
        <section className="inspector-section">
          <div className="rail-empty">This session has ended.</div>
          <SectionHeading label="Wrap-up" />
          <WrapUp onError={onError} session={session} />
        </section>
      ) : (
        <>
          <section className="inspector-section">
            <SectionHeading label="Current activity" trailing={onOpenView && <ViewAll onClick={() => openView('activity')} />} />
            <div className="inspector-card inspector-now">
              <span aria-hidden="true" className="inspector-now-glyph">{now ? TOOL_GLYPHS[now.kind] : input ? '?' : '>_'}</span>
              <div className="inspector-now-copy">
                <strong>{now ? now.present : input ? 'Waiting for you' : working ? 'Thinking' : 'Idle'}</strong>
                {now?.detail && <code title={now.detail}>{now.detail}</code>}
              </div>
              <Wave bars={6} className="activity-wave" />
            </div>
          </section>

          {progress && (
            <section className="inspector-section">
              <SectionHeading label="Progress" trailing={<span className="inspector-count">{progress.done}/{progress.total}</span>} />
              <div aria-label={`${progress.done} of ${progress.total} steps done`} aria-valuemax={progress.total} aria-valuemin={0} aria-valuenow={progress.done} className="inspector-progress" role="progressbar">
                <i style={{ width: `${(progress.done / progress.total) * 100}%` }} />
              </div>
              <ol className="inspector-steps">
                {progress.steps.map((step, index) => (
                  <li className={`inspector-step is-${step.status}`} key={`${index}:${step.label}`}>
                    <span aria-hidden="true" className="inspector-step-mark" />
                    <span className="inspector-step-label">{step.label}</span>
                    <span className="sr-only">{step.status === 'completed' ? ' (done)' : step.status === 'in_progress' ? ' (in progress)' : ''}</span>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {input && (
            <section aria-label="Needs input" className="inspector-needs-input" role="status">
              <span aria-hidden="true" className="inspector-needs-icon">✦</span>
              <div className="inspector-needs-body">
                <div className="inspector-needs-title"><strong>Needs input</strong><span className="inspector-needs-count">{input.count}</span></div>
                <p>{input.text}</p>
                {onOpenView && (
                  <div className="inspector-needs-actions">
                    <button className="inspector-needs-primary" onClick={() => openView(input.hasQuestion ? 'conversation' : 'terminal')} type="button">View question</button>
                    <button className="inspector-needs-secondary" onClick={() => openView(input.hasQuestion ? 'conversation' : 'terminal', { focusComposer: true })} type="button">Reply now</button>
                  </div>
                )}
              </div>
            </section>
          )}
        </>
      )}

      {diff && diff.files.length > 0 && (
        <section className="inspector-section">
          <SectionHeading label="Changes made" />
          <div className="inspector-card inspector-changes">
            <button aria-expanded={changesOpen} className="inspector-changes-summary" onClick={() => setChangesOpen((current) => !current)} type="button">
              <span aria-hidden="true" className="inspector-file-glyph">▢</span>
              <span className="inspector-changes-label">{diff.files.length} file{diff.files.length === 1 ? '' : 's'} changed</span>
              <span className="diff-add">+{diff.additions}</span>
              <span className="diff-del">−{diff.deletions}</span>
              <span aria-hidden="true" className={`inspector-chevron${changesOpen ? ' is-open' : ''}`}>›</span>
            </button>
            {changesOpen && (
              <div className="inspector-changes-detail">
                <ul>
                  {diff.files.map((file) => (
                    <li key={file.path}>
                      <code title={file.path}>{file.path}</code>
                      <span className="diff-add">+{file.additions}</span>
                      <span className="diff-del">−{file.deletions}</span>
                    </li>
                  ))}
                </ul>
                {repository && onReviewChanges && (
                  <button className="inspector-view-all" onClick={() => onReviewChanges(repository.id)} type="button">Review changes <span aria-hidden="true">→</span></button>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      {recent.length > 0 && (
        <section className="inspector-section">
          <SectionHeading label="Recent activity" trailing={onOpenView && <ViewAll onClick={() => openView('activity')} />} />
          <ol className="inspector-recent">
            {recent.map((row) => (
              <li className={row.tone} key={row.id}>
                <time dateTime={row.at}>{formatClock(row.at)}</time>
                <span aria-hidden="true" className="inspector-recent-glyph">{row.glyph}</span>
                <span className="inspector-recent-copy"><strong>{row.label}</strong>{row.detail && <code title={row.detail}>{row.detail}</code>}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="inspector-section">
        <SectionHeading label="Session info" />
        <dl className="inspector-info">
          <div><dt>Repository</dt><dd title={path}>{repoDisplayName(session, repos)}</dd></div>
          <div><dt>Branch</dt><dd className="mono" title={session.branch}>{session.branch ?? 'Unknown'}</dd></div>
          <div><dt>Agent</dt><dd>{agentName}</dd></div>
          <div><dt>Started</dt><dd>{formatStarted(session.startedAt)}</dd></div>
          {ended && session.endedAt && <div><dt>Ended</dt><dd>{formatStarted(session.endedAt)}</dd></div>}
          <div className="is-wide"><dt>Collaborators</dt><dd><span aria-hidden="true" className="inspector-avatar">Y</span>You{collaborators > 0 ? ` + ${collaborators}` : ''}</dd></div>
        </dl>
      </section>

      <footer className="inspector-actions">
        {editingName ? (
          <form className="rename-form" onSubmit={(event) => {
            event.preventDefault();
            onRename(session, name);
            setEditingName(false);
          }}>
            <input autoFocus onChange={(event) => setName(event.target.value)} placeholder={sessionLabel(session)} value={name} />
            <button type="submit">Save</button>
            <button onClick={() => setEditingName(false)} type="button">Cancel</button>
          </form>
        ) : (
          <>
            {/* Restart and Terminate are live-only actions: an ended session
                has no process to restart in place or stop (ticket 04). */}
            {session.origin === 'managed' && !ended && <button className="inspector-action" onClick={() => onAction(session, 'restart')} type="button"><span aria-hidden="true">↻</span>Restart agent</button>}
            <button className="inspector-action" onClick={() => { setName(session.name ?? ''); setEditingName(true); }} type="button"><span aria-hidden="true">✎</span>Rename</button>
            {session.origin === 'managed' && !ended && <button className="inspector-action is-danger" onClick={() => onAction(session, 'stop')} type="button"><span aria-hidden="true">■</span>Terminate session</button>}
            {ended && onDelete && (
              <button
                className="inspector-action is-danger"
                onClick={() => {
                  if (window.confirm(`Delete "${sessionLabel(session)}" permanently? Its transcript and summary will be removed. This cannot be undone.`)) {
                    onDelete(session);
                  }
                }}
                type="button"
              >
                <span aria-hidden="true">×</span>Delete session
              </button>
            )}
          </>
        )}
      </footer>
    </aside>
  );
}
