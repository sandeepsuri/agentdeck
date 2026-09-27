// Issue #82 demo: approving and carrying out a PDF filing plan, through the
// real owner-only HTTP routes, against a throwaway folder — no personal file
// is touched. The proposal comes from a scripted stand-in for the confined
// agent that speaks MCP to the real broker (the live provider is #81's demo),
// so this spends no allowance. It shows:
//   - a stale plan fingerprint refused, and a collaborator device refused;
//   - approved moves, including a new folder and one approved replacement;
//   - a file edited after the proposal, a destination swapped for a link, and
//     a target the owner did not approve replacing, all left in place;
//   - a second approve (double tap) and a restart moving nothing again.
//
// Usage: npx tsx scripts/demo-filing-execution.ts
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CollaboratorService } from '../src/collaborators/service.js';
import { defaultConfig } from '../src/config.js';
import { PersonalTaskService } from '../src/personal-tasks/service.js';
import { isFilingProposal, type PersonalTaskView } from '../src/personal-tasks/types.js';
import { buildApp } from '../src/server/app.js';
import { TOKEN_HEADER } from '../src/server/connection-trust.js';
import type { RouteContext } from '../src/server/routes.js';
import { Store } from '../src/store/index.js';
import { scriptedFilingProvider, type BrokerCall } from '../src/test-fixtures/filing-agent.js';
import { buildTextPdf } from '../src/test-fixtures/pdf.js';

const REMOTE_HOST = 'demo-mac.tailnet-0000.ts.net';
const LOCAL = { host: '127.0.0.1:4040' };
const base = fs.realpathSync(fs.mkdtempSync('/private/tmp/agentdeck-filing-exec-demo-'));
const home = path.join(base, 'home');
const inbox = path.join(home, 'Documents', 'Inbox');
const outside = path.join(base, 'Outside');
const at = (relative: string) => path.join(inbox, ...relative.split('/'));

fs.mkdirSync(at('Bills'), { recursive: true });
fs.mkdirSync(at('Receipts'), { recursive: true });
fs.mkdirSync(outside, { recursive: true });
const files: Record<string, Buffer> = {
  'scan0001.pdf': buildTextPdf(['City Power & Light', 'Statement March 2026']),
  'scan0002.pdf': buildTextPdf(['Metro Water', 'Bill April 2026']),
  'scan0003.pdf': buildTextPdf(['Riverside Clinic', 'Visit summary']),
  'scan0004.pdf': buildTextPdf(['Hardware store receipt']),
  'scan0005.pdf': buildTextPdf(['Gas bill', 'May 2026']),
  'scan0006.pdf': buildTextPdf(['Phone bill', 'May 2026']),
};
for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(at(name), bytes);
fs.writeFileSync(at('Bills/Water 2026-04.pdf'), buildTextPdf(['an older water bill']));
fs.writeFileSync(at('Bills/Phone 2026-05.pdf'), buildTextPdf(['an older phone bill']));

const PLAN: Record<string, [string, string]> = {
  'scan0001.pdf': ['Power 2026-03.pdf', 'Bills/Power'], // new folder
  'scan0002.pdf': ['Water 2026-04.pdf', 'Bills'], // replacement the owner approves
  'scan0003.pdf': ['Clinic visit 2026-02.pdf', 'Medical'], // new folder
  'scan0004.pdf': ['Hardware receipt.pdf', 'Receipts'], // folder swapped for a link after the proposal
  'scan0005.pdf': ['Gas 2026-05.pdf', 'Bills'], // edited after the proposal
  'scan0006.pdf': ['Phone 2026-05.pdf', 'Bills'], // replacement the owner does not approve
};
const agent = async (call: BrokerCall) => {
  const documents = JSON.parse((await call('list_documents')).text) as { document: string; name: string }[];
  for (const document of documents) {
    await call('read_document', { document: document.document });
    const [newName, destination] = PLAN[document.name]!;
    await call('propose_filing', { document: document.document, new_name: newName, destination });
  }
};

const dbFile = path.join(base, 'agentdeck.db');
let store = new Store(dbFile);
let collaborators = new CollaboratorService(store);
let service!: PersonalTaskService;
let app!: ReturnType<typeof buildApp>;
function boot(): void {
  service = new PersonalTaskService({ repository: store.personal, homeDir: home, filingProvider: scriptedFilingProvider({ script: agent }) });
  service.recover();
  app = buildApp({
    config: { ...defaultConfig(), tailscaleToken: 'demo-shared-token-0123456789abcdef' },
    manager: {} as RouteContext['manager'],
    remoteHosts: [REMOTE_HOST],
    collaborators,
    store,
    personalTasks: { service, pickFolder: async () => inbox },
  });
}

const snapshot = () => fs.readdirSync(base, { recursive: true, withFileTypes: true })
  .filter((entry) => !entry.name.startsWith('agentdeck.db'))
  .map((entry) => {
    const full = path.join(entry.parentPath, entry.name);
    return `${path.relative(base, full)}:${entry.isFile() ? createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 8) : entry.isSymbolicLink() ? 'link' : 'dir'}`;
  })
  .sort()
  .join('\n');

