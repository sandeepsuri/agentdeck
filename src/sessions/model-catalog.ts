// ModelCatalog (ticket 12): the spec's second seam alongside Summarizer
// (docs/specs/session-persistence-and-remote-access.md, "Summarizer and
// ModelCatalog" under Module design):
//
//   ModelCatalog.list(): Model[]
//
// Kept as its own interface, separate from Summarizer, because the picker
// needs the list without summarizing anything — folding it in would grow
// Summarizer to four methods. It hides the runtime fetch, cache, allowlist
// filter, and per-provider auth detection behind one call.
//
// Two providers today, one interface each side:
//   - ClaudeModelSource: `claude -p` (ticket 11's default). See the class
//     doc comment for why this is a small static list rather than a
//     genuine runtime fetch — that's a documented, investigated decision,
//     not a shortcut.
//   - OpenAiModelSource: a genuine runtime fetch against OpenAI's public
//     models endpoint, allowlist-filtered and cached by ModelCatalog.
//
// Adding a third provider means writing one more ModelSource and listing
// it in server/index.ts — nothing here, in Summarizer, or in the REST
// routes needs to change.

export type ModelProvider = 'claude-cli' | 'openai';
export type BillingKind = 'subscription' | 'api-key';

export interface Model {
  /**
   * Provider-qualified id of the form "<provider>:<model>" — this exact
   * string is what the UI sends back as SummarizeOptions.model, and what
   * RoutingSummarizer (summarizer.ts) parses to route to the right
   * adapter. Never a bare, ambiguous model name.
   */
  id: string;
  displayName: string;
  provider: ModelProvider;
  /** What using this model costs: an existing subscription, or a metered API key. The picker must show this per the spec's rationale. */
  billing: BillingKind;
  /** False when this option cannot currently be used (e.g. OpenAI without a configured key, or a provider fetch that failed). Still listed, never hidden. */
  available: boolean;
  /** Present only when available is false — user-facing instructions for how to fix it. */
  unavailableReason?: string;
}

/** One provider's contribution to the catalog. `list()` should not throw for "not configured" — see OpenAiModelSource — only for a genuine, unexpected fetch failure, which ModelCatalog turns into a single disabled entry rather than failing the whole catalog. */
export interface ModelSource {
  readonly provider: ModelProvider;
  list(): Promise<Model[]>;
}

/**
 * `claude -p` authenticates through the Claude Code CLI's own login/
 * subscription (ticket 11), not an Anthropic API key AgentDeck manages —
 * that is the entire reason it is the zero-config default. AgentDeck
 * therefore has no key to call a models-list HTTP endpoint with for this
 * provider.
 *
 * Investigated before falling back to a static list (per the ticket's
 * explicit instruction not to invent a flag from memory): the installed
 * CLI's own `claude --help` / `claude -p --help` (v2.1.248) documents no
 * `models` subcommand and no models-list flag of any kind. The only
 * model-related surface is `--model <model>`, whose help text names a
 * small set of aliases verbatim: "Provide an alias for the latest model
 * (e.g. 'fable', 'opus', or 'sonnet') or a model's full name (e.g.
 * 'claude-fable-5')."
 *
 * Decision: use exactly those verified aliases as a small, explicitly
 * documented static list, rather than leaving Claude out of the picker or
 * fabricating an ID. These are named aliases that the CLI itself resolves
 * to "whatever it currently means" — there is no frozen snapshot
 * identifier here to silently drift the way the spec's rationale warns
 * about for a hardcoded model *snapshot* ID. OpenAiModelSource below still
 * gets a fully genuine runtime fetch; only this provider uses this
 * fallback, and only because there is nothing to fetch from.
 */
export class ClaudeModelSource implements ModelSource {
  readonly provider: ModelProvider = 'claude-cli';

  async list(): Promise<Model[]> {
    return [
      { id: 'claude-cli:opus', displayName: 'Claude Opus (latest)', provider: this.provider, billing: 'subscription', available: true },
      { id: 'claude-cli:sonnet', displayName: 'Claude Sonnet (latest)', provider: this.provider, billing: 'subscription', available: true },
      { id: 'claude-cli:fable', displayName: 'Claude Fable (latest)', provider: this.provider, billing: 'subscription', available: true },
    ];
  }
}

/** Recommended default, matching the spec's decision ("Summary model | Opus 5 default via `claude -p`"). Only used as a UI/settings display fallback — never hardcoded into the actual summarize call path (see manager.ts: no stored default means no --model flag at all, letting the CLI use its own current default). */
export const DEFAULT_MODEL_ID = 'claude-cli:opus';

/** Store settings key for the persisted default model choice (ticket 12). The API key never goes through this path — only the model id string. */
export const DEFAULT_MODEL_SETTING_KEY = 'defaultSummaryModel';

// Prefix/pattern allowlist for chat/completion-capable OpenAI models worth
// offering for summarization. OpenAI's full /v1/models response also lists
// embedding, moderation, audio (whisper/tts/realtime), and image models —
// none of which can summarize text. Patterns, not an exhaustive ID list, so
// a new dated snapshot of an already-allowed family shows up automatically
// without a code change; this is what "allowlist-filtered" means for the
// runtime-fetched provider.
const OPENAI_ALLOWED_PATTERNS: RegExp[] = [
  /^gpt-5(\b|-)/,
  /^gpt-4\.1(\b|-)/,
  /^gpt-4o(\b|-)/,
  /^o3(\b|-)/,
  /^o4(\b|-)/,
];
const OPENAI_DENY_SUBSTRINGS = ['embedding', 'audio', 'realtime', 'transcribe', 'tts', 'image', 'moderation', 'search', 'instruct'];

