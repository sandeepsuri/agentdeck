// The loopback MCP server every personal-task broker runs on (decision 0003):
// a per-session bearer token, POST-only JSON-RPC, a small body limit, and
// no tool behaviour of its own. Each broker supplies its tools and decides
// every call; this shell only speaks the protocol.
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type net from 'node:net';

export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface McpBrokerOptions {
  readonly serverName: string;
  readonly tools: readonly McpTool[];
  /** The result of one tools/call; a thrown error becomes a JSON-RPC internal error. */
  readonly callTool: (name: unknown, args: Record<string, unknown>) => unknown;
}

export interface McpBroker {
  readonly url: string;
  readonly port: number;
  readonly token: string;
  close(): Promise<void>;
}

interface JsonRpcRequest {
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

export async function startMcpBroker(options: McpBrokerOptions): Promise<McpBroker> {
  const token = randomBytes(24).toString('hex');

  async function handle(request: JsonRpcRequest): Promise<unknown> {
    switch (request.method) {
      case 'initialize':
        return {
          protocolVersion: typeof request.params?.protocolVersion === 'string' ? request.params.protocolVersion : '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: options.serverName, version: '1' },
        };
      case 'tools/list':
        return { tools: options.tools };
      case 'tools/call': {
        const args = request.params?.arguments;
        const safeArgs = args !== null && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
        return await options.callTool(request.params?.name, safeArgs);
      }
      case 'ping':
        return {};
      default:
        return undefined;
    }
  }

  const server = http.createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    let body = '';
    let tooLarge = false;
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > 64 * 1024) {
        tooLarge = true;
        request.destroy();
      }
    });
    request.on('end', () => {
      if (tooLarge) return;
      let message: JsonRpcRequest;
      try {
        message = JSON.parse(body) as JsonRpcRequest;
      } catch {
        response.writeHead(400).end();
        return;
      }
      // Notifications (no id) are acknowledged without a body.
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      void handle(message).then(
        (result) => (result === undefined
          ? { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }
          : { jsonrpc: '2.0', id: message.id, result }),
        () => ({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Internal error' } }),
      ).then((reply) => {
        if (!response.destroyed) response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    token,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
