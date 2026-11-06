import Fastify from 'fastify';
import { tenantHook } from '../packages/fastify/src/index.js';
import { getTenant } from '../packages/node/src/index.js';
import { conformance, guard, handle } from './http-conformance.js';
conformance('Fastify', async () => {
  const app = Fastify();
  const errors: unknown[] = [];
  app.setErrorHandler((error, _request, reply) => {
    errors.push(error);
    void reply.code(500).send('Internal error');
  });
  app.get('/public', async () => ({ tenant: getTenant() ?? null }));
  await app.register(async (protectedApp) => {
    protectedApp.addHook(
      'preHandler',
      tenantHook(guard((request) => request.headers.authorization)),
    );
    protectedApp.get('/tenant', async () => handle('/tenant'));
    protectedApp.get('/throw', async () => handle('/throw'));
  });
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  return { url, errors, stop: () => app.close() };
});
