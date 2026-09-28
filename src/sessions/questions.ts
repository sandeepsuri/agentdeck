// Agent questions: the multiple-choice prompts an agent raises mid-session —
// Claude Code's AskUserQuestion, Codex's request_user_input (Plan mode, a
// blocking menu) and request_user_input_async (Default mode, a queued
// question the agent keeps working past) — read from the same transcript as
// the Conversation view, so they can be answered there instead of in the
// Terminal. Answering a menu means driving it with keystrokes; the keys
// below were worked out against Claude Code 2.1 and Codex 0.157 in a real
// PTY. An async Codex question is answered with an ordinary reply message.
import type { AgentType } from '../types.js';

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface AgentQuestionItem {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

export interface PendingQuestion {
  /** The provider's tool call id; an answer names it so a stale card can't answer a newer question. */
  id: string;
  /** 'menu': the TUI holds a menu open until answered. 'message': the agent reads the user's next message. */
  delivery: 'menu' | 'message';
  questions: AgentQuestionItem[];
}

/** One answer per question: option indexes picked, and/or free text for the menu's "other" row. */
export interface QuestionAnswer {
  selected: number[];
  other?: string;
}

type Json = Record<string, unknown>;
const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 20;
const DOWN = '\x1b[B';

const obj = (value: unknown): Json | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

function parse(line: string): Json | undefined {
  if (!line.trim()) return undefined;
  try { return obj(JSON.parse(line)); } catch { return undefined; }
}

/** Text injected by the harness rather than typed by the user (see conversation.ts). */
function isHarnessText(text: string): boolean {
  return /^<[a-z_-]+>/i.test(text.trimStart());
}

/**
 * Every question must offer choices: a free-text-only question can't be
 * mapped onto the menu rows, so the whole prompt is left to the Terminal.
 */
function questionItems(input: unknown): AgentQuestionItem[] {
  const questions = obj(input)?.questions;
  if (!Array.isArray(questions) || questions.length === 0 || questions.length > MAX_QUESTIONS) return [];
  const items = questions.map(obj).map((item): AgentQuestionItem | undefined => {
    const question = str(item?.question) ?? str(item?.title);
    const rawOptions = Array.isArray(item?.options) ? item.options : [];
    if (!item || !question || rawOptions.length > MAX_OPTIONS) return undefined;
    const options = rawOptions.map((option): QuestionOption | undefined => {
      if (typeof option === 'string') return str(option) ? { label: option.trim() } : undefined;
      const label = str(obj(option)?.label);
      const description = str(obj(option)?.description);
      return label ? { label, ...(description ? { description } : {}) } : undefined;
    });
    if (options.length === 0 || options.some((option) => !option)) return undefined;
    const header = str(item.header);
    return { question, ...(header ? { header } : {}), multiSelect: item.multiSelect === true, options: options as QuestionOption[] };
  });
  return items.every(Boolean) ? items as AgentQuestionItem[] : [];
}

export function pendingClaudeQuestion(lines: readonly string[]): PendingQuestion | undefined {
  let pending: PendingQuestion | undefined;
  for (const line of lines) {
    const record = parse(line);
    if (!record || record.isSidechain === true || record.isMeta === true) continue;
    const content = obj(record.message)?.content;
    const parts = Array.isArray(content) ? content.map(obj) : [];
    if (record.type === 'assistant') {
      for (const part of parts) {
        if (part?.type === 'tool_use' && part.name === 'AskUserQuestion' && str(part.id)) {
          const questions = questionItems(part.input);
          pending = questions.length ? { id: String(part.id), delivery: 'menu', questions } : undefined;
        } else if (part?.type === 'text' && str(part.text)) {
          pending = undefined;
        }
      }
    } else if (record.type === 'user') {
      // Its result, or the user typing something else, closes the question.
      if (typeof content === 'string' || parts.some((part) => part?.type === 'text' || (pending && part?.tool_use_id === pending.id))) {
        pending = undefined;
      }
    }
  }
  return pending;
}

export function pendingCodexQuestion(lines: readonly string[]): PendingQuestion | undefined {
  let pending: PendingQuestion | undefined;
  for (const line of lines) {
    const record = parse(line);
    const payload = obj(record?.payload);
    if (record?.type !== 'response_item' || !payload) continue;
    const name = payload.name;
    if (payload.type === 'function_call' && (name === 'request_user_input' || name === 'request_user_input_async') && str(payload.call_id)) {
      let input: unknown;
      try { input = typeof payload.arguments === 'string' ? JSON.parse(payload.arguments) : payload.arguments; } catch { input = undefined; }
      // Codex asks single-choice questions only.
      const questions = questionItems(input).map((item) => ({ ...item, multiSelect: false }));
      pending = questions.length
        ? { id: String(payload.call_id), delivery: name === 'request_user_input' ? 'menu' : 'message', questions }
        : undefined;
    } else if (payload.type === 'function_call_output' && pending?.delivery === 'menu' && payload.call_id === pending.id) {
      pending = undefined;
    } else if (payload.type === 'message' && payload.role === 'user') {
      const content = Array.isArray(payload.content) ? payload.content.map(obj) : [];
      const typed = content.some((part) => typeof part?.text === 'string' && part.text.trim() && !isHarnessText(part.text));
      const reply = content.some((part) => typeof part?.text === 'string' && part.text.startsWith('<send_user_message_question_reply>'));
      if (typed || reply) pending = undefined;
    } else if (payload.type === 'message' && payload.role === 'assistant' && pending?.delivery === 'menu') {
      pending = undefined;
    }
  }
  return pending;
}

export function pendingQuestion(agent: AgentType, lines: readonly string[]): PendingQuestion | undefined {
  return agent === 'claude' ? pendingClaudeQuestion(lines) : pendingCodexQuestion(lines);
}

/** Rejects an answer that doesn't fit the question, so no guessed keystrokes reach the terminal. */
export function validateQuestionAnswers(question: PendingQuestion, value: unknown): QuestionAnswer[] {
  if (!Array.isArray(value) || value.length !== question.questions.length) throw new Error('Answer every question.');
  return question.questions.map((item, index) => {
    const answer = obj(value[index]);
    const selected = Array.isArray(answer?.selected) ? answer.selected : [];
    if (!selected.every((choice) => Number.isInteger(choice) && choice >= 0 && choice < item.options.length)) {
      throw new Error(`Answer for “${item.question}” is not one of its choices.`);
    }
    const unique = [...new Set(selected as number[])].sort((left, right) => left - right);
    const other = typeof answer?.other === 'string' ? answer.other.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 2000) : '';
    if (!item.multiSelect && unique.length + (other ? 1 : 0) > 1) throw new Error(`“${item.question}” takes one answer.`);
    if (unique.length === 0 && !other) throw new Error(`Answer “${item.question}”.`);
    return { selected: unique, ...(other ? { other } : {}) };
  });
}

