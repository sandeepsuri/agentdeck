// Everyday 04 (#79): the everyday Home. Three things, in this order: Ask
// (hands the typed text to the existing Start work flow, unsent), Needs you
// (the one derived queue, needsYou.ts), and Tasks (real Runs and Sessions,
// workItems.ts). Personal tasks don't exist yet, so nothing here invents
// one. Each section tells the truth about its source — still loading,
// unreachable, or genuinely empty. Every action routes through handlers
// App.tsx already owns (resolveRunAttention, opening work, Start work), so
// Home adds no write path and changes no authorization. The developer
// dashboard that used to live here is Developer tools › Overview.
import { type FormEvent, type KeyboardEvent, type ReactNode, useState } from 'react';
import type { AttentionDecisionInput, WorkRun } from '../../work-engine/types.js';
import { ApprovalCard } from '../components/ApprovalCard.js';
import type { NeedsYouItem } from '../needsYou.js';
import type { WorkBucket, WorkItem } from '../workItems.js';
import { WorkRow } from './WorkRow.js';

/** Whether a data source behind Home has answered: never loaded yet, loaded, or its latest refresh failed. */
export type HomeSourceState = 'loading' | 'ready' | 'error';

/** One view over several sources: any failure is an error, else any still loading is loading. */
export function combineSourceStates(...states: HomeSourceState[]): HomeSourceState {
  if (states.includes('error')) return 'error';
  return states.includes('loading') ? 'loading' : 'ready';
}

export interface HomeViewProps {
  needsYou: readonly NeedsYouItem[];
  workItems: readonly WorkItem[];
  runs: readonly WorkRun[];
  /** `work` covers Runs and Sessions — the sources of both Needs you and Tasks. */
  sources: { work: HomeSourceState; repositories: HomeSourceState };
  repositoryCount: number;
  onAsk: (task: string) => void;
  onOpenNeedsYou: (item: NeedsYouItem) => void;
  onOpenWorkItem: (item: WorkItem) => void;
  onOpenWork: () => void;
  onOpenSettings: () => void;
  onResolveRunAttention: (runId: string, attentionId: string, decision: AttentionDecisionInput) => Promise<void> | void;
}

/** Most pressing first; archived work stays in Work. */
const TASK_ORDER: Partial<Record<WorkBucket, number>> = { needs_you: 0, working: 1, review: 2, completed: 3 };
const TASK_LIMIT = 10;

export function homeTasks(items: readonly WorkItem[]): WorkItem[] {
  return items.filter((item) => TASK_ORDER[item.bucket] !== undefined)
    .sort((a, b) => TASK_ORDER[a.bucket]! - TASK_ORDER[b.bucket]! || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, TASK_LIMIT);
}

const KIND_GLYPH: Record<NeedsYouItem['kind'], string> = {
  permission: '⚠', question: '?', conflict: '△', error: '✕', usage: '◔', review: '◉',
};

function InlineAnswer({ onSubmit }: { onSubmit: (value: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <form className="needs-you-answer" onSubmit={(event) => { event.preventDefault(); if (value.trim()) onSubmit(value.trim()); }}>
      <input aria-label="Your answer" autoFocus onChange={(event) => setValue(event.target.value)} placeholder="Type your answer…" value={value} />
      <button className="button button-primary" disabled={!value.trim()} type="submit">Send</button>
    </form>
  );
}

function NeedsYouRow({ item, run, onOpen, onResolve }: {
  item: NeedsYouItem;
  run: WorkRun | undefined;
  onOpen: () => void;
  onResolve: HomeViewProps['onResolveRunAttention'];
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  // Inline only where acting here is exactly what the detail page would do:
  // a pending Run approval or input request. Everything else opens its work.
  const pending = item.target.kind === 'run' && run?.pendingAttention && run.pendingAttention.id === item.target.attentionId ? run.pendingAttention : undefined;
  const resolve = async (decision: AttentionDecisionInput) => {
    if (!run || !pending) return;
    setBusy(true);
    try { await onResolve(run.id, pending.id, decision); } finally { setBusy(false); }
  };
  return (
    <li className={`needs-you-item kind-${item.kind}`}>
      <div className="needs-you-summary">
        <span aria-hidden="true" className="needs-you-glyph">{KIND_GLYPH[item.kind]}</span>
        <span className="needs-you-copy">
          <strong>{item.title}</strong>
          <small>{item.context}</small>
          {item.detail && !expanded && <code>{item.detail}</code>}
        </span>
        <button
          aria-expanded={pending ? expanded : undefined}
          className={`button${item.kind === 'permission' || item.kind === 'question' ? ' button-primary' : ''}`}
          onClick={() => (pending ? setExpanded((current) => !current) : onOpen())}
          type="button"
        >
          {pending && expanded ? 'Close' : item.action}
        </button>
      </div>
      {pending && expanded && run && (pending.kind === 'approval'
        ? (
          <ApprovalCard
            busy={busy}
            fallbackAgent={run.spec.runtimePreference[0] === 'codex' ? 'Codex' : 'Claude'}
            intent={run.spec.objective}
            onApprove={() => void resolve({ kind: 'approve' })}
            onDeny={() => void resolve({ kind: 'deny' })}
            reason={pending.reason}
            repositoryName={run.spec.repository.name}
            {...(run.preparation.worktreePath ? { workingDirectory: run.preparation.worktreePath } : {})}
          />
        )
        : <InlineAnswer onSubmit={(value) => void resolve({ kind: 'input', value })} />)}
    </li>
  );
}

function AskSection({ repositoryCount, repositoriesState, onAsk, onOpenSettings }: {
  repositoryCount: number;
  repositoriesState: HomeSourceState;
  onAsk: (task: string) => void;
  onOpenSettings: () => void;
}) {
  const [value, setValue] = useState('');
  // Only a confirmed empty list blocks Ask; while loading or unreachable,
  // Start work itself shows what it can.
  const noRepository = repositoriesState === 'ready' && repositoryCount === 0;
  const task = value.trim();
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!task || noRepository) return;
    onAsk(task);
    setValue('');
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) submit(event);
  };
  return (
    <section aria-labelledby="home-ask" className="home-section home-ask">
      <header className="home-section-header"><h2 id="home-ask">Ask</h2></header>
      <form className="home-ask-form" onSubmit={submit}>
        <label className="home-ask-label" htmlFor="home-ask-input">What do you want done?</label>
        <textarea
          aria-describedby="home-ask-help"
          disabled={noRepository}
          id="home-ask-input"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Describe the task…"
          rows={2}
          value={value}
        />
        <div className="home-ask-footer">
          <p className="home-ask-help" id="home-ask-help">
            {noRepository
              ? <>Add a repository before asking for work. <button className="text-button" onClick={onOpenSettings} type="button">Open Settings</button></>
              : repositoriesState === 'error'
                ? 'Couldn’t load your repositories. You can still continue and choose one in Start work.'
                : 'Continue opens Start work to choose a repository and agent. Nothing starts until you confirm there.'}
          </p>
          <button className="button button-primary" disabled={!task || noRepository} type="submit">Continue</button>
        </div>
      </form>
    </section>
  );
}

