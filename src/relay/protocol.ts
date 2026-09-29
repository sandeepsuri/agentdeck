// Issue #90: what the relay, the Mac's link to it, and the rest of AgentDeck
// share about the relay protocol. Kept apart from server.ts so the Mac never
// depends on the relay's own code, only on the wire it speaks.
import { createHash } from 'node:crypto';

/** Prefix of the challenge a Mac signs to register its mailbox. */
export const REGISTER_LABEL = 'agentdeck-relay/1 register:';

/** WebSocket close codes the relay uses; the Mac and phones tell states apart by them. */
export const RELAY_CLOSE = {
  macOffline: [4404, 'mac-offline'],
  dropped: [4403, 'dropped'],
  replaced: [4409, 'replaced'],
  refused: [4401, 'refused'],
  full: [4429, 'full'],
  idle: [4408, 'idle'],
} as const;

/** An APNs device token: hex, as the phone reports it. */
export const APNS_TOKEN = /^[0-9a-f]{64,200}$/;

export type PushEnvironment = 'sandbox' | 'production';

/** Where the relay may send one content-free push. */
export interface PushTarget {
  token: string;
  environment: PushEnvironment;
}

/** The mailbox a Mac's signing key registers: phones address it by this alone. */
export function mailboxFor(signingKey: string): string {
  return createHash('sha256').update(Buffer.from(signingKey, 'base64url')).digest('base64url').slice(0, 32);
}

/** How a phone reaches one Mac through the relay: from the pairing QR code, or from the Mac. */
export interface RelayLinkInfo {
  url: string;
  mailbox: string;
  /** The Mac's X25519 channel key, base64url. */
  macKey: string;
}

export type RelayLinkState = 'connecting' | 'connected' | 'unreachable' | 'refused' | 'stopped';

export interface RelayStatus {
  url?: string;
  state: RelayLinkState | 'off';
  detail?: string;
  mailbox?: string;
}

/** The Mac's outbound relay link, as Settings › Owner phones and pairing use it. */
export interface RelayControl {
  status(): RelayStatus;
  /** Saves the relay URL (or turns the relay off) and reconnects. */
  setUrl(url: string | undefined): Promise<void>;
  /** What a phone needs to reach this Mac through the relay; undefined while it is off. */
  link(): RelayLinkInfo | undefined;
}
