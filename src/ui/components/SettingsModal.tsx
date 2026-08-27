import { useEffect, useState } from 'react';
import type { Model } from '../../sessions/model-catalog.js';

interface SettingsBody { defaultModel?: string; openaiKeyConfigured: boolean; error?: string }

/**
 * Ticket 12: default summary model + OpenAI API key. Follows the same
 * modal shell as LaunchModal/PublishModal. The API key field is
 * write-only by design — GET /api/settings only ever returns
 * openaiKeyConfigured (a boolean), never the key itself, so there is
 * nothing to prefill here even right after saving one.
 */
export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [models, setModels] = useState<Model[]>([]);
  const [openaiKeyConfigured, setOpenaiKeyConfigured] = useState(false);
  const [defaultModel, setDefaultModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch('/api/models').then((response) => response.json() as Promise<Model[]>),
      fetch('/api/settings').then((response) => response.json() as Promise<SettingsBody>),
    ]).then(([modelList, settings]) => {
      if (cancelled) return;
      setModels(modelList);
      setOpenaiKeyConfigured(settings.openaiKeyConfigured);
      setDefaultModel(settings.defaultModel ?? '');
    }).catch(() => { if (!cancelled) setError('Unable to load settings.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const patchSettings = async (body: { defaultModel?: string; openaiApiKey?: string }) => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const response = await fetch('/api/settings', {
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
    <div className="launch-backdrop" onMouseDown={onClose} role="presentation">
      <section aria-label="Settings" aria-modal="true" className="launch-dialog settings-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog">
        <header className="launch-header">
          <span className="launch-mark">⚙</span>
          <span><strong>Settings</strong><small>Summary model default and API key</small></span>
          <kbd>ESC</kbd>
          <button aria-label="Close" onClick={onClose} type="button">×</button>
        </header>

        <div className="settings-content">
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

              {error && <div className="form-error">{error}</div>}
              {saved && !error && <div className="settings-saved">Saved.</div>}
            </>
          )}
        </div>

        <footer className="launch-footer">
          <span className={saved && !saving ? 'is-ready' : ''}><i />{saving ? 'Saving…' : 'Changes apply to future wrap-ups'}</span>
          <button className="button" onClick={onClose} type="button">Close</button>
          <button className="button button-primary" disabled={saving || loading} onClick={save} type="button">{saving ? 'Saving…' : 'Save'}</button>
        </footer>
      </section>
    </div>
  );
}
