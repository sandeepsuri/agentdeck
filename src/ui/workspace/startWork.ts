// Redesign spec §05: one "Start work" entry point. Quick mode launches an ad
// hoc Session; Structured mode submits a durable Run. These helpers decide
// the runtime for each mode from the shared readiness report.
import type { RuntimeReadinessReport } from '../../sessions/runtime-readiness-contract.js';
import type { AgentType } from '../../types.js';
import { runtimeSelectableForManagedRun } from '../components/workSubmission.js';

export type AgentChoice = 'auto' | AgentType;
export type StartWorkMode = 'quick' | 'structured';

export function resolveQuickAgent(choice: AgentChoice, readiness: RuntimeReadinessReport | null): AgentType {
  if (choice !== 'auto') return choice;
  const installed = (['claude', 'codex'] as const).find((runtime) => {
    const entry = readiness?.runtimes.find((item) => item.runtime === runtime);
    return entry === undefined || entry.status !== 'unavailable';
  });
  return installed ?? 'claude';
}

export function resolveStructuredRuntimes(choice: AgentChoice, readiness: RuntimeReadinessReport | null): AgentType[] {
  const candidates: AgentType[] = choice === 'auto' ? ['codex', 'claude'] : [choice];
  return candidates.filter((runtime) => runtimeSelectableForManagedRun(readiness, runtime));
}

export function quickSessionName(task: string): string | undefined {
  const firstLine = task.trim().split('\n')[0]?.replace(/\s+/g, ' ').trim();
  if (!firstLine) return undefined;
  return firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine;
}
