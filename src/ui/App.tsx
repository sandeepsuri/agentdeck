import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentMessage, Conflict, DiscoveryStatus, FileClaim, Repo, Session } from '../types.js';
import type { ServerFrame } from '../protocol.js';
import { LaunchModal } from './components/LaunchModal.js';
import { inspectorPreferenceStorage, persistInspectorCollapsed, readInspectorCollapsed } from './preferences.js';
import { type ThemePreference, useTheme } from './theme.js';
import { ChangesWorkspace } from './workspace/ChangesWorkspace.js';
import { CommandPalette } from './workspace/CommandPalette.js';
import { GridView } from './workspace/GridView.js';
import { InspectorRail } from './workspace/InspectorRail.js';
import { OperationsView } from './workspace/OperationsView.js';
import { SessionSidebar } from './workspace/SessionSidebar.js';
import { SignalsView } from './workspace/SignalsView.js';
import { TerminalWorkspace } from './workspace/TerminalWorkspace.js';
import { repoPathOf, sessionLabel, type WorkspaceView, WORKSPACE_VIEWS } from './workspace/model.js';

const THEME_OPTIONS: { value: ThemePreference; label: string; glyph: string }[] = [
  { value: 'system', label: 'System', glyph: '◐' },
  { value: 'light', label: 'Light', glyph: '☀' },
  { value: 'dark', label: 'Dark', glyph: '☾' },
];

function ThemeControl() {
  const { preference, resolvedTheme, setPreference } = useTheme();
  const [open, setOpen] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const selected = THEME_OPTIONS.find((option) => option.value === preference) ?? THEME_OPTIONS[0]!;
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!hostRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  return (
    <div className="theme-control" ref={hostRef}>
      <button aria-expanded={open} aria-haspopup="menu" className="top-icon-button" onClick={() => setOpen((current) => !current)} title={`Appearance: ${selected.label}`} type="button">{selected.glyph}</button>
      {open && <div className="theme-menu" role="menu"><div>Appearance</div>{THEME_OPTIONS.map((option) => <button aria-checked={preference === option.value} key={option.value} onClick={() => { setPreference(option.value); setOpen(false); }} role="menuitemradio" type="button"><span>{option.glyph}</span><strong>{option.label}</strong>{option.value === 'system' && <small>{resolvedTheme}</small>}<em>{preference === option.value ? '✓' : ''}</em></button>)}</div>}
    </div>
  );
}

