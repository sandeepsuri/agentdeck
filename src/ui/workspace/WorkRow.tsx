// One Run or Session as a row: shared by Home's Tasks and Developer tools ›
// Overview so both show the same fields for the same work.
import type { WorkItem } from '../workItems.js';
import { Duration } from './model.js';

export function WorkRow({ item, onOpen }: { item: WorkItem; onOpen: () => void }) {
  return (
    <button className={`work-row tone-${item.tone}`} onClick={onOpen} type="button">
      <span className="work-row-agent">{item.agentLabel}</span>
      <strong className="work-row-title" title={item.title}>{item.title}</strong>
      <span className="work-row-repo">{item.repositoryName}</span>
      <span className="work-row-status"><i aria-hidden="true" />{item.statusLabel}</span>
      <span className="work-row-time"><Duration since={item.startedAt} /></span>
    </button>
  );
}
