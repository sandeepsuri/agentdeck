import { useCallback, useEffect, useMemo, useState } from 'react';

export type PublishMode = 'commit' | 'pr';

interface PublishFile {
  path: string;
  additions: number;
  deletions: number;
  partiallyStaged?: boolean;
}

interface PullRequestResult {
  number: number;
  url: string;
  title: string;
  state: string;
  draft: boolean;
}

interface PublishStatus {
  branch?: string;
  baseBranch?: string;
  baseCandidates: string[];
  remote?: { name: 'origin'; url: string; github: boolean };
  upstream?: string;
  ahead: number;
  stagedFiles: PublishFile[];
  unstagedCount: number;
  identity: { configured: boolean; name?: string; email?: string };
  github: {
    state: 'missing' | 'unauthenticated' | 'ready';
    installed: boolean;
    authenticated: boolean;
    account?: string;
    detail: string;
  };
  existingPr?: PullRequestResult;
  canCommit: boolean;
  canCreatePr: boolean;
  blockers: { code: string; message: string }[];
}

interface CompletedSteps {
  commit?: { sha: string; subject: string };
  push?: { remote: 'origin'; branch: string; upstream: string };
  pullRequest?: PullRequestResult;
}

async function requestJson<T>(url: string, body?: object): Promise<T> {
  const response = await fetch(url, body ? {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  } : undefined);
  const value = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `Request failed (${response.status})`);
  return value;
}

