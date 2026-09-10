import { randomUUID } from 'node:crypto';
import type { StoredSessionChatMessage, StoredSessionInteraction } from '../store/index.js';
import type {
  AgentMessage, Session, SessionInteraction, SessionInteractionChoice, SessionInteractionResponse, SessionInteractionsView,
} from '../types.js';
import { relativizePaths } from './collaborator-run-view.js';
import { sessionRoots } from './collaborator-session-view.js';

type RecordValue = Record<string, unknown>;

const object = (value: unknown): RecordValue | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RecordValue : undefined;

function safeSummary(input: RecordValue): string | undefined {
  for (const key of ['command', 'file_path', 'pattern', 'query', 'url', 'description']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 1000);
  }
  return undefined;
}

function findClaudeSession(providerSessionId: string, agentDeckSessionId: unknown, cwd: string, sessions: readonly Session[]): Session | undefined {
  return sessions.find((candidate) => candidate.agent === 'claude'
    && (candidate.agentSessionId === `claude:${providerSessionId}` || candidate.id === agentDeckSessionId)
    && [candidate.cwd, candidate.repoId, candidate.worktreePath].filter(Boolean).some((root) => cwd === root || cwd.startsWith(`${root}/`)));
}

export function parseClaudeInteraction(
  value: unknown,
  sessions: readonly Session[],
  newId: () => string = randomUUID,
  now: () => Date = () => new Date(),
): StoredSessionInteraction | null {
  const payload = object(value);
  if (!payload || typeof payload.session_id !== 'string'
    || typeof payload.cwd !== 'string' || typeof payload.tool_name !== 'string') return null;
  const session = findClaudeSession(payload.session_id, payload.agentdeck_session_id, payload.cwd, sessions);
  if (!session) return null;
  const input = object(payload.tool_input) ?? {};
  const providerRequestId = typeof payload.tool_use_id === 'string' ? payload.tool_use_id
    : typeof payload.agentdeck_request_id === 'string' ? payload.agentdeck_request_id : undefined;
  if (!providerRequestId) return null;
  const base = {
    id: newId(), sessionId: session.id, provider: 'claude' as const,
    providerSessionId: payload.session_id, providerRequestId,
    requestedAt: now().toISOString(), status: 'pending' as const,
  };
  if (payload.hook_event_name === 'PreToolUse' && payload.tool_name === 'AskUserQuestion') {
    const questions = Array.isArray(input.questions) ? input.questions.slice(0, 4).map(object).filter((item): item is RecordValue => Boolean(item)) : [];
    if (questions.length === 0) return null;
    const choices: SessionInteractionChoice[] = [];
    const labels: string[] = [];
    let allowsFreeText = false;
    for (const question of questions) {
      if (typeof question.question !== 'string' || !question.question.trim()) return null;
      const questionId = question.question.trim().slice(0, 4000);
      labels.push(questionId);
      const options = Array.isArray(question.options) ? question.options.slice(0, 20).map(object).filter((item): item is RecordValue => Boolean(item)) : [];
      for (const option of options) {
        if (typeof option.label !== 'string' || !option.label.trim()) continue;
        choices.push({
          id: option.label.trim().slice(0, 500), label: option.label.trim().slice(0, 500), questionId,
          ...(question.multiSelect === true ? { multiple: true } : {}),
          ...(typeof option.description === 'string' && option.description.trim() ? { description: option.description.trim().slice(0, 1000) } : {}),
        });
      }
      allowsFreeText = allowsFreeText || question.allowsFreeText !== false;
    }
    return { ...base, kind: 'question', question: labels.join('\n'), choices, allowsFreeText };
  }
  if (payload.hook_event_name === 'PermissionRequest') {
    const summary = safeSummary(input);
    return {
      ...base, kind: 'approval', question: `Claude Code wants approval to use ${payload.tool_name}.`,
      choices: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }],
      ...(summary ? { context: relativizePaths(summary, sessionRoots(session)) } : {}), allowsFreeText: false,
    };
  }
  return null;
}

export function validateInteractionResponse(row: StoredSessionInteraction, value: unknown): SessionInteractionResponse {
  const body = object(value);
  if (!body) throw new Error('A response is required.');
  if (row.kind === 'approval') {
    if (body.decision !== 'approve' && body.decision !== 'deny') throw new Error('Decision must be approve or deny.');
    return { kind: 'approval', decision: body.decision };
  }
  const answers = object(body.answers);
  if (!answers) throw new Error('Answers are required.');
  const normalized: Record<string, string[]> = {};
  for (const [questionId, answer] of Object.entries(answers)) {
    const values = (Array.isArray(answer) ? answer : [answer]).filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim().slice(0, 4000));
    if (values.length === 0) continue;
    const advertised = new Set(row.choices.filter((choice) => choice.questionId === questionId).map((choice) => choice.id));
    if (!row.allowsFreeText && values.some((item) => !advertised.has(item))) throw new Error(`Answer for ${questionId} is not an available choice.`);
    if (row.allowsFreeText && advertised.size > 0 && values.some((item) => !advertised.has(item)) && body.freeText !== true) {
      throw new Error(`Answer for ${questionId} is not an available choice.`);
    }
    const multiple = row.choices.some((choice) => choice.questionId === questionId && choice.multiple);
    if (!multiple && values.length > 1) throw new Error(`Answer for ${questionId} allows only one choice.`);
    normalized[questionId] = values;
  }
  if (Object.keys(normalized).length === 0) throw new Error('At least one answer is required.');
  const questionIds = new Set(row.choices.map((choice) => choice.questionId).filter((value): value is string => Boolean(value)));
  if ([...questionIds].some((questionId) => normalized[questionId] === undefined)) throw new Error('Every question requires an answer.');
  return { kind: 'answer', answers: normalized };
}

