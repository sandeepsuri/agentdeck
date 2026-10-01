import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../apiFetch.js';

interface WindowName { app: string; title: string }
interface ShareableWindow extends WindowName { id: number }
interface Status {
  permission: 'granted' | 'denied' | 'unsupported';
  permissionHelp?: string;
  window: WindowName | null;
  live: { viewer: string; window: WindowName; startedAt: string } | null;
  lastEnded: { reason: string; message: string; at: string; viewer: string } | null;
}

const nameOf = (window: WindowName) => (window.title ? `${window.app} — ${window.title}` : window.app);

async function call<T>(url: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<T> {
  const response = await apiFetch(url, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const parsed = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(parsed.error ?? `request failed: ${response.status}`);
  return parsed;
}

/**
 * Issue #91: choose the one Mac window a paired owner phone may view. The
 * window is chosen only here, capture needs Screen Recording permission, and
 * while a phone is viewing this panel (and a floating indicator on screen)
 * says so, with a way to stop it.
 */
export function WindowViewPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [windows, setWindows] = useState<ShareableWindow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => setStatus(await call<Status>('/api/window-view')), []);
  useEffect(() => { void load().catch(() => setError('Could not load the window view.')); }, [load]);
  // Follows who is viewing: closely during a view so this indicator never
  // lags the capture, and gently otherwise (each check runs the helper once).
  const live = Boolean(status?.live);
  useEffect(() => {
    const timer = window.setInterval(() => void load().catch(() => undefined), live ? 2000 : 10000);
    return () => window.clearInterval(timer);
  }, [load, live]);

  const act = async (action: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await action(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong.'); }
    finally { setBusy(false); }
  };
  const merge = (next: Partial<Status>) => setStatus((current) => (current ? { ...current, ...next } : current));

  if (!status) return error ? <p className="form-error" role="alert">{error}</p> : null;
  return <div className="settings-card" aria-label="Mac window">
    <h3>Mac window</h3>
    <p>Share one window on this Mac so a paired phone can view it, at home or away. The phone sees only that window and can't control it. Collaborators never see it, and nothing is recorded.</p>

    {status.permission === 'unsupported' && <p>Viewing a Mac window needs AgentDeck's capture helper on macOS 13 or newer. Reinstall AgentDeck to restore it.</p>}
    {status.permission === 'denied' && <>
      <p className="form-error" role="alert">{status.permissionHelp}</p>
      <button className="button button-primary" disabled={busy} onClick={() => void act(async () => merge(await call<Partial<Status>>('/api/window-view/permission', 'POST')))} type="button">Ask for permission</button>
      <button className="button" disabled={busy} onClick={() => void act(async () => { await call('/api/window-view/permission/settings', 'POST'); })} type="button">Open Screen Recording settings</button>
      <button className="button" disabled={busy} onClick={() => void act(load)} type="button">Check again</button>
    </>}

    {status.live && <p className="window-view-live" aria-label="Phone viewing now" role="status">
      <span aria-hidden="true" className="window-view-live-dot" />
      <strong>{status.live.viewer} is viewing {nameOf(status.live.window)}</strong>
      <button className="button" disabled={busy} onClick={() => void act(async () => setStatus(await call<Status>('/api/window-view/stop', 'POST')))} type="button">Stop viewing</button>
    </p>}

    {status.permission === 'granted' && <>
      {status.window
        ? <p>Shared window: <strong>{nameOf(status.window)}</strong></p>
        : <p>No window is shared.</p>}
      <button className="button" disabled={busy} onClick={() => void act(async () => setWindows(await call<ShareableWindow[]>('/api/window-view/windows')))} type="button">Choose a window…</button>
      {status.window && <button className="button" disabled={busy} onClick={() => void act(async () => { setStatus(await call<Status>('/api/window-view/clear', 'POST')); setWindows(null); })} type="button">Stop sharing</button>}
      {windows && (windows.length === 0
        ? <p>No windows are open that can be shared.</p>
        : <ul className="window-view-list">{windows.map((candidate) => <li key={candidate.id}>
          <span>{nameOf(candidate)}</span>
          <button className="button" disabled={busy} onClick={() => void act(async () => { setStatus(await call<Status>('/api/window-view/select', 'POST', { windowId: candidate.id })); setWindows(null); })} type="button">Share</button>
        </li>)}</ul>)}
    </>}

    {!status.live && status.lastEnded && <p>Last view by {status.lastEnded.viewer}: {status.lastEnded.message}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>;
}
