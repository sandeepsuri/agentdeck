import type { Session } from '../../types.js';

export interface TerminalTab {
  tty: string;
  windowId: string;
  tabId: string;
  sessionId?: string;
  title?: string;
}

export interface TerminalAdapter {
  readonly app: 'Terminal' | 'iTerm2';
  readonly verified: boolean;
  listTtys(): Promise<TerminalTab[]>;
  focus(ref: NonNullable<Session['terminalRef']>): Promise<void>;
}

export class AutomationDeniedError extends Error {
  constructor(readonly app: 'Terminal' | 'iTerm2') {
    super(`Automation access to ${app} was denied. Allow AgentDeck in System Settings → Privacy & Security → Automation.`);
    this.name = 'AutomationDeniedError';
  }
}

export interface TerminalMatch {
  terminalApp: 'Terminal' | 'iTerm2';
  terminalRef: NonNullable<Session['terminalRef']>;
  title?: string;
}

export class TerminalRegistry {
  private byTty = new Map<string, TerminalMatch>();
  private deniedApps = new Set<'Terminal' | 'iTerm2'>();
  private logged = new Set<string>();

  constructor(private adapters: TerminalAdapter[]) {}

  async refresh(): Promise<void> {
    const next = new Map<string, TerminalMatch>();
    await Promise.all(this.adapters.map(async (adapter) => {
      try {
        for (const tab of await adapter.listTtys()) {
          const terminalRef: NonNullable<Session['terminalRef']> = {
            windowId: tab.windowId,
            tabId: tab.tabId,
          };
          if (tab.sessionId) terminalRef.sessionId = tab.sessionId;
          const match: TerminalMatch = { terminalApp: adapter.app, terminalRef };
          if (tab.title) match.title = tab.title;
          next.set(tab.tty, match);
        }
      } catch (error) {
        if (error instanceof AutomationDeniedError) this.deniedApps.add(adapter.app);
        const key = `${adapter.app}:${error instanceof Error ? error.message : String(error)}`;
        if (!this.logged.has(key)) {
          this.logged.add(key);
          console.warn(`[agentdeck] ${key}`);
        }
      }
    }));
    this.byTty = next;
  }

  lookup(tty: string): TerminalMatch | undefined {
    return this.byTty.get(tty);
  }

  automationHint(): string | undefined {
    if (this.deniedApps.size === 0) return undefined;
    return `Automation access denied for ${[...this.deniedApps].join(', ')}. Allow AgentDeck in System Settings → Privacy & Security → Automation.`;
  }

  async focus(session: Session): Promise<void> {
    if (!session.terminalRef || !session.terminalApp || session.terminalApp === 'unknown') {
      throw new Error('No Terminal.app or iTerm2 tab is mapped to this tty.');
    }
    const adapter = this.adapters.find((candidate) => candidate.app === session.terminalApp);
    if (!adapter) throw new Error(`No adapter for ${session.terminalApp}.`);
    await adapter.focus(session.terminalRef);
  }
}

export { ITerm2Adapter } from './iterm2.js';
export { TerminalAppAdapter } from './terminal-app.js';
