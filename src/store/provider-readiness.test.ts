// Issue #85: the last readiness check per provider survives a restart and
// holds readiness metadata only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from './index.js';

let base: string | undefined;
afterEach(() => { if (base) fs.rmSync(base, { recursive: true, force: true }); base = undefined; });

describe('ProviderReadinessRepository', () => {
  it('keeps the latest check per provider across a reopen', () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-provider-readiness-'));
    const file = path.join(base, 'agentdeck.db');
    let store = new Store(file);
    store.providerReadiness.put({
      provider: 'claude', state: 'ready', detail: 'Ready.', cliVersion: '2.1.283', authMethod: 'claude.ai', plan: 'pro',
      checkedAt: '2026-09-27T10:00:00.000Z', lastReadyAt: '2026-09-27T10:00:00.000Z',
    });
    store.providerReadiness.put({ provider: 'claude', state: 'expired', detail: 'Expired.', checkedAt: '2026-09-27T11:00:00.000Z', lastReadyAt: '2026-09-27T10:00:00.000Z' });
    store.close();

    store = new Store(file);
    expect(store.providerReadiness.get('claude')).toEqual(
      { provider: 'claude', state: 'expired', detail: 'Expired.', checkedAt: '2026-09-27T11:00:00.000Z', lastReadyAt: '2026-09-27T10:00:00.000Z' },
    );
    expect(store.providerReadiness.get('codex')).toBeUndefined();
    store.close();
  });
});
