import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMysqlAdapter,
  createMysqlPool,
} from '../packages/mysql/src/index.js';
import {
  createMariadbAdapter,
  createMariadbPool,
} from '../packages/mariadb/src/index.js';
import {
  createTenantRouter,
  type TenantRoute,
} from '../packages/core/src/index.js';
import {
  adapterConformanceCases,
  type AdapterConformanceFixture,
} from '../packages/testing/src/conformance.js';
import {
  ScopedSqlSafetyError,
  ScopedSqlTimeoutError,
  type ScopedSqlClient,
  type ScopedSqlRepository,
} from '../packages/scoped-sql/src/index.js';
import {
  mysqlFamilyFixture,
  familyTables,
  familyTenantA,
  familyTenantB,
} from './helpers/mysql-family.js';
interface Row {
  id: string;
  tenant_id: string;
  value: string;
}
for (const engine of ['mysql', 'mariadb'] as const)
  test(
    `${engine} scoped CRUD conformance and connection lifecycle`,
    { timeout: 180000 },
    async (t) => {
      const db = await mysqlFamilyFixture(engine);
      const pool = (engine === 'mysql' ? createMysqlPool : createMariadbPool)({
        connection: db.appConfig,
        max: 1,
      });
      const factory =
        engine === 'mysql' ? createMysqlAdapter : createMariadbAdapter;
      const adapter = factory({
        resolvePool: () => pool,
        tables: familyTables,
      });
      const route = (tenantId = familyTenantA.tenantId): TenantRoute => ({
        tenantId,
        source: 'orders',
        adapter: engine,
        resource: 'orders-main',
        revision: '1',
        status: 'active',
        mode: 'application-filter',
      });
      const run = <T>(work: (client: ScopedSqlClient) => Promise<T>) =>
        adapter.run(familyTenantA, route(), work);
      const inspect = async () => {
        const session = await pool.acquire();
        try {
          return (
            await session.execute(
              'SELECT CONNECTION_ID() AS id,@tenantguard_tenant AS tenant,@leak AS leak,@@session.autocommit AS autocommit',
            )
          ).rows[0]!;
        } finally {
          session.release();
        }
      };
      try {
        const cases = adapterConformanceCases({
          transactional: true,
          createFixture: async (): Promise<
            AdapterConformanceFixture<ScopedSqlClient>
          > => {
            await db.seed();
            return {
              adapter,
              tenantA: familyTenantA,
              tenantB: familyTenantB,
              seedA: {
                id: 'seed-a',
                tenantId: familyTenantA.tenantId,
                value: 'a',
              },
              seedB: {
                id: 'seed-b',
                tenantId: familyTenantB.tenantId,
                value: 'b',
              },
              route: (context) => route(context.tenantId),
              read: async (client, id) =>
                (
                  await client
                    .table<Row>('orders')
                    .find(id === undefined ? {} : { id })
                ).map((row) => ({
                  id: row.id,
                  tenantId: row.tenant_id,
                  value: row.value,
                })),
              insert: async (client, row) => {
                await client.table('orders').insert({
                  id: row.id,
                  tenant_id: row.tenantId,
                  value: row.value,
                });
              },
              update: (client, id, changes) =>
                client.table('orders').update(
                  { id },
                  {
                    ...(changes.tenantId === undefined
                      ? {}
                      : { tenant_id: changes.tenantId }),
                    ...(changes.value === undefined
                      ? {}
                      : { value: changes.value }),
                  },
                ),
              delete: (client, id) => client.table('orders').delete({ id }),
              close: async () => {},
            };
          },
        });
        for (const entry of cases) await t.test(entry.name, entry.run);
        await db.seed();
        await t.test(
          'strict router rejects application filtering; normal router preserves case-sensitive tenants',
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
            const router = createTenantRouter({
              sources: { orders: { adapter, mode: 'application-filter' } },
              registry: { resolve: async (context) => route(context.tenantId) },
            });
            for (const context of [familyTenantA, familyTenantB]) {
              const rows = await router.run(context, 'orders', (client) =>
                client.table<Row>('orders').find(),
              );
              assert.equal(rows.length, 1);
              assert.equal(rows[0]!.tenant_id, context.tenantId);
            }
          },
        );
        await t.test(
          'native SQL outside the facade is not database-enforced isolation',
          async () => {
            const session = await pool.acquire();
            try {
              assert.equal(
                (await session.execute('SELECT * FROM orders')).rows.length,
                2,
              );
            } finally {
              session.release(true);
            }
          },
        );
        await t.test(
          'injected SQL values and unknown fragments cannot widen CRUD access',
          async () => {
            assert.deepEqual(
              await run((client) =>
                client.table('orders').find({ id: "' OR 1=1 --" }),
              ),
              [],
            );
            await assert.rejects(() =>
              run((client) => client.table('orders').find({ $or: '1=1' })),
            );
            await assert.rejects(() =>
              run((client) =>
                client
                  .table('orders')
                  .find({ id: { toSqlString: () => '1=1' } as never }),
              ),
            );
            await assert.rejects(() =>
              run((client) =>
                client.table('orders').find(
                  {},
                  {
                    orderBy: {
                      column: 'id',
                      direction: 'asc;DROP TABLE orders' as never,
                    },
                  },
                ),
              ),
            );
            assert.equal(
              (await run((client) => client.table('orders').find())).length,
              1,
            );
          },
        );
        await t.test(
          'tenant insertion is automatic and immutable even when validation errors are swallowed',
          async () => {
            await run((client) =>
              client.table('orders').insert({ id: 'implicit', value: 'own' }),
            );
            const rows = await run((client) =>
              client.table<Row>('orders').find({ id: 'implicit' }),
            );
            assert.equal(rows[0]!.tenant_id, familyTenantA.tenantId);
            await assert.rejects(
              () =>
                run(async (client) => {
                  const orders = client.table('orders');
                  await orders.insert({
                    id: 'rollback-validation',
                    value: 'own',
                  });
                  await orders
                    .update(
                      { id: 'implicit' },
                      { tenant_id: familyTenantB.tenantId },
                    )
                    .catch(() => {});
                }),
              /immutable/,
            );
            assert.deepEqual(
              await run((client) =>
                client.table('orders').find({ id: 'rollback-validation' }),
              ),
              [],
            );
          },
        );
        await t.test(
          'full resets clear user variables, temporary tables and advisory locks before reuse',
          async () => {
            await db.admin.query(
              "GRANT CREATE TEMPORARY TABLES ON tenantguard.* TO 'tenantguard_app'@'%'",
            );
            const stale = await pool.acquire();
            stale.release(true);
            try {
              const before = await inspect();
              const session = await pool.acquire();
              try {
                await session.execute('SET @leak=123');
                await session.execute(
                  'CREATE TEMPORARY TABLE leaked_temp(id INT)',
                );
                await session.execute(
                  "SELECT GET_LOCK('tenantguard_cleanup',0)",
                );
              } finally {
                session.release();
              }
              await run((client) => client.table('orders').find());
              const after = await inspect();
              assert.equal(after.id, before.id);
              assert.equal(after.tenant, null);
              assert.equal(after.leak, null);
              assert.equal(Number(after.autocommit), 1);
              const clean = await pool.acquire();
              try {
                await clean.execute(
                  'CREATE TEMPORARY TABLE leaked_temp(id INT)',
                );
                await clean.execute('DROP TEMPORARY TABLE leaked_temp');
                assert.equal(
                  Number(
                    (
                      await clean.execute(
                        "SELECT IS_FREE_LOCK('tenantguard_cleanup') AS free",
                      )
                    ).rows[0]!.free,
                  ),
                  1,
                );
              } finally {
                clean.release();
              }
            } finally {
              await db.admin.query(
                "REVOKE CREATE TEMPORARY TABLES ON tenantguard.* FROM 'tenantguard_app'@'%'",
              );
              const stale = await pool.acquire();
              stale.release(true);
            }
          },
        );
        await t.test(
          'dirty tenant sentinels are rejected before business work',
          async () => {
            const session = await pool.acquire();
            await session.execute('SET @tenantguard_tenant=?', ['other']);
            session.release();
            await assert.rejects(
              () => run(async () => assert.fail('must not run')),
              ScopedSqlSafetyError,
            );
            assert.equal((await inspect()).tenant, null);
          },
        );
        await t.test(
          'request deadlines destroy blocked sessions and roll back prior writes',
          async () => {
            const timed = factory({
              resolvePool: () => pool,
              tables: familyTables,
              requestTimeoutMs: 100,
              operationTimeoutMs: 5000,
            });
            await db.admin.beginTransaction();
            try {
              await db.admin.execute(
                'SELECT id FROM orders WHERE id=? FOR UPDATE',
                ['seed-a'],
              );
              await assert.rejects(
                () =>
                  timed.run(familyTenantA, route(), async (client) => {
                    const orders = client.table('orders');
                    await orders.insert({ id: 'timeout-prior', value: 'bad' });
                    await orders.update({ id: 'seed-a' }, { value: 'blocked' });
                  }),
                ScopedSqlTimeoutError,
              );
            } finally {
              await db.admin.rollback();
            }
            assert.deepEqual(
              await run((client) =>
                client.table('orders').find({ id: 'timeout-prior' }),
              ),
              [],
            );
            assert.equal((await inspect()).tenant, null);
          },
        );
        await t.test(
          'lock wait failures cannot commit earlier writes even if caught',
          async () => {
            const timed = factory({
              resolvePool: () => pool,
              tables: familyTables,
              lockTimeoutMs: 1000,
              requestTimeoutMs: 5000,
              operationTimeoutMs: 10000,
            });
            await db.admin.beginTransaction();
            try {
              await db.admin.execute(
                'SELECT id FROM orders WHERE id=? FOR UPDATE',
                ['seed-a'],
              );
              await assert.rejects(
                () =>
                  timed.run(familyTenantA, route(), async (client) => {
                    const orders = client.table('orders');
                    await orders.insert({ id: 'lock-prior', value: 'bad' });
                    await orders
                      .update({ id: 'seed-a' }, { value: 'blocked' })
                      .catch(() => {});
                  }),
                /lock wait timeout/i,
              );
            } finally {
              await db.admin.rollback();
            }
            assert.deepEqual(
              await run((client) =>
                client.table('orders').find({ id: 'lock-prior' }),
              ),
              [],
            );
          },
        );
        await t.test(
          'operation timeout revokes escaped repositories',
          async () => {
            const timed = factory({
              resolvePool: () => pool,
              tables: familyTables,
              operationTimeoutMs: 500,
            });
            let escaped: ScopedSqlRepository | undefined;
            await assert.rejects(
              () =>
                timed.run(familyTenantA, route(), async (client) => {
                  escaped = client.table('orders');
                  await new Promise(() => {});
                }),
              ScopedSqlTimeoutError,
            );
            await assert.rejects(() => escaped!.find(), /outside/);
            assert.equal((await inspect()).tenant, null);
          },
        );
        await t.test(
          'nontransactional tables fail closed before callbacks',
          async () => {
            await db.admin.query('ALTER TABLE orders ENGINE=MyISAM');
            try {
              await assert.rejects(
                () => run(async () => assert.fail('must not run')),
                /InnoDB/,
              );
            } finally {
              await db.admin.query('ALTER TABLE orders ENGINE=InnoDB');
            }
          },
        );
        await t.test(
          'parallel facade operations serialize without losing tenant predicates',
          async () => {
            const results = await run((client) =>
              Promise.all(
                Array.from({ length: 8 }, () =>
                  client.table<Row>('orders').find(),
                ),
              ),
            );
            assert.ok(
              results.every((rows) =>
                rows.every((row) => row.tenant_id === familyTenantA.tenantId),
              ),
            );
          },
        );
        await t.test(
          'accent and padding aliases cannot cross tenant boundaries',
          async () => {
            for (const [tenantId, id] of [
              ['Café', 'accent-a'],
              ['Cafe', 'accent-b'],
            ] as const) {
              await adapter.run({ tenantId }, route(tenantId), (client) =>
                client.table('orders').insert({ id, value: id }),
              );
              const rows = await adapter.run(
                { tenantId },
                route(tenantId),
                (client) => client.table<Row>('orders').find(),
              );
              assert.equal(rows.length, 1);
              assert.equal(rows[0]!.tenant_id, tenantId);
            }
            await db.admin.execute('INSERT INTO orders VALUES(?,?,?)', [
              'padded',
              'Org_A ',
              'bad',
            ]);
            assert.deepEqual(
              await run((client) =>
                client.table('orders').find({ id: 'padded' }),
              ),
              [],
            );
          },
        );
        await t.test(
          'killed connections do not leak scope state or reenter the pool',
          async () => {
            const before = await inspect();
            await assert.rejects(() =>
              run(async (client) => {
                await db.admin.query(`KILL CONNECTION ${Number(before.id)}`);
                await client.table('orders').find();
              }),
            );
            assert.equal((await inspect()).tenant, null);
          },
        );
      } finally {
        await pool.close();
        await db.close();
      }
    },
  );
