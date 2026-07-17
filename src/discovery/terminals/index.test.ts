import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../../types.js';
import {
  AutomationDeniedError,
  TerminalRegistry,
  type TerminalAdapter,
  type TerminalTab,
} from './index.js';

class FakeAdapter implements TerminalAdapter {
  readonly focus = vi.fn(async () => undefined);

  constructor(
    readonly app: 'Terminal' | 'iTerm2',
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
