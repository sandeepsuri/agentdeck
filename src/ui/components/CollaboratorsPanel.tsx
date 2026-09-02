import { useEffect, useState } from 'react';
import type { Repo } from '../../types.js';
import {
  inviteCollaborator, inviteExistingCollaborator, listCollaborators, revokeDevice,
  type Collaborator,
} from '../collaborators.js';

/**
 * Ticket 11 AC1/AC2/AC5: the bootstrap local admin's collaborator
 * management surface — desktop-only (rendered inside SettingsModal, which
 * only ever mounts on a local connection, see App.tsx). Creates named
 * invitations, shows a freshly issued one-time code exactly once, and lists
 * every collaborator's devices with a per-device revoke control.
 */
export function CollaboratorsPanel({ repos }: { repos: Repo[] }) {
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [selectedRepoIds, setSelectedRepoIds] = useState<string[]>([]);
  const [issuedCode, setIssuedCode] = useState<{ displayName: string; code: string } | null>(null);

  const refresh = () => listCollaborators().then(setCollaborators).catch(() => setError('Unable to load collaborators.'));

  useEffect(() => {
    let cancelled = false;
    refresh().finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const toggleRepo = (id: string) => setSelectedRepoIds((current) => (
    current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
  ));

  const create = async () => {
    const name = displayName.trim();
    if (!name) return;
    setError(null);
    try {
      const { collaborator, code } = await inviteCollaborator({ displayName: name, grantedRepositoryIds: selectedRepoIds });
      setIssuedCode({ displayName: collaborator.displayName, code });
      setDisplayName('');
      setSelectedRepoIds([]);
      await refresh();
    } catch {
      setError('Unable to create the invitation.');
    }
  };

  const reinvite = async (collaboratorId: string, name: string) => {
    setError(null);
    try {
      const { code } = await inviteExistingCollaborator(collaboratorId);
      setIssuedCode({ displayName: name, code });
    } catch {
      setError('Unable to create the invitation.');
    }
  };

  const revoke = async (deviceId: string) => {
    setError(null);
    try {
      await revokeDevice(deviceId);
      await refresh();
    } catch {
      setError('Unable to revoke that device.');
    }
  };

  return (
    <fieldset className="collaborators-panel">
      <legend>Collaborators</legend>
      <p className="field-hint-block">
        Invite a named collaborator and issue them a device credential for viewing authorized Runs and
        Repositories over the tailnet. Each device is individually revocable and never lets you see its
        bearer value again once issued.
      </p>

      <div className="collaborators-invite-row">
        <input
          aria-label="Collaborator name"
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder="Collaborator name"
          value={displayName}
        />
        {repos.length > 0 && (
          <div className="collaborators-repo-grants">
            {repos.map((repo) => (
              <label key={repo.id}>
                <input
                  checked={selectedRepoIds.includes(repo.id)}
                  onChange={() => toggleRepo(repo.id)}
                  type="checkbox"
                />
                {repo.name}
              </label>
            ))}
          </div>
        )}
        <button className="button button-primary" disabled={!displayName.trim()} onClick={() => void create()} type="button">
          Create invitation
        </button>
      </div>

      {issuedCode && (
        <div className="collaborators-issued-code" role="status">
          <strong>{issuedCode.displayName}&rsquo;s invitation code</strong>
          <code>{issuedCode.code}</code>
          <p className="field-hint">Share this once, out of band — it cannot be shown again.</p>
          <button onClick={() => setIssuedCode(null)} type="button">Dismiss</button>
        </div>
      )}

      {loading && <div className="rail-empty">Loading collaborators…</div>}
      {!loading && collaborators.length === 0 && <div className="rail-empty">No collaborators yet.</div>}
      {!loading && collaborators.length > 0 && (
        <ul className="collaborators-list">
          {collaborators.map((collaborator) => (
            <li key={collaborator.id}>
              <strong>{collaborator.displayName}</strong>
              <span className="field-hint">{collaborator.grantedRepositoryIds.length} repositor{collaborator.grantedRepositoryIds.length === 1 ? 'y' : 'ies'} granted</span>
              <button onClick={() => void reinvite(collaborator.id, collaborator.displayName)} type="button">New device invitation</button>
              <ul>
                {collaborator.devices.map((device) => (
                  <li key={device.id}>
                    <span>{device.deviceLabel}{device.revokedAt ? ' — revoked' : ''}</span>
                    {!device.revokedAt && (
                      <button aria-label={`Revoke ${device.deviceLabel}`} onClick={() => void revoke(device.id)} type="button">
                        Revoke
                      </button>
                    )}
                  </li>
                ))}
                {collaborator.devices.length === 0 && <li className="field-hint">No devices yet.</li>}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {error && <div className="form-error">{error}</div>}
    </fieldset>
  );
}
