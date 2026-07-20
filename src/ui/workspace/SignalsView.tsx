import type { AgentMessage } from '../../types.js';

export function SignalsView({ events }: { events: AgentMessage[] }) {
  return (
    <section className="workspace-scroll signals-view">
      <div className="signals-inner">
        <div className="view-heading signals-heading">
          <h1>Signals</h1>
          <span>.agents/bus.jsonl · hooks · file watcher</span>
        </div>
        <p>Everything the agents report: claims, progress, blockers, prompts, and file events.</p>
        <div className="signal-list">
          {[...events].reverse().map((event, index) => (
            <div className="signal-row" key={`${event.ts}-${event.agent}-${event.event}-${index}`}>
              <time>{new Date(event.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
              <span className={`signal-tag signal-${event.event}`}>{event.event}</span>
              <strong title={event.agent}>{event.agent}</strong>
              <span>{event.message ?? event.summary ?? event.files?.join(', ') ?? event.status ?? event.task ?? 'Event received'}</span>
            </div>
          ))}
          {events.length === 0 && <div className="empty-workspace compact"><strong>No signals yet</strong><span>Agent events will appear here in real time.</span></div>}
        </div>
      </div>
    </section>
  );
}
