import { AsyncLocalStorage } from 'node:async_hooks';
import {
  getTenant,
  requireTenant,
  runWithContext,
} from '../packages/node/src/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createTenantResourcePool,
  createPooledAdapter,
  ResourcePoolCapacityError,
  ResourcePoolCleanupError,
  ResourcePoolClosedError,
  ResourcePoolRouteError,
  ResourcePoolTimeoutError,
} from '../packages/resources/src/index.js';
import type {
  DatabaseAdapter,
  TenantRoute,
} from '../packages/core/src/index.js';
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const signal = () => deferred<void>();
const route = (
  tenantId = 'Org_A',
  revision = '1',
  source = 'orders',
): TenantRoute => ({
  tenantId,
  revision,
  source,
  adapter: 'test',
  resource: 'pool-' + revision,
  secretRef: 'secret-' + revision,
  status: 'active',
  mode: 'database-policy',
});
const tick = () => delay(0);
async function until(check: () => boolean) {
  const deadline = performance.now() + 2000;
  while (!check()) {
    if (performance.now() > deadline) assert.fail('condition did not settle');
    await delay(2);
  }
}

test('resource creation coalesces 100 callers and bounds concurrent leases', async () => {
  let created = 0,
    active = 0,
    high = 0,
    destroyed = 0;
  const pool = createTenantResourcePool({
    create: async (value) => {
      assert(Object.isFrozen(value));
      created++;
      return { id: created };
    },
    destroy: async () => {
      assert.equal(active, 0);
      destroyed++;
    },
    maxLeasesPerResource: 3,
  });
  pool.setRoute(route());
  const values = await Promise.all(
    Array.from({ length: 100 }, () =>
      pool.run(route(), async (resource) => {
        active++;
        high = Math.max(high, active);
        await delay(1);
        active--;
        return resource.id;
      }),
    ),
  );
  assert(values.every((value) => value === 1));
  assert.equal(created, 1);
  assert.equal(high, 3);
  await pool.close();
  assert.equal(destroyed, 1);
  assert.equal(pool.stats().resources, 0);
});
test('route catalog, tenants, sources and case are isolated and bounded', async () => {
  let created = 0;
  const pool = createTenantResourcePool({
    create: async () => ({ id: ++created }),
    destroy: async () => {},
    maxRoutes: 3,
    maxResources: 3,
  });
  for (const value of [route(), route('org_a'), route('Org_A', '1', 'audit')])
    pool.setRoute(value);
  assert.throws(() => pool.setRoute(route('third')), ResourcePoolCapacityError);
  const values = await Promise.all(
    [route(), route('org_a'), route('Org_A', '1', 'audit')].map((value) =>
      pool.run(value, async (resource) => resource.id),
    ),
  );
  assert.equal(new Set(values).size, 3);
  pool.remove({ tenantId: 'Org_A', source: 'audit' });
  assert.equal(pool.stats().routes, 2);
  await pool.close();
});
test('global capacity counts disposal until it really completes before admitting another tenant', async () => {
  const destroyGate = signal(),
    entered = signal(),
    release = signal();
  let created = 0;
  const pool = createTenantResourcePool({
    maxResources: 1,
    create: async () => ({ id: ++created }),
    destroy: async (resource) => {
      if (resource.id === 1) await destroyGate.promise;
    },
  });
  pool.setRoute(route());
  pool.setRoute(route('B'));
  const first = pool.run(route(), async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const second = pool.run(route('B'), async (resource) => resource.id);
  await tick();
  assert.equal(created, 1);
  release.resolve();
  await first;
  await tick();
  assert.equal(pool.stats().disposing, 1);
  assert.equal(created, 1);
  destroyGate.resolve();
  assert.equal(await second, 2);
  await pool.close();
});
test('per-tenant capacity pins old rotation leases while other tenants proceed', async () => {
  const entered = signal(),
    release = signal();
  let created = 0;
  const destroyed: number[] = [];
  const pool = createTenantResourcePool({
    maxResources: 3,
    maxResourcesPerTenant: 1,
    maxLeasesPerResource: 1,
    create: async () => ({ id: ++created }),
    destroy: async (resource) => {
      destroyed.push(resource.id);
    },
  });
  pool.setRoute(route());
  pool.setRoute(route('B'));
  const old = pool.run(route(), async (resource) => {
    entered.resolve();
    await release.promise;
    assert(!destroyed.includes(resource.id));
    return resource.id;
  });
  await entered.promise;
  const oldQueued = assert.rejects(
    pool.run(route(), async () => assert.fail('rotated queue')),
    ResourcePoolRouteError,
  );
  pool.setRoute(route('Org_A', '2'), '1');
  await oldQueued;
  const fresh = pool.run(route('Org_A', '2'), async (resource) => resource.id);
  assert.equal(await pool.run(route('B'), async (resource) => resource.id), 2);
  assert.equal(created, 2);
  assert.equal(destroyed.length, 0);
  release.resolve();
  assert.equal(await old, 1);
  assert.equal(await fresh, 3);
  assert(destroyed.includes(1));
  await pool.close();
});
test('rotation requires compare-and-set, rejects stale routes and conflicting same revisions', async () => {
  const pool = createTenantResourcePool({
    create: async () => ({}),
    destroy: async () => {},
  });
  pool.setRoute(route());
  pool.setRoute(route());
  assert.throws(
    () => pool.setRoute(route('Org_A', '2')),
    ResourcePoolRouteError,
  );
  assert.throws(
    () => pool.setRoute({ ...route(), secretRef: 'changed' }, '1'),
    ResourcePoolRouteError,
  );
  pool.setRoute(route('Org_A', '2'), '1');
  assert.throws(
    () => pool.setRoute(route('Org_A', '3'), '1'),
    ResourcePoolRouteError,
  );
  await assert.rejects(
    pool.run(route(), async () => assert.fail('stale route')),
    ResourcePoolRouteError,
  );
  pool.remove({ tenantId: 'Org_A' });
  await assert.rejects(
    pool.run(route('Org_A', '2'), async () => assert.fail('removed route')),
    ResourcePoolRouteError,
  );
  pool.setRoute(route('Org_A', '3'));
  await pool.close();
});
test('removal rejects queued work without destroying acquired callbacks', async () => {
  const entered = signal(),
    release = signal();
  let destroyed = false;
  const pool = createTenantResourcePool({
    maxLeasesPerResource: 1,
    create: async () => ({}),
    destroy: async () => {
      destroyed = true;
    },
  });
  pool.setRoute(route());
  const active = pool.run(route(), async () => {
    entered.resolve();
    await release.promise;
    assert.equal(destroyed, false);
  });
  await entered.promise;
  const queued = assert.rejects(
    pool.run(route(), async () => assert.fail('removed work')),
    ResourcePoolRouteError,
  );
  pool.remove({ tenantId: 'Org_A' });
  await queued;
  assert.equal(destroyed, false);
  release.resolve();
  await active;
  await pool.close();
  assert(destroyed);
});
test('automatic idle eviction runs without traffic and never evicts active leases', async () => {
  const entered = signal(),
    release = signal();
  let destroyed = 0;
  const pool = createTenantResourcePool({
    idleTimeoutMs: 10,
    create: async () => ({}),
    destroy: async () => {
      destroyed++;
    },
  });
  pool.setRoute(route());
  const active = pool.run(route(), async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  await delay(25);
  assert.equal(destroyed, 0);
  release.resolve();
  await active;
  await until(() => destroyed === 1);
  assert.equal(pool.stats().resources, 0);
  await pool.close();
});
test('idle sweep uses monotonic deadlines and idle eviction cannot reopen stale generations', async () => {
  let time = 0,
    created = 0;
  const pool = createTenantResourcePool({
    idleTimeoutMs: 10,
    clock: () => time,
    create: async () => ({ id: ++created }),
    destroy: async () => {},
  });
  pool.setRoute(route());
  await pool.run(route(), async () => {});
  await tick();
  time = 10;
  pool.sweep();
  await tick();
  assert.equal(pool.stats().resources, 0);
  pool.setRoute(route('Org_A', '2'), '1');
  await assert.rejects(
    pool.run(route(), async () => {}),
    ResourcePoolRouteError,
  );
  assert.equal(
    await pool.run(route('Org_A', '2'), async (resource) => resource.id),
    2,
  );
  await pool.close();
});
test('timed-out acquisitions retain pending factory capacity and dispose its late result', async () => {
  const factory = deferred<{ id: number }>();
  let created = 0,
    destroyed = 0;
  const pool = createTenantResourcePool({
    maxResources: 1,
    acquireTimeoutMs: 10,
    create: async () => {
      created++;
      return factory.promise;
    },
    destroy: async () => {
      destroyed++;
    },
  });
  pool.setRoute(route());
  await assert.rejects(
    pool.run(route(), async () => assert.fail('late work')),
    ResourcePoolTimeoutError,
  );
  assert.equal(pool.stats().resources, 1);
  assert.equal(pool.stats().creating, 1);
  factory.resolve({ id: 1 });
  await until(() => destroyed === 1);
  assert.equal(created, 1);
  await pool.close();
});
test('factory deadlines retain native capacity and late successful factories are destroyed', async () => {
  const factory = deferred<object>();
  let destroyed = 0;
  const pool = createTenantResourcePool({
    maxResources: 1,
    createTimeoutMs: 5,
    acquireTimeoutMs: 1000,
    create: () => factory.promise,
    destroy: async () => {
      destroyed++;
    },
  });
  pool.setRoute(route());
  await assert.rejects(
    pool.run(route(), async () => assert.fail('late factory')),
    (error) =>
      error instanceof ResourcePoolTimeoutError && error.phase === 'create',
  );
  assert.equal(pool.stats().resources, 1);
  factory.resolve({});
  await pool.close();
  assert.equal(destroyed, 1);
});
test('absolute factory deadlines are checked before publishing even if the timer has not fired', async () => {
  let time = 0,
    destroyed = 0;
  const factory = deferred<object>();
  const pool = createTenantResourcePool({
    clock: () => time,
    createTimeoutMs: 1000,
    acquireTimeoutMs: 2000,
    create: () => factory.promise,
    destroy: async () => {
      destroyed++;
    },
  });
  pool.setRoute(route());
  const request = assert.rejects(
    pool.run(route(), async () => assert.fail('expired factory')),
    ResourcePoolTimeoutError,
  );
  await tick();
  time = 1000;
  factory.resolve({});
  await request;
  await pool.close();
  assert.equal(destroyed, 1);
});
test('absolute acquisition deadlines reject queued callbacks before granting a released lease', async () => {
  let time = 0;
  const entered = signal(),
    release = signal();
  const pool = createTenantResourcePool({
    clock: () => time,
    acquireTimeoutMs: 1000,
    maxLeasesPerResource: 1,
    create: async () => ({}),
    destroy: async () => {},
  });
  pool.setRoute(route());
  const active = pool.run(route(), async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const queued = assert.rejects(
    pool.run(route(), async () => assert.fail('expired acquisition')),
    ResourcePoolTimeoutError,
  );
  time = 1000;
  release.resolve();
  await active;
  await queued;
  await pool.close();
});
test('shutdown is terminal and idempotent, rejects waiters and waits for real lease completion', async () => {
  const entered = signal(),
    release = signal();
  let destroyed = 0;
  const pool = createTenantResourcePool({
    maxLeasesPerResource: 1,
    create: async () => ({}),
    destroy: async () => {
      destroyed++;
    },
  });
  pool.setRoute(route());
  const active = pool.run(route(), async () => {
    entered.resolve();
    await release.promise;
    assert.equal(destroyed, 0);
  });
  await entered.promise;
  const queued = assert.rejects(
    pool.run(route(), async () => assert.fail('closed work')),
    ResourcePoolClosedError,
  );
  const closing = pool.close();
  assert.equal(pool.close(), closing);
  let done = false;
  void closing.then(() => {
    done = true;
  });
  await queued;
  await tick();
  assert.equal(done, false);
  await assert.rejects(
    pool.run(route(), async () => {}),
    ResourcePoolClosedError,
  );
  assert.throws(() => pool.setRoute(route()), ResourcePoolClosedError);
  assert.throws(
    () => pool.remove({ tenantId: 'Org_A' }),
    ResourcePoolClosedError,
  );
  release.resolve();
  await active;
  await closing;
  assert.equal(destroyed, 1);
});
test('shutdown drains late factory rejection and skips factories not yet dispatched', async () => {
  for (const dispatched of [false, true]) {
    let created = 0;
    const factory = deferred<object>();
    const pool = createTenantResourcePool({
      create: () => {
        created++;
        return factory.promise;
      },
      destroy: async () => {},
    });
    pool.setRoute(route());
    const result = assert.rejects(
      pool.run(route(), async () => assert.fail('closed factory')),
      ResourcePoolClosedError,
    );
    if (dispatched) await tick();
    const closing = pool.close();
    await result;
    if (dispatched) factory.reject(new Error('late rejection'));
    await closing;
    assert.equal(created, dispatched ? 1 : 0);
  }
});
test('cleanup failure quarantines capacity, closes admission and is reported by shutdown', async () => {
  const failure = new Error('native close failed');
  const pool = createTenantResourcePool({
    create: async () => ({}),
    destroy: async () => {
      throw failure;
    },
  });
  pool.setRoute(route());
  await pool.run(route(), async () => {});
  pool.remove({ tenantId: 'Org_A' });
  await until(() => pool.stats().quarantined === 1);
  assert.equal(pool.stats().resources, 1);
  assert.equal(pool.stats().closed, true);
  await assert.rejects(
    pool.close(),
    (error) =>
      error instanceof ResourcePoolCleanupError &&
      error.errors.includes(failure),
  );
  await assert.rejects(
    pool.run(route(), async () => {}),
    ResourcePoolClosedError,
  );
});
test('creation failures preserve identity and free actual capacity for a later explicit request', async () => {
  let calls = 0;
  const failure = new Error('factory failed');
  const pool = createTenantResourcePool({
    maxResources: 1,
    create: async () => {
      if (++calls === 1) throw failure;
      return {};
    },
    destroy: async () => {},
  });
  pool.setRoute(route());
  await assert.rejects(
    pool.run(route(), async () => {}),
    (error) => error === failure,
  );
  await pool.run(route(), async () => {});
  assert.equal(calls, 2);
  await pool.close();
});
test('the same native resource cannot be adopted by two managers or destroyed by the second', async () => {
  const resource = {};
  let destroyed = 0;
  const first = createTenantResourcePool({
    create: async () => resource,
    destroy: async () => {
      destroyed++;
    },
  });
  first.setRoute(route());
  await first.run(route(), async () => {});
  const second = createTenantResourcePool({
    create: async () => resource,
    destroy: async () => {
      destroyed++;
    },
  });
  second.setRoute(route());
  await assert.rejects(
    second.run(route(), async () => {}),
    ResourcePoolRouteError,
  );
  await assert.rejects(second.close(), ResourcePoolCleanupError);
  assert.equal(destroyed, 0);
  assert.equal(first.stats().closed, false);
  await first.close();
  assert.equal(destroyed, 1);
});
test('pooled adapter holds its lease through underlying cleanup, validates scope, and preserves types', async () => {
  const workDone = signal(),
    cleanup = signal();
  let destroyed = false;
  const pool = createTenantResourcePool({
    create: async () => ({ value: 'ok' }),
    destroy: async () => {
      destroyed = true;
    },
  });
  pool.setRoute(route());
  const adapter = createPooledAdapter({
    pool,
    name: 'test',
    capabilities: { transactions: true, isolationModes: ['database-policy'] },
    createAdapter: (resource): DatabaseAdapter<{ read(): string }> => ({
      name: 'test',
      capabilities: { transactions: true, isolationModes: ['database-policy'] },
      run: async (_context, _route, work) => {
        const result = await work({ read: () => resource.value });
        workDone.resolve();
        await cleanup.promise;
        return result;
      },
    }),
  });
  const request = adapter.run({ tenantId: 'Org_A' }, route(), async (client) =>
    client.read(),
  );
  await workDone.promise;
  pool.remove({ tenantId: 'Org_A' });
  await tick();
  assert.equal(destroyed, false);
  assert.equal(pool.stats().activeLeases, 1);
  cleanup.resolve();
  assert.equal(await request, 'ok');
  await pool.close();
  assert.equal(destroyed, true);
  await assert.rejects(
    adapter.run({ tenantId: 'foreign' }, route(), async () =>
      assert.fail('wrong scope'),
    ),
    ResourcePoolRouteError,
  );
});
test('admission bounds, invalid configuration and route checks fail before native construction', async () => {
  let calls = 0;
  const factory = deferred<object>();
  const options = {
    create: () => {
      calls++;
      return factory.promise;
    },
    destroy: async () => {},
  };
  for (const value of [0, -1, NaN, Infinity, 1.5])
    assert.throws(
      () => createTenantResourcePool({ ...options, maxResources: value }),
      RangeError,
    );
  const pool = createTenantResourcePool({ ...options, maxWaiters: 1 });
  assert.throws(
    () => pool.setRoute({ ...route(), status: 'suspended' }),
    ResourcePoolRouteError,
  );
  assert.throws(
    () => pool.setRoute({ ...route(), secretRef: '\n' }),
    ResourcePoolRouteError,
  );
  await assert.rejects(
    pool.run(route(), async () => {}),
    ResourcePoolRouteError,
  );
  pool.setRoute(route());
  const pending = assert.rejects(
    pool.run(route(), async () => {}),
    ResourcePoolClosedError,
  );
  await tick();
  await assert.rejects(
    pool.run(route(), async () => {}),
    ResourcePoolCapacityError,
  );
  assert.equal(calls, 1);
  const closing = pool.close();
  factory.resolve({});
  await pending;
  await closing;
});

test('shutdown deadline reports without force-closing active work and continues real draining', async () => {
  const entered = signal(),
    release = signal();
  let destroyed = 0;
  const pool = createTenantResourcePool({
    shutdownTimeoutMs: 10,
    create: async () => ({}),
    destroy: async () => {
      destroyed++;
    },
  });
  pool.setRoute(route());
  const active = pool.run(route(), async () => {
    entered.resolve();
    await release.promise;
    assert.equal(destroyed, 0);
    return 'finished';
  });
  await entered.promise;
  const close = pool.close();
  await assert.rejects(
    close,
    (error) =>
      error instanceof ResourcePoolTimeoutError && error.phase === 'shutdown',
  );
  assert.equal(pool.close(), close);
  assert.equal(pool.stats().activeLeases, 1);
  assert.equal(pool.stats().resources, 1);
  assert.equal(destroyed, 0);
  release.resolve();
  assert.equal(await active, 'finished');
  await until(() => pool.stats().resources === 0);
  assert.equal(destroyed, 1);
  await assert.rejects(close, ResourcePoolTimeoutError);
});
test('stalled destruction closes admission but keeps actual disposal counted until settlement', async () => {
  const gate = signal();
  const pool = createTenantResourcePool({
    destroyTimeoutMs: 5,
    shutdownTimeoutMs: 10,
    create: async () => ({}),
    destroy: () => gate.promise,
  });
  pool.setRoute(route());
  await pool.run(route(), async () => {});
  pool.remove({ tenantId: 'Org_A' });
  await until(() => pool.stats().closed);
  assert.equal(pool.stats().disposing, 1);
  assert.equal(pool.stats().resources, 1);
  await assert.rejects(pool.close(), ResourcePoolTimeoutError);
  gate.resolve();
  await until(() => pool.stats().resources === 0);
});
test('late factory completion after shutdown timeout is still owned and destroyed exactly once', async () => {
  const gate = deferred<object>();
  let destroyed = 0;
  const pool = createTenantResourcePool({
    shutdownTimeoutMs: 5,
    create: () => gate.promise,
    destroy: async () => {
      destroyed++;
    },
  });
  pool.setRoute(route());
  const request = assert.rejects(
    pool.run(route(), async () => assert.fail('late work')),
    ResourcePoolClosedError,
  );
  await tick();
  const closing = pool.close();
  await request;
  await assert.rejects(closing, ResourcePoolTimeoutError);
  assert.equal(pool.stats().creating, 1);
  gate.resolve({});
  await until(() => pool.stats().resources === 0);
  assert.equal(destroyed, 1);
});

test('reentrant clock cannot publish an expired factory result to another acquisition', async () => {
  let time = 0,
    callback = () => {},
    worked = 0,
    destroyed = 0;
  const gate = deferred<object>();
  let reentrant: Promise<void> | undefined;
  const pool = createTenantResourcePool({
    clock: () => {
      callback();
      return time;
    },
    createTimeoutMs: 1000,
    acquireTimeoutMs: 2000,
    create: () => gate.promise,
    destroy: async () => {
      destroyed++;
    },
  });
  pool.setRoute(route());
  const first = assert.rejects(
    pool.run(route(), async () => {
      worked++;
    }),
    ResourcePoolTimeoutError,
  );
  await tick();
  callback = () => {
    callback = () => {};
    reentrant = assert.rejects(
      pool.run(route(), async () => {
        worked++;
      }),
      ResourcePoolTimeoutError,
    );
  };
  time = 1000;
  gate.resolve({});
  await first;
  await reentrant;
  await pool.close();
  assert.equal(worked, 0);
  assert.equal(destroyed, 1);
});
test('factory publication rechecks terminal closure after a custom clock callback', async () => {
  let callback = () => {},
    destroyed = 0;
  const gate = deferred<object>();
  const pool = createTenantResourcePool({
    clock: () => {
      callback();
      return 0;
    },
    create: () => gate.promise,
    destroy: async () => {
      destroyed++;
    },
  });
  pool.setRoute(route());
  const first = assert.rejects(
    pool.run(route(), async () => assert.fail('closed publication')),
    ResourcePoolClosedError,
  );
  await tick();
  callback = () => {
    callback = () => {};
    void pool.close();
  };
  gate.resolve({});
  await first;
  await pool.close();
  assert.equal(destroyed, 1);
});

test('a dispatched factory returning undefined after shutdown is not mistaken for skipped work', async () => {
  const gate = deferred<object>();
  const pool = createTenantResourcePool({
    create: () => gate.promise,
    destroy: async () => assert.fail('unknown native handle'),
    shutdownTimeoutMs: 1000,
  });
  pool.setRoute(route());
  const request = assert.rejects(
    pool.run(route(), async () => assert.fail('invalid resource')),
    ResourcePoolClosedError,
  );
  await tick();
  const closing = pool.close();
  await request;
  gate.resolve(undefined as unknown as object);
  await assert.rejects(closing, ResourcePoolCleanupError);
  assert.equal(pool.stats().closed, true);
  assert.equal(pool.stats().resources, 0);
});

test('late retired factory settlement cannot reject a fresh factory for the same route revision', async () => {
  for (const outcome of ['success', 'failure']) {
    let time = 0,
      calls = 0,
      destroyed = 0;
    const old = deferred<{ value: string }>(),
      fresh = deferred<{ value: string }>();
    const pool = createTenantResourcePool({
      maxResources: 2,
      maxResourcesPerTenant: 2,
      clock: () => time,
      createTimeoutMs: 1000,
      acquireTimeoutMs: 5000,
      create: () => (++calls === 1 ? old.promise : fresh.promise),
      destroy: async () => {
        destroyed++;
      },
    });
    pool.setRoute(route());
    const initial = assert.rejects(
      pool.run(route(), async () => assert.fail('expired first factory')),
      ResourcePoolTimeoutError,
    );
    await tick();
    time = 1000;
    pool.sweep();
    await initial;
    const replacement = pool
      .run(route(), async (resource) => resource.value)
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    await tick();
    assert.equal(calls, 2);
    if (outcome === 'success') old.resolve({ value: 'old' });
    else old.reject(new Error('old native factory failed'));
    await tick();
    fresh.resolve({ value: 'fresh' });
    assert.deepEqual(await replacement, { value: 'fresh' });
    await pool.close();
    assert.equal(destroyed, outcome === 'success' ? 2 : 1);
  }
});

test('queued leases resume in each caller context rather than the factory or releasing request', async () => {
  const trace = new AsyncLocalStorage<string>();
  const pool = createTenantResourcePool({
    maxLeasesPerResource: 1,
    create: async () => {
      await delay(2);
      return {};
    },
    destroy: async () => {},
  });
  pool.setRoute(route());
  pool.setRoute(route('B'));
  try {
    await Promise.all(
      Array.from({ length: 24 }, (_, i) => {
        const tenantId = i % 2 ? 'B' : 'Org_A';
        const context = {
          tenantId,
          principalId: 'principal-' + i,
          correlationId: 'request-' + i,
        };
        return trace.run('trace-' + i, () =>
          runWithContext(context, () =>
            pool.run(route(tenantId), async () => {
              assert.deepEqual(requireTenant(), context);
              assert.equal(trace.getStore(), 'trace-' + i);
              await delay(1);
              assert.deepEqual(requireTenant(), context);
              assert.equal(trace.getStore(), 'trace-' + i);
            }),
          ),
        );
      }),
    );
    assert.equal(getTenant(), undefined);
    assert.equal(trace.getStore(), undefined);
  } finally {
    await pool.close();
  }
});
