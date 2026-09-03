import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentMessage, Conflict, DiscoveryStatus, FileClaim, Repo, RunAttentionItem, Session } from '../types.js';
import type {
  AttentionDecisionInput, Profile, PublicationTarget, WorkRun,
} from '../work-engine/types.js';
import { TOKEN_QUERY_PARAM, type ServerFrame } from '../protocol.js';
import { apiFetch, fetchConnection, responseJson, responseJsonArray } from './apiFetch.js';
import { getStoredToken, setStoredToken, tokenStorage } from './connection.js';
import { exchangeInvitationCode } from './collaborators.js';
import { LaunchModal } from './components/LaunchModal.js';
import { RunSubmissionModal } from './components/RunSubmissionModal.js';
import { SettingsModal } from './components/SettingsModal.js';
import { inspectorPreferenceStorage, persistInspectorCollapsed, readInspectorCollapsed } from './preferences.js';
import { type ThemePreference, useTheme } from './theme.js';
import { ChangesWorkspace } from './workspace/ChangesWorkspace.js';
import { CommandPalette } from './workspace/CommandPalette.js';
import { GridView } from './workspace/GridView.js';
import { HistoryView } from './workspace/HistoryView.js';
import { INITIAL_HISTORY_WITNESS_STATE, advanceHistoryWitnessState, splitSessionsForRail } from './workspace/history.js';
import { InspectorRail } from './workspace/InspectorRail.js';
import { MobileWorkspace } from './workspace/MobileWorkspace.js';
import { OperationsView } from './workspace/OperationsView.js';
import { RunWorkspace } from './workspace/RunWorkspace.js';
import { SessionSidebar } from './workspace/SessionSidebar.js';
import { SignalsView } from './workspace/SignalsView.js';
import { TerminalWorkspace } from './workspace/TerminalWorkspace.js';
import { repoPathOf, sessionLabel, useNow, type WorkspaceView, WORKSPACE_VIEWS } from './workspace/model.js';
import { parseInitialNavigation } from './navigation.js';
import { finalizeRemoteAuthentication } from './remote-auth.js';

const THEME_OPTIONS: { value: ThemePreference; label: string; glyph: string }[] = [
  { value: 'system', label: 'System', glyph: '◐' },
  { value: 'light', label: 'Light', glyph: '☀' },
  { value: 'dark', label: 'Dark', glyph: '☾' },
];

