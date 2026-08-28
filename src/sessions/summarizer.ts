// Summarizer: turns an ended session's scrollback into a short prose
// summary. Spec's exact seam (docs/specs/session-persistence-and-remote-access.md,
// "Summarizer and ModelCatalog" under Module design):
//
//   Summarizer.summarize(scrollback, { model }): Promise<string>
//
// `claude -p` as a subprocess and OpenAI over HTTP are two genuinely
// different providers behind the same seam. Ticket 11 built only the
// `claude -p` adapter; ticket 12 adds OpenAiSummarizer (a real HTTP
// adapter) and RoutingSummarizer, which composes every configured adapter
// behind this same single Summarizer interface so SessionManager and the
// REST route never need to know which provider a chosen model id belongs
// to (spec: "Provider selection sits behind one interface, so adding a
// provider does not touch the summary flow"). The interface hides provider
// selection, key resolution, the prompt, and input truncation from callers.
import { execFile } from 'node:child_process';
import { parseModelId, type ModelProvider, type OpenAiClientOptions } from './model-catalog.js';

export interface SummarizeOptions {
  /**
   * Optional model override. Ticket 11 never resolves this itself — no
   * model identifier is hardcoded here (the spec's rationale: identifiers
   * drift, an unverifiable string in source is worse than a fetch). When
   * omitted, ClaudeCliSummarizer passes no `--model` flag at all and lets
   * the `claude` CLI use its own current default. Ticket 12's ModelCatalog
   * is expected to fill this in from a runtime-fetched, allowlisted list.
   */
  model?: string;
}

export interface Summarizer {
  summarize(scrollback: string, opts?: SummarizeOptions): Promise<string>;
}

// Tail-kept truncation cap, in characters. Mirrors the same drop-oldest
// philosophy already used for raw.log's 5 MB live tail cap
// (transcript.ts): the end of a session — the part someone is deciding
// whether to reopen — is what's worth spending model input on. 40,000
// characters (~10k tokens) is small enough to keep the subprocess call
// fast and comfortably under any OS argv length limit, while still large
// enough to cover a substantial compacted scrollback.
export const MAX_SCROLLBACK_CHARS = 40_000;

/** Exported standalone for testing; also used internally by ClaudeCliSummarizer. */
export function truncateScrollback(scrollback: string, max: number = MAX_SCROLLBACK_CHARS): string {
  if (scrollback.length <= max) return scrollback;
  return `[earlier output truncated]\n…\n${scrollback.slice(-max)}`;
}

const PROMPT_PREAMBLE = [
  'You are summarizing a terminal session run by an autonomous coding agent',
  '(Claude Code or Codex CLI) inside AgentDeck, a local supervision tool.',
  'The text below is the compacted scrollback of that session — everything',
  'the agent printed to its terminal. Write a short, plain-language summary',
  '(a few sentences to a short paragraph) covering: what the agent was',
  'asked to do, what it actually did, and how it ended (finished cleanly,',
  'hit an error, was left mid-task, etc). This summary is read by someone',
  'deciding whether to reopen the session, not by the agent itself.',
  '',
  '--- SCROLLBACK START ---',
].join('\n');
const PROMPT_TRAILER = '--- SCROLLBACK END ---';

export interface ClaudeCliSummarizerOptions {
  /** binary to invoke. Default: 'claude', resolved from PATH like any other CLI. */
  command?: string;
  /** hard wall-clock cap for the subprocess, ms. `claude -p` can be slow. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * `claude -p` subprocess adapter. One-shot, non-interactive: this is not a
 * PTY session (no node-pty), just a single execFile call capturing stdout.
 * Never invoked outside an explicit, user-triggered SessionManager.summarize()
 * call — see manager.ts and the ticket's "never automatic" requirement.
 */
export class ClaudeCliSummarizer implements Summarizer {
  private readonly command: string;
  private readonly timeoutMs: number;

  constructor(opts: ClaudeCliSummarizerOptions = {}) {
    this.command = opts.command ?? 'claude';
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async summarize(scrollback: string, opts: SummarizeOptions = {}): Promise<string> {
    const prompt = `${PROMPT_PREAMBLE}\n${truncateScrollback(scrollback)}\n${PROMPT_TRAILER}`;
    const args = ['-p', prompt];
    if (opts.model) args.push('--model', opts.model);
    const stdout = await this.run(args);
    const summary = stdout.trim();
    if (!summary) throw new Error('claude -p produced no output');
    return summary;
  }

  private run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.command,
        args,
        { timeout: this.timeoutMs, maxBuffer: 10 * 1024 * 1024, encoding: 'utf8' },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`claude -p failed: ${stderr.trim() || error.message}`));
            return;
          }
          resolve(stdout);
        },
      );
      // No stdin content is sent (the whole prompt is passed as an
      // argument); close it immediately so `claude -p` never blocks
      // waiting for input it isn't going to receive.
      child.stdin?.end();
    });
  }
}

