// Runs the real Seatbelt shell probes (issue #77) against a stand-in CLI
// install, so no provider, network, keychain item or personal file is
// involved. Skipped where sandbox-exec cannot apply a profile (non-macOS,
// or when the test runner is itself already sandboxed).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SANDBOX_EXEC } from './confined-launch.js';
import { runConfinementProbe } from './probe.js';

const canApplySeatbelt = process.platform === 'darwin'
  && spawnSync(SANDBOX_EXEC, ['-p', '(version 1)(allow default)', '/usr/bin/true']).status === 0;

const install = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-fake-cli-')));
const executable = path.join(install, 'pkg', 'bin', 'claude');
fs.mkdirSync(path.dirname(executable), { recursive: true });
fs.writeFileSync(executable, '\x7fELF stand-in', { mode: 0o755 });

afterAll(() => fs.rmSync(install, { recursive: true, force: true }));

describe.skipIf(!canApplySeatbelt)('Seatbelt confinement probes', () => {
  it('denies every ungranted file, symlink, shell, network, keychain and environment effect', async () => {
    const report = await runConfinementProbe({
      runtime: 'claude', executable, credential: 'none', live: false, hostEnv: { ...process.env, GITHUB_TOKEN: 'host-token' },
    });
    const failures = report.checks.filter((check) => check.outcome !== 'pass');
    expect(failures).toEqual([]);
    expect(report.checks.map((check) => check.id)).toEqual(expect.arrayContaining([
      'ungranted-read', 'symlink-read-escape', 'symlink-write-escape', 'child-process-inherits', 'inherited-environment',
      'loopback-network', 'direct-network', 'proxy-ungranted-domain', 'keychain', 'provider-credential',
      'broker-granted-operation', 'broker-refuses-ungranted',
    ]));
    expect(JSON.stringify(report)).not.toMatch(/FILE-CANARY|ENV-CANARY|host-token/);
  }, 120_000);
});
