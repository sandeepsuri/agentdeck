// A scripted stand-in for the confined agent (issue #81 tests): it speaks
// MCP to the real filing broker over loopback HTTP, exactly as the confined
// CLI would, so tests exercise the broker's enforcement rather than a mock.
import type { FilingAgentRequest, FilingAgentTurn, FilingProvider, FilingProviderAccess } from '../personal-tasks/confined-provider.js';
import { FILING_BROKER_MCP_TOOLS } from '../personal-tasks/filing-broker.js';

export interface ToolResult {
  text: string;
  isError: boolean;
}

export type BrokerCall = (tool: string, args?: Record<string, unknown>) => Promise<ToolResult>;

let rpcId = 0;

export async function callBroker(
  broker: { url: string; token: string }, tool: string, args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const response = await fetch(broker.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${broker.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: tool, arguments: args } }),
  });
  const body = await response.json() as { result?: { content: { text: string }[]; isError?: boolean } };
  return { text: body.result?.content.map((part) => part.text).join('\n') ?? '', isError: body.result?.isError === true };
}

export const CONFINED_ACCESS: FilingProviderAccess = {
  mode: 'agent-confined', runtime: 'claude', executable: '/nonexistent/claude', cliVersion: '9.9.9 (Test)', credential: 'macos-keychain',
};

export interface ScriptedProviderOptions {
  access?: FilingProviderAccess;
  /** The agent's behaviour: any sequence of broker calls. */
  script: (call: BrokerCall, request: FilingAgentRequest) => Promise<void>;
  turn?: Partial<FilingAgentTurn>;
}

export function scriptedFilingProvider(options: ScriptedProviderOptions): FilingProvider & { turns: number } {
  const provider = {
    turns: 0,
    resolveAccess: async () => options.access ?? CONFINED_ACCESS,
    runTurn: async (request: FilingAgentRequest): Promise<FilingAgentTurn> => {
      provider.turns += 1;
      await options.script((tool, args) => callBroker(request.broker, tool, args), request);
      return { status: 'ok', reason: 'Completed.', toolsOffered: FILING_BROKER_MCP_TOOLS, ...options.turn };
    },
  };
  return provider;
}
