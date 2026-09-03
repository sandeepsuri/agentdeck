import { useEffect, useState } from 'react';
import type { AgentType, Repo } from '../../types.js';
import {
  createProfile, inviteCollaborator, inviteExistingCollaborator, listCollaborators, listProfiles, revokeDevice,
  type Collaborator,
} from '../collaborators.js';
import type { Profile } from '../../work-engine/types.js';
import { lines } from './RunSubmissionModal.js';
import './CollaboratorsPanel.css';

/**
 * Ticket 12 AC1: the admin's minimal Profile roster — create-only (a
 * Profile is immutable once created, exactly like a Run's own frozen
 * WorkSpec; see profile-routes.ts). Kept inside CollaboratorsPanel rather
 * than a sibling component because its only purpose is feeding the invite
 * row's Profile-grant checkboxes below.
 */
function CreateProfileForm({ onCreated }: { onCreated: (profile: Profile) => void }) {
  const [name, setName] = useState('');
  const [runtimePreference, setRuntimePreference] = useState<AgentType[]>(['codex']);
  const [wallClockMinutes, setWallClockMinutes] = useState('60');
  const [verificationRequired, setVerificationRequired] = useState(false);
  const [verificationCommands, setVerificationCommands] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleRuntime = (runtime: AgentType) => setRuntimePreference((current) => (
    current.includes(runtime) ? current.filter((item) => item !== runtime) : [...current, runtime]
  ));

  const create = async () => {
    if (!name.trim() || runtimePreference.length === 0) return;
    setCreating(true);
    setError(null);
    try {
      const profile = await createProfile({
        name: name.trim(),
        runtimePreference,
        budget: { maxWallClockMs: Number(wallClockMinutes) * 60_000 },
        verificationIntent: { required: verificationRequired, commands: lines(verificationCommands) },
        requestedDeliveryResult: 'local-commit',
      });
      onCreated(profile);
      setName('');
      setVerificationCommands('');
    } catch {
      setError('Unable to create the Profile.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="collaborators-create-profile">
      <label className="collaborators-field">
        <span>Profile name</span>
        <input aria-label="Profile name" onChange={(event) => setName(event.target.value)} placeholder="e.g. Standard Codex run" value={name} />
      </label>

      <div className="collaborators-form-row">
        <div className="collaborators-field">
          <span>Runtime</span>
          <div className="run-choice-row">
            {(['codex', 'claude'] as const).map((runtime) => (
              <label key={runtime}>
                <input checked={runtimePreference.includes(runtime)} onChange={() => toggleRuntime(runtime)} type="checkbox" />
                {runtime === 'codex' ? 'Codex' : 'Claude'}
              </label>
            ))}
          </div>
        </div>
        <label className="collaborators-field">
          <span>Wall-clock minutes</span>
          <input min="1" onChange={(event) => setWallClockMinutes(event.target.value)} type="number" value={wallClockMinutes} />
        </label>
      </div>

      <label className="run-check">
        <input checked={verificationRequired} onChange={(event) => setVerificationRequired(event.target.checked)} type="checkbox" />
        Verification required
      </label>
      {verificationRequired && (
        <label className="collaborators-field">
          <span>Verification commands</span>
          <textarea
            aria-label="Verification commands"
            onChange={(event) => setVerificationCommands(event.target.value)}
            placeholder="One command per line, e.g. npm test"
            value={verificationCommands}
          />
        </label>
      )}

      <div className="collaborators-form-actions">
        {error && <div className="form-error">{error}</div>}
        <button className="button" disabled={creating || !name.trim() || runtimePreference.length === 0} onClick={() => void create()} type="button">
          {creating ? 'Creating…' : 'Create Profile'}
        </button>
      </div>
    </div>
  );
}

/**
 * Ticket 11 AC1/AC2/AC5 / ticket 12 AC1: the bootstrap local admin's
 * collaborator management surface — desktop-only (rendered inside
 * SettingsModal, which only ever mounts on a local connection, see
 * App.tsx). Creates named invitations (granting Repositories and
 * admin-approved Profiles at invite time), shows a freshly issued one-time
 * code exactly once, and lists every collaborator's devices with a
 * per-device revoke control.
 */
export function CollaboratorsPanel({ repos }: { repos: Repo[] }) {
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [selectedRepoIds, setSelectedRepoIds] = useState<string[]>([]);
  const [selectedProfileIds, setSelectedProfileIds] = useState<string[]>([]);
  const [issuedCode, setIssuedCode] = useState<{ displayName: string; code: string } | null>(null);

  const refresh = () => Promise.all([
    listCollaborators().then(setCollaborators),
    listProfiles().then(setProfiles),
  ]).catch(() => setError('Unable to load collaborators.'));

  useEffect(() => {
    let cancelled = false;
    refresh().finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const toggleRepo = (id: string) => setSelectedRepoIds((current) => (
    current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
  ));
  const toggleProfile = (id: string) => setSelectedProfileIds((current) => (
    current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
  ));

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

  return (
    <fieldset className="collaborators-panel">
      <legend>Collaborators</legend>
      <p className="field-hint-block">
        Invite a named collaborator and issue them a device credential for viewing, launching, and guiding
        authorized Runs over the tailnet. Each device is individually revocable and never lets you see its
        bearer value again once issued.
      </p>

      <div className="collaborators-section">
        <h3 className="collaborators-subheading">Profiles</h3>
        <p className="field-hint-block">
          Profiles are admin-approved configurations for how a collaborator&rsquo;s Run may run — runtime, budget,
          and verification. A collaborator can only launch a Run against a Profile granted to them; the Work
          Engine derives the Run entirely from the Profile, never from anything the collaborator submits.
        </p>
        <CreateProfileForm onCreated={(profile) => setProfiles((current) => [...current, profile])} />
      </div>

      <div className="collaborators-section">
        <h3 className="collaborators-subheading">Invite a collaborator</h3>
        <div className="collaborators-invite-row">
          <label className="collaborators-field">
            <span>Collaborator name</span>
            <input
              aria-label="Collaborator name"
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="Collaborator name"
              value={displayName}
            />
          </label>
          {repos.length > 0 && (
            <div className="collaborators-repo-grants">
              <span className="collaborators-grant-label">Repositories</span>
              <div className="collaborators-chip-row">
                {repos.map((repo) => (
                  <label className={`collaborators-chip${selectedRepoIds.includes(repo.id) ? ' is-selected' : ''}`} key={repo.id}>
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
            <div className="collaborators-profile-grants">
              <span className="collaborators-grant-label">Profiles</span>
              <div className="collaborators-chip-row">
                {profiles.map((profile) => (
                  <label className={`collaborators-chip${selectedProfileIds.includes(profile.id) ? ' is-selected' : ''}`} key={profile.id}>
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
          <div className="collaborators-form-actions">
            <button className="button button-primary" disabled={!displayName.trim()} onClick={() => void create()} type="button">
              Create invitation
            </button>
          </div>
        </div>

        {issuedCode && (
          <div className="collaborators-issued-code" role="status">
            <div className="collaborators-issued-code-head">
              <strong>{issuedCode.displayName}&rsquo;s invitation code</strong>
              <button onClick={() => setIssuedCode(null)} type="button">Dismiss</button>
            </div>
            <code>{issuedCode.code}</code>
            <p className="field-hint">Share this once, out of band — it cannot be shown again.</p>
          </div>
        )}
      </div>

      <div className="collaborators-section">
        <h3 className="collaborators-subheading">Team</h3>
        {loading && <div className="rail-empty">Loading collaborators…</div>}
        {!loading && collaborators.length === 0 && <div className="rail-empty">No collaborators yet.</div>}
        {!loading && collaborators.length > 0 && (
          <ul className="collaborators-list">
            {collaborators.map((collaborator) => (
              <li className="collaborators-card" key={collaborator.id}>
                <div className="collaborators-card-head">
                  <span>
                    <strong>{collaborator.displayName}</strong>
                    <span className="field-hint">
                      {collaborator.grantedRepositoryIds.length} repositor{collaborator.grantedRepositoryIds.length === 1 ? 'y' : 'ies'},
                      {' '}{collaborator.grantedProfileIds.length} profile{collaborator.grantedProfileIds.length === 1 ? '' : 's'} granted
                    </span>
                  </span>
                  <button className="button" onClick={() => void reinvite(collaborator.id, collaborator.displayName)} type="button">
                    New device invitation
                  </button>
                </div>
                <ul className="collaborators-devices">
                  {collaborator.devices.map((device) => (
                    <li className="collaborators-device-row" key={device.id}>
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
      </div>

      {error && <div className="form-error">{error}</div>}
    </fieldset>
  );
}
