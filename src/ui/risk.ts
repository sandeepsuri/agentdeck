// Redesign spec §08 (Trust) and §07 (Review): presentation-only risk hints.
// These never gate an action — approval and publishing stay explicit human
// decisions enforced by the Work Engine. They only explain what an agent is
// asking to do, so an approval or review decision is an informed one.

export type RiskLevel = 'low' | 'medium' | 'high';

export interface ApprovalAccess {
  network: boolean;
  files: boolean;
  secrets: boolean;
}

export interface ApprovalClassification {
  risk: RiskLevel;
  category: string;
  access: ApprovalAccess;
}

export interface ParsedApprovalReason {
  agent?: string;
  tool?: string;
  command?: string;
}

/**
 * Reads the approval sentences the runtime adapters produce
 * (work-engine/runtimes/claude.ts describePermissionRequest,
 * codex.ts describeAttentionRequest). Anything else yields no command rather
 * than a guessed one — the reason text itself is still shown verbatim.
 */
export function parseApprovalReason(reason: string): ParsedApprovalReason {
  const claude = /^(Claude) is requesting approval to use (\S+?)(?::\s*(.+)| before it can continue\.)$/s.exec(reason.trim());
  if (claude) return { agent: claude[1], tool: claude[2], ...(claude[3] ? { command: claude[3].trim() } : {}) };
  const codex = /^(Codex) is requesting approval to run:\s*(.+)$/s.exec(reason.trim());
  if (codex) return { agent: codex[1], command: codex[2]!.trim() };
  return {};
}

const SECRETS = /(\.env\b|secret|credential|password|token|\.ssh|\.aws|keychain|id_rsa|\.npmrc|\.netrc)/i;
const DESTRUCTIVE = /(\brm\s+-[a-z]*[rf]|\bsudo\b|\bchmod\b|\bchown\b|git\s+push|git\s+reset\s+--hard|git\s+clean|\bnpm\s+publish\b|\bdd\s+if=|\bmkfs\b|drop\s+(table|database)|\bkill\s+-9)/i;
const NETWORK = /(\bcurl\b|\bwget\b|https?:\/\/|\b(npm|pnpm|yarn|bun)\s+(install|add|i)\b|\bpip3?\s+install\b|\bbrew\s+install\b|\bgit\s+(clone|fetch|pull)\b|\bssh\b|\bscp\b)/i;
const TESTS = /(\btest\b|\bvitest\b|\bjest\b|\bplaywright\b|\bpytest\b|typecheck|\btsc\b|\blint\b|\bbuild\b)/i;
const NETWORK_TOOLS = new Set(['WebFetch', 'WebSearch']);
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read']);

export function classifyApproval({ tool, command }: { tool?: string; command?: string }): ApprovalClassification {
  if (!command) {
    if (tool && NETWORK_TOOLS.has(tool)) return { risk: 'medium', category: 'Network access', access: { network: true, files: false, secrets: false } };
    if (tool && FILE_TOOLS.has(tool)) return { risk: 'low', category: 'Edit files', access: { network: false, files: true, secrets: false } };
    return { risk: 'medium', category: 'Agent action', access: { network: false, files: true, secrets: false } };
  }
  const access: ApprovalAccess = { network: NETWORK.test(command), files: true, secrets: SECRETS.test(command) };
  if (DESTRUCTIVE.test(command)) return { risk: 'high', category: 'Destructive or publishing command', access };
  if (access.secrets) return { risk: 'high', category: 'Reads credentials', access };
  if (access.network) return { risk: 'medium', category: 'Network access', access };
  if (TESTS.test(command)) return { risk: 'low', category: 'Run tests', access };
  return { risk: 'medium', category: 'Run command', access };
}

export function estimateChangeRisk({ files, additions, deletions, verification }: {
  files: number;
  additions: number;
  deletions: number;
  verification: 'passed' | 'failed' | 'none';
}): RiskLevel {
  const lines = additions + deletions;
  if (verification === 'failed' || files > 15 || lines > 800) return 'high';
  if (verification === 'none' || files > 3 || lines > 150) return 'medium';
  return 'low';
}

export const RISK_LABELS: Record<RiskLevel, string> = { low: 'Low', medium: 'Medium', high: 'High' };
