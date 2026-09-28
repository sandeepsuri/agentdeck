// Issue #85: owner-only routes for setting up a provider CLI on this Mac.
// Installing, signing in, and opening pages all act on this Mac, so like
// /api/personal/* none of these paths is on app.ts's remote or collaborator
// allowlists, and each handler re-checks that the request is local.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SETUP_PROVIDERS, type SetupProvider } from '../provider-setup/readiness.js';
import { ProviderSetupError, type ProviderSetupService } from '../provider-setup/service.js';

export interface ProviderSetupRouteDeps {
  service: ProviderSetupService;
  /** True only for the owner at this Mac. */
  isOwner: (request: FastifyRequest) => boolean;
}

const ERROR_STATUS: Record<ProviderSetupError['code'], number> = {
  'invalid-state': 409,
  'invalid-input': 400,
  'not-installed': 409,
  unsupported: 400,
};

const OWNER_ONLY = 'Provider setup is only available to the owner on this Mac.';

export function registerProviderSetupRoutes(app: FastifyInstance, deps: ProviderSetupRouteDeps): void {
  const { service } = deps;

  /** Resolves the provider for an owner request, or answers the request itself. */
  const guard = (request: FastifyRequest, reply: FastifyReply): SetupProvider | undefined => {
    if (!deps.isOwner(request)) {
      void reply.code(403).send({ error: OWNER_ONLY });
      return undefined;
    }
    const { provider } = request.params as { provider: string };
    if (!(SETUP_PROVIDERS as readonly string[]).includes(provider)) {
      void reply.code(404).send({ error: 'No such provider.' });
      return undefined;
    }
    return provider as SetupProvider;
  };

  const act = async (request: FastifyRequest, reply: FastifyReply, action: (provider: SetupProvider) => unknown) => {
    const provider = guard(request, reply);
    if (!provider) return reply;
    try {
      await action(provider);
      return service.view();
    } catch (error) {
      if (error instanceof ProviderSetupError) return reply.code(ERROR_STATUS[error.code]).send({ error: error.message, code: error.code });
      return reply.code(500).send({ error: 'AgentDeck could not do that on this Mac. Try again.' });
    }
  };

  app.get('/api/provider-setup', async (request, reply) => {
    if (!deps.isOwner(request)) return reply.code(403).send({ error: OWNER_ONLY });
    service.ensureCheckedThisLaunch();
    return service.view();
  });

  // A check takes a few seconds; the answer arrives through GET polling.
  app.post('/api/provider-setup/:provider/check', (request, reply) => act(request, reply, (provider) => {
    void service.check(provider).catch(() => undefined);
  }));
  app.post('/api/provider-setup/:provider/install', (request, reply) => act(request, reply, (provider) => service.install(provider)));
  app.post('/api/provider-setup/:provider/install-guide', (request, reply) => act(request, reply, (provider) => service.openInstallGuide(provider)));
  app.post('/api/provider-setup/:provider/sign-in', (request, reply) => act(request, reply, (provider) => service.signIn(provider)));
  app.post('/api/provider-setup/:provider/sign-in/page', (request, reply) => act(request, reply, (provider) => service.openSignInPage(provider)));
  app.post('/api/provider-setup/:provider/sign-in/code', (request, reply) => act(request, reply, (provider) => {
    const { code } = (request.body ?? {}) as { code?: unknown };
    if (typeof code !== 'string') throw new ProviderSetupError('invalid-input', 'code is required');
    service.submitSignInCode(provider, code);
  }));
  // The probe runs one short live turn; its progress arrives through GET polling.
  app.post('/api/provider-setup/:provider/agent-access', (request, reply) => act(request, reply, (provider) => service.checkAgentAccess(provider)));
  app.post('/api/provider-setup/:provider/cancel', (request, reply) => act(request, reply, (provider) => service.cancel(provider)));
}
