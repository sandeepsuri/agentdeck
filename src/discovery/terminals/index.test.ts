import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../../types.js';
import {
  AutomationDeniedError,
  ITerm2Adapter,
  TerminalAppAdapter,
  TerminalRegistry,
  type TerminalAdapter,
  type TerminalTab,
} from './index.js';

class FakeAdapter implements TerminalAdapter {
  readonly focus = vi.fn(async () => undefined);
  readonly sendText = vi.fn(async () => undefined);

  constructor(
    readonly app: 'Terminal' | 'iTerm2' | 'VSCode',
    readonly verified: boolean,
    private tabs: TerminalTab[] | Error,
  ) {}

  async listTtys(): Promise<TerminalTab[]> {
    if (this.tabs instanceof Error) throw this.tabs;
    return this.tabs;
  }
}

const external: Session = {
  id: 'ext-1-2',
  origin: 'external',
  agent: 'claude',
  cwd: '/tmp',
  pid: 1,
  tty: 'ttys004',
  startedAt: '2026-07-17T00:00:00.000Z',
  lastActivityAt: '2026-07-17T00:00:00.000Z',
  status: 'idle',
  statusSource: 'cpu_heuristic',
};

describe('TerminalRegistry', () => {
  it('joins a tty to its app/ref and dispatches focus to the owning adapter', async () => {
    const terminal = new FakeAdapter('Terminal', true, [{
      tty: 'ttys004',
      windowId: '58250',
      tabId: '1',
      title: 'Agent work',
    }]);
    const iterm = new FakeAdapter('iTerm2', false, []);
    const registry = new TerminalRegistry([terminal, iterm]);

    await registry.refresh();
    expect(registry.lookup('ttys004')).toEqual({
      terminalApp: 'Terminal',
      terminalRef: { windowId: '58250', tabId: '1' },
      title: 'Agent work',
    });
    await registry.focus({
      ...external,
      terminalApp: 'Terminal',
      terminalRef: { windowId: '58250', tabId: '1' },
    });
    expect(terminal.focus).toHaveBeenCalledWith({ windowId: '58250', tabId: '1' });
  });

  it('returns unknown for unmatched ttys and absorbs Automation denial during refresh', async () => {
    const denied = new FakeAdapter('Terminal', true, new AutomationDeniedError('Terminal'));
    const registry = new TerminalRegistry([denied]);
    await expect(registry.refresh()).resolves.toBeUndefined();
    expect(registry.lookup('ttys012')).toBeUndefined();
    expect(registry.automationHint()).toMatch(/Automation/i);
  });

  it('dispatches sendText to the owning adapter and rejects unknown terminals', async () => {
    const terminal = new FakeAdapter('Terminal', true, []);
    const registry = new TerminalRegistry([terminal]);
    await registry.sendText({
      ...external,
      terminalApp: 'Terminal',
      terminalRef: { windowId: '58250', tabId: '1' },
    }, 'hello agent');
    expect(terminal.sendText).toHaveBeenCalledWith({ windowId: '58250', tabId: '1' }, 'hello agent');
    await expect(registry.sendText({ ...external, terminalApp: 'unknown' }, 'x'))
      .rejects.toThrow(/No scriptable terminal/);
  });

  it('generates paste-then-submit AppleScript for both terminal apps', async () => {
    const terminalScripts: string[] = [];
    const terminal = new TerminalAppAdapter(async (script) => { terminalScripts.push(script); return ''; }, 0);
    await terminal.sendText({ windowId: '10', tabId: '2' }, 'say "hi"');
    expect(terminalScripts[0]).toContain('do script "say \\"hi\\"" in tab 2 of (first window whose id is 10)');
    expect(terminalScripts[1]).toContain('do script "" in tab 2');

    const itermScripts: string[] = [];
    const iterm = new ITerm2Adapter(async (script) => { itermScripts.push(script); return ''; }, 0);
    await iterm.sendText({ windowId: '10', tabId: '2', sessionId: 'S-1' }, 'hello');
    expect(itermScripts[0]).toContain('write text "hello" newline NO');
    expect(itermScripts[1]).toContain('write text "" newline YES');
  });

  it('surfaces denial from focus without crashing the registry', async () => {
    const adapter = new FakeAdapter('Terminal', true, []);
    adapter.focus.mockRejectedValueOnce(new AutomationDeniedError('Terminal'));
    const registry = new TerminalRegistry([adapter]);
    await expect(registry.focus({
      ...external,
      terminalApp: 'Terminal',
      terminalRef: { windowId: '1', tabId: '1' },
    })).rejects.toBeInstanceOf(AutomationDeniedError);
  });
});
