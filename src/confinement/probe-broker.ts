// The smallest capability broker the confinement probe needs (issue #77):
// one granted operation, served from outside the sandbox over loopback
// HTTP as an MCP server, so a confined CLI offered no built-in tools can
// still reach exactly this effect. The broker — not the sandbox — enforces
// the grant, so a denied request is refused here even though the sandbox
// allows the connection. It is a proof harness, not the product broker.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import path from 'node:path';
import { assertReadablePath, CapabilityEnvelopeViolation } from '../work-engine/envelope.js';

export const PROBE_BROKER_TOOL = 'read_granted_file';

export interface BrokerOperation {
  readonly tool: string;
  readonly name: string;
  readonly allowed: boolean;
}

export interface ProbeBroker {
  readonly port: number;
  readonly url: string;
  readonly token: string;
  operations(): BrokerOperation[];
  close(): Promise<void>;
}

interface JsonRpcRequest {
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

const TOOL_DEFINITION = {
  name: PROBE_BROKER_TOOL,
  description: 'Read one file from the folder the owner granted to this task.',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string', description: 'File name inside the granted folder.' } },
    required: ['name'],
    additionalProperties: false,
  },
};

function readGranted(grantedRoot: string, name: string): string {
  // Resolve symlinks first and read exactly the checked path. The broker runs
  // unconfined, so it must never follow a link out of the grant.
  const target = fs.realpathSync(path.resolve(grantedRoot, name));
  assertReadablePath({ writableWorktree: grantedRoot, readableRoots: [grantedRoot] }, target);
  return fs.readFileSync(target, 'utf8');
}

export async function startProbeBroker(options: { readonly grantedRoot: string }): Promise<ProbeBroker> {
  const grantedRoot = fs.realpathSync(options.grantedRoot);
  const token = randomBytes(24).toString('hex');
  const operations: BrokerOperation[] = [];

  function handle(request: JsonRpcRequest): unknown {
    switch (request.method) {
      case 'initialize':
        return {
          protocolVersion: typeof request.params?.protocolVersion === 'string' ? request.params.protocolVersion : '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'agentdeck-probe-broker', version: '1' },
        };
      case 'tools/list':
        return { tools: [TOOL_DEFINITION] };
      case 'tools/call': {
        const args = (request.params?.arguments ?? {}) as { name?: unknown };
        const name = typeof args.name === 'string' ? args.name : '';
        if (request.params?.name !== PROBE_BROKER_TOOL) {
          return { content: [{ type: 'text', text: 'Unknown tool.' }], isError: true };
        }
        try {
          const text = readGranted(grantedRoot, name);
          operations.push({ tool: PROBE_BROKER_TOOL, name, allowed: true });
          return { content: [{ type: 'text', text }] };
        } catch (error) {
          operations.push({ tool: PROBE_BROKER_TOOL, name, allowed: false });
          const reason = error instanceof CapabilityEnvelopeViolation ? 'outside the granted folder' : 'not readable';
          return { content: [{ type: 'text', text: `Refused: ${reason}.` }], isError: true };
        }
      }
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
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => {
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
      const result = handle(message);
      const reply = result === undefined
        ? { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }
        : { jsonrpc: '2.0', id: message.id, result };
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    operations: () => operations.map((operation) => ({ ...operation })),
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
