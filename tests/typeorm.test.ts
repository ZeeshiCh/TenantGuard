import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DataSource, EntityManager } from 'typeorm';
import {
  createTenantRouter,
  type TenantRoute,
} from '../packages/core/src/index.js';
import { runWithTenant } from '../packages/node/src/index.js';
import {
  withTenantTransaction,
  createTypeormPostgresAdapter,
} from '../packages/typeorm/src/index.js';
const tenantId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
function sourceFixture(privileged = false) {
  const queries: { sql: string; values?: unknown[] }[] = [];
  let transactions = 0;
  const manager = {
    query: async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      return sql.includes('pg_roles')
        ? [{ rolsuper: privileged, rolbypassrls: false }]
        : [];
    },
  } as unknown as EntityManager;
  const source = {
    options: { type: 'postgres' },
    transaction: async <T>(work: (manager: EntityManager) => Promise<T>) => {
      transactions++;
      return work(manager);
    },
  } as unknown as DataSource;
  return { source, queries, count: () => transactions };
}
test('TypeORM validates its UUID encoding before opening a transaction', async () => {
  const f = sourceFixture();
  for (const id of ['Org_A', tenantId.toUpperCase()]) {
    await assert.rejects(
      () =>
        runWithTenant(id, () =>
          withTenantTransaction(f.source, async () => {}),
        ),
      /UUID/,
    );
  }
  assert.equal(f.count(), 0);
});
test('TypeORM rejects privileged roles before tenant callback or set_config', async () => {
  const f = sourceFixture(true);
  await assert.rejects(
    () =>
      runWithTenant(tenantId, () =>
        withTenantTransaction(f.source, async () =>
          assert.fail('must not run'),
        ),
      ),
    /non-superuser/,
  );
  assert.equal(f.queries.length, 1);
});
test('TypeORM rejects nested transactions instead of silently committing independent work', async () => {
  const f = sourceFixture();
  await runWithTenant(tenantId, () =>
    withTenantTransaction(f.source, async () => {
      await assert.rejects(
        () => withTenantTransaction(f.source, async () => {}),
        /Nested/,
      );
    }),
  );
  assert.equal(f.count(), 1);
  await runWithTenant(tenantId, () =>
    withTenantTransaction(f.source, async () => {}),
  );
  assert.equal(f.count(), 2);
});
test('portable router executes TypeORM using explicit context without Node ambient context', async () => {
  const f = sourceFixture();
  const adapter = createTypeormPostgresAdapter(() => f.source);
  const route: TenantRoute = {
    tenantId,
    source: 'orders',
    adapter: adapter.name,
    resource: 'pool-1',
    revision: '1',
    status: 'active',
    mode: 'database-policy',
  };
  const router = createTenantRouter({
    strict: true,
    registry: { resolve: async () => route },
    sources: { orders: { adapter, mode: 'database-policy' } },
  });
  await router.run({ tenantId }, 'orders', async (manager) => {
    await manager.query('SELECT 1');
  });
  assert.deepEqual(f.queries[1]?.values, [tenantId]);
  assert.match(f.queries[1]!.sql, /true/);
  assert.equal(f.queries[2]?.sql, 'SELECT 1');
});
