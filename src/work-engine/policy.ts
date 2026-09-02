// Ticket 12 AC7: the one policy path — CONTEXT.md's "Policy decision" made
// concrete for the first time. engine.ts is the only caller (its
// enforcePolicy private helper); REST (work-routes.ts), WebSocket (ws.ts),
// and a direct WorkEngine call all resolve the same actor shape and reach
// that one engine method, so there is no separate REST-only or WS-only
// authorization path to drift out of sync with this one.
import type { RunActor } from './types.js';

export type PolicyActionKind = 'submit' | 'guide';

export type PolicyAction =
  | { readonly kind: 'submit'; readonly repositoryId: string; readonly profileId: string | undefined }
  | { readonly kind: 'guide'; readonly repositoryId: string };

export interface PolicyDecision {
  readonly allowed: boolean;
  /** A stable identifier for which rule produced this decision (CONTEXT.md's Policy decision) — never a full sentence, so a caller could key UI copy or telemetry off it if it ever needed to. */
  readonly rule: string;
  readonly reason: string;
}

const ALLOW_ADMIN: PolicyDecision = { allowed: true, rule: 'admin-full-authority', reason: 'The local admin has unrestricted authority.' };

/**
 * Ticket 12 AC1/AC4: `actor.grants` absent means unrestricted admin
 * authority (the local operator, or the legacy shared tailnet token —
 * connection-trust.ts never resolves a `device` for that path, so it never
 * carries `grants` either) — every action is allowed, exactly today's
 * behavior. `grants` present means a named collaborator device: a
 * 'submit' needs both the Repository and the named Profile explicitly
 * granted (an ungranted or missing profileId is refused — AC4's "cannot
 * select an unapproved runtime" starts here, since submit() then never
 * even reaches a Profile whose runtime it could apply); a 'guide' action
 * (prepare/start/cancel/resolveAttention/pause/resume — AC1's "launch and
 * guide") needs only the Run's already-frozen Repository granted, since
 * its Profile was already checked once, at submission.
 */
export function decidePolicy(actor: RunActor, action: PolicyAction): PolicyDecision {
  if (!actor.grants) return ALLOW_ADMIN;

  if (!actor.grants.repositoryIds.includes(action.repositoryId)) {
    return {
      allowed: false,
      rule: 'repository-not-granted',
      reason: `${actor.principal.displayName} has not been granted this Repository.`,
    };
  }

  if (action.kind === 'submit') {
    if (!action.profileId) {
      return {
        allowed: false,
        rule: 'profile-required',
        reason: 'A collaborator must submit against an admin-approved Profile.',
      };
    }
    if (!actor.grants.profileIds.includes(action.profileId)) {
      return {
        allowed: false,
        rule: 'profile-not-granted',
        reason: `${actor.principal.displayName} has not been granted this Profile.`,
      };
    }
  }

  return { allowed: true, rule: 'collaborator-within-grants', reason: 'Granted Repository and Profile.' };
}
