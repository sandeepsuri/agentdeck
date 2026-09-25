// Builds the sandbox-exec invocation for a confined personal task (issue
// #77): the Seatbelt profile, a private HOME/TMPDIR/work directory, an
// environment carrying no host secret, and the one credential route each
// provider CLI needs. Nothing here is used by developer Sessions or Runs —
// those keep their existing, explicit power-user launch.
import fs from 'node:fs';
import path from 'node:path';
import type { AgentType } from '../types.js';
import { buildSeatbeltProfile } from './seatbelt.js';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** The only host variables copied into a confined process; everything else (tokens, sockets, PATH) is dropped. */
export const CONFINED_ENVIRONMENT_PASSTHROUGH: readonly string[] = Object.freeze(['LANG', 'LC_ALL', 'TERM', 'USER']);

const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

// Codex verifies TLS through Security.framework by default, which needs
// trustd and the keychain. A PEM bundle keeps both closed.
const SYSTEM_CA_BUNDLE = '/private/etc/ssl/cert.pem';

/**
 * How the provider CLI proves its sign-in inside the sandbox.
 * - 'none': the process gets no credential path (sign-in fails closed).
 * - 'macos-keychain': opens SecurityServer so Claude Code can run
 *   `/usr/bin/security` for its own login item. Seatbelt cannot scope that
 *   to one item or one process, so every child can then read keychain
 *   items; only safe when the agent is offered no process-spawning tool.
 * - 'codex-auth-file': a read-only link to ~/.codex/auth.json.
 */
export type ConfinedCredential = 'none' | 'macos-keychain' | 'codex-auth-file';

export interface ConfinedState {
  readonly root: string;
  readonly home: string;
  readonly tmp: string;
  readonly work: string;
}

/** Creates the private per-task state tree and returns its canonical paths. */
export function prepareConfinedState(root: string): ConfinedState {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const canonical = fs.realpathSync(root);
  const state = {
    root: canonical,
    home: path.join(canonical, 'home'),
    tmp: path.join(canonical, 'tmp'),
    work: path.join(canonical, 'work'),
  };
  for (const directory of [state.home, state.tmp, state.work]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return state;
}

export interface ConfinedLaunchOptions {
  readonly runtime: AgentType;
  /** The CLI as found on PATH; its real install tree becomes readable. */
  readonly executable: string;
  readonly args: readonly string[];
  readonly state: ConfinedState;
  readonly grantedReadRoots: readonly string[];
  readonly proxyPort: number;
  readonly brokerPort?: number;
  readonly hostEnv: Readonly<Record<string, string | undefined>>;
  /** The operator's real home directory (for the Codex login file). */
  readonly home: string;
  /** Defaults to 'codex-auth-file' for Codex and 'none' for Claude. */
  readonly credential?: ConfinedCredential;
}

export interface ConfinedLaunch {
  readonly command: typeof SANDBOX_EXEC;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly profile: string;
}

function isScript(file: string): boolean {
  const handle = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(2);
    fs.readSync(handle, head, 0, 2, 0);
    return head.toString() === '#!';
  } finally {
    fs.closeSync(handle);
  }
}

// The real executable's package directory (two levels above bin/<exe>). A
// Node launcher script also needs the Node installation found beside the
// PATH entry — for nvm that is the whole version prefix.
function runtimeInstall(executable: string): { realExecutable: string; roots: string[]; pathDirs: string[] } {
  const realExecutable = fs.realpathSync(executable);
  const roots = [path.dirname(path.dirname(realExecutable))];
  const pathDirs: string[] = [];
  if (isScript(realExecutable)) {
    const node = path.join(path.dirname(executable), 'node');
    if (fs.existsSync(node)) {
      const realNode = fs.realpathSync(node);
      roots.push(path.dirname(path.dirname(realNode)));
      pathDirs.push(path.dirname(realNode));
    }
  }
  return { realExecutable, roots, pathDirs };
}

export function buildConfinedLaunch(options: ConfinedLaunchOptions): ConfinedLaunch {
  const { state } = options;
  const install = runtimeInstall(options.executable);
  const home = fs.realpathSync(options.home);
  for (const root of install.roots) {
    if (root === home || home.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Refusing to confine a CLI whose install tree would expose the home folder: ${root}`);
    }
  }
  const credential = options.credential ?? (options.runtime === 'codex' ? 'codex-auth-file' : 'none');
  const proxyUrl = `http://127.0.0.1:${options.proxyPort}`;

  const env: Record<string, string> = {};
  for (const name of CONFINED_ENVIRONMENT_PASSTHROUGH) {
    const value = options.hostEnv[name];
    if (value !== undefined) env[name] = value;
  }
  Object.assign(env, {
    PATH: [...install.pathDirs, ...SYSTEM_PATH].join(':'),
    HOME: state.home,
    TMPDIR: `${state.tmp}/`,
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    http_proxy: proxyUrl,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  });

  const readFiles: string[] = [];
  if (options.runtime === 'claude') {
    // Claude Code otherwise writes to /tmp/claude-<uid>, outside the sandbox.
    env.CLAUDE_CODE_TMPDIR = state.tmp;
    if (credential === 'macos-keychain') {
      // `security` finds the login keychain under $HOME, so the private home
      // links to the real keychain directory (readable only through the
      // profile's keychain rule) and to nothing else of the owner's.
      const library = path.join(state.home, 'Library');
      fs.mkdirSync(library, { recursive: true, mode: 0o700 });
      fs.rmSync(path.join(library, 'Keychains'), { force: true });
      fs.symlinkSync(path.join(options.home, 'Library', 'Keychains'), path.join(library, 'Keychains'));
    }
  } else {
    const codexHome = path.join(state.home, '.codex');
    fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    env.CODEX_HOME = codexHome;
    env.CODEX_CA_CERTIFICATE = SYSTEM_CA_BUNDLE;
    if (credential === 'codex-auth-file') {
      const authFile = path.join(options.home, '.codex', 'auth.json');
      const link = path.join(codexHome, 'auth.json');
      if (fs.existsSync(authFile)) {
        fs.rmSync(link, { force: true });
        fs.symlinkSync(authFile, link);
        readFiles.push(fs.realpathSync(authFile));
      }
    }
  }

  const profile = buildSeatbeltProfile({
    runtimeRoots: install.roots,
    readRoots: options.grantedReadRoots.map((root) => fs.realpathSync(root)),
    readFiles,
    writeRoots: [state.root],
    loopbackPorts: options.brokerPort === undefined ? [options.proxyPort] : [options.proxyPort, options.brokerPort],
    keychainDirectory: credential === 'macos-keychain'
      ? fs.realpathSync(path.join(options.home, 'Library', 'Keychains'))
      : undefined,
  });

  return {
    command: SANDBOX_EXEC,
    args: ['-p', profile, install.realExecutable, ...options.args],
    env,
    cwd: state.work,
    profile,
  };
}