export interface OpenAiSummarizerOptions extends OpenAiClientOptions {
  timeoutMs?: number;
}

const OPENAI_DEFAULT_TIMEOUT_MS = 120_000;
// Only used if this adapter is ever invoked with no model at all. In
// practice RoutingSummarizer always supplies one for an "openai:..."
// catalog selection; this is a defensive fallback for direct use, not the
// model a user actually sees or picks (OpenAI is never the stored
// zero-config default — see manager.ts and the spec's decision table).
const OPENAI_FALLBACK_MODEL = 'gpt-4o-mini';

/**
 * OpenAI-over-HTTP adapter. A genuine runtime API call, metered against
 * the configured API key (spec rationale: a ChatGPT subscription does not
 * supply this key — separate products, separate billing). Node 24's
 * global fetch is used directly rather than adding an SDK dependency, same
 * choice already made for ModelCatalog's OpenAiModelSource.
 */
export class OpenAiSummarizer implements Summarizer {
  constructor(private opts: OpenAiSummarizerOptions) {}

  async summarize(scrollback: string, opts: SummarizeOptions = {}): Promise<string> {
    const apiKey = this.opts.getApiKey();
    if (!apiKey) {
      throw new Error('OpenAI summarization requires an API key — configure one in Settings.');
    }
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const base = this.opts.baseUrl ?? 'https://api.openai.com/v1';
    const model = opts.model ?? OPENAI_FALLBACK_MODEL;
    const prompt = `${PROMPT_PREAMBLE}\n${truncateScrollback(scrollback)}\n${PROMPT_TRAILER}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? OPENAI_DEFAULT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new Error(`OpenAI request failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`OpenAI summarization failed (${response.status}): ${detail.slice(0, 500) || response.statusText}`);
    }
    const body = await response.json() as { choices?: { message?: { content?: string } }[] };
    const summary = body.choices?.[0]?.message?.content?.trim();
    if (!summary) throw new Error('OpenAI produced no summary content');
    return summary;
  }
}

export interface RoutingSummarizerOptions {
  /** One adapter per provider this deployment actually supports. A provider with no adapter here throws a clear error when routed to, rather than silently falling back to another one. */
  adapters: Partial<Record<ModelProvider, Summarizer>>;
  /** Provider used when opts.model is entirely omitted (no override, no stored default resolved upstream — see SessionManager.summarize()). Default: 'claude-cli', matching ticket 11's zero-config behavior. */
  defaultProvider?: ModelProvider;
}

/**
 * Composes every configured provider adapter behind the single Summarizer
 * seam, so SessionManager and the REST route stay provider-agnostic (spec:
 * "Provider selection sits behind one interface, so adding a provider does
 * not touch the summary flow"). This is the one Summarizer instance
 * SessionManagerOptions.summarizer is constructed with in production
 * (server/index.ts) — a per-call model id determines routing dynamically,
 * so changing which provider a wrap-up uses never requires restarting the
 * server or swapping the manager's summarizer.
 *
 * `opts.model`, when present, is a ModelCatalog-issued id of the form
 * "<provider>:<model>" (model-catalog.ts) — the prefix selects the
 * adapter, and the remainder is passed on unprefixed, exactly as that
 * adapter itself expects (e.g. ClaudeCliSummarizer still just sees
 * `{ model: 'opus' }`, never the qualified id).
 */
export class RoutingSummarizer implements Summarizer {
  constructor(private opts: RoutingSummarizerOptions) {}

  async summarize(scrollback: string, opts: SummarizeOptions = {}): Promise<string> {
    if (!opts.model) {
      return this.adapterFor(this.opts.defaultProvider ?? 'claude-cli').summarize(scrollback);
    }
    const { provider, modelId } = parseModelId(opts.model);
    return this.adapterFor(provider).summarize(scrollback, { model: modelId });
  }

  private adapterFor(provider: ModelProvider): Summarizer {
    const adapter = this.opts.adapters[provider];
    if (!adapter) throw new Error(`no summarizer configured for provider "${provider}"`);
    return adapter;
  }
}
