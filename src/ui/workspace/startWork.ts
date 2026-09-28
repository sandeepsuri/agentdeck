// Redesign spec §05: one "Start work" entry point. Quick mode launches an ad
// hoc Session; Structured mode submits a durable Run. These helpers decide
// the runtime for each mode from the shared readiness report.
import type { RuntimeReadinessReport } from '../../sessions/runtime-readiness-contract.js';
import type { AgentType } from '../../types.js';
import type { RateLimitSnapshot } from '../../usage/types.js';
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

/** Below this much plan headroom, a provider is only picked when nothing else is ready. */
const LOW_HEADROOM_PERCENT = 10;

/** Percent of plan left before the tightest unexpired limit window runs out, or undefined with no snapshot. */
export function planHeadroom(snapshot: RateLimitSnapshot | undefined, now: Date): number | undefined {
  if (!snapshot) return undefined;
  const windows = [snapshot.primary, snapshot.secondary].filter((window) => window !== undefined);
  if (windows.length === 0) return undefined;
  // A window whose reset time has passed has refilled since it was observed.
  const used = windows.map((window) => (window.resetsAt && Date.parse(window.resetsAt) <= now.getTime() ? 0 : window.usedPercent));
  return Math.max(0, 100 - Math.max(...used));
}

/**
 * Home's Ask starts a Session without asking which agent: the installed one
 * with the most plan left. Only providers that log their limits (today,
 * Codex) have a known headroom; an unknown one is never assumed exhausted,
 * so the usual Claude-first order holds unless a known limit says otherwise.
 */
export function resolveAskAgent(
  readiness: RuntimeReadinessReport | null,
  rateLimits: readonly RateLimitSnapshot[],
  now = new Date(),
): AgentType {
  const installed = (['claude', 'codex'] as const).filter((runtime) => {
    const entry = readiness?.runtimes.find((item) => item.runtime === runtime);
    return entry === undefined || entry.status !== 'unavailable';
  });
  if (installed.length === 0) return 'claude';
  const headroom = new Map(installed.map((runtime) => [runtime, planHeadroom(rateLimits.find((item) => item.provider === runtime), now)]));
  const low = (runtime: AgentType) => (headroom.get(runtime) ?? 100) < LOW_HEADROOM_PERCENT;
  const ranked = [...installed].sort((a, b) => {
    if (low(a) !== low(b)) return low(a) ? 1 : -1;
    const left = headroom.get(a);
    const right = headroom.get(b);
    return left !== undefined && right !== undefined ? right - left : 0;
  });
  return ranked[0]!;
}
