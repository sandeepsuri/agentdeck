import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../config.js';
import type { GitPublishService, PublishStatus } from '../git/publish.js';
import type { SessionManager } from '../sessions/manager.js';
import { Store } from '../store/index.js';
import { registerRoutes } from './routes.js';

const readyStatus: PublishStatus = {
  branch: 'feature/publish', baseBranch: 'main', baseCandidates: ['main'],
  remote: { name: 'origin', url: 'git@github.com:example/project.git', github: true },
  ahead: 1, stagedFiles: [], unstagedCount: 0,
  identity: { configured: true, name: 'AgentDeck Test', email: 'agentdeck@example.test' },
  github: {
    state: 'ready', installed: true, authenticated: true, account: 'octocat',
    detail: 'Authenticated with GitHub as octocat.',
  },
  canCommit: false, canCreatePr: true, blockers: [],
};

describe('repository publish routes', () => {
  let app: ReturnType<typeof Fastify>;
  let store: Store;
  let publish: GitPublishService;

  beforeEach(() => {
    app = Fastify();
    store = new Store(':memory:');
    store.upsertRepo({ id: '/repo', path: '/repo', name: 'repo' });
    publish = {
      status: vi.fn(async () => readyStatus),
      commit: vi.fn(async (_repo, subject) => ({ sha: 'abc1234', subject })),
      push: vi.fn(async () => ({ remote: 'origin' as const, branch: 'feature/publish', upstream: 'origin/feature/publish' })),
      createPullRequest: vi.fn(async (_repo, input) => ({
        number: 42, url: 'https://github.com/example/project/pull/42', title: input.title, state: 'OPEN', draft: input.draft,
      })),
    };
    registerRoutes(app, {
      manager: {} as SessionManager, config: defaultConfig(), store, publish,
    });
  });

  afterEach(async () => {
    await app.close();
    store.close();
  });

  it('returns status only for repositories in the store', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/repos/publish-status?repo=%2Frepo' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ branch: 'feature/publish', canCreatePr: true });
    expect(publish.status).toHaveBeenCalledWith('/repo');

    const unknown = await app.inject({ method: 'GET', url: '/api/repos/publish-status?repo=%2Funknown' });
    expect(unknown.statusCode).toBe(404);
  });

  it('validates and creates a staged-only commit', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/repos/commit', payload: {
      repo: '/repo', subject: 'Publish changes', body: 'Details',
    } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ sha: 'abc1234', subject: 'Publish changes' });
    expect(publish.commit).toHaveBeenCalledWith('/repo', 'Publish changes', 'Details');

    const invalid = await app.inject({ method: 'POST', url: '/api/repos/commit', payload: { repo: '/repo', subject: ' ' } });
    expect(invalid.statusCode).toBe(400);
  });

  it('pushes and creates a draft pull request with validated input', async () => {
    const pushed = await app.inject({ method: 'POST', url: '/api/repos/push', payload: { repo: '/repo' } });
    expect(pushed.statusCode).toBe(200);
    expect(publish.push).toHaveBeenCalledWith('/repo');

    const created = await app.inject({ method: 'POST', url: '/api/repos/pull-request', payload: {
      repo: '/repo', base: 'main', title: 'Publish changes', body: 'Summary', draft: true,
    } });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ number: 42, draft: true });
    expect(publish.createPullRequest).toHaveBeenCalledWith('/repo', {
      base: 'main', title: 'Publish changes', body: 'Summary', draft: true,
    });
  });

  it('rejects malformed pull request input before invoking the service', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/repos/pull-request', payload: {
      repo: '/repo', base: 'main', title: '', body: 'Summary', draft: 'yes',
    } });
    expect(response.statusCode).toBe(400);
    expect(publish.createPullRequest).not.toHaveBeenCalled();
  });
});
