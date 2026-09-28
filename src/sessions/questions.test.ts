import { describe, expect, it } from 'vitest';
import {
  answerKeystrokes, answerMessage, pendingClaudeQuestion, pendingCodexQuestion, type PendingQuestion, validateQuestionAnswers,
} from './questions.js';

const lines = (...records: unknown[]) => records.map((record) => JSON.stringify(record));
const DOWN = '\x1b[B';

const askUserQuestion = {
  type: 'assistant', uuid: 'a1', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'AskUserQuestion', input: { questions: [
    { question: 'Pick a color', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: 'The color red' }, { label: 'Green' }, { label: 'Blue' }] },
    { question: 'Pick toppings', header: 'Toppings', multiSelect: true, options: [{ label: 'Cheese' }, { label: 'Olives' }, { label: 'Ham' }] },
  ] } }] },
};

describe('pendingClaudeQuestion', () => {
  it('finds an AskUserQuestion with no result yet', () => {
    expect(pendingClaudeQuestion(lines({ type: 'user', message: { content: 'Help me pick' } }, askUserQuestion))).toEqual({
      id: 'toolu_1', delivery: 'menu', questions: [
        { question: 'Pick a color', header: 'Color', multiSelect: false,
          options: [{ label: 'Red', description: 'The color red' }, { label: 'Green' }, { label: 'Blue' }] },
        { question: 'Pick toppings', header: 'Toppings', multiSelect: true, options: [{ label: 'Cheese' }, { label: 'Olives' }, { label: 'Ham' }] },
      ],
    });
  });

  it('closes once the tool result arrives, or the user moves on', () => {
    const result = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'answered' }] } };
    expect(pendingClaudeQuestion(lines(askUserQuestion, result))).toBeUndefined();
    expect(pendingClaudeQuestion(lines(askUserQuestion, { type: 'user', message: { content: 'never mind' } }))).toBeUndefined();
    expect(pendingClaudeQuestion(lines(askUserQuestion, { type: 'user', isMeta: true, message: { content: 'meta' } }))?.id).toBe('toolu_1');
  });

  it('leaves a question with no choices to the Terminal', () => {
    const freeText = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_2', name: 'AskUserQuestion',
      input: { questions: [{ question: 'Anything else?', options: [] }] } }] } };
    expect(pendingClaudeQuestion(lines(freeText))).toBeUndefined();
  });
});

describe('pendingCodexQuestion', () => {
  const item = (payload: unknown) => ({ timestamp: '2026-09-28T14:00:00Z', type: 'response_item', payload });
  const planQuestion = item({ type: 'function_call', name: 'request_user_input', call_id: 'call_1', arguments: JSON.stringify({ questions: [
    { id: 'color', header: 'Color', question: 'Pick a color', options: [{ label: 'Red (Recommended)', description: 'Choose red.' }, { label: 'Green' }] },
  ] }) });
  const asyncQuestion = item({ type: 'function_call', name: 'request_user_input_async', call_id: 'call_2',
    arguments: JSON.stringify({ questions: [{ title: 'Pick a size', options: ['Small', 'Large'] }] }) });

  it('reads a Plan-mode menu until its output arrives', () => {
    expect(pendingCodexQuestion(lines(planQuestion))).toMatchObject({ id: 'call_1', delivery: 'menu', questions: [{ question: 'Pick a color', header: 'Color' }] });
    expect(pendingCodexQuestion(lines(planQuestion, item({ type: 'function_call_output', call_id: 'call_1', output: '{}' })))).toBeUndefined();
  });

  it('keeps a queued async question open past its accepted output until the user replies', () => {
    const accepted = item({ type: 'function_call_output', call_id: 'call_2', output: '{"accepted":true}' });
    const agentUpdate = item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Continuing meanwhile.' }] });
    expect(pendingCodexQuestion(lines(asyncQuestion, accepted, agentUpdate))).toEqual({
      id: 'call_2', delivery: 'message', questions: [{ question: 'Pick a size', multiSelect: false, options: [{ label: 'Small' }, { label: 'Large' }] }],
    });
    const harness = item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x' }] });
    expect(pendingCodexQuestion(lines(asyncQuestion, accepted, harness))?.id).toBe('call_2');
    const reply = item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Small' }] });
    expect(pendingCodexQuestion(lines(asyncQuestion, accepted, reply))).toBeUndefined();
  });
});

