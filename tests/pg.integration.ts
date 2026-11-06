import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {
  createPgAdapter,
  PgCleanupError,
  PgSafetyError,
  PgTimeoutError,
  type PgTenantClient,
} from '../packages/postgres/src/pg.js';
import {
  createTenantRouter,
  type TenantRoute,
} from '../packages/core/src/index.js';
import { postgresFixture, tenantA, tenantB } from './helpers/postgres.js';
const tables = [{ schema: 'public', table: 'orders' }];
const route = (tenantId = tenantA.tenantId): TenantRoute => ({
  tenantId,
  adapter: 'pg',
  source: 'orders',
  resource: 'orders-pool',
  revision: '1',
  status: 'active',
  mode: 'database-policy',
});
test(
  'direct pg connection lifecycle against PostgreSQL',
  { timeout: 120000 },
  async (t) => {
    const database = await postgresFixture();
    const pool = new pg.Pool({ ...database.config, max: 1 });
    const idleErrors: Error[] = [];
    pool.on('error', (error) => idleErrors.push(error));
    const adapter = createPgAdapter({ resolvePool: () => pool, tables });
    const run = <T>(work: (client: PgTenantClient) => Promise<T>) =>
      adapter.run(tenantA, route(), work);
    const pid = async () =>
      (await pool.query('SELECT pg_backend_pid() AS pid')).rows[0]!
        .pid as number;
    try {
      await database.admin.query(
        'INSERT INTO public.orders VALUES ($1,$2,$3),($4,$5,$6)',
        ['a', tenantA.tenantId, 'a', 'b', tenantB.tenantId, 'b'],
      );
      await t.test(
        'router pins a reusable connection and leaves no unscoped tenant visibility',
        async () => {
          const router = createTenantRouter({
            strict: true,
            sources: { orders: { adapter, mode: 'database-policy' } },
            registry: { resolve: async (context) => route(context.tenantId) },
          });
          const initial = await pid();
          for (const context of [tenantA, tenantB, tenantA]) {
            const rows = await router.run(
              context,
              'orders',
              async (client) =>
                (await client.query('SELECT * FROM public.orders')).rows,
            );
            assert.equal(rows.length, 1);
            assert.equal(rows[0]!.tenant_id, context.tenantId);
            assert.equal(await pid(), initial);
            assert.deepEqual(
              (await pool.query('SELECT * FROM public.orders')).rows,
              [],
            );
          }
        },
      );
      await t.test(
        'preexisting session-level tenant settings cause connection destruction',
        async () => {
          const initial = await pid();
          await pool.query("SELECT set_config('app.tenant_id',$1,false)", [
            tenantB.tenantId,
          ]);
          await assert.rejects(
            () => run(async () => assert.fail('must not run')),
            PgSafetyError,
          );
          assert.notEqual(await pid(), initial);
          assert.deepEqual(
            (await pool.query('SELECT * FROM public.orders')).rows,
            [],
          );
        },
      );
      await t.test(
        'unfinished transactions are rolled back before a tenant scope starts',
        async () => {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            await client.query("SELECT set_config('app.tenant_id',$1,true)", [
              tenantB.tenantId,
            ]);
            await client.query('INSERT INTO public.orders VALUES ($1,$2,$3)', [
              'unfinished',
              tenantB.tenantId,
              'bad',
            ]);
          } finally {
            client.release();
          }
          await run(async (client) => {
            assert.equal(
              (await client.query('SELECT * FROM public.orders')).rows[0]!
                .tenant_id,
              tenantA.tenantId,
            );
          });
          assert.equal(
            (
              await database.admin.query(
                "SELECT count(*)::int AS count FROM public.orders WHERE id='unfinished'",
              )
            ).rows[0]!.count,
            0,
          );
        },
      );
      await t.test(
        'swallowed SQL errors cannot commit earlier writes',
        async () => {
          await assert.rejects(
            () =>
              run(async (client) => {
                await client.query(
                  'INSERT INTO public.orders VALUES ($1,$2,$3)',
                  ['swallowed', tenantA.tenantId, 'bad'],
                );
                await client
                  .query('SELECT missing_column FROM public.orders')
                  .catch(() => {});
              }),
            /missing_column/,
          );
          assert.equal(
            (
              await database.admin.query(
                "SELECT count(*)::int AS count FROM public.orders WHERE id='swallowed'",
              )
            ).rows[0]!.count,
            0,
          );
          await run(async (client) => {
            await client.query('SELECT 1');
          });
        },
      );
      await t.test(
        'multi-statement SQL is rejected by the extended protocol',
        async () => {
          await assert.rejects(
            () => run((client) => client.query('SELECT 1; COMMIT')),
            /multiple commands/,
          );
          await run(async (client) => {
            await client.query('SELECT 1');
          });
        },
      );
      await t.test(
        'server-side statement timeouts roll back and permit safe pool reuse',
        async () => {
          const timed = createPgAdapter({
            resolvePool: () => pool,
            tables,
            statementTimeoutMs: 25,
          });
          const initial = await pid();
          await assert.rejects(
            () =>
              timed.run(tenantA, route(), (client) =>
                client.query('SELECT pg_sleep(0.2)'),
              ),
            /statement timeout/,
          );
          assert.equal(await pid(), initial);
          await run(async (client) => {
            await client.query('SELECT 1');
          });
        },
      );
      await t.test('lock timeouts roll back blocked work', async () => {
        const timed = createPgAdapter({
          resolvePool: () => pool,
          tables,
          lockTimeoutMs: 25,
        });
        await database.admin.query('BEGIN');
        try {
          await database.admin.query(
            'LOCK TABLE public.orders IN ACCESS EXCLUSIVE MODE',
          );
          await assert.rejects(
            () =>
              timed.run(tenantA, route(), (client) =>
                client.query('SELECT * FROM public.orders'),
              ),
            /lock timeout/,
          );
        } finally {
          await database.admin.query('ROLLBACK');
        }
      });
      await t.test(
        'operation deadlines discard the session and revoke the scoped client',
        async () => {
          const timed = createPgAdapter({
            resolvePool: () => pool,
            tables,
            operationTimeoutMs: 60,
          });
          const initial = await pid();
          let escaped: PgTenantClient | undefined;
          await assert.rejects(
            () =>
              timed.run(tenantA, route(), async (client) => {
                escaped = client;
                await new Promise(() => {});
              }),
            (error) =>
              error instanceof PgTimeoutError ||
              /idle-in-transaction/.test(String(error)),
          );
          await assert.rejects(() => escaped!.query('SELECT 1'), /outside/);
          assert.notEqual(await pid(), initial);
        },
      );
      await t.test(
        'unawaited queries never commit and their session is discarded',
        async () => {
          const initial = await pid();
          await assert.rejects(
            () =>
              run(async (client) => {
                void client.query('SELECT pg_sleep(0.03)');
              }),
            /unawaited queries/,
          );
          assert.notEqual(await pid(), initial);
        },
      );
      await t.test(
        'inherited BYPASSRLS roles are rejected before application work',
        async () => {
          await database.admin.query(
            'CREATE ROLE unsafe BYPASSRLS; GRANT unsafe TO app',
          );
          try {
            await assert.rejects(
              () => run(async () => assert.fail('must not run')),
              /bypass privileges/,
            );
          } finally {
            await database.admin.query(
              'REVOKE unsafe FROM app; DROP ROLE unsafe',
            );
          }
        },
      );
      await t.test(
        'table ownership and disabled FORCE RLS fail closed',
        async () => {
          await database.admin.query(
            'ALTER TABLE public.orders NO FORCE ROW LEVEL SECURITY',
          );
          try {
            await assert.rejects(
              () => run(async () => assert.fail('must not run')),
              PgSafetyError,
            );
          } finally {
            await database.admin.query(
              'ALTER TABLE public.orders FORCE ROW LEVEL SECURITY',
            );
          }
          await database.admin.query(
            'CREATE TABLE public.owned (id text, tenant_id uuid NOT NULL); ALTER TABLE public.owned OWNER TO app',
          );
          const owned = createPgAdapter({
            resolvePool: () => pool,
            tables: [{ schema: 'public', table: 'owned' }],
          });
          try {
            await assert.rejects(
              () =>
                owned.run(tenantA, route(), async () =>
                  assert.fail('must not run'),
                ),
              PgSafetyError,
            );
          } finally {
            await database.admin.query('DROP TABLE public.owned');
          }
        },
      );
      await t.test(
        'post-commit tenant contamination reports committed state and destroys the session',
        async () => {
          const initial = await pid();
          await assert.rejects(
            () =>
              run(async (client) => {
                await client.query(
                  'INSERT INTO public.orders VALUES ($1,$2,$3)',
                  ['committed', tenantA.tenantId, 'ok'],
                );
                await client.query(
                  "SELECT set_config('app.tenant_id',$1,false)",
                  [tenantA.tenantId],
                );
              }),
            (error) =>
              error instanceof PgCleanupError &&
              error.commitOutcome === 'committed',
          );
          assert.equal(
            (
              await database.admin.query(
                "SELECT count(*)::int AS count FROM public.orders WHERE id='committed'",
              )
            ).rows[0]!.count,
            1,
          );
          assert.notEqual(await pid(), initial);
        },
      );
      await t.test(
        'backend termination is handled without returning the broken client',
        async () => {
          const initial = await pid();
          await assert.rejects(() =>
            run(async (client) => {
              const current = (
                await client.query('SELECT pg_backend_pid() AS pid')
              ).rows[0]!.pid;
              await database.admin.query('SELECT pg_terminate_backend($1)', [
                current,
              ]);
              await client.query('SELECT 1');
            }),
          );
          assert.notEqual(await pid(), initial);
        },
      );
      assert.deepEqual(idleErrors, []);
    } finally {
      await pool.end();
      await database.close();
    }
  },
);
