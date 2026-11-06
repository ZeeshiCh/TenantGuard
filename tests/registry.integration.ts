import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import express, { type ErrorRequestHandler, type Request } from 'express';
import pg from 'pg';
import {
  createTenantGuard,
  createTenantRouter,
  TenantRoutingError,
  type TenantRoute,
} from '../packages/core/src/index.js';
import {
  createCachedTenantRegistry,
  RegistryCacheClosedError,
  RegistryCacheCapacityError,
  RegistryCacheTimeoutError,
  RegistryCacheInvalidatedError,
} from '../packages/registry/src/index.js';
import { requireTenant } from '../packages/node/src/index.js';
import { tenantMiddleware } from '../packages/express/src/index.js';
import { createPgAdapter } from '../packages/postgres/src/pg.js';
import { postgresFixture, tenantA, tenantB } from './helpers/postgres.js';
import { listen, close } from './http-conformance.js';
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
test(
  'registry cache integrates real HTTP, PostgreSQL routing and lifecycle changes',
  { timeout: 120_000 },
  async (t) => {
    const database = await postgresFixture();
    const oldPool = new pg.Pool({ ...database.config, max: 2 });
    const newPool = new pg.Pool({ ...database.config, max: 2 });
    const control = new pg.Pool({
      ...database.config,
      user: 'registry_reader',
      password: 'registry-test',
      max: 3,
    });
    let time = 0,
      lookups = 0;
    let stall: ReturnType<typeof signal> | undefined;
    const registry = createCachedTenantRegistry({
      ttlMs: 100,
      clock: () => time,
      registry: {
        resolve: async (context, source) => {
          lookups++;
          const result = await control.query<TenantRoute>(
            'SELECT tenant_id AS "tenantId", source, adapter, resource, secret_ref AS "secretRef", revision, status, mode FROM tenant_routes WHERE tenant_id=$1 AND source=$2',
            [context.tenantId, source],
          );
          const waiting = stall;
          if (waiting) {
            waiting.resolve();
            await control.query('SELECT pg_sleep(0.15)');
          }
          return result.rows[0];
        },
      },
    });
    const selections: TenantRoute[] = [];
    const adapter = createPgAdapter({
      resolvePool: (route) => {
        selections.push(route);
        if (route.resource === 'old' && route.secretRef === 'secret-v1')
          return oldPool;
        if (route.resource === 'new' && route.secretRef === 'secret-v2')
          return newPool;
        throw new Error('unknown resource or secret revision');
      },
      tables: [{ schema: 'public', table: 'orders' }],
    });
    const router = createTenantRouter({
      strict: true,
      registry,
      sources: { orders: { adapter, mode: 'database-policy' } },
    });
    const app = express();
    app.use(
      tenantMiddleware(
        createTenantGuard<Request>({
          authorize: (request) => {
            const token = request.headers.authorization;
            return token === 'alice'
              ? { ...tenantA, principalId: 'alice' }
              : token === 'bob'
                ? { ...tenantB, principalId: 'bob' }
                : undefined;
          },
        }),
      ),
    );
    app.get('/orders', async (_request, response) => {
      const rows = await router.run(
        requireTenant(),
        'orders',
        async (client) =>
          (
            await client.query(
              'SELECT tenant_id AS "tenantId", value FROM orders',
            )
          ).rows,
      );
      response.json(rows);
    });
    const handler: ErrorRequestHandler = (error, _request, response, _next) => {
      response
        .status(error instanceof TenantRoutingError ? 503 : 500)
        .send('Route unavailable');
    };
    app.use(handler);
    const server = createServer(app);
    try {
      await database.admin.query(
        "CREATE ROLE registry_reader LOGIN PASSWORD 'registry-test' NOSUPERUSER NOBYPASSRLS; CREATE TABLE tenant_routes(tenant_id uuid NOT NULL, source text NOT NULL, adapter text NOT NULL, resource text NOT NULL, secret_ref text NOT NULL, revision text NOT NULL, status text NOT NULL, mode text NOT NULL, PRIMARY KEY(tenant_id,source)); GRANT USAGE ON SCHEMA public TO registry_reader; GRANT SELECT ON tenant_routes TO registry_reader;",
      );
      for (const [context, value] of [
        [tenantA, 'a'],
        [tenantB, 'b'],
      ] as const) {
        await database.admin.query('INSERT INTO orders VALUES($1,$2,$3)', [
          value,
          context.tenantId,
          value,
        ]);
        await database.admin.query(
          "INSERT INTO tenant_routes VALUES($1,'orders','pg','old','secret-v1','1','active','database-policy')",
          [context.tenantId],
        );
      }
      const url = await listen(server);
      const read = async (token: string) => {
        const response = await fetch(url + '/orders', {
          headers: { authorization: token },
        });
        return { status: response.status, body: await response.text() };
      };
      await t.test(
        'concurrent HTTP requests share registry loads without mixing database tenants',
        async () => {
          await Promise.all(
            Array.from({ length: 40 }, async (_, i) => {
              const alice = i % 2 === 0;
              const result = await read(alice ? 'alice' : 'bob');
              assert.equal(result.status, 200);
              assert.deepEqual(JSON.parse(result.body), [
                {
                  tenantId: alice ? tenantA.tenantId : tenantB.tenantId,
                  value: alice ? 'a' : 'b',
                },
              ]);
            }),
          );
          assert.equal(lookups, 2);
          assert.deepEqual(
            (await oldPool.query('SELECT * FROM orders')).rows,
            [],
          );
          await assert.rejects(
            oldPool.query('SELECT * FROM tenant_routes'),
            /permission denied/u,
          );
        },
      );
      await t.test(
        'resource/secret revision changes apply after invalidation without disrupting acquired work',
        async () => {
          const acquired = signal(),
            release = signal();
          const ongoing = router.run(
            { ...tenantA, principalId: 'alice' },
            'orders',
            async (client) => {
              acquired.resolve();
              await release.promise;
              return (await client.query('SELECT value FROM orders')).rows;
            },
          );
          await acquired.promise;
          try {
            await database.admin.query(
              "UPDATE tenant_routes SET resource='new',secret_ref='secret-v2',revision='2' WHERE tenant_id=$1",
              [tenantA.tenantId],
            );
            registry.invalidate({
              tenantId: tenantA.tenantId,
              source: 'orders',
            });
            assert.equal((await read('alice')).status, 200);
            assert.equal(selections.at(-1)!.revision, '2');
            assert.equal(selections.at(-1)!.secretRef, 'secret-v2');
          } finally {
            release.resolve();
          }
          assert.deepEqual(await ongoing, [{ value: 'a' }]);
          assert.equal((await read('bob')).status, 200);
          assert.equal(selections.at(-1)!.revision, '1');
        },
      );
      await t.test(
        'suspension, deletion and missing-route creation fail closed or refresh as specified',
        async () => {
          await database.admin.query(
            "UPDATE tenant_routes SET status='suspended' WHERE tenant_id=$1",
            [tenantA.tenantId],
          );
          registry.invalidate({ tenantId: tenantA.tenantId });
          const count = selections.length;
          assert.equal((await read('alice')).status, 503);
          assert.equal(selections.length, count);
          await database.admin.query(
            "UPDATE tenant_routes SET status='active' WHERE tenant_id=$1",
            [tenantA.tenantId],
          );
          assert.equal((await read('alice')).status, 503); // Suspended snapshot is cached until explicit invalidation/TTL.
          time = 100;
          assert.equal((await read('alice')).status, 200);
          await database.admin.query(
            'DELETE FROM tenant_routes WHERE tenant_id=$1',
            [tenantA.tenantId],
          );
          registry.invalidate({ tenantId: tenantA.tenantId });
          assert.equal((await read('alice')).status, 503);
          await database.admin.query(
            "INSERT INTO tenant_routes VALUES($1,'orders','pg','new','secret-v2','3','active','database-policy')",
            [tenantA.tenantId],
          );
          assert.equal((await read('alice')).status, 200); // No negative caching by default.
        },
      );
      await t.test(
        'late real database results cannot undo invalidation',
        async () => {
          registry.clear();
          stall = signal();
          const pending = assert.rejects(
            registry.resolve({ ...tenantA, principalId: 'alice' }, 'orders'),
            RegistryCacheInvalidatedError,
          );
          await stall.promise;
          stall = undefined;
          await database.admin.query(
            "UPDATE tenant_routes SET revision='4' WHERE tenant_id=$1",
            [tenantA.tenantId],
          );
          registry.invalidate({ tenantId: tenantA.tenantId });
          await pending;
          assert.equal(
            (await registry.resolve(
              { ...tenantA, principalId: 'alice' },
              'orders',
            ))!.revision,
            '4',
          );
          await delay(180);
          assert.equal(
            (await registry.resolve(
              { ...tenantA, principalId: 'alice' },
              'orders',
            ))!.revision,
            '4',
          );
        },
      );
      await t.test(
        'provider outages are not cached and never fall back to expired routes',
        async () => {
          time += 100;
          await database.admin.query(
            'REVOKE SELECT ON tenant_routes FROM registry_reader',
          );
          const count = selections.length;
          assert.equal((await read('alice')).status, 500);
          assert.equal(selections.length, count);
          await database.admin.query(
            'GRANT SELECT ON tenant_routes TO registry_reader',
          );
          assert.equal((await read('alice')).status, 200);
        },
      );
      await t.test(
        'real timed-out native lookups retain capacity and drain before closure',
        async () => {
          await database.admin.query('SELECT pg_advisory_lock(713845)');
          let unlocked = false;
          const started = signal();
          const timed = createCachedTenantRegistry({
            maxPending: 1,
            lookupTimeoutMs: 20,
            registry: {
              resolve: async (context, source) => {
                const query = control.query(
                  'SELECT pg_advisory_xact_lock(713845)',
                );
                started.resolve();
                await query;
                const rows = await control.query<TenantRoute>(
                  'SELECT tenant_id AS "tenantId", source, adapter, resource, secret_ref AS "secretRef", revision, status, mode FROM tenant_routes WHERE tenant_id=$1 AND source=$2',
                  [context.tenantId, source],
                );
                return rows.rows[0];
              },
            },
          });
          try {
            const request = assert.rejects(
              timed.resolve(tenantA, 'orders'),
              RegistryCacheTimeoutError,
            );
            await started.promise;
            await request;
            assert.equal(timed.stats().pending, 1);
            await assert.rejects(
              timed.resolve(tenantB, 'orders'),
              RegistryCacheCapacityError,
            );
            let finished = false;
            const closing = timed.close().then(() => {
              finished = true;
            });
            await delay(10);
            assert.equal(finished, false);
            await database.admin.query('SELECT pg_advisory_unlock(713845)');
            unlocked = true;
            await closing;
            assert.equal(timed.stats().pending, 0);
            assert.equal(timed.stats().entries, 0);
          } finally {
            if (!unlocked)
              await database.admin.query('SELECT pg_advisory_unlock(713845)');
            await timed.close();
          }
        },
      );
      await t.test(
        'terminal shutdown drains an actual native query without owning the upstream pool',
        async () => {
          registry.clear();
          stall = signal();
          const pending = assert.rejects(
            registry.resolve(tenantA, 'orders'),
            RegistryCacheClosedError,
          );
          await stall.promise;
          stall = undefined;
          let finished = false;
          const shutdown = registry.close().then(() => {
            finished = true;
          });
          await pending;
          await delay(10);
          assert.equal(finished, false);
          assert.equal(registry.stats().pending, 1);
          await shutdown;
          assert.equal(registry.stats().pending, 0);
          assert.equal(registry.stats().entries, 0);
          await assert.rejects(
            registry.resolve(tenantA, 'orders'),
            RegistryCacheClosedError,
          );
          assert.equal(
            (await control.query('SELECT 1 AS alive')).rows[0]!.alive,
            1,
          );
        },
      );
    } finally {
      if (server.listening) await close(server);
      await registry.close();
      await Promise.all([oldPool.end(), newPool.end(), control.end()]);
      await database.close();
    }
  },
);
