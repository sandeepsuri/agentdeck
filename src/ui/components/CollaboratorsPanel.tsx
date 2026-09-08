import { useEffect, useState } from 'react';
import type { AgentType, Repo } from '../../types.js';
import {
  createProfile, inviteCollaborator, inviteExistingCollaborator, listCollaborators, listProfiles, removeCollaborator,
  revokeDevice, updateGrants, type Collaborator,
} from '../collaborators.js';
import type { Profile, RequestedDeliveryResult, RunBudget } from '../../work-engine/types.js';
import { lines } from './RunSubmissionModal.js';

const initials = (name: string) => (
  name.trim().split(/\s+/).slice(0, 2).map((word) => word[0]?.toUpperCase() ?? '').join('') || '?'
);

/** Shared by every Repository/Profile grant checkbox list (invite-time and edit-time) — toggles one id's membership in an array. */
const toggleId = (ids: string[], id: string) => (ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]);

/** Matches RunSubmissionModal's own delivery-result options (ticket 55: a clone must offer the source Profile's actual `requestedDeliveryResult`, not a hardcoded 'local-commit'). */
const DELIVERY_RESULT_LABELS: Record<RequestedDeliveryResult, string> = {
  'apply-to-repository': 'Apply to repository',
  'local-commit': 'Create run branch and commit',
  'pull-request': 'Open draft pull request',
  'working-tree': 'Keep in AgentDeck for review',
};

/** Every RunBudget field beyond wall-clock minutes — shown in an initially-collapsed disclosure so a plain new Profile stays uncluttered, but auto-expanded (see CloneProfileForm) whenever the source Profile actually set one, so cloning never silently drops it. */
const BUDGET_LIMIT_FIELDS: { key: Exclude<keyof RunBudget, 'maxWallClockMs'>; label: string }[] = [
  { key: 'maxModelTurns', label: 'Model turns' },
  { key: 'maxInputTokens', label: 'Input tokens' },
  { key: 'maxOutputTokens', label: 'Output tokens' },
  { key: 'maxChildRuns', label: 'Child runs' },
  { key: 'maxToolCalls', label: 'Tool calls' },
  { key: 'maxConcurrentProcesses', label: 'Concurrent processes' },
  { key: 'maxCostUsd', label: 'Cost (USD)' },
  { key: 'maxRepairAttempts', label: 'Repair attempts' },
];

/** The subset of BUDGET_LIMIT_FIELDS a given budget actually sets — the one place that filter runs, shared by the summary line, the view-details list, and CloneProfileForm's auto-expand decision. */
const presentBudgetLimits = (budget: RunBudget) => BUDGET_LIMIT_FIELDS.filter(({ key }) => budget[key] !== undefined);

function summarizeBudget(budget: RunBudget): string {
  const parts: string[] = [];
  if (budget.maxWallClockMs) parts.push(`${Math.round(budget.maxWallClockMs / 60_000)} min wall clock`);
  const extra = presentBudgetLimits(budget).length;
  if (extra > 0) parts.push(`${extra} additional limit${extra === 1 ? '' : 's'}`);
  return parts.length > 0 ? parts.join(', ') : 'no limits set';
}

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
    <div className="collaborators-card">
      <div className="collaborators-card-heading">
        <strong>New profile</strong>
        <span className="field-hint">Runtime, budget, and verification an admin approves once, up front</span>
      </div>
      <div className="collaborators-create-profile">
        <input aria-label="Profile name" className="collaborators-input" onChange={(event) => setName(event.target.value)} placeholder="Profile name, e.g. Standard Codex run" value={name} />
        <div className="collaborators-field-group">
          <span className="collaborators-field-label">Runtime</span>
          <div className="collaborators-chip-row">
            {(['codex', 'claude'] as const).map((runtime) => (
              <label className="collaborators-chip" key={runtime}>
                <input checked={runtimePreference.includes(runtime)} onChange={() => toggleRuntime(runtime)} type="checkbox" />
                {runtime === 'codex' ? 'Codex' : 'Claude'}
              </label>
            ))}
          </div>
        </div>
        <div className="collaborators-two-col">
          <label className="collaborators-field">
            <span className="collaborators-field-label">Wall-clock minutes</span>
            <input min="1" onChange={(event) => setWallClockMinutes(event.target.value)} type="number" value={wallClockMinutes} />
          </label>
          <label className="collaborators-verify-toggle">
            <input checked={verificationRequired} onChange={(event) => setVerificationRequired(event.target.checked)} type="checkbox" />
            Verification required
          </label>
        </div>
        {verificationRequired && (
          <textarea
            aria-label="Verification commands"
            onChange={(event) => setVerificationCommands(event.target.value)}
            placeholder="One command per line, e.g. npm test"
            value={verificationCommands}
          />
        )}
        <div className="collaborators-card-footer">
          <button className="button button-primary" disabled={creating || !name.trim() || runtimePreference.length === 0} onClick={() => void create()} type="button">
            {creating ? 'Creating…' : 'Create Profile'}
          </button>
          {error && <div className="form-error">{error}</div>}
        </div>
      </div>
    </div>
  );
}

