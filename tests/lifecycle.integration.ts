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
} from '../packages/resources/src/index.js';
import { createPgAdapter } from '../packages/postgres/src/pg.js';
import {
  createTenantLifecycle,
  createLifecycleRegistry,
  LifecycleBusyError,
  LifecycleUnavailableError,
  LifecycleClosedError,
  LifecycleTimeoutError,
  LifecycleRecoveryError,
  type LifecycleState,
} from '../packages/lifecycle/src/index.js';
import {
  createPgLifecycleStore,
  createPgLifecycleAdapter,
  pgLifecycleSchemaSql,
  type PgLifecycleExecution,
} from '../packages/lifecycle/src/pg.js';
import { postgresFixture, tenantA, tenantB } from './helpers/postgres.js';
const signal = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
async function until(check: () => boolean | Promise<boolean>) {
  const end = performance.now() + 5000;
  while (!(await check())) {
    if (performance.now() > end)
      assert.fail('database lifecycle did not settle');
    await delay(3);
  }
}
const route = (tenantId = tenantA.tenantId, revision = '1'): TenantRoute => ({
  tenantId,
  source: 'orders',
  adapter: 'pg',
  resource: 'main',
  secretRef: 'runtime',
  revision,
  status: 'active',
  mode: 'database-policy',
});
const keyA = { ...tenantA, source: 'orders' },
  keyB = { ...tenantB, source: 'orders' };
