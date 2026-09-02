// Regenerates src/test-fixtures/codex-protocol-snapshot.json from the Codex
// CLI installed on this machine.
//
// Why a derived snapshot rather than the schema files themselves: the raw
// `codex app-server generate-json-schema` output is ~5 MB across hundreds of
// files (ClientRequest.json alone is 272 KB), which is neither reviewable in a
// diff nor useful to a test. What the adapter actually depends on is a much
// smaller set of facts — which JSON-RPC methods exist, and which payload paths
// each one carries — so that is what gets extracted and checked in.
//
// Usage: node scripts/snapshot-codex-protocol.mjs [--out <path>] [--check]
//   --check  writes nothing; exits non-zero if the snapshot would change
//            (i.e. the installed CLI has drifted from the checked-in file).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const check = args.includes('--check');
const outIndex = args.indexOf('--out');
const outPath = outIndex >= 0
  ? path.resolve(args[outIndex + 1])
  : path.join(root, 'src', 'test-fixtures', 'codex-protocol-snapshot.json');

/** How deep to walk a payload schema. Every path the adapter reads sits within 3 (e.g. params.turn.error.message). */
const MAX_DEPTH = 3;

function codex(...commandArgs) {
  return execFileSync('codex', commandArgs, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function readJson(directory, relativePath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(directory, relativePath), 'utf8'));
  } catch {
    return undefined;
  }
}

/** Resolves a local "#/definitions/Name" reference against the schema document it came from. */
function resolveRef(document, node) {
  let current = node;
  const seen = new Set();
  while (current && typeof current.$ref === 'string') {
    if (seen.has(current.$ref)) return undefined;
    seen.add(current.$ref);
    const name = current.$ref.replace('#/definitions/', '');
    current = document.definitions?.[name];
  }
  return current;
}

/** Every branch of a oneOf/anyOf/allOf union, plus the node itself, so a union's fields are all reachable. */
function branches(document, node) {
  const resolved = resolveRef(document, node);
  if (!resolved || typeof resolved !== 'object') return [];
  const nested = [...(resolved.oneOf ?? []), ...(resolved.anyOf ?? []), ...(resolved.allOf ?? [])];
  if (nested.length === 0) return [resolved];
  return [resolved, ...nested.flatMap((branch) => branches(document, branch))];
}

/**
 * Flattens a payload schema into dotted paths ('turn.error.message'), plus
 * 'field=value' entries for string enums so discriminator values (a
 * ThreadItem's `type`, an approval `decision`) are pinned too.
 */