/**
 * Ticket 55 AC: an admin inspecting an existing Profile creates a new one
 * "based on it" rather than editing it — Profiles stay immutable and
 * create-only (profile-routes.ts has no update route), so every Run already
 * built from the source Profile keeps its own frozen intent untouched no
 * matter what this form submits. The action is deliberately labeled "Create
 * new from this Profile," never "Edit," and every field defaults to the
 * source Profile's actual current value (not a re-derived guess) so the
 * admin can see and adjust exactly what will carry over before submitting.
 */
function CloneProfileForm({ source, onCreated, onCancel }: {
  source: Profile; onCreated: (profile: Profile) => void; onCancel: () => void;
}) {
  const [name, setName] = useState(`${source.name} copy`);
  const [runtimePreference, setRuntimePreference] = useState<AgentType[]>([...source.runtimePreference]);
  const [wallClockMinutes, setWallClockMinutes] = useState(
    source.budget.maxWallClockMs ? String(Math.round(source.budget.maxWallClockMs / 60_000)) : '',
  );
  const [advancedBudget, setAdvancedBudget] = useState<Partial<Record<Exclude<keyof RunBudget, 'maxWallClockMs'>, string>>>(
    Object.fromEntries(BUDGET_LIMIT_FIELDS.map(({ key }) => [key, source.budget[key] !== undefined ? String(source.budget[key]) : ''])),
  );
  const [advancedOpen, setAdvancedOpen] = useState(presentBudgetLimits(source.budget).length > 0);
  const [verificationRequired, setVerificationRequired] = useState(source.verificationIntent.required);
  const [verificationCommands, setVerificationCommands] = useState(source.verificationIntent.commands.join('\n'));
  const [delivery, setDelivery] = useState<RequestedDeliveryResult>(source.requestedDeliveryResult);
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
      const budget: RunBudget = {};
      if (wallClockMinutes.trim()) budget.maxWallClockMs = Number(wallClockMinutes) * 60_000;
      for (const { key } of BUDGET_LIMIT_FIELDS) {
        const raw = advancedBudget[key];
        if (raw && raw.trim()) budget[key] = Number(raw);
      }
      const profile = await createProfile({
        name: name.trim(),
        runtimePreference,
        budget,
        verificationIntent: { required: verificationRequired, commands: lines(verificationCommands) },
        requestedDeliveryResult: delivery,
      });
      onCreated(profile);
    } catch {
      setError('Unable to create the Profile.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="collaborators-card collaborators-subpanel">
      <div className="collaborators-card-heading">
        <strong>Create new from {source.name}</strong>
        <span className="field-hint">
          Starts from this Profile&rsquo;s actual runtime, budget, verification, and delivery. The original
          Profile — and any Run already built from it — never changes.
        </span>
      </div>
      <div className="collaborators-create-profile">
        <input aria-label="New profile name" className="collaborators-input" onChange={(event) => setName(event.target.value)} placeholder="Profile name" value={name} />
        <div className="collaborators-field-group">
          <span className="collaborators-field-label">Runtime</span>
          <div className="collaborators-chip-row">
            {(['codex', 'claude'] as const).map((runtime) => (
              <label className="collaborators-chip" key={runtime}>
                <input checked={runtimePreference.includes(runtime)} onChange={() => toggleRuntime(runtime)} type="checkbox" />
                {runtime === 'codex' ? 'Codex' : 'Claude'}
              </label>
            ))}
          </div>
        </div>
        <div className="collaborators-two-col">
          <label className="collaborators-field">
            <span className="collaborators-field-label">Wall-clock minutes</span>
            <input min="1" onChange={(event) => setWallClockMinutes(event.target.value)} type="number" value={wallClockMinutes} />
          </label>
          <label className="collaborators-field">
            <span className="collaborators-field-label">Requested delivery result</span>
            <select aria-label="Requested delivery result" onChange={(event) => setDelivery(event.target.value as RequestedDeliveryResult)} value={delivery}>
              {(Object.entries(DELIVERY_RESULT_LABELS) as [RequestedDeliveryResult, string][]).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="collaborators-verify-toggle">
          <input checked={verificationRequired} onChange={(event) => setVerificationRequired(event.target.checked)} type="checkbox" />
          Verification required
        </label>
        {verificationRequired && (
          <textarea
            aria-label="Verification commands"
            onChange={(event) => setVerificationCommands(event.target.value)}
            placeholder="One command per line, e.g. npm test"
            value={verificationCommands}
          />
        )}
        <details onToggle={(event) => setAdvancedOpen(event.currentTarget.open)} open={advancedOpen}>
          <summary className="collaborators-field-label">Additional budget limits</summary>
          <div className="collaborators-two-col">
            {BUDGET_LIMIT_FIELDS.map(({ key, label }) => (
              <label className="collaborators-field" key={key}>
                <span className="collaborators-field-label">{label}</span>
                <input
                  aria-label={label}
                  min="0"
                  onChange={(event) => setAdvancedBudget((current) => ({ ...current, [key]: event.target.value }))}
                  type="number"
                  value={advancedBudget[key] ?? ''}
                />
              </label>
            ))}
          </div>
        </details>
        <div className="collaborators-card-footer">
          <button className="button button-primary" disabled={creating || !name.trim() || runtimePreference.length === 0} onClick={() => void create()} type="button">
            {creating ? 'Creating…' : 'Create new from this Profile'}
          </button>
          <button className="button" disabled={creating} onClick={onCancel} type="button">Cancel</button>
          {error && <div className="form-error">{error}</div>}
        </div>
      </div>
    </div>
  );
}

/**
 * Ticket 55 AC: grant reassignment is a separate, explicit action from
 * creating the replacement Profile — nothing here runs until the admin
 * picks specific collaborators and clicks Update. Reuses the exact
 * PATCH /api/collaborators/:id grant seam ticket 51's editor already
 * exercises; a per-collaborator failure never rolls back the ones that
 * succeeded, deletes the new Profile, or gets reported as a false success.
 */
function ReassignGrantsPanel({ source, replacement, collaborators, onDone }: {
  source: Profile; replacement: Profile; collaborators: Collaborator[]; onDone: () => void;
}) {
  const affected = collaborators.filter((collaborator) => collaborator.grantedProfileIds.includes(source.id));
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [results, setResults] = useState<Record<string, 'ok' | 'error'>>({});

  const toggle = (id: string) => setSelectedIds((current) => toggleId(current, id));

  const apply = async () => {
    setSaving(true);
    const next: Record<string, 'ok' | 'error'> = { ...results };
    for (const collaborator of affected) {
      if (!selectedIds.includes(collaborator.id)) continue;
      const grantedProfileIds = collaborator.grantedProfileIds.map((id) => (id === source.id ? replacement.id : id));
      try {
        await updateGrants(collaborator.id, { grantedProfileIds });
        next[collaborator.id] = 'ok';
      } catch {
        next[collaborator.id] = 'error';
      }
    }
    setResults(next);
    setSaving(false);
  };

  return (
    <div className="collaborators-card collaborators-subpanel">
      <div className="collaborators-card-heading">
        <strong>Update collaborator grants to {replacement.name}?</strong>
        <span className="field-hint">
          Separate from creating the Profile — nothing changes here until you choose collaborators and update.
        </span>
      </div>
      {affected.length === 0 && <p className="field-hint-block">No collaborator is currently granted {source.name}.</p>}
      {affected.length > 0 && (
        <ul className="collaborators-list">
          {affected.map((collaborator) => (
            <li className="collaborators-row" key={collaborator.id}>
              <div className="collaborators-row-main">
                <label className="collaborators-chip">
                  <input checked={selectedIds.includes(collaborator.id)} onChange={() => toggle(collaborator.id)} type="checkbox" />
                  {collaborator.displayName}
                </label>
                {results[collaborator.id] === 'ok' && <span className="field-hint">Updated to {replacement.name}</span>}
                {results[collaborator.id] === 'error' && (
                  <span className="form-error">Unable to update — still granted {source.name}</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="collaborators-card-footer">
        {affected.length > 0 && (
          <button className="button button-primary" disabled={saving || selectedIds.length === 0} onClick={() => void apply()} type="button">
            {saving ? 'Updating…' : `Update selected to ${replacement.name}`}
          </button>
        )}
        <button className="button" disabled={saving} onClick={onDone} type="button">Done</button>
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

  /** Ticket 55: which existing Profile (if any) currently has an open "Create new from this Profile" form, and the source/replacement pair once that create succeeds — driving the separate, explicit grant-reassignment panel below it. */
  const [cloningFromId, setCloningFromId] = useState<string | null>(null);
  const [cloneCreated, setCloneCreated] = useState<{ source: Profile; replacement: Profile } | null>(null);

  const refresh = () => Promise.all([
    listCollaborators().then(setCollaborators),
    listProfiles().then(setProfiles),
  ]).catch(() => setError('Unable to load collaborators.'));

  useEffect(() => {
    let cancelled = false;
    refresh().finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

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
    <fieldset className="collaborators-panel">
      <legend>Collaborators</legend>
      <p className="field-hint-block">
        Invite a named collaborator and issue them a device credential for viewing, launching, and guiding
        authorized Runs over the tailnet. Each device is individually revocable and never lets you see its
        bearer value again once issued.
      </p>

      <p className="field-hint-block">
        Profiles are admin-approved configurations for how a collaborator&rsquo;s Run may run — runtime, budget,
        and verification. A collaborator can only launch a Run against a Profile granted to them; the Work
        Engine derives the Run entirely from the Profile, never from anything the collaborator submits.
      </p>

      <CreateProfileForm onCreated={(profile) => setProfiles((current) => [...current, profile])} />

      <div className="collaborators-section-label">Profiles</div>
      {!loading && profiles.length === 0 && <div className="rail-empty">No Profiles yet.</div>}
      {profiles.length > 0 && (
        <ul className="collaborators-list">
          {profiles.map((profile) => (
            <li className="collaborators-row" key={profile.id}>
              <div className="collaborators-row-main">
                <span className="collaborators-row-info">
                  <strong>{profile.name}</strong>
                  <span className="field-hint">
                    {profile.runtimePreference.map((runtime) => (runtime === 'codex' ? 'Codex' : 'Claude')).join(', ')}
                    {' · '}{summarizeBudget(profile.budget)}
                    {' · '}{profile.verificationIntent.required
                      ? `verification required (${profile.verificationIntent.commands.length})`
                      : 'no verification required'}
                    {' · '}{DELIVERY_RESULT_LABELS[profile.requestedDeliveryResult]}
                  </span>
                </span>
                <button
                  aria-label={`Create new from ${profile.name}`}
                  className="button"
                  onClick={() => { setCloningFromId(profile.id); setCloneCreated(null); }}
                  type="button"
                >
                  Create new from this Profile
                </button>
              </div>
              <details>
                <summary className="field-hint">View details</summary>
                <ul className="collaborators-devices">
                  <li className="collaborators-device-row"><span>Runtime</span><span>{profile.runtimePreference.join(', ')}</span></li>
                  <li className="collaborators-device-row">
                    <span>Wall clock</span>
                    <span>{profile.budget.maxWallClockMs ? `${Math.round(profile.budget.maxWallClockMs / 60_000)} min` : 'not set'}</span>
                  </li>
                  {presentBudgetLimits(profile.budget).map(({ key, label }) => (
                    <li className="collaborators-device-row" key={key}><span>{label}</span><span>{profile.budget[key]}</span></li>
                  ))}
                  <li className="collaborators-device-row"><span>Verification</span><span>{profile.verificationIntent.required ? 'Required' : 'Not required'}</span></li>
                  {profile.verificationIntent.commands.map((command) => (
                    <li className="collaborators-device-row" key={command}><span /><code>{command}</code></li>
                  ))}
                  <li className="collaborators-device-row"><span>Delivery</span><span>{DELIVERY_RESULT_LABELS[profile.requestedDeliveryResult]}</span></li>
                  <li className="collaborators-device-row"><span>Created</span><span>{new Date(profile.createdAt).toLocaleString()}</span></li>
                </ul>
              </details>
              {cloningFromId === profile.id && (
                <CloneProfileForm
                  onCancel={() => setCloningFromId(null)}
                  onCreated={(newProfile) => {
                    setProfiles((current) => [...current, newProfile]);
                    setCloningFromId(null);
                    setCloneCreated({ source: profile, replacement: newProfile });
                  }}
                  source={profile}
                />
              )}
              {cloneCreated && cloneCreated.source.id === profile.id && (
                <ReassignGrantsPanel
                  collaborators={collaborators}
                  onDone={() => { setCloneCreated(null); void refresh(); }}
                  replacement={cloneCreated.replacement}
                  source={cloneCreated.source}
                />
              )}
            </li>
          ))}
        </ul>
      )}

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
    </fieldset>
  );
}
