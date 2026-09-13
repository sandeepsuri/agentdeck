// Redesign spec §06: Signals become an Activity timeline attached to work.
// Only observable actions the agent reported through hooks or the bus are
// shown — never model reasoning. The source is the durable event archive
// (GET /api/events), so the timeline outlives the agent process.
import type { AgentMessage, Session } from '../types.js';
import { repoPathOf } from './workspace/model.js';

export type ActivityVerb =
  | 'started' | 'reading' | 'editing' | 'testing' | 'working' | 'waiting' | 'retrying'
  | 'asking' | 'replied' | 'blocked' | 'done' | 'failed' | 'ended';

export interface ActivityEntry {
  id: string;
  at: string;
  verb: ActivityVerb;
  label: string;
  detail?: string;
}

const VERB_LABELS: Partial<Record<ActivityVerb, string>> = {
  reading: 'Reading', testing: 'Testing', retrying: 'Retrying', working: 'Working', editing: 'Editing',
};

function verbForText(text: string): ActivityVerb {
  if (/\bretry|\bretrying|\bagain\b/i.test(text)) return 'retrying';
  if (/\btest|vitest|jest|pytest|playwright|typecheck|\blint/i.test(text)) return 'testing';
  if (/\bread|inspect|search|explor|look(ing)? (at|into)|review/i.test(text)) return 'reading';
  if (/\bedit|writ|updat|implement|fix|refactor|add(ing)?\b|chang/i.test(text)) return 'editing';
  return 'working';
}

function belongsTo(event: AgentMessage, session: Session): boolean {
  if (event.agent.startsWith('dashboard:')) return false;
  if (event.sessionId) return event.sessionId === session.id;
  if (session.agentSessionId && event.agent === session.agentSessionId) return true;
  return event.agent.split(':')[0] === session.agent
    && event.repo === repoPathOf(session)
    && Date.parse(event.ts) >= Date.parse(session.startedAt);
}

function entryFor(event: AgentMessage): Omit<ActivityEntry, 'id' | 'at'> | null {
  const text = event.message?.trim() || event.summary?.trim();
  switch (event.event) {
    case 'session_start': return { verb: 'started', label: 'Started' };
    case 'session_end': return { verb: 'ended', label: 'Agent exited' };
    case 'claim': {
      const files = event.files ?? [];
      if (files.length === 0) return text ? { verb: 'editing', label: 'Editing', detail: text } : null;
      return { verb: 'editing', label: `Editing ${files.length} file${files.length === 1 ? '' : 's'}`, detail: files.join(', ') };
    }
    case 'release': return null;
    case 'blocked': return { verb: 'blocked', label: 'Blocked', ...((event.blockers?.join(', ') || text) ? { detail: event.blockers?.join(', ') || text } : {}) };
    case 'done': return { verb: 'done', label: 'Finished', ...(text ? { detail: text } : {}) };
    case 'failed': return { verb: 'failed', label: 'Failed', ...(text ? { detail: text } : {}) };
    case 'status':
      if (event.status === 'waiting_input') return { verb: 'waiting', label: 'Waiting for input' };
      return text ? { verb: verbForText(text), label: VERB_LABELS[verbForText(text)]!, detail: text } : null;
    case 'message':
      if (!text) return null;
      return event.attention === 'response_required'
        ? { verb: 'asking', label: 'Asked a question', detail: text }
        : { verb: 'replied', label: 'Replied', detail: text };
    case 'progress': {
      if (!text) return null;
      const verb = verbForText(text);
      return { verb, label: VERB_LABELS[verb]!, detail: text };
    }
    default: return null;
  }
}

export function deriveActivityTimeline(events: readonly AgentMessage[], session: Session): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  for (const [index, event] of events.entries()) {
    if (!belongsTo(event, session)) continue;
    const entry = entryFor(event);
    if (!entry) continue;
    const previous = entries.at(-1);
    if (previous && previous.verb === entry.verb && previous.label === entry.label && previous.detail === entry.detail) continue;
    entries.push({ id: `${event.ts}:${index}`, at: event.ts, ...entry });
  }
  return entries.sort((a, b) => a.at.localeCompare(b.at));
}
