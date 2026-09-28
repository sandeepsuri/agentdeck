import { describe, expect, it } from 'vitest';
import { keychainTokenVault, type SecurityRunner } from './keychain.js';

function fakeSecurity() {
  const items = new Map<string, string>();
  const calls: { args: readonly string[]; stdin?: string }[] = [];
  const run: SecurityRunner = async (args, stdin) => {
    calls.push({ args, ...(stdin !== undefined ? { stdin } : {}) });
    if (args[0] === '-i') {
      const match = /-a "([^"]+)" -s "([^"]+)" -w "([^"]+)"/.exec(stdin ?? '');
      items.set(`${match![2]}/${match![1]}`, match![3]!);
      return { code: 0, stdout: '' };
    }
    const account = args[args.indexOf('-a') + 1];
    const service = args[args.indexOf('-s') + 1];
    const key = `${service}/${account}`;
    if (args[0] === 'find-generic-password') return items.has(key) ? { code: 0, stdout: `${items.get(key)}\n` } : { code: 44, stdout: '' };
    items.delete(key);
    return { code: 0, stdout: '' };
  };
  return { run, calls };
}

describe('keychainTokenVault', () => {
  it('saves over stdin, never on the command line, and reads and removes by account', async () => {
    const { run, calls } = fakeSecurity();
    const vault = keychainTokenVault(run);
    await vault.save('acct-1', '1//0gRefresh-Token_x');
    expect(calls[0]!.args).toEqual(['-i']);
    expect(calls.flatMap((call) => call.args).join(' ')).not.toContain('1//0gRefresh');
    expect(await vault.read('acct-1')).toBe('1//0gRefresh-Token_x');
    await vault.remove('acct-1');
    expect(await vault.read('acct-1')).toBeUndefined();
  });

  it('refuses a value that could break out of the quoted command', async () => {
    const vault = keychainTokenVault(fakeSecurity().run);
    await expect(vault.save('acct', 'tok" -s other')).rejects.toThrow(/cannot carry/);
    await expect(vault.read('a b')).rejects.toThrow(/cannot carry/);
  });
});
