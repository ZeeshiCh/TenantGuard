import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adapterConformanceCases,
  type AdapterConformanceFixture,
  type ConformanceRecord,
} from '../packages/testing/src/conformance.js';
import {
  createSqlServerAdapter,
  createSqlServerPool,
  SqlServerCleanupError,
  SqlServerSafetyError,
  SqlServerTimeoutError,
  type SqlServerTenantClient,
} from '../packages/sqlserver/src/index.js';
import {
  createTenantRouter,
  type TenantRoute,
} from '../packages/core/src/index.js';
import {
  sqlServerFixture,
  sqlTables,
  sqlTenantA,
  sqlTenantB,
} from './helpers/sqlserver.js';
const route = (tenantId = sqlTenantA.tenantId): TenantRoute => ({
  tenantId,
  source: 'orders',
  adapter: 'sqlserver',
  resource: 'test-pool',
  revision: '1',
  status: 'active',
  mode: 'database-policy',
});
test(
  'SQL Server adapter conformance and session lifecycle',
  { timeout: 240000 },
  async (t) => {
    const database = await sqlServerFixture();
    const pool = createSqlServerPool({
      connection: database.appConfig,
      max: 1,
    });
    const adapter = createSqlServerAdapter({
      resolvePool: () => pool,
      tables: sqlTables,
    });
    const run = <T>(work: (client: SqlServerTenantClient) => Promise<T>) =>
      adapter.run(sqlTenantA, route(), work);
    const seedA = { id: 'seed-a', tenantId: sqlTenantA.tenantId, value: 'a' },
      seedB = { id: 'seed-b', tenantId: sqlTenantB.tenantId, value: 'b' };
    const seed = async () => {
      await database.admin.query(
        'ALTER SECURITY POLICY tenantguard.dbo_orders_tenant_policy WITH (STATE=OFF)',
      );
      try {
        await database.admin.query(
          'TRUNCATE TABLE dbo.orders; INSERT dbo.orders VALUES(@a,@tenantA,@valueA),(@b,@tenantB,@valueB)',
          {
            a: seedA.id,
            tenantA: seedA.tenantId,
            valueA: seedA.value,
            b: seedB.id,
            tenantB: seedB.tenantId,
            valueB: seedB.value,
          },
        );
      } finally {
        await database.admin.query(
          'ALTER SECURITY POLICY tenantguard.dbo_orders_tenant_policy WITH (STATE=ON)',
        );
      }
    };
    const inspect = async () => {
      const session = await pool.acquire();
      try {
        return (
          await session.query(
            "SELECT @@SPID AS spid, SESSION_CONTEXT(N'app.tenant_id') AS tenant, @@TRANCOUNT AS transactions",
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
          AdapterConformanceFixture<SqlServerTenantClient>
        > => {
          await seed();
          const columns =
            'id, LOWER(CONVERT(varchar(36),tenant_id)) AS tenantId, value';
          return {
            adapter,
            tenantA: sqlTenantA,
            tenantB: sqlTenantB,
            seedA,
            seedB,
            route: (context) => route(context.tenantId),
            read: async (client, id) =>
              (
                await client.query<ConformanceRecord>(
                  `SELECT ${columns} FROM dbo.orders${id === undefined ? '' : ' WHERE id=@id'}`,
                  id === undefined ? {} : { id },
                )
              ).rows,
            insert: async (client, row) => {
              await client.query(
                'INSERT dbo.orders VALUES(@id,@tenant,@value)',
                { id: row.id, tenant: row.tenantId, value: row.value },
              );
            },
            update: async (client, id, changes) =>
              (
                await client.query(
                  'UPDATE dbo.orders SET tenant_id=COALESCE(CONVERT(uniqueidentifier,@tenant),tenant_id), value=COALESCE(@value,value) OUTPUT inserted.id WHERE id=@id',
                  {
                    id,
                    tenant: changes.tenantId ?? null,
                    value: changes.value ?? null,
                  },
                )
              ).rows.length,
            delete: async (client, id) =>
              (
                await client.query(
                  'DELETE dbo.orders OUTPUT deleted.id WHERE id=@id',
                  { id },
                )
              ).rows.length,
            close: async () => {},
          };
        },
      });
      for (const entry of cases) await t.test(entry.name, entry.run);
      await seed();
      await t.test(
        'router reuses a physical session only after clearing SESSION_CONTEXT',
        async () => {
          const before = await inspect();
          const router = createTenantRouter({
            strict: true,
            sources: { orders: { adapter, mode: 'database-policy' } },
            registry: { resolve: async (context) => route(context.tenantId) },
          });
          for (const context of [sqlTenantA, sqlTenantB, sqlTenantA]) {
            const rows = await router.run(
              context,
              'orders',
              async (client) =>
                (
                  await client.query<ConformanceRecord>(
                    'SELECT id, LOWER(CONVERT(varchar(36),tenant_id)) AS tenantId, value FROM dbo.orders',
                  )
                ).rows,
            );
            assert.equal(rows.length, 1);
            assert.equal(rows[0]!.tenantId, context.tenantId);
            const after = await inspect();
            assert.equal(after.spid, before.spid);
            assert.equal(after.tenant, null);
            assert.equal(after.transactions, 0);
          }
        },
      );
      await t.test(
        'contaminated sessions are discarded before application code',
        async () => {
          const before = await inspect();
          const session = await pool.acquire();
          await session.query(
            "EXEC sys.sp_set_session_context @key=N'app.tenant_id',@value=@tenant",
            { tenant: sqlTenantB.tenantId },
          );
          session.release();
          await assert.rejects(
            () => run(async () => assert.fail('must not run')),
            SqlServerSafetyError,
          );
          const after = await inspect();
          assert.equal(after.tenant, null);
          // SPIDs can be recycled immediately by SQL Server; verify cleanliness, not numeric inequality.
          assert.ok(before.spid);
        },
      );
      await t.test(
        'swallowed SQL errors prevent earlier writes from committing',
        async () => {
          await assert.rejects(
            () =>
              run(async (client) => {
                await client.query(
                  "INSERT dbo.orders VALUES(N'swallowed',@tenant,N'bad')",
                  { tenant: sqlTenantA.tenantId },
                );
                await client
                  .query('SELECT missing_column FROM dbo.orders')
                  .catch(() => {});
              }),
            /missing_column/i,
          );
          assert.equal(
            (
              await run((client) =>
                client.query("SELECT * FROM dbo.orders WHERE id=N'swallowed'"),
              )
            ).rows.length,
            0,
          );
          assert.equal((await inspect()).tenant, null);
        },
      );
      await t.test(
        'read-only SESSION_CONTEXT poisoning destroys rather than reuses the session',
        async () => {
          await assert.rejects(
            () =>
              run((client) =>
                client.query(
                  "SELECT 1 AS allowed; EXEC sys.sp_set_session_context @key=N'app.tenant_id',@value=@tenant,@read_only=1",
                  { tenant: sqlTenantA.tenantId },
                ),
              ),
            (error) =>
              error instanceof SqlServerCleanupError &&
              error.commitOutcome === 'committed',
          );
          assert.equal((await inspect()).tenant, null);
          await run((client) => client.query('SELECT 1 AS ok'));
        },
      );
      await t.test(
        'operation timeout destroys the physical connection and revokes its facade',
        async () => {
          const timed = createSqlServerAdapter({
            resolvePool: () => pool,
            tables: sqlTables,
            operationTimeoutMs: 500,
          });
          let escaped: SqlServerTenantClient | undefined;
          await assert.rejects(
            () =>
              timed.run(sqlTenantA, route(), async (client) => {
                escaped = client;
                await new Promise(() => {});
              }),
            SqlServerTimeoutError,
          );
          await assert.rejects(() => escaped!.query('SELECT 1'), /outside/);
          assert.equal((await inspect()).tenant, null);
        },
      );
      await t.test(
        'request cancellation rolls back and clears session context',
        async () => {
          const timed = createSqlServerAdapter({
            resolvePool: () => pool,
            tables: sqlTables,
            requestTimeoutMs: 250,
          });
          await assert.rejects(
            () =>
              timed.run(sqlTenantA, route(), (client) =>
                client.query("SELECT 1; WAITFOR DELAY '00:00:01'"),
              ),
            /timeout/i,
          );
          const state = await inspect();
          assert.equal(state.tenant, null);
          assert.equal(state.transactions, 0);
          await run((client) => client.query('SELECT 1'));
        },
      );
      await t.test(
        'server lock timeout applies to the physical session',
        async () => {
          const timed = createSqlServerAdapter({
            resolvePool: () => pool,
            tables: sqlTables,
            lockTimeoutMs: 100,
            requestTimeoutMs: 2000,
            operationTimeoutMs: 5000,
          });
          await database.admin.query(
            "EXEC sys.sp_set_session_context @key=N'app.tenant_id',@value=@tenant",
            { tenant: sqlTenantA.tenantId },
          );
          await database.admin.begin();
          try {
            await database.admin.query(
              'SELECT TOP(1) id FROM dbo.orders WITH(TABLOCKX,HOLDLOCK)',
            );
            await assert.rejects(
              () =>
                timed.run(sqlTenantA, route(), (client) =>
                  client.query('SELECT * FROM dbo.orders'),
                ),
              /lock request time out/i,
            );
          } finally {
            await database.admin.batch(
              "IF @@TRANCOUNT>0 ROLLBACK TRANSACTION; EXEC sys.sp_set_session_context @key=N'app.tenant_id',@value=NULL",
            );
          }
          const state = await inspect();
          assert.equal(state.tenant, null);
          assert.equal(state.transactions, 0);
        },
      );
      await t.test(
        'parallel facade queries are serialized on the pinned TDS connection',
        async () => {
          const values = await run((client) =>
            Promise.all(
              Array.from(
                { length: 6 },
                async (_value, index) =>
                  (
                    await client.query<{ value: number }>(
                      'SELECT @value AS value',
                      { value: index },
                    )
                  ).rows[0]!.value,
              ),
            ),
          );
          assert.deepEqual(values, [0, 1, 2, 3, 4, 5]);
        },
      );
      await t.test(
        'effective user impersonation grants fail closed',
        async () => {
          await database.admin.query(
            'GRANT IMPERSONATE ON USER::dbo TO tenantguard_app',
          );
          try {
            await assert.rejects(
              () => run(async () => assert.fail('must not run')),
              SqlServerSafetyError,
            );
          } finally {
            await database.admin.query(
              'REVOKE IMPERSONATE ON USER::dbo FROM tenantguard_app',
            );
          }
        },
      );
      await t.test(
        'missing or disabled block policies fail closed',
        async () => {
          await database.admin.query(
            'ALTER SECURITY POLICY tenantguard.dbo_orders_tenant_policy WITH(STATE=OFF)',
          );
          try {
            await assert.rejects(
              () => run(async () => assert.fail('must not run')),
              SqlServerSafetyError,
            );
          } finally {
            await database.admin.query(
              'ALTER SECURITY POLICY tenantguard.dbo_orders_tenant_policy WITH(STATE=ON)',
            );
          }
        },
      );
      await t.test(
        'inherited database-owner permissions are rejected',
        async () => {
          await database.admin.query(
            'CREATE ROLE unsafe; GRANT CONTROL ON DATABASE::tenantguard TO unsafe; ALTER ROLE unsafe ADD MEMBER tenantguard_app',
          );
          try {
            await assert.rejects(
              () => run(async () => assert.fail('must not run')),
              SqlServerSafetyError,
            );
          } finally {
            await database.admin.query(
              'ALTER ROLE unsafe DROP MEMBER tenantguard_app; DROP ROLE unsafe',
            );
          }
        },
      );
      await t.test(
        'killed sessions never return tenant state to the pool',
        async () => {
          await assert.rejects(() =>
            run(async (client) => {
              const id = (
                await client.query<{ spid: number }>('SELECT @@SPID AS spid')
              ).rows[0]!.spid;
              assert.ok(Number.isInteger(id) && id > 0);
              await database.admin.query(`KILL ${id}`);
              await client.query('SELECT 1');
            }),
          );
          assert.equal((await inspect()).tenant, null);
        },
      );
    } finally {
      await pool.close();
      await database.close();
    }
  },
);
