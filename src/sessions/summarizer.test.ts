// Never spawns a real `claude` process: node:child_process's execFile is
// mocked at the module boundary, per the ticket's hard requirement that
// automated tests must fake the subprocess boundary entirely.
import { afterEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.fn();
vi.mock('node:child_process', () => ({ execFile: (...args: unknown[]) => execFileMock(...args) }));

const {
  ClaudeCliSummarizer, OpenAiSummarizer, RoutingSummarizer, truncateScrollback, MAX_SCROLLBACK_CHARS,
} = await import('./summarizer.js');

function fakeChildProcess() {
  return { stdin: { end: vi.fn() } };
}

afterEach(() => {
  execFileMock.mockReset();
});

describe('truncateScrollback', () => {
  it('returns short scrollback unchanged', () => {
    expect(truncateScrollback('hello')).toBe('hello');
  });

  it('keeps only the tail once over the cap, and marks that it truncated', () => {
    const long = 'x'.repeat(MAX_SCROLLBACK_CHARS + 500);
    const result = truncateScrollback(long);
    expect(result.length).toBeLessThan(long.length);
    expect(result).toContain('truncated');
    expect(result.endsWith('x'.repeat(100))).toBe(true); // tail preserved
  });
});

describe('ClaudeCliSummarizer', () => {
  it('invokes `claude -p <prompt>` with no --model flag by default, and returns trimmed stdout', async () => {
    execFileMock.mockImplementation((_command, _args, _opts, callback: (error: unknown, stdout: string, stderr: string) => void) => {
      callback(null, '  A short summary.  \n', '');
      return fakeChildProcess();
    });

    const summarizer = new ClaudeCliSummarizer();
    const result = await summarizer.summarize('agent did some things');

    expect(result).toBe('A short summary.');
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [command, args] = execFileMock.mock.calls[0] as [string, string[], object, unknown];
    expect(command).toBe('claude');
    expect(args[0]).toBe('-p');
    expect(args).toHaveLength(2); // no --model flag when opts.model is omitted
    expect(args[1]).toContain('agent did some things');
  });

  it('passes --model only when an explicit override is given', async () => {
    execFileMock.mockImplementation((_command, _args, _opts, callback: (error: unknown, stdout: string, stderr: string) => void) => {
      callback(null, 'summary', '');
      return fakeChildProcess();
    });

    const summarizer = new ClaudeCliSummarizer();
    await summarizer.summarize('scrollback text', { model: 'claude-opus-5' });

    const [, args] = execFileMock.mock.calls[0] as [string, string[], object, unknown];
    expect(args).toEqual(expect.arrayContaining(['--model', 'claude-opus-5']));
  });

  it('truncates the scrollback before including it in the prompt', async () => {
    execFileMock.mockImplementation((_command, _args, _opts, callback: (error: unknown, stdout: string, stderr: string) => void) => {
      callback(null, 'summary', '');
      return fakeChildProcess();
    });

    const long = 'y'.repeat(MAX_SCROLLBACK_CHARS + 1000);
    const summarizer = new ClaudeCliSummarizer();
    await summarizer.summarize(long);

    const [, args] = execFileMock.mock.calls[0] as [string, string[], object, unknown];
    const prompt = args[1] ?? '';
    expect(prompt.length).toBeLessThan(long.length);
  });

  it('rejects with a clear error when the subprocess fails', async () => {
    execFileMock.mockImplementation((_command, _args, _opts, callback: (error: unknown, stdout: string, stderr: string) => void) => {
      callback(new Error('exit code 1'), '', 'claude: command not found');
      return fakeChildProcess();
    });

    const summarizer = new ClaudeCliSummarizer();
    await expect(summarizer.summarize('text')).rejects.toThrow(/claude -p failed/);
  });

  it('rejects when the subprocess produces no output', async () => {
    execFileMock.mockImplementation((_command, _args, _opts, callback: (error: unknown, stdout: string, stderr: string) => void) => {
      callback(null, '   \n', '');
      return fakeChildProcess();
    });

    const summarizer = new ClaudeCliSummarizer();
    await expect(summarizer.summarize('text')).rejects.toThrow(/no output/);
  });
});

// Never makes a real network call: fetchImpl is always injected in tests,
// per the ticket's hard requirement.
describe('OpenAiSummarizer', () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status });
  }

  it('rejects immediately, without calling fetch, when no API key is configured', async () => {
    const fetchImpl = vi.fn();
    const summarizer = new OpenAiSummarizer({ getApiKey: () => undefined, fetchImpl });
    await expect(summarizer.summarize('scrollback')).rejects.toThrow(/API key/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts to the chat completions endpoint with the resolved model and a bearer token', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [{ message: { content: '  A summary.  ' } }] }));
    const summarizer = new OpenAiSummarizer({ getApiKey: () => 'sk-test', fetchImpl });
    const result = await summarizer.summarize('agent did things', { model: 'gpt-4o-mini' });

    expect(result).toBe('A summary.');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-test');
    const payload = JSON.parse(init.body as string) as { model: string; messages: { content: string }[] };
    expect(payload.model).toBe('gpt-4o-mini');
    expect(payload.messages[0]?.content).toContain('agent did things');
  });

  it('truncates the scrollback before including it in the request', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'summary' } }] }));
    const summarizer = new OpenAiSummarizer({ getApiKey: () => 'sk-test', fetchImpl });
    const long = 'z'.repeat(MAX_SCROLLBACK_CHARS + 1000);
    await summarizer.summarize(long, { model: 'gpt-4o-mini' });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const payload = JSON.parse(init.body as string) as { messages: { content: string }[] };
    expect(payload.messages[0]!.content.length).toBeLessThan(long.length);
  });

  it('rejects with a clear error on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: 'invalid api key' } }, 401));
    const summarizer = new OpenAiSummarizer({ getApiKey: () => 'sk-bad', fetchImpl });
    await expect(summarizer.summarize('text', { model: 'gpt-4o-mini' })).rejects.toThrow(/401/);
  });

  it('rejects when the response has no summary content', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [] }));
    const summarizer = new OpenAiSummarizer({ getApiKey: () => 'sk-test', fetchImpl });
    await expect(summarizer.summarize('text', { model: 'gpt-4o-mini' })).rejects.toThrow(/no summary/i);
  });
});

