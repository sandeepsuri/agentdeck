// The collaborator's "request work" form (formerly CollaboratorWorkspace's
// inline RequestWorkComposer, pinned to the bottom of a Repository's feed),
// now reached from a "New request" action and presented the same way the
// admin's own RunSubmissionModal is — same modal chrome, same field
// styling. Presentation only: the WorkSpec construction, requestWork() call,
// onError/onRequested contract, "text stays in the form on failure"
// behavior, and "no Profiles granted" empty state are all unchanged from the
// composer this replaces.
import { type FormEvent, useEffect, useState } from 'react';
import type { AgentType, Repo } from '../../types.js';
import type { Profile, WorkSpec } from '../../work-engine/types.js';
import { requestWork } from '../collaboratorRuns.js';
import { lines } from './RunSubmissionModal.js';

interface Props {
  repository: Repo;
  profiles: Profile[];
  onClose: () => void;
  onError: (message: string) => void;
  onRequested: (runId: string, note?: string) => void;
}

export function RequestWorkModal({ repository, profiles, onClose, onError, onRequested }: Props) {
  const [objective, setObjective] = useState('');
  const [acceptanceCriteria, setAcceptanceCriteria] = useState('');
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? '');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => { if (!profileId && profiles[0]) setProfileId(profiles[0].id); }, [profileId, profiles]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile || !objective.trim() || !acceptanceCriteria.trim()) return;
    // Runtime, budget, verification and delivery are filled from the Profile
    // purely so this form's own summary matches what will run — the Work
    // Engine overwrites all four from the Profile server-side regardless
    // (engine.ts's submit()), and now resolves the Repository from its own
    // store too, which is why `path` is empty here: a Collaborator is never
    // told a Repository's absolute path (server/routes.ts's scopeRepos).
    const spec: WorkSpec = {
      objective: objective.trim(),
      acceptanceCriteria: lines(acceptanceCriteria),
      repository: { id: repository.id, name: repository.name, path: '' },
      requestedBaseReference: repository.currentBranch ?? 'main',
      runtimePreference: [...profile.runtimePreference] as AgentType[],
      budget: { ...profile.budget },
      verificationIntent: { ...profile.verificationIntent },
      requestedDeliveryResult: profile.requestedDeliveryResult,
      profileId: profile.id,
    };
    setSubmitting(true);
    try {
      const outcome = await requestWork(spec);
      onRequested(outcome.runId, outcome.note);
    } catch (error) {
      // A refused submission created nothing, so the text stays in the form
      // rather than being cleared out from under the person who wrote it.
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section aria-labelledby="request-work-title" aria-modal="true" className="run-submission-modal" role="dialog">
        <header>
          <span><small>{repository.name}</small><h2 id="request-work-title">Request work</h2></span>
          <button aria-label="Close" onClick={onClose} type="button">×</button>
        </header>
        {profiles.length === 0 ? (
          <div className="collab-request-empty">
            <p>No Profiles have been granted to you yet, so work can&rsquo;t be requested. Ask the admin to grant one.</p>
          </div>
        ) : (
          <form onSubmit={(event) => { void submit(event); }}>
            <label>
              <span>What should be done in {repository.name}?</span>
              <textarea
                aria-label="Objective"
                onChange={(event) => setObjective(event.target.value)}
                placeholder="Describe the work…"
                required
                rows={3}
                value={objective}
              />
            </label>
            <label>
              <span>How will you know it worked?</span>
              <textarea
                aria-label="Acceptance criteria"
                onChange={(event) => setAcceptanceCriteria(event.target.value)}
                placeholder="One per line"
                required
                rows={3}
                value={acceptanceCriteria}
              />
            </label>
            <label>
              <span>Profile</span>
              <select aria-label="Profile" onChange={(event) => setProfileId(event.target.value)} required value={profileId}>
                {profiles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
            <footer>
              <button className="button" onClick={onClose} type="button">Cancel</button>
              <button className="button button-primary" disabled={submitting || !objective.trim() || !acceptanceCriteria.trim()} type="submit">
                {submitting ? 'Requesting…' : 'Request work'}
              </button>
            </footer>
          </form>
        )}
      </section>
    </div>
  );
}