const capabilities = {
  transactions: true,
  isolationModes: ['database-policy'] as const,
};
test(
  'durable PostgreSQL tenant provisioning, migration and transaction-fenced routing',
  { timeout: 120_000 },
  async (t) => {
    const db = await postgresFixture();
    const runtime = new pg.Pool({ ...db.config, max: 4 });
    runtime.on('error', () => {});
    const config = {
      ...db.config,
      user: 'lifecycle_owner',
      password: 'lifecycle-test',
      application_name: 'tenantguard-lifecycle',
    };
    const store = createPgLifecycleStore({
      connection: config,
      maxConnections: 6,
    });
    const peer = createPgLifecycleStore({
      connection: config,
      maxConnections: 4,
    });
    const resources = createTenantResourcePool({
      maxResources: 4,
      create: async () => {
        const native = new pg.Pool({ ...db.config, max: 2 });
        native.on('error', () => {});
        return native;
      },
      destroy: async (native) => {
        await native.end();
      },
    });
    const registry = createCachedTenantRegistry({
      registry: createLifecycleRegistry(store),
    });
    const onChange = async (state: Readonly<LifecycleState>) => {
      registry.invalidate({
        tenantId: state.route.tenantId,
        source: state.route.source,
      });
      if (state.route.status === 'active') resources.setRoute(state.route);
      else
        resources.remove({
          tenantId: state.route.tenantId,
          source: state.route.source,
        });
    };
    const manager = createTenantLifecycle({ store, onChange });
    const other = createTenantLifecycle({ store: peer, onChange });
    const pooled = createPooledAdapter({
      pool: resources,
      name: 'pg',
      capabilities,
      createAdapter: (native) =>
        createPgAdapter({
          resolvePool: () => native,
          tables: [{ schema: 'public', table: 'orders' }],
        }),
    });
    const guarded = createPgLifecycleAdapter({ adapter: pooled });
    const direct = createPgLifecycleAdapter({
      adapter: createPgAdapter({
        resolvePool: () => runtime,
        tables: [{ schema: 'public', table: 'orders' }],
      }),
    });
    const router = createTenantRouter({
      strict: true,
      registry,
      sources: { orders: { adapter: guarded, mode: 'database-policy' } },
    });
    const read = (context = tenantA) =>
      router.run(
        context,
        'orders',
        async (client) =>
          (
            await client.query(
              'SELECT id,tenant_id,value FROM orders ORDER BY id',
            )
          ).rows,
      );
    const status = async (key = keyA) => (await store.read(key))!;
    const hasColumn = async (table: string, column: string) =>
      Number(
        (
          await db.admin.query(
            'SELECT count(*) AS n FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3',
            ['public', table, column],
          )
        ).rows[0]!.n,
      ) === 1;
    const verifyA = async (native: PgLifecycleExecution) => {
      assert.equal(
        Number(
          (await native.query('SELECT count(*) AS n FROM lifecycle_payload_a'))
            .rows[0]!.n,
        ),
        1,
      );
    };
    try {
      await db.admin.query(
        "CREATE ROLE lifecycle_owner LOGIN PASSWORD 'lifecycle-test' NOSUPERUSER NOBYPASSRLS; GRANT USAGE,CREATE ON SCHEMA public TO lifecycle_owner; GRANT SELECT,INSERT,UPDATE,DELETE ON orders TO lifecycle_owner;",
      );
      // The management role has an explicit metadata-only RLS policy, not global BYPASSRLS.
      await db.admin.query(
        pgLifecycleSchemaSql({ managementRole: 'lifecycle_owner' }),
      );
      await db.admin.query(
        'GRANT SELECT,INSERT,UPDATE ON tenantguard_lifecycle TO lifecycle_owner; GRANT SELECT ON tenantguard_lifecycle TO app;',
      );
      // Shared data writes by the management role use an explicit fixture policy; runtime app is excluded.
      await db.admin.query(
        'CREATE POLICY lifecycle_management ON orders FOR ALL TO lifecycle_owner USING(true) WITH CHECK(true);',
      );
      // Existing restrictive data boundary still applies, so management uses tenant context per data statement.
      const seed = async (
        native: PgLifecycleExecution,
        tenantId: string,
        id: string,
      ) => {
        await native.query("SELECT set_config('app.tenant_id',$1,true)", [
          tenantId,
        ]);
        await native.query('INSERT INTO orders VALUES($1,$2,$3)', [
          id,
          tenantId,
          'provisioned',
        ]);
      };
      await t.test(
        'provisioning stays unroutable until schema and data verification commit',
        async () => {
          await assert.rejects(read());
          const active = await manager.provision({
            route: route(),
            schemaVersion: 'v1',
            operationId: 'provision-a',
            work: async (native) => {
              assert.equal((await status()).route.status, 'provisioning');
              await assert.rejects(
                direct.run(tenantA, route(), async () =>
                  assert.fail('unfinished tenant'),
                ),
              );
              await native.query(
                'CREATE TABLE lifecycle_payload_a(id integer PRIMARY KEY,value text NOT NULL)',
              );
              await native.query(
                "INSERT INTO lifecycle_payload_a VALUES(1,'ready')",
              );
              await seed(native, tenantA.tenantId, 'seed-a');
            },
            verify: verifyA,
          });
          assert.equal(active.version, 3);
          assert.equal(active.schemaVersion, 'v1');
          assert.equal((await read())[0]!.value, 'provisioned');
          assert.equal((await peer.read(keyA))!.route.status, 'active');
        },
      );
      await t.test(
        'two durable controllers cannot provision one tenant concurrently',
        async () => {
          const entered = signal();
          await db.admin.query('SELECT pg_advisory_lock(834471)');
          let unlocked = false;
          const command = {
            route: route(tenantB.tenantId),
            schemaVersion: 'v1',
            operationId: 'provision-b',
            work: async (native: PgLifecycleExecution) => {
              const query = native.query(
                'SELECT pg_advisory_xact_lock(834471)',
              );
              entered.resolve();
              await query;
              await native.query(
                'CREATE TABLE lifecycle_payload_b(id integer PRIMARY KEY)',
              );
              await native.query('INSERT INTO lifecycle_payload_b VALUES(1)');
              await seed(native, tenantB.tenantId, 'seed-b');
            },
            verify: async (native: PgLifecycleExecution) => {
              assert.equal(
                (await native.query('SELECT id FROM lifecycle_payload_b'))
                  .rows[0]!.id,
                1,
              );
            },
          };
          let task: Promise<unknown> | undefined;
          try {
            task = manager.provision(command);
            await entered.promise;
            await assert.rejects(
              other.provision({
                ...command,
                work: async () => assert.fail('duplicate owner'),
              }),
              LifecycleBusyError,
            );
            await assert.rejects(
              direct.run(tenantB, route(tenantB.tenantId), async () =>
                assert.fail('pending B'),
              ),
            );
            assert.equal((await read()).length, 1);
            await db.admin.query('SELECT pg_advisory_unlock(834471)');
            unlocked = true;
            await task;
          } finally {
            if (!unlocked)
              await db.admin.query('SELECT pg_advisory_unlock(834471)');
            await task;
          }
          assert.equal((await read(tenantB))[0]!.tenant_id, tenantB.tenantId);
        },
      );
      await t.test(
        'migrations drain admitted data transactions while rejecting stale active caches',
        async () => {
          const entered = signal(),
            release = signal();
          let ddl = false;
          const old = router.run(tenantA, 'orders', async (client) => {
            await client.query('INSERT INTO orders VALUES($1,$2,$3)', [
              'before-migration',
              tenantA.tenantId,
              'committed-before-ddl',
            ]);
            entered.resolve();
            await release.promise;
          });
          await entered.promise;
          const migration = manager.migrate({
            route: route(tenantA.tenantId, '2'),
            schemaVersion: 'v2',
            operationId: 'migrate-a',
            expectedVersion: 3,
            work: async (native) => {
              ddl = true;
              await native.query("SELECT set_config('app.tenant_id',$1,true)", [
                tenantA.tenantId,
              ]);
              assert.equal(
                (
                  await native.query('SELECT value FROM orders WHERE id=$1', [
                    'before-migration',
                  ])
                ).rows[0]!.value,
                'committed-before-ddl',
              );
              await native.query(
                'ALTER TABLE lifecycle_payload_a ADD COLUMN note text',
              );
            },
            verify: async (native) => {
              await verifyA(native);
              assert.equal(
                (
                  await native.query(
                    "SELECT state->'route'->>'status' AS status FROM tenantguard_lifecycle WHERE tenant_id=$1 AND source=$2",
                    [keyA.tenantId, keyA.source],
                  )
                ).rows[0]!.status,
                'migrating',
              );
            },
          });
          try {
            await until(
              async () => (await status()).route.status === 'migrating',
            );
            assert.equal(ddl, false);
            await assert.rejects(
              direct.run(tenantA, route(), async () =>
                assert.fail('stale active route'),
              ),
            );
            assert.equal((await read(tenantB)).length, 1);
            release.resolve();
            await old;
            assert.equal((await migration).version, 5);
          } finally {
            release.resolve();
            await old;
          }
          assert.equal(await hasColumn('lifecycle_payload_a', 'note'), true);
          await assert.rejects(
            direct.run(tenantA, route(), async () =>
              assert.fail('old revision after migration'),
            ),
            LifecycleUnavailableError,
          );
          assert.equal((await read()).length, 2);
        },
      );
      await t.test(
        'failed DDL verification rolls back schema and recovery is explicit and durable',
        async () => {
          const command = {
            route: route(tenantA.tenantId, '3'),
            schemaVersion: 'v3',
            operationId: 'migration-fail',
            expectedVersion: 5,
            work: async (native: PgLifecycleExecution) => {
              await native.query(
                'ALTER TABLE lifecycle_payload_a ADD COLUMN rollback_marker integer',
              );
            },
            verify: async () => {
              throw new Error('verification failed');
            },
          };
          await assert.rejects(
            manager.migrate(command),
            /verification failed/u,
          );
          assert.equal(
            await hasColumn('lifecycle_payload_a', 'rollback_marker'),
            false,
          );
          const failed = await status();
          assert.equal(failed.route.status, 'failed');
          assert.equal(failed.schemaVersion, 'v2');
          assert.equal(failed.version, 7);
          await assert.rejects(
            manager.migrate(command),
            LifecycleRecoveryError,
          );
          await assert.rejects(
            direct.run(tenantA, route(tenantA.tenantId, '2'), async () =>
              assert.fail('failed tenant'),
            ),
          );
          const recovered = await other.recover({
            key: keyA,
            expectedVersion: 7,
            operationId: 'migration-fail',
            work: async (native) => {
              await native.query(
                'ALTER TABLE lifecycle_payload_a ADD COLUMN rollback_marker integer',
              );
            },
            verify: verifyA,
          });
          assert.equal(recovered.version, 9);
          assert.equal(recovered.schemaVersion, 'v3');
          assert.equal(
            await hasColumn('lifecycle_payload_a', 'rollback_marker'),
            true,
          );
          const repeated = await manager.migrate({
            ...command,
            work: async () => assert.fail('completed DDL replay'),
            verify: async () => assert.fail('completed verification replay'),
          });
          assert.equal(repeated.version, 9);
        },
      );
      await t.test(
        'runtime metadata reads remain tenant-scoped and cannot mutate lifecycle state',
        async () => {
          const rows = await direct.run(
            tenantA,
            route(tenantA.tenantId, '3'),
            async (client) =>
              (
                await client.query(
                  'SELECT tenant_id FROM tenantguard_lifecycle',
                )
              ).rows,
          );
          assert.deepEqual(rows, [{ tenant_id: tenantA.tenantId }]);
          assert.deepEqual(
            (await runtime.query('SELECT * FROM tenantguard_lifecycle')).rows,
            [],
          );
          await assert.rejects(
            runtime.query('UPDATE tenantguard_lifecycle SET version=version+1'),
            /permission denied/u,
          );
        },
      );
      await t.test(
        'suspension and verified resume keep old route generations fenced',
        async () => {
          await manager.suspend({ key: keyA, expectedVersion: 9 });
          assert.equal((await status()).route.status, 'suspended');
          await assert.rejects(
            direct.run(tenantA, route(tenantA.tenantId, '3'), async () =>
              assert.fail('suspended'),
            ),
          );
          const active = await manager.resume({
            route: route(tenantA.tenantId, '4'),
            schemaVersion: 'v3',
            operationId: 'resume-a',
            expectedVersion: 10,
            verify: verifyA,
          });
          assert.equal(active.version, 12);
          assert.equal((await read()).length, 2);
        },
      );
      await t.test(
        'lost data connection aborts its transaction before migration obtains the fence',
        async () => {
          const blocked = signal();
          await db.admin.query('SELECT pg_advisory_lock(834472)');
          let unlocked = false,
            pid = 0,
            ddl = false;
          const request = direct.run(
            tenantA,
            route(tenantA.tenantId, '4'),
            async (client) => {
              pid = Number(
                (await client.query('SELECT pg_backend_pid() AS pid')).rows[0]!
                  .pid,
              );
              await client.query('INSERT INTO orders VALUES($1,$2,$3)', [
                'aborted-request',
                tenantA.tenantId,
                'must-rollback',
              ]);
              const query = client.query(
                'SELECT pg_advisory_xact_lock(834472)',
              );
              blocked.resolve();
              await query;
            },
          );
          const rejected = assert.rejects(request);
          let migration: Promise<unknown> | undefined;
          try {
            await blocked.promise;
            migration = manager.migrate({
              route: route(tenantA.tenantId, '5'),
              schemaVersion: 'v4',
              operationId: 'after-disconnect',
              expectedVersion: 12,
              work: async (native) => {
                ddl = true;
                await native.query(
                  "SELECT set_config('app.tenant_id',$1,true)",
                  [tenantA.tenantId],
                );
                assert.equal(
                  (
                    await native.query('SELECT * FROM orders WHERE id=$1', [
                      'aborted-request',
                    ])
                  ).rows.length,
                  0,
                );
                await native.query(
                  'ALTER TABLE lifecycle_payload_a ADD COLUMN after_disconnect integer',
                );
              },
              verify: verifyA,
            });
            await until(
              async () => (await status()).route.status === 'migrating',
            );
            assert.equal(ddl, false);
            await db.admin.query('SELECT pg_terminate_backend($1)', [pid]);
            await rejected;
            await migration;
            await db.admin.query('SELECT pg_advisory_unlock(834472)');
            unlocked = true;
          } finally {
            if (!unlocked)
              await db.admin.query('SELECT pg_advisory_unlock(834472)');
            await rejected;
            await migration;
          }
          assert.equal((await status()).route.status, 'active');
          assert.equal(
            await hasColumn('lifecycle_payload_a', 'after_disconnect'),
            true,
          );
        },
      );
      await t.test(
        'operation/shutdown timeouts retain actual native DDL and prevent late activation',
        async () => {
          const entered = signal();
          await db.admin.query('SELECT pg_advisory_lock(834473)');
          let unlocked = false;
          const timed = createTenantLifecycle({
            store,
            onChange,
            operationTimeoutMs: 30,
            shutdownTimeoutMs: 10,
          });
          try {
            const request = assert.rejects(
              timed.migrate({
                route: route(tenantB.tenantId, '2'),
                schemaVersion: 'v2',
                operationId: 'timeout-b',
                expectedVersion: 3,
                work: async (native) => {
                  await native.query(
                    'ALTER TABLE lifecycle_payload_b ADD COLUMN late integer',
                  );
                  const query = native.query(
                    'SELECT pg_advisory_xact_lock(834473)',
                  );
                  entered.resolve();
                  await query;
                },
                verify: async () => {},
              }),
              LifecycleTimeoutError,
            );
            await entered.promise;
            await request;
            assert.equal(timed.stats().operations, 1);
            assert.equal((await status(keyB)).route.status, 'migrating');
            await assert.rejects(timed.close(), LifecycleTimeoutError);
            assert.equal(timed.stats().operations, 1);
            await db.admin.query('SELECT pg_advisory_unlock(834473)');
            unlocked = true;
            await until(() => timed.stats().operations === 0);
            assert.equal((await status(keyB)).route.status, 'failed');
            assert.equal(await hasColumn('lifecycle_payload_b', 'late'), false);
            await manager.recover({
              key: keyB,
              expectedVersion: 5,
              operationId: 'timeout-b',
              work: async (native) => {
                await native.query(
                  'ALTER TABLE lifecycle_payload_b ADD COLUMN late integer',
                );
              },
              verify: async () => {},
            });
          } finally {
            if (!unlocked)
              await db.admin.query('SELECT pg_advisory_unlock(834473)');
            await timed.close().catch((error) => {
              if (!(error instanceof LifecycleTimeoutError)) throw error;
            });
          }
        },
      );
      await t.test(
        'execution phases reject transaction escapes, swallowed errors, pending and expired queries',
        async () => {
          for (const sql of [
            'COMMIT',
            'SELECT 1; COMMIT',
            'SELECT * FROM nonexistent_lifecycle_table',
          ]) {
            await assert.rejects(
              store.withExclusiveLock(keyA, async (transaction) =>
                transaction.runPhase(async (native) => {
                  await native.query(
                    'ALTER TABLE lifecycle_payload_a ADD COLUMN forbidden integer',
                  );
                  await native.query(sql).catch(() => {});
                }),
              ),
            );
            assert.equal(
              await hasColumn('lifecycle_payload_a', 'forbidden'),
              false,
            );
          }
          let expired: PgLifecycleExecution | undefined;
          await store.withExclusiveLock(keyA, async (transaction) =>
            transaction.runPhase(async (native) => {
              expired = native;
              await native.query('SELECT 1');
            }),
          );
          await assert.rejects(
            expired!.query('SELECT 1'),
            LifecycleClosedError,
          );
          await assert.rejects(
            store.withExclusiveLock(keyA, async (transaction) =>
              transaction.runPhase(async (native) => {
                void native.query('SELECT pg_sleep(0.03)').catch(() => {});
              }),
            ),
            /unawaited/u,
          );
          assert.equal((await status()).route.status, 'active');
        },
      );
      await t.test(
        'killed management transaction cannot publish active metadata or leave committed DDL',
        async () => {
          const entered = signal();
          await db.admin.query('SELECT pg_advisory_lock(834474)');
          let pid = 0,
            unlocked = false;
          const task = assert.rejects(
            manager.migrate({
              route: route(tenantB.tenantId, '3'),
              schemaVersion: 'v3',
              operationId: 'killed-b',
              expectedVersion: 7,
              work: async (native) => {
                pid = Number(
                  (await native.query('SELECT pg_backend_pid() AS pid'))
                    .rows[0]!.pid,
                );
                await native.query(
                  'ALTER TABLE lifecycle_payload_b ADD COLUMN killed integer',
                );
                const query = native.query(
                  'SELECT pg_advisory_xact_lock(834474)',
                );
                entered.resolve();
                await query;
              },
              verify: async () => {},
            }),
          );
          try {
            await entered.promise;
            await db.admin.query('SELECT pg_terminate_backend($1)', [pid]);
            await task;
            assert.notEqual((await status(keyB)).route.status, 'active');
            assert.equal(
              await hasColumn('lifecycle_payload_b', 'killed'),
              false,
            );
            const interrupted = await status(keyB);
            await other.recover({
              key: keyB,
              expectedVersion: interrupted.version,
              operationId: 'killed-b',
              work: async (native) => {
                await native.query(
                  'ALTER TABLE lifecycle_payload_b ADD COLUMN killed integer',
                );
              },
              verify: async () => {},
            });
            assert.equal((await status(keyB)).route.status, 'active');

            await db.admin.query('SELECT pg_advisory_unlock(834474)');
            unlocked = true;
          } finally {
            if (!unlocked)
              await db.admin.query('SELECT pg_advisory_unlock(834474)');
            await task;
          }
        },
      );
      await t.test(
        'concurrent tenants reuse pinned control sessions without second-connection deadlocks',
        async () => {
          const bounded = createPgLifecycleStore({
            connection: {
              ...config,
              application_name: 'lifecycle-bounded',
              connectionTimeoutMillis: 1000,
            },
            maxConnections: 2,
            maxPending: 8,
          });
          const controller = createTenantLifecycle({
            store: bounded,
            maxOperations: 6,
            operationTimeoutMs: 2000,
          });
          let active = 0,
            high = 0;
          const pids = new Set<number>();
          try {
            await Promise.all(
              Array.from({ length: 6 }, (_, i) =>
                controller.provision({
                  route: route(
                    'cccccccc-cccc-cccc-cccc-' + String(i).padStart(12, '0'),
                  ),
                  schemaVersion: 'v1',
                  operationId: 'bounded-' + i,
                  work: async (native) => {
                    active++;
                    high = Math.max(high, active);
                    try {
                      pids.add(
                        Number(
                          (await native.query('SELECT pg_backend_pid() AS pid'))
                            .rows[0]!.pid,
                        ),
                      );
                      await native.query('SELECT pg_sleep(0.02)');
                    } finally {
                      active--;
                    }
                  },
                  verify: async (native) => {
                    assert.equal(
                      (await native.query('SELECT 1 AS ok')).rows[0]!.ok,
                      1,
                    );
                  },
                }),
              ),
            );
            assert(high <= 2);
            assert.equal(pids.size, 6);
            assert.equal(bounded.stats().operations, 0);
          } finally {
            await controller.close();
            await bounded.close();
          }
        },
      );
      await t.test(
        'store shutdown and capacity account for queued native connection acquisition',
        async () => {
          const isolated = createPgLifecycleStore({
            connection: { ...config, connectionTimeoutMillis: 150 },
            maxConnections: 2,
            maxPending: 3,
            statementTimeoutMs: 1000,
            shutdownTimeoutMs: 20,
          });
          const release = signal();
          let entered = 0;
          const first = isolated.withControlLock(keyA, async (session) => {
            await session.read();
            entered++;
            await release.promise;
          });
          const second = isolated.withControlLock(keyB, async (session) => {
            await session.read();
            entered++;
            await release.promise;
          });
          let queued: Promise<void> | undefined;
          try {
            await until(() => entered === 2);
            queued = assert.rejects(isolated.read(keyA));
            assert.equal(isolated.stats().operations, 3);
            await assert.rejects(isolated.read(keyB), LifecycleBusyError);
            const closing = isolated.close();
            await assert.rejects(closing, LifecycleTimeoutError);
            assert.equal(isolated.close(), closing);
            assert.equal(isolated.stats().operations, 3);
            await assert.rejects(isolated.read(keyA), LifecycleClosedError);
            release.resolve();
            await Promise.all([first, second]);
            await queued;
            await until(() => isolated.stats().operations === 0);
          } finally {
            release.resolve();
            await Promise.allSettled([first, second]);
            await queued;
            await isolated.close().catch((error) => {
              if (!(error instanceof LifecycleTimeoutError)) throw error;
            });
          }
        },
      );
    } finally {
      await manager.close();
      await other.close();
      await registry.close();
      await resources.close();
      await runtime.end();
      await store.close();
      await peer.close();
      await db.close();
    }
  },
);
