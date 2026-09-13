// ModelNewsService: a cached feed of model launches, updates, deprecations
// and retirements, plus "first used" entries derived from local usage.
//
// Remote sources are the providers' official docs, fetched as the Markdown
// versions both sites serve (append `.md`), which are far steadier to parse
// than rendered HTML. Parsing is deliberately forgiving: a page whose shape
// changes yields fewer items and a recorded error, never a crash, and
// previously cached items stay.
import { createHash } from 'node:crypto';
import type { UsageRepository } from '../store/usage.js';
import type { ModelNewsFeed, ModelNewsItem, ModelNewsKind } from './types.js';

export const NEWS_SOURCES = {
  anthropicReleaseNotes: 'https://platform.claude.com/docs/en/release-notes/overview.md',
  anthropicDeprecations: 'https://platform.claude.com/docs/en/about-claude/model-deprecations.md',
  openaiChangelog: 'https://developers.openai.com/api/docs/changelog.md',
  openaiDeprecations: 'https://developers.openai.com/api/docs/deprecations.md',
} as const;

const PAGE_URL = (source: string) => source.replace(/\.md$/, '');
const MAX_AGE_DAYS = 365;
const TITLE_MAX = 200;
const DETAIL_MAX = 480;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

type Draft = Omit<ModelNewsItem, 'id' | 'fetchedAt'>;

function newsId(provider: string, publishedAt: string, title: string): string {
  return createHash('sha1').update(`${provider}|${publishedAt}|${title}`).digest('hex').slice(0, 20);
}

