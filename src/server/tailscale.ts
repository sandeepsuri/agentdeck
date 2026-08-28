// Tailscale interface detection (ticket 05, Stage 4 step 1). Shells out to
// the `tailscale` CLI; the exec function is injectable so this is
// unit-testable without a real Tailscale install (see tailscale.test.ts).
//
// Failure of any kind — binary missing, not logged in, malformed JSON,
// timeout — must degrade to `undefined`, never throw: the server falls back
// to loopback-only rather than failing to start.
import { execFile } from 'node:child_process';

export interface TailscaleInterface {
  /** The tailnet IPv4 address (`tailscale ip -4`), always present when this resolves. */
  ip: string;
  /** MagicDNS name (`tailscale status --json` → Self.DNSName), trailing dot stripped. Best-effort. */
  hostname?: string;
}

export type ExecFn = (
  command: string,
  args: string[],
  opts: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

const DEFAULT_TIMEOUT_MS = 3000;

const defaultExec: ExecFn = (command, args, opts) => new Promise((resolve, reject) => {
  execFile(command, args, { timeout: opts.timeout, encoding: 'utf8' }, (error, stdout, stderr) => {
    if (error) reject(error);
    else resolve({ stdout, stderr });
  });
});

function stripTrailingDot(name: string): string {
  return name.endsWith('.') ? name.slice(0, -1) : name;
}

export async function detectTailscaleInterface(
  exec: ExecFn = defaultExec,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<TailscaleInterface | undefined> {
  let ip: string;
  try {
    const { stdout } = await exec('tailscale', ['ip', '-4'], { timeout: timeoutMs });
    ip = stdout.trim().split('\n')[0]?.trim() ?? '';
    if (!ip) return undefined;
  } catch {
    return undefined; // binary missing, not logged in, timed out, ...
  }

  // The hostname is a nice-to-have (a friendlier address than a bare IP);
  // any failure here still leaves a usable IP-only interface.
  let hostname: string | undefined;
  try {
    const { stdout } = await exec('tailscale', ['status', '--json'], { timeout: timeoutMs });
    const parsed = JSON.parse(stdout) as { Self?: { DNSName?: unknown } };
    const dnsName = parsed.Self?.DNSName;
    if (typeof dnsName === 'string' && dnsName.length > 0) {
      hostname = stripTrailingDot(dnsName);
    }
  } catch {
    // malformed JSON / command failure — ip alone is enough to bind to.
  }

  return { ip, hostname };
}
