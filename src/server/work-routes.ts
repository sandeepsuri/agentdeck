import type { FastifyInstance } from 'fastify';
import { InvalidWorkSpecError } from '../work-engine/engine.js';
import type { WorkEngine, WorkSpec } from '../work-engine/types.js';

/** Local admin REST adapter; all behavior remains owned by WorkEngine. */
export function registerWorkRoutes(app: FastifyInstance, workEngine: WorkEngine): void {
  app.get('/api/runs', async () => workEngine.list());

  app.get('/api/runs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = workEngine.get(id);
    return run ?? reply.code(404).send({ error: 'no such run' });
  });

  app.post('/api/runs', async (request, reply) => {
    try {
      const run = await workEngine.submit(request.body as WorkSpec);
      return reply.code(201).send(run);
    } catch (error) {
      if (error instanceof InvalidWorkSpecError) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
  });
}
