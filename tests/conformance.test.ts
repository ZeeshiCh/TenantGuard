import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTenantContext } from '../packages/core/src/index.js';
import {
  adapterConformanceCases,
  type AdapterConformanceFixture,
  type ConformanceRecord,
} from '../packages/testing/src/conformance.js';

function harness(
  options: {
    leakReads?: boolean;
    persistFailure?: boolean;
    cleanupFailure?: boolean;
  } = {},
) {
  const tenantA = { tenantId: 'Org_A' },
    tenantB = { tenantId: 'org_a' };
  const seedA = { id: 'seed-a', tenantId: tenantA.tenantId, value: 'a' },
    seedB = { id: 'seed-b', tenantId: tenantB.tenantId, value: 'b' };
  type Client = { tenantId: string; rows: Map<string, ConformanceRecord> };
  let closed = 0;
  const createFixture = async (): Promise<
    AdapterConformanceFixture<Client>
  > => {
    let rows = new Map([seedA, seedB].map((row) => [row.id, row]));
    return {
      tenantA,
      tenantB,
      seedA,
      seedB,
      adapter: {
        name: 'harness-only',
        capabilities: {
          isolationModes: ['application-filter'],
          transactions: true,
        },
        async run(context, route, work) {
          createTenantContext(context);
          if (context.tenantId !== route.tenantId)
            throw new Error('Route mismatch');
          const copy = new Map(rows);
          try {
            const result = await work({
              tenantId: context.tenantId,
              rows: copy,
            });
            rows = copy;
            return result;
          } catch (error) {
            if (options.persistFailure) rows = copy;
            throw error;
          }
        },
      },
      route: (context) => ({
        tenantId: context.tenantId,
        source: 'test',
        adapter: 'harness-only',
        resource: 'test',
        revision: '1',
        status: 'active',
        mode: 'application-filter',
      }),
      read: async (client, id) =>
        [...client.rows.values()].filter(
          (row) =>
            (!id || row.id === id) &&
            (options.leakReads || row.tenantId === client.tenantId),
        ),
      insert: async (client, row) => {
        if (row.tenantId !== client.tenantId) throw new Error('Foreign insert');
        client.rows.set(row.id, row);
      },
      update: async (client, id, changes) => {
        const row = client.rows.get(id);
        if (!row || row.tenantId !== client.tenantId) return 0;
        if (changes.tenantId && changes.tenantId !== client.tenantId)
          throw new Error('Reassignment');
        client.rows.set(id, { ...row, ...changes });
        return 1;
      },
      delete: async (client, id) => {
        if (client.rows.get(id)?.tenantId !== client.tenantId) return 0;
        client.rows.delete(id);
        return 1;
      },
      close: async () => {
        closed++;
        if (options.cleanupFailure) throw new Error('cleanup');
      },
    };
  };
  return { createFixture, closed: () => closed };
}
for (const conformance of adapterConformanceCases({
  ...harness(),
  transactional: true,
}))
  test(`harness: ${conformance.name}`, conformance.run);
test('conformance harness detects leaks and cleans up failed fixtures', async () => {
  const f = harness({ leakReads: true });
  const [visibility] = adapterConformanceCases({ ...f, transactional: true });
  await assert.rejects(visibility!.run, /visibility/);
  assert.equal(f.closed(), 1);
});
test('conformance harness detects adapters that fail to roll back', async () => {
  const cases = adapterConformanceCases({
    ...harness({ persistFailure: true }),
    transactional: true,
  });
  await assert.rejects(
    cases.find((c) => c.name.includes('rolls back'))!.run,
    /persisted/,
  );
});
test('conformance harness preserves both assertion and cleanup errors', async () => {
  const [visibility] = adapterConformanceCases({
    ...harness({ leakReads: true, cleanupFailure: true }),
    transactional: false,
  });
  await assert.rejects(
    visibility!.run,
    (error) => error instanceof AggregateError && error.errors.length === 2,
  );
});
