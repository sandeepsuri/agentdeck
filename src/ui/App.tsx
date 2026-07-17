import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentMessage, Conflict, Repo, Session, SessionOrigin, SessionStatus } from '../types.js';
import type { ServerFrame } from '../protocol.js';
import { DiffPanel } from './components/DiffPanel.js';
import { LaunchModal } from './components/LaunchModal.js';
import { Terminal } from './components/Terminal.js';
import {
  conversationFor,
  filterSessions,
  groupSessions,
  type GroupBy,
  type SessionFilters,
} from './selectors.js';

const STATUS_COLORS: Record<SessionStatus, string> = {
  starting: '#d29922',
  working: '#3fb950',
  waiting_input: '#f0883e',
  idle: '#8b949e',
  completed: '#58a6ff',
  exited: '#6e7681',
  unknown: '#6e7681',
};

const STATUSES: SessionStatus[] = [
  'starting', 'working', 'waiting_input', 'idle', 'completed', 'exited', 'unknown',
];

function relativeTime(iso: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (seconds < 10) return 'now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function SessionNameEditor({ session, onSave }: {
  session: Session;
  onSave: (session: Session, name: string) => Promise<void>;
}) {
  const fallback = `${session.agent} · ${session.cwd.split('/').pop() ?? session.cwd}`;
  const [value, setValue] = useState(session.name ?? '');
  useEffect(() => setValue(session.name ?? ''), [session.name]);

  return (
    <input
      aria-label={`Session name for ${session.id}`}
      onBlur={() => void onSave(session, value)}
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          setValue(session.name ?? '');
          event.currentTarget.blur();
        }
      }}
      placeholder={fallback}
      style={styles.nameInput}
      title="Click to edit session label"
      value={value}
    />
  );
}

