import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTenantContext,
  createTenantGuard,
  createTenantRouter,
  TenantAuthorizationError,
  type DatabaseAdapter,
  type TenantRoute,
  type TenantRegistry,
} from '../packages/core/src/index.js';
import { createNodeContextCarrier } from '../packages/node/src/index.js';
import { assertTenantIsolation } from '../packages/testing/src/index.js';

test('opaque IDs retain case and metadata is immutable and copied', () => {
  const input = { tenantId: 'Org_A', principalId: 'User_1' };
  const context = createTenantContext(input);
  input.tenantId = 'changed';
  assert.equal(context.tenantId, 'Org_A');
  assert.ok(Object.isFrozen(context));
  for (const tenantId of [
    '',
    ' leading',
    'trailing ',
    'line\nfeed',
    'a'.repeat(257),
  ])
    assert.throws(() => createTenantContext({ tenantId }));
});
test('portable explicit authorization works without ambient state', async () => {
  const guard = createTenantGuard<string>({
    authorize: (principal) =>
      principal === 'member'
        ? { tenantId: 'Org_A', principalId: principal }
        : undefined,
  });
  await assert.rejects(
    () => guard.run('outsider', () => assert.fail('handler must not run')),
    TenantAuthorizationError,
  );
  assert.equal(
    await guard.run('member', async (context) => context.tenantId),
    'Org_A',
  );
  await assert.rejects(
    () =>
      guard.run('member', () => {
        throw new Error('business failure');
      }),
    /business failure/,
  );
});
test('authorizer outages propagate and invalid authorized output fails closed', async () => {
  await assert.rejects(
    () =>
      createTenantGuard({
        authorize: () => {
          throw new Error('identity provider unavailable');
        },
      }).run({}, () => {}),
    /identity provider/,
  );
  await assert.rejects(
    () =>
      createTenantGuard({ authorize: () => ({ tenantId: '' }) }).run(
        {},
        () => {},
      ),
    TypeError,
  );
});
test('independent Node carriers isolate concurrent tenant scopes and reject principal switches', async () => {
  const carrier = createNodeContextCarrier();
  const other = createNodeContextCarrier();
  const guard = createTenantGuard({
    carrier,
    authorize: (tenantId: string) => ({ tenantId, principalId: 'user' }),
  });
  await Promise.all(
    ['Org_A', 'org_a'].map((id) =>
      guard.run(id, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(carrier.get()?.tenantId, id);
        assert.equal(other.get(), undefined);
        assert.throws(
          () => carrier.run({ tenantId: id, principalId: 'other' }, () => {}),
          /switch/,
        );
        await assert.rejects(
          () => guard.run(id === 'Org_A' ? 'org_a' : 'Org_A', () => {}),
          /switch/,
        );
      }),
    ),
  );
  assert.equal(carrier.get(), undefined);
});
test('case-sensitive isolation assertions detect IDs differing only by case', async () => {
  await assert.rejects(
    () =>
      assertTenantIsolation({
        tenantA: 'Org_A',
        tenantB: 'org_a',
        read: async () => [{ id: 'Org_A' }],
        tenantOf: (row) => row.id,
      }),
    /exposure/,
  );
});

function fixture() {
  const calls: string[] = [];
  const sql: DatabaseAdapter<{ query: () => string }> = {
    name: 'sql-test',
    capabilities: { isolationModes: ['database-policy'], transactions: true },
    async run(context, route, work) {
      calls.push(`${context.tenantId}:${route.resource}`);
      return work({ query: () => 'sql' });
    },
  };
  const document: DatabaseAdapter<{ find: () => string }> = {
    name: 'document-test',
    capabilities: {
      isolationModes: ['application-filter'],
      transactions: false,
    },
    async run(context, route, work) {
      calls.push(`${context.tenantId}:${route.resource}`);
      return work({ find: () => 'document' });
    },
  };
  const routes: Record<string, TenantRoute> = {
    orders: {
      tenantId: 'Org_A',
      source: 'orders',
      adapter: sql.name,
      resource: 'orders-pool',
      revision: '1',
      status: 'active',
      mode: 'database-policy',
    },
    events: {
      tenantId: 'Org_A',
      source: 'events',
      adapter: document.name,
      resource: 'events-pool',
      revision: '1',
      status: 'active',
      mode: 'application-filter',
    },
  };
  const registry: TenantRegistry = {
    resolve: async (_context, source) => routes[source],
  };
  const sources = {
    orders: { adapter: sql, mode: 'database-policy' as const },
    events: { adapter: document, mode: 'application-filter' as const },
  };
  return { calls, routes, sources, registry };
}
test('one tenant can route to heterogeneous typed clients without a database dependency in core', async () => {
  const f = fixture();
  const router = createTenantRouter({
    registry: f.registry,
    sources: f.sources,
  });
  const context = createTenantContext({ tenantId: 'Org_A' });
  assert.equal(
    await router.run(context, 'orders', async (client) => client.query()),
    'sql',
  );
  assert.equal(
    await router.run(context, 'events', async (client) => client.find()),
    'document',
  );
  assert.deepEqual(f.calls, ['Org_A:orders-pool', 'Org_A:events-pool']);
});
test('router rejects an unsupported enforcement mode and strict-mode downgrade at startup', () => {
  const f = fixture();
  assert.throws(
    () =>
      createTenantRouter({
        registry: f.registry,
        sources: f.sources,
        strict: true,
      }),
    /Strict/,
  );
  assert.throws(
    () =>
      createTenantRouter({
        registry: f.registry,
        sources: {
          orders: {
            adapter: f.sources.orders.adapter,
            mode: 'database-per-tenant',
          },
        },
      }),
    /Unsupported/,
  );
});
for (const mismatch of [
  'tenantId',
  'source',
  'adapter',
  'mode',
  'status',
  'resource',
  'revision',
] as const) {
  test(`router fails closed on invalid route ${mismatch} before adapter execution`, async () => {
    const f = fixture();
    const route = f.routes.orders!;
    Object.assign(route, {
      [mismatch]:
        mismatch === 'status'
          ? 'suspended'
          : mismatch === 'mode'
            ? 'application-filter'
            : '',
    });
    const router = createTenantRouter({
      registry: f.registry,
      sources: f.sources,
    });
    await assert.rejects(() =>
      router.run({ tenantId: 'Org_A' }, 'orders', async () => {}),
    );
    assert.deepEqual(f.calls, []);
  });
}
test('missing routes deny access; registry and adapter errors propagate', async () => {
  const f = fixture();
  delete f.routes.orders;
  const router = createTenantRouter({
    registry: f.registry,
    sources: f.sources,
  });
  await assert.rejects(
    () => router.run({ tenantId: 'Org_A' }, 'orders', async () => {}),
    /No tenant route/,
  );
  f.registry.resolve = async () => {
    throw new Error('registry offline');
  };
  await assert.rejects(
    () => router.run({ tenantId: 'Org_A' }, 'orders', async () => {}),
    /registry offline/,
  );
});
test('router snapshots tenant before awaiting mutable registry state', async () => {
  const f = fixture();
  const context = { tenantId: 'Org_A' };
  f.registry.resolve = async (snapshot) => {
    context.tenantId = 'attacker';
    assert.ok(Object.isFrozen(snapshot));
    return f.routes.orders;
  };
  const router = createTenantRouter({
    registry: f.registry,
    sources: f.sources,
  });
  await router.run(context, 'orders', async () => {});
  assert.deepEqual(f.calls, ['Org_A:orders-pool']);
});
