export const INSPECTOR_COLLAPSED_STORAGE_KEY = 'agentdeck.inspector.collapsed';

interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readInspectorCollapsed(storage: PreferenceStorage | undefined): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(INSPECTOR_COLLAPSED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function persistInspectorCollapsed(storage: PreferenceStorage | undefined, collapsed: boolean): void {
  if (!storage) return;
  try {
    storage.setItem(INSPECTOR_COLLAPSED_STORAGE_KEY, String(collapsed));
  } catch {
    // Persistence is optional; the current page can still use the chosen state.
  }
}

export function inspectorPreferenceStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** Redesign spec §06: Grid is a Work display toggle, not a destination — the choice persists locally. */
export const WORK_LAYOUT_STORAGE_KEY = 'agentdeck.work.layout';
export type WorkLayout = 'list' | 'grid';

export function readWorkLayout(storage: PreferenceStorage | undefined): WorkLayout {
  if (!storage) return 'list';
  try {
    return storage.getItem(WORK_LAYOUT_STORAGE_KEY) === 'grid' ? 'grid' : 'list';
  } catch {
    return 'list';
  }
}

export function persistWorkLayout(storage: PreferenceStorage | undefined, layout: WorkLayout): void {
  if (!storage) return;
  try {
    storage.setItem(WORK_LAYOUT_STORAGE_KEY, layout);
  } catch {
    // Persistence is optional; the current page can still use the chosen layout.
  }
}

/** Which sidebar repositories are expanded to show their chats; null until the user has chosen. */
export const EXPANDED_REPOSITORIES_STORAGE_KEY = 'agentdeck.sidebar.expandedRepositories';

export function readExpandedRepositories(storage: PreferenceStorage | undefined): string[] | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(EXPANDED_REPOSITORIES_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((id) => typeof id === 'string') ? parsed : null;
  } catch {
    return null;
  }
}

export function persistExpandedRepositories(storage: PreferenceStorage | undefined, repositoryIds: readonly string[]): void {
  if (!storage) return;
  try {
    storage.setItem(EXPANDED_REPOSITORIES_STORAGE_KEY, JSON.stringify(repositoryIds));
  } catch {
    // Persistence is optional; the current page can still use the chosen state.
  }
}
