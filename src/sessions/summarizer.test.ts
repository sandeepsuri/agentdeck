// Never spawns a real `claude` process: node:child_process's execFile is
// mocked at the module boundary, per the ticket's hard requirement that
// automated tests must fake the subprocess boundary entirely.
import { afterEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.fn();
vi.mock('node:child_process', () => ({ execFile: (...args: unknown[]) => execFileMock(...args) }));

const { ClaudeCliSummarizer, truncateScrollback, MAX_SCROLLBACK_CHARS } = await import('./summarizer.js');

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
