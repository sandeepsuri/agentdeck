export function formatRunLabel(value: string): string {
  const words = value.replaceAll('-', ' ').replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Mirrors work-engine/engine.ts's TERMINAL_STATUSES — a Run in one of these will never change status again, so it's the only state deletion is offered from. */
const TERMINAL_RUN_STATUSES = new Set([
  'completed', 'completed_unverified', 'failed_verification', 'failed_budget', 'failed', 'cancelled',
]);

export function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}
