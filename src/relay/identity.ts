// Issue #90: the Mac's two relay keys. The X25519 channel key is what phones
// pair with and every session is bound to; the Ed25519 signing key is how
// the Mac proves to the relay that it owns its mailbox. Both live together
// in one login Keychain item (service "AgentDeck Relay"), created on first use.
import { createPrivateKey, createPublicKey, randomBytes, type KeyObject } from 'node:crypto';
import type { TokenVault } from '../personal-tasks/email/keychain.js';
import { exportStaticKey, generateStaticKey, importStaticKey, type StaticKey } from './channel.js';
import { mailboxFor } from './protocol.js';

export const RELAY_KEYCHAIN_SERVICE = 'AgentDeck Relay';
const ITEM = 'identity';
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface RelayIdentity {
  readonly channel: StaticKey;
  readonly signingKey: KeyObject;
  /** Raw Ed25519 public key, base64url: what the relay derives the mailbox from. */
  readonly signingPublic: string;
  readonly mailbox: string;
}

function signingFromRaw(raw: Buffer): { signingKey: KeyObject; signingPublic: string } {
  const signingKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, raw]), format: 'der', type: 'pkcs8' });
  const signingPublic = createPublicKey(signingKey).export({ format: 'der', type: 'spki' }).subarray(12).toString('base64url');
  return { signingKey, signingPublic };
}

export function relayIdentityFrom(channelRaw: string, signingRaw: string): RelayIdentity {
  const signing = signingFromRaw(Buffer.from(signingRaw, 'base64url'));
  return { channel: importStaticKey(channelRaw), ...signing, mailbox: mailboxFor(signing.signingPublic) };
}

/** The Mac's relay keys from the Keychain, made and saved on first use. */
export async function loadRelayIdentity(vault: TokenVault): Promise<RelayIdentity> {
  const stored = await vault.read(ITEM);
  const [channelRaw, signingRaw] = stored?.split('.') ?? [];
  if (channelRaw && signingRaw) return relayIdentityFrom(channelRaw, signingRaw);
  const identity = relayIdentityFrom(exportStaticKey(generateStaticKey()), randomBytes(32).toString('base64url'));
  const signingRawNew = identity.signingKey.export({ format: 'der', type: 'pkcs8' }).subarray(PKCS8_ED25519.length).toString('base64url');
  await vault.save(ITEM, `${exportStaticKey(identity.channel)}.${signingRawNew}`);
  return identity;
}
