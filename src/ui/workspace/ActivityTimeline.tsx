import type { AgentMessage, Session } from '../../types.js';
import { deriveActivityTimeline } from '../activityTimeline.js';

/** Redesign spec §06: observable actions only, oldest first, kept after the agent exits. */
export function ActivityTimeline({ session, events }: { session: Session; events: readonly AgentMessage[] }) {
  const entries = deriveActivityTimeline(events, session);
  if (entries.length === 0) {
    return <p className="activity-empty">No activity reported yet. Actions appear here as the agent reads, edits, tests or asks.</p>;
  }
  return (
    <ol aria-label="Activity" className="activity-timeline">
      {entries.map((entry) => (
        <li className={`activity-entry verb-${entry.verb}`} key={entry.id}>
          <time dateTime={entry.at}>{new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
          <span aria-hidden="true" className="activity-dot" />
          <span className="activity-copy"><strong>{entry.label}</strong>{entry.detail && <span>{entry.detail}</span>}</span>
        </li>
      ))}
    </ol>
  );
}
