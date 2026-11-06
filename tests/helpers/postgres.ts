import pg from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { DatabaseAdapter } from '../../packages/core/src/index.js';
import type {
  AdapterConformanceFixture,
  ConformanceRecord,
} from '../../packages/testing/src/conformance.js';
import { tenantPolicySql } from '../../packages/postgres/src/index.js';
export const tenantA = { tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
export const tenantB = { tenantId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' };
export async function postgresFixture() {
  const container = await new PostgreSqlContainer('postgres:17-alpine').start();
  const admin = new pg.Client({
    connectionString: container.getConnectionUri(),
  });
  try {
    await admin.connect();
    await admin.query(
      "CREATE ROLE app LOGIN PASSWORD 'integration' NOSUPERUSER NOBYPASSRLS; CREATE TABLE public.orders (id text PRIMARY KEY, tenant_id uuid NOT NULL, value text NOT NULL); GRANT USAGE ON SCHEMA public TO app; GRANT SELECT, INSERT, UPDATE, DELETE ON public.orders TO app;",
    );
    await admin.query(tenantPolicySql('orders'));
  } catch (error) {
    await admin.end();
    await container.stop();
    throw error;
  }
  return {
    admin,
    adminConfig: { connectionString: container.getConnectionUri() },
    config: {
      host: container.getHost(),
      port: container.getPort(),
      user: 'app',
      password: 'integration',
      database: container.getDatabase(),
      max: 2,
      connectionTimeoutMillis: 2000,
    },
    async close() {
      try {
        await admin.end();
      } finally {
        await container.stop();
      }
    },
  };
}
export async function sqlConformanceFixture<Client>(options: {
  admin: pg.Client;
  adapter: DatabaseAdapter<Client>;
  execute(
    client: Client,
    text: string,
    values?: unknown[],
  ): Promise<ConformanceRecord[]>;
  close(): Promise<void>;
}): Promise<AdapterConformanceFixture<Client>> {
  const seedA = { id: 'seed-a', tenantId: tenantA.tenantId, value: 'a' },
    seedB = { id: 'seed-b', tenantId: tenantB.tenantId, value: 'b' };
  await options.admin.query('TRUNCATE public.orders');
  await options.admin.query(
    'INSERT INTO public.orders VALUES ($1,$2,$3),($4,$5,$6)',
    [
      seedA.id,
      seedA.tenantId,
      seedA.value,
      seedB.id,
      seedB.tenantId,
      seedB.value,
    ],
  );
  const columns = 'id, tenant_id AS "tenantId", value';
  return {
    adapter: options.adapter,
    tenantA,
    tenantB,
    seedA,
    seedB,
    route: (context) => ({
      tenantId: context.tenantId,
      adapter: options.adapter.name,
      source: 'orders',
      resource: 'test-pool',
      revision: '1',
      status: 'active',
      mode: 'database-policy',
    }),
    read: (client, id) =>
      options.execute(
        client,
        `SELECT ${columns} FROM public.orders${id === undefined ? '' : ' WHERE id = $1'}`,
        id === undefined ? [] : [id],
      ),
    insert: async (client, row) => {
      await options.execute(
        client,
        'INSERT INTO public.orders VALUES ($1,$2,$3)',
        [row.id, row.tenantId, row.value],
      );
    },
    update: async (client, id, changes) =>
      (
        await options.execute(
          client,
          `UPDATE public.orders SET tenant_id = COALESCE($2::uuid, tenant_id), value = COALESCE($3::text, value) WHERE id = $1 RETURNING ${columns}`,
          [id, changes.tenantId ?? null, changes.value ?? null],
        )
      ).length,
    delete: async (client, id) =>
      (
        await options.execute(
          client,
          `DELETE FROM public.orders WHERE id = $1 RETURNING ${columns}`,
          [id],
        )
      ).length,
    close: options.close,
  };
}