/** What a section says instead of (or beside) its list when its source isn't simply loaded. */
function SourceNote({ state, hasItems, loading, unreachable, stale, empty }: {
  state: HomeSourceState;
  hasItems: boolean;
  loading: string;
  unreachable: string;
  stale: string;
  empty: ReactNode;
}) {
  if (state === 'error') return <p className="home-empty is-error" role="alert">{hasItems ? stale : unreachable}</p>;
  if (hasItems) return null;
  if (state === 'loading') return <p className="home-empty" role="status">{loading}</p>;
  return <p className="home-empty">{empty}</p>;
}

export function HomeView({
  needsYou, workItems, runs, sources, repositoryCount,
  onAsk, onOpenNeedsYou, onOpenWorkItem, onOpenWork, onOpenSettings, onResolveRunAttention,
}: HomeViewProps) {
  const tasks = homeTasks(workItems);
  return (
    <section className="workspace-scroll home-view">
      <div className="view-heading home-heading"><h1>Home</h1></div>

      <AskSection onAsk={onAsk} onOpenSettings={onOpenSettings} repositoriesState={sources.repositories} repositoryCount={repositoryCount} />

      <section aria-labelledby="home-needs-you" className="home-section">
        <header className="home-section-header"><h2 id="home-needs-you">Needs you</h2>{needsYou.length > 0 && <span aria-label={`${needsYou.length} item${needsYou.length === 1 ? '' : 's'}`} className="home-count">{needsYou.length}</span>}</header>
        {needsYou.length > 0 && (
          <ol className="needs-you-list">
            {needsYou.map((item) => (
              <NeedsYouRow
                item={item}
                key={item.id}
                onOpen={() => onOpenNeedsYou(item)}
                onResolve={onResolveRunAttention}
                run={item.target.kind === 'run' ? runs.find((run) => run.id === (item.target as { runId: string }).runId) : undefined}
              />
            ))}
          </ol>
        )}
        <SourceNote
          empty="Nothing needs you right now."
          hasItems={needsYou.length > 0}
          loading="Checking what needs you…"
          stale="Couldn’t refresh from AgentDeck, so this list may be out of date. It will retry automatically."
          state={sources.work}
          unreachable="Couldn’t check what needs you because AgentDeck isn’t responding. It will retry automatically."
        />
      </section>

      <section aria-labelledby="home-tasks" className="home-section">
        <header className="home-section-header">
          <h2 id="home-tasks">Tasks</h2>
          {tasks.length > 0 && <button className="text-button home-section-link" onClick={onOpenWork} type="button">See all work</button>}
        </header>
        {tasks.length > 0 && <div className="work-list">{tasks.map((item) => <WorkRow item={item} key={item.id} onOpen={() => onOpenWorkItem(item)} />)}</div>}
        <SourceNote
          empty="No tasks yet. Ask for something above to get started."
          hasItems={tasks.length > 0}
          loading="Loading tasks…"
          stale="Couldn’t refresh from AgentDeck, so tasks may be out of date. It will retry automatically."
          state={sources.work}
          unreachable="Couldn’t load tasks because AgentDeck isn’t responding. It will retry automatically."
        />
      </section>
    </section>
  );
}
