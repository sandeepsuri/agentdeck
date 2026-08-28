import { useEffect, useMemo, useState } from 'react';
import type { AgentMessage, Conflict, Session } from '../../types.js';
import type { Model } from '../../sessions/model-catalog.js';
import { ElapsedTime, SparkBars, StatusBadge, isEndedSession, repoPathOf, sessionLabel, type WorkspaceView } from './model.js';

interface Props {
  view: WorkspaceView;
  selected: Session | null;
  events: AgentMessage[];
  conflicts: Conflict[];
  onView: (view: WorkspaceView) => void;
  onAction: (session: Session, action: 'stop' | 'restart' | 'focus') => void;
  onRename: (session: Session, name: string) => void;
  onError: (message: string) => void;
}

function Meta({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return <div className="inspector-meta"><span>{label}</span><strong className={mono ? 'mono' : ''}>{value}</strong></div>;
}

function MessageSelected({ session, onError }: { session: Session; onError: (message: string) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/send`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: text.trim() }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) onError(body.error ?? 'Message failed.'); else setText('');
    } catch { onError('Message failed.'); }
    setBusy(false);
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
    fetch('/api/models')
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
    fetch(`/api/sessions/${encodeURIComponent(session.id)}/summary`)
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
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/summarize`, {
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

export function InspectorRail({ view, selected, events, conflicts, onView, onAction, onRename, onError }: Props) {
  const repoConflicts = conflicts.filter((conflict) => selected && conflict.repoId === repoPathOf(selected));
  const recentEvents = useMemo(() => events.slice(-3).reverse(), [events]);
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState('');

  if (view === 'changes') {
    return (
      <aside className="inspector-rail">
        <div className="inspector-section-label">Coordination</div>
        {repoConflicts.length > 0 ? (
          <div className="coordination-card">
            <strong>△ {repoConflicts.length} overlap{repoConflicts.length === 1 ? '' : 's'}</strong>
            {repoConflicts.map((conflict, index) => <Meta key={`${conflict.kind}-${index}`} label={conflict.kind.replaceAll('_', ' ')} mono={false} value={conflict.detail} />)}
            <button className="button attention-button" type="button">Message involved agents</button>
            <button className="button" type="button">Isolate worktree</button>
          </div>
        ) : <div className="rail-empty">No active overlaps in this repository.</div>}
        <div className="inspector-section-label">Selected session</div>
        {selected ? <><Meta label="Agent" value={selected.agent} /><Meta label="Branch" value={selected.branch ?? 'Unknown'} /><Meta label="Directory" value={selected.cwd} /></> : <div className="rail-empty">Select a session.</div>}
      </aside>
    );
  }

  if (view === 'terminal') {
    return (
      <aside className="inspector-rail">
        <div className="inspector-section-label">Session</div>
        {selected ? (
          <>
            <Meta label="Agent" value={selected.agent === 'claude' ? 'Claude Code' : 'Codex CLI'} />
            <div className="inspector-meta"><span>State</span><StatusBadge status={selected.status} /></div>
            <Meta label="PID" value={String(selected.pid ?? '—')} />
            <Meta label="TTY" value={selected.tty ?? (selected.origin === 'managed' ? 'managed PTY' : 'unknown')} />
            <Meta label="Directory" value={selected.cwd} />
            <Meta label="Branch" value={selected.branch ?? 'Unknown'} />
            {isEndedSession(selected) && selected.endedAt && (
              <Meta label="Ended" value={new Date(selected.endedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} />
            )}
            <div className="inspector-section-label inner">Runtime</div>
            <div className="runtime-rail-metric"><span>Activity · <ElapsedTime startedAt={selected.startedAt} /></span><SparkBars count={24} seed={7} /></div>
            <div className="runtime-rail-metric"><span>Session events · {events.filter((event) => event.sessionId === selected.id || event.repo === repoPathOf(selected)).length}</span><SparkBars count={24} seed={9} /></div>
            <div className="inspector-section-label inner">Actions</div>
            {editingName ? (
              <form className="rename-form" onSubmit={(event) => {
                event.preventDefault();
                onRename(selected, name);
                setEditingName(false);
              }}><input autoFocus onChange={(event) => setName(event.target.value)} placeholder={sessionLabel(selected)} value={name} /><button type="submit">Save</button></form>
            ) : <button className="rail-action" onClick={() => { setName(selected.name ?? ''); setEditingName(true); }} type="button">Rename <span>✎</span></button>}
            {selected.origin === 'external' && <button className="rail-action" onClick={() => onAction(selected, 'focus')} type="button">Focus terminal <span>⌖</span></button>}
            {/* Restart and Terminate are live-only actions: an ended session
                has no process to restart in place or stop (ticket 04). */}
            {selected.origin === 'managed' && !isEndedSession(selected) && <button className="rail-action" onClick={() => onAction(selected, 'restart')} type="button">Restart agent <span>↻</span></button>}
            {selected.origin === 'managed' && !isEndedSession(selected) && <button className="rail-action is-danger" onClick={() => onAction(selected, 'stop')} type="button">Terminate session <span>■</span></button>}
            {isEndedSession(selected) && (
              <>
                <div className="rail-empty">This session has ended.</div>
                <div className="inspector-section-label inner">Wrap-up</div>
                <WrapUp onError={onError} session={selected} />
              </>
            )}
          </>
        ) : <div className="rail-empty">Select a session to inspect its runtime.</div>}
      </aside>
    );
  }

  return (
    <aside className="inspector-rail">
      <div className="inspector-section-label">Attention <span>{selected?.status === 'waiting_input' ? 1 : 0}</span></div>
      {selected?.status === 'waiting_input' ? (
        <div className="attention-rail-card">
          <div><span className="attention-square" /><strong>{sessionLabel(selected)}</strong><time>{new Date(selected.lastActivityAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>
          <small>{selected.cwd.split('/').pop()} / {selected.branch ?? 'unknown'}</small>
          <footer><span>Waiting for your response</span><button onClick={() => onView('terminal')} type="button">Respond ↗</button></footer>
        </div>
      ) : <div className="rail-empty">All clear — no prompts waiting.</div>}

      <div className="inspector-section-label">Session inspector</div>
      {selected ? (
        <>
          <Meta label="Agent" value={selected.agent === 'claude' ? 'Claude Code' : 'Codex CLI'} />
          <Meta label="Origin" value={selected.origin} />
          <Meta label="PID" value={String(selected.pid ?? '—')} />
          <Meta label="TTY" value={selected.tty ?? '—'} />
          <Meta label="Worktree" value={selected.cwd.split('/').pop() ?? selected.cwd} />
          <Meta label="Branch" value={selected.branch ?? 'Unknown'} />
          <button className="button open-terminal-button" onClick={() => onView('terminal')} type="button"><span>&gt;_</span> Open in terminal</button>
        </>
      ) : <div className="rail-empty">Select a session to inspect it.</div>}

      <div className="inspector-section-label">Recent signals</div>
      <div className="recent-signals">
        {recentEvents.map((event, index) => (
          <div key={`${event.ts}-${index}`}>
            <span className={`signal-dot signal-${event.event}`} />
            <span><small>{new Date(event.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {event.event}</small><strong>{event.message ?? event.summary ?? event.files?.join(', ') ?? 'Event received'}</strong><em>{event.agent}</em></span>
          </div>
        ))}
        {recentEvents.length === 0 && <div className="rail-empty">No bus events yet.</div>}
      </div>
      <button className="text-button" onClick={() => onView('signals')} type="button">View all signals ↗</button>
      {/* Sending input is a live-only action: an ended session has no
          process left to receive it (ticket 04). */}
      {selected && (isEndedSession(selected)
        ? <div className="rail-empty">This session has ended — it can no longer receive messages.</div>
        : <MessageSelected onError={onError} session={selected} />)}
    </aside>
  );
}
