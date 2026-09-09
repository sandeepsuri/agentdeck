import type { Session } from '../../types.js';
import type { WorkRun } from '../../work-engine/types.js';
import { sessionLabel, type WorkspaceView, WORKSPACE_VIEWS } from './model.js';

interface Props {
  activeView: WorkspaceView;
  runs: readonly WorkRun[];
  sessions: readonly Session[];
  onView: (view: WorkspaceView) => void;
  onSelectRun: (run: WorkRun) => void;
  onSelectSession: (session: Session) => void;
  onSubmitRun: () => void;
  onLaunch: () => void;
  changeCount?: number;
  historyCount?: number;
}

interface NavigationItem {
  id: WorkspaceView;
  glyph: string;
  badge?: 'changes' | 'history';
}

const NAVIGATION_GROUPS: readonly { label: string; items: readonly NavigationItem[] }[] = [
  { label: 'Repositories', items: [{ id: 'overview', glyph: '⌂' }, { id: 'tasks', glyph: '✓' }, { id: 'changes', glyph: '±', badge: 'changes' }] },
  { label: 'Work', items: [{ id: 'operations', glyph: '◉' }, { id: 'terminal', glyph: '>_' }, { id: 'grid', glyph: '▦' }, { id: 'history', glyph: '↶', badge: 'history' }] },
  { label: 'System', items: [{ id: 'signals', glyph: '⌁' }] },
];

function NavigationGroup({ label, items, activeView, badges, onView }: {
  label: string;
  items: readonly NavigationItem[];
  activeView: WorkspaceView;
  badges: Record<'changes' | 'history', number>;
  onView: (view: WorkspaceView) => void;
}) {
  return (
    <div className="admin-nav-group">
      <div className="admin-nav-label">{label}</div>
      {items.map(({ id, glyph, badge }) => {
        const destination = WORKSPACE_VIEWS.find((item) => item.id === id)!;
        const count = badge ? badges[badge] : 0;
        return (
          <button aria-current={activeView === id ? 'page' : undefined} aria-label={destination.label} className={activeView === id ? 'is-active' : ''} key={id} onClick={() => onView(id)} title={destination.label} type="button">
            <span aria-hidden="true" className="admin-nav-glyph">{glyph}</span>
            <span>{destination.label}</span>
            {count > 0 && <small>{count}</small>}
          </button>
        );
      })}
    </div>
  );
}

export function AdminSidebar({ activeView, runs, sessions, onView, onSelectRun, onSelectSession, onSubmitRun, onLaunch, changeCount = 0, historyCount = 0 }: Props) {
  const attentionRuns = runs.filter((run) => Boolean(run.pendingAttention));
  const attentionSessions = sessions.filter((session) => session.status === 'waiting_input');
  const attentionCount = attentionRuns.length + attentionSessions.length;

  return (
    <aside className="admin-sidebar">
      <div className="admin-sidebar-brand"><span className="brand-mark"><i /></span><strong>AgentDeck</strong></div>
      <nav aria-label="Admin navigation" className="admin-navigation">
        {NAVIGATION_GROUPS.map((group) => <NavigationGroup activeView={activeView} badges={{ changes: changeCount, history: historyCount }} items={group.items} key={group.label} label={group.label} onView={onView} />)}
      </nav>

      {attentionCount > 0 && (
        <section aria-label="Attention" className="admin-sidebar-attention">
          <div className="admin-nav-label">Attention <span>{attentionCount}</span></div>
          <div aria-label={`${attentionCount} item${attentionCount === 1 ? '' : 's'} need attention`} className="attention-compact-count">{attentionCount}</div>
          {attentionRuns.slice(0, 3).map((run) => (
            <button aria-label={`Open Run needing attention: ${run.spec.objective}`} key={run.id} onClick={() => onSelectRun(run)} title={run.spec.objective} type="button">
              <span aria-hidden="true" className="attention-dot" />
              <span><strong>{run.spec.objective}</strong><small>{run.spec.repository.name} · Run</small></span>
            </button>
          ))}
          {attentionSessions.slice(0, Math.max(0, 3 - attentionRuns.length)).map((session) => (
            <button aria-label={`Open Session needing attention: ${sessionLabel(session)}`} key={session.id} onClick={() => onSelectSession(session)} title={sessionLabel(session)} type="button">
              <span aria-hidden="true" className="attention-dot" />
              <span><strong>{sessionLabel(session)}</strong><small>Session waiting for input</small></span>
            </button>
          ))}
        </section>
      )}

      <div className="admin-sidebar-actions">
        <button aria-label="New run" onClick={onSubmitRun} title="New run" type="button"><span aria-hidden="true">＋</span><strong>New run</strong></button>
        <button aria-label="New session" onClick={onLaunch} title="New session" type="button"><span aria-hidden="true">＋</span><strong>New session</strong></button>
      </div>
    </aside>
  );
}
