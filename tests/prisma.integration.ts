import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPrismaAdapter,
  PrismaTimeoutError,
  type PrismaScopedClient,
  type PrismaRepository,
} from '../packages/prisma/src/index.js';
import {
  adapterConformanceCases,
  type AdapterConformanceFixture,
} from '../packages/testing/src/conformance.js';
import {
  createTenantRouter,
  type TenantRoute,
} from '../packages/core/src/index.js';
import {
  prismaFixture,
  prismaModels,
  prismaTenantA,
  prismaTenantB,
} from './helpers/prisma.js';
interface Row {
  id: string;
  tenantId: string;
  value: string;
}
for (const engine of ['postgresql', 'mysql', 'mariadb'] as const)
  test(
    `Prisma ${engine} scoped CRUD and interactive transaction conformance`,
    { timeout: 180000 },
    async (t) => {
      const db = await prismaFixture(engine),
        adapter = createPrismaAdapter({
          resolveResource: () => db.resource,
          models: prismaModels,
        });
      const route = (tenantId = prismaTenantA.tenantId): TenantRoute => ({
        tenantId,
        adapter: 'prisma',
        source: 'orders',
        resource: 'prisma-main',
        revision: '1',
        status: 'active',
        mode: 'application-filter',
      });
      const run = <T>(work: (c: PrismaScopedClient) => Promise<T>) =>
        adapter.run(prismaTenantA, route(), work);
      try {
        for (const entry of adapterConformanceCases({
          transactional: true,
          createFixture: async (): Promise<
            AdapterConformanceFixture<PrismaScopedClient>
          > => {
            await db.seed();
            return {
              adapter,
              tenantA: prismaTenantA,
              tenantB: prismaTenantB,
              seedA: {
                id: 'seed-a',
                tenantId: prismaTenantA.tenantId,
                value: 'a',
              },
              seedB: {
                id: 'seed-b',
                tenantId: prismaTenantB.tenantId,
                value: 'b',
              },
              route: (c) => route(c.tenantId),
              read: (c, id) =>
                c.model<Row>('orders').find(id === undefined ? {} : { id }),
              insert: async (c, row) => {
                await c.model('orders').insert({ ...row });
              },
              update: (c, id, changes) =>
                c.model('orders').update({ id }, { ...changes }),
              delete: (c, id) => c.model('orders').delete({ id }),
              close: async () => {},
            };
          },
        }))
          await t.test(entry.name, entry.run);
        await db.seed();
        await t.test(
          'strict routing refuses application filtering and native Prisma bypasses scoping',
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
            const raw = db.createClient();
            try {
              assert.equal(
                (await raw.$queryRawUnsafe<unknown[]>('SELECT * FROM orders'))
                  .length,
                2,
              );
            } finally {
              await raw.$disconnect();
            }
          },
        );
        await t.test(
          'case, accent and padding aliases cannot widen ownership',
          async () => {
            await db.execute(
              "INSERT INTO orders VALUES('padded','Org_A ','bad')",
            );
            assert.deepEqual(
              (await run((c) => c.model<Row>('orders').find())).map(
                (r) => r.id,
              ),
              ['seed-a'],
            );
            assert.equal(
              await run((c) =>
                c.model('orders').update({ id: 'padded' }, { value: 'oops' }),
              ),
              0,
            );
            assert.equal(
              await run((c) => c.model('orders').delete({ id: 'seed-b' })),
              0,
            );
            for (const tenantId of ['Café', 'Cafe', '$tenant']) {
              await adapter.run({ tenantId }, route(tenantId), (c) =>
                c.model('orders').insert({ id: tenantId, value: tenantId }),
              );
              const rows = await adapter.run(
                { tenantId },
                route(tenantId),
                (c) => c.model<Row>('orders').find(),
              );
              assert.equal(rows.length, 1);
              assert.equal(rows[0]!.tenantId, tenantId);
            }
          },
        );
        await t.test(
          'nested writes, relation projections and Prisma operators fail closed',
          async () => {
            for (const work of [
              (c: PrismaScopedClient) =>
                c.model('orders').find({ OR: 'unsafe' }),
              (c: PrismaScopedClient) =>
                c.model('orders').insert({
                  id: 'nested',
                  related: { create: { tenantId: 'other' } },
                } as never),
              (c: PrismaScopedClient) =>
                c
                  .model('orders')
                  .find({}, { include: { related: true } } as never),
              (c: PrismaScopedClient) =>
                c.model('orders').update({ id: 'seed-a' }, {
                  value: { set: 'injected' },
                } as never),
            ])
              await assert.rejects(() => run<unknown>(work));
            const unsafe = createPrismaAdapter({
              resolveResource: () => db.resource,
              models: {
                orders: {
                  ...prismaModels.orders,
                  fields: [...prismaModels.orders.fields, 'related'],
                },
              },
            });
            await assert.rejects(
              () =>
                unsafe.run(prismaTenantA, route(), async () =>
                  assert.fail('callback invoked'),
                ),
              /scalar fields/,
            );
            assert.equal(await db.rawCount('nested'), 0);
          },
        );
        await t.test(
          'caught validation and native constraint errors roll back preceding writes',
          async () => {
            for (const invalid of [
              (repo: PrismaRepository) =>
                repo.update({ id: 'seed-a' }, { tenantId: 'other' }),
              (repo: PrismaRepository) =>
                repo.insert({ id: 'seed-a', value: 'duplicate' }),
            ]) {
              await assert.rejects(() =>
                run(async (c) => {
                  const orders = c.model('orders');
                  await orders.insert({ id: 'rollback', value: 'bad' });
                  await invalid(orders).catch(() => {});
                }),
              );
              assert.equal(await db.rawCount('rollback'), 0);
            }
          },
        );
        await t.test(
          'parallel operations serialize and escaped repositories cannot run after callback',
          async () => {
            let escaped!: PrismaRepository;
            await run(async (c) => {
              escaped = c.model('orders');
              const rows = await Promise.all(
                Array.from({ length: 8 }, () => escaped.find()),
              );
              assert.ok(rows.every((r) => r.length === 1));
            });
            await assert.rejects(() => escaped.find(), /outside/);
          },
        );
        await t.test(
          'work timeout rolls back prior writes and permits a fresh client scope',
          async () => {
            const timed = createPrismaAdapter({
              resolveResource: () => db.resource,
              models: prismaModels,
              operationTimeoutMs: 200,
            });
            let escaped!: PrismaRepository;
            await assert.rejects(
              () =>
                timed.run(prismaTenantA, route(), async (c) => {
                  escaped = c.model('orders');
                  await escaped.insert({ id: 'timeout', value: 'bad' });
                  await new Promise(() => {});
                }),
              PrismaTimeoutError,
            );
            await assert.rejects(() => escaped.find(), /outside/);
            assert.equal(await db.rawCount('timeout'), 0);
            await run((c) => c.model('orders').find());
          },
        );
        await t.test(
          'pending writes cannot commit and nested transactions are refused',
          async () => {
            await assert.rejects(
              () =>
                run(async (c) => {
                  void c
                    .model('orders')
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
          'unsafe database collations fail before callbacks',
          async () => {
            if (engine === 'postgresql') {
              await db.execute(
                "CREATE COLLATION tenantguard_unsafe(provider=icu,locale='und-u-ks-level2',deterministic=false)",
              );
              await db.execute(
                'ALTER TABLE orders ALTER COLUMN tenant_id TYPE text COLLATE tenantguard_unsafe',
              );
              try {
                await assert.rejects(
                  () => run(async () => assert.fail('unsafe callback')),
                  /deterministic/,
                );
              } finally {
                await db.execute(
                  'ALTER TABLE orders ALTER COLUMN tenant_id TYPE text COLLATE "C"',
                );
                await db.execute('DROP COLLATION tenantguard_unsafe');
              }
            } else {
              await db.execute(
                'ALTER TABLE orders MODIFY tenant_id VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL',
              );
              try {
                await assert.rejects(
                  () => run(async () => assert.fail('unsafe callback')),
                  /NO PAD/,
                );
              } finally {
                await db.execute(
                  `ALTER TABLE orders MODIFY tenant_id VARCHAR(256) CHARACTER SET utf8mb4 COLLATE ${engine === 'mysql' ? 'utf8mb4_0900_bin' : 'utf8mb4_nopad_bin'} NOT NULL`,
                );
              }
            }
          },
        );
        await t.test(
          'blocked native updates cannot commit earlier writes even when caught',
          async () => {
            await db.execute('BEGIN');
            await db.execute(
              "SELECT * FROM orders WHERE id='seed-a' FOR UPDATE",
            );
            try {
              await assert.rejects(() =>
                run(async (c) => {
                  const orders = c.model('orders');
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
            await run((c) => c.model('orders').find());
          },
        );
        await t.test(
          'Prisma native transaction expiry rolls back and disconnects the scope client',
          async () => {
            const timed = createPrismaAdapter({
              resolveResource: () => db.resource,
              models: prismaModels,
              transactionTimeoutMs: 100,
              operationTimeoutMs: 1000,
            });
            await assert.rejects(() =>
              timed.run(prismaTenantA, route(), async (c) => {
                const orders = c.model('orders');
                await orders.insert({ id: 'native-expiry', value: 'bad' });
                await new Promise((r) => setTimeout(r, 200));
                await orders.find().catch(() => {});
              }),
            );
            assert.equal(await db.rawCount('native-expiry'), 0);
            await run((c) => c.model('orders').find());
            for (let attempt = 0; ; attempt++) {
              if ((await db.connections()) === 0) break;
              if (attempt > 20)
                assert.fail('Prisma retained database connections');
              await new Promise((r) => setTimeout(r, 50));
            }
          },
        );
        await t.test(
          'closed resources reject new scopes before business callbacks',
          async () => {
            await db.resource.close();
            await assert.rejects(
              () => run(async () => assert.fail('callback invoked')),
              /outside|closed/,
            );
          },
        );
      } finally {
        await db.close();
      }
    },
  );
