import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = process.argv.includes('--release');
const identity = release ? process.env.AGENTDECK_SIGN_IDENTITY : '-';
const notaryProfile = process.env.AGENTDECK_NOTARY_PROFILE;
if (process.platform !== 'darwin') throw new Error('Mac app packaging requires macOS');
if (release && (!identity || !notaryProfile)) {
  throw new Error('Release packaging requires AGENTDECK_SIGN_IDENTITY and AGENTDECK_NOTARY_PROFILE');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: root, ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? result.error})`);
}

const app = path.join(root, 'dist', 'mac', 'AgentDeck.app');
const contents = path.join(app, 'Contents');
const macOS = path.join(contents, 'MacOS');
const resources = path.join(contents, 'Resources');
const service = path.join(resources, 'service');
const scratch = path.join(root, '.mac-build');
fs.rmSync(app, { recursive: true, force: true });
fs.mkdirSync(macOS, { recursive: true });
fs.mkdirSync(service, { recursive: true });

// Copy only the runtime dependency closure. Native modules must come from the
// same Node ABI and CPU architecture as the embedded executable.
const packageList = execFileSync('npm', ['ls', '--omit=dev', '--parseable', '--all'], {
  cwd: root, encoding: 'utf8',
}).trim().split('\n').slice(1);
for (const source of packageList) {
  const relative = path.relative(root, source);
  if (!relative.startsWith('node_modules/')) throw new Error(`Unexpected npm dependency: ${source}`);
  const destination = path.join(service, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, {
    recursive: true, force: true, dereference: true,
    filter: (candidate) => !path.relative(source, candidate).split(path.sep).includes('.bin'),
  });
}
for (const entry of ['bin', 'migrations']) {
  const source = path.join(root, entry);
  if (!fs.existsSync(source)) throw new Error(`Missing build output: ${entry}`);
  fs.cpSync(source, path.join(service, entry), { recursive: true });
}
for (const entry of fs.readdirSync(path.join(root, 'dist'))) {
  if (entry === 'mac') continue;
  fs.cpSync(path.join(root, 'dist', entry), path.join(service, 'dist', entry), { recursive: true });
}
for (const entry of ['server/index.js', 'ui/index.html', 'native/AgentDeckNotch.app', 'native/AgentDeckWindowView.app']) {
  if (!fs.existsSync(path.join(service, 'dist', entry))) throw new Error(`Missing build output: dist/${entry}`);
}
// Bundle the packager's Gmail Desktop client (decision 0002 until AgentDeck's
// own is registered), so whoever runs this app can Connect Gmail with no
// file of their own. src/personal-tasks/email/gmail-oauth.ts reads it from
// beside itself. Google does not treat a Desktop client's secret as
// confidential; the refresh tokens it issues stay in each user's Keychain.
const gmailClientSource = process.env.AGENTDECK_GMAIL_CLIENT_FILE
  ?? path.join(os.homedir(), '.agentdeck', 'gmail-oauth-client.json');
let gmailClient;
try {
  gmailClient = JSON.parse(fs.readFileSync(gmailClientSource, 'utf8')).installed;
} catch { /* reported below */ }
if (typeof gmailClient?.client_id === 'string' && typeof gmailClient?.client_secret === 'string') {
  const target = path.join(service, 'dist', 'personal-tasks', 'email', 'gmail-oauth-client.json');
  fs.writeFileSync(target, `${JSON.stringify({ installed: { client_id: gmailClient.client_id, client_secret: gmailClient.client_secret } })}\n`);
  console.log(`[agentdeck] bundled Gmail client ${gmailClient.client_id.split('-')[0]}… from ${gmailClientSource.replace(os.homedir(), '~')}`);
} else {
  console.warn(`[agentdeck] no Desktop Gmail client at ${gmailClientSource.replace(os.homedir(), '~')}; this app will show Gmail as not set up`);
}
fs.writeFileSync(path.join(service, 'package.json'), '{"type":"module","private":true}\n');
fs.copyFileSync(process.execPath, path.join(macOS, 'node'));
fs.chmodSync(path.join(macOS, 'node'), 0o755);

const swiftPackage = path.join(root, 'native', 'AgentDeckApp');
run('xcrun', ['swift', 'build', '--package-path', swiftPackage, '--scratch-path', scratch,
  '--configuration', 'release']);
const swiftBin = execFileSync('xcrun', ['swift', 'build', '--package-path', swiftPackage,
  '--scratch-path', scratch, '--configuration', 'release', '--show-bin-path'], {
  cwd: root, encoding: 'utf8',
}).trim();
fs.copyFileSync(path.join(swiftBin, 'AgentDeckApp'), path.join(macOS, 'AgentDeckApp'));
fs.chmodSync(path.join(macOS, 'AgentDeckApp'), 0o755);
const plist = fs.readFileSync(path.join(swiftPackage, 'Info.plist'), 'utf8')
  .replace('<string>0.1.0</string>', `<string>${JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version}</string>`);
fs.writeFileSync(path.join(contents, 'Info.plist'), plist);

const signArgs = ['--force', '--sign', identity];
if (release) signArgs.push('--options', 'runtime', '--timestamp');
else signArgs.push('--timestamp=none');
const sign = (target, entitlements) => run('codesign', [
  ...signArgs, ...(entitlements ? ['--entitlements', entitlements] : []), target,
]);
const nodeEntitlements = path.join(swiftPackage, 'Node.entitlements');
// Sign all Mach-O content from the inside out. The nested menu app is kept
// intact so src/native/companion.ts can launch it by its existing path.
function walk(directory, visit) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file, visit);
    else visit(file);
  }
}
walk(path.join(service, 'node_modules'), (file) => {
  if (file.endsWith('.node') || path.basename(file) === 'spawn-helper') sign(file);
});
const companion = path.join(service, 'dist/native/AgentDeckNotch.app');
sign(path.join(companion, 'Contents/MacOS/AgentDeckNotch'));
sign(companion);
// Issue #91: runs as a child of the service, so Screen Recording is granted to AgentDeck itself.
const windowView = path.join(service, 'dist/native/AgentDeckWindowView.app');
sign(path.join(windowView, 'Contents/MacOS/AgentDeckWindowView'));
sign(windowView);
sign(path.join(macOS, 'node'), nodeEntitlements);
sign(path.join(macOS, 'AgentDeckApp'));
sign(app);
run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);

// Smoke test the exact embedded Node and production modules before shipping.
run(path.join(macOS, 'node'), ['-e',
  "require('better-sqlite3')(':memory:').close(); require('node-pty');"], { cwd: service });

const archive = path.join(root, 'dist', 'mac', `AgentDeck-${process.arch}.zip`);
fs.rmSync(archive, { force: true });
if (release) {
  const submission = path.join(os.tmpdir(), `agentdeck-notary-${process.pid}.zip`);
  try {
    run('ditto', ['-c', '-k', '--keepParent', app, submission]);
    const result = spawnSync('xcrun', ['notarytool', 'submit', submission,
      '--keychain-profile', notaryProfile, '--wait', '--output-format', 'json'], {
      cwd: root, encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error(result.stderr || 'Apple notarization submission failed');
    const receipt = JSON.parse(result.stdout);
    if (receipt.status !== 'Accepted') {
      throw new Error(`Apple notarization rejected the app: ${receipt.status ?? 'unknown status'} (${receipt.id ?? 'no submission ID'})`);
    }
    console.log(`[agentdeck] notarization accepted: ${receipt.id}`);
    run('xcrun', ['stapler', 'staple', app]);
    run('spctl', ['--assess', '--type', 'execute', '--verbose=4', app]);
  } finally {
    fs.rmSync(submission, { force: true });
  }
}
run('ditto', ['-c', '-k', '--keepParent', app, archive]);
console.log(`[agentdeck] ${release ? 'signed and notarized' : 'local test'} app: ${app}`);
console.log(`[agentdeck] install archive: ${archive}`);
