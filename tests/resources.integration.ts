import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import {
  createTenantRouter,
  type TenantRoute,
} from '../packages/core/src/index.js';
import { createCachedTenantRegistry } from '../packages/registry/src/index.js';
import {
  createTenantResourcePool,
  createPooledAdapter,
  ResourcePoolRouteError,
  ResourcePoolClosedError,
  ResourcePoolTimeoutError,
} from '../packages/resources/src/index.js';
import {
  createPgAdapter,
  type PgTenantClient,
} from '../packages/postgres/src/pg.js';
import { postgresFixture, tenantA, tenantB } from './helpers/postgres.js';
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function until(check: () => boolean | Promise<boolean>) {
  const end = performance.now() + 5000;
  while (!(await check())) {
    if (performance.now() > end) assert.fail('native lifecycle did not settle');
    await delay(5);
  }
}
const route = (tenantId = tenantA.tenantId, revision = '1'): TenantRoute => ({
  tenantId,
  revision,
  source: 'orders',
  adapter: 'pg',
  resource: tenantId === tenantA.tenantId ? 'a' : 'b',
  secretRef: tenantId === tenantA.tenantId ? 'a-v' + revision : 'b-v1',
  status: 'active',
  mode: 'database-policy',
});
const capabilities = {
  transactions: true,
  isolationModes: ['database-policy'] as const,
};
const tables = [{ schema: 'public', table: 'orders' }];
test(
  'bounded tenant resources against PostgreSQL: concurrency, rotation and native drain',
  { timeout: 120_000 },
  async (t) => {
    const database = await postgresFixture();
    const credentials = new Map([
      ['a-v1', { user: 'tenant_a', password: 'a-first' }],
      ['a-v2', { user: 'tenant_a', password: 'a-rotated' }],
      ['b-v1', { user: 'tenant_b', password: 'b-first' }],
    ]);
    const live = new Set<pg.Pool>();
    const pids = new Map<pg.Pool, number>();
    let high = 0,
      created = 0;
    const idleErrors: unknown[] = [];
    const create = async (value: Readonly<TenantRoute>) => {
      const credential = credentials.get(value.secretRef ?? '');
      if (!credential) throw new Error('Unknown secret reference');
      const native = new pg.Pool({ ...database.config, ...credential, max: 1 });
      native.on('error', (error) => idleErrors.push(error));
      live.add(native);
      created++;
      high = Math.max(high, live.size);
      try {
        pids.set(
          native,
          Number(
            (await native.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid,
          ),
        );
        return native;
      } catch (error) {
        await native.end();
        live.delete(native);
        throw error;
      }
    };
    const destroy = async (native: pg.Pool) => {
      await native.end();
      live.delete(native);
    };
    const pool = createTenantResourcePool({
      create,
      destroy,
      maxResources: 3,
      maxResourcesPerTenant: 2,
      maxLeasesPerResource: 2,
      idleTimeoutMs: 60_000,
    });
    const routes = new Map([
      [tenantA.tenantId, route()],
      [tenantB.tenantId, route(tenantB.tenantId)],
    ]);
    const registry = createCachedTenantRegistry({
      registry: { resolve: async (context) => routes.get(context.tenantId) },
    });
    const adapter = createPooledAdapter({
      pool,
      name: 'pg',
      capabilities,
      createAdapter: (native) =>
        createPgAdapter({
          resolvePool: () => native,
          tables,
          operationTimeoutMs: 5000,
        }),
    });
    const router = createTenantRouter({
      strict: true,
      registry,
      sources: { orders: { adapter, mode: 'database-policy' } },
    });
    const read = (context = tenantA) =>
      router.run(
        context,
        'orders',
        async (client) =>
          (
            await client.query(
              'SELECT tenant_id AS "tenantId",value FROM orders ORDER BY id',
            )
          ).rows,
      );
    const gone = async (pid: number) =>
      Number(
        (
          await database.admin.query(
            'SELECT count(*) AS count FROM pg_stat_activity WHERE pid=$1',
            [pid],
          )
        ).rows[0]!.count,
      ) === 0;
    try {
      await database.admin.query(
        "CREATE ROLE tenant_a LOGIN PASSWORD 'a-first' NOSUPERUSER NOBYPASSRLS; CREATE ROLE tenant_b LOGIN PASSWORD 'b-first' NOSUPERUSER NOBYPASSRLS; GRANT app TO tenant_a,tenant_b;",
      );
      await database.admin.query(
        'INSERT INTO orders VALUES($1,$2,$3),($4,$5,$6)',
        ['a', tenantA.tenantId, 'a', 'b', tenantB.tenantId, 'b'],
      );
      pool.setRoute(route());
      pool.setRoute(route(tenantB.tenantId));
      await t.test(
        'concurrent tenants coalesce pools, retain RLS isolation and bound native connections',
        async () => {
          await Promise.all(
            Array.from({ length: 40 }, async (_, i) => {
              const context = i % 2 ? tenantB : tenantA;
              assert.deepEqual(await read(context), [
                { tenantId: context.tenantId, value: i % 2 ? 'b' : 'a' },
              ]);
              assert(pool.stats().resources <= 3);
              assert(pool.stats().activeLeases <= 4);
            }),
          );
          assert.equal(created, 2);
          assert.equal(high, 2);
          for (const native of live)
            assert.deepEqual(
              (await native.query('SELECT * FROM orders')).rows,
              [],
            );
        },
      );
      await t.test(
        'actual password rotation pins old transactions, blocks stale metadata and authenticates fresh pools',
        async () => {
          const acquired = signal(),
            release = signal();
          let oldPid = 0;
          const old = router.run(tenantA, 'orders', async (client) => {
            oldPid = Number(
              (await client.query('SELECT pg_backend_pid() AS pid')).rows[0]!
                .pid,
            );
            await client.query('INSERT INTO orders VALUES($1,$2,$3)', [
              'rotation',
              tenantA.tenantId,
              'pinned',
            ]);
            acquired.resolve();
            await release.promise;
            assert.equal(await gone(oldPid), false);
            return (
              await client.query('SELECT value FROM orders WHERE id=$1', [
                'rotation',
              ])
            ).rows;
          });
          await acquired.promise;
          try {
            await database.admin.query(
              "ALTER ROLE tenant_a PASSWORD 'a-rotated'",
            );
            const stale = new pg.Client({
              ...database.config,
              user: 'tenant_a',
              password: 'a-first',
            });
            try {
              await assert.rejects(
                stale.connect(),
                /password authentication failed/u,
              );
            } finally {
              await stale.end();
            }
            const fresh = route(tenantA.tenantId, '2');
            routes.set(tenantA.tenantId, fresh);
            pool.setRoute(fresh, '1');
            await assert.rejects(read(), ResourcePoolRouteError); // Registry still has revision 1.
            registry.invalidate({ tenantId: tenantA.tenantId });
            assert.deepEqual(await read(), [
              { tenantId: tenantA.tenantId, value: 'a' },
            ]);
            assert.equal(pool.stats().resources, 3);
            assert.equal(high, 3);
            assert.equal(await gone(oldPid), false);
          } finally {
            release.resolve();
          }
          assert.deepEqual(await old, [{ value: 'pinned' }]);
          await until(() => gone(oldPid));
          assert.equal((await read()).length, 2);
          assert.deepEqual(await read(tenantB), [
            { tenantId: tenantB.tenantId, value: 'b' },
          ]);
          assert.throws(
            () => pool.setRoute(route(), '1'),
            ResourcePoolRouteError,
          );
        },
      );
      await t.test(
        'callback failure rolls back before its resource is retired and recreated',
        async () => {
          let oldPid = 0;
          const failure = new Error('business failed');
          await assert.rejects(
            router.run(tenantA, 'orders', async (client) => {
              oldPid = Number(
                (await client.query('SELECT pg_backend_pid() AS pid')).rows[0]!
                  .pid,
              );
              await client.query('INSERT INTO orders VALUES($1,$2,$3)', [
                'rolled-back',
                tenantA.tenantId,
                'failed',
              ]);
              throw failure;
            }),
            (error) => error === failure,
          );
          await until(() => gone(oldPid));
          assert.equal(
            (await read()).some((row) => row.value === 'failed'),
            false,
          );
          assert.equal(await gone(oldPid), true);
          assert(high <= 3);
        },
      );
      await t.test(
        'automatic idle eviction really closes PostgreSQL sessions without another request',
        async () => {
          let nativePid = 0;
          const idle = createTenantResourcePool({
            create,
            destroy,
            idleTimeoutMs: 20,
            maxResources: 1,
          });
          idle.setRoute(route(tenantB.tenantId));
          try {
            await idle.run(route(tenantB.tenantId), async (native) => {
              nativePid = pids.get(native)!;
              assert.equal(await gone(nativePid), false);
            });
            await until(() => idle.stats().resources === 0);
            assert.equal(await gone(nativePid), true);
          } finally {
            await idle.close();
          }
        },
      );
      await t.test(
        'timed-out native factory remains counted and its late pool is closed before replacement',
        async () => {
          await database.admin.query('SELECT pg_advisory_lock(721455)');
          const started = signal();
          let first = true,
            unlocked = false,
            nativePid = 0;
          let localCreated = 0;
          const bounded = createTenantResourcePool({
            maxResources: 1,
            acquireTimeoutMs: 200,
            createTimeoutMs: 5000,
            create: async (value) => {
              localCreated++;
              const native = await create(value);
              if (first) {
                first = false;
                nativePid = pids.get(native)!;
                const query = native.query(
                  'SELECT pg_advisory_xact_lock(721455)',
                );
                started.resolve();
                await query;
              }
              return native;
            },
            destroy,
          });
          bounded.setRoute(route(tenantA.tenantId, '2'));
          bounded.setRoute(route(tenantB.tenantId));
          try {
            const request = assert.rejects(
              bounded.run(route(tenantA.tenantId, '2'), async () =>
                assert.fail('late factory work'),
              ),
              ResourcePoolTimeoutError,
            );
            await started.promise;
            await request;
            assert.equal(bounded.stats().resources, 1);
            assert.equal(bounded.stats().creating, 1);
            const replacement = bounded.run(
              route(tenantB.tenantId),
              async (native) =>
                Number((await native.query('SELECT 1 AS ok')).rows[0]!.ok),
            );
            await database.admin.query('SELECT pg_advisory_unlock(721455)');
            unlocked = true;
            assert.equal(await replacement, 1);
            assert.equal(localCreated, 2);
            assert.equal(await gone(nativePid), true);
          } finally {
            if (!unlocked)
              await database.admin.query('SELECT pg_advisory_unlock(721455)');
            await bounded.close();
          }
        },
      );
      await t.test(
        'shutdown deadline never kills a blocked native transaction and drains it after release',
        async () => {
          const blocked = signal();
          await database.admin.query('SELECT pg_advisory_lock(721456)');
          let unlocked = false,
            nativePid = 0,
            destroyCalls = 0;
          const shutting = createTenantResourcePool({
            create,
            destroy: async (native) => {
              destroyCalls++;
              await destroy(native);
            },
            shutdownTimeoutMs: 20,
            maxResources: 1,
            maxLeasesPerResource: 1,
          });
          shutting.setRoute(route(tenantA.tenantId, '2'));
          const managed = createPooledAdapter({
            pool: shutting,
            name: 'pg',
            capabilities,
            createAdapter: (native) =>
              createPgAdapter({
                resolvePool: () => native,
                tables,
                operationTimeoutMs: 5000,
              }),
          });
          let active: Promise<unknown> | undefined;
          try {
            active = managed.run(
              tenantA,
              route(tenantA.tenantId, '2'),
              async (client: PgTenantClient) => {
                nativePid = Number(
                  (await client.query('SELECT pg_backend_pid() AS pid'))
                    .rows[0]!.pid,
                );
                const query = client.query(
                  'SELECT pg_advisory_xact_lock(721456)',
                );
                blocked.resolve();
                await query;
                await client.query('INSERT INTO orders VALUES($1,$2,$3)', [
                  'shutdown',
                  tenantA.tenantId,
                  'drained',
                ]);
              },
            );
            await blocked.promise;
            const queued = assert.rejects(
              managed.run(tenantA, route(tenantA.tenantId, '2'), async () =>
                assert.fail('closed queued callback'),
              ),
              ResourcePoolClosedError,
            );
            const closing = shutting.close();
            await queued;
            await assert.rejects(
              closing,
              (error) =>
                error instanceof ResourcePoolTimeoutError &&
                error.phase === 'shutdown',
            );
            assert.equal(shutting.stats().activeLeases, 1);
            assert.equal(shutting.stats().resources, 1);
            assert.equal(destroyCalls, 0);
            assert.equal(await gone(nativePid), false);
            await database.admin.query('SELECT pg_advisory_unlock(721456)');
            unlocked = true;
            await active;
            await until(() => shutting.stats().resources === 0);
            assert.equal(destroyCalls, 1);
            assert.equal(await gone(nativePid), true);
            assert.equal(
              (await read()).some((row) => row.value === 'drained'),
              true,
            );
          } finally {
            if (!unlocked)
              await database.admin.query('SELECT pg_advisory_unlock(721456)');
            await active;
            await shutting.close().catch((error) => {
              if (!(error instanceof ResourcePoolTimeoutError)) throw error;
            });
          }
        },
      );
      await t.test(
        'native pool.end stalls retain capacity after cleanup and shutdown deadlines',
        async () => {
          let held: pg.PoolClient | undefined,
            nativePid = 0;
          const stalled = createTenantResourcePool({
            create: async (value) => {
              const native = await create(value);
              held = await native.connect();
              nativePid = pids.get(native)!;
              return native;
            },
            destroy,
            destroyTimeoutMs: 10,
            shutdownTimeoutMs: 20,
            maxResources: 1,
          });
          stalled.setRoute(route(tenantB.tenantId));
          try {
            await stalled.run(route(tenantB.tenantId), async () => {});
            stalled.remove({ tenantId: tenantB.tenantId });
            await until(() => stalled.stats().closed);
            await assert.rejects(stalled.close(), ResourcePoolTimeoutError);
            assert.equal(stalled.stats().disposing, 1);
            assert.equal(stalled.stats().resources, 1);
            assert.equal(await gone(nativePid), false);
            held!.release();
            held = undefined;
            await until(() => stalled.stats().resources === 0);
            assert.equal(await gone(nativePid), true);
          } finally {
            held?.release();
            await stalled.close().catch((error) => {
              if (!(error instanceof ResourcePoolTimeoutError)) throw error;
            });
          }
        },
      );
      assert.deepEqual(idleErrors, []);
    } finally {
      await registry.close();
      await pool.close();
      assert.equal(live.size, 0);
      await database.close();
    }
  },
);