export function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showLaunch, setShowLaunch] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [terminalHint, setTerminalHint] = useState<string | null>(null);
  const [vscodeStatus, setVsCodeStatus] = useState({ connected: false, windows: 0, terminals: 0, installable: false });
  const [events, setEvents] = useState<AgentMessage[]>([]);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [wsReady, setWsReady] = useState(false);
  const [filters, setFilters] = useState<SessionFilters>({});
  const [detailTab, setDetailTab] = useState<'main' | 'changes'>('main');
  const [changeCount, setChangeCount] = useState<number | null>(null);
  const [expandedRepoChanges, setExpandedRepoChanges] = useState<Set<string>>(new Set());
  const [groupBy, setGroupBy] = useState<GroupBy>('repo');
  const [now, setNow] = useState(Date.now());
  const wsRef = useRef<WebSocket | null>(null);
  const filterRef = useRef<HTMLInputElement | null>(null);

  const removeSession = useCallback((sessionId: string) => {
    setSessions((current) => current.filter((item) => item.id !== sessionId));
    setSelectedId((current) => (current === sessionId ? null : current));
  }, []);

  const upsertSession = useCallback((session: Session) => {
    setSessions((current) => {
      const index = current.findIndex((item) => item.id === session.id);
      if (index === -1) return [session, ...current];
      const next = [...current];
      next[index] = session;
      return next;
    });
  }, []);

  const refresh = useCallback(() => {
    fetch('/api/sessions')
      .then((response) => response.json())
      .then(setSessions)
      .catch(() => setError('AgentDeck API is unreachable.'));
  }, []);

  const refreshRepos = useCallback(() => {
    fetch('/api/repos')
      .then((response) => response.json())
      .then(setRepos)
      .catch(() => undefined);
  }, []);

  const refreshEvents = useCallback(() => {
    fetch('/api/events').then((response) => response.json()).then(setEvents).catch(() => undefined);
  }, []);
  const refreshConflicts = useCallback(() => {
    fetch('/api/conflicts').then((response) => response.json()).then(setConflicts).catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
    refreshRepos();
    refreshEvents();
    refreshConflicts();
    const clock = setInterval(() => setNow(Date.now()), 30_000);
    const refreshTerminalHint = () => {
      fetch('/api/terminals/status')
        .then((response) => response.json())
        .then((body: { automationHint?: string }) => setTerminalHint(body.automationHint ?? null))
        .catch(() => undefined);
    };
    const refreshVsCodeStatus = () => {
      fetch('/api/integrations/vscode/status')
        .then((response) => response.json())
        .then(setVsCodeStatus)
        .catch(() => undefined);
    };
    refreshTerminalHint();
    refreshVsCodeStatus();
    const terminalStatus = setInterval(refreshTerminalHint, 5000);
    const vscodeIntegrationStatus = setInterval(refreshVsCodeStatus, 5000);
    return () => {
      clearInterval(clock);
      clearInterval(terminalStatus);
      clearInterval(vscodeIntegrationStatus);
    };
  }, [refresh, refreshConflicts, refreshEvents, refreshRepos]);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout>;
    let disposed = false;
    const connect = () => {
      if (disposed) return;
      socket = new WebSocket(`ws://${location.host}/ws`);
      wsRef.current = socket;
      socket.addEventListener('open', () => {
        setWsReady(true);
        refresh();
      });
      socket.addEventListener('message', (event) => {
        const frame = JSON.parse(String(event.data)) as ServerFrame;
        if (frame.t === 'session_update') { upsertSession(frame.session); void refreshConflicts(); }
        if (frame.t === 'session_removed') { removeSession(frame.sessionId); void refreshConflicts(); }
        if (frame.t === 'agent_event') { setEvents((current) => [...current.slice(-49), frame.event]); void refreshConflicts(); }
      });
      socket.addEventListener('close', () => {
        setWsReady(false);
        if (!disposed) retry = setTimeout(connect, 1000);
      });
    };
    connect();
    return () => {
      disposed = true;
      clearTimeout(retry);
      socket?.close();
    };
  }, [refresh, refreshConflicts, removeSession, upsertSession]);

  const visibleSessions = useMemo(() => filterSessions(sessions, filters), [filters, sessions]);
  const groups = useMemo(
    () => groupSessions(visibleSessions, groupBy, repos),
    [groupBy, repos, visibleSessions],
  );
  const selected = useMemo(
    () => sessions.find((session) => session.id === selectedId) ?? null,
    [selectedId, sessions],
  );
  const repoNames = useMemo(() => new Map(repos.map((repo) => [repo.id, repo.name])), [repos]);

  useEffect(() => {
    setDetailTab('main');
    setChangeCount(null);
  }, [selectedId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.tagName === 'SELECT';
      if (event.key === '/' && !typing) {
        event.preventDefault();
        filterRef.current?.focus();
      }
      if (!typing && /^[1-9]$/.test(event.key)) {
        const session = visibleSessions[Number(event.key) - 1];
        if (session) setSelectedId(session.id);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [visibleSessions]);

  const action = async (session: Session, actionName: 'stop' | 'restart' | 'focus') => {
    setError(null);
    const response = await fetch(`/api/sessions/${session.id}/${actionName}`, { method: 'POST' });
    const body = await response.json() as Session & { error?: string };
    if (!response.ok) {
      setError(body.error ?? `${actionName} failed`);
      return;
    }
    // stop removes the session; the ws session_removed frame updates the list
    if (actionName === 'restart') upsertSession(body);
  };

  const rename = async (session: Session, name: string) => {
    const trimmed = name.trim();
    if (trimmed === (session.name ?? '')) return;
    const response = await fetch(`/api/sessions/${session.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: trimmed }),
    });
    const body = await response.json() as Session & { error?: string };
    if (!response.ok) setError(body.error ?? 'Rename failed');
    else upsertSession(body);
  };

  const configureHooks = async (mode: 'install' | 'uninstall') => {
    const repo = repos.find((item) => item.id === selected?.repoId)
      ?? repos.find((item) => item.id === filters.repo)
      ?? repos[0];
    if (!repo) return setError('No repository is available for hook installation.');
    const response = await fetch(`/api/hooks/${mode}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath: repo.path, user: true }),
    });
    const body = await response.json() as { error?: string; restartRequired?: boolean };
    setError(response.ok
      ? `Hooks ${mode === 'install' ? 'installed' : 'removed'} for ${repo.name}. Restart active Claude/Codex sessions to apply the change.`
      : (body.error ?? `${mode} failed`));
  };

  const installVsCodeHelper = async () => {
    const response = await fetch('/api/integrations/vscode/install', { method: 'POST' });
    const body = await response.json() as { error?: string; reloadRequired?: boolean };
    setError(response.ok
      ? 'VS Code helper installed. Reload each VS Code window once to connect it to AgentDeck.'
      : (body.error ?? 'VS Code helper installation failed.'));
  };

  const setFilter = <K extends keyof SessionFilters>(key: K, value: SessionFilters[K]) => {
    setFilters((current) => ({ ...current, [key]: value || undefined }));
  };

  const toggleRepoChanges = (repoId: string) => {
    setExpandedRepoChanges((current) => {
      const next = new Set(current);
      if (next.has(repoId)) next.delete(repoId);
      else next.add(repoId);
      return next;
    });
  };

  return (
    <div style={styles.shell}>
      <header style={styles.topbar}>
        <div><strong style={styles.logo}>AgentDeck</strong><span style={styles.subtitle}>local agent control plane</span></div>
        <div style={styles.topActions}>
          <span style={{ ...styles.connection, color: wsReady ? '#3fb950' : '#f0883e' }}>{wsReady ? '● live' : '● reconnecting'}</span>
          <button onClick={() => setShowLaunch(true)} style={styles.launchButton}>＋ Launch agent</button>
          <button onClick={() => void configureHooks('install')} style={styles.secondaryButton}>Install hooks</button>
          <button onClick={() => void configureHooks('uninstall')} style={styles.secondaryButton}>Remove hooks</button>
          <button
            disabled={vscodeStatus.connected}
            onClick={() => void installVsCodeHelper()}
            style={styles.secondaryButton}
            title={vscodeStatus.connected ? `${vscodeStatus.terminals} VS Code terminal(s) connected` : 'Install the bundled VS Code terminal helper'}
          >{vscodeStatus.connected ? `VS Code connected (${vscodeStatus.terminals})` : 'Install VS Code helper'}</button>
        </div>
      </header>

      {error && <div style={styles.errorBanner}><span>{error}</span><button onClick={() => setError(null)} style={styles.dismiss}>×</button></div>}

      <div style={styles.workspace}>
        <main style={styles.dashboard}>
          <div style={styles.filters}>
            <input
              ref={filterRef}
              onChange={(event) => setFilter('query', event.target.value)}
              placeholder="Filter sessions…  /"
              style={{ ...styles.control, ...styles.search }}
              value={filters.query ?? ''}
            />
            <select onChange={(event) => setFilter('repo', event.target.value)} style={styles.control} value={filters.repo ?? ''}>
              <option value="">All repos</option>
              {repos.map((repo) => <option key={repo.id} value={repo.id}>{repo.name}</option>)}
            </select>
            <select onChange={(event) => setFilter('agent', event.target.value as SessionFilters['agent'])} style={styles.control} value={filters.agent ?? ''}>
              <option value="">All agents</option><option value="claude">Claude</option><option value="codex">Codex</option>
            </select>
            <select onChange={(event) => setFilter('status', event.target.value as SessionFilters['status'])} style={styles.control} value={filters.status ?? ''}>
              <option value="">All statuses</option>
              {STATUSES.map((status) => <option key={status} value={status}>{status.replaceAll('_', ' ')}</option>)}
            </select>
            <select onChange={(event) => setFilter('origin', event.target.value as SessionOrigin)} style={styles.control} value={filters.origin ?? ''}>
              <option value="">All origins</option><option value="managed">Managed</option><option value="external">External</option>
            </select>
            <label style={styles.groupLabel}>Group
              <select onChange={(event) => setGroupBy(event.target.value as GroupBy)} style={styles.control} value={groupBy}>
                <option value="repo">Repo</option><option value="agent">Agent</option><option value="status">Status</option><option value="origin">Origin</option><option value="none">None</option>
              </select>
            </label>
          </div>

          <div style={styles.summary}>{visibleSessions.length} of {sessions.length} sessions · keys 1–9 open · / filters</div>
          {terminalHint && <div style={styles.hint}>{terminalHint}</div>}
          <div style={styles.tableArea}>
            {groups.map((group) => (
              <section key={group.key} style={styles.group}>
                <header style={styles.groupHeader}>
                  <span>{group.label}</span>
                  <span style={styles.groupCount}>{group.sessions.length}</span>
                  {groupBy === 'repo' && conflicts.some((item) => item.repoId === group.key) && <span style={styles.conflictBadge}>⚠ {conflicts.filter((item) => item.repoId === group.key).length}</span>}
                  {groupBy === 'repo' && group.key !== 'unassigned' && (
                    <button onClick={() => toggleRepoChanges(group.key)} style={styles.groupChangesButton}>
                      {expandedRepoChanges.has(group.key) ? '▾' : '▸'} Changes
                    </button>
                  )}
                </header>
                <div style={styles.tableHeader}>
                  <span>Name</span><span>Agent</span><span>Repository / branch</span><span>Task</span><span>Status</span><span>Origin</span><span>Activity</span><span>Started</span>
                </div>
                {group.sessions.map((session) => (
                  <div
                    key={session.id}
                    onClick={() => setSelectedId(session.id)}
                    style={{ ...styles.tableRow, ...(selectedId === session.id ? styles.selectedRow : {}) }}
                  >
                    <SessionNameEditor session={session} onSave={rename} />
                    <span style={styles.agent}><span style={styles.agentIcon}>{session.agent === 'claude' ? 'C' : '⌘'}</span>{session.agent}</span>
                    <span style={styles.ellipsis} title={session.cwd}>{session.repoId ? (repoNames.get(session.repoId) ?? session.repoId) : session.cwd.split('/').pop()}<small style={styles.branch}>{session.branch ?? '—'}</small></span>
                    <span style={styles.muted}>{session.taskId ?? '—'}</span>
                    <span><span title={`Status source: ${session.statusSource}`} style={{ ...styles.statusChip, borderColor: STATUS_COLORS[session.status], color: STATUS_COLORS[session.status] }}>{session.status.replaceAll('_', ' ')}</span></span>
                    <span style={styles.originCell}>
                      <span style={{ ...styles.originBadge, ...(session.origin === 'external' ? styles.externalBadge : {}) }}>{session.origin}</span>
                      {session.origin === 'external' && session.terminalRef && (
                        <button
                          onClick={(event) => {
                            event.stopPropagation();
                            void action(session, 'focus');
                          }}
                          style={styles.rowFocus}
                        >Focus</button>
                      )}
                    </span>
                    <span style={styles.muted} title={new Date(session.lastActivityAt).toLocaleString()}>{relativeTime(session.lastActivityAt, now)}</span>
                    <span style={styles.muted}>{new Date(session.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                ))}
                {groupBy === 'repo' && expandedRepoChanges.has(group.key) && (
                  <div style={styles.inlineChanges}>
                    <DiffPanel key={group.key} repoPath={group.key} />
                  </div>
                )}
              </section>
            ))}
            {visibleSessions.length === 0 && <div style={styles.empty}>No sessions match these filters.</div>}
          </div>
          <div style={styles.activityBar}>
            <strong>Coordination</strong>
            {events.slice(-3).reverse().map((event) => (
              <span key={`${event.ts}-${event.agent}-${event.event}`} title={event.message}>{event.agent} · {event.event}{event.task ? ` · ${event.task}` : ''}</span>
            ))}
            {events.length === 0 && <span>No bus events yet</span>}
          </div>
          {conflicts.length > 0 && <aside style={styles.conflictPanel}>
            <strong>Conflicts & overlap</strong>
            {conflicts.map((conflict, index) => <span key={`${conflict.kind}-${conflict.repoId}-${index}`}><b>{conflict.kind.replaceAll('_', ' ')}:</b> {conflict.detail}</span>)}
            <span>Recommendation: isolate concurrent work with branches or <a href="https://git-scm.com/docs/git-worktree" rel="noreferrer" target="_blank">git worktrees</a>.</span>
          </aside>}
        </main>

        {selected && (
          <aside style={styles.detail}>
            <header style={styles.detailHeader}>
              <div><strong>{selected.name ?? `${selected.agent} session`}</strong><div style={styles.detailSub}>{selected.cwd}</div></div>
              <button aria-label="Close details" onClick={() => setSelectedId(null)} style={styles.dismiss}>×</button>
            </header>
            {(selected.worktreePath ?? selected.repoId) && (
              <div style={styles.detailTabs}>
                <button
                  onClick={() => setDetailTab('main')}
                  style={{ ...styles.detailTab, ...(detailTab === 'main' ? styles.detailTabActive : {}) }}
                >{selected.origin === 'managed' ? 'Terminal' : 'Overview'}</button>
                <button
                  onClick={() => setDetailTab('changes')}
                  style={{ ...styles.detailTab, ...(detailTab === 'changes' ? styles.detailTabActive : {}) }}
                >Changes{changeCount !== null ? ` (${changeCount})` : ''}</button>
              </div>
            )}
            {selected.origin === 'managed' ? (
              <>
                <div style={styles.detailActions}>
                  <button onClick={() => void action(selected, 'stop')} style={styles.secondaryButton}>■ Stop</button>
                  <button onClick={() => void action(selected, 'restart')} style={styles.secondaryButton}>↻ Restart</button>
                </div>
                {/* keep the terminal mounted while the Changes tab is open so xterm state survives tab switches */}
                <div style={{ ...styles.terminalWrap, ...(detailTab === 'changes' ? styles.hidden : {}) }}>
                  {wsReady && wsRef.current
                    ? <Terminal key={`${selected.id}-${selected.startedAt}`} ws={wsRef.current} sessionId={selected.id} />
                    : <div style={styles.empty}>Terminal reconnecting…</div>}
                </div>
              </>
            ) : (
              <div style={{ ...styles.metadataCard, ...(detailTab === 'changes' ? styles.hidden : {}) }}>
                <Metadata label="Agent" value={selected.agent} />
                <Metadata label="Status" value={`${selected.status} (${selected.statusSource})`} />
                <Metadata label="Repository" value={selected.repoId ? (repoNames.get(selected.repoId) ?? selected.repoId) : 'Not a git repository'} />
                <Metadata label="Branch" value={selected.branch ?? 'Unknown'} />
                <Metadata label="Process" value={selected.pid ? `pid ${selected.pid}` : 'Unknown'} />
                <Metadata label="TTY" value={selected.tty ?? 'Unknown'} />
                <Metadata label="Terminal" value={selected.terminalApp === 'iTerm2' ? `iTerm2 · tab ${selected.terminalRef?.tabId ?? '?'}` : selected.terminalApp === 'Terminal' ? `Terminal.app · tab ${selected.terminalRef?.tabId ?? '?'}` : selected.terminalApp === 'VSCode' ? 'VS Code integrated terminal' : 'Unknown terminal'} />
                <button disabled={!selected.terminalRef} onClick={() => void action(selected, 'focus')} style={styles.launchButton}>Focus terminal</button>
                <ConversationPanel key={selected.id} session={selected} />
              </div>
            )}
            {detailTab === 'changes' && (selected.worktreePath ?? selected.repoId) && (
              <DiffPanel
                key={selected.worktreePath ?? selected.repoId}
                onCount={setChangeCount}
                repoPath={selected.worktreePath ?? selected.repoId!}
              />
            )}
          </aside>
        )}
      </div>

      {showLaunch && (
        <LaunchModal
          repos={repos}
          onClose={() => setShowLaunch(false)}
          onLaunched={(session) => {
            upsertSession(session);
            setSelectedId(session.id);
            setShowLaunch(false);
            refreshRepos();
          }}
        />
      )}
    </div>
  );
}

function Metadata({ label, value }: { label: string; value: string }) {
  return <div style={styles.metadata}><span style={styles.metadataLabel}>{label}</span><span>{value}</span></div>;
}

function repoPathOf(session: Session): string {
  return session.worktreePath ?? session.repoId ?? session.cwd;
}

function ConversationPanel({ session }: { session: Session }) {
  const repoPath = repoPathOf(session);
  const [fetched, setFetched] = useState<AgentMessage[]>([]);
  const [localSends, setLocalSends] = useState<AgentMessage[]>([]);
  const [capabilities, setCapabilities] = useState<{ send: string; replyCapture: boolean } | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const refreshMessages = () => {
      fetch(`/api/sessions/${encodeURIComponent(session.id)}/messages`)
        .then((response) => response.ok ? response.json() : [])
        .then(setFetched)
        .catch(() => undefined);
    };
    const refreshCapabilities = () => {
      fetch(`/api/sessions/${encodeURIComponent(session.id)}/capabilities`)
        .then((response) => response.ok ? response.json() : null)
        .then(setCapabilities)
        .catch(() => undefined);
    };
    refreshMessages();
    refreshCapabilities();
    const poll = setInterval(refreshMessages, 4000);
    const capabilityPoll = setInterval(refreshCapabilities, 4000);
    return () => { clearInterval(poll); clearInterval(capabilityPoll); };
  }, [session.id]);

  const conversation = useMemo(() => {
    // drop optimistic entries once the bus round-trip delivers the real event
    const pending = localSends.filter((send) =>
      !fetched.some((event) => event.agent === send.agent && event.message === send.message));
    return conversationFor([...fetched, ...pending], session.id, session.agentSessionId);
  }, [fetched, localSends, session.id, session.agentSessionId]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [conversation.length]);

  return (
    <>
      {conversation.length > 0 && (
        <div ref={listRef} style={styles.messageList}>
          {conversation.map((entry) => (
            <div key={`${entry.ts}-${entry.agent}-${entry.text}`} style={{ ...styles.messageBubble, ...(entry.from === 'you' ? styles.messageSent : styles.messageReceived) }}>
              <div style={styles.messageMeta}>{entry.from === 'you' ? 'You' : entry.agent} · {new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
              <div style={styles.messageText}>{entry.text}</div>
            </div>
          ))}
        </div>
      )}
      {capabilities && !capabilities.replyCapture && (
        <div style={styles.captureWarning}>Prompt sending is available, but agent replies will not be recorded until AgentDeck hooks are installed and the CLI is restarted.</div>
      )}
      <SendBox
        session={session}
        onSent={(text) => setLocalSends((current) => [...current, {
          ts: new Date().toISOString(), agent: `dashboard:${session.id}`, repo: repoPath,
          event: 'message', message: text, sessionId: session.id,
        }])}
      />
    </>
  );
}