const line = (text = '') => console.log(text);
let ok = true;
const check = (label: string, pass: boolean) => {
  ok &&= pass;
  line(`  ${pass ? 'PASS' : 'FAIL'}  ${label}`);
};

try {
  boot();
  const grant = (await app.inject({ method: 'POST', url: '/api/personal/grants/pick', headers: LOCAL })).json() as { grant: { id: string } };
  const created = await app.inject({
    method: 'POST', url: '/api/personal/tasks', headers: LOCAL, payload: { kind: 'pdf-filing-proposal', grantId: grant.grant.id, files: Object.keys(files) },
  });
  await service.whenIdle();
  const { id } = created.json() as PersonalTaskView;
  const proposed = service.get(id)!;
  if (!proposed.result || !isFilingProposal(proposed.result)) throw new Error(`No proposal: ${proposed.failure}`);
  const { planDigest } = proposed.result;
  line(`Proposal ${planDigest.slice(0, 12)} (nothing moved yet)`);
  for (const entry of proposed.result.entries) {
    line(`  ${entry.source} → ${entry.target}${entry.warnings.length ? `   ⚠ ${entry.warnings.map((warning) => warning.kind).join(', ')}` : ''}`);
  }

  // The world changes between review and approval.
  fs.writeFileSync(at('scan0005.pdf'), buildTextPdf(['Gas bill', 'May 2026', 'annotated after the proposal']));
  fs.renameSync(at('Receipts'), path.join(outside, 'Receipts'));
  fs.symlinkSync(path.join(outside, 'Receipts'), at('Receipts'));

  line('\nRefusals');
  const approveUrl = `/api/personal/tasks/${id}/filing/approve`;
  const before = snapshot();
  const stale = await app.inject({ method: 'POST', url: approveUrl, headers: LOCAL, payload: { planDigest: '0'.repeat(64) } });
  check(`stale plan fingerprint → ${stale.statusCode} ${(stale.json() as { code?: string }).code}`, stale.statusCode === 409);
  const { code } = collaborators.inviteCollaborator({ displayName: 'Collaborator' });
  const { token } = collaborators.exchangeInvitation(code, 'phone');
  const denied = await app.inject({ method: 'POST', url: approveUrl, headers: { host: `${REMOTE_HOST}:4040`, [TOKEN_HEADER]: token }, payload: { planDigest } });
  check(`collaborator device approve → ${denied.statusCode}`, denied.statusCode === 403);
  await service.whenIdle();
  check('nothing moved by either', snapshot() === before);

  line('\nOwner approves, replacing only Bills/Water 2026-04.pdf');
  await app.inject({ method: 'POST', url: approveUrl, headers: LOCAL, payload: { planDigest, overwrite: ['scan0002.pdf'] } });
  await service.whenIdle();
  const done = service.get(id)!;
  for (const receipt of done.filing!.receipts) {
    line(`  [${receipt.state.padEnd(7)}] ${receipt.source} → ${receipt.target}${receipt.reason ? `\n              ${receipt.reason}` : ''}`);
  }
  const states = Object.fromEntries(done.filing!.receipts.map((receipt) => [receipt.source, receipt.state]));
  check('approved moves happened', states['scan0001.pdf'] === 'moved' && states['scan0002.pdf'] === 'moved' && states['scan0003.pdf'] === 'moved');
  check('symlinked destination refused, nothing written outside', states['scan0004.pdf'] === 'failed' && fs.readdirSync(path.join(outside, 'Receipts')).length === 0);
  check('file edited after the proposal left in place', states['scan0005.pdf'] === 'failed' && fs.existsSync(at('scan0005.pdf')));
  check('unapproved replacement left in place', states['scan0006.pdf'] === 'skipped' && fs.existsSync(at('scan0006.pdf')));

  line('\nDouble tap and restart');
  fs.writeFileSync(at('scan0001.pdf'), files['scan0001.pdf']!); // a repeat would move this copy
  const afterFirst = snapshot();
  const again = await app.inject({ method: 'POST', url: approveUrl, headers: LOCAL, payload: { planDigest, overwrite: ['scan0002.pdf'] } });
  await service.whenIdle();
  check(`second approve → ${again.statusCode}, same receipts, nothing moved`, again.statusCode === 200 && snapshot() === afterFirst);
  await app.close();
  store.close();
  store = new Store(dbFile);
  collaborators = new CollaboratorService(store);
  boot();
  await service.whenIdle();
  check('restart moved nothing and kept the receipts', snapshot() === afterFirst && JSON.stringify(service.get(id)!.filing) === JSON.stringify(done.filing));

  line('\nActivity');
  for (const entry of service.get(id)!.activity.filter((item) => item.sequence > proposed.activity.length)) {
    line(`  ${String(entry.sequence).padStart(2)}. [${entry.kind}] ${entry.message}`);
  }
  process.exitCode = ok ? 0 : 1;
} finally {
  await app.close();
  store.close();
  fs.rmSync(base, { recursive: true, force: true });
}
