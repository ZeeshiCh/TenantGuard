import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import {
  createDrizzleAdapter,
  DrizzleTimeoutError,
  type DrizzleScopedClient,
  type DrizzleRepository,
} from '../packages/drizzle/src/index.js';
import {
  adapterConformanceCases,
  type AdapterConformanceFixture,
} from '../packages/testing/src/conformance.js';
import {
  createTenantRouter,
  type TenantRoute,
} from '../packages/core/src/index.js';
import {
  drizzleFixture,
  drizzleTenantA,
  drizzleTenantB,
} from './helpers/drizzle.js';
interface Row {
  id: string;
  tenantId: string;
  value: string;
}
for (const engine of ['postgresql', 'mysql', 'mariadb'] as const)
  test(
    `Drizzle ${engine} scoped CRUD and owned transaction conformance`,
    { timeout: 180000 },
    async (t) => {
      const db = await drizzleFixture(engine),
        adapter = createDrizzleAdapter({
          resolveResource: () => db.resource,
          tables: db.tables,
        });
      const route = (tenantId = drizzleTenantA.tenantId): TenantRoute => ({
        tenantId,
        adapter: 'drizzle',
        source: 'orders',
        resource: 'drizzle-main',
        revision: '1',
        status: 'active',
        mode: 'application-filter',
      });
      const run = <T>(work: (c: DrizzleScopedClient) => Promise<T>) =>
        adapter.run(drizzleTenantA, route(), work);
      try {
        for (const entry of adapterConformanceCases({
          transactional: true,
          createFixture: async (): Promise<
            AdapterConformanceFixture<DrizzleScopedClient>
          > => {
            await db.seed();
            return {
              adapter,
              tenantA: drizzleTenantA,
              tenantB: drizzleTenantB,
              seedA: {
                id: 'seed-a',
                tenantId: drizzleTenantA.tenantId,
                value: 'a',
              },
              seedB: {
                id: 'seed-b',
                tenantId: drizzleTenantB.tenantId,
                value: 'b',
              },
              route: (c) => route(c.tenantId),
              read: (c, id) =>
                c.table<Row>('orders').find(id === undefined ? {} : { id }),
              insert: async (c, row) => {
                await c.table('orders').insert({ ...row });
              },
              update: (c, id, changes) =>
                c.table('orders').update({ id }, { ...changes }),
              delete: (c, id) => c.table('orders').delete({ id }),
              close: async () => {},
            };
          },
        }))
          await t.test(entry.name, entry.run);
        await db.seed();
        await t.test(
          'strict routing refuses application filtering and unwrapped Drizzle bypasses it',
          async () => {
            assert.throws(
              () =>
                createTenantRouter({
                  strict: true,
                  sources: { orders: { adapter, mode: 'application-filter' } },
                  registry: { resolve: async () => undefined },
                }),
              /Strict/,
            );
            assert.equal((await db.nativeRead()).length, 2);
          },
        );
        await t.test(
          'binary ownership defeats case, accent and padding aliases under database defaults',
          async () => {
            await db.execute(
              "INSERT INTO orders VALUES('padded','Org_A ','bad')",
            );
            assert.deepEqual(
              (await run((c) => c.table<Row>('orders').find())).map(
                (row) => row.id,
              ),
              ['seed-a'],
            );
            assert.equal(
              await run((c) =>
                c.table('orders').update({ id: 'padded' }, { value: 'oops' }),
              ),
              0,
            );
            assert.equal(
              await run((c) => c.table('orders').delete({ id: 'seed-b' })),
              0,
            );
            for (const tenantId of ['Café', 'Cafe', '$tenant']) {
              await adapter.run({ tenantId }, route(tenantId), (c) =>
                c.table('orders').insert({ id: tenantId, value: tenantId }),
              );
              const rows = await adapter.run(
                { tenantId },
                route(tenantId),
                (c) => c.table<Row>('orders').find(),
              );
              assert.equal(rows.length, 1);
              assert.equal(rows[0]!.tenantId, tenantId);
            }
          },
        );
        await t.test(
          'explicit foreign tenant filters do not alias under permissive collations',
          async () => {
            if (engine === 'postgresql') {
              await db.execute(
                "CREATE COLLATION tenantguard_ci(provider=icu,locale='und-u-ks-level2',deterministic=false)",
              );
              await db.execute(
                'ALTER TABLE orders ALTER COLUMN tenant_id TYPE text COLLATE tenantguard_ci',
              );
            }
            try {
              assert.deepEqual(
                await run((c) =>
                  c.table('orders').find({ tenantId: drizzleTenantB.tenantId }),
                ),
                [],
              );
              assert.equal(
                await run((c) =>
                  c
                    .table('orders')
                    .update(
                      { id: 'seed-a', tenantId: drizzleTenantB.tenantId },
                      { value: 'oops' },
                    ),
                ),
                0,
              );
              const rows = await run((c) => c.table<Row>('orders').find());
              assert.equal(rows.length, 1);
              assert.equal(rows[0]!.tenantId, drizzleTenantA.tenantId);
            } finally {
              if (engine === 'postgresql') {
                await db.execute(
                  'ALTER TABLE orders ALTER COLUMN tenant_id TYPE text COLLATE "C"',
                );
                await db.execute('DROP COLLATION tenantguard_ci');
              }
            }
          },
        );
        await t.test(
          'SQL objects, operators, relations and raw query options cannot widen CRUD',
          async () => {
            assert.deepEqual(
              await run((c) =>
                c.table('orders').find({ id: "' OR 1=1;COMMIT;--" }),
              ),
              [],
            );
            for (const work of [
              (c: DrizzleScopedClient) =>
                c.table('orders').find({ OR: 'unsafe' }),
              (c: DrizzleScopedClient) =>
                c.table('orders').find({ id: sql`1=1` } as never),
              (c: DrizzleScopedClient) =>
                c
                  .table('orders')
                  .find({}, { with: { related: true } } as never),
              (c: DrizzleScopedClient) =>
                c
                  .table('orders')
                  .update({ id: 'seed-a' }, { value: sql`'unsafe'` } as never),
            ])
              await assert.rejects(() => run<unknown>(work));
          },
        );
        await t.test(
          'caught validation and constraint errors roll back prior writes',
          async () => {
            for (const invalid of [
              (repo: DrizzleRepository) =>
                repo.update({ id: 'seed-a' }, { tenantId: 'other' }),
              (repo: DrizzleRepository) =>
                repo.insert({ id: 'seed-a', value: 'duplicate' }),
            ]) {
              await assert.rejects(() =>
                run(async (c) => {
                  const orders = c.table('orders');
                  await orders.insert({ id: 'rollback', value: 'bad' });
                  await invalid(orders).catch(() => {});
                }),
              );
              assert.equal(await db.rawCount('rollback'), 0);
            }
          },
        );
        await t.test(
          'parallel facade calls serialize and repositories are revoked after callback',
          async () => {
            let escaped!: DrizzleRepository;
            await run(async (c) => {
              escaped = c.table('orders');
              const rows = await Promise.all(
                Array.from({ length: 8 }, () => escaped.find()),
              );
              assert.ok(rows.every((r) => r.length === 1));
            });
            await assert.rejects(() => escaped.find(), /outside/);
          },
        );
        await t.test(
          'work deadlines roll back prior writes and a fresh connection works',
          async () => {
            const timed = createDrizzleAdapter({
              resolveResource: () => db.resource,
              tables: db.tables,
              operationTimeoutMs: 200,
            });
            let escaped!: DrizzleRepository;
            await assert.rejects(
              () =>
                timed.run(drizzleTenantA, route(), async (c) => {
                  escaped = c.table('orders');
                  await escaped.insert({ id: 'timeout', value: 'bad' });
                  await new Promise(() => {});
                }),
              DrizzleTimeoutError,
            );
            await assert.rejects(() => escaped.find(), /outside/);
            assert.equal(await db.rawCount('timeout'), 0);
            await run((c) => c.table('orders').find());
          },
        );
        await t.test(
          'unawaited writes cannot commit and nested independent scopes are denied',
          async () => {
            await assert.rejects(
              () =>
                run(async (c) => {
                  void c
                    .table('orders')
                    .insert({ id: 'pending', value: 'bad' });
                }),
              /Unawaited/,
            );
            assert.equal(await db.rawCount('pending'), 0);
            await run(async () => {
              await assert.rejects(() => run(async () => {}), /Nested/);
            });
          },
        );
        await t.test(
          'blocked native updates cannot commit earlier writes when errors are swallowed',
          async () => {
            await db.execute('BEGIN');
            await db.execute(
              "SELECT * FROM orders WHERE id='seed-a' FOR UPDATE",
            );
            try {
              await assert.rejects(() =>
                run(async (c) => {
                  const orders = c.table('orders');
                  await orders.insert({ id: 'lock-prior', value: 'bad' });
                  await orders
                    .update({ id: 'seed-a' }, { value: 'blocked' })
                    .catch(() => {});
                }),
              );
            } finally {
              await db.execute('ROLLBACK');
            }
            assert.equal(await db.rawCount('lock-prior'), 0);
            await run((c) => c.table('orders').find());
          },
        );
        await t.test(
          'request expiry closes blocked native connections without leaking writes',
          async () => {
            const timed = createDrizzleAdapter({
              resolveResource: () => db.resource,
              tables: db.tables,
              requestTimeoutMs: 100,
              cleanupTimeoutMs: 2000,
            });
            await db.execute('BEGIN');
            await db.execute(
              "SELECT * FROM orders WHERE id='seed-a' FOR UPDATE",
            );
            try {
              await assert.rejects(() =>
                timed.run(drizzleTenantA, route(), async (c) => {
                  const orders = c.table('orders');
                  await orders.insert({ id: 'request-prior', value: 'bad' });
                  await orders.update({ id: 'seed-a' }, { value: 'blocked' });
                }),
              );
            } finally {
              await db.execute('ROLLBACK');
            }
            assert.equal(await db.rawCount('request-prior'), 0);
            await run((c) => c.table('orders').find());
          },
        );
        await t.test(
          'views and nontransactional/weak ownership schemas deny callbacks',
          async () => {
            if (engine === 'postgresql') {
              await db.execute(
                'ALTER TABLE orders ALTER COLUMN tenant_id DROP NOT NULL',
              );
              try {
                await assert.rejects(
                  () => run(async () => assert.fail('unsafe callback')),
                  /NOT NULL/,
                );
              } finally {
                await db.execute(
                  'ALTER TABLE orders ALTER COLUMN tenant_id SET NOT NULL',
                );
              }
            } else {
              await db.execute('ALTER TABLE orders ENGINE=MyISAM');
              try {
                await assert.rejects(
                  () => run(async () => assert.fail('unsafe callback')),
                  /InnoDB/,
                );
              } finally {
                await db.execute('ALTER TABLE orders ENGINE=InnoDB');
              }
            }
            await db.execute('ALTER TABLE orders RENAME TO original_orders');
            await db.execute(
              'CREATE VIEW orders AS SELECT * FROM original_orders',
            );
            try {
              await assert.rejects(
                () => run(async () => assert.fail('view callback')),
                /ordinary|InnoDB/,
              );
            } finally {
              await db.execute('DROP VIEW orders');
              await db.execute('ALTER TABLE original_orders RENAME TO orders');
            }
          },
        );
        await t.test(
          'owned native connections are closed after scopes settle',
          async () => {
            await run((c) => c.table('orders').find());
            for (let attempt = 0; ; attempt++) {
              if ((await db.connections()) === 0) break;
              if (attempt > 20)
                assert.fail('Drizzle leaked native connections');
              await new Promise((r) => setTimeout(r, 50));
            }
          },
        );
        await t.test(
          'closed resources reject new business callbacks',
          async () => {
            await db.resource.close();
            await assert.rejects(
              () => run(async () => assert.fail('closed callback')),
              /closed|outside/,
            );
          },
        );
      } finally {
        await db.close();
      }
    },
  );