export function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [events, setEvents] = useState<AgentMessage[]>([]);
  const [claims, setClaims] = useState<FileClaim[]>([]);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [discoveryStatus, setDiscoveryStatus] = useState<DiscoveryStatus | null>(null);
  const [vscodeStatus, setVsCodeStatus] = useState({ connected: false, windows: 0, terminals: 0, installable: false });
  const [view, setView] = useState<WorkspaceView>('operations');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showLaunch, setShowLaunch] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wsReady, setWsReady] = useState(false);
  const [terminalVisited, setTerminalVisited] = useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(() => readInspectorCollapsed(inspectorPreferenceStorage()));
  const [now, setNow] = useState(Date.now());
  const wsRef = useRef<WebSocket | null>(null);

  const selected = useMemo(() => sessions.find((session) => session.id === selectedId) ?? null, [selectedId, sessions]);
  const selectedRepoPath = selected ? repoPathOf(selected) : repos[0]?.path ?? null;
  const changeCount = repos.find((repo) => repo.path === selectedRepoPath || repo.id === selectedRepoPath)?.dirtyFiles?.length ?? 0;

  const upsertSession = useCallback((session: Session) => setSessions((current) => {
    const index = current.findIndex((item) => item.id === session.id);
    if (index < 0) return [session, ...current];
    const next = [...current];
    next[index] = session;
    return next;
  }), []);

  const refreshSessions = useCallback(() => fetch('/api/sessions').then((response) => response.json()).then((body: Session[]) => {
    setSessions(body);
    setSelectedId((current) => current && body.some((session) => session.id === current) ? current : body[0]?.id ?? null);
  }).catch(() => setError('AgentDeck API is unreachable.')), []);
  const refreshRepos = useCallback(() => fetch('/api/repos').then((response) => response.json()).then(setRepos).catch(() => undefined), []);
  const refreshEvents = useCallback(() => fetch('/api/events?limit=300').then((response) => response.json()).then(setEvents).catch(() => undefined), []);
  const refreshClaims = useCallback(() => fetch('/api/claims').then((response) => response.json()).then(setClaims).catch(() => undefined), []);
  const refreshConflicts = useCallback(() => fetch('/api/conflicts').then((response) => response.json()).then(setConflicts).catch(() => undefined), []);
  const refreshDiscovery = useCallback(() => fetch('/api/discovery/status').then((response) => response.json()).then(setDiscoveryStatus).catch(() => undefined), []);
  const refreshVsCode = useCallback(() => fetch('/api/integrations/vscode/status').then((response) => response.json()).then(setVsCodeStatus).catch(() => undefined), []);

  useEffect(() => {
    refreshSessions(); refreshRepos(); refreshEvents(); refreshClaims(); refreshConflicts(); refreshDiscovery(); refreshVsCode();
    const clock = setInterval(() => setNow(Date.now()), 1000);
    const background = setInterval(() => { refreshRepos(); refreshClaims(); refreshConflicts(); refreshDiscovery(); refreshVsCode(); }, 5000);
    return () => { clearInterval(clock); clearInterval(background); };
  }, [refreshClaims, refreshConflicts, refreshDiscovery, refreshEvents, refreshRepos, refreshSessions, refreshVsCode]);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout>;
    let disposed = false;
    const connect = () => {
      if (disposed) return;
      socket = new WebSocket(`ws://${location.host}/ws`);
      wsRef.current = socket;
      socket.addEventListener('open', () => { setWsReady(true); refreshSessions(); });
      socket.addEventListener('message', (message) => {
        const frame = JSON.parse(String(message.data)) as ServerFrame;
        if (frame.t === 'session_update') upsertSession(frame.session);
        if (frame.t === 'session_removed') {
          setSessions((current) => current.filter((session) => session.id !== frame.sessionId));
          setSelectedId((current) => current === frame.sessionId ? null : current);
        }
        if (frame.t === 'agent_event') {
          setEvents((current) => [...current.slice(-299), frame.event]);
          refreshClaims(); refreshConflicts();
        }
      });
      socket.addEventListener('close', () => { setWsReady(false); if (!disposed) retry = setTimeout(connect, 1000); });
    };
    connect();
    return () => { disposed = true; clearTimeout(retry); socket?.close(); };
  }, [refreshClaims, refreshConflicts, refreshSessions, upsertSession]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName ?? '');
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setPaletteOpen(true); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'l') { event.preventDefault(); setShowLaunch(true); }
      if (!typing && /^[1-9]$/.test(event.key)) {
        const session = sessions[Number(event.key) - 1];
        if (session) setSelectedId(session.id);
      }
      if (event.key === 'Escape') setPaletteOpen(false);
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [sessions]);

  useEffect(() => { if (view === 'terminal') setTerminalVisited(true); }, [view]);

  useEffect(() => {
    persistInspectorCollapsed(inspectorPreferenceStorage(), inspectorCollapsed);
  }, [inspectorCollapsed]);

  const selectSession = (session: Session) => setSelectedId(session.id);
  const openTerminal = (session: Session) => { setSelectedId(session.id); setView('terminal'); setTerminalVisited(true); };

  const action = async (session: Session, actionName: 'stop' | 'restart' | 'focus') => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/${actionName}`, { method: 'POST' });
    const body = await response.json() as Session & { error?: string };
    if (!response.ok) return setError(body.error ?? `${actionName} failed.`);
    if (actionName === 'restart') upsertSession(body);
  };

  const rename = async (session: Session, name: string) => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name.trim() }),
    });
    const body = await response.json() as Session & { error?: string };
    if (!response.ok) setError(body.error ?? 'Rename failed.'); else upsertSession(body);
  };

  const retryDiscovery = async () => {
    setDiscoveryStatus((current) => current ? { ...current, polling: true } : current);
    await fetch('/api/discovery/refresh', { method: 'POST' }).catch(() => undefined);
    refreshDiscovery(); refreshSessions();
  };

  const installHooks = async () => {
    const repo = repos.find((item) => item.path === selectedRepoPath) ?? repos[0];
    if (!repo) return setError('No repository is available for hook installation.');
    const response = await fetch('/api/hooks/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repoPath: repo.path, user: true }) });
    const body = await response.json() as { error?: string };
    setError(response.ok ? `Hooks installed for ${repo.name}. Restart active sessions to apply them.` : body.error ?? 'Hook installation failed.');
  };

  return (
    <div className="agentdeck-shell">
      <header className="app-topbar">
        <div className="app-brand"><span className="brand-mark"><i /></span><strong>AgentDeck</strong></div>
        <nav className="workspace-tabs" aria-label="Workspace views">
          {WORKSPACE_VIEWS.map((item) => <button className={view === item.id ? 'is-active' : ''} key={item.id} onClick={() => setView(item.id)} type="button">{item.label}{item.id === 'changes' && changeCount > 0 && <span>{changeCount}</span>}</button>)}
        </nav>
        <button className="jump-control" onClick={() => setPaletteOpen(true)} type="button"><span>&gt;_</span><strong>Jump to session, file, or action…</strong><kbd>⌘K</kbd></button>
        <div className="topbar-actions">
          <span className={`live-indicator${wsReady ? '' : ' is-down'}`}><i />{wsReady ? 'live' : 'reconnecting'}</span>
          <ThemeControl />
          <button className="button compact-button" onClick={() => void installHooks()} type="button">Install hooks</button>
          <button className="button button-primary launch-button" onClick={() => setShowLaunch(true)} type="button">Launch agent <kbd>⌘L</kbd></button>
        </div>
      </header>

      {error && <div className="global-banner"><span>{error}</span><button onClick={() => setError(null)} type="button">×</button></div>}

      <div className="app-body">
        <SessionSidebar discoveryStatus={discoveryStatus} onLaunch={() => setShowLaunch(true)} onRefreshDiscovery={() => void retryDiscovery()} onSelect={selectSession} repos={repos} selectedId={selectedId} sessions={sessions} />
        <main className="workspace-stage">
          <div className={view === 'operations' ? 'workspace-layer is-active' : 'workspace-layer'}><OperationsView conflicts={conflicts} events={events} onOpenTerminal={openTerminal} onSelect={selectSession} repos={repos} selected={selected} sessions={sessions} /></div>
          {terminalVisited && <div className={view === 'terminal' ? 'workspace-layer is-active' : 'workspace-layer'}><TerminalWorkspace onError={setError} onFocusExternal={(session) => void action(session, 'focus')} session={selected} ws={wsRef.current} wsReady={wsReady} /></div>}
          <div className={view === 'changes' ? 'workspace-layer is-active' : 'workspace-layer'}><ChangesWorkspace claims={claims} onError={setError} repoPath={selectedRepoPath} sessions={sessions} /></div>
          <div className={view === 'grid' ? 'workspace-layer is-active' : 'workspace-layer'}><GridView onOpen={openTerminal} sessions={sessions} /></div>
          <div className={view === 'signals' ? 'workspace-layer is-active' : 'workspace-layer'}><SignalsView events={events} /></div>
        </main>
        <div className={`inspector-dock${inspectorCollapsed ? ' is-collapsed' : ''}`}>
          <button
            aria-controls="agentdeck-inspector-panel"
            aria-expanded={!inspectorCollapsed}
            aria-label={inspectorCollapsed ? 'Expand inspector' : 'Collapse inspector'}
            className="inspector-toggle"
            onClick={() => setInspectorCollapsed((current) => !current)}
            title={inspectorCollapsed ? 'Expand inspector' : 'Collapse inspector'}
            type="button"
          >{inspectorCollapsed ? '‹' : '›'}</button>
          <div hidden={inspectorCollapsed} id="agentdeck-inspector-panel">
            <InspectorRail conflicts={conflicts} events={events} onAction={(session, actionName) => void action(session, actionName)} onError={setError} onRename={(session, name) => void rename(session, name)} onView={setView} selected={selected} view={view} />
          </div>
        </div>
      </div>

      <footer className="app-statusbar">
        <span className={wsReady ? 'is-live' : ''}><i />{wsReady ? 'Live' : 'Offline'}</span>
        <span>AgentDeck v0.1.0</span>
        <span>▣ {selected ? selected.cwd.split('/').pop() : `${repos.length} repos`}</span>
        {repos.some((repo) => repo.isDirty) && <span className="is-dirty"><i />Worktree dirty</span>}
        <span className="status-ticker">{events.slice(-3).reverse().map((event) => `${event.agent} · ${event.event}${event.task ? ` · ${event.task}` : ''}`).join('      ') || 'Waiting for coordination signals'}</span>
        <span>{new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        <span>API status <i className={wsReady ? 'api-ok' : ''} /></span>
      </footer>

      <CommandPalette onClose={() => setPaletteOpen(false)} onLaunch={() => setShowLaunch(true)} onSelectSession={(session) => { selectSession(session); setView('operations'); }} onView={setView} open={paletteOpen} repos={repos} sessions={sessions} />
      {showLaunch && <LaunchModal onClose={() => setShowLaunch(false)} onLaunched={(session) => { upsertSession(session); setSelectedId(session.id); setShowLaunch(false); setView('terminal'); setTerminalVisited(true); refreshRepos(); }} repos={repos} />}
    </div>
  );
}
