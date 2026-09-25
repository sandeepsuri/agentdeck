// Issue #77: proves (or disproves) macOS Seatbelt confinement of a
// personal-task provider CLI and its child processes. Findings and the gate
// decision live in docs/decisions/0003-personal-task-confinement.md.
//
// Usage: npx tsx scripts/probe-confinement.ts [--runtime claude|codex]
//          [--credential none|macos-keychain|codex-auth-file] [--live] [--record]
//   --live    also runs the real CLI confined (spends a little allowance)
//   --record  saves the report as this Mac's evidence for the access gate
//             (~/.agentdeck/confinement/<runtime>.json)
//
// Probes run against a throwaway fixture of random canaries under
// /private/tmp; no personal file or credential is read or reported. The
// redacted report is written to .scratch/confinement-probes/ (gitignored).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConfinedCredential } from '../src/confinement/confined-launch.js';
import { decidePersonalResourceAccess, recordConfinementEvidence } from '../src/confinement/decision.js';
import { runConfinementProbe } from '../src/confinement/probe.js';
import { resolveAgentExecutable } from '../src/sessions/executable.js';
import type { AgentType } from '../src/types.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const runtime = (option('runtime') ?? 'claude') as AgentType;
if (runtime !== 'claude' && runtime !== 'codex') throw new Error(`Unknown runtime: ${runtime}`);
const CREDENTIALS: readonly ConfinedCredential[] = ['none', 'macos-keychain', 'codex-auth-file'];
const credential = (option('credential') ?? (runtime === 'claude' ? 'macos-keychain' : 'codex-auth-file')) as ConfinedCredential;
if (!CREDENTIALS.includes(credential)) throw new Error(`Unknown credential route: ${credential}`);
const live = process.argv.includes('--live');

if (process.platform !== 'darwin') {
  console.error('Seatbelt confinement is macOS-only; personal resources stay on the deterministic workflow.');
  process.exit(1);
}
const executable = resolveAgentExecutable(runtime);
if (!executable) {
  console.error(`${runtime} is not installed.`);
  process.exit(1);
}

const report = await runConfinementProbe({ runtime, executable, credential, live });
for (const check of report.checks) {
  const label = check.outcome === 'pass' ? 'PASS' : check.outcome === 'fail' ? 'FAIL' : 'RISK';
  console.log(`${label}  ${check.id.padEnd(26)} ${check.expect.padEnd(5)} ${check.evidence}`);
}

const decision = decidePersonalResourceAccess({
  platform: process.platform, macosVersion: report.macosVersion, arch: process.arch, runtime,
  cliVersion: report.cliVersion, evidence: report,
});
console.log(`\nmacOS ${report.macosVersion} (${report.arch}) · ${runtime} ${report.cliVersion} · credential ${credential} · agent tools ${report.agentTools}`);
console.log(`Probe ${report.passed ? 'passed' : 'FAILED'}. Gate: ${decision.mode}${decision.mode === 'deterministic-only' ? ` — ${decision.reason}` : ''}`);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, '.scratch', 'confinement-probes');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `${runtime}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Report: ${path.relative(root, outPath)}`);
if (process.argv.includes('--record')) {
  console.log(`Recorded gate evidence: ${recordConfinementEvidence(report).replace(os.homedir(), '~')}`);
}
process.exit(report.passed ? 0 : 1);
