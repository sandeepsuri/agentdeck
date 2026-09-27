import { useEffect, useState } from 'react';
import { apiFetch } from '../apiFetch.js';

export interface FolderAccessView {
  roots: { path: string; exists: boolean }[];
  chosen: boolean;
  enforced: boolean;
  launchedByApp: boolean;
  canPick: boolean;
  cancelled?: boolean;
  error?: string;
}

/**
 * Settings → Folder access: the folders AgentDeck may scan for repos and
 * start agents in. Saves on every add/remove, independent of the General
 * tab's Save button, since the server enforces it immediately.
 */
function isView(value: unknown): value is FolderAccessView {
  return typeof value === 'object' && value !== null && Array.isArray((value as FolderAccessView).roots);
}

export function FolderAccessPanel({ onChange }: { onChange?: () => void }) {
  const [view, setView] = useState<FolderAccessView | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/settings/access')
      .then(async (response) => {
        const body: unknown = response.ok ? await response.json() : undefined;
        if (!cancelled && isView(body)) setView(body);
      })
      .catch(() => { if (!cancelled) setError('Unable to load folder access.'); });
    return () => { cancelled = true; };
  }, []);

  const send = async (url: string, init: RequestInit) => {
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch(url, init);
      const result = await response.json() as FolderAccessView;
      if (!response.ok || !isView(result)) throw new Error(result.error ?? 'Could not update folder access.');
      setView(result);
      if (!result.cancelled) onChange?.();
      return true;
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : String(sendError));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const chosenRoots = view?.chosen ? view.roots.map((root) => root.path) : [];
  const putRoots = (roots: string[]) => send('/api/settings/access', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roots }),
  });
  const addTyped = async () => {
    const value = draft.trim();
    if (value && await putRoots([...chosenRoots, value])) setDraft('');
  };

  return (
    <fieldset className="folder-access">
      <legend>Folder access</legend>
      <p className="field-hint-block">
        AgentDeck only shows repositories and starts agents inside the folders you choose here. Pick a folder of projects
        (such as ~/Documents/Code) or a single repository.
      </p>
      {view && !view.chosen && view.roots.length > 0 && (
        <p className="field-hint-block">Nothing chosen yet — currently using the folder AgentDeck was started from: <code>{view.roots[0]!.path}</code></p>
      )}
      {view && view.roots.length === 0 && <div className="rail-empty">No folders chosen. AgentDeck can't see any repositories yet.</div>}
      {view?.chosen && (
        <ul className="folder-access-list">
          {view.roots.map((root) => (
            <li key={root.path}>
              <code>{root.path}</code>
              {!root.exists && <small className="form-error"> Missing</small>}
              <button
                aria-label={`Remove ${root.path}`}
                className="button"
                disabled={busy}
                onClick={() => void putRoots(chosenRoots.filter((item) => item !== root.path))}
                type="button"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="settings-key-row">
        {view?.canPick && (
          <button className="button button-primary" disabled={busy} onClick={() => void send('/api/settings/access/pick', { method: 'POST' })} type="button">
            Choose Folder…
          </button>
        )}
        <input
          aria-label="Folder path"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void addTyped(); } }}
          placeholder="/Users/you/Documents/Code"
          value={draft}
        />
        <button className="button" disabled={busy || !draft.trim()} onClick={() => void addTyped()} type="button">Add</button>
      </div>
      {error && <div className="form-error" role="alert">{error}</div>}
    </fieldset>
  );
}