const claudeQuestion: PendingQuestion = {
  id: 'toolu_1', delivery: 'menu', questions: [
    { question: 'Pick a color', multiSelect: false, options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }] },
    { question: 'Pick toppings', multiSelect: true, options: [{ label: 'Cheese' }, { label: 'Olives' }, { label: 'Ham' }] },
  ],
};

describe('validateQuestionAnswers', () => {
  it('accepts choices and free text that fit each question', () => {
    expect(validateQuestionAnswers(claudeQuestion, [{ selected: [1] }, { selected: [2, 0, 2], other: ' Pepperoni\n' }]))
      .toEqual([{ selected: [1] }, { selected: [0, 2], other: 'Pepperoni' }]);
  });

  it('rejects missing, out-of-range, or too many answers', () => {
    expect(() => validateQuestionAnswers(claudeQuestion, [{ selected: [1] }])).toThrow('Answer every question.');
    expect(() => validateQuestionAnswers(claudeQuestion, [{ selected: [3] }, { selected: [0] }])).toThrow('not one of its choices');
    expect(() => validateQuestionAnswers(claudeQuestion, [{ selected: [0, 1] }, { selected: [0] }])).toThrow('takes one answer');
    expect(() => validateQuestionAnswers(claudeQuestion, [{ selected: [0], other: 'Purple' }, { selected: [0] }])).toThrow('takes one answer');
    expect(() => validateQuestionAnswers(claudeQuestion, [{ selected: [0] }, { selected: [], other: '  ' }])).toThrow('Answer “Pick toppings”.');
  });
});

describe('answerKeystrokes', () => {
  // Each sequence below answered the real menu in a PTY.
  it('drives Claude Code: digits pick or toggle, Submit row ends a multi-choice list, review submits', () => {
    expect(answerKeystrokes('claude', claudeQuestion, [{ selected: [1] }, { selected: [0, 2] }]))
      .toEqual(['2', '1', '3', DOWN, DOWN, DOWN, DOWN, '\r', '1']);
    expect(answerKeystrokes('claude', claudeQuestion, [{ selected: [], other: 'Purple' }, { selected: [0, 2], other: 'Pepperoni' }]))
      .toEqual(['4', 'Purple', '\r', '1', '3', DOWN, DOWN, DOWN, 'Pepperoni', DOWN, '\r', '1']);
  });

  it('skips the review step for a lone single-choice Claude question', () => {
    const single: PendingQuestion = { ...claudeQuestion, questions: [claudeQuestion.questions[0]!] };
    expect(answerKeystrokes('claude', single, [{ selected: [2] }])).toEqual(['3']);
  });

  it('drives Codex with arrows, Enter per question, and notes on None of the above', () => {
    const codex: PendingQuestion = { id: 'call_1', delivery: 'menu', questions: [
      { question: 'Pick a color', multiSelect: false, options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }] },
      { question: 'Pick a size', multiSelect: false, options: [{ label: 'Small' }, { label: 'Large' }] },
    ] };
    expect(answerKeystrokes('codex', codex, [{ selected: [2] }, { selected: [], other: 'Medium please' }]))
      .toEqual([DOWN, DOWN, '\r', DOWN, DOWN, '\t', 'Medium please', '\r']);
    expect(answerKeystrokes('codex', codex, [{ selected: [0] }, { selected: [1] }])).toEqual(['\r', DOWN, '\r']);
  });

  it('answers a queued question with a message instead of keys', () => {
    const queued: PendingQuestion = { id: 'call_2', delivery: 'message', questions: [
      { question: 'Pick a size', multiSelect: false, options: [{ label: 'Small' }, { label: 'Large' }] },
      { question: 'Pick a color', multiSelect: false, options: [{ label: 'Red' }] },
    ] };
    expect(() => answerKeystrokes('codex', queued, [{ selected: [0] }, { selected: [0] }])).toThrow('answered with a message');
    expect(answerMessage(queued, [{ selected: [1] }, { selected: [], other: 'Teal' }])).toBe('Pick a size\n→ Large\n\nPick a color\n→ Teal');
  });
});
