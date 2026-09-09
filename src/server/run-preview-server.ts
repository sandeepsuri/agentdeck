// Ticket 70 (B10, docs/specs/run-result-application-previews.md): an
// in-process, loopback-only, ephemeral static-file server for the smallest
// supported preview artifact type — a single already-produced HTML file
// plus same-directory relative assets, from a settled Run's own worktree.
//
// Deliberately a genuinely separate origin from the admin dashboard (its
// own port — never the admin app's Fastify instance, never the tailnet
// interface): agent-generated content must never share the dashboard's own
// ambient authority (cookies, same-origin API access). Access is gated by a
// fresh, single-request-scoped random token in the URL path (never a query
// string, which can leak via a Referer header) — never persisted anywhere,
// mirroring this codebase's own "launch-secret exclusion" discipline.
//
// Never proxies, never spawns a process, never executes anything from the
// worktree — only ever resolves a requested relative path with the exact
// same containment check GET /api/repos/diff/file already relies on
// (resolveRepoFile, ../git/diff.js) and streams the file back.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { resolveRepoFile } from '../git/diff.js';

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

/** Conservative and separate from the admin dashboard's own CSP (app.ts) — the previewed content is untrusted, agent-produced, and gets no exception from this. */
const PREVIEW_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * One token's worth of authorized preview access — deliberately never named
 * "Session": CONTEXT.md's own vocabulary reserves that word for a running
 * Claude Code/Codex process AgentDeck can observe, and repeatedly tells
 * other, unrelated concepts to avoid it for exactly this reason (Task,
 * Run). A preview grant has no process behind it at all.
 */
interface PreviewGrant {
  readonly runId: string;
  readonly worktreePath: string;
  timer: ReturnType<typeof setTimeout>;
  expiresAt: number;
}

export interface StartPreviewInput {
  readonly runId: string;
  readonly worktreePath: string;
  /** Repository-relative — one of derivePreviewCandidates' own results. */
  readonly entryPath: string;
}

export interface StartedPreview {
  readonly previewUrl: string;
  readonly expiresAt: string;
}

/**
 * Owns at most one active `http.createServer`, lazily created on the first
 * `start()` call and shared across every concurrent preview grant (each
 * independently identified and authorized by its own token) — never one
 * listener per Run, to avoid unbounded port/listener growth.
 */
export class RunPreviewServer {
  private readonly idleTimeoutMs: number;
  private server: http.Server | undefined;
  private port: number | undefined;
  private readonly grants = new Map<string, PreviewGrant>();

  constructor(idleTimeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS) {
    this.idleTimeoutMs = idleTimeoutMs;
  }

  async start(input: StartPreviewInput): Promise<StartedPreview> {
    await this.ensureListening();
    const token = randomBytes(24).toString('hex');
    const grant: PreviewGrant = {
      runId: input.runId, worktreePath: input.worktreePath, timer: setTimeout(() => {}, 0), expiresAt: 0,
    };
    this.grants.set(token, grant);
    this.touch(token, grant);
    return {
      previewUrl: `http://127.0.0.1:${this.port}/${token}/${input.entryPath}`,
      expiresAt: new Date(grant.expiresAt).toISOString(),
    };
  }

  /** Ticket 70 (B10): called by DurableWorkEngine's onWorktreeReset hook before retryAttempt() resets a Run's worktree — every active grant for that Run stops resolving immediately, never left to go stale. */
  invalidate(runId: string): void {
    for (const [token, grant] of this.grants) {
      if (grant.runId !== runId) continue;
      clearTimeout(grant.timer);
      this.grants.delete(token);
    }
  }

  /** Stops the listener entirely — dies with the process in production; used directly by tests. */
  async close(): Promise<void> {
    for (const grant of this.grants.values()) clearTimeout(grant.timer);
    this.grants.clear();
    const { server } = this;
    if (!server) return;
    this.server = undefined;
    this.port = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private touch(token: string, grant: PreviewGrant): void {
    clearTimeout(grant.timer);
    grant.expiresAt = Date.now() + this.idleTimeoutMs;
    grant.timer = setTimeout(() => this.grants.delete(token), this.idleTimeoutMs);
    // Never a reason to keep the process alive on its own — preview
    // grants are opt-in, short-lived, and must never block shutdown.
    grant.timer.unref?.();
  }

  private async ensureListening(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => { this.handleRequest(req, res); });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('preview server failed to bind a loopback port');
    }
    this.server = server;
    this.port = address.port;
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.setHeader('Content-Security-Policy', PREVIEW_CONTENT_SECURITY_POLICY);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const notFound = () => { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Not found'); };

    const rawUrl = req.url ?? '/';
    const [pathname] = rawUrl.split('?');
    const segments = (pathname ?? '').split('/').filter(Boolean);
    const [token, ...rest] = segments;
    if (!token) return notFound();
    const grant = this.grants.get(token);
    if (!grant) return notFound();

    const relativePath = rest.map(decodeURIComponent).join('/') || 'index.html';
    const resolved = resolveRepoFile(grant.worktreePath, relativePath);
    if (!resolved || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return notFound();

    this.touch(token, grant);
    const contentType = MIME_TYPES[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': contentType });
    fs.createReadStream(resolved).pipe(res);
  }
}