function isAllowedOpenAiModel(id: string): boolean {
  return OPENAI_ALLOWED_PATTERNS.some((pattern) => pattern.test(id))
    && !OPENAI_DENY_SUBSTRINGS.some((needle) => id.includes(needle));
}

/**
 * Shared shape for reaching OpenAI's HTTP API — used by both
 * OpenAiModelSource (this file) and OpenAiSummarizer (summarizer.ts), two
 * independent callers of the same provider that were duplicating this
 * triple verbatim.
 */
export interface OpenAiClientOptions {
  /** Resolved at call time (not baked in at construction), so a key configured later through Settings is picked up without a server restart. */
  getApiKey: () => string | undefined;
  /** Injectable for tests — never call the real OpenAI endpoint from an automated test. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export type OpenAiModelSourceOptions = OpenAiClientOptions;

/**
 * Genuine runtime fetch against OpenAI's public Models endpoint
 * (GET /v1/models) — exactly what an API key is for, unlike the Claude
 * provider above. When no key is configured, listing real model IDs is
 * simply not possible (the endpoint requires the key to even ask), so
 * list() returns a single, clearly-labeled disabled placeholder instead of
 * either fabricating IDs or omitting the provider from the picker
 * entirely — this is what the "visible but disabled, with a hint" part of
 * the acceptance criteria means for a provider whose model list itself is
 * gated behind the key.
 */
export class OpenAiModelSource implements ModelSource {
  readonly provider: ModelProvider = 'openai';

  constructor(private opts: OpenAiModelSourceOptions) {}

  async list(): Promise<Model[]> {
    const apiKey = this.opts.getApiKey();
    if (!apiKey) {
      return [{
        id: 'openai:unconfigured',
        displayName: 'OpenAI (configure an API key)',
        provider: this.provider,
        billing: 'api-key',
        available: false,
        unavailableReason: 'Requires an OpenAI API key — add one in Settings to see live OpenAI models.',
      }];
    }
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const base = this.opts.baseUrl ?? 'https://api.openai.com/v1';
    const response = await fetchImpl(`${base}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      throw new Error(`OpenAI models request failed: ${response.status}`);
    }
    const body = await response.json() as { data?: { id: string }[] };
    return (body.data ?? [])
      .map((entry) => entry.id)
      .filter(isAllowedOpenAiModel)
      .sort()
      .map((id) => ({
        id: `openai:${id}`,
        displayName: id,
        provider: this.provider,
        billing: 'api-key' as const,
        available: true,
      }));
  }
}

export interface ModelCatalogOptions {
  /** Cache TTL in ms. Default: 5 minutes — "cached" per the acceptance criteria; no need for persistence across server restarts. */
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 5 * 60_000;

/**
 * `ModelCatalog.list(): Promise<Model[]>` (async, since at least the
 * OpenAI source needs real I/O — the spec sketches a sync signature but
 * this mirrors the same async-for-I/O call it makes for
 * ScrollbackRenderer). Merges every configured ModelSource, caches the
 * merged result for ttlMs, and turns a single source's failure into one
 * disabled entry for that provider rather than failing the whole catalog
 * — a transient OpenAI outage should not blank out the Claude options too.
 */
export class ModelCatalog {
  private cache?: { at: number; models: Model[] };
  private readonly ttlMs: number;

  constructor(private sources: ModelSource[], opts: ModelCatalogOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  }

  async list(): Promise<Model[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < this.ttlMs) return this.cache.models;
    const perSource = await Promise.all(this.sources.map(async (source): Promise<Model[]> => {
      try {
        return await source.list();
      } catch (error) {
        return [{
          id: `${source.provider}:unavailable`,
          displayName: `${source.provider} (unavailable)`,
          provider: source.provider,
          billing: source.provider === 'openai' ? 'api-key' : 'subscription',
          available: false,
          unavailableReason: error instanceof Error ? error.message : String(error),
        }];
      }
    }));
    const models = perSource.flat();
    this.cache = { at: now, models };
    return models;
  }

  /** Drop the cache so the next list() call re-fetches immediately — used right after the OpenAI key changes, so the picker reflects it without waiting out the TTL. */
  invalidate(): void {
    this.cache = undefined;
  }
}

/** Splits a ModelCatalog-issued id ("<provider>:<model>") back into its parts. Used by RoutingSummarizer (summarizer.ts) to pick the right adapter. */
export function parseModelId(id: string): { provider: ModelProvider; modelId: string } {
  const index = id.indexOf(':');
  if (index <= 0) throw new Error(`invalid model id (expected "<provider>:<model>"): ${id}`);
  const provider = id.slice(0, index);
  const modelId = id.slice(index + 1);
  if (provider !== 'claude-cli' && provider !== 'openai') {
    throw new Error(`unknown model provider "${provider}" in model id: ${id}`);
  }
  return { provider, modelId };
}
