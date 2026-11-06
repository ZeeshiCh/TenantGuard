import Koa from 'koa';
import { createServer } from 'node:http';
import { tenantMiddleware } from '../packages/koa/src/index.js';
import { getTenant } from '../packages/node/src/index.js';
import {
  close,
  conformance,
  guard,
  handle,
  listen,
  recordError,
} from './http-conformance.js';
conformance('Koa', async () => {
  const app = new Koa();
  const errors: unknown[] = [];
  app.use(async (context, next) => {
    try {
      await next();
    } catch (error) {
      // Upstream Koa middleware resumes outside the nested tenant scope.
      recordError(errors, error, false);
      context.status = 500;
      context.body = 'Internal error';
    }
  });
  app.use(async (context, next) => {
    if (context.path === '/public') {
      context.body = { tenant: getTenant() ?? null };
      return;
    }
    await next();
  });
  app.use(tenantMiddleware(guard((context) => context.headers.authorization)));
  app.use(async (context) => {
    context.body = await handle(context.path);
  });
  const server = createServer(app.callback());
  return { url: await listen(server), errors, stop: () => close(server) };
});
