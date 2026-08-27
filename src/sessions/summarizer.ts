// Summarizer: turns an ended session's scrollback into a short prose
// summary. Spec's exact seam (docs/specs/session-persistence-and-remote-access.md,
// "Summarizer and ModelCatalog" under Module design):
//
//   Summarizer.summarize(scrollback, { model }): Promise<string>
//
// `claude -p` as a subprocess and a hypothetical OpenAI-over-HTTP adapter
// are two genuinely different providers behind the same seam; this file
// builds only the `claude -p` adapter (ticket 11's "single default model"
// scope — a runtime-fetched model picker and other providers are ticket
// 12, not built here). The interface hides provider selection, key
// resolution, the prompt, and input truncation from callers.
import { execFile } from 'node:child_process';

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
