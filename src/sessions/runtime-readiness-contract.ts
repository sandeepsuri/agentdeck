import type { AgentType } from '../types.js';

export type RuntimeReadinessStatus = 'managed' | 'compatibility-only' | 'unavailable';

export type ManagedRuntimeCapability =
  | 'structured-events'
  | 'continuation'
  | 'approvals'
  | 'usage-reporting'
  | 'execution-restrictions';

export const MANAGED_RUNTIME_CAPABILITIES: readonly ManagedRuntimeCapability[] = [
  'structured-events',
  'continuation',
  'approvals',
  'usage-reporting',
  'execution-restrictions',
];

export const RUNTIME_CAPABILITY_LABELS: Readonly<Record<ManagedRuntimeCapability, string>> = {
  'structured-events': 'Structured events',
  continuation: 'Continuation',
  approvals: 'Approvals',
  'usage-reporting': 'Usage reporting',
  'execution-restrictions': 'Execution restrictions',
};

export interface RuntimeCapabilityReadiness {
  capability: ManagedRuntimeCapability;
  supported: boolean;
  reason?: string;
}

export interface RuntimeReadiness {
  runtime: AgentType;
  displayName: string;
  status: RuntimeReadinessStatus;
  version?: string;
  reason: string;
  capabilities: RuntimeCapabilityReadiness[];
}

export interface RuntimeReadinessReport {
  checkedAt: string;
  runtimes: RuntimeReadiness[];
}
