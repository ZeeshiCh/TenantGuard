import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTenantRouter,
  type TenantRoute,
} from '../packages/core/src/index.js';
import {
  createTenantResourcePool,
  createPooledAdapter,
  ResourcePoolRouteError,
} from '../packages/resources/src/index.js';
import {
  createSqliteResource,
  createSqliteAdapter,
} from '../packages/sqlite/src/index.js';
import {
  sqliteFixture,
  sqliteTables,
  sqliteTenantA,
  sqliteTenantB,
} from './helpers/sqlite.js';

test(
  'managed SQLite resources preserve tenant isolation and pin transactions across file rotation',
  { timeout: 30000 },
  async () => {
    const first = await sqliteFixture(),
      second = await sqliteFixture();
    const files = new Map([
      ['first', first.filename],
      ['second', second.filename],
    ]);
    let revision = '1',
      destroyed = 0,
      created = 0;
    const route = (tenantId = sqliteTenantA.tenantId): TenantRoute => ({
      tenantId,
      source: 'orders',
      adapter: 'sqlite',
      resource:
        tenantId === sqliteTenantA.tenantId && revision === '2'
          ? 'second'
          : 'first',
      revision: tenantId === sqliteTenantA.tenantId ? revision : '1',
      status: 'active',
      mode: 'application-filter',
    });
    const pool = createTenantResourcePool({
      maxResources: 3,
      maxResourcesPerTenant: 2,
      create: async (value) => {
        const filename = files.get(value.resource);
        assert(filename);
        created++;
        return createSqliteResource({ filename });
      },
      destroy: async (resource) => {
        await resource.close();
        destroyed++;
      },
    });
    const adapter = createPooledAdapter({
      pool,
      name: 'sqlite',
      capabilities: {
        transactions: true,
        isolationModes: ['application-filter'],
      },
      createAdapter: (resource) =>
        createSqliteAdapter({
          resolveResource: () => resource,
          tables: sqliteTables,
        }),
    });
    const router = createTenantRouter({
      registry: { resolve: async (context) => route(context.tenantId) },
      sources: { orders: { adapter, mode: 'application-filter' } },
    });
    try {
      await first.seed();
      await second.seed();
      second.admin
        .prepare('UPDATE orders SET value=? WHERE tenant_id=?')
        .run('new-file', sqliteTenantA.tenantId);
      pool.setRoute(route());
      pool.setRoute(route(sqliteTenantB.tenantId));
      await Promise.all(
        Array.from({ length: 16 }, async (_, i) => {
          const context = i % 2 ? sqliteTenantB : sqliteTenantA;
          const rows = await router.run(context, 'orders', (client) =>
            client.table('orders').find(),
          );
          assert.equal(rows.length, 1);
          assert.equal(rows[0]!.tenant_id, context.tenantId);
        }),
      );
      assert.equal(created, 2);
      let acquired!: () => void, release!: () => void;
      const ready = new Promise<void>((yes) => {
        acquired = yes;
      });
      const gate = new Promise<void>((yes) => {
        release = yes;
      });
      const original = route();
      const old = router.run(sqliteTenantA, 'orders', async (client) => {
        await client
          .table('orders')
          .insert({ id: 'pinned', value: 'old-file' });
        acquired();
        await gate;
        return client.table('orders').find({ id: 'pinned' });
      });
      await ready;
      try {
        revision = '2';
        pool.setRoute(route(), '1');
        await assert.rejects(
          pool.run(original, async () => assert.fail('stale file generation')),
          ResourcePoolRouteError,
        );
        const rows = await router.run(sqliteTenantA, 'orders', (client) =>
          client.table('orders').find(),
        );
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.value, 'new-file');
        assert.equal(destroyed, 0);
      } finally {
        release();
      }
      assert.equal((await old)[0]!.value, 'old-file');
      await pool.close();
      assert.equal(pool.stats().resources, 0);
      assert.equal(destroyed, created);
      assert.equal(
        first.admin
          .prepare('SELECT count(*) AS n FROM orders WHERE id=?')
          .get('pinned')!.n,
        1,
      );
      assert.equal(
        second.admin
          .prepare('SELECT count(*) AS n FROM orders WHERE id=?')
          .get('pinned')!.n,
        0,
      );
    } finally {
      await pool.close();
      await Promise.all([first.close(), second.close()]);
    }
  },
);