function payloadPaths(document, node, prefix = '', depth = 0, seen = new Set()) {
  if (depth > MAX_DEPTH) return [];
  const paths = [];
  for (const branch of branches(document, node)) {
    if (branch.enum && prefix) {
      for (const value of branch.enum) {
        if (typeof value === 'string') paths.push(`${prefix}=${value}`);
      }
    }
    // An array is transparent for path purposes: `input` holding UserInput
    // items yields `input.text` and `input.type=text`, which is what a caller
    // building that payload actually needs to know.
    if (branch.items) {
      paths.push(...payloadPaths(document, branch.items, prefix, depth, seen));
    }
    for (const [key, rawChild] of Object.entries(branch.properties ?? {})) {
      const childPath = prefix ? `${prefix}.${key}` : key;
      paths.push(childPath);
      const child = resolveRef(document, rawChild);
      if (!child || typeof child !== 'object') continue;
      // Guard $ref cycles (a Thread referencing a Thread) only. Inline
      // schemas cannot recurse, and guarding those would collapse a union's
      // branches into whichever one was walked first — losing, say, every
      // ThreadItem `type` value after the first.
      if (typeof rawChild.$ref === 'string') {
        const visited = `${childPath}:${rawChild.$ref}`;
        if (seen.has(visited)) continue;
        seen.add(visited);
      }
      paths.push(...payloadPaths(document, child, childPath, depth + 1, seen));
    }
  }
  return paths;
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

/** Reads the `method` enum + params $ref off each branch of a ClientRequest/ServerNotification/ServerRequest union. */
function unionMembers(document) {
  const members = [];
  for (const branch of document?.oneOf ?? []) {
    const method = branch.properties?.method?.enum?.[0];
    if (typeof method === 'string') members.push({ method, params: branch.properties?.params });
  }
  return members;
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-codex-snapshot-'));
let snapshot;
try {
  const version = codex('--version').match(/\bcodex-cli\s+([0-9][0-9A-Za-z.+-]*)/i)?.[1];
  if (!version) throw new Error('could not read a codex-cli version from `codex --version`');
  codex('app-server', 'generate-json-schema', '--out', directory, '--experimental');

  const clientRequest = readJson(directory, 'ClientRequest.json');
  const serverNotification = readJson(directory, 'ServerNotification.json');
  const serverRequest = readJson(directory, 'ServerRequest.json');
  if (!clientRequest || !serverNotification || !serverRequest) {
    throw new Error(`generated schema is missing its top-level unions in ${directory}`);
  }

  const serverNotifications = {};
  for (const { method, params } of unionMembers(serverNotification)) {
    serverNotifications[method] = params ? sortedUnique(payloadPaths(serverNotification, params)) : [];
  }

  // A server-to-client request needs both halves: the params the adapter
  // reads to describe the request, and the result shape it must reply with.
  const serverRequests = {};
  for (const { method, params } of unionMembers(serverRequest)) {
    const title = params?.$ref?.replace('#/definitions/', '');
    const response = title?.endsWith('Params') ? readJson(directory, `${title.slice(0, -'Params'.length)}Response.json`) : undefined;
    serverRequests[method] = {
      params: params ? sortedUnique(payloadPaths(serverRequest, params)) : [],
      response: response ? sortedUnique(payloadPaths(response, response)) : [],
    };
  }

  // Only the responses the adapter actually reads a value out of.
  const responses = {};
  for (const [method, file] of [['thread/start', 'v2/ThreadStartResponse.json'], ['turn/start', 'v2/TurnStartResponse.json']]) {
    const response = readJson(directory, file);
    if (!response) throw new Error(`generated schema is missing ${file}`);
    responses[method] = sortedUnique(payloadPaths(response, response));
  }

  const threadItem = serverNotification.definitions?.ThreadItem;
  const threadItemTypes = sortedUnique(
    (threadItem?.oneOf ?? []).map((branch) => branch.properties?.type?.enum?.[0]).filter((value) => typeof value === 'string'),
  );

  // Params are kept only for the requests AgentDeck actually sends — the full
  // 154-method surface would bury them. The complete name list is still
  // captured, so "does this method exist at all" stays answerable.
  const sentRequests = new Set(['initialize', 'thread/start', 'turn/start']);
  const requestParams = {};
  for (const { method, params } of unionMembers(clientRequest)) {
    if (sentRequests.has(method)) requestParams[method] = params ? sortedUnique(payloadPaths(clientRequest, params)) : [];
  }

  snapshot = {
    codexVersion: version,
    generatedBy: 'scripts/snapshot-codex-protocol.mjs',
    clientRequests: sortedUnique(unionMembers(clientRequest).map((member) => member.method)),
    requestParams,
    responses,
    serverNotifications,
    serverRequests,
    threadItemTypes,
  };
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
if (check) {
  const existing = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
  if (existing !== serialized) {
    console.error(`[agentdeck] codex protocol snapshot is out of date (installed codex-cli ${snapshot.codexVersion}).`);
    console.error('[agentdeck] run: node scripts/snapshot-codex-protocol.mjs');
    process.exit(1);
  }
  console.log(`[agentdeck] codex protocol snapshot matches installed codex-cli ${snapshot.codexVersion}`);
} else {
  fs.writeFileSync(outPath, serialized);
  console.log(`[agentdeck] wrote ${path.relative(root, outPath)} from codex-cli ${snapshot.codexVersion}`);
}
