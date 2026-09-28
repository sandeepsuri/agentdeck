// Issue #88: where a connected Gmail account's refresh token lives — the
// owner's login Keychain (decision 0002), one generic-password item per
// account grant. The database never holds it. The token is written through
// `security -i` on stdin so it never appears in a process list.
//
// Exposure note (decision 0003, remaining risk 1): an item `security`
// created is readable by any same-user process that runs /usr/bin/security,
// which includes a confined agent while SecurityServer is open for Claude
// Code's own login. That is accepted on the same terms as Claude's login:
// the agent is offered no process-spawning tool (checked on every turn), and
// its sandbox has no network route to Google even if it read the token.
import { execFile } from 'node:child_process';

export const KEYCHAIN_SERVICE = 'AgentDeck Gmail';

export interface TokenVault {
  save(accountId: string, token: string): Promise<void>;
  read(accountId: string): Promise<string | undefined>;
  remove(accountId: string): Promise<void>;
}

export type SecurityRunner = (args: readonly string[], stdin?: string) => Promise<{ code: number; stdout: string }>;

const runSecurity: SecurityRunner = (args, stdin) => new Promise((resolve) => {
  const child = execFile('/usr/bin/security', [...args], { timeout: 10_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
    resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout) });
  });
  if (stdin !== undefined) child.stdin?.end(stdin);
});

// Account ids are UUIDs and tokens are Google's URL-safe strings; anything
// else could break out of the quoted `security -i` command line.
const SAFE = /^[A-Za-z0-9._\-/~+=]+$/;

export function keychainTokenVault(run: SecurityRunner = runSecurity, service = KEYCHAIN_SERVICE): TokenVault {
  const check = (value: string, what: string) => {
    if (!SAFE.test(value)) throw new Error(`The ${what} has characters the Keychain command cannot carry safely.`);
  };
  return {
    async save(accountId, token) {
      check(accountId, 'account id');
      check(token, 'sign-in token');
      const result = await run(['-i'], `add-generic-password -U -a "${accountId}" -s "${service}" -w "${token}"\n`);
      if (result.code !== 0) throw new Error('The Gmail sign-in could not be saved in the login Keychain.');
    },
    async read(accountId) {
      check(accountId, 'account id');
      const result = await run(['find-generic-password', '-a', accountId, '-s', service, '-w']);
      const token = result.stdout.trim();
      return result.code === 0 && token ? token : undefined;
    },
    async remove(accountId) {
      check(accountId, 'account id');
      await run(['delete-generic-password', '-a', accountId, '-s', service]);
    },
  };
}
