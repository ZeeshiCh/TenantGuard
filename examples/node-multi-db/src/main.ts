import { createServer } from 'node:http';
import { createTenantGuard } from '@tenantguard/core';
import { nodeContext } from '@tenantguard/node';
import { createPgAdapter } from '@tenantguard/postgres/pg';
import pg from 'pg';

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
  authorize: (request: { headers: Record<string, string | undefined> }) =>
    request.headers.authorization === `Bearer ${token}`
      ? { tenantId: tenant, principalId: 'demo-user' }
      : undefined,
});

const server = createServer(async (request, response) => {
  if (request.url !== '/orders') {
    response.writeHead(404).end();
    return;
  }
  try {
    const context = await guard.authorize({
      headers: request.headers as Record<string, string | undefined>,
    });
    const rows = await adapter.run(
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
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify(rows.rows));
  } catch {
    response
      .writeHead(403)
      .end(JSON.stringify({ error: 'tenant access denied' }));
  }
});
server.listen(Number(process.env.PORT ?? 3001));
process.once('SIGTERM', async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});
