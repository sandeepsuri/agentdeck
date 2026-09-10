import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { Model } from '../../sessions/model-catalog.js';
import type { Repo } from '../../types.js';
import { apiFetch, responseJson, responseJsonArray } from '../apiFetch.js';
import { CollaboratorsPanel } from './CollaboratorsPanel.js';
import { ProfilesPanel } from './ProfilesPanel.js';
import { useAccessData } from './useAccessData.js';

interface SettingsBody { defaultModel?: string; openaiKeyConfigured: boolean; error?: string }

/**
 * Presentation-only redesign slice (parent issue #37,
 * docs/prototypes/agentdeck-redesign.html): three sections previously
 * crowded into one scrolling modal — model/key/appearance, the Profile
 * roster, and Collaborator access — get their own tab, rendered as a page in
 * the Admin shell's main content area (the sidebar stays visible; there is
 * no backdrop, dialog frame, or modal footer). Every tab's panel stays
 * mounted regardless of which is active (only the `hidden` attribute
 * changes, exactly like RunWorkspace's run-detail tabs), so an unsaved
 * invite draft, a "Create new from this Profile" form, or a freshly issued
 * one-time invitation code all survive a tab switch instead of unmounting
 * and losing state.
 */
type SettingsTab = 'general' | 'profiles' | 'collaborators';
const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'profiles', label: 'Profiles' },
  { id: 'collaborators', label: 'Collaborators' },
];

