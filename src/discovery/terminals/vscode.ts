import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import type { ServerFrame, VsCodeTerminalFrame } from '../../protocol.js';
import type { Session } from '../../types.js';
import type { TerminalAdapter, TerminalTab } from './index.js';

const execFileAsync = promisify(execFile);

interface WindowRegistration {
  ws: WebSocket;
  terminals: Map<string, VsCodeTerminalFrame>;
}

interface PendingAction {
  windowId: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface VsCodeIntegrationStatus {
  connected: boolean;
  windows: number;
  terminals: number;
}

export class VsCodeBridge {
  private windows = new Map<string, WindowRegistration>();
  private pending = new Map<string, PendingAction>();

  register(ws: WebSocket, windowId: string, terminals: VsCodeTerminalFrame[]): void {
    this.windows.set(windowId, { ws, terminals: new Map(terminals.map((terminal) => [terminal.id, terminal])) });
  }

  update(ws: WebSocket, windowId: string, terminals: VsCodeTerminalFrame[]): void {
    const registration = this.windows.get(windowId);
    if (!registration || registration.ws !== ws) return;
    registration.terminals = new Map(terminals.map((terminal) => [terminal.id, terminal]));
  }

  result(ws: WebSocket, requestId: string, ok: boolean, error?: string): void {
    const pending = this.pending.get(requestId);
    if (!pending || this.windows.get(pending.windowId)?.ws !== ws) return;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    if (ok) pending.resolve();
    else pending.reject(new Error(error || 'VS Code terminal action failed.'));
  }

  disconnect(ws: WebSocket): void {
    for (const [windowId, registration] of this.windows) {
      if (registration.ws !== ws) continue;
      this.windows.delete(windowId);
      for (const [requestId, pending] of this.pending) {
        if (pending.windowId !== windowId) continue;
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        pending.reject(new Error('VS Code disconnected before the terminal action completed.'));
      }
    }
  }

  listTerminals(): Array<VsCodeTerminalFrame & { windowId: string }> {
    return [...this.windows].flatMap(([windowId, registration]) =>
      [...registration.terminals.values()].map((terminal) => ({ ...terminal, windowId })));
  }

  status(): VsCodeIntegrationStatus {
    return {
      connected: this.windows.size > 0,
      windows: this.windows.size,
      terminals: this.listTerminals().length,
    };
  }

  action(windowId: string, terminalId: string, action: 'send' | 'focus', text?: string): Promise<void> {
    const registration = this.windows.get(windowId);
    if (!registration || !registration.terminals.has(terminalId)) {
      return Promise.reject(new Error('The mapped VS Code terminal is no longer available.'));
    }
    const requestId = randomUUID();
    const frame: ServerFrame = {
      t: 'vscode_action', requestId, terminalId, action,
      ...(text !== undefined ? { text } : {}),
    };
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('VS Code terminal action timed out.'));
      }, 10_000);
      this.pending.set(requestId, { windowId, resolve, reject, timer });
      try {
        registration.ws.send(JSON.stringify(frame));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}

export type TtyResolver = (pid: number) => Promise<string | undefined>;

async function resolveTty(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'tty=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 5000,
    });
    const tty = stdout.trim().replace('/dev/', '');
    return tty && tty !== '??' && tty !== '?' ? tty : undefined;
  } catch {
    return undefined;
  }
}

export class VsCodeAdapter implements TerminalAdapter {
  readonly app = 'VSCode' as const;
  readonly verified = true;

  constructor(
    private bridge: VsCodeBridge,
    private ttyForPid: TtyResolver = resolveTty,
    private submitDelayMs = 300,
  ) {}

  async listTtys(): Promise<TerminalTab[]> {
    const resolved = await Promise.all(this.bridge.listTerminals().map(async (terminal) => {
      const tty = await this.ttyForPid(terminal.processId);
      return tty ? [{
        tty,
        windowId: terminal.windowId,
        tabId: terminal.id,
        title: terminal.name,
      }] : [];
    }));
    return resolved.flat();
  }

  async focus(ref: NonNullable<Session['terminalRef']>): Promise<void> {
    await this.bridge.action(ref.windowId, ref.tabId, 'focus');
  }

  async sendText(ref: NonNullable<Session['terminalRef']>, text: string): Promise<void> {
    await this.bridge.action(ref.windowId, ref.tabId, 'send', text);
    await new Promise((resolve) => setTimeout(resolve, this.submitDelayMs));
    await this.bridge.action(ref.windowId, ref.tabId, 'send', '');
  }
}
