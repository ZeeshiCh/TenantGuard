import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createCachedTenantRegistry,
  RegistryCacheCapacityError,
  RegistryCacheClosedError,
  RegistryCacheInvalidatedError,
  RegistryCacheTimeoutError,
} from '../packages/registry/src/index.js';
import {
  TenantRoutingError,
  type TenantRoute,
} from '../packages/core/src/index.js';
const context = { tenantId: 'Org_A', principalId: 'alice' };
const route = (
  revision = '1',
  source = 'orders',
  tenantId = context.tenantId,
): TenantRoute => ({
  tenantId,
  source,
  adapter: 'test',
  resource: 'pool-' + revision,
  revision,
  status: 'active',
  mode: 'database-policy',
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tick = () => delay(0);

test('registry coalesces a concurrent lookup, snapshots/freeze routes and starts TTL at settlement', async () => {
  let time = 0,
    calls = 0;
  const upstream = deferred<TenantRoute>();
  const cache = createCachedTenantRegistry({
    registry: {
      resolve: () => {
        calls++;
        return upstream.promise;
      },
    },
    clock: () => time,
    ttlMs: 10,
  });
  const mutable = route();
  const requests = Array.from({ length: 100 }, () =>
    cache.resolve(context, 'orders'),
  );
  await tick();
  assert.equal(calls, 1);
  time = 100;
  upstream.resolve(mutable);
  const results = await Promise.all(requests);
  assert(results.every((value) => value === results[0]));
  assert(Object.isFrozen(results[0]));
  Object.assign(mutable, { resource: 'mutated' });
  time = 109;
  assert.equal((await cache.resolve(context, 'orders'))!.resource, 'pool-1');
  assert.equal(calls, 1);
  time = 110;
  await cache.resolve(context, 'orders');
  assert.equal(calls, 2);
  await cache.close();
});
test('registry keys include principal, correlation and source without delimiter collisions', async () => {
  let calls = 0;
  const cache = createCachedTenantRegistry({
    registry: {
      resolve: async (c, s) => {
        calls++;
        return route(c.principalId ?? 'none', s, c.tenantId);
      },
    },
  });
  const contexts = [
    context,
    { ...context, principalId: 'bob' },
    { ...context, correlationId: 'request-1' },
    { ...context, correlationId: 'request-2' },
    { tenantId: 'org_a' },
    { tenantId: 'a|b', principalId: 'c' },
    { tenantId: 'a', principalId: 'b|c' },
  ];
  for (const c of contexts)
    for (const source of ['orders', 'audit']) await cache.resolve(c, source);
  for (const c of contexts)
    for (const source of ['orders', 'audit']) await cache.resolve(c, source);
  assert.equal(calls, contexts.length * 2);
  await cache.close();
});
test('registry evicts least recently used entries and lazily expires bounded storage', async () => {
  let time = 0,
    calls = 0;
  const cache = createCachedTenantRegistry({
    registry: {
      resolve: async (c, s) => {
        calls++;
        return route('1', s, c.tenantId);
      },
    },
    maxEntries: 2,
    ttlMs: 10,
    clock: () => time,
  });
  await cache.resolve(context, 'a');
  await cache.resolve(context, 'b');
  await cache.resolve(context, 'a');
  await cache.resolve(context, 'c');
  assert.equal(cache.stats().entries, 2);
  await cache.resolve(context, 'a');
  assert.equal(calls, 3);
  await cache.resolve(context, 'b');
  assert.equal(calls, 4);
  time = 10;
  await cache.resolve(context, 'c');
  assert.equal(cache.stats().entries, 1);
  await cache.close();
  assert.equal(cache.stats().entries, 0);
});
test('registry missing routes are uncached by default and optional negative TTL expires', async () => {
  for (const negativeTtlMs of [0, 10]) {
    let calls = 0,
      time = 0;
    const cache = createCachedTenantRegistry({
      registry: {
        resolve: async () => {
          calls++;
          return undefined;
        },
      },
      negativeTtlMs,
      clock: () => time,
    });
    await cache.resolve(context, 'orders');
    await tick();
    await cache.resolve(context, 'orders');
    assert.equal(calls, negativeTtlMs ? 1 : 2);
    time = 10;
    await tick();
    await cache.resolve(context, 'orders');
    assert.equal(calls, negativeTtlMs ? 2 : 3);
    await cache.close();
  }
});
test('registry never caches provider failures, including synchronous throws', async () => {
  const failure = new Error('provider failed');
  let calls = 0;
  const cache = createCachedTenantRegistry({
    registry: {
      resolve: () => {
        calls++;
        throw failure;
      },
    },
  });
  for (let i = 0; i < 2; i++) {
    await assert.rejects(
      cache.resolve(context, 'orders'),
      (error) => error === failure,
    );
    await tick();
  }
  assert.equal(calls, 2);
  await cache.close();
});
test('registry rejects cross-tenant/source and malformed routes before caching', async () => {
  for (const value of [
    route('1', 'orders', 'foreign'),
    route('1', 'other'),
    { ...route(), resource: '' },
    { ...route(), revision: '' },
    { ...route(), secretRef: '\n' },
    { ...route(), status: 'unknown' },
    { ...route(), mode: 'unknown' },
  ]) {
    const cache = createCachedTenantRegistry({
      registry: { resolve: async () => value as TenantRoute },
    });
    await assert.rejects(cache.resolve(context, 'orders'), TenantRoutingError);
    assert.equal(cache.stats().entries, 0);
    await cache.close();
  }
});
test('registry invalidates cached variants by tenant/source and can clear globally', async () => {
  let calls = 0;
  const cache = createCachedTenantRegistry({
    registry: {
      resolve: async (c, s) => {
        calls++;
        return route(String(calls), s, c.tenantId);
      },
    },
  });
  for (const principalId of ['alice', 'bob'])
    for (const source of ['orders', 'audit'])
      await cache.resolve({ ...context, principalId }, source);
  await cache.resolve({ tenantId: 'other' }, 'orders');
  cache.invalidate({ tenantId: context.tenantId, source: 'orders' });
  assert.equal(cache.stats().entries, 3);
  cache.invalidate({ tenantId: context.tenantId });
  assert.equal(cache.stats().entries, 1);
  cache.clear();
  assert.equal(cache.stats().entries, 0);
  await cache.close();
});
test('invalidation rejects every waiter and late older revisions cannot replace a fresh load', async () => {
  const old = deferred<TenantRoute>();
  let calls = 0;
  const cache = createCachedTenantRegistry({
    registry: {
      resolve: async () => (++calls === 1 ? old.promise : route('2')),
    },
  });
  const requests = Array.from({ length: 50 }, () =>
    cache.resolve(context, 'orders'),
  );
  const checks = requests.map((request) =>
    assert.rejects(request, RegistryCacheInvalidatedError),
  );
  await tick();
  cache.invalidate({ tenantId: context.tenantId });
  await Promise.all(checks);
  assert.equal(cache.stats().pending, 1);
  assert.equal((await cache.resolve(context, 'orders'))!.revision, '2');
  old.resolve(route('1'));
  await tick();
  assert.equal((await cache.resolve(context, 'orders'))!.revision, '2');
  assert.equal(calls, 2);
  await cache.close();
});
test('timeouts retain real pending capacity; late failures are consumed and uncached', async () => {
  const old = deferred<TenantRoute>();
  const cache = createCachedTenantRegistry({
    registry: { resolve: () => old.promise },
    maxPending: 1,
    lookupTimeoutMs: 5,
  });
  await assert.rejects(
    cache.resolve(context, 'orders'),
    RegistryCacheTimeoutError,
  );
  assert.equal(cache.stats().pending, 1);
  await assert.rejects(
    cache.resolve(context, 'orders'),
    RegistryCacheCapacityError,
  );
  cache.clear();
  assert.equal(cache.stats().pending, 1);
  old.reject(new Error('late provider failure'));
  await tick();
  assert.equal(cache.stats().pending, 0);
  assert.equal(cache.stats().entries, 0);
  await cache.close();
});
test('invalidation storms cannot bypass actual lookup capacity', async () => {
  const old = deferred<TenantRoute>();
  const cache = createCachedTenantRegistry({
    registry: { resolve: () => old.promise },
    maxPending: 1,
  });
  const first = assert.rejects(
    cache.resolve(context, 'orders'),
    RegistryCacheInvalidatedError,
  );
  await tick();
  cache.clear();
  await first;
  for (let i = 0; i < 20; i++) {
    cache.clear();
    await assert.rejects(
      cache.resolve(context, 'orders'),
      RegistryCacheCapacityError,
    );
  }
  old.resolve(route());
  await cache.close();
});
test('close is terminal/idempotent, immediately rejects waiters and drains real operations', async () => {
  const old = deferred<TenantRoute>();
  const cache = createCachedTenantRegistry({
    registry: { resolve: () => old.promise },
  });
  const first = assert.rejects(
    cache.resolve(context, 'orders'),
    RegistryCacheClosedError,
  );
  await tick();
  const close = cache.close();
  assert.equal(cache.close(), close);
  let done = false;
  void close.then(() => {
    done = true;
  });
  await first;
  await tick();
  assert.equal(done, false);
  assert.equal(cache.stats().pending, 1);
  await assert.rejects(
    cache.resolve(context, 'orders'),
    RegistryCacheClosedError,
  );
  assert.throws(() => cache.clear(), RegistryCacheClosedError);
  assert.throws(
    () => cache.invalidate({ tenantId: context.tenantId }),
    RegistryCacheClosedError,
  );
  old.resolve(route());
  await close;
  assert.equal(cache.stats().pending, 0);
  assert.equal(cache.stats().entries, 0);
});
test('closing or invalidating before dispatch prevents new upstream work', async () => {
  let calls = 0;
  const cache = createCachedTenantRegistry({
    registry: {
      resolve: async () => {
        calls++;
        return route();
      },
    },
  });
  const result = assert.rejects(
    cache.resolve(context, 'orders'),
    RegistryCacheClosedError,
  );
  await cache.close();
  await result;
  assert.equal(calls, 0);
});
test('registry validates bounds, inputs and monotonic clocks', async () => {
  const registry = { resolve: async () => route() };
  for (const value of [NaN, Infinity, -1, 0, 1.5]) {
    assert.throws(
      () => createCachedTenantRegistry({ registry, ttlMs: value }),
      RangeError,
    );
    assert.throws(
      () => createCachedTenantRegistry({ registry, maxEntries: value }),
      RangeError,
    );
    assert.throws(
      () => createCachedTenantRegistry({ registry, maxPending: value }),
      RangeError,
    );
    assert.throws(
      () => createCachedTenantRegistry({ registry, lookupTimeoutMs: value }),
      RangeError,
    );
  }
  assert.throws(
    () => createCachedTenantRegistry({ registry, negativeTtlMs: -1 }),
    RangeError,
  );
  let time = 1;
  const cache = createCachedTenantRegistry({ registry, clock: () => time });
  await assert.rejects(cache.resolve({ tenantId: ' ' }, 'orders'));
  await assert.rejects(cache.resolve(context, ''), TenantRoutingError);
  assert.throws(() => cache.invalidate({ tenantId: '' }));
  time = 0;
  await assert.rejects(cache.resolve(context, 'orders'), RangeError);
  await cache.close();
});

test('settled lookups release capacity before the next sequential lookup', async () => {
  let calls = 0;
  const cache = createCachedTenantRegistry({
    maxPending: 1,
    registry: {
      resolve: async () => {
        calls++;
        return undefined;
      },
    },
  });
  for (let i = 0; i < 10; i++) await cache.resolve(context, 'orders');
  assert.equal(calls, 10);
  assert.equal(cache.stats().pending, 0);
  await cache.close();
});
test('reentrant route accessors cannot repopulate an invalidated or closed cache', async () => {
  for (const close of [false, true]) {
    const value = route();
    const cache = createCachedTenantRegistry({
      registry: { resolve: async () => value },
    });
    Object.defineProperty(value, 'resource', {
      get() {
        if (close) void cache.close();
        else cache.clear();
        return 'pool';
      },
    });
    await assert.rejects(
      cache.resolve(context, 'orders'),
      close ? RegistryCacheClosedError : RegistryCacheInvalidatedError,
    );
    await cache.close();
    assert.equal(cache.stats().entries, 0);
  }
});
test('reentrant clock closure cannot admit a new lookup or insert an old result', async () => {
  let callback = () => {};
  let calls = 0;
  const cache = createCachedTenantRegistry({
    clock: () => {
      callback();
      return 0;
    },
    registry: {
      resolve: async () => {
        calls++;
        return route();
      },
    },
  });
  callback = () => {
    void cache.close();
  };
  await assert.rejects(
    cache.resolve(context, 'orders'),
    RegistryCacheClosedError,
  );
  assert.equal(calls, 0);
  await cache.close();
});
