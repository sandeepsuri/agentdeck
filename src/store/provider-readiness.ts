// Issue #85: the last provider readiness check (migration 026). Exposed as
// Store.providerReadiness so the "no SQL outside src/store" rule holds for
// src/provider-setup too. Columns are readiness metadata only; see the
// migration for why no identity or credential is stored.
import type { Database } from 'better-sqlite3';
import type { ProviderReadinessState, SetupProvider } from '../provider-setup/readiness.js';

export interface StoredProviderReadiness {
  provider: SetupProvider;
  state: ProviderReadinessState;
  detail: string;
  cliVersion?: string;
  authMethod?: string;
  plan?: string;
  checkedAt: string;
  /** The last time a check found the provider ready; kept across failed checks. */
  lastReadyAt?: string;
}

interface Row {
  provider: string; state: string; detail: string; cli_version: string | null; auth_method: string | null;
  plan: string | null; checked_at: string; last_ready_at: string | null;
}

function fromRow(row: Row): StoredProviderReadiness {
  return {
    provider: row.provider as SetupProvider,
    state: row.state as ProviderReadinessState,
    detail: row.detail,
    ...(row.cli_version ? { cliVersion: row.cli_version } : {}),
    ...(row.auth_method ? { authMethod: row.auth_method } : {}),
    ...(row.plan ? { plan: row.plan } : {}),
    checkedAt: row.checked_at,
    ...(row.last_ready_at ? { lastReadyAt: row.last_ready_at } : {}),
  };
}

export class ProviderReadinessRepository {
  constructor(private readonly db: Database) {}

  get(provider: SetupProvider): StoredProviderReadiness | undefined {
    const row = this.db.prepare('SELECT * FROM provider_readiness WHERE provider = ?').get(provider) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  put(record: StoredProviderReadiness): void {
    this.db.prepare(`INSERT INTO provider_readiness
      (provider, state, detail, cli_version, auth_method, plan, checked_at, last_ready_at)
      VALUES (@provider, @state, @detail, @cliVersion, @authMethod, @plan, @checkedAt, @lastReadyAt)
      ON CONFLICT(provider) DO UPDATE SET state = excluded.state, detail = excluded.detail,
        cli_version = excluded.cli_version, auth_method = excluded.auth_method, plan = excluded.plan,
        checked_at = excluded.checked_at, last_ready_at = excluded.last_ready_at`).run({
      provider: record.provider,
      state: record.state,
      detail: record.detail,
      cliVersion: record.cliVersion ?? null,
      authMethod: record.authMethod ?? null,
      plan: record.plan ?? null,
      checkedAt: record.checkedAt,
      lastReadyAt: record.lastReadyAt ?? null,
    });
  }
}
