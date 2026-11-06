import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createTenantRouter,
  type TenantRoute,
  type DatabaseAdapter,
} from '../packages/core/src/index.js';
import { createCachedTenantRegistry } from '../packages/registry/src/index.js';
import {
  createMemoryLifecycleStore,
  createTenantLifecycle,
  createLifecycleRegistry,
  createLifecycleAdapter,
  LifecycleBusyError,
  LifecycleConflictError,
  LifecycleUnavailableError,
  LifecycleRecoveryError,
  LifecycleTimeoutError,
  LifecyclePublicationError,
  LifecycleClosedError,
  stateSnapshot,
  type LifecycleSession,
} from '../packages/lifecycle/src/index.js';
import {
  runWithContext,
  requireTenant,
  getTenant,
} from '../packages/node/src/index.js';
const key = { tenantId: 'Org_A', source: 'orders' };
const route = (revision = '1', tenantId = key.tenantId): TenantRoute => ({
  tenantId,
  source: 'orders',
  adapter: 'test',
  resource: 'main',
  revision,
  status: 'active',
  mode: 'database-policy',
});
const signal = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
const until = async (check: () => boolean | Promise<boolean>) => {
  const end = performance.now() + 2000;
  while (!(await check())) {
    if (performance.now() > end) assert.fail('lifecycle did not settle');
    await delay(2);
  }
};
const callbacks = { work: async () => {}, verify: async () => {} };
const provision = {
  ...callbacks,
  route: route(),
  operationId: 'provision-1',
  schemaVersion: 'v1',
};
function fixture(
  options: Parameters<typeof createTenantLifecycle>[0] extends never
    ? never
    : {
        operationTimeoutMs?: number;
        shutdownTimeoutMs?: number;
        maxOperations?: number;
      } = {},
) {
  const store = createMemoryLifecycleStore();
  const changes: string[] = [];
  const manager = createTenantLifecycle({
    store,
    onChange: async (state) => {
      changes.push(state.route.status);
    },
    ...options,
  });
  let calls = 0;
  const adapter: DatabaseAdapter<{ read(): string }> = {
    name: 'test',
    capabilities: { transactions: true, isolationModes: ['database-policy'] },
    run: async (_context, _route, work) => {
      calls++;
      return work({ read: () => 'ok' });
    },
  };
  const guarded = createLifecycleAdapter({ store, adapter });
  const cache = createCachedTenantRegistry({
    registry: createLifecycleRegistry(store),
  });
  const router = createTenantRouter({
    strict: true,
    registry: cache,
    sources: { orders: { adapter: guarded, mode: 'database-policy' } },
  });
  return {
    store,
    manager,
    changes,
    cache,
    router,
    guarded,
    calls: () => calls,
    close: async () => {
      await manager.close();
      await cache.close();
      await store.close();
    },
  };
}
test('provision publishes pending/provisioning and only verifies into active', async () => {
  const f = fixture();
  let worked = false;
  try {
    const active = await f.manager.provision({
      ...provision,
      work: async () => {
        assert.equal((await f.store.read(key))!.route.status, 'provisioning');
        await assert.rejects(
          f.router.run(key, 'orders', async () =>
            assert.fail('unfinished tenant'),
          ),
        );
        worked = true;
      },
      verify: async () => {
        assert(worked);
        assert.equal((await f.store.read(key))!.route.status, 'provisioning');
      },
    });
    assert.equal(active.version, 3);
    assert.equal(active.schemaVersion, 'v1');
    assert(Object.isFrozen(active.operation!.target));
    assert.deepEqual(f.changes, ['pending', 'provisioning', 'active']);
    f.cache.clear();
    assert.equal(
      await f.router.run(key, 'orders', async (client) => client.read()),
      'ok',
    );
  } finally {
    await f.close();
  }
});
test('identical completed operations are idempotent without replaying DDL or verification', async () => {
  const f = fixture();
  let calls = 0;
  try {
    const command = {
      ...provision,
      work: async () => {
        calls++;
      },
      verify: async () => {
        calls++;
      },
    };
    await f.manager.provision(command);
    assert.equal((await f.manager.provision(command)).version, 3);
    assert.equal(calls, 2);
    await assert.rejects(
      f.manager.provision({ ...command, operationId: 'another' }),
      LifecycleConflictError,
    );
  } finally {
    await f.close();
  }
});
test('controller races reject duplicate ownership and preserve unrelated tenant progress', async () => {
  const f = fixture();
  const entered = signal(),
    release = signal();
  try {
    const first = f.manager.provision({
      ...provision,
      work: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    await entered.promise;
    const other = createTenantLifecycle({ store: f.store });
    try {
      await assert.rejects(other.provision(provision), LifecycleBusyError);
      await other.provision({
        ...provision,
        route: route('1', 'B'),
        operationId: 'b',
      });
    } finally {
      await other.close();
    }
    release.resolve();
    await first;
  } finally {
    release.resolve();
    await f.close();
  }
});
test('migration marks inactive before waiting for old admitted callbacks and fences stale cache', async () => {
  const f = fixture();
  const entered = signal(),
    release = signal(),
    migrating = signal();
  let migrated = false;
  try {
    await f.manager.provision(provision);
    await f.router.run(key, 'orders', async () => {});
    const old = f.router.run(key, 'orders', async () => {
      entered.resolve();
      await release.promise;
      assert.equal(migrated, false);
    });
    await entered.promise;
    const migration = f.manager.migrate({
      ...callbacks,
      route: route('2'),
      schemaVersion: 'v2',
      operationId: 'migration',
      expectedVersion: 3,
      work: async () => {
        migrating.resolve();
        migrated = true;
      },
    });
    await until(
      async () => (await f.store.read(key))!.route.status === 'migrating',
    );
    await assert.rejects(
      f.router.run(key, 'orders', async () =>
        assert.fail('cached active route'),
      ),
      (error) =>
        error instanceof LifecycleUnavailableError ||
        error instanceof LifecycleBusyError,
    );
    assert.equal(migrated, false);
    release.resolve();
    await old;
    await migrating.promise;
    const active = await migration;
    assert.equal(active.version, 5);
    await assert.rejects(
      f.router.run(key, 'orders', async () =>
        assert.fail('old revision after activation'),
      ),
      LifecycleUnavailableError,
    );
    f.cache.clear();
    assert.equal(
      await f.router.run(key, 'orders', async (client) => client.read()),
      'ok',
    );
  } finally {
    release.resolve();
    await f.close();
  }
});
test('failed verification stays failed and explicit recovery reuses the recorded target', async () => {
  const f = fixture();
  const error = new Error('verification failed');
  try {
    await assert.rejects(
      f.manager.provision({
        ...provision,
        verify: async () => {
          throw error;
        },
      }),
      (value) => value === error,
    );
    const failed = (await f.store.read(key))!;
    assert.equal(failed.route.status, 'failed');
    assert.equal(failed.version, 3);
    assert.equal(failed.schemaVersion, undefined);
    await assert.rejects(
      f.manager.provision(provision),
      LifecycleRecoveryError,
    );
    await assert.rejects(
      f.manager.recover({
        ...callbacks,
        key,
        operationId: 'wrong',
        expectedVersion: 3,
      }),
      LifecycleConflictError,
    );
    const active = await f.manager.recover({
      ...callbacks,
      key,
      operationId: 'provision-1',
      expectedVersion: 3,
    });
    assert.equal(active.route.status, 'active');
    assert.equal(active.version, 5);
  } finally {
    await f.close();
  }
});
test('migration failure preserves last applied schema and requires explicit reconciliation', async () => {
  const f = fixture();
  try {
    await f.manager.provision(provision);
    await assert.rejects(
      f.manager.migrate({
        ...callbacks,
        route: route('2'),
        schemaVersion: 'v2',
        operationId: 'm',
        expectedVersion: 3,
        work: async () => {
          throw new Error('DDL failed');
        },
      }),
    );
    const failed = (await f.store.read(key))!;
    assert.equal(failed.schemaVersion, 'v1');
    assert.equal(failed.route.status, 'failed');
    assert.equal(failed.operation!.schemaVersion, 'v2');
    assert.equal(
      (
        await f.manager.recover({
          ...callbacks,
          key,
          expectedVersion: failed.version,
          operationId: 'm',
        })
      ).schemaVersion,
      'v2',
    );
  } finally {
    await f.close();
  }
});
test('suspension drains old admissions and resume verifies a new route revision', async () => {
  const f = fixture();
  try {
    await f.manager.provision(provision);
    const suspended = await f.manager.suspend({ key, expectedVersion: 3 });
    assert.equal(suspended.route.status, 'suspended');
    await assert.rejects(
      f.guarded.run(key, route(), async () => assert.fail('suspended')),
      LifecycleUnavailableError,
    );
    await assert.rejects(
      f.manager.resume({
        route: route(),
        operationId: 'resume',
        schemaVersion: 'v1',
        expectedVersion: 4,
        verify: async () => {},
      }),
      LifecycleConflictError,
    );
    assert.equal(
      (
        await f.manager.resume({
          route: route('2'),
          operationId: 'resume',
          schemaVersion: 'v1',
          expectedVersion: 4,
          verify: async () => {},
        })
      ).route.status,
      'active',
    );
  } finally {
    await f.close();
  }
});
test('stale management versions and same-revision migrations never run work', async () => {
  const f = fixture();
  try {
    await f.manager.provision(provision);
    for (const command of [
      { ...provision, expectedVersion: 2, route: route('2') },
      { ...provision, operationId: 'new', expectedVersion: 3 },
    ])
      await assert.rejects(
        f.manager.migrate({
          ...command,
          work: async () => assert.fail('conflicting operation'),
        }),
        LifecycleConflictError,
      );
  } finally {
    await f.close();
  }
});
test('operation timeout retains actual work and prevents late activation', async () => {
  const f = fixture({ operationTimeoutMs: 10 });
  const entered = signal(),
    release = signal();
  try {
    const task = assert.rejects(
      f.manager.provision({
        ...provision,
        work: async () => {
          entered.resolve();
          await release.promise;
        },
      }),
      LifecycleTimeoutError,
    );
    await entered.promise;
    await task;
    assert.equal(f.manager.stats().operations, 1);
    assert.equal((await f.store.read(key))!.route.status, 'provisioning');
    release.resolve();
    await until(() => f.manager.stats().operations === 0);
    assert.equal((await f.store.read(key))!.route.status, 'failed');
  } finally {
    release.resolve();
    await f.close();
  }
});
test('shutdown rejects new management work and reports while draining actual operations', async () => {
  const f = fixture({ shutdownTimeoutMs: 5 });
  const entered = signal(),
    release = signal();
  try {
    const operation = f.manager.provision({
      ...provision,
      work: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    await entered.promise;
    const closing = f.manager.close();
    assert.equal(f.manager.close(), closing);
    await assert.rejects(closing, LifecycleTimeoutError);
    await assert.rejects(
      f.manager.provision({ ...provision, route: route('1', 'B') }),
      LifecycleClosedError,
    );
    await assert.rejects(
      f.manager.recover({
        ...callbacks,
        key,
        expectedVersion: 2,
        operationId: 'provision-1',
      }),
      LifecycleClosedError,
    );
    assert.equal(f.manager.stats().operations, 1);
    release.resolve();
    await operation;
    await until(() => f.manager.stats().operations === 0);
  } finally {
    release.resolve();
    await f.manager.close().catch(() => {});
    await f.cache.close();
    await f.store.close();
  }
});
test('post-commit publication failure reports committed state and idempotent repair never replays work', async () => {
  const store = createMemoryLifecycleStore();
  let fail = true,
    calls = 0;
  const manager = createTenantLifecycle({
    store,
    onChange: async (state) => {
      if (state.route.status === 'active' && fail)
        throw new Error('event unavailable');
    },
  });
  try {
    const command = {
      ...provision,
      work: async () => {
        calls++;
      },
    };
    await assert.rejects(
      manager.provision(command),
      (error) => error instanceof LifecyclePublicationError && error.committed,
    );
    assert.equal((await store.read(key))!.route.status, 'active');
    fail = false;
    await manager.provision(command);
    assert.equal(calls, 1);
  } finally {
    await manager.close();
    await store.close();
  }
});
test('blocking publication failure never starts DDL or activates the tenant', async () => {
  const store = createMemoryLifecycleStore();
  const manager = createTenantLifecycle({
    store,
    onChange: async () => {
      throw new Error('publication unavailable');
    },
  });
  try {
    await assert.rejects(
      manager.provision({
        ...provision,
        work: async () => assert.fail('publication failed before DDL'),
      }),
    );
    assert.notEqual((await store.read(key))!.route.status, 'active');
  } finally {
    await manager.close();
    await store.close();
  }
});
test('verification returning false cannot accidentally activate a tenant', async () => {
  const f = fixture();
  try {
    await assert.rejects(
      f.manager.provision({
        ...provision,
        verify: (async () => false) as unknown as () => Promise<void>,
      }),
      TypeError,
    );
    assert.equal((await f.store.read(key))!.route.status, 'failed');
  } finally {
    await f.close();
  }
});
test('operation capacity includes timed-out work, including recovery admission', async () => {
  const f = fixture({ maxOperations: 1, operationTimeoutMs: 10 });
  const entered = signal(),
    release = signal();
  try {
    const first = assert.rejects(
      f.manager.provision({
        ...provision,
        work: async () => {
          entered.resolve();
          await release.promise;
        },
      }),
      LifecycleTimeoutError,
    );
    await entered.promise;
    await first;
    await assert.rejects(
      f.manager.provision({ ...provision, route: route('1', 'B') }),
      LifecycleBusyError,
    );
    await assert.rejects(
      f.manager.recover({
        ...callbacks,
        key,
        expectedVersion: 2,
        operationId: 'provision-1',
      }),
      LifecycleBusyError,
    );
  } finally {
    release.resolve();
    await f.close();
  }
});
test('expired memory store sessions cannot write and state snapshots reject malformed identity', async () => {
  const store = createMemoryLifecycleStore();
  let escaped: LifecycleSession | undefined;
  try {
    await store.withControlLock(key, async (session) => {
      escaped = session;
    });
    await assert.rejects(escaped!.read(), LifecycleClosedError);
    assert.throws(() =>
      stateSnapshot({ version: 1, route: { ...route(), status: 'active' } }),
    );
    assert.throws(() =>
      stateSnapshot(
        { version: 1, route: route('1', 'foreign'), schemaVersion: 'v1' },
        key,
      ),
    );
  } finally {
    await store.close();
  }
});
test('queued management and admission preserve caller async contexts', async () => {
  const f = fixture();
  try {
    await f.manager.provision(provision);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        const context = { tenantId: key.tenantId, principalId: String(i) };
        return runWithContext(context, () =>
          f.guarded.run(context, route(), async () => {
            assert.deepEqual(requireTenant(), context);
            await delay(1);
            assert.deepEqual(requireTenant(), context);
          }),
        );
      }),
    );
    assert.equal(getTenant(), undefined);
  } finally {
    await f.close();
  }
});
test('memory catalog and lock bounds reject without changing existing records', async () => {
  const store = createMemoryLifecycleStore({ maxRecords: 1 });
  const manager = createTenantLifecycle({ store });
  try {
    await manager.provision(provision);
    await assert.rejects(
      manager.provision({ ...provision, route: route('1', 'B') }),
      LifecycleBusyError,
    );
    assert.equal((await store.read(key))!.route.status, 'active');
  } finally {
    await manager.close();
    await store.close();
  }
});
