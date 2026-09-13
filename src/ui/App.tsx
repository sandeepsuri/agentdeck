import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentMessage, CollaboratorSession, Conflict, DiscoveryStatus, FileClaim, Repo, RunAttentionItem, Session,
} from '../types.js';
import type {
  AttentionDecisionInput, CollaboratorRunSummary, Profile, PublicationTarget, WorkRun,
} from '../work-engine/types.js';
import { deriveRunCompanionSessions } from '../work-engine/run-companion-session.js';
import { TOKEN_QUERY_PARAM, type ServerFrame } from '../protocol.js';
import { apiFetch, type ConnectionInfo, fetchConnection, responseJson, responseJsonArray } from './apiFetch.js';
import { adminRepos, adminRuns, adminSessions } from './adminProjection.js';
import { listCollaboratorRuns, type CollaboratorListState } from './collaboratorRuns.js';
import { listCollaboratorSessions } from './collaboratorSessions.js';
import { getStoredToken, setStoredToken, tokenStorage } from './connection.js';
import { exchangeInvitationCode } from './collaborators.js';
import { LaunchModal } from './components/LaunchModal.js';
import { SettingsWorkspace } from './components/SettingsWorkspace.js';
import { StartWorkModal, type StartWorkDraft } from './components/StartWorkModal.js';
import { deriveNeedsYou, type NeedsYouItem } from './needsYou.js';
import {
  inspectorPreferenceStorage, persistInspectorCollapsed, persistWorkLayout, readInspectorCollapsed, readWorkLayout, type WorkLayout,
} from './preferences.js';
import { THEME_OPTIONS, useTheme } from './theme.js';
import { useRateLimits, useRunReviewStates } from './useAttentionSources.js';
import { deriveWorkItems, type WorkFilters, type WorkItem } from './workItems.js';
import { AdminSidebar, type RepositoryActivity } from './workspace/AdminSidebar.js';
import { CommandPalette } from './workspace/CommandPalette.js';
import { HomeView } from './workspace/HomeView.js';
import { INITIAL_HISTORY_WITNESS_STATE, advanceHistoryWitnessState, splitSessionsForRail } from './workspace/history.js';
import { InspectorRail } from './workspace/InspectorRail.js';
import { MobileWorkspace } from './workspace/MobileWorkspace.js';
import { ReviewView, type ReviewTarget } from './workspace/ReviewView.js';
import { RunWorkspace } from './workspace/RunWorkspace.js';
import { UsageView } from './workspace/UsageView.js';
import { TerminalWorkspace } from './workspace/TerminalWorkspace.js';
import { WorkView } from './workspace/WorkView.js';
import { sessionLabel, useNow, type WorkspaceView, WORKSPACE_VIEWS } from './workspace/model.js';
import { isInspectorRelevant, parseInitialNavigation } from './navigation.js';
import { finalizeRemoteAuthentication, resolveConnectionState } from './remote-auth.js';

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
      <button aria-expanded={open} aria-haspopup="menu" aria-label={`Appearance: ${selected.label}`} className="top-icon-button" onClick={() => setOpen((current) => !current)} title={`Appearance: ${selected.label}`} type="button">{selected.glyph}</button>
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
  const [view, setView] = useState<WorkspaceView>(initialNavigation.view ?? 'home');
  // Redesign spec §06: Work shows its list until a piece of work is opened;
  // a Session and a Run open into the same Work destination.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [workFilters, setWorkFilters] = useState<WorkFilters>({ status: 'all' });
  const [workLayout, setWorkLayout] = useState<WorkLayout>(() => readWorkLayout(inspectorPreferenceStorage()));
  const [reviewTarget, setReviewTarget] = useState<ReviewTarget | null>(null);
  const [showStartWork, setShowStartWork] = useState(false);
  const [advancedLaunch, setAdvancedLaunch] = useState<StartWorkDraft | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsVisited, setSettingsVisited] = useState(false);
  useEffect(() => { if (showSettings) setSettingsVisited(true); }, [showSettings]);
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
  /** Kept apart from `runs` above: a collaborator device receives the narrowed projection (server/collaborator-run-view.ts), not a WorkRun, and the desktop's deep-link/selection logic reads `runs` expecting the full shape. */
  const [collaboratorRuns, setCollaboratorRuns] = useState<CollaboratorRunSummary[]>([]);
  const [collaboratorRunListState, setCollaboratorRunListState] = useState<CollaboratorListState>('loading');
  const [collaboratorRepositoryListState, setCollaboratorRepositoryListState] = useState<CollaboratorListState>('loading');
  /** Kept apart from `sessions` above for the same reason: GET /api/sessions answers a collaborator device with CollaboratorSession (server/collaborator-session-view.ts), which has no cwd, worktreePath, pid or launchSpec — the desktop tree reads `sessions` expecting all of them. */
  const [collaboratorSessions, setCollaboratorSessions] = useState<CollaboratorSession[]>([]);

  const selected = useMemo(() => sessions.find((session) => session.id === selectedId) ?? null, [selectedId, sessions]);
  const selectedRun = useMemo(() => runs.find((run) => run.id === selectedRunId) ?? null, [runs, selectedRunId]);
  const activeRepositoryId = workFilters.repositoryId ?? null;
  // Ticket 68 (B13): live, derived, admin-only — never stored, never a
  // claim that a companion Session is this Run's own terminal.
  const companionSessions = useMemo(
    () => selectedRun ? deriveRunCompanionSessions(selectedRun, sessions) : [],
    [selectedRun, sessions],
  );
  const inspectorRelevant = !showSettings && isInspectorRelevant(view, Boolean(selected) && !selectedRun);
  const pageTitle = showSettings
    ? 'Settings & access'
    : view === 'work' && selectedRun
      ? selectedRun.spec.objective
      : view === 'work' && selected
        ? sessionLabel(selected)
        : WORKSPACE_VIEWS.find((item) => item.id === view)?.label ?? 'Workspace';
  // A14: Settings is an additional workspace-stage layer, not a `view` of
  // its own (it isn't a sidebar destination) — so a given view's layer is
  // active only while Settings isn't showing, and Settings' own layer is
  // active exactly when it is. This keeps whatever `view` was open
  // underneath fully intact (mounted, unchanged) while Settings is shown,
  // so leaving it is a plain visibility flip, not a re-navigation.
  const layerClass = (id: WorkspaceView) => (!showSettings && view === id ? 'workspace-layer is-active' : 'workspace-layer');

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
    .then((response) => responseJsonArray<Session>(response)).then((all) => {
      const body = adminSessions(all);
      setSessions(body);
      setError(null);
      const requested = requestedSessionIdRef.current;
      if (requested) {
        requestedSessionIdRef.current = undefined;
        history.replaceState(null, '', location.pathname);
        if (body.some((session) => session.id === requested)) {
          setSelectedRunId(null);
          setSelectedId(requested);
          setTerminalVisited(true);
        }
        setView('work');
        return;
      }
      setSelectedId((current) => current && body.some((session) => session.id === current) ? current : null);
    }).catch(() => setError('AgentDeck API is unreachable.')), []);
  const refreshRepos = useCallback(() => apiFetch('/api/repos').then((response) => responseJsonArray<Repo>(response)).then((all) => setRepos(adminRepos(all))).catch(() => undefined), []);
  const refreshRuns = useCallback(() => apiFetch('/api/runs').then((response) => responseJsonArray<WorkRun>(response)).then((all) => {
    const body = adminRuns(all);
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
      setView('work');
    }
  }).catch(() => undefined), []);
  const refreshRunAttention = useCallback(() => apiFetch('/api/runs/attention').then((response) => responseJsonArray<RunAttentionItem>(response)).then(setRunAttention).catch(() => undefined), []);
  const refreshCollaboratorRuns = useCallback(() => listCollaboratorRuns().then((next) => {
    setCollaboratorRuns(next);
    setCollaboratorRunListState('ready');
  }).catch(() => setCollaboratorRunListState('error')), []);
  const refreshCollaboratorSessions = useCallback(() => listCollaboratorSessions().then(setCollaboratorSessions).catch(() => undefined), []);
  // Ticket 12 AC1/AC6: a resolved collaborator device gets its own granted
  // Repositories and Profiles — GET /api/repos and GET /api/profiles are
  // already grant-filtered (and, for Repositories, narrowed) server-side, so
  // this is the same shape refreshRepos would do for the desktop path, just
  // scoped to when there's actually a collaborator Principal to fetch for.
  // Polled rather than fetched once: the Repository drawer is now the
  // collaborator's persistent navigation, so a grant revoked mid-session has
  // to stop appearing in it.
  const refreshCollaboratorGrants = useCallback(() => Promise.all([
    apiFetch('/api/repos').then((response) => responseJsonArray<Repo>(response)).then((grantedRepos) => {
      setCollaboratorRepos(grantedRepos);
      setCollaboratorRepositoryListState('ready');
    }).catch(() => setCollaboratorRepositoryListState('error')),
    // Profile loading keeps its previous behavior: a failed refresh exposes
    // no request Profile choices. Crucially, it cannot now suppress an
    // independently successful Repository revocation response.
    apiFetch('/api/profiles').then((response) => responseJsonArray<Profile>(response)).catch(() => []).then(setCollaboratorProfiles),
  ]).then(() => undefined), []);
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
      // A named collaborator device also polls its own Run list, and its
      // grants alongside it. The `collaboratorPrincipal` guard is
      // load-bearing, not cosmetic: GET /api/runs, /api/repos and
      // /api/profiles are on isCollaboratorAllowedRoute ONLY, so the admin's
      // own phone (the legacy shared token, no Principal) would 403 on all
      // three every tick. Re-reading the grants each time is also how a
      // revoked Repository stops appearing in the drawer mid-session —
      // enforcement was always server-side, but the display used to go
      // stale until reload.
      const refreshCollaborator = () => {
        refreshRunAttention();
        if (!collaboratorPrincipal) return;
        refreshCollaboratorRuns();
        refreshCollaboratorGrants();
        // The admin's own phone keeps its session list current from WS
        // 'session_update' frames, but ws.ts excludes a collaborator socket
        // from both session broadcasts (and 'attach'), so this list is only
        // ever as fresh as the last poll. GET /api/sessions is grant-scoped
        // and narrowed for a collaborator device (collaborator-session-view.ts).
        refreshCollaboratorSessions();
      };
      refreshCollaborator();
      const background = setInterval(refreshCollaborator, collaboratorPrincipal ? 3000 : 5000);
      return () => { clearInterval(background); };
    }
    refreshRepos(); refreshRuns(); refreshEvents(); refreshClaims(); refreshConflicts(); refreshDiscovery(); refreshVsCode();
    const background = setInterval(() => { refreshRepos(); refreshRuns(); refreshClaims(); refreshConflicts(); refreshDiscovery(); refreshVsCode(); }, 5000);
    return () => { clearInterval(background); };
  }, [collaboratorPrincipal, connectionKind, refreshClaims, refreshCollaboratorGrants, refreshCollaboratorRuns, refreshCollaboratorSessions, refreshConflicts, refreshDiscovery, refreshEvents, refreshRepos, refreshRunAttention, refreshRuns, refreshSessions, refreshVsCode]);

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
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'l') { event.preventDefault(); setShowStartWork(true); }
      if (!typing && /^[1-9]$/.test(event.key)) {
        const session = sessions[Number(event.key) - 1];
        if (session) {
          setShowSettings(false);
          setSelectedRunId(null);
          setSelectedId(session.id);
          setView('work');
          setTerminalVisited(true);
        }
      }
      if (event.key === 'Escape') setPaletteOpen(false);
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [sessions]);

  useEffect(() => {
    persistInspectorCollapsed(inspectorPreferenceStorage(), inspectorCollapsed);
  }, [inspectorCollapsed]);

  useEffect(() => {
    persistWorkLayout(inspectorPreferenceStorage(), workLayout);
  }, [workLayout]);

  // The global Needs You system (redesign spec §04) — one derivation feeding
  // Home, the sidebar badge and Work's "Needs you" filter.
  const desktop = connectionKind === 'local';
  const { reviewStates, refreshReviewState } = useRunReviewStates(runs, desktop);
  const rateLimits = useRateLimits(desktop);
  const needsYou = useMemo(
    () => deriveNeedsYou({ runs, sessions: railSessions, conflicts, reviewStates, rateLimits }),
    [conflicts, railSessions, rateLimits, reviewStates, runs],
  );
  const workItems = useMemo(
    () => deriveWorkItems({ runs, sessions: railSessions, historySessions, repos, needsYou, reviewStates }),
    [historySessions, needsYou, railSessions, repos, reviewStates, runs],
  );
  const reviewCount = needsYou.filter((item) => item.kind === 'review').length;
  const repositoryActivity = useMemo(() => {
    const activity = new Map<string, RepositoryActivity>();
    for (const item of workItems) {
      if (!item.repositoryId || (item.bucket !== 'working' && item.bucket !== 'needs_you')) continue;
      const current = activity.get(item.repositoryId) ?? { active: 0, waiting: 0 };
      activity.set(item.repositoryId, { active: current.active + 1, waiting: current.waiting + (item.bucket === 'needs_you' ? 1 : 0) });
    }
    return activity;
  }, [workItems]);

  // Three places learn this connection's identity — the probe below and
  // both gate submissions — and every one of them has to apply it the same
  // way. They used to diverge: submitToken/submitInvitation set the gate
  // but dropped `principal`, so a collaborator who had just redeemed an
  // invitation code stayed on the admin's session view until a full reload
  // (MobileWorkspace forks on collaboratorPrincipal). One helper, three
  // callers, so they cannot drift again.
  const applyConnection = useCallback((body: ConnectionInfo) => {
    const { kind, gate, principal } = resolveConnectionState(body);
    if (kind === 'remote') setConnectionKind('remote');
    setConnectionGate(gate);
    // Ticket 12 AC6: present only for a resolved collaborator device —
    // drives whether MobileWorkspace renders the collaborator workspace at
    // all, and which Repositories/Profiles it offers work in.
    setCollaboratorPrincipal(principal);
  }, []);

  // A device can hold exactly one credential, and the gate is only
  // reachable while GET /api/connection reports zero capabilities — so a
  // phone handed the shared tailnet token first could never reach the
  // invitation-code form again without clearing localStorage by hand.
  // Dropping the stored credential and re-gating is the only way to change
  // identity on a device; the server-side classification is unchanged.
  const signOut = useCallback(() => {
    setStoredToken(tokenStorage(), '');
    setCollaboratorPrincipal(null);
    setCollaboratorRepos([]);
    setCollaboratorProfiles([]);
    setCollaboratorRuns([]);
    setCollaboratorRunListState('loading');
    setCollaboratorRepositoryListState('loading');
    setCollaboratorSessions([]);
    setSessions([]);
    setRunAttention([]);
    setError(null);
    setTokenInput('');
    setTokenError(null);
    setInviteCode('');
    setInviteError(null);
    setAuthMode('token');
    setConnectionGate('needs-token');
  }, []);

  // Ticket 05: how the client discovers "you're remote, please enter a
  // token". The endpoint is reachable without a token, but this request
  // still carries a stored token so a returning phone can validate it and
  // proceed without prompting again. On loopback this always resolves to
  // 'local' and connectionGate never leaves 'ready'.
  useEffect(() => {
    let cancelled = false;
    fetchConnection()
      .then((body) => { if (!cancelled) applyConnection(body); })
      .catch(() => undefined); // can't reach the API at all — leave the normal error/reconnect paths to surface that
    return () => { cancelled = true; };
  }, [applyConnection]);


  const submitToken = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStoredToken(tokenStorage(), tokenInput.trim());
    try {
      const body = await fetchConnection();
      if (await finalizeRemoteAuthentication(body, refreshSessions, () => setError(null))) {
        applyConnection(body);
        setTokenError(null);
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
        applyConnection(body);
        setInviteError(null);
      } else {
        setInviteError('The device credential was not accepted.');
      }
    } catch {
      setInviteError('Could not reach AgentDeck to confirm the device.');
    }
  };

  const selectSession = (session: Pick<Session, 'id'>) => { setSelectedRunId(null); setSelectedId(session.id); };
  // Every entry point (Home, Work, sidebar, command palette, deep links)
  // opens the same Run or Session detail inside Work.
  const selectRun = (run: Pick<WorkRun, 'id'>) => { setShowSettings(false); setSelectedId(null); setSelectedRunId(run.id); setView('work'); };
  const openSession = (session: Pick<Session, 'id'>) => { setShowSettings(false); selectSession(session); setView('work'); setTerminalVisited(true); };
  const closeWorkDetail = () => { setSelectedId(null); setSelectedRunId(null); };
  const openWorkItem = (item: WorkItem) => (item.run ? selectRun(item.run) : item.session ? openSession(item.session) : undefined);
  const selectRepository = (repositoryId: string) => {
    setShowSettings(false);
    closeWorkDetail();
    setWorkFilters((current) => ({ ...current, repositoryId: current.repositoryId === repositoryId && view === 'work' ? null : repositoryId }));
    setView((current) => current === 'review' ? 'review' : 'work');
  };
  const openNeedsYou = (item: NeedsYouItem) => {
    const { target } = item;
    if (target.kind === 'usage') return navigateToView('usage');
    if (target.kind === 'repository') {
      const repo = repos.find((candidate) => candidate.id === target.repositoryId || candidate.path === target.repositoryId);
      if (repo) { setShowSettings(false); setReviewTarget({ kind: 'repository', repositoryId: repo.id }); setView('review'); }
      return;
    }
    if (target.kind === 'session') return openSession({ id: target.sessionId });
    if (item.kind === 'review') { setShowSettings(false); setReviewTarget({ kind: 'run', runId: target.runId }); setView('review'); return; }
    selectRun({ id: target.runId });
  };
  // A14: these are the two navigation surfaces that stay reachable while the
  // Settings workspace is open (AdminSidebar, always visible; CommandPalette,
  // reachable via ⌘K) — every view layer that could otherwise call this is
  // itself hidden behind `!showSettings` (App.tsx's workspace-stage), so
  // leaving Settings here is exactly the "navigate elsewhere" case, never a
  // stray reset of an in-progress view.
  const navigateToView = (nextView: WorkspaceView) => {
    setShowSettings(false);
    // Choosing Work from navigation always lands on the list, never a stale detail.
    if (nextView === 'work' && view === 'work') closeWorkDetail();
    setView(nextView);
  };

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

  // Ticket 68 (B12): a genuinely new Attempt — its own route
  // (POST /api/runs/:id/attempts), never overloading startRun above.
  const retryAttempt = async (run: WorkRun) => {
    const response = await apiFetch(`/api/runs/${encodeURIComponent(run.id)}/attempts`, { method: 'POST' });
    const body = await response.json() as WorkRun & { error?: string };
    if (!response.ok) return setError(body.error ?? 'Starting a new Attempt failed.');
    setRuns((current) => current.map((item) => item.id === body.id ? body : item));
  };

  // Ticket 70 (B10): mints an ephemeral, loopback-only preview session and
  // opens it in a new tab — deliberately never an iframe, so no change to
  // this dashboard's own Content-Security-Policy is needed.
  const previewRun = async (run: WorkRun, previewPath: string) => {
    const response = await apiFetch(`/api/runs/${encodeURIComponent(run.id)}/preview`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: previewPath }),
    });
    const body = await response.json() as { previewUrl?: string; error?: string };
    if (!response.ok || !body.previewUrl) return setError(body.error ?? 'Starting the preview failed.');
    window.open(body.previewUrl, '_blank');
  };

  // Ticket 54 (B11): requests pause/resume against the existing engine's
  // safe-boundary controls (work-routes.ts's POST .../pause and .../resume).
  // The Run state shown afterward is always the server's response body —
  // never a locally-guessed "paused" label — so a refusal, a completion
  // that beat the request, or a pause that hasn't reached its safe boundary
  // yet all render exactly what the engine actually did.
  const guideRun = async (run: WorkRun, actionName: 'pause' | 'resume') => {
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
    const repo = repos.find((item) => item.id === activeRepositoryId) ?? repos[0];
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
  //
  // A named collaborator (collaboratorPrincipal set) instead gets the same
  // admin-style shell class as the desktop tree below — CollaboratorWorkspace
  // (rendered inside MobileWorkspace) supplies its own sidebar/topbar/content
  // structure now (parent issue #37's redesign pass), so it needs the
  // .agentdeck-shell flex-column ancestor that shell expects. The admin's own
  // phone, on the legacy shared token with no Principal, keeps the
  // .mobile-shell it always had.
  if (connectionKind === 'remote') {
    return (
      <div className={collaboratorPrincipal ? 'agentdeck-shell collab-shell' : 'mobile-shell'}>
        {error && <div className="global-banner"><span>{error}</span><button onClick={() => setError(null)} type="button">×</button></div>}
        <MobileWorkspace
          appearanceControl={<ThemeControl />}
          collaboratorPrincipal={collaboratorPrincipal}
          collaboratorProfiles={collaboratorProfiles}
          collaboratorRepos={collaboratorRepos}
          collaboratorRuns={collaboratorRuns}
          collaboratorRunListState={collaboratorRunListState}
          collaboratorRepositoryListState={collaboratorRepositoryListState}
          collaboratorSessions={collaboratorSessions}
          onError={setError}
          onResolveRunAttention={resolveRunAttention}
          onRunsStale={refreshCollaboratorRuns}
          onSelect={selectSession}
          onSignOut={signOut}
          runAttention={runAttention}
          session={selected}
          sessions={sessions}
          ws={wsRef.current}
          wsReady={wsReady}
        />
      </div>
    );
  }

  const workDetailOpen = Boolean(selectedRun) || Boolean(selected);
  return (
    <div className="agentdeck-shell">
      <div className="admin-shell-main">
        <AdminSidebar
          activeRepositoryId={activeRepositoryId}
          activeView={view}
          needsYouCount={needsYou.length}
          onSelectRepository={selectRepository}
          onSettings={() => setShowSettings(true)}
          onStartWork={() => setShowStartWork(true)}
          onView={navigateToView}
          repos={repos}
          repositoryActivity={repositoryActivity}
          reviewCount={reviewCount}
          settingsActive={showSettings}
        />
        <div className="admin-shell-content">
      <header className="app-topbar">
        <div className="topbar-context"><strong title={pageTitle}>{pageTitle}</strong></div>
        <button className="jump-control" onClick={() => setPaletteOpen(true)} type="button"><span>⌕</span><strong>Search work, repositories, or actions…</strong><kbd>⌘K</kbd></button>
        <div className="topbar-actions">
          <span className={`live-indicator${wsReady ? '' : ' is-down'}`}><i />{wsReady ? 'live' : 'reconnecting'}</span>
          <ThemeControl />
        </div>
      </header>

      {error && <div className="global-banner"><span>{error}</span><button onClick={() => setError(null)} type="button">×</button></div>}

      <div className="app-body">
        <main className="workspace-stage">
          <div className={layerClass('home')}>
            <HomeView
              active={!showSettings && view === 'home'}
              needsYou={needsYou}
              onOpenNeedsYou={openNeedsYou}
              onOpenUsage={() => navigateToView('usage')}
              onOpenWorkItem={openWorkItem}
              onResolveRunAttention={resolveRunAttention}
              onSelectRepository={selectRepository}
              onStartWork={() => setShowStartWork(true)}
              rateLimits={rateLimits}
              repos={repos}
              repositoryActivity={repositoryActivity}
              runs={runs}
              workItems={workItems}
            />
          </div>
          <div className={layerClass('work')}>
            <div className="work-layer-list" hidden={workDetailOpen}>
              <WorkView
                events={events}
                filters={workFilters}
                items={workItems}
                layout={workLayout}
                onFiltersChange={setWorkFilters}
                onLayoutChange={setWorkLayout}
                onOpen={openWorkItem}
                onStartWork={() => setShowStartWork(true)}
                repos={repos}
              />
            </div>
            {selectedRun && (
              <div className="work-run-detail">
                <button className="repository-page-back" onClick={closeWorkDetail} type="button">‹ Work</button>
                <RunWorkspace companionSessions={companionSessions} onApply={(run) => void runRecoveryAction(run, 'apply')} onDelete={(run) => void deleteRun(run)} onOpenCompanionSession={(sessionId) => openSession({ id: sessionId })} onPause={(run) => void guideRun(run, 'pause')} onPrepare={prepareRun} onPreview={(run, previewPath) => void previewRun(run, previewPath)} onPublish={publishRun} onResolveAttention={(run, attentionId, decision) => void resolveRunAttention(run.id, attentionId, decision)} onResume={(run) => void guideRun(run, 'resume')} onRetryAttempt={(run) => void retryAttempt(run)} onReverify={(run) => void runRecoveryAction(run, 'reverify')} onStart={startRun} onViewChanges={(run) => { setReviewTarget({ kind: 'run', runId: run.id }); setView('review'); }} run={selectedRun} structuredAttemptsEnabled={structuredAttemptsEnabled} />
              </div>
            )}
            {terminalVisited && (
              <div className="work-session-detail" hidden={!selected || Boolean(selectedRun)}>
                <TerminalWorkspace events={events} onBack={closeWorkDetail} onError={setError} onFocusExternal={(session) => void action(session, 'focus')} session={selected} sessions={sessions} ws={wsRef.current} wsReady={wsReady} />
              </div>
            )}
          </div>
          <div className={layerClass('review')}>
            <ReviewView
              activeRepositoryId={activeRepositoryId}
              claims={claims}
              onApply={(run) => runRecoveryAction(run, 'apply')}
              onError={setError}
              onOpenInWork={selectRun}
              onPreview={(run, previewPath) => void previewRun(run, previewPath)}
              onPublish={publishRun}
              onReverify={(run) => void runRecoveryAction(run, 'reverify')}
              onReviewDecided={(runId) => void refreshReviewState(runId)}
              onSelectTarget={setReviewTarget}
              repos={repos}
              reviewStates={reviewStates}
              runs={runs}
              sessions={sessions}
              structuredAttemptsEnabled={structuredAttemptsEnabled}
              target={reviewTarget}
            />
          </div>
          <div className={layerClass('usage')}><UsageView active={!showSettings && view === 'usage'} onSelectSession={openSession} repos={repos} sessions={sessions} /></div>
          <div className={showSettings ? 'workspace-layer is-active' : 'workspace-layer'}>{(showSettings || settingsVisited) && <SettingsWorkspace appearanceControl={<ThemeControl />} onBack={() => setShowSettings(false)} onInstallHooks={() => void installHooks()} repos={repos} />}</div>
        </main>
        <div className={`inspector-dock${inspectorCollapsed ? ' is-collapsed' : ''}`} hidden={!inspectorRelevant}>
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
            <InspectorRail onAction={(session, actionName) => void action(session, actionName)} onDelete={(session) => void deleteSession(session)} onError={setError} onRename={(session, name) => void rename(session, name)} selected={selectedRun ? null : selected} />
          </div>
        </div>
      </div>

      <footer className="app-statusbar">
        <span className={wsReady ? 'is-live' : ''}><i />{wsReady ? 'Live' : 'Offline'}</span>
        <span>AgentDeck v0.1.0</span>
        <Clock />
      </footer>
        </div>
      </div>

      <CommandPalette
        onClose={() => setPaletteOpen(false)}
        onLaunch={() => setShowStartWork(true)}
        onSelectRepo={(repo) => selectRepository(repo.id)}
        onSelectRun={selectRun}
        onSelectSession={openSession}
        onView={navigateToView}
        open={paletteOpen}
        repos={repos}
        runs={runs}
        sessions={sessions}
      />
      {showStartWork && (
        <StartWorkModal
          initialRepositoryId={activeRepositoryId}
          onAdvanced={(draft) => { setShowStartWork(false); setAdvancedLaunch(draft); }}
          onClose={() => setShowStartWork(false)}
          onError={setError}
          onLaunched={(session) => { setShowStartWork(false); upsertSession(session); openSession(session); refreshRepos(); }}
          onSubmitted={(run) => { setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]); selectRun(run); setShowStartWork(false); }}
          repos={repos}
        />
      )}
      {advancedLaunch && (
        <LaunchModal
          initial={{ prompt: advancedLaunch.task, repoPath: advancedLaunch.repoPath, ...(advancedLaunch.agent !== 'auto' ? { agent: advancedLaunch.agent } : {}) }}
          onClose={() => setAdvancedLaunch(null)}
          onLaunched={(session) => { setAdvancedLaunch(null); upsertSession(session); openSession(session); refreshRepos(); }}
          repos={repos}
        />
      )}
    </div>
  );
}
