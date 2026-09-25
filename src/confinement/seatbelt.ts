// macOS Seatbelt profile for a confined personal task (issue #77). The
// kernel enforces this policy on the selected CLI and on every process it
// forks or execs — a child cannot shed it, and a nested sandbox_apply is
// refused — so it bounds the agent's shell tool as well as the CLI itself.
//
// The policy starts closed ((deny default)) and opens only:
//   - the read-only system locations dyld, libc and the shell need;
//   - the CLI's own install roots (read + map-executable);
//   - explicitly granted read roots and read-only files;
//   - write roots (the task's scratch directory and private runtime state);
//   - TCP to named loopback ports — the egress proxy and the capability
//     broker. There is no DNS and no remote IP, so every provider request
//     must pass the domain-allowlisting proxy.
// It never opens trustd, Apple Events, the pasteboard, or Launch Services,
// and opens the keychain (SecurityServer) only when keychainDirectory is
// set: on macOS 26 that lets any child enumerate keychain items with
// `security dump-keychain`.
//
// Seatbelt matches resolved vnode paths, so callers must pass canonical
// (realpath'd) paths; a symlink inside a granted root that points outside
// it is then denied at open time.

export class SeatbeltProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeatbeltProfileError';
  }
}

export interface SeatbeltSpec {
  /** CLI install roots: readable and mappable as executable code. */
  readonly runtimeRoots: readonly string[];
  /** Granted read-only directory trees. */
  readonly readRoots: readonly string[];
  /** Granted read-only single files (for example a provider's own login file). */
  readonly readFiles: readonly string[];
  /** Read-write directory trees: task scratch space and private runtime state. */
  readonly writeRoots: readonly string[];
  /** Loopback TCP ports the process may connect to (egress proxy, broker). */
  readonly loopbackPorts: readonly number[];
  /**
   * The user's ~/Library/Keychains. When set, SecurityServer is reachable
   * so a CLI can read its own login item — and so can every child, for any
   * item whose access list trusts /usr/bin/security. Omit unless the
   * confined process is offered no process-spawning tool.
   */
  readonly keychainDirectory?: string;
}

// Measured on macOS 26.2: dyld aborts the process (SIGABRT, no log) unless
// "/" itself is readable, and the shared cache now lives in the Preboot
// cryptex rather than /private/var/db/dyld.
const SYSTEM_READ_ROOTS = [
  '/usr',
  '/bin',
  '/sbin',
  '/System',
  '/Library/Apple',
  '/private/etc',
  '/private/var/db/dyld',
  '/private/var/db/timezone',
  '/private/preboot',
];

const DEVICE_FILES = ['/dev/null', '/dev/zero', '/dev/random', '/dev/urandom', '/dev/tty', '/dev/dtracehelper'];

// Characters that would let a path break out of an SBPL string literal or
// smuggle a second rule onto the policy.
const UNSAFE_PATH = /["\\\u0000-\u001f\u007f]/;

function quotePath(candidate: string): string {
  if (!candidate.startsWith('/')) {
    throw new SeatbeltProfileError(`Confinement paths must be absolute: ${candidate}`);
  }
  if (UNSAFE_PATH.test(candidate)) {
    throw new SeatbeltProfileError(`Confinement path contains an unsupported character: ${JSON.stringify(candidate)}`);
  }
  if (candidate.replace(/\/+$/, '') === '') {
    throw new SeatbeltProfileError('Refusing to grant the filesystem root.');
  }
  return `"${candidate}"`;
}

function quotePort(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SeatbeltProfileError(`Invalid loopback port: ${port}`);
  }
  return `"localhost:${port}"`;
}

function rule(operations: string, filter: string, paths: readonly string[]): string[] {
  return paths.map((candidate) => `(allow ${operations} (${filter} ${quotePath(candidate)}))`);
}

export function buildSeatbeltProfile(spec: SeatbeltSpec): string {
  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process-fork process-exec)',
    '(allow signal (target same-sandbox))',
    '(allow process-info* (target same-sandbox))',
    '(allow sysctl-read)',
    // stat() anywhere: path resolution needs it. It reveals names, sizes and
    // times, never contents or directory listings.
    '(allow file-read-metadata)',
    '(allow file-read* (literal "/"))',
    ...SYSTEM_READ_ROOTS.map((root) => `(allow file-read* file-map-executable (subpath "${root}"))`),
    ...DEVICE_FILES.map((device) => `(allow file-read* file-write-data (literal "${device}"))`),
    '(allow file-read* (subpath "/dev/fd"))',
    // getpwuid()/os.userInfo(); no other Mach service is reachable.
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))',
    ...rule('file-read* file-map-executable', 'subpath', spec.runtimeRoots),
    ...rule('file-read*', 'subpath', spec.readRoots),
    ...rule('file-read*', 'literal', spec.readFiles),
    ...rule('file-read* file-write*', 'subpath', spec.writeRoots),
    ...spec.loopbackPorts.map((port) => `(allow network-outbound (remote tcp ${quotePort(port)}))`),
    ...(spec.keychainDirectory === undefined ? [] : [
      '(allow mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc"))',
      '(allow ipc-posix-shm-read-data (ipc-posix-name "com.apple.AppleDatabaseChanged"))',
      ...rule('file-read*', 'subpath', [spec.keychainDirectory]),
    ]),
  ];
  return `${lines.join('\n')}\n`;
}
