// What the inspector says about a session right now, derived from data the
// UI already has: the agent's own transcript (GET /api/sessions/:id/
// conversation — its tool calls, checklist and open question) and the
// session's status. Pure, so the panel only renders.
import type { ConversationTurn, ConversationView, PlanStep } from '../../sessions/conversation.js';
import type { Session } from '../../types.js';
import { verbForText } from '../activityTimeline.js';

export type ToolKind = 'command' | 'edit' | 'read' | 'search' | 'other';

export interface ToolActivity {
  id: string;
  at: string;
  kind: ToolKind;
  /** "Running test suite", "Editing gmail.ts" — for the step in progress. */
  present: string;
  /** "Ran test suite", "Edited gmail.ts" — once it is history. */
  past: string;
  detail: string;
}

const COMMAND_TOOLS = new Set(['Bash', 'BashOutput', 'shell', 'exec', 'exec_command', 'local_shell', 'container.exec']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'apply_patch']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'WebSearch', 'WebFetch', 'ToolSearch']);
/** Tools that are bookkeeping rather than work the user would recognize. */
const HIDDEN_TOOLS = new Set(['TodoWrite', 'update_plan']);

const basename = (value: string) => value.split('/').filter(Boolean).pop() ?? value;

export function describeTool(turn: ConversationTurn): ToolActivity | null {
  const name = turn.toolName ?? 'tool';
  if (HIDDEN_TOOLS.has(name)) return null;
  const detail = turn.text.split('\n')[0]!.trim();
  const base = { id: turn.id, at: turn.ts, detail };
  if (COMMAND_TOOLS.has(name)) {
    return verbForText(detail) === 'testing'
      ? { ...base, kind: 'command', present: 'Running test suite', past: 'Ran test suite' }
      : { ...base, kind: 'command', present: 'Running command', past: 'Ran command' };
  }
  if (EDIT_TOOLS.has(name)) {
    const file = name === 'apply_patch' ? '' : ` ${basename(detail)}`;
    return { ...base, kind: 'edit', present: `Editing${file || ' files'}`, past: `Edited${file || ' files'}` };
  }
  if (name === 'Read') return { ...base, kind: 'read', present: `Reading ${basename(detail)}`, past: `Read ${basename(detail)}` };
  if (SEARCH_TOOLS.has(name)) return { ...base, kind: 'search', present: 'Searching', past: 'Searched' };
  if (name === 'Task' || name === 'Agent') return { ...base, kind: 'other', present: 'Running a helper agent', past: 'Ran a helper agent' };
  return { ...base, kind: 'other', present: `Using ${name}`, past: `Used ${name}` };
}

/** The agent's tool calls, newest first, without bookkeeping calls. */
export function recentTools(turns: readonly ConversationTurn[], limit: number): ToolActivity[] {
  const tools: ToolActivity[] = [];
  for (let index = turns.length - 1; index >= 0 && tools.length < limit; index -= 1) {
    const turn = turns[index]!;
    if (turn.role !== 'tool') continue;
    const activity = describeTool(turn);
    if (activity) tools.push(activity);
  }
  return tools;
}

/** The tool call the agent is in the middle of: the last one, if nothing it said has come after it. */
export function currentTool(turns: readonly ConversationTurn[]): ToolActivity | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    if (turn.role !== 'tool') return null;
    const activity = describeTool(turn);
    if (activity) return activity;
  }
  return null;
}

export interface PlanProgress {
  steps: PlanStep[];
  done: number;
  total: number;
  current?: PlanStep;
}

export function planProgress(plan: readonly PlanStep[] | undefined): PlanProgress | null {
  if (!plan?.length) return null;
  return {
    steps: [...plan],
    done: plan.filter((step) => step.status === 'completed').length,
    total: plan.length,
    current: plan.find((step) => step.status === 'in_progress'),
  };
}

export interface NeedsInput {
  count: number;
  text: string;
  /** True when AgentDeck shows a question card for it; otherwise it's answered in the Terminal (approvals, free text). */
  hasQuestion: boolean;
}

export function isLive(session: Session): boolean {
  return session.status !== 'exited' && session.status !== 'completed';
}

export function needsInput(session: Session, conversation: ConversationView | null): NeedsInput | null {
  if (!isLive(session)) return null;
  const agent = session.agent === 'claude' ? 'Claude' : 'Codex';
  const question = conversation?.question;
  if (question?.questions.length) {
    return { count: question.questions.length, text: `${agent} is asking: ${question.questions[0]!.question}`, hasQuestion: true };
  }
  if (session.status === 'waiting_input') {
    return { count: 1, text: `${agent} is waiting for you — it may be asking for approval or a choice.`, hasQuestion: false };
  }
  return null;
}

/** Working, animated; everything else settles to a static state. */
export function isWorking(session: Session, input: NeedsInput | null): boolean {
  return !input && (session.status === 'working' || session.status === 'starting');
}

export interface DiffTotals {
  files: { path: string; additions: number; deletions: number }[];
  additions: number;
  deletions: number;
}

export function diffTotals(files: readonly { path: string; additions: number; deletions: number }[]): DiffTotals {
  return {
    files: [...files],
    additions: files.reduce((sum, file) => sum + (file.additions || 0), 0),
    deletions: files.reduce((sum, file) => sum + (file.deletions || 0), 0),
  };
}
