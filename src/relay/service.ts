// Issue #90: the Mac's relay, as the rest of AgentDeck sees it. It loads the
// Mac's relay keys, keeps the one outbound link to the relay the owner chose,
// and exposes what Settings › Owner phones and pairing need. Task data never
// passes through here unsealed: requests are answered by the dispatcher the
// server attaches, inside the Mac.
import type { TokenVault } from '../personal-tasks/email/keychain.js';
import { loadRelayIdentity, type RelayIdentity } from './identity.js';
import { MacRelayLink, type MacRelayLinkOptions } from './mac-link.js';
import type { PushTarget, RelayControl, RelayLinkInfo, RelayStatus } from './protocol.js';

export interface RelayServiceOptions {
  vault: TokenVault;
  /** The relay URL saved in config.json, if any. */
  url?: string;
  /** Persists the owner's choice of relay URL. */
  save: (url: string | undefined) => void;
  lookupPhone: MacRelayLinkOptions['lookupPhone'];
  retryMs?: number;
  log?: (message: string) => void;
}

export class RelayService implements RelayControl {
  private url: string | undefined;
  private identity: RelayIdentity | undefined;
  private active: MacRelayLink | undefined;
  private handle: MacRelayLinkOptions['handle'] | undefined;
  private failure: string | undefined;

  constructor(private readonly options: RelayServiceOptions) {
    this.url = options.url;
  }

  /** The server's dispatcher; set once the app exists, before start(). */
  attach(handle: MacRelayLinkOptions['handle']): void {
    this.handle = handle;
  }

  async start(): Promise<void> {
    this.active?.stop();
    this.active = undefined;
    this.failure = undefined;
    if (!this.url || !this.handle) return;
    try {
      this.identity ??= await loadRelayIdentity(this.options.vault);
    } catch {
      this.failure = 'The relay keys could not be read from or saved to the login Keychain.';
      return;
    }
    const link = new MacRelayLink({
      url: this.url,
      identity: this.identity,
      lookupPhone: this.options.lookupPhone,
      handle: this.handle,
      ...(this.options.retryMs ? { retryMs: this.options.retryMs } : {}),
      onState: (state, detail) => this.options.log?.(`[agentdeck] relay ${state}${detail ? `: ${detail}` : ''}`),
    });
    this.active = link;
    link.start();
  }

  stop(): void {
    this.active?.stop();
    this.active = undefined;
  }

  async setUrl(url: string | undefined): Promise<void> {
    this.options.save(url);
    this.url = url;
    await this.start();
  }

  status(): RelayStatus {
    if (!this.url) return { state: 'off' };
    if (this.failure) return { url: this.url, state: 'refused', detail: this.failure };
    if (!this.active) return { url: this.url, state: 'connecting' };
    return { url: this.url, ...this.active.state(), mailbox: this.active.mailbox };
  }

  link(): RelayLinkInfo | undefined {
    return this.active ? { url: this.active.url, mailbox: this.active.mailbox, macKey: this.active.macKey } : undefined;
  }

  dropDevice(deviceId: string): void {
    this.active?.dropDevice(deviceId);
  }

  push(targets: readonly PushTarget[]): void {
    this.active?.push(targets);
  }
}
