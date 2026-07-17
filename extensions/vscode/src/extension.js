const crypto = require('node:crypto');
const vscode = require('vscode');
const WebSocket = require('ws');

function serverUrl() {
  const configured = vscode.workspace.getConfiguration('agentdeck')
    .get('serverUrl', 'ws://127.0.0.1:4040/ws');
  const parsed = new URL(configured.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:'));
  const loopback = parsed.hostname === '127.0.0.1'
    || parsed.hostname === 'localhost'
    || parsed.hostname === '[::1]';
  if (!loopback || (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:')
    || parsed.username || parsed.password) {
    throw new Error('AgentDeck serverUrl must be a loopback ws:// or wss:// URL.');
  }
  return parsed.href;
}

function activate(context) {
  const windowId = `${vscode.env.sessionId}:${crypto.randomUUID()}`;
  const terminalIds = new WeakMap();
  let socket;
  let reconnectTimer;
  let publishTimer;
  let stopped = false;
  let reconnectMs = 500;

  const terminalId = (terminal) => {
    let id = terminalIds.get(terminal);
    if (!id) {
      id = crypto.randomUUID();
      terminalIds.set(terminal, id);
    }
    return id;
  };

  const send = (frame) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  };

  const terminals = async () => (await Promise.all(vscode.window.terminals.map(async (terminal) => {
    try {
      const processId = await terminal.processId;
      return Number.isInteger(processId) && processId > 0
        ? { id: terminalId(terminal), name: terminal.name, processId }
        : undefined;
    } catch {
      return undefined;
    }
  }))).filter(Boolean);

  const publish = async (kind = 'vscode_terminals') => {
    send({ t: kind, windowId, terminals: await terminals() });
  };

  const schedulePublish = () => {
    clearTimeout(publishTimer);
    publishTimer = setTimeout(() => void publish(), 100);
  };

  const result = (requestId, ok, error) => send({
    t: 'vscode_result', requestId, ok,
    ...(error ? { error: String(error) } : {}),
  });

  const handleAction = async (frame) => {
    const terminal = vscode.window.terminals.find((candidate) => terminalId(candidate) === frame.terminalId);
    if (!terminal) return result(frame.requestId, false, 'The requested VS Code terminal no longer exists.');
    try {
      if (frame.action === 'focus') terminal.show(false);
      else if (frame.action === 'send') {
        const text = typeof frame.text === 'string' ? frame.text : '';
        terminal.sendText(text, text.length === 0);
      } else {
        throw new Error('Unsupported AgentDeck terminal action.');
      }
      result(frame.requestId, true);
    } catch (error) {
      result(frame.requestId, false, error instanceof Error ? error.message : String(error));
    }
  };

  const connect = () => {
    if (stopped) return;
    clearTimeout(reconnectTimer);
    try {
      socket = new WebSocket(serverUrl(), { maxPayload: 1024 * 1024, perMessageDeflate: false });
    } catch {
      reconnectTimer = setTimeout(connect, reconnectMs);
      reconnectMs = Math.min(reconnectMs * 2, 10_000);
      return;
    }
    socket.on('open', () => {
      reconnectMs = 500;
      void publish('vscode_register');
    });
    socket.on('message', (raw) => {
      try {
        const frame = JSON.parse(String(raw));
        if (frame?.t === 'vscode_action') void handleAction(frame);
      } catch { /* ignore unrelated/malformed frames */ }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      if (stopped) return;
      reconnectTimer = setTimeout(connect, reconnectMs);
      reconnectMs = Math.min(reconnectMs * 2, 10_000);
    });
  };

  context.subscriptions.push(
    vscode.window.onDidOpenTerminal(schedulePublish),
    vscode.window.onDidCloseTerminal(schedulePublish),
    vscode.window.onDidChangeTerminalState(schedulePublish),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('agentdeck.serverUrl')) return;
      socket?.close();
    }),
    new vscode.Disposable(() => {
      stopped = true;
      clearTimeout(reconnectTimer);
      clearTimeout(publishTimer);
      socket?.close();
    }),
  );
  connect();
}

function deactivate() {}

module.exports = { activate, deactivate };
