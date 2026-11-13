import { Hono } from 'hono';
import { createServer } from 'node:http';
import pg from 'pg';
import { createTenantGuard } from '@tenantguard/core';
import { tenantMiddleware } from '@tenantguard/hono';
import { nodeContext } from '@tenantguard/node';
import { createPgAdapter } from '@tenantguard/postgres/pg';

const url = process.env.DATABASE_URL;
const token = process.env.DEMO_API_TOKEN;
const tenant = process.env.DEMO_TENANT_ID;
if (!url || !token || !tenant)
  throw new Error('Set DATABASE_URL, DEMO_API_TOKEN and DEMO_TENANT_ID');
const pool = new pg.Pool({ connectionString: url, max: 4 });
const adapter = createPgAdapter({
  resolvePool: () => pool,
  tables: [{ schema: 'public', table: 'orders' }],
});
const guard = createTenantGuard({
  carrier: nodeContext,
  authorize: (request: Request) =>
    request.headers.get('authorization') === `Bearer ${token}`
      ? { tenantId: tenant, principalId: 'demo-user' }
      : undefined,
});
const app = new Hono();
app.use('/orders', tenantMiddleware(guard));
app.get('/orders', async (c) => {
  const context = c.get('tenant');
  const result = await adapter.run(
    context,
    {
      tenantId: context.tenantId,
      source: 'orders',
      adapter: 'pg',
      resource: 'demo',
      revision: '1',
      status: 'active',
      mode: 'database-policy',
    },
    (client) =>
      client.query(
        'SELECT id, tenant_id, description FROM public.orders ORDER BY id',
      ),
  );
  return c.json(result.rows);
});
const server = createServer((request, response) =>
  app
    .fetch(
      new Request(
        `http://${request.headers.host ?? 'localhost'}${request.url}`,
        {
          method: request.method,
          headers: request.headers as Record<string, string>,
        },
      ),
    )
    .then(async (result) => {
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(await result.text());
    }),
);
server.listen(Number(process.env.PORT ?? 3002));
process.once('SIGTERM', async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});