describe('RoutingSummarizer', () => {
  function fakeAdapter(result = 'ok'): Summarizer & { summarize: ReturnType<typeof vi.fn> } {
    return { summarize: vi.fn(async () => result) };
  }
  type Summarizer = { summarize: (scrollback: string, opts?: { model?: string }) => Promise<string> };

  it('routes a provider-qualified model id to the matching adapter, stripping the prefix', async () => {
    const claude = fakeAdapter('claude summary');
    const openai = fakeAdapter('openai summary');
    const router = new RoutingSummarizer({ adapters: { 'claude-cli': claude, openai } });

    const result = await router.summarize('scrollback', { model: 'openai:gpt-4o-mini' });

    expect(result).toBe('openai summary');
    expect(openai.summarize).toHaveBeenCalledWith('scrollback', { model: 'gpt-4o-mini' });
    expect(claude.summarize).not.toHaveBeenCalled();
  });

  it('routes claude-cli ids the same way', async () => {
    const claude = fakeAdapter('claude summary');
    const openai = fakeAdapter('openai summary');
    const router = new RoutingSummarizer({ adapters: { 'claude-cli': claude, openai } });

    await router.summarize('scrollback', { model: 'claude-cli:opus' });

    expect(claude.summarize).toHaveBeenCalledWith('scrollback', { model: 'opus' });
    expect(openai.summarize).not.toHaveBeenCalled();
  });

  it('defaults to claude-cli with no model override when opts.model is omitted', async () => {
    const claude = fakeAdapter('claude summary');
    const openai = fakeAdapter('openai summary');
    const router = new RoutingSummarizer({ adapters: { 'claude-cli': claude, openai } });

    await router.summarize('scrollback');

    expect(claude.summarize).toHaveBeenCalledWith('scrollback');
    expect(openai.summarize).not.toHaveBeenCalled();
  });

  it('throws a clear error when the routed-to provider has no adapter configured', async () => {
    const claude = fakeAdapter();
    const router = new RoutingSummarizer({ adapters: { 'claude-cli': claude } });
    await expect(router.summarize('scrollback', { model: 'openai:gpt-4o-mini' })).rejects.toThrow(/openai/);
  });

  it('propagates an invalid model id error from parseModelId', async () => {
    const claude = fakeAdapter();
    const router = new RoutingSummarizer({ adapters: { 'claude-cli': claude } });
    await expect(router.summarize('scrollback', { model: 'not-qualified' })).rejects.toThrow();
  });
});