// Owns its own 1 Hz interval so the footer clock ticks without re-rendering
// the rest of the app (see docs/specs: "Stop the global setNow re-render").
function Clock() {
  const now = useNow(1000);
  return <span>{new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>;
}

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
  const initialNavigation = useMemo(() => parseInitialNavigation(location.search), []);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [runs, setRuns] = useState<WorkRun[]>([]);
  // Ticket 07: a remote (mobile) connection cannot fetch full Run objects
  // (see the isRemoteAllowedRoute comment in app.ts) — this is the one
  // minimal, remote-safe queue it polls instead (GET /api/runs/attention).
  // The local/desktop path never needs it: RunWorkspace already reads
  // run.pendingAttention straight off the full Run objects `runs` above.
  const [runAttention, setRunAttention] = useState<RunAttentionItem[]>([]);
  // Ticket 05: the structured Attempt panel stays hidden until this
  // admin-configured feature gate (config.json's structuredAttemptsEnabled) is on.
  const [structuredAttemptsEnabled, setStructuredAttemptsEnabled] = useState(false);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [events, setEvents] = useState<AgentMessage[]>([]);
  const [claims, setClaims] = useState<FileClaim[]>([]);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [discoveryStatus, setDiscoveryStatus] = useState<DiscoveryStatus | null>(null);
  const [vscodeStatus, setVsCodeStatus] = useState({ connected: false, windows: 0, terminals: 0, installable: false });
  const [view, setView] = useState<WorkspaceView>(initialNavigation.view ?? 'operations');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [showLaunch, setShowLaunch] = useState(false);
  const [showRunSubmission, setShowRunSubmission] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wsReady, setWsReady] = useState(false);
  const [terminalVisited, setTerminalVisited] = useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(() => readInspectorCollapsed(inspectorPreferenceStorage()));
  const wsRef = useRef<WebSocket | null>(null);
  const requestedSessionIdRef = useRef(initialNavigation.sessionId);
  const requestedRunIdRef = useRef(initialNavigation.runId);
  const historyWitnessRef = useRef(INITIAL_HISTORY_WITNESS_STATE);
  // Ticket 05: defaults to 'ready' (render normally, no delay) rather than
  // an initial "unknown/loading" state — the ordinary desktop/loopback case
  // must be a complete no-op with zero extra render delay. Only flips to
  // 'needs-token'/'denied' once GET /api/connection reports it. That check
  // includes a stored token so returning phones can become ready directly.
  const [connectionGate, setConnectionGate] = useState<'ready' | 'needs-token' | 'denied'>('ready');
  const [tokenInput, setTokenInput] = useState('');
  const [tokenError, setTokenError] = useState<string | null>(null);
  // Ticket 11 AC1: a named collaborator's device has no shared tailnet
  // token to enter — it exchanges a one-time invitation code for its own
  // device credential instead. Same gate, a second mode.
  const [authMode, setAuthMode] = useState<'token' | 'invitation'>('token');
  const [inviteCode, setInviteCode] = useState('');
  const [deviceLabel, setDeviceLabel] = useState('');
  const [inviteError, setInviteError] = useState<string | null>(null);
  // Ticket 13: which workspace to render once the gate is 'ready'. Defaults
  // to 'local' for the same reason connectionGate defaults to 'ready' — the
  // ordinary desktop/loopback case must render its normal tree immediately,
  // with zero extra delay, and only switch to the phone view once
  // GET /api/connection actually reports 'remote'.
  const [connectionKind, setConnectionKind] = useState<'local' | 'remote'>('local');
  // Ticket 12 AC1/AC6: set only when this connection resolved to a named
  // collaborator's device credential — drives whether MobileWorkspace
  // offers launching/guiding Runs, and which Repositories/Profiles it
  // offers them for.
  const [collaboratorPrincipal, setCollaboratorPrincipal] = useState<{ id: string; displayName: string } | null>(null);
  const [collaboratorRepos, setCollaboratorRepos] = useState<Repo[]>([]);
  const [collaboratorProfiles, setCollaboratorProfiles] = useState<Profile[]>([]);

  const selected = useMemo(() => sessions.find((session) => session.id === selectedId) ?? null, [selectedId, sessions]);
  const selectedRun = useMemo(() => runs.find((run) => run.id === selectedRunId) ?? null, [runs, selectedRunId]);
  const selectedRepoPath = selectedRun?.spec.repository.path ?? (selected ? repoPathOf(selected) : repos[0]?.path ?? null);
  const changesRepoPath = selectedRun?.preparation.state === 'ready'
    ? selectedRun.preparation.worktreePath ?? selectedRepoPath
    : selectedRepoPath;
  const changeCount = repos.find((repo) => repo.path === selectedRepoPath || repo.id === selectedRepoPath)?.dirtyFiles?.length ?? 0;

  // Ticket 10: an ended managed session stays in the rail ~1h, then moves to
  // History. `historyWitnessRef` is advanced synchronously during render
  // (not from a useEffect) so a just-witnessed live->ended transition is
  // recorded in the same render it's observed — an effect-based update
  // would lag one render, letting the session flash into History before
  // settling back into the rail. `advanceHistoryWitnessState` is idempotent
  // for a stable `sessions` snapshot, so re-running it on every render
  // (e.g. the ticking `historyNow` below) is safe. The tick is coarse
  // (minutes, not the Stage-1 1 Hz global re-render this app removed) and
  // lives here because the split needs the full `sessions` list, which App
  // already owns.
  historyWitnessRef.current = advanceHistoryWitnessState(historyWitnessRef.current, sessions, Date.now());
  const historyNow = useNow(60_000);
  const { rail: railSessions, history: historySessions } = useMemo(
    () => splitSessionsForRail(sessions, historyNow, historyWitnessRef.current.witnessedEndedAtById),
    [sessions, historyNow],
  );

  const upsertSession = useCallback((session: Session) => setSessions((current) => {
    const index = current.findIndex((item) => item.id === session.id);
    if (index < 0) return [session, ...current];
    const next = [...current];
    next[index] = session;
    return next;
  }), []);

  const refreshSessions = useCallback(() => apiFetch('/api/sessions')
    .then((response) => responseJsonArray<Session>(response)).then((body) => {
      setSessions(body);
      setError(null);
      const requested = requestedSessionIdRef.current;
      if (requested) {
        requestedSessionIdRef.current = undefined;
        history.replaceState(null, '', location.pathname);
        if (body.some((session) => session.id === requested)) {
          setSelectedId(requested);
        } else {
          setView('operations');
          setSelectedId(body[0]?.id ?? null);
        }
        return;
      }
      setSelectedId((current) => {
        return current && body.some((session) => session.id === current) ? current : body[0]?.id ?? null;
      });
    }).catch(() => setError('AgentDeck API is unreachable.')), []);
  const refreshRepos = useCallback(() => apiFetch('/api/repos').then((response) => responseJsonArray<Repo>(response)).then(setRepos).catch(() => undefined), []);
  const refreshRuns = useCallback(() => apiFetch('/api/runs').then((response) => responseJsonArray<WorkRun>(response)).then((body) => {
    setRuns(body);
    // Ticket 07: the native companion's openRun deep-link (?run=<id>) — same
    // one-shot "consume once loaded, then clear the URL" shape as the
    // session deep-link above.
    const requestedRunId = requestedRunIdRef.current;
    if (requestedRunId && body.some((run) => run.id === requestedRunId)) {
      requestedRunIdRef.current = undefined;
      history.replaceState(null, '', location.pathname);
      setSelectedId(null);
      setSelectedRunId(requestedRunId);
      setView('operations');
    }
  }).catch(() => undefined), []);
  const refreshRunAttention = useCallback(() => apiFetch('/api/runs/attention').then((response) => responseJsonArray<RunAttentionItem>(response)).then(setRunAttention).catch(() => undefined), []);
  const refreshEvents = useCallback(() => apiFetch('/api/events?limit=300').then((response) => responseJsonArray<AgentMessage>(response)).then(setEvents).catch(() => undefined), []);
  const refreshClaims = useCallback(() => apiFetch('/api/claims').then((response) => responseJsonArray<FileClaim>(response)).then(setClaims).catch(() => undefined), []);
  const refreshConflicts = useCallback(() => apiFetch('/api/conflicts').then((response) => responseJsonArray<Conflict>(response)).then(setConflicts).catch(() => undefined), []);
  const refreshDiscovery = useCallback(() => apiFetch('/api/discovery/status').then((response) => responseJson<DiscoveryStatus>(response)).then(setDiscoveryStatus).catch(() => undefined), []);
  const refreshVsCode = useCallback(() => apiFetch('/api/integrations/vscode/status').then((response) => responseJson<{ connected: boolean; windows: number; terminals: number; installable: boolean }>(response)).then(setVsCodeStatus).catch(() => undefined), []);

  useEffect(() => {
    refreshSessions();
    // The remote mobile surface intentionally cannot access repository,
    // event, discovery, or integration APIs — but GET /api/runs/attention
    // is the one deliberately narrow, remote-safe Run read it does poll
    // (see app.ts's isRemoteAllowedRoute and attention.ts's
    // deriveRunAttentionItems). Response validation above also makes the
    // brief pre-classification requests harmless if their 403s arrive late.
    if (connectionKind === 'remote') {
      refreshRunAttention();
      const background = setInterval(refreshRunAttention, 5000);
      return () => { clearInterval(background); };
    }
    refreshRepos(); refreshRuns(); refreshEvents(); refreshClaims(); refreshConflicts(); refreshDiscovery(); refreshVsCode();
    const background = setInterval(() => { refreshRepos(); refreshRuns(); refreshClaims(); refreshConflicts(); refreshDiscovery(); refreshVsCode(); }, 5000);
    return () => { clearInterval(background); };
  }, [connectionKind, refreshClaims, refreshConflicts, refreshDiscovery, refreshEvents, refreshRepos, refreshRunAttention, refreshRuns, refreshSessions, refreshVsCode]);

  useEffect(() => {
    if (connectionKind === 'remote') return;
    let disposed = false;
    apiFetch('/api/settings')
      .then((response) => response.ok ? response.json() as Promise<{ structuredAttemptsEnabled?: boolean }> : null)
      .then((body) => { if (!disposed && body) setStructuredAttemptsEnabled(Boolean(body.structuredAttemptsEnabled)); })
      .catch(() => undefined);
    return () => { disposed = true; };
  }, [connectionKind]);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout>;
    let disposed = false;
    const connect = () => {
      if (disposed) return;
      const storedToken = getStoredToken(tokenStorage());
      const wsUrl = storedToken
        ? `ws://${location.host}/ws?${TOKEN_QUERY_PARAM}=${encodeURIComponent(storedToken)}`
        : `ws://${location.host}/ws`;
      socket = new WebSocket(wsUrl);
      wsRef.current = socket;
      socket.addEventListener('open', () => {
        setWsReady(true);
        socket?.send(JSON.stringify({
          t: 'ui_presence',
          visible: document.visibilityState === 'visible' && document.hasFocus(),
        }));
        refreshSessions();
      });
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
    const presenceChanged = () => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          t: 'ui_presence',
          visible: document.visibilityState === 'visible' && document.hasFocus(),
        }));
      }
    };
    document.addEventListener('visibilitychange', presenceChanged);
    window.addEventListener('focus', presenceChanged);
    window.addEventListener('blur', presenceChanged);
    connect();
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', presenceChanged);
      window.removeEventListener('focus', presenceChanged);
      window.removeEventListener('blur', presenceChanged);
      clearTimeout(retry);
      socket?.close();
    };
  }, [refreshClaims, refreshConflicts, refreshSessions, upsertSession]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName ?? '');
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setPaletteOpen(true); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'l') { event.preventDefault(); setShowLaunch(true); }
      if (!typing && /^[1-9]$/.test(event.key)) {
        const session = sessions[Number(event.key) - 1];
        if (session) {
          setSelectedRunId(null);
          setSelectedId(session.id);
        }
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

  // Ticket 05: how the client discovers "you're remote, please enter a
  // token". The endpoint is reachable without a token, but this request
  // still carries a stored token so a returning phone can validate it and
  // proceed without prompting again. On loopback this always resolves to
  // 'local' and connectionGate never leaves 'ready'.
  useEffect(() => {
    let cancelled = false;
    fetchConnection()
      .then((body) => {
        if (cancelled) return;
        if (body.kind === 'remote') setConnectionKind('remote');
        if (body.kind === 'denied') setConnectionGate('denied');
        else if (body.kind === 'remote' && body.capabilities.length === 0) setConnectionGate('needs-token');
        else setConnectionGate('ready');
        // Ticket 12 AC6: present only for a resolved collaborator device —
        // drives whether MobileWorkspace offers launching/guiding Runs.
        setCollaboratorPrincipal(body.principal ?? null);
      })
      .catch(() => undefined); // can't reach the API at all — leave the normal error/reconnect paths to surface that
    return () => { cancelled = true; };
  }, []);

  // Ticket 12 AC1/AC6: a resolved collaborator device gets its own granted
  // Repositories and Profiles — GET /api/repos and GET /api/profiles are
  // already grant-filtered server-side (routes.ts/profile-routes.ts), so
  // this is the same shape refreshRepos would do for the desktop path,
  // just scoped to when there's actually a collaborator Principal to fetch
  // for. Re-fetches only once on identifying as a collaborator device —
  // grants rarely change mid-session, and the launch form re-opens fresh.
  useEffect(() => {
    if (!collaboratorPrincipal) return;
    let cancelled = false;
    Promise.all([
      apiFetch('/api/repos').then((response) => responseJsonArray<Repo>(response)).catch(() => []),
      apiFetch('/api/profiles').then((response) => responseJsonArray<Profile>(response)).catch(() => []),
    ]).then(([grantedRepos, grantedProfiles]) => {
      if (cancelled) return;
      setCollaboratorRepos(grantedRepos);
      setCollaboratorProfiles(grantedProfiles);
    });
    return () => { cancelled = true; };
  }, [collaboratorPrincipal]);

  const submitToken = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStoredToken(tokenStorage(), tokenInput.trim());
    try {
      const body = await fetchConnection();
      if (await finalizeRemoteAuthentication(body, refreshSessions, () => setError(null))) {
        setConnectionKind('remote');
        setTokenError(null);
        setConnectionGate('ready');
      } else {
        setTokenError('That token was not accepted. Check it and try again.');
      }
    } catch {
      setTokenError('Could not reach AgentDeck to check the token.');
    }
  };

  // Ticket 11 AC1: exchanges the one-time invitation code the bootstrap
  // admin issued for this device's own bearer token (collaborators.ts
  // stores it exactly like the shared tailnet token), then re-checks
  // GET /api/connection the same way submitToken does above.
  const submitInvitation = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = await exchangeInvitationCode(inviteCode.trim(), deviceLabel.trim());
    if (!result.ok) { setInviteError(result.error); return; }
    try {
      const body = await fetchConnection();
      if (await finalizeRemoteAuthentication(body, refreshSessions, () => setError(null))) {
        setConnectionKind('remote');
        setInviteError(null);
        setConnectionGate('ready');
      } else {
        setInviteError('The device credential was not accepted.');
      }
    } catch {
      setInviteError('Could not reach AgentDeck to confirm the device.');
    }
  };

  const selectSession = (session: Session) => { setSelectedRunId(null); setSelectedId(session.id); };
  const selectRun = (run: WorkRun) => { setSelectedId(null); setSelectedRunId(run.id); setView('operations'); };
  const openTerminal = (session: Session) => { setSelectedRunId(null); setSelectedId(session.id); setView('terminal'); setTerminalVisited(true); };

  const prepareRun = async (run: WorkRun) => {
    const response = await apiFetch(`/api/runs/${encodeURIComponent(run.id)}/prepare`, { method: 'POST' });
    const body = await response.json() as WorkRun & { error?: string };
    if (!response.ok) return setError(body.error ?? 'Run preparation failed.');
    setRuns((current) => current.map((item) => item.id === body.id ? body : item));
  };

  const startRun = async (run: WorkRun) => {
    const response = await apiFetch(`/api/runs/${encodeURIComponent(run.id)}/start`, { method: 'POST' });
    const body = await response.json() as WorkRun & { error?: string };
    if (!response.ok) return setError(body.error ?? 'Starting the Attempt failed.');
    setRuns((current) => current.map((item) => item.id === body.id ? body : item));
  };

  const runRecoveryAction = async (run: WorkRun, actionName: 'apply' | 'reverify') => {
    const response = await apiFetch(`/api/runs/${encodeURIComponent(run.id)}/${actionName}`, { method: 'POST' });
    const body = await response.json() as WorkRun & { error?: string };
    if (!response.ok) return setError(body.error ?? `Run ${actionName} failed.`);
    setRuns((current) => current.map((item) => item.id === body.id ? body : item));
  };

  // Ticket 13 AC2: the admin's explicit authorization of an external effect
  // — the request blocks until publication reaches a settled state, and the
  // returned Run carries the durable publication record whatever it is.
  const publishRun = async (run: WorkRun, target: PublicationTarget) => {
    const response = await apiFetch(`/api/runs/${encodeURIComponent(run.id)}/publish`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target }),
    });
    const body = await response.json() as WorkRun & { error?: string };
    if (!response.ok) return setError(body.error ?? 'Publishing the Run result failed.');
    setRuns((current) => current.map((item) => item.id === body.id ? body : item));
  };

  // Ticket 07 AC2: the one Work Engine policy path every transport's
  // approve/deny/provide-input command reaches — this is the REST call both
  // the local desktop RunWorkspace and the mobile attention card make.
  const resolveRunAttention = async (runId: string, attentionId: string, decision: AttentionDecisionInput) => {
    const action = decision.kind === 'approve' ? 'approve' : decision.kind === 'deny' ? 'deny' : 'input';
    const response = await apiFetch(`/api/runs/${encodeURIComponent(runId)}/attention/${encodeURIComponent(attentionId)}/${action}`, {
      method: 'POST',
      ...(decision.kind === 'input'
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: decision.value }) }
        : {}),
    });
    if (connectionKind === 'remote') {
      if (response.ok) setRunAttention((current) => current.filter((item) => item.attentionId !== attentionId));
      else setError((await response.json().catch(() => ({}))).error ?? 'Could not resolve the pending Run attention.');
      return;
    }
    const body = await response.json() as WorkRun & { error?: string };
    if (!response.ok) return setError(body.error ?? 'Could not resolve the pending Run attention.');
    setRuns((current) => current.map((item) => item.id === body.id ? body : item));
  };

  const deleteRun = async (run: WorkRun) => {
    const response = await apiFetch(`/api/runs/${encodeURIComponent(run.id)}`, { method: 'DELETE' });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      setError(body.error ?? 'Deleting the Run failed.');
      return;
    }
    setRuns((current) => current.filter((item) => item.id !== run.id));
    setSelectedRunId((current) => current === run.id ? null : current);
  };

  const deleteSession = async (session: Session) => {
    const response = await apiFetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      setError(body.error ?? 'Deleting the session failed.');
      return;
    }
    setSessions((current) => current.filter((item) => item.id !== session.id));
    setSelectedId((current) => current === session.id ? null : current);
  };

  const action = async (session: Session, actionName: 'stop' | 'restart' | 'focus') => {
    const response = await apiFetch(`/api/sessions/${encodeURIComponent(session.id)}/${actionName}`, { method: 'POST' });
    const body = await response.json() as Session & { error?: string };
    if (!response.ok) return setError(body.error ?? `${actionName} failed.`);
    if (actionName === 'restart') upsertSession(body);
  };

  const rename = async (session: Session, name: string) => {
    const response = await apiFetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name.trim() }),
    });
    const body = await response.json() as Session & { error?: string };
    if (!response.ok) setError(body.error ?? 'Rename failed.'); else upsertSession(body);
  };

  const retryDiscovery = async () => {
    setDiscoveryStatus((current) => current ? { ...current, polling: true } : current);
    await apiFetch('/api/discovery/refresh', { method: 'POST' }).catch(() => undefined);
    refreshDiscovery(); refreshSessions();
  };

  const installHooks = async () => {
    const repo = repos.find((item) => item.path === selectedRepoPath) ?? repos[0];
    if (!repo) return setError('No repository is available for hook installation.');
    const response = await apiFetch('/api/hooks/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repoPath: repo.path, user: true }) });
    const body = await response.json() as { error?: string };
    setError(response.ok ? `Hooks installed for ${repo.name}. Restart active sessions to apply them.` : body.error ?? 'Hook installation failed.');
  };

  // Ticket 05: minimal, unstyled-is-fine gate for a remote connection that
  // hasn't entered its token yet (or was denied outright). Ticket 13 builds
  // the real mobile UI on top of this; this only needs to work. The
  // ordinary loopback case never reaches here — connectionGate stays
  // 'ready' from the initial render.
  if (connectionGate === 'denied') {
    return (
      <div className="agentdeck-shell">
        <p>Access denied. This host is not allowed to reach AgentDeck.</p>
      </div>
    );
  }
  if (connectionGate === 'needs-token') {
    return (
      <div className="agentdeck-shell">
        {authMode === 'token' ? (
          <form onSubmit={(event) => { void submitToken(event); }}>
            <label htmlFor="agentdeck-token-input">Enter access token</label>
            <input
              autoFocus
              id="agentdeck-token-input"
              onChange={(event) => setTokenInput(event.target.value)}
              type="password"
              value={tokenInput}
            />
            <button type="submit">Continue</button>
            {tokenError && <p role="alert">{tokenError}</p>}
            <button onClick={() => setAuthMode('invitation')} type="button">Have an invitation code instead?</button>
          </form>
        ) : (
          <form onSubmit={(event) => { void submitInvitation(event); }}>
            <label htmlFor="agentdeck-invite-code-input">Invitation code</label>
            <input
              autoFocus
              id="agentdeck-invite-code-input"
              onChange={(event) => setInviteCode(event.target.value)}
              value={inviteCode}
            />
            <label htmlFor="agentdeck-device-label-input">This device&rsquo;s name</label>
            <input
              id="agentdeck-device-label-input"
              onChange={(event) => setDeviceLabel(event.target.value)}
              placeholder="e.g. My phone"
              value={deviceLabel}
            />
            <button type="submit">Continue</button>
            {inviteError && <p role="alert">{inviteError}</p>}
            <button onClick={() => setAuthMode('token')} type="button">Have an access token instead?</button>
          </form>
        )}
      </div>
    );
  }

  // Ticket 13: a remote (phone) connection gets the reflowed mobile view
  // instead of the desktop workspace tree below — no session sidebar,
  // Mission Control grid, or inspector rail, none of which fit a phone
  // screen or apply to a connection that never receives raw PTY bytes. The
  // local/desktop path below this is otherwise completely untouched.
  if (connectionKind === 'remote') {
    return (
      <div className="mobile-shell">
        {error && <div className="global-banner"><span>{error}</span><button onClick={() => setError(null)} type="button">×</button></div>}
        <MobileWorkspace
          collaboratorPrincipal={collaboratorPrincipal}
          collaboratorProfiles={collaboratorProfiles}
          collaboratorRepos={collaboratorRepos}
          onError={setError}
          onResolveRunAttention={resolveRunAttention}
          onSelect={selectSession}
          runAttention={runAttention}
          session={selected}
          sessions={sessions}
          ws={wsRef.current}
          wsReady={wsReady}
        />
      </div>
    );
  }

  return (
    <div className="agentdeck-shell">
      <header className="app-topbar">
        <div className="app-brand"><span className="brand-mark"><i /></span><strong>AgentDeck</strong></div>
        <nav className="workspace-tabs" aria-label="Workspace views">
          {WORKSPACE_VIEWS.map((item) => <button className={view === item.id ? 'is-active' : ''} key={item.id} onClick={() => setView(item.id)} type="button">{item.label}{item.id === 'changes' && changeCount > 0 && <span>{changeCount}</span>}{item.id === 'history' && historySessions.length > 0 && <span>{historySessions.length}</span>}</button>)}
        </nav>
        <button className="jump-control" onClick={() => setPaletteOpen(true)} type="button"><span>&gt;_</span><strong>Jump to session, file, or action…</strong><kbd>⌘K</kbd></button>
        <div className="topbar-actions">
          <span className={`live-indicator${wsReady ? '' : ' is-down'}`}><i />{wsReady ? 'live' : 'reconnecting'}</span>
          <ThemeControl />
          <button aria-label="Settings" className="top-icon-button" onClick={() => setShowSettings(true)} title="Settings — summary model default and API key" type="button">⚙</button>
          <button className="button compact-button" onClick={() => void installHooks()} type="button">Install hooks</button>
          <button className="button compact-button" onClick={() => setShowRunSubmission(true)} type="button">New run</button>
          <button className="button button-primary launch-button" onClick={() => setShowLaunch(true)} type="button">Launch agent <kbd>⌘L</kbd></button>
        </div>
      </header>

      {error && <div className="global-banner"><span>{error}</span><button onClick={() => setError(null)} type="button">×</button></div>}

      <div className="app-body">
        <SessionSidebar discoveryStatus={discoveryStatus} onDeleteRun={(run) => void deleteRun(run)} onLaunch={() => setShowLaunch(true)} onRefreshDiscovery={() => void retryDiscovery()} onSelect={selectSession} onSelectRun={selectRun} onSubmitRun={() => setShowRunSubmission(true)} repos={repos} runs={runs} selectedId={selectedRun ? null : selectedId} selectedRunId={selectedRunId} sessions={railSessions} />
        <main className="workspace-stage">
          <div className={view === 'operations' ? 'workspace-layer is-active' : 'workspace-layer'}>{selectedRun ? <RunWorkspace onApply={(run) => void runRecoveryAction(run, 'apply')} onDelete={(run) => void deleteRun(run)} onPrepare={prepareRun} onPublish={publishRun} onResolveAttention={(run, attentionId, decision) => void resolveRunAttention(run.id, attentionId, decision)} onReverify={(run) => void runRecoveryAction(run, 'reverify')} onStart={startRun} onViewChanges={() => setView('changes')} run={selectedRun} structuredAttemptsEnabled={structuredAttemptsEnabled} /> : <OperationsView conflicts={conflicts} events={events} onOpenTerminal={openTerminal} onSelect={selectSession} repos={repos} selected={selected} sessions={sessions} />}</div>
          {terminalVisited && <div className={view === 'terminal' ? 'workspace-layer is-active' : 'workspace-layer'}><TerminalWorkspace onError={setError} onFocusExternal={(session) => void action(session, 'focus')} session={selected} sessions={sessions} ws={wsRef.current} wsReady={wsReady} /></div>}
          <div className={view === 'changes' ? 'workspace-layer is-active' : 'workspace-layer'}><ChangesWorkspace claims={claims} onError={setError} repoPath={changesRepoPath} sessions={sessions} /></div>
          <div className={view === 'grid' ? 'workspace-layer is-active' : 'workspace-layer'}><GridView onOpen={openTerminal} sessions={sessions} ws={wsRef.current} /></div>
          <div className={view === 'signals' ? 'workspace-layer is-active' : 'workspace-layer'}><SignalsView events={events} /></div>
          <div className={view === 'history' ? 'workspace-layer is-active' : 'workspace-layer'}><HistoryView onDelete={(session) => void deleteSession(session)} repos={repos} sessions={historySessions} /></div>
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
            <InspectorRail conflicts={conflicts} events={events} onAction={(session, actionName) => void action(session, actionName)} onError={setError} onRename={(session, name) => void rename(session, name)} onView={setView} selected={selectedRun ? null : selected} view={view} />
          </div>
        </div>
      </div>

      <footer className="app-statusbar">
        <span className={wsReady ? 'is-live' : ''}><i />{wsReady ? 'Live' : 'Offline'}</span>
        <span>AgentDeck v0.1.0</span>
        <span>▣ {selectedRun ? selectedRun.spec.repository.name : selected ? selected.cwd.split('/').pop() : `${repos.length} repos`}</span>
        {repos.some((repo) => repo.isDirty) && <span className="is-dirty"><i />Worktree dirty</span>}
        <span className="status-ticker">{events.slice(-3).reverse().map((event) => `${event.agent} · ${event.event}${event.task ? ` · ${event.task}` : ''}`).join('      ') || 'Waiting for coordination signals'}</span>
        <Clock />
        <span>API status <i className={wsReady ? 'api-ok' : ''} /></span>
      </footer>

      <CommandPalette onClose={() => setPaletteOpen(false)} onLaunch={() => setShowLaunch(true)} onSelectSession={(session) => { selectSession(session); setView('operations'); }} onView={setView} open={paletteOpen} repos={repos} sessions={sessions} />
      {showLaunch && <LaunchModal onClose={() => setShowLaunch(false)} onLaunched={(session) => { upsertSession(session); setSelectedRunId(null); setSelectedId(session.id); setShowLaunch(false); setView('terminal'); setTerminalVisited(true); refreshRepos(); }} repos={repos} />}
      {showRunSubmission && <RunSubmissionModal onClose={() => setShowRunSubmission(false)} onError={setError} onSubmitted={(run) => { setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]); selectRun(run); setShowRunSubmission(false); }} repos={repos} />}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} repos={repos} />}
    </div>
  );
}