export function projectSessionInteractions(
  session: Session,
  rows: readonly StoredSessionInteraction[],
  canApprove: boolean,
  bridgeAvailable = true,
  events: readonly AgentMessage[] = [],
  chatMessages: readonly StoredSessionChatMessage[] = [],
): SessionInteractionsView {
  const pending = [...rows].reverse().find((row) => row.status === 'pending');
  const latestEvent = [...events].reverse().find((event) => event.sessionId === session.id
    || (session.agentSessionId !== undefined && event.agent === session.agentSessionId));
  const responseAwaitingDelivery = [...rows].reverse().find((row) => row.status === 'resolved' && !row.responseDeliveredAt
    && (!latestEvent || !row.resolvedAt || latestEvent.ts <= row.resolvedAt));
  const pendingDelivery = [...chatMessages].reverse().find((message) => message.audience === 'agent'
    && (message.delivery === 'sent' || message.delivery === 'queued')
    && (!latestEvent || message.ts > latestEvent.ts));
  let processingState: SessionInteractionsView['processingState'] = 'idle';
  let processingReason: string | undefined;
  if (pending) processingState = pending.kind === 'approval' ? 'waiting_approval' : 'waiting_answer';
  else if (responseAwaitingDelivery) processingState = 'delivery_pending';
  else if (pendingDelivery) processingState = 'delivery_pending';
  else if (session.status === 'working' || session.status === 'starting') processingState = 'working';
  else if (latestEvent?.event === 'failed') {
    processingState = 'failed';
    processingReason = latestEvent.message ?? 'The provider reported that the Session failed.';
  } else if (latestEvent?.event === 'done' || session.status === 'completed') processingState = 'finished';
  else if (session.status === 'exited' || session.status === 'unknown') {
    processingState = 'disconnected';
    processingReason = 'The Session process is no longer connected; AgentDeck did not receive a structured completion event.';
  } else if (session.status === 'waiting_input') {
    processingState = 'waiting_answer';
    processingReason = 'The provider reported that input is needed, but did not supply a structured request AgentDeck can answer.';
  }
  const providerSupport = session.agent === 'claude' && (bridgeAvailable || rows.length > 0) ? 'supported' : 'unavailable';
  const providerReason = providerSupport === 'unavailable'
    ? (session.agent === 'codex'
      ? 'Codex notify reports completed turns but does not expose interactive Session questions or approvals.'
      : 'AgentDeck Claude hooks are not installed for this Repository; answer in the terminal.')
    : undefined;
  const interactions: SessionInteraction[] = rows.map((row) => {
    const canRespond = row.status === 'pending' && (row.kind === 'question' || canApprove);
    return {
      id: row.id, kind: row.kind, question: relativizePaths(row.question, sessionRoots(session)),
      choices: row.choices.map((choice) => ({
        ...choice, label: relativizePaths(choice.label, sessionRoots(session)),
        ...(choice.questionId ? { questionId: relativizePaths(choice.questionId, sessionRoots(session)) } : {}),
        ...(choice.description ? { description: relativizePaths(choice.description, sessionRoots(session)) } : {}),
      })), ...(row.context ? { context: relativizePaths(row.context, sessionRoots(session)) } : {}),
      allowsFreeText: row.allowsFreeText, requestedAt: row.requestedAt, status: row.status,
      ...(row.response?.kind === 'answer' ? { response: {
        kind: 'answer' as const,
        answers: Object.fromEntries(Object.entries(row.response.answers).map(([question, answers]) => [
          relativizePaths(question, sessionRoots(session)), answers.map((answer) => relativizePaths(answer, sessionRoots(session))),
        ])),
      } } : row.response ? { response: row.response } : {}),
      ...(row.responderPrincipalId ? { responderPrincipalId: row.responderPrincipalId } : {}),
      ...(row.responderDisplayName ? { responderDisplayName: row.responderDisplayName } : {}),
      ...(row.resolvedAt ? { resolvedAt: row.resolvedAt } : {}), canRespond,
      ...(!canRespond && row.status === 'pending' && row.kind === 'approval'
        ? { unavailableReason: 'An authorized local admin must approve or deny this request.' } : {}),
    };
  });
  return {
    providerSupport, ...(providerReason ? { providerReason } : {}), processingState,
    ...(processingReason ? { processingReason } : {}), interactions,
  };
}
