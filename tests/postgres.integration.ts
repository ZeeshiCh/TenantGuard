import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import pg from 'pg';
import { runWithTenant } from '../packages/node/src/index.js';
import { tenantPolicySql } from '../packages/postgres/src/index.js';
import { createTenantRouter } from '../packages/core/src/index.js';
import {
  createTypeormPostgresAdapter,
  withTenantTransaction,
} from '../packages/typeorm/src/index.js';
const a = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  b = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
test(
  'real PostgreSQL enforces isolation and cleans pooled connections',
  { timeout: 120000 },
  async () => {
    const container = await new PostgreSqlContainer(
      'postgres:17-alpine',
    ).start();
    const admin = new pg.Client({
      connectionString: container.getConnectionUri(),
    });
    let source: DataSource | undefined;
    try {
      await admin.connect();
      await admin.query(
        "CREATE ROLE app LOGIN PASSWORD 'integration' NOSUPERUSER NOBYPASSRLS; CREATE TABLE orders (id int PRIMARY KEY, tenant_id uuid NOT NULL); GRANT SELECT, INSERT, UPDATE, DELETE ON orders TO app;",
      );
      await admin.query(tenantPolicySql('orders'));
      await admin.query('INSERT INTO orders VALUES (1, $1), (2, $2)', [a, b]);
      source = new DataSource({
        type: 'postgres',
        host: container.getHost(),
        port: container.getPort(),
        username: 'app',
        password: 'integration',
        database: container.getDatabase(),
        extra: { max: 1 },
      });
      await source.initialize();
      const db = source;
      const scoped = <T>(
        id: string,
        work: Parameters<typeof withTenantTransaction<T>>[1],
      ) => runWithTenant(id, () => withTenantTransaction(db, work));
      assert.deepEqual(await db.query('SELECT * FROM orders'), []);
      await assert.rejects(
        () => withTenantTransaction(db, async () => {}),
        /context/,
      );
      for (const id of [a, b]) {
        const rows = await scoped(id, (m) => m.query('SELECT * FROM orders'));
        assert.equal(rows.length, 1);
        assert.equal(rows[0].tenant_id, id);
      }
      assert.deepEqual(
        await scoped(a, (m) =>
          m.query('UPDATE orders SET id = 3 WHERE id = 2 RETURNING *'),
        ),
        [[], 0],
      );
      assert.deepEqual(
        await scoped(a, (m) =>
          m.query('DELETE FROM orders WHERE id = 2 RETURNING *'),
        ),
        [[], 0],
      );
      await assert.rejects(
        () =>
          scoped(a, (m) => m.query('INSERT INTO orders VALUES (3, $1)', [b])),
        /row-level security/,
      );
      await assert.rejects(
        () =>
          scoped(a, (m) =>
            m.query('UPDATE orders SET tenant_id = $1 WHERE id = 1', [b]),
          ),
        /row-level security/,
      );
      await assert.rejects(
        () =>
          scoped(a, async (m) => {
            await m.query('DELETE FROM orders');
            throw new Error('rollback');
          }),
        /rollback/,
      );
      assert.deepEqual(await db.query('SELECT * FROM orders'), []);
      assert.equal(
        (await scoped(a, (m) => m.query('SELECT * FROM orders'))).length,
        1,
      );
      await scoped(a, async () => {
        await assert.rejects(
          () => withTenantTransaction(db, async () => {}),
          /Nested/,
        );
      });
      const adapter = createTypeormPostgresAdapter(() => db);
      const router = createTenantRouter({
        strict: true,
        sources: { orders: { adapter, mode: 'database-policy' } },
        registry: {
          resolve: async (context) => ({
            tenantId: context.tenantId,
            source: 'orders',
            adapter: adapter.name,
            resource: 'test-pool',
            revision: '1',
            status: 'active',
            mode: 'database-policy',
          }),
        },
      });
      for (const tenantId of [a, b]) {
        const rows = await router.run({ tenantId }, 'orders', (manager) =>
          manager.query('SELECT * FROM orders'),
        );
        assert.equal(rows.length, 1);
        assert.equal(rows[0].tenant_id, tenantId);
      }
      assert.deepEqual(await db.query('SELECT * FROM orders'), []);
      // An unrelated permissive policy must not widen the restrictive boundary.
      await admin.query(
        'CREATE POLICY broad_access ON orders USING (true) WITH CHECK (true)',
      );
      assert.equal(
        (await scoped(a, (m) => m.query('SELECT * FROM orders'))).length,
        1,
      );
      await Promise.all(
        [a, b, a, b].map((id) =>
          scoped(id, async (m) => {
            const rows = await m.query('SELECT * FROM orders');
            assert.equal(rows[0].tenant_id, id);
          }),
        ),
      );
    } finally {
      if (source?.isInitialized) await source.destroy();
      await admin.end();
      await container.stop();
    }
  },
);
