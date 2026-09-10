// Ticket 70 (B10, docs/specs/run-result-application-previews.md): a real
// http.createServer, real files on disk — no mocked file serving. This is
// the one genuinely new piece of infrastructure this ticket introduces.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  afterEach, beforeEach, describe, expect, it,
} from 'vitest';
import { RunPreviewServer } from './run-preview-server.js';

/**
 * `fetch`/the WHATWG URL parser normalizes `..` segments away before a
 * request is even sent — so a traversal test built on `fetch(url)` would
 * only prove the browser's own URL normalization, not this server's own
 * `resolveRepoFile`-based rejection. Node's raw `http.request` sends
 * whatever request-line path string it's given, unnormalized, which is
 * what actually exercises the server's own guard.
 */
function rawGet(port: number, rawPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

let worktree: string;
let server: RunPreviewServer;

beforeEach(() => {
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-preview-'));
  fs.mkdirSync(path.join(worktree, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'dist', 'index.html'), '<!doctype html><html><body>Hello preview</body></html>');
  fs.writeFileSync(path.join(worktree, 'dist', 'app.js'), 'console.log("hi");');
  server = new RunPreviewServer(200); // short idle timeout for the expiry test below
});

afterEach(async () => {
  await server.close();
  fs.rmSync(worktree, { recursive: true, force: true });
});

describe('RunPreviewServer', () => {
  it('serves the requested file, binds loopback only, and reports its own token-scoped URL', async () => {
    const started = await server.start({ runId: 'run-1', worktreePath: worktree, entryPath: 'dist/index.html' });

    expect(started.previewUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{48}\/dist\/index\.html$/);

    const response = await fetch(started.previewUrl);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Hello preview');
    expect(response.headers.get('content-type')).toMatch(/text\/html/);
  });

  it('serves a same-worktree relative asset the entry file references', async () => {
    const started = await server.start({ runId: 'run-1', worktreePath: worktree, entryPath: 'dist/index.html' });
    const assetUrl = started.previewUrl.replace('dist/index.html', 'dist/app.js');

    const response = await fetch(assetUrl);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('console.log("hi");');
    expect(response.headers.get('content-type')).toMatch(/javascript/);
  });

  it('sets a conservative CSP on every response, separate from the admin dashboard\'s own', async () => {
    const started = await server.start({ runId: 'run-1', worktreePath: worktree, entryPath: 'dist/index.html' });

    const response = await fetch(started.previewUrl);

    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
  });

  it('404s a request with the wrong token, never leaking whether the Run exists', async () => {
    const started = await server.start({ runId: 'run-1', worktreePath: worktree, entryPath: 'dist/index.html' });
    const wrongToken = 'a'.repeat(48);
    const wrongUrl = started.previewUrl.replace(/\/[0-9a-f]{48}\//, `/${wrongToken}/`);

    const response = await fetch(wrongUrl);

    expect(response.status).toBe(404);
  });

  it('404s a path-traversal attempt, reusing resolveRepoFile\'s existing rejection — never leaking a real file outside the worktree', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-preview-outside-'));
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'do not serve this');
    const started = await server.start({ runId: 'run-1', worktreePath: worktree, entryPath: 'dist/index.html' });
    const { port } = new URL(started.previewUrl);
    const token = new URL(started.previewUrl).pathname.split('/')[1];
    // Enough `..` segments to escape `worktree` regardless of how deep the
    // OS temp dir happens to be, landing on a file that genuinely exists
    // outside it — proving this is rejected by path containment, not
    // merely by the target not existing.
    const traversalPath = `/${token}/${'../'.repeat(10)}${outsideDir.replace(/^\//, '')}/secret.txt`;

    const status = await rawGet(Number(port), traversalPath);

    expect(status).toBe(404);
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('404s for a picked file that does not exist', async () => {
    const started = await server.start({ runId: 'run-1', worktreePath: worktree, entryPath: 'dist/missing.html' });

    const response = await fetch(started.previewUrl);

    expect(response.status).toBe(404);
  });

  it('invalidate(runId) ends every active session for that Run immediately', async () => {
    const started = await server.start({ runId: 'run-1', worktreePath: worktree, entryPath: 'dist/index.html' });
    expect((await fetch(started.previewUrl)).status).toBe(200);

    server.invalidate('run-1');

    expect((await fetch(started.previewUrl)).status).toBe(404);
  });

  it('invalidate never affects a different Run\'s active session', async () => {
    const runOne = await server.start({ runId: 'run-1', worktreePath: worktree, entryPath: 'dist/index.html' });
    const runTwo = await server.start({ runId: 'run-2', worktreePath: worktree, entryPath: 'dist/index.html' });

    server.invalidate('run-1');

    expect((await fetch(runOne.previewUrl)).status).toBe(404);
    expect((await fetch(runTwo.previewUrl)).status).toBe(200);
  });

  it('expires after the idle timeout with no further requests', async () => {
    const started = await server.start({ runId: 'run-1', worktreePath: worktree, entryPath: 'dist/index.html' });
    expect((await fetch(started.previewUrl)).status).toBe(200);

    await new Promise((resolve) => { setTimeout(resolve, 300); });

    expect((await fetch(started.previewUrl)).status).toBe(404);
  });

  it('an in-flight request resets the idle timer, keeping an actively-viewed preview alive', async () => {
    const started = await server.start({ runId: 'run-1', worktreePath: worktree, entryPath: 'dist/index.html' });

    await new Promise((resolve) => { setTimeout(resolve, 120); });
    expect((await fetch(started.previewUrl)).status).toBe(200); // resets the 200ms idle timer
    await new Promise((resolve) => { setTimeout(resolve, 120); });

    expect((await fetch(started.previewUrl)).status).toBe(200);
  });

  it('close() shuts the listener down — no further requests succeed', async () => {
    const started = await server.start({ runId: 'run-1', worktreePath: worktree, entryPath: 'dist/index.html' });

    await server.close();

    await expect(fetch(started.previewUrl)).rejects.toThrow();
  });
});
