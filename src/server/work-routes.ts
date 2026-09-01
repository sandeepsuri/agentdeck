import type { FastifyInstance } from 'fastify';
import {
  InvalidRunStateError, InvalidWorkSpecError, RunNotFoundError, RunPreparationError, UnsupportedRuntimeError,
} from '../work-engine/engine.js';
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

  app.post('/api/runs/:id/prepare', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await workEngine.prepare(id);
    } catch (error) {
      if (error instanceof RunNotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof InvalidRunStateError || error instanceof RunPreparationError) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post('/api/runs/:id/start', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await workEngine.start(id);
    } catch (error) {
      if (error instanceof RunNotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof InvalidRunStateError || error instanceof UnsupportedRuntimeError) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post('/api/runs/:id/cancel', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await workEngine.cancel(id);
    } catch (error) {
      if (error instanceof RunNotFoundError) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });
}
