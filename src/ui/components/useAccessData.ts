import { type Dispatch, type SetStateAction, useEffect, useState } from 'react';
import { listCollaborators, listProfiles, type Collaborator } from '../collaborators.js';
import type { Profile } from '../../work-engine/types.js';

/**
 * A14 (parent #37): the Profiles and Collaborators tabs (ProfilesPanel,
 * CollaboratorsPanel) both read and cross-reference the same two lists —
 * a Profile grant checkbox needs the Profile roster, a Profile's "who's
 * granted this" reassignment needs the Collaborator roster — so this lives
 * one level up in SettingsWorkspace rather than inside either panel. Because
 * both panels stay mounted (only `hidden`) across a tab switch, lifting the
 * fetch here also means creating a Profile in one tab is visible in the
 * other's grant checkboxes without a second fetch.
 */
export interface AccessData {
  collaborators: Collaborator[];
  profiles: Profile[];
  loading: boolean;
  error: string | null;
  setError: (error: string | null) => void;
  setProfiles: Dispatch<SetStateAction<Profile[]>>;
  refresh: () => Promise<void>;
}

export function useAccessData(): AccessData {
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => Promise.all([
    listCollaborators().then(setCollaborators),
    listProfiles().then(setProfiles),
  ]).then(() => undefined).catch(() => { setError('Unable to load collaborators.'); });

  useEffect(() => {
    let cancelled = false;
    refresh().finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return { collaborators, profiles, loading, error, setError, setProfiles, refresh };
}
