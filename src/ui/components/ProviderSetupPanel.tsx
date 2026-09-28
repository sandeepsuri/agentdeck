// Issue #85: set up a provider CLI from the Mac app without a terminal —
// install it through the provider's supported path, sign in through the
// provider's own browser page, and confirm readiness with a harmless check.
// Every state comes with repair steps (readiness.ts's repairFor). The panel
// lives in Settings › Providers; Home shows it only while no provider is
// ready. AgentDeck never asks for a password or API key here.
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import {
  PROVIDER_NAMES,
  type ProviderReadinessState,
  type RepairAction,
} from '../../provider-setup/readiness.js';
import type { ProviderSetupEntry, ProviderSetupView } from '../../provider-setup/service.js';
import { apiFetch } from '../apiFetch.js';

const POLL_MS = 1500;

const STATE_LABELS: Record<ProviderReadinessState, string> = {
  ready: 'Ready',
  'missing-cli': 'Not installed',
  'signed-out': 'Not signed in',
  expired: 'Sign-in expired',
  'allowance-reached': 'Allowance used up',
  'check-failed': 'Check failed',
};

const AUTH_LABELS: Record<string, string> = {
  'claude.ai': 'Claude subscription',
  console: 'Anthropic Console',
  chatgpt: 'ChatGPT plan',
  'api-key': 'API key',
};

const ACTION_LABELS: Record<Exclude<RepairAction, 'install'>, string> = {
  'open-install-guide': 'Open install page',
  'sign-in': 'Sign in',
  check: 'Check again',
};

type ActionPath = 'check' | 'install' | 'install-guide' | 'sign-in' | 'sign-in/page' | 'sign-in/code' | 'cancel' | 'agent-access';
const ACTION_PATHS: Record<RepairAction, ActionPath> = {
  install: 'install', 'open-install-guide': 'install-guide', 'sign-in': 'sign-in', check: 'check',
};

