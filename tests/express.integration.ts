import express, { type ErrorRequestHandler } from 'express';
import { createServer } from 'node:http';
import { tenantMiddleware } from '../packages/express/src/index.js';
import { getTenant } from '../packages/node/src/index.js';
import {
  close,
  conformance,
  guard,
  handle,
  listen,
  recordError,
} from './http-conformance.js';
conformance('Express', async () => {
  const app = express();
  const errors: unknown[] = [];
  app.get('/public', (_request, response) => {
    response.json({ tenant: getTenant() ?? null });
  });
  app.use(tenantMiddleware(guard((request) => request.headers.authorization)));
  app.use(async (request, response) => {
    response.json(await handle(request.path));
  });
  const errorHandler: ErrorRequestHandler = (
    error,
    _request,
    response,
    _next,
  ) => {
    recordError(errors, error);
    response.status(500).send('Internal error');
  };
  app.use(errorHandler);
  const server = createServer(app);
  return { url: await listen(server), errors, stop: () => close(server) };
});