/** WAI-ARIA "Tabs" pattern: roving tabindex, Left/Right/Home/End move both selection and focus. Mirrors RunWorkspace's RunDetailTabList. */
function SettingsTabList({ active, onChange }: { active: SettingsTab; onChange: (tab: SettingsTab) => void }) {
  const buttonRefs = useRef<Partial<Record<SettingsTab, HTMLButtonElement | null>>>({});
  const select = (id: SettingsTab) => {
    onChange(id);
    buttonRefs.current[id]?.focus();
  };
  return (
    <div
      aria-label="Settings sections"
      className="settings-tabs"
      onKeyDown={(event) => {
        const index = SETTINGS_TABS.findIndex((tab) => tab.id === active);
        if (event.key === 'ArrowRight') { event.preventDefault(); select(SETTINGS_TABS[(index + 1) % SETTINGS_TABS.length]!.id); }
        else if (event.key === 'ArrowLeft') { event.preventDefault(); select(SETTINGS_TABS[(index - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length]!.id); }
        else if (event.key === 'Home') { event.preventDefault(); select(SETTINGS_TABS[0]!.id); }
        else if (event.key === 'End') { event.preventDefault(); select(SETTINGS_TABS.at(-1)!.id); }
      }}
      role="tablist"
    >
      {SETTINGS_TABS.map((tab) => (
        <button
          aria-controls={`settings-tabpanel-${tab.id}`}
          aria-selected={active === tab.id}
          className={active === tab.id ? 'is-active' : ''}
          id={`settings-tab-${tab.id}`}
          key={tab.id}
          onClick={() => onChange(tab.id)}
          ref={(el) => { buttonRefs.current[tab.id] = el; }}
          role="tab"
          tabIndex={active === tab.id ? 0 : -1}
          type="button"
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Ticket 12: default summary model + OpenAI API key + appearance. The API
 * key field is write-only by design — GET /api/settings only ever returns
 * openaiKeyConfigured (a boolean), never the key itself, so there is
 * nothing to prefill here even right after saving one.
 */
export function SettingsWorkspace({ onBack, repos = [], appearanceControl }: { onBack: () => void; repos?: Repo[]; appearanceControl?: ReactNode }) {
  const [tab, setTab] = useState<SettingsTab>('general');
  const [models, setModels] = useState<Model[]>([]);
  const [openaiKeyConfigured, setOpenaiKeyConfigured] = useState(false);
  const [defaultModel, setDefaultModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const access = useAccessData();

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiFetch('/api/models').then((response) => responseJsonArray<Model>(response)),
      apiFetch('/api/settings').then((response) => responseJson<SettingsBody>(response)),
    ]).then(([modelList, settings]) => {
      if (cancelled) return;
      setModels(modelList);
      setOpenaiKeyConfigured(settings.openaiKeyConfigured);
      setDefaultModel(settings.defaultModel ?? '');
    }).catch(() => { if (!cancelled) setError('Unable to load settings.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const patchSettings = async (body: { defaultModel?: string; openaiApiKey?: string }) => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const response = await apiFetch('/api/settings', {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const result = await response.json() as SettingsBody;
      if (!response.ok) throw new Error(result.error ?? 'Failed to save settings.');
      setOpenaiKeyConfigured(result.openaiKeyConfigured);
      if (result.defaultModel !== undefined) setDefaultModel(result.defaultModel);
      setApiKey(''); // never keep the plaintext key in the field once it's saved
      setSaved(true);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  const save = () => {
    const body: { defaultModel?: string; openaiApiKey?: string } = {};
    if (defaultModel) body.defaultModel = defaultModel;
    if (apiKey.trim()) body.openaiApiKey = apiKey.trim();
    void patchSettings(body);
  };

  const removeKey = () => void patchSettings({ openaiApiKey: '' });

  return (
    <section aria-label="Settings" className="workspace-scroll settings-workspace">
      <button className="repository-page-back" onClick={onBack} type="button">‹ Back to workspace</button>
      <div className="view-heading">
        <h1>Settings &amp; access</h1>
        <span>Workspace configuration and access management</span>
      </div>

      <SettingsTabList active={tab} onChange={setTab} />

      <div aria-labelledby="settings-tab-general" className="settings-tab-panel" hidden={tab !== 'general'} id="settings-tabpanel-general" role="tabpanel">
        {loading && <div className="rail-empty">Loading settings…</div>}
        {!loading && (
          <>
            <fieldset>
              <legend>Default summary model</legend>
              <p className="field-hint-block">Used for wrap-ups that don't pick a model explicitly. Changing this affects later wrap-ups only — it never rewrites a summary you've already generated.</p>
              <div className="settings-model-list">
                {models.length === 0 && <div className="rail-empty">No models available.</div>}
                {models.map((model) => (
                  <label
                    className={`settings-model-row${defaultModel === model.id ? ' is-selected' : ''}${!model.available ? ' is-disabled' : ''}`}
                    key={model.id}
                  >
                    <input
                      checked={defaultModel === model.id}
                      disabled={!model.available}
                      name="default-model"
                      onChange={() => setDefaultModel(model.id)}
                      type="radio"
                    />
                    <span>
                      <strong>{model.displayName}</strong>
                      <small>{model.billing === 'subscription' ? 'Billed to your Claude subscription' : 'Billed per use to your OpenAI API key'}{model.unavailableReason ? ` · ${model.unavailableReason}` : ''}</small>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset>
              <legend>OpenAI API key</legend>
              <p className="field-hint-block">Required to use OpenAI summary models. A ChatGPT subscription does not include this — it's billed separately, per request. Stored locally at owner-only file permissions and never sent back to this UI once saved.</p>
              <div className="settings-key-row">
                <input
                  autoComplete="off"
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={openaiKeyConfigured ? 'Configured — enter a new key to replace it' : 'sk-...'}
                  type="password"
                  value={apiKey}
                />
                {openaiKeyConfigured && <button className="button" disabled={saving} onClick={removeKey} type="button">Remove key</button>}
              </div>
              <div className="field-hint"><span>{openaiKeyConfigured ? 'An OpenAI API key is configured.' : 'No OpenAI API key configured — OpenAI models are shown disabled until one is added.'}</span></div>
            </fieldset>

            {appearanceControl && (
              <fieldset>
                <legend>Appearance</legend>
                <p className="field-hint-block">Choose a comfortable workspace theme, or follow your system setting.</p>
                {appearanceControl}
              </fieldset>
            )}

            <div className="collaborators-card-footer">
              <button className="button button-primary" disabled={saving || loading} onClick={save} type="button">{saving ? 'Saving…' : 'Save'}</button>
              {error && <div className="form-error">{error}</div>}
            </div>
            {saved && !error && <div className="settings-saved">Saved.</div>}
          </>
        )}
      </div>

      <div aria-labelledby="settings-tab-profiles" className="settings-tab-panel" hidden={tab !== 'profiles'} id="settings-tabpanel-profiles" role="tabpanel">
        <ProfilesPanel access={access} />
      </div>

      <div aria-labelledby="settings-tab-collaborators" className="settings-tab-panel" hidden={tab !== 'collaborators'} id="settings-tabpanel-collaborators" role="tabpanel">
        <CollaboratorsPanel access={access} repos={repos} />
      </div>
    </section>
  );
}
