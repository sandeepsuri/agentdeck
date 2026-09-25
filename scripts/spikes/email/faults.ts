// Fault injection around a real or fake adapter's send, so the uncertain-send
// cases can be reproduced on demand against a live provider as well as the
// fake one. Only `sendDraft` is ever wrapped; lookup and reconciliation always
// talk to the provider as-is.
import type { EmailSpikeAdapter } from './types.js';

export type SendFault =
  | 'none'
  /** The provider accepts the send but the response never reaches us. */
  | 'lose-response-after-commit'
  /** The request never reaches the provider. */
  | 'fail-before-commit'
  /** The provider accepts the send and then this process dies before recording it. */
  | 'crash-after-commit';

export class CrashAfterCommit extends Error {
  constructor() {
    super('simulated crash after provider commit');
  }
}

export function withSendFault(adapter: EmailSpikeAdapter, fault: SendFault): EmailSpikeAdapter {
  if (fault === 'none') return adapter;
  let armed = true;
  return new Proxy(adapter, {
    get(target, property, receiver) {
      if (property !== 'sendDraft') {
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (...args: Parameters<EmailSpikeAdapter['sendDraft']>) => {
        if (!armed) return target.sendDraft(...args);
        armed = false; // one fault per wrapped adapter, like one dropped connection
        if (fault === 'fail-before-commit') throw new Error('simulated network failure before provider commit');
        await target.sendDraft(...args);
        if (fault === 'crash-after-commit') throw new CrashAfterCommit();
        throw new Error('simulated lost response after provider commit');
      };
    },
  });
}