function useProviderSetup() {
  const [view, setView] = useState<ProviderSetupView>();
  const [error, setError] = useState<string>();
  // Owner-only: any other connection gets 403 and stops asking.
  const [unavailable, setUnavailable] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await apiFetch('/api/provider-setup');
      if (response.status === 403) { setUnavailable(true); return; }
      if (!response.ok) throw new Error();
      setView(await response.json() as ProviderSetupView);
      setError(undefined);
    } catch {
      setError('Couldn’t reach AgentDeck to check your providers. It will retry.');
    }
  }, []);

  const busy = !view || view.providers.some((entry) => (
    entry.operation?.state === 'running' || !entry.confirmedThisLaunch || entry.agentAccess?.state === 'checking'
  ));
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (unavailable || (!busy && !error)) return undefined;
    const timer = setInterval(() => { void refresh(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [busy, error, refresh, unavailable]);

  const act = useCallback(async (provider: string, action: ActionPath, body?: unknown): Promise<boolean> => {
    try {
      const response = await apiFetch(`/api/provider-setup/${provider}/${action}`, {
        method: 'POST',
        ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
      const result = await response.json() as ProviderSetupView & { error?: string };
      if (!response.ok) { setError(result.error ?? 'That did not work. Try again.'); return false; }
      setView(result);
      setError(undefined);
      return true;
    } catch {
      setError('Couldn’t reach AgentDeck. Try again.');
      return false;
    }
  }, []);

  return { view, error, act };
}

function formatChecked(iso: string): string {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? new Date(time).toLocaleString() : iso;
}

function SignInProgress({ entry, onAct }: { entry: ProviderSetupEntry; onAct: (action: ActionPath, body?: unknown) => Promise<boolean> }) {
  const [code, setCode] = useState('');
  const operation = entry.operation!;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!code.trim()) return;
    // The code goes straight to the provider's CLI; the field never keeps it.
    const value = code.trim();
    setCode('');
    await onAct('sign-in/code', { code: value });
  };
  return (
    <div className="provider-progress" role="status">
      <p><strong>Finish signing in in your browser.</strong> Sign in on {entry.provider === 'claude' ? 'Anthropic' : 'OpenAI'}’s page, then come back here. AgentDeck checks your sign-in as soon as it finishes.</p>
      <div className="provider-actions">
        {operation.browserPageAvailable && <button className="button" onClick={() => void onAct('sign-in/page')} type="button">Open sign-in page</button>}
        <button className="button" onClick={() => void onAct('cancel')} type="button">Cancel sign-in</button>
      </div>
      {operation.acceptsCode && (
        <form className="provider-code" onSubmit={(event) => void submit(event)}>
          <label htmlFor={`provider-code-${entry.provider}`}>If the page shows a code, paste it here:</label>
          <div className="provider-code-row">
            <input
              aria-label="Sign-in code"
              autoComplete="off"
              id={`provider-code-${entry.provider}`}
              onChange={(event) => setCode(event.target.value)}
              spellCheck={false}
              value={code}
            />
            <button className="button button-primary" disabled={!code.trim()} type="submit">Submit code</button>
          </div>
        </form>
      )}
    </div>
  );
}

/** Whether Claude may help with personal tasks: AgentDeck proves its sandbox itself (agent-access.ts). */
function AgentAccessStatus({ entry, onAct }: { entry: ProviderSetupEntry; onAct: (action: ActionPath) => Promise<boolean> }) {
  const access = entry.agentAccess!;
  if (access.state === 'checking') {
    return (
      <div className="provider-progress" role="status">
        <p><strong>Checking that Claude stays sandboxed on this Mac…</strong> This takes a minute or two and uses a small amount of your Claude allowance. Personal tasks wait for it.</p>
      </div>
    );
  }
  if (access.state === 'on') {
    return <p className="provider-facts">Agent help for personal tasks is on. Claude runs sandboxed on this Mac.</p>;
  }
  return (
    <div className="provider-repair">
      <h4>Agent help for personal tasks is off</h4>
      {access.reason && <p className="provider-detail">{access.reason}</p>}
      <div className="provider-actions">
        <button className="button" onClick={() => void onAct('agent-access')} type="button">Check sandbox again</button>
      </div>
    </div>
  );
}

function ProviderCard({ entry, onAct }: { entry: ProviderSetupEntry; onAct: (action: ActionPath, body?: unknown) => Promise<boolean> }) {
  const { readiness, operation, repair } = entry;
  const running = operation?.state === 'running';
  const status = running
    ? { label: operation.kind === 'install' ? 'Installing…' : operation.kind === 'sign-in' ? 'Signing in…' : 'Checking…', tone: 'running' }
    : readiness
      ? { label: STATE_LABELS[readiness.state], tone: readiness.state === 'ready' ? 'ready' : 'attention' }
      : { label: 'Checking…', tone: 'running' };
  const facts = readiness ? [
    readiness.cliVersion ? `Version ${readiness.cliVersion}` : undefined,
    readiness.authMethod ? `Signed in with ${AUTH_LABELS[readiness.authMethod] ?? readiness.authMethod}${readiness.plan ? ` (${readiness.plan})` : ''}` : undefined,
    `Checked ${formatChecked(readiness.checkedAt)}`,
  ].filter(Boolean) : [];
  const showRepair = !running && repair && readiness?.state !== 'ready';

  return (
    <li className={`provider-card is-${status.tone}`}>
      <header>
        <h3>{entry.name}</h3>
        {entry.provider === 'claude' && <span className="provider-tag">Recommended · used by Personal tasks</span>}
        <span className={`provider-status is-${status.tone}`}>{status.label}</span>
      </header>
      {readiness && <p className="provider-detail">{readiness.detail}</p>}
      {facts.length > 0 && <p className="provider-facts">{facts.join(' · ')}</p>}
      {readiness && !entry.confirmedThisLaunch && (
        <p className="provider-note">This was last confirmed before AgentDeck restarted. Checking again…</p>
      )}
      {readiness?.allowance && readiness.allowance.length > 0 && (
        <ul className="provider-allowance" aria-label="Plan allowance">
          {readiness.allowance.map((window) => (
            <li key={window.window}>
              <span>{window.window}</span>
              <span className="provider-meter" aria-hidden="true"><span style={{ width: `${Math.min(100, window.usedPercent)}%` }} /></span>
              <span>{window.usedPercent}% used{window.resetsAt ? ` · resets ${window.resetsAt}` : ''}</span>
            </li>
          ))}
        </ul>
      )}

      {running && operation.kind === 'sign-in' && <SignInProgress entry={entry} onAct={onAct} />}
      {running && operation.kind === 'install' && (
        <div className="provider-progress" role="status">
          <p><strong>Installing Claude Code…</strong> This usually takes under a minute. AgentDeck checks it when the installer finishes.</p>
          <div className="provider-actions"><button className="button" onClick={() => void onAct('cancel')} type="button">Cancel</button></div>
        </div>
      )}
      {operation?.state === 'failed' && <p className="provider-error" role="alert">{operation.message}</p>}

      {showRepair && (
        <div className="provider-repair">
          <h4>{repair.title}</h4>
          {repair.steps.length > 0 && <ol>{repair.steps.map((step) => <li key={step}>{step}</li>)}</ol>}
          <div className="provider-actions">
            {repair.actions.map((action, index) => (
              <button
                className={`button${index === 0 ? ' button-primary' : ''}`}
                key={action}
                onClick={() => void onAct(ACTION_PATHS[action])}
                type="button"
              >
                {action === 'install' ? `Install ${PROVIDER_NAMES[entry.provider]}` : ACTION_LABELS[action]}
              </button>
            ))}
          </div>
        </div>
      )}
      {!running && readiness?.state === 'ready' && entry.confirmedThisLaunch && entry.agentAccess && (
        <AgentAccessStatus entry={entry} onAct={onAct} />
      )}
      {!running && readiness?.state === 'ready' && (
        <div className="provider-actions">
          <button className="button" onClick={() => void onAct('check')} type="button">Check again</button>
          <button className="button" onClick={() => void onAct('sign-in')} type="button">Switch account</button>
        </div>
      )}
    </li>
  );
}

function ProviderList({ view, error, act }: ReturnType<typeof useProviderSetup>) {
  return (
    <>
      <p className="field-hint-block">
        AgentDeck uses the Claude Code or Codex app installed on this Mac. You sign in on the provider’s own page, and your sign-in stays with the provider. AgentDeck never sees or stores your password or API key.
      </p>
      {error && <p className="provider-error" role="alert">{error}</p>}
      {!view && !error && <p className="provider-note" role="status">Checking your providers…</p>}
      {view && (
        <ul className="provider-list">
          {view.providers.map((entry) => (
            <ProviderCard entry={entry} key={entry.provider} onAct={(action, body) => act(entry.provider, action, body)} />
          ))}
        </ul>
      )}
    </>
  );
}

/** Settings › Providers. */
export function ProviderSetupPanel() {
  const setup = useProviderSetup();
  return <div className="provider-setup"><ProviderList {...setup} /></div>;
}

/**
 * Home: shown only once every provider has been checked this launch and none
 * is ready, so a working developer setup never sees it. It stays until the
 * owner dismisses it after finishing, so success is visible.
 */
export function HomeProviderSetup() {
  const setup = useProviderSetup();
  const [shown, setShown] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const providers = setup.view?.providers ?? [];
  const checked = providers.length > 0 && providers.every((entry) => entry.confirmedThisLaunch || entry.operation);
  const anyReady = providers.some((entry) => entry.readiness?.state === 'ready' && entry.confirmedThisLaunch);
  const needsSetup = checked && !anyReady;
  useEffect(() => { if (needsSetup) setShown(true); }, [needsSetup]);
  if (dismissed || !(shown || needsSetup)) return null;
  return (
    <section aria-labelledby="home-provider-setup" className="home-section provider-setup is-home">
      <header className="home-section-header">
        <h2 id="home-provider-setup">Set up an AI provider</h2>
        {anyReady && <button className="text-button home-section-link" onClick={() => setDismissed(true)} type="button">Done</button>}
      </header>
      <ProviderList {...setup} />
    </section>
  );
}