/** The labels an answer amounts to, free text last — what the agent is told was chosen. */
export function answerLabels(item: AgentQuestionItem, answer: QuestionAnswer): string[] {
  return [...answer.selected.map((index) => item.options[index]!.label), ...(answer.other ? [answer.other] : [])];
}

/** A reply the agent reads as the answer to a queued (async) question. */
export function answerMessage(question: PendingQuestion, answers: readonly QuestionAnswer[]): string {
  return question.questions.map((item, index) => `${item.question}\n→ ${answerLabels(item, answers[index]!).join(', ')}`).join('\n\n');
}

/**
 * Keys that answer an open menu, one PTY write each — the TUIs drop keys
 * that arrive in a single burst, so the caller paces them. Claude Code:
 * a digit picks a single-choice row and moves on; in a multi-choice list a
 * digit toggles a row, typing on the "Type something" row fills and ticks
 * it, and Enter on the Submit row below it moves on; with more than one
 * question, or any multi-choice one, a review screen ends it where "1"
 * submits. Codex: rows are reached with ↓ (its digits are unreliable),
 * Enter answers and moves on, and "None of the above" takes notes via Tab.
 */
export function answerKeystrokes(agent: AgentType, question: PendingQuestion, answers: readonly QuestionAnswer[]): string[] {
  if (question.delivery !== 'menu') throw new Error('This question is answered with a message, not menu keys.');
  const keys: string[] = [];
  question.questions.forEach((item, index) => {
    const answer = answers[index]!;
    const rows = item.options.length;
    if (agent === 'codex') {
      const row = answer.other ? rows : answer.selected[0]!;
      keys.push(...Array<string>(row).fill(DOWN));
      if (answer.other) keys.push('\t', answer.other);
      keys.push('\r');
    } else if (rows > 8) {
      throw new Error('This question has too many choices to answer from here; answer it in the Terminal.');
    } else if (!item.multiSelect) {
      if (answer.other) keys.push(String(rows + 1), answer.other, '\r');
      else keys.push(String(answer.selected[0]! + 1));
    } else {
      keys.push(...answer.selected.map((row) => String(row + 1)));
      keys.push(...Array<string>(rows).fill(DOWN));
      if (answer.other) keys.push(answer.other);
      keys.push(DOWN, '\r');
    }
  });
  if (agent === 'claude' && (question.questions.length > 1 || question.questions.some((item) => item.multiSelect))) keys.push('1');
  return keys;
}