function SendBox({ session, onSent }: { session: Session; onSent?: (text: string) => void }) {
  const [text, setText] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const scriptable = session.terminalApp === 'Terminal' || session.terminalApp === 'iTerm2' || session.terminalApp === 'VSCode';

  const send = async () => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch(`/api/sessions/${session.id}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: trimmed }),
      });
      const body = await response.json() as { delivered?: string; hooked?: boolean; error?: string };
      if (!response.ok) {
        setFeedback(body.error ?? 'Send failed.');
      } else {
        setText('');
        onSent?.(trimmed);
        if (body.delivered === 'typed') {
          setFeedback(`Typed into ${session.terminalApp}.`);
        } else if (body.hooked === false) {
          setFeedback('Queued, but this repo has no AgentDeck hooks installed — the message will never be delivered. Use "Install hooks" first.');
        } else {
          setFeedback('Queued — delivered on this session’s next turn and shown in its terminal as an AgentDeck banner.');
        }
      }
    } catch {
      setFeedback('Send failed.');
    }
    setBusy(false);
  };

  return (
    <div style={styles.sendBox}>
      <textarea
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void send();
          }
        }}
        placeholder={scriptable
          ? `Send a prompt — typed straight into ${session.terminalApp}`
          : 'Send a message — delivered on the session’s next turn'}
        rows={2}
        style={styles.sendInput}
        value={text}
      />
      <button disabled={busy || text.trim() === ''} onClick={() => void send()} style={styles.secondaryButton}>
        {busy ? 'Sending…' : 'Send to session'}
      </button>
      {feedback && <div style={styles.sendFeedback}>{feedback}</div>}
    </div>
  );
}

const GRID = 'minmax(180px,1.35fr) 100px minmax(170px,1.15fr) 90px 125px 84px 92px 72px';

const styles: Record<string, React.CSSProperties> = {
  shell: { height: '100vh', display: 'flex', flexDirection: 'column', background: '#090d12', color: '#d8dee4', fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, sans-serif', fontSize: 13 },
  topbar: { minHeight: 58, display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 18px', borderBottom: '1px solid #242b35', background: '#0d1218' },
  logo: { fontSize: 18, letterSpacing: '-.02em', color: '#f0f6fc' },
  subtitle: { marginLeft: 10, color: '#697586', fontSize: 12 },
  topActions: { display: 'flex', alignItems: 'center', gap: 14 },
  connection: { fontSize: 11 },
  launchButton: { border: '1px solid #2ea043', background: '#238636', color: '#fff', padding: '7px 12px', borderRadius: 6, cursor: 'pointer', font: 'inherit' },
  errorBanner: { background: '#3c1518', color: '#ffb3ad', borderBottom: '1px solid #7d242c', padding: '8px 16px', display: 'flex', justifyContent: 'space-between' },
  dismiss: { border: 0, background: 'transparent', color: '#8b949e', cursor: 'pointer', fontSize: 18, lineHeight: 1 },
  workspace: { flex: 1, display: 'flex', minHeight: 0 },
  dashboard: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' },
  filters: { padding: '12px 14px', display: 'flex', gap: 8, alignItems: 'center', borderBottom: '1px solid #1d242d', flexWrap: 'wrap' },
  control: { boxSizing: 'border-box', background: '#111820', border: '1px solid #303844', color: '#c9d1d9', borderRadius: 5, padding: '6px 8px', font: 'inherit', fontSize: 12 },
  search: { width: 220 },
  groupLabel: { display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto', color: '#697586', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em' },
  summary: { padding: '8px 16px', color: '#697586', fontSize: 11, borderBottom: '1px solid #1d242d' },
  hint: { padding: '8px 16px', color: '#e3b341', background: '#2b2111', borderBottom: '1px solid #5a4319', fontSize: 11 },
  tableArea: { flex: 1, overflow: 'auto', padding: '0 14px 24px' },
  activityBar: { minHeight: 34, borderTop: '1px solid #242b35', display: 'flex', alignItems: 'center', gap: 16, padding: '0 14px', color: '#8b949e', fontSize: 10, overflow: 'hidden' },
  conflictPanel: { borderTop: '1px solid #5a4319', background: '#211a0d', color: '#d6b66d', padding: '9px 14px', display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, maxHeight: 130, overflow: 'auto' },
  group: { minWidth: 1030, border: '1px solid #242b35', borderRadius: 8, overflow: 'hidden', marginTop: 14, background: '#0d1218' },
  groupHeader: { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', background: '#131a22', borderBottom: '1px solid #242b35', color: '#e6edf3', fontWeight: 600 },
  groupCount: { borderRadius: 10, background: '#29313c', color: '#9da8b5', padding: '1px 7px', fontSize: 10 },
  conflictBadge: { borderRadius: 10, background: '#5a4319', color: '#e3b341', padding: '1px 7px', fontSize: 10 },
  groupChangesButton: { marginLeft: 'auto', border: '1px solid #303844', background: '#171d25', color: '#c9d1d9', borderRadius: 5, padding: '3px 9px', cursor: 'pointer', font: 'inherit', fontSize: 11, fontWeight: 400 },
  inlineChanges: { borderTop: '1px solid #242b35', maxHeight: '50vh', display: 'flex', flexDirection: 'column' },
  tableHeader: { display: 'grid', gridTemplateColumns: GRID, gap: 12, padding: '7px 12px', color: '#697586', fontSize: 10, textTransform: 'uppercase', letterSpacing: '.06em', borderBottom: '1px solid #202731' },
  tableRow: { display: 'grid', gridTemplateColumns: GRID, gap: 12, alignItems: 'center', padding: '9px 12px', borderBottom: '1px solid #171d25', cursor: 'pointer' },
  selectedRow: { background: '#12243a', boxShadow: 'inset 3px 0 #58a6ff' },
  nameInput: { minWidth: 0, width: '100%', boxSizing: 'border-box', border: '1px solid transparent', background: 'transparent', color: '#e6edf3', borderRadius: 4, padding: '4px 5px', font: 'inherit', fontWeight: 600, textOverflow: 'ellipsis' },
  agent: { display: 'flex', alignItems: 'center', gap: 7, textTransform: 'capitalize' },
  agentIcon: { display: 'inline-grid', placeItems: 'center', width: 22, height: 22, borderRadius: 6, background: '#252d38', color: '#c9d1d9', fontSize: 11, fontWeight: 700 },
  ellipsis: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  branch: { display: 'block', color: '#697586', fontSize: 10, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis' },
  muted: { color: '#8b949e', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis' },
  statusChip: { display: 'inline-block', border: '1px solid', borderRadius: 10, padding: '2px 7px', fontSize: 10, textTransform: 'capitalize', whiteSpace: 'nowrap' },
  originBadge: { display: 'inline-block', borderRadius: 4, padding: '2px 6px', background: '#183b2a', color: '#56d364', fontSize: 9, textTransform: 'uppercase', letterSpacing: '.04em' },
  externalBadge: { background: '#2d2340', color: '#d2a8ff' },
  originCell: { display: 'flex', alignItems: 'center', gap: 4 },
  rowFocus: { border: 0, background: 'transparent', color: '#58a6ff', padding: 0, cursor: 'pointer', font: 'inherit', fontSize: 9 },
  empty: { padding: 40, color: '#697586', textAlign: 'center' },
  detail: { width: 440, minWidth: 360, borderLeft: '1px solid #242b35', background: '#0b1016', display: 'flex', flexDirection: 'column', minHeight: 0 },
  detailHeader: { padding: 14, borderBottom: '1px solid #242b35', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 },
  detailSub: { color: '#697586', fontSize: 10, marginTop: 4, wordBreak: 'break-all' },
  detailActions: { padding: 8, borderBottom: '1px solid #242b35', display: 'flex', justifyContent: 'flex-end', gap: 6 },
  detailTabs: { display: 'flex', gap: 2, padding: '6px 14px 0', borderBottom: '1px solid #242b35' },
  detailTab: { border: '1px solid transparent', borderBottom: 0, background: 'transparent', color: '#8b949e', padding: '6px 12px', cursor: 'pointer', font: 'inherit', fontSize: 12, borderRadius: '6px 6px 0 0' },
  detailTabActive: { background: '#111820', border: '1px solid #242b35', borderBottom: '1px solid #111820', color: '#e6edf3', marginBottom: -1 },
  hidden: { display: 'none' },
  secondaryButton: { background: '#171d25', border: '1px solid #303844', color: '#c9d1d9', borderRadius: 5, padding: '5px 10px', cursor: 'pointer', font: 'inherit', fontSize: 11 },
  terminalWrap: { flex: 1, minHeight: 0, padding: 8, background: '#090d12' },
  metadataCard: { margin: 16, padding: 16, border: '1px solid #242b35', borderRadius: 8, background: '#111820', display: 'flex', flexDirection: 'column', gap: 14 },
  metadata: { display: 'grid', gridTemplateColumns: '90px 1fr', gap: 10, alignItems: 'start' },
  metadataLabel: { color: '#697586', fontSize: 10, textTransform: 'uppercase', letterSpacing: '.06em' },
  messageList: { display: 'flex', flexDirection: 'column', gap: 8, maxHeight: '38vh', overflowY: 'auto', borderTop: '1px solid #242b35', paddingTop: 12 },
  messageBubble: { maxWidth: '85%', borderRadius: 8, padding: '7px 10px', fontSize: 12, lineHeight: 1.45 },
  messageSent: { alignSelf: 'flex-end', background: '#12324f', border: '1px solid #1f4a73', color: '#cde3f8' },
  messageReceived: { alignSelf: 'flex-start', background: '#171d25', border: '1px solid #303844', color: '#c9d1d9' },
  messageMeta: { color: '#697586', fontSize: 9, textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 3 },
  messageText: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  sendBox: { display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid #242b35', paddingTop: 14 },
  sendInput: { boxSizing: 'border-box', width: '100%', resize: 'vertical', background: '#0d1218', border: '1px solid #303844', color: '#c9d1d9', borderRadius: 5, padding: '7px 9px', font: 'inherit', fontSize: 12 },
  sendFeedback: { color: '#8b949e', fontSize: 11, lineHeight: 1.4 },
  captureWarning: { color: '#d29922', background: '#241d0b', border: '1px solid #5f4b14', borderRadius: 5, padding: '7px 9px', fontSize: 11, lineHeight: 1.4 },
};