/** Markdown → one line of plain text. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function firstSentence(text: string): { title: string; rest: string } {
  const match = /^(.{20,}?[.!?])\s+(.*)$/.exec(text);
  return match ? { title: match[1] ?? text, rest: match[2] ?? '' } : { title: text, rest: '' };
}

/** "September 1, 2026" | "Sep 10" (+ year context) | "2026-06-05" → YYYY-MM-DD. */
export function parseDate(text: string, fallbackYear?: number): string | undefined {
  const iso = /(\d{4})[-‑](\d{2})[-‑](\d{2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const named = /([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,\s*(\d{4}))?/.exec(text);
  if (!named) return undefined;
  const month = MONTHS.indexOf((named[1] ?? '').slice(0, 3).toLowerCase());
  const year = named[3] ? Number(named[3]) : fallbackYear;
  if (month === -1 || !year) return undefined;
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(Number(named[2])).padStart(2, '0')}`;
}

function kindOf(text: string): ModelNewsKind {
  if (/\bretired\b|shut\s*down|no longer available/i.test(text)) return 'retirement';
  if (/deprecat|retire/i.test(text)) return 'deprecation';
  if (/launch|introduc|now available|generally available|releas/i.test(text)) return 'launch';
  return 'update';
}

/** Split Markdown into sections at a given heading depth. */
function sections(markdown: string, depth: number): { heading: string; body: string }[] {
  const marker = `${'#'.repeat(depth)} `;
  const result: { heading: string; body: string }[] = [];
  let current: { heading: string; lines: string[] } | undefined;
  for (const line of markdown.split('\n')) {
    if (line.startsWith(marker)) {
      if (current) result.push({ heading: current.heading, body: current.lines.join('\n') });
      current = { heading: line.slice(marker.length).trim(), lines: [] };
    } else if (/^#{1,6} /.test(line) && line.indexOf(' ') < depth) {
      // A shallower heading closes the current section.
      if (current) result.push({ heading: current.heading, body: current.lines.join('\n') });
      current = undefined;
    } else {
      current?.lines.push(line);
    }
  }
  if (current) result.push({ heading: current.heading, body: current.lines.join('\n') });
  return result;
}

/** Data rows of a Markdown table as plain-text cells (header and divider skipped). */
function tableRows(body: string): string[][] {
  const rows = body.split('\n').filter((line) => line.trim().startsWith('|'));
  return rows
    .slice(2)
    .map((line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => plainText(cell)));
}

const MODEL_ID_PATTERN = /^[a-z][a-z0-9.:-]*\d[a-z0-9.:-]*$/;

/** "model retires date → replacement" for each model row; undefined when the section retires no models (e.g. an API feature). */
function deprecationDetail(body: string): string | undefined {
  const lines = tableRows(body)
    .filter((cells) => MODEL_ID_PATTERN.test(cells[1] ?? ''))
    .slice(0, 6)
    .map(([date, model, replacement]) => `${model} retires ${date}${replacement && replacement !== '---' ? ` → ${replacement}` : ''}`);
  return lines.length > 0 ? lines.join('; ') : undefined;
}

const CLAUDE_MODEL_PATTERN = /claude-(fable|opus|sonnet|haiku|mythos)|Claude (Fable|Opus|Sonnet|Haiku|Mythos)\b/;
const NOTABLE_UPDATE_PATTERN = /available|pric|cost|context window|rate limit|default|tokenizer|fast mode/i;

export function parseAnthropicReleaseNotes(markdown: string): Draft[] {
  const items: Draft[] = [];
  for (const section of sections(markdown, 3)) {
    const publishedAt = parseDate(section.heading);
    if (!publishedAt) continue;
    const bullets = section.body.split(/\n(?=\* )/).map((bullet) => bullet.replace(/^\* /, '').trim()).filter(Boolean);
    for (const bullet of bullets) {
      const { title, rest } = firstSentence(plainText(bullet));
      // Release notes cover the whole platform; keep what's about a model itself.
      if (!CLAUDE_MODEL_PATTERN.test(title)) continue;
      const kind = kindOf(title);
      if (kind === 'update' && !NOTABLE_UPDATE_PATTERN.test(title)) continue;
      items.push({
        provider: 'anthropic', kind, title: clip(title, TITLE_MAX),
        ...(rest ? { detail: clip(rest, DETAIL_MAX) } : {}),
        url: PAGE_URL(NEWS_SOURCES.anthropicReleaseNotes), publishedAt,
      });
    }
  }
  return items;
}

export function parseDeprecationPage(markdown: string, provider: 'anthropic' | 'openai', url: string): Draft[] {
  const items: Draft[] = [];
  // Walk "## " groups so OpenAI's "Past deprecations" entries read as retirements.
  for (const group of sections(markdown, 2)) {
    const past = /past/i.test(group.heading);
    for (const section of sections(`${group.body}\n`, 3)) {
      const match = /^(\d{4}-\d{2}-\d{2}):\s*(.+)$/.exec(section.heading);
      if (!match?.[1] || !match[2]) continue;
      const title = plainText(match[2]);
      const detail = deprecationDetail(section.body);
      if (!detail) continue;
      items.push({
        provider,
        kind: past || /were retired|was retired/i.test(section.body) ? 'retirement' : 'deprecation',
        title: clip(title, TITLE_MAX),
        detail: clip(detail, DETAIL_MAX),
        url, publishedAt: match[1],
      });
    }
  }
  return items;
}

export function parseOpenAiChangelog(markdown: string): Draft[] {
  const items: Draft[] = [];
  for (const month of sections(markdown, 2)) {
    const year = Number(/(\d{4})/.exec(month.heading)?.[1]);
    if (!year) continue;
    for (const entry of sections(`${month.body}\n`, 3)) {
      const publishedAt = parseDate(entry.heading, year);
      if (!publishedAt) continue;
      const paragraphs = entry.body.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
      const meta = paragraphs[0] ?? '';
      if (!/Model:/.test(meta)) continue;
      const text = plainText(paragraphs.slice(1).join(' '));
      if (!text) continue;
      const { title, rest } = firstSentence(text);
      const kind = /deprecat/i.test(meta) ? 'deprecation' : kindOf(title);
      items.push({
        provider: 'openai', kind, title: clip(title, TITLE_MAX),
        ...(rest ? { detail: clip(rest, DETAIL_MAX) } : {}),
        url: PAGE_URL(NEWS_SOURCES.openaiChangelog), publishedAt,
      });
    }
  }
  return items;
}

export type FetchText = (url: string) => Promise<string>;

const defaultFetchText: FetchText = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { accept: 'text/markdown, text/plain' } });
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  return response.text();
};

export interface ModelNewsServiceOptions {
  repository: UsageRepository;
  fetchText?: FetchText;
  intervalMs?: number;
  now?: () => Date;
  log?: (message: string, error?: unknown) => void;
}

export class ModelNewsService {
  private readonly repository: UsageRepository;
  private readonly fetchText: FetchText;
  private readonly intervalMs: number;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private lastFetchedAt?: string;
  private lastError?: string;

  constructor(private readonly options: ModelNewsServiceOptions) {
    this.repository = options.repository;
    this.fetchText = options.fetchText ?? defaultFetchText;
    this.intervalMs = options.intervalMs ?? 6 * 60 * 60 * 1000;
  }

  private now(): Date { return this.options.now?.() ?? new Date(); }

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Fetches every source; one failing source doesn't block the others. Never rejects. */
  refresh(): Promise<void> {
    this.running ??= this.fetchAll().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async fetchAll(): Promise<void> {
    const sources: [string, (markdown: string) => Draft[]][] = [
      [NEWS_SOURCES.anthropicReleaseNotes, parseAnthropicReleaseNotes],
      [NEWS_SOURCES.anthropicDeprecations, (md) => parseDeprecationPage(md, 'anthropic', PAGE_URL(NEWS_SOURCES.anthropicDeprecations))],
      [NEWS_SOURCES.openaiChangelog, parseOpenAiChangelog],
      [NEWS_SOURCES.openaiDeprecations, (md) => parseDeprecationPage(md, 'openai', PAGE_URL(NEWS_SOURCES.openaiDeprecations))],
    ];
    const errors: string[] = [];
    const fetchedAt = this.now().toISOString();
    const cutoff = new Date(this.now().getTime() - MAX_AGE_DAYS * 86_400_000).toISOString().slice(0, 10);
    const results = await Promise.allSettled(sources.map(async ([url, parse]) => {
      const drafts = parse(await this.fetchText(url));
      if (drafts.length === 0) throw new Error(`no entries recognized at ${url}`);
      return drafts;
    }));
    const items: ModelNewsItem[] = [];
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        errors.push(message);
        this.options.log?.(`[agentdeck] model news: ${sources[index]?.[0]} failed`, result.reason);
        return;
      }
      for (const draft of result.value) {
        if (draft.publishedAt < cutoff) continue;
        items.push({ ...draft, id: newsId(draft.provider, draft.publishedAt, draft.title), fetchedAt });
      }
    });
    if (items.length > 0) this.repository.upsertNews(items);
    this.lastFetchedAt = fetchedAt;
    this.lastError = errors.length > 0 ? `${errors.length} of ${sources.length} sources unavailable` : undefined;
  }

  /** Adds a "first used" entry for every model seen in local usage that hasn't had one yet. */
  recordFirstUse(): void {
    const fetchedAt = this.now().toISOString();
    const items: ModelNewsItem[] = [];
    for (const { provider, model, firstAt } of this.repository.modelFirstUse()) {
      if (model === 'unknown') continue;
      const id = `first-seen:${provider}:${model}`;
      if (this.repository.hasNews(id)) continue;
      items.push({
        id, provider: 'local', kind: 'first-seen',
        title: `First used ${model}`,
        detail: `${provider === 'claude' ? 'Claude Code' : 'Codex'} first ran on ${model}.`,
        publishedAt: firstAt.slice(0, 10), fetchedAt,
      });
    }
    if (items.length > 0) this.repository.upsertNews(items);
  }

  feed(limit = 60): ModelNewsFeed {
    const usedModels = this.repository.modelFirstUse().map((entry) => entry.model).filter((model) => model !== 'unknown');
    const items = this.repository.listNews(limit).map((item) => {
      if (item.kind !== 'deprecation' && item.kind !== 'retirement') return item;
      const text = `${item.title} ${item.detail ?? ''}`;
      const affects = usedModels.filter((model) => text.includes(model));
      return affects.length > 0 ? { ...item, affectsModels: affects } : item;
    });
    return {
      items,
      ...(this.lastFetchedAt ? { lastFetchedAt: this.lastFetchedAt } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }
}