export function PublishModal({ repoPath, initialMode, onClose, onChanged }: {
  repoPath: string;
  initialMode: PublishMode;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<PublishMode>(initialMode);
  const [status, setStatus] = useState<PublishStatus | null>(null);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [subject, setSubject] = useState('');
  const [commitBody, setCommitBody] = useState('');
  const [prTitle, setPrTitle] = useState('');
  const [prBody, setPrBody] = useState('');
  const [base, setBase] = useState('');
  const [draft, setDraft] = useState(true);
  const [phase, setPhase] = useState<'form' | 'progress' | 'success'>('form');
  const [activeStep, setActiveStep] = useState<'commit' | 'push' | 'pr' | null>(null);
  const [completed, setCompleted] = useState<CompletedSteps>({});
  const [actionError, setActionError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    setLoadingError(null);
    setCheckingStatus(true);
    try {
      const next = await requestJson<PublishStatus>(`/api/repos/publish-status?${new URLSearchParams({ repo: repoPath })}`);
      setStatus(next);
      setBase((current) => current && next.baseCandidates.includes(current) ? current : next.baseBranch ?? next.baseCandidates[0] ?? '');
    } catch (error) {
      setLoadingError(error instanceof Error ? error.message : String(error));
    } finally {
      setCheckingStatus(false);
    }
  }, [repoPath]);

  useEffect(() => { void loadStatus(); }, [loadStatus]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && phase !== 'progress') onClose();
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [onClose, phase]);

  const hasStaged = Boolean(status?.stagedFiles.length);
  const ghUnavailable = mode === 'pr' && status && status.github.state !== 'ready';
  const canSubmit = Boolean(status) && !loadingError && subject.trim().length <= 160
    && (mode === 'commit'
      ? status!.canCommit && Boolean(subject.trim())
      : status!.canCreatePr && Boolean(base) && Boolean(prTitle.trim()) && prTitle.trim().length <= 256
        && (!hasStaged || Boolean(subject.trim())));
  const repoName = repoPath.split('/').pop() ?? repoPath;
  const routeLabel = `${status?.branch ?? 'detached'} → origin → ${base || 'base'}`;
  const result = mode === 'commit' ? completed.commit : completed.pullRequest;
  const blockers = useMemo(() => status?.blockers.filter((blocker) => mode === 'pr'
    || blocker.code === 'missing_identity' || blocker.code === 'nothing_to_publish') ?? [], [mode, status]);

  const changeSubject = (value: string) => {
    setSubject((previous) => {
      if (!prTitle || prTitle === previous) setPrTitle(value);
      return value;
    });
  };

  const run = async () => {
    if (!status || !canSubmit || (phase === 'progress' && !actionError)) return;
    setPhase('progress');
    setActionError(null);
    const next: CompletedSteps = { ...completed };
    try {
      if (status.stagedFiles.length > 0 && !next.commit) {
        setActiveStep('commit');
        next.commit = await requestJson('/api/repos/commit', { repo: repoPath, subject, body: commitBody });
        setCompleted({ ...next });
        onChanged();
      }
      if (mode === 'commit') {
        setActiveStep(null);
        setPhase('success');
        return;
      }
      if (!next.push) {
        setActiveStep('push');
        next.push = await requestJson('/api/repos/push', { repo: repoPath });
        setCompleted({ ...next });
      }
      if (!next.pullRequest) {
        setActiveStep('pr');
        next.pullRequest = await requestJson('/api/repos/pull-request', {
          repo: repoPath, base, title: prTitle, body: prBody, draft,
        });
        setCompleted({ ...next });
      }
      setActiveStep(null);
      setPhase('success');
      onChanged();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
      setCompleted({ ...next });
      setActiveStep(null);
    }
  };

  const switchMode = (next: PublishMode) => {
    if (phase === 'progress') return;
    setMode(next);
    setPhase('form');
    setActionError(null);
    setCompleted({});
  };

  const stepState = (step: keyof CompletedSteps) => completed[step] ? 'is-done'
    : activeStep === (step === 'pullRequest' ? 'pr' : step) ? 'is-active' : '';

  return (
    <div className="publish-backdrop" onMouseDown={() => phase !== 'progress' && onClose()} role="presentation">
      <section aria-label="Publish changes" aria-modal="true" className="publish-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog">
        <header className="publish-header">
          <span className="publish-mark">⇧</span>
          <span><strong>{mode === 'commit' ? 'Commit staged changes' : 'Publish changes'}</strong><small>Commit locally or open a GitHub pull request</small></span>
          <em>{repoName} · {status?.branch ?? 'checking branch'}</em><kbd>ESC</kbd>
          <button aria-label="Close" disabled={phase === 'progress'} onClick={onClose} type="button">×</button>
        </header>
        <nav className="publish-tabs">
          <button className={mode === 'commit' ? 'is-active' : ''} onClick={() => switchMode('commit')} type="button">Commit locally</button>
          <button className={mode === 'pr' ? 'is-active' : ''} onClick={() => switchMode('pr')} type="button">Create pull request</button>
        </nav>

        {!status && !loadingError && <div className="publish-state"><span className="publish-state-icon">···</span><h2>Checking repository</h2><p>Reading staged changes, branch state, Git identity, and GitHub availability.</p></div>}
        {loadingError && <div className="publish-state"><span className="publish-state-icon is-error">!</span><h2>Preflight failed</h2><p>{loadingError}</p><button className="button" onClick={() => void loadStatus()} type="button">Recheck</button></div>}

        {status && ghUnavailable && phase === 'form' && <>
          <div className="publish-state"><span className="publish-state-icon is-warning">!</span><h2>{status.github.state === 'missing' ? 'GitHub CLI is required' : 'GitHub CLI authentication required'}</h2><p>{status.github.detail} AgentDeck uses an authenticated GitHub CLI to create pull requests without storing access tokens.</p><code>{status.github.state === 'missing' ? '$ brew install gh && gh auth login --hostname github.com' : '$ gh auth login --hostname github.com'}</code></div>
          <footer className="publish-footer"><span className="is-warning"><i />Pull request publishing unavailable</span><button className="button" onClick={() => switchMode('commit')} type="button">Commit locally instead</button><button className="button button-primary" disabled={checkingStatus} onClick={() => void loadStatus()} type="button">{checkingStatus ? 'Checking…' : 'Recheck'}</button></footer>
        </>}

        {status && !ghUnavailable && phase === 'form' && <form onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void run(); } }} onSubmit={(event) => { event.preventDefault(); void run(); }}>
          <div className="publish-content">
            <div className="publish-form">
              {mode === 'pr' && <div className="publish-field"><label>Publish route <small>remote and head are inferred</small></label><div className="publish-route">{routeLabel}</div></div>}
              {hasStaged && <>
                <div className="publish-field"><label htmlFor="publish-subject">Commit subject <small>required · {subject.length}/160</small></label><input autoFocus id="publish-subject" maxLength={160} onChange={(event) => changeSubject(event.target.value)} value={subject} /></div>
                <div className="publish-field"><label htmlFor="publish-details">Commit details <small>optional</small></label><textarea id="publish-details" onChange={(event) => setCommitBody(event.target.value)} rows={3} value={commitBody} /></div>
              </>}
              {mode === 'pr' && <>
                <div className="publish-two-col">
                  <div className="publish-field"><label htmlFor="publish-title">Pull request title <small>required · {prTitle.length}/256</small></label><input autoFocus={!hasStaged} id="publish-title" maxLength={256} onChange={(event) => setPrTitle(event.target.value)} value={prTitle} /></div>
                  <div className="publish-field"><label htmlFor="publish-base">Base branch <small>GitHub</small></label><select id="publish-base" onChange={(event) => setBase(event.target.value)} value={base}>{status.baseCandidates.map((candidate) => <option key={candidate}>{candidate}</option>)}</select></div>
                </div>
                <div className="publish-field"><label htmlFor="publish-description">Description <small>Markdown supported</small></label><textarea id="publish-description" onChange={(event) => setPrBody(event.target.value)} rows={6} value={prBody} /></div>
                <label className="publish-toggle"><input checked={draft} onChange={(event) => setDraft(event.target.checked)} type="checkbox" /><span /><strong>Create as draft<small>Mark ready for review later on GitHub.</small></strong></label>
              </>}
              {actionError && <div className="form-error">{actionError}</div>}
            </div>
            <aside className="publish-summary">
              <div className="micro-heading">Staged for commit · {status.stagedFiles.length}</div>
              {status.stagedFiles.length === 0 && <p className="publish-note">No staged files. The existing {status.ahead} branch commit{status.ahead === 1 ? '' : 's'} will be published.</p>}
              {status.stagedFiles.map((file) => <div className="publish-file" key={file.path}><span>{file.partiallyStaged ? '◐' : '✓'}</span><strong title={file.path}>{file.path}</strong><small>+{file.additions} −{file.deletions}</small></div>)}
              {status.unstagedCount > 0 && <p className="publish-note">Only staged hunks will be committed. {status.unstagedCount} unstaged file{status.unstagedCount === 1 ? '' : 's'} stay in your worktree.</p>}
              <div className="micro-heading publish-preflight-heading">Preflight</div>
              <div className={`publish-check${status.identity.configured ? ' is-ok' : ''}`}><span>{status.identity.configured ? '✓' : '!'}</span><strong>Git identity {status.identity.configured ? 'configured' : 'missing'}<small>{status.identity.name && status.identity.email ? `${status.identity.name} <${status.identity.email}>` : 'Configure user.name and user.email'}</small></strong></div>
              {mode === 'pr' && <>
                <div className={`publish-check${status.github.authenticated ? ' is-ok' : ''}`}><span>{status.github.authenticated ? '✓' : '!'}</span><strong>GitHub CLI {status.github.authenticated ? 'authenticated' : 'unavailable'}<small>{status.github.account ? `github.com · ${status.github.account}` : 'Authentication required'}</small></strong></div>
                <div className={`publish-check${status.remote?.github ? ' is-ok' : ''}`}><span>{status.remote?.github ? '✓' : '!'}</span><strong>Remote {status.remote?.github ? 'ready' : 'unavailable'}<small>{status.remote ? `${status.remote.name} · ${status.upstream ? 'upstream configured' : 'push with upstream'}` : 'Add a GitHub origin remote'}</small></strong></div>
              </>}
              {blockers.map((blocker) => <div className="publish-blocker" key={blocker.code}>{blocker.message}</div>)}
              {status.existingPr && <button className="button publish-open-existing" onClick={() => window.open(status.existingPr!.url, '_blank', 'noopener,noreferrer')} type="button">Open pull request #{status.existingPr.number} ↗</button>}
            </aside>
          </div>
          <footer className="publish-footer"><span className={canSubmit ? 'is-ready' : ''}><i />{canSubmit ? mode === 'commit' ? `${status.stagedFiles.length} staged files will be committed locally` : 'Ready to publish safely' : 'Resolve preflight requirements to continue'}</span><button className="button" onClick={onClose} type="button">Cancel</button><button className="button button-primary" disabled={!canSubmit} type="submit">{mode === 'commit' ? 'Commit staged' : draft ? 'Create draft PR' : 'Create PR'} <kbd>⌘⏎</kbd></button></footer>
        </form>}

        {status && phase === 'progress' && <>
          <div className="publish-content"><div className="publish-progress"><h2>{mode === 'commit' ? 'Committing staged changes' : `Publishing ${status.branch}`}</h2><p>Completed steps are retained if a later operation needs to be retried.</p>
            <div className={`publish-step ${stepState('commit')}`}><span>{completed.commit ? '✓' : '1'}</span><strong>Commit staged changes<small>{completed.commit ? `${completed.commit.sha} · ${completed.commit.subject}` : status.stagedFiles.length ? 'Create the local commit' : 'No staged changes · skipped'}</small></strong><em>{completed.commit ? 'done' : activeStep === 'commit' ? 'working' : status.stagedFiles.length ? 'queued' : 'skip'}</em></div>
            {mode === 'pr' && <><div className={`publish-step ${stepState('push')}`}><span>{completed.push ? '✓' : '2'}</span><strong>Push branch to origin<small>{completed.push?.upstream ?? `Set upstream for ${status.branch}`}</small></strong><em>{completed.push ? 'done' : activeStep === 'push' ? 'working' : 'queued'}</em></div><div className={`publish-step ${stepState('pullRequest')}`}><span>{completed.pullRequest ? '✓' : '3'}</span><strong>Create {draft ? 'draft ' : ''}pull request<small>{completed.pullRequest?.url ?? `Target ${base}`}</small></strong><em>{completed.pullRequest ? 'done' : activeStep === 'pr' ? 'working' : 'queued'}</em></div></>}
            {actionError && <div className="form-error publish-progress-error">{actionError}</div>}
          </div><aside className="publish-summary"><div className="micro-heading">Completed safely</div><p className="publish-note">Successful steps will not be repeated when you retry.</p>{completed.commit && <div className="publish-check is-ok"><span>✓</span><strong>Local commit created<small>{completed.commit.sha}</small></strong></div>}{completed.push && <div className="publish-check is-ok"><span>✓</span><strong>Branch pushed<small>{completed.push.upstream}</small></strong></div>}</aside></div>
          <footer className="publish-footer"><span className={actionError ? 'is-warning' : 'is-ready'}><i />{actionError ? 'Publishing paused at the failed step' : 'Publishing in progress'}</span><button className="button" disabled={!actionError} onClick={onClose} type="button">Close</button><button className="button button-primary" disabled={!actionError} onClick={() => void run()} type="button">{actionError ? 'Retry failed step' : 'Working…'}</button></footer>
        </>}

        {status && phase === 'success' && <div className="publish-state publish-success"><span className="publish-state-icon is-success">✓</span><h2>{mode === 'commit' ? 'Changes committed' : `${draft ? 'Draft pull request' : 'Pull request'} created`}</h2><p>{mode === 'commit' ? 'Your staged changes were committed locally. Unstaged work is unchanged.' : 'The branch was pushed to origin and GitHub opened the pull request.'}</p>
          {result && <div className="publish-result"><span>{'url' in result ? result.url : `${result.sha} · ${result.subject}`}</span><button className="button" onClick={() => void navigator.clipboard.writeText('url' in result ? result.url : result.sha)} type="button">Copy</button>{'url' in result && <button className="button button-primary" onClick={() => window.open(result.url, '_blank', 'noopener,noreferrer')} type="button">Open ↗</button>}</div>}
          <button className="button" onClick={onClose} type="button">Done</button></div>}
      </section>
    </div>
  );
}
