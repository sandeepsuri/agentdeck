// Estimated API-equivalent prices, USD per million tokens. Subscription
// users (Claude Pro/Max, ChatGPT Plus/Pro) aren't billed per token; this
// answers "what would this usage cost at API rates". Standard tier,
// short-context rates.
//
// Sources, checked 2026-09-12:
//   Claude — platform.claude.com/docs/en/about-claude/pricing (via the
//     claude-api skill's model table): cache writes 1.25x input (5-minute)
//     and 2x input (1-hour), cache reads 0.1x input — except Fable 5.1 /
//     Mythos 5.1, whose reads are $0.25. Opus 5 fast mode is $10/$50.
//   OpenAI — developers.openai.com/api/docs/pricing (Standard table).
//
// Users can override or add models via config.json `usagePricing`.

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  /** Replacement input/output rates when a response ran in fast mode. */
  fast?: { input: number; output: number };
}

export type PricingTable = Record<string, ModelPrice>;

function claude(input: number, output: number, extra: Partial<ModelPrice> = {}): ModelPrice {
  return { input, output, cacheRead: input * 0.1, cacheWrite: input * 1.25, cacheWrite1h: input * 2, ...extra };
}

function openai(input: number, cacheRead: number, output: number, cacheWrite = input): ModelPrice {
  return { input, output, cacheRead, cacheWrite };
}

/** Keys match a model id exactly or as a prefix; the longest matching key wins. */
export const DEFAULT_PRICING: PricingTable = {
  'claude-fable-5-1': claude(10, 50, { cacheRead: 0.25 }),
  'claude-mythos-5-1': claude(10, 50, { cacheRead: 0.25 }),
  'claude-fable-5': claude(10, 50),
  'claude-mythos-5': claude(10, 50),
  'claude-opus-5': claude(5, 25, { fast: { input: 10, output: 50 } }),
  'claude-opus-4-8': claude(5, 25),
  'claude-opus-4-7': claude(5, 25),
  'claude-opus-4-6': claude(5, 25),
  'claude-opus-4-5': claude(5, 25),
  'claude-sonnet-5': claude(2, 10),
  'claude-sonnet-4-6': claude(3, 15),
  'claude-sonnet-4-5': claude(3, 15),
  'claude-haiku-4-5': claude(1, 5),
  'gpt-6-astra': openai(10, 1, 50, 12.5),
  'gpt-5.6-sol': openai(4, 0.4, 20, 5),
  'gpt-5.6-terra': openai(2, 0.2, 12, 2.5),
  'gpt-5.6-luna': openai(0.2, 0.02, 1.2, 0.25),
  'gpt-5.5-pro': openai(30, 30, 180),
  'gpt-5.5': openai(5, 0.5, 30),
  'gpt-5.4-pro': openai(30, 30, 180),
  'gpt-5.4-mini': openai(0.75, 0.075, 4.5),
  'gpt-5.4-nano': openai(0.2, 0.02, 1.25),
  'gpt-5.4': openai(2.5, 0.25, 15),
  'gpt-5.3-codex': openai(1.75, 0.175, 14),
  'gpt-5.2': openai(1.75, 0.175, 14),
  'gpt-5.1': openai(1.25, 0.125, 10),
  'gpt-5-mini': openai(0.25, 0.025, 2),
  'gpt-5-nano': openai(0.05, 0.005, 0.4),
  'gpt-5': openai(1.25, 0.125, 10),
};

export function resolvePrice(model: string, table: PricingTable): ModelPrice | undefined {
  if (table[model]) return table[model];
  let best: string | undefined;
  for (const key of Object.keys(table)) {
    // Prefix matches must end on a separator so `gpt-5` never prices `gpt-5.5-foo`.
    if (model.startsWith(key) && /^[-@_]/.test(model.slice(key.length)) && (!best || key.length > best.length)) best = key;
  }
  return best ? table[best] : undefined;
}

export interface PricedTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens: number;
  speed?: string | null;
}

/** Input cost covers uncached input plus cache reads/writes; output cost is output tokens. */
export function costOf(tokens: PricedTokens, price: ModelPrice): { inputCostUsd: number; outputCostUsd: number } {
  const fast = tokens.speed === 'fast' ? price.fast : undefined;
  const inputRate = fast?.input ?? price.input;
  const outputRate = fast?.output ?? price.output;
  const inputCost = tokens.inputTokens * inputRate
    + tokens.cacheReadTokens * price.cacheRead
    + tokens.cacheWriteTokens * price.cacheWrite
    + tokens.cacheWrite1hTokens * (price.cacheWrite1h ?? price.cacheWrite);
  return { inputCostUsd: inputCost / 1_000_000, outputCostUsd: (tokens.outputTokens * outputRate) / 1_000_000 };
}

/** Accepts only well-formed entries from config.json; anything else is ignored rather than breaking startup. */
export function parsePricingOverrides(value: unknown): PricingTable | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const table: PricingTable = {};
  for (const [model, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const rate = (key: string) => typeof entry[key] === 'number' && Number.isFinite(entry[key]) && (entry[key] as number) >= 0 ? entry[key] as number : undefined;
    const input = rate('input');
    const output = rate('output');
    if (input === undefined || output === undefined) continue;
    table[model] = {
      input,
      output,
      cacheRead: rate('cacheRead') ?? input * 0.1,
      cacheWrite: rate('cacheWrite') ?? input * 1.25,
      ...(rate('cacheWrite1h') !== undefined ? { cacheWrite1h: rate('cacheWrite1h') } : {}),
    };
  }
  return Object.keys(table).length > 0 ? table : undefined;
}
