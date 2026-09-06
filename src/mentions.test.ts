import { describe, expect, it } from 'vitest';
import { parseMention } from './mentions.js';

describe('parseMention', () => {
  it('leaves ordinary chat alone', () => {
    expect(parseMention('Can you review the code?')).toEqual({ mentioned: false });
  });

  it('recognizes a leading mention and strips it from the agent payload', () => {
    expect(parseMention('@agent can you review the code?')).toEqual({
      mentioned: true,
      agentPayload: 'can you review the code?',
    });
  });

  it('recognizes a mention followed by punctuation', () => {
    expect(parseMention('@agent, please review')).toEqual({ mentioned: true, agentPayload: 'please review' });
  });

  it('is case-insensitive', () => {
    expect(parseMention('hey @AGENT please look')).toEqual({ mentioned: true, agentPayload: 'hey please look' });
  });

  it('recognizes a mid-sentence mention', () => {
    expect(parseMention('please review this, @agent')).toEqual({ mentioned: true, agentPayload: 'please review this,' });
  });

  it('does not treat "@agents" as a mention', () => {
    expect(parseMention('@agents can you help')).toEqual({ mentioned: false });
  });

  it('does not treat an email-like "foo@agent" as a mention', () => {
    expect(parseMention('reach foo@agent for details')).toEqual({ mentioned: false });
  });

  it('ignores an escaped mention', () => {
    expect(parseMention('\\@agent ignore this one')).toEqual({ mentioned: false });
  });

  it('ignores a mention inside inline code', () => {
    expect(parseMention('the literal token is `@agent` in our docs')).toEqual({ mentioned: false });
  });

  it('ignores a mention inside a fenced code block', () => {
    expect(parseMention('```\n@agent\n```')).toEqual({ mentioned: false });
  });

  it('collapses multiple mentions into a single delivery', () => {
    expect(parseMention('@agent @agent do it twice')).toEqual({ mentioned: true, agentPayload: 'do it twice' });
  });

  it('reports an empty payload when nothing is left to ask', () => {
    expect(parseMention('@agent')).toEqual({ mentioned: true, agentPayload: '' });
  });

  it('reports an empty payload when only punctuation is left', () => {
    expect(parseMention('@agent!')).toEqual({ mentioned: true, agentPayload: '' });
  });
});
