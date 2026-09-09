import { useState } from 'react';
import type { Repo } from '../../types.js';
import {
  inviteCollaborator, inviteExistingCollaborator, removeCollaborator, revokeDevice, toggleId, updateGrants, type Collaborator,
} from '../collaborators.js';
import type { AccessData } from './useAccessData.js';

const initials = (name: string) => (
  name.trim().split(/\s+/).slice(0, 2).map((word) => word[0]?.toUpperCase() ?? '').join('') || '?'
);

/**
 * Ticket 11 AC1/AC2/AC5 / ticket 12 AC1 / A14 (parent #37): the
 * Collaborators tab of the Settings workspace — desktop-only (rendered
 * inside SettingsModal, which only ever mounts on a local connection, see
 * App.tsx). Creates named invitations (granting Repositories and
 * admin-approved Profiles at invite time), shows a freshly issued one-time
 * code exactly once, and lists every collaborator's devices with a
 * per-device revoke control. Profile grant checkboxes read `access.profiles`
 * — the Profiles tab (ProfilesPanel) owns creating and cloning those.
 */
export function CollaboratorsPanel({ repos, access }: { repos: Repo[]; access: AccessData }) {
  const { collaborators, profiles, loading, error, setError, refresh } = access;
  const [displayName, setDisplayName] = useState('');
  const [selectedRepoIds, setSelectedRepoIds] = useState<string[]>([]);
  const [selectedProfileIds, setSelectedProfileIds] = useState<string[]>([]);
  const [issuedCode, setIssuedCode] = useState<{ displayName: string; code: string } | null>(null);

  /**
   * Ticket 51 AC: editing an existing collaborator's grants reuses the same
   * PATCH /api/collaborators/:id (updateGrants) already exercised by the
   * invite-time grant checkboxes above — only one collaborator's editor is
   * open at a time, seeded from their current grants so Cancel can discard
   * the draft without ever calling the API.
   */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRepoIds, setEditRepoIds] = useState<string[]>([]);
  const [editProfileIds, setEditProfileIds] = useState<string[]>([]);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const toggleRepo = (id: string) => setSelectedRepoIds((current) => toggleId(current, id));
  const toggleProfile = (id: string) => setSelectedProfileIds((current) => toggleId(current, id));

  const create = async () => {
    const name = displayName.trim();
    if (!name) return;
    setError(null);
    try {
      const { collaborator, code } = await inviteCollaborator({
        displayName: name, grantedRepositoryIds: selectedRepoIds, grantedProfileIds: selectedProfileIds,
      });
      setIssuedCode({ displayName: collaborator.displayName, code });
      setDisplayName('');
      setSelectedRepoIds([]);
      setSelectedProfileIds([]);
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

  const remove = async (collaboratorId: string, name: string) => {
    if (!window.confirm(`Remove ${name}? They will immediately lose all access, and this cannot be undone.`)) return;
    setError(null);
    try {
      await removeCollaborator(collaboratorId);
      await refresh();
    } catch {
      setError('Unable to remove that collaborator.');
    }
  };

  const startEdit = (collaborator: Collaborator) => {
    setEditingId(collaborator.id);
    setEditRepoIds([...collaborator.grantedRepositoryIds]);
    setEditProfileIds([...collaborator.grantedProfileIds]);
    setEditError(null);
  };

  /** AC: cancel leaves grants untouched — no API call, just discard the draft. */
  const cancelEdit = () => {
    setEditingId(null);
    setEditError(null);
  };

  const toggleEditRepo = (id: string) => setEditRepoIds((current) => toggleId(current, id));
  const toggleEditProfile = (id: string) => setEditProfileIds((current) => toggleId(current, id));

  /**
   * AC: saving displays the grants the server actually returned (not just
   * the checked boxes), the same way every other mutation in this panel
   * re-reads the roster afterward rather than trusting a local guess; a
   * failure never closes the editor or is mistaken for success — the draft
   * stays open with an error so the admin can retry instead of silently
   * losing the edit.
   */
  const saveEdit = async (collaboratorId: string) => {
    setEditSaving(true);
    setEditError(null);
    try {
      await updateGrants(collaboratorId, { grantedRepositoryIds: editRepoIds, grantedProfileIds: editProfileIds });
      await refresh();
      setEditingId(null);
    } catch {
      setEditError('Unable to update access. Nothing was changed.');
    } finally {
      setEditSaving(false);
    }
  };

  return (
    <div className="collaborators-panel">
      <p className="field-hint-block">
        Invite a named collaborator and issue them a device credential for viewing, launching, and guiding
        authorized Runs over the tailnet. Each device is individually revocable and never lets you see its
        bearer value again once issued.
      </p>

      <div className="collaborators-card">
        <div className="collaborators-card-heading">
          <strong>Invite collaborator</strong>
          <span className="field-hint">Grants the repositories and profiles they can use, at invite time</span>
        </div>
        <div className="collaborators-invite-row">
          <input
            aria-label="Collaborator name"
            className="collaborators-input"
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="Collaborator name"
            value={displayName}
          />
          {repos.length > 0 && (
            <div className="collaborators-field-group collaborators-repo-grants">
              <span className="collaborators-field-label">Repositories</span>
              <div className="collaborators-chip-row">
                {repos.map((repo) => (
                  <label className="collaborators-chip" key={repo.id}>
                    <input
                      checked={selectedRepoIds.includes(repo.id)}
                      onChange={() => toggleRepo(repo.id)}
                      type="checkbox"
                    />
                    {repo.name}
                  </label>
                ))}
              </div>
            </div>
          )}
          {profiles.length > 0 && (
            <div className="collaborators-field-group collaborators-profile-grants">
              <span className="collaborators-field-label">Profiles</span>
              <div className="collaborators-chip-row">
                {profiles.map((profile) => (
                  <label className="collaborators-chip" key={profile.id}>
                    <input
                      checked={selectedProfileIds.includes(profile.id)}
                      onChange={() => toggleProfile(profile.id)}
                      type="checkbox"
                    />
                    {profile.name}
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="collaborators-card-footer">
            <button className="button button-primary" disabled={!displayName.trim()} onClick={() => void create()} type="button">
              Create invitation
            </button>
          </div>
        </div>
      </div>

      {issuedCode && (
        <div className="collaborators-issued-code" role="status">
          <strong>{issuedCode.displayName}&rsquo;s invitation code</strong>
          <code>{issuedCode.code}</code>
          <p className="field-hint">Share this once, out of band — it cannot be shown again.</p>
          <button className="button" onClick={() => setIssuedCode(null)} type="button">Dismiss</button>
        </div>
      )}

      <div className="collaborators-section-label">Roster</div>
      {loading && <div className="rail-empty">Loading collaborators…</div>}
      {!loading && collaborators.length === 0 && <div className="rail-empty">No collaborators yet.</div>}
      {!loading && collaborators.length > 0 && (
        <ul className="collaborators-list">
          {collaborators.map((collaborator) => (
            <li className="collaborators-row" key={collaborator.id}>
              <div className="collaborators-row-main">
                <span className="collaborators-avatar">{initials(collaborator.displayName)}</span>
                <span className="collaborators-row-info">
                  <strong>{collaborator.displayName}</strong>
                  <span className="field-hint">
                    {collaborator.grantedRepositoryIds.length} repositor{collaborator.grantedRepositoryIds.length === 1 ? 'y' : 'ies'},
                    {' '}{collaborator.grantedProfileIds.length} profile{collaborator.grantedProfileIds.length === 1 ? '' : 's'} granted
                  </span>
                </span>
                <button className="button" onClick={() => startEdit(collaborator)} type="button">Edit access</button>
                <button className="button" onClick={() => void reinvite(collaborator.id, collaborator.displayName)} type="button">New device invitation</button>
                <button
                  aria-label={`Remove ${collaborator.displayName}`}
                  className="text-button danger-button"
                  onClick={() => void remove(collaborator.id, collaborator.displayName)}
                  type="button"
                >
                  Remove
                </button>
              </div>
              {editingId === collaborator.id && (
                <div className="collaborators-card collaborators-edit-grants">
                  <div className="collaborators-card-heading">
                    <strong>Edit access for {collaborator.displayName}</strong>
                    <span className="field-hint">Preserves every other grant — only the boxes you change here move</span>
                  </div>
                  {repos.length > 0 && (
                    <div className="collaborators-field-group collaborators-repo-grants">
                      <span className="collaborators-field-label">Repositories</span>
                      <div className="collaborators-chip-row">
                        {repos.map((repo) => (
                          <label className="collaborators-chip" key={repo.id}>
                            <input checked={editRepoIds.includes(repo.id)} onChange={() => toggleEditRepo(repo.id)} type="checkbox" />
                            {repo.name}
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                  {profiles.length > 0 && (
                    <div className="collaborators-field-group collaborators-profile-grants">
                      <span className="collaborators-field-label">Profiles</span>
                      <div className="collaborators-chip-row">
                        {profiles.map((profile) => (
                          <label className="collaborators-chip" key={profile.id}>
                            <input checked={editProfileIds.includes(profile.id)} onChange={() => toggleEditProfile(profile.id)} type="checkbox" />
                            {profile.name}
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="collaborators-card-footer">
                    <button className="button button-primary" disabled={editSaving} onClick={() => void saveEdit(collaborator.id)} type="button">
                      {editSaving ? 'Saving…' : 'Save access'}
                    </button>
                    <button className="button" disabled={editSaving} onClick={cancelEdit} type="button">Cancel</button>
                    {editError && <div className="form-error">{editError}</div>}
                  </div>
                </div>
              )}
              <ul className="collaborators-devices">
                {collaborator.devices.map((device) => (
                  <li className="collaborators-device-row" key={device.id}>
                    <span className={device.revokedAt ? 'is-revoked' : ''}>{device.deviceLabel}{device.revokedAt ? ' — revoked' : ''}</span>
                    {!device.revokedAt && (
                      <button aria-label={`Revoke ${device.deviceLabel}`} className="text-button" onClick={() => void revoke(device.id)} type="button">
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

      {/*
        Ticket 51 AC: "who has access to a Repository" is a read-only
        projection of the same roster loaded above — not a new
        authorization source or a second fetch — so it can never disagree
        with the grants an admin just edited.
      */}
      <div className="collaborators-section-label">Repository access</div>
      {!loading && repos.length === 0 && <div className="rail-empty">No repositories yet.</div>}
      {!loading && repos.length > 0 && (
        <ul className="collaborators-list collaborators-access-list">
          {repos.map((repo) => {
            const granted = collaborators.filter((collaborator) => collaborator.grantedRepositoryIds.includes(repo.id));
            return (
              <li className="collaborators-row" key={repo.id}>
                <div className="collaborators-row-main">
                  <span className="collaborators-row-info">
                    <strong>{repo.name}</strong>
                    <span className="field-hint">{granted.length} collaborator{granted.length === 1 ? '' : 's'} granted</span>
                  </span>
                </div>
                {granted.length > 0 && (
                  <ul className="collaborators-devices">
                    {granted.map((collaborator) => (
                      <li className="collaborators-device-row" key={collaborator.id}><span>{collaborator.displayName}</span></li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
