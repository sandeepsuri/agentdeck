import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../store/index.js';
import {
  ModelNewsService, NEWS_SOURCES, parseAnthropicReleaseNotes, parseDate, parseDeprecationPage, parseOpenAiChangelog,
} from './news.js';

// Trimmed from the live Markdown pages (2026-09-12), keeping their structure.
const ANTHROPIC_RELEASE_NOTES = `---
title: Claude Platform release notes
---

### September 3, 2026

* Version 1.30.0 of the \`ant\` CLI adds \`ant apply\`. See [Manage resources](https://example.com).

### September 1, 2026

* We've launched **Claude Fable 5.1** (\`claude-fable-5-1\`), the successor to Claude Fable 5. Both models support a [1M token context window](https://example.com).
* Prompt cache reads on Claude Fable 5.1 and Claude Mythos 5.1 cost $0.25 USD per million tokens: 0.025x the base input price. Cache writes are unchanged.
* On Claude Fable 5.1, \`tool_choice\` types \`any\` and \`tool\` aren't supported. Use strict tool use.
`;

const ANTHROPIC_DEPRECATIONS = `# Model deprecations

## Model status

| API model name | Current state |
| --- | --- |
| claude-opus-5 | Active |

## Deprecation history

### 2026-06-05: Claude Opus 4.1 model

<Note>
  This model was retired August 5, 2026.
</Note>

| Retirement date | Deprecated model           | Recommended replacement |
| --------------- | -------------------------- | ----------------------- |
| August 5, 2026  | \`claude-opus-4-1-20250805\` | \`claude-opus-4-8\`       |
`;

const OPENAI_DEPRECATIONS = `# Deprecations

## Upcoming deprecations

### 2026-09-11: GPT-5.4-Cyber

| Shutdown date | Model / system | Recommended replacement |
| ------------- | -------------- | ----------------------- |
| Oct 1, 2026   | \`gpt-5.4-cyber\` | \`gpt-5.6-cyber\`       |

### 2026-06-03: Reusable prompts

| Shutdown date | Feature | Recommended replacement |
| ------------- | ------- | ----------------------- |
| June 3, 2027  | Reusable prompts | --- |

## Past deprecations

### 2026-05-08: \`gpt-5.2-chat-latest\` snapshot

| Shutdown date | Model / system | Recommended replacement |
| ------------- | -------------- | ----------------------- |
| 2026-08-08    | \`gpt-5.2-chat-latest\` | \`gpt-5.5\` |
`;

const OPENAI_CHANGELOG = `# Changelog

## September, 2026

### Sep 10

Feature

You can now set expiration dates when creating project API keys.

### Sep 3

Feature · Model: gpt-6-astra · API: v1/responses

Released [GPT-6 Astra](https://example.com), our most capable model. Use it for the hardest work.

## August, 2026

### Aug 26

Deprecation · Model: whisper-1

Announced the deprecation of whisper-1. These models will shut down on February 26, 2027.
`;

describe('news parsers', () => {
  it('parses dates in every shape the pages use', () => {
    expect(parseDate('September 1, 2026')).toBe('2026-09-01');
    expect(parseDate('Sep 3', 2026)).toBe('2026-09-03');
    expect(parseDate('2026-06-05: Claude Opus 4.1 model')).toBe('2026-06-05');
    expect(parseDate('Sep 3')).toBeUndefined();
  });

  it('keeps model launches and notable model updates from Anthropic release notes', () => {
    const items = parseAnthropicReleaseNotes(ANTHROPIC_RELEASE_NOTES);
    expect(items.map((item) => [item.publishedAt, item.kind])).toEqual([['2026-09-01', 'launch'], ['2026-09-01', 'update']]);
    expect(items[0]?.title).toBe("We've launched Claude Fable 5.1 (claude-fable-5-1), the successor to Claude Fable 5.");
    expect(items[0]?.detail).toContain('1M token context window');
  });

  it('summarizes model rows on deprecation pages and skips non-model features', () => {
    const anthropic = parseDeprecationPage(ANTHROPIC_DEPRECATIONS, 'anthropic', 'https://a');
    expect(anthropic).toEqual([expect.objectContaining({
      kind: 'retirement', title: 'Claude Opus 4.1 model', publishedAt: '2026-06-05',
      detail: 'claude-opus-4-1-20250805 retires August 5, 2026 → claude-opus-4-8',
    })]);
    const openai = parseDeprecationPage(OPENAI_DEPRECATIONS, 'openai', 'https://o');
    expect(openai.map((item) => [item.title, item.kind])).toEqual([['GPT-5.4-Cyber', 'deprecation'], ['gpt-5.2-chat-latest snapshot', 'retirement']]);
  });

  it('keeps only model entries from the OpenAI changelog', () => {
    const items = parseOpenAiChangelog(OPENAI_CHANGELOG);
    expect(items.map((item) => [item.publishedAt, item.kind, item.title])).toEqual([
      ['2026-09-03', 'launch', 'Released GPT-6 Astra, our most capable model.'],
      ['2026-08-26', 'deprecation', 'Announced the deprecation of whisper-1.'],
    ]);
  });
});

describe('ModelNewsService', () => {
  let store: Store;
  beforeEach(() => { store = new Store(':memory:'); });
  afterEach(() => { store.close(); });

  const pages: Record<string, string> = {
    [NEWS_SOURCES.anthropicReleaseNotes]: ANTHROPIC_RELEASE_NOTES,
    [NEWS_SOURCES.anthropicDeprecations]: ANTHROPIC_DEPRECATIONS,
    [NEWS_SOURCES.openaiChangelog]: OPENAI_CHANGELOG,
    [NEWS_SOURCES.openaiDeprecations]: OPENAI_DEPRECATIONS,
  };
  const now = () => new Date('2026-09-12T00:00:00Z');

  it('keeps cached items and reports partial failure when a source goes away', async () => {
    let failing = false;
    const service = new ModelNewsService({
      repository: store.usage, now,
      fetchText: async (url) => { if (failing && url === NEWS_SOURCES.openaiChangelog) throw new Error('offline'); return pages[url] ?? ''; },
    });
    await service.refresh();
    const before = service.feed().items.length;
    expect(before).toBeGreaterThan(0);
    expect(service.feed().lastError).toBeUndefined();

    failing = true;
    await service.refresh();
    expect(service.feed().items).toHaveLength(before);
    expect(service.feed().lastError).toBe('1 of 4 sources unavailable');
  });

  it('adds first-used entries once and flags deprecations that mention a model you used', async () => {
    store.usage.commitFileScan({ path: '/x', provider: 'claude', size: 1, mtimeMs: 1, offset: 1 }, [{
      provider: 'claude', eventKey: 'm1', sessionId: 's', model: 'claude-opus-4-1-20250805', occurredAt: '2026-05-01T10:00:00Z',
      inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0,
    }]);
    const service = new ModelNewsService({ repository: store.usage, now, fetchText: async (url) => pages[url] ?? '' });
    service.recordFirstUse();
    service.recordFirstUse();
    await service.refresh();
    const items = service.feed().items;
    expect(items.filter((item) => item.kind === 'first-seen')).toEqual([expect.objectContaining({ title: 'First used claude-opus-4-1-20250805', publishedAt: '2026-05-01' })]);
    expect(items.find((item) => item.title === 'Claude Opus 4.1 model')?.affectsModels).toEqual(['claude-opus-4-1-20250805']);
  });
});
