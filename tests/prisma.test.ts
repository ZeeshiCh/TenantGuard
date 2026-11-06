import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPrismaAdapter,
  createPrismaResource,
  PrismaLifecycleError,
  PrismaTimeoutError,
  type PrismaClientLike,
} from '../packages/prisma/src/index.js';
import type { TenantRoute } from '../packages/core/src/index.js';
import { verifyPrismaModels } from '../packages/prisma/src/metadata.js';
import { validateModel } from '../packages/prisma/src/guards.js';
const datamodel = {
  models: [
    {
      name: 'Order',
      dbName: 'orders',
      fields: ['id', 'tenantId', 'value'].map((name) => ({
        name,
        kind: 'scalar',
        type: 'String',
        isList: false,
        isRequired: true,
      })),
    },
  ],
};
const models = {
  orders: {
    model: 'Order',
    tenantField: 'tenantId',
    idField: 'id',
    fields: ['id', 'tenantId', 'value'],
  },
};
const context = { tenantId: 'Org_A' },
  route: TenantRoute = {
    tenantId: 'Org_A',
    adapter: 'prisma',
    source: 'orders',
    resource: 'main',
    revision: '1',
    status: 'active',
    mode: 'application-filter',
  };
function fake(
  options: {
    commitFail?: boolean;
    disconnectFail?: boolean;
    hangTransaction?: boolean;
    hangFind?: boolean;
    hangDisconnect?: boolean;
    foreign?: boolean;
  } = {},
) {
  const events: string[] = [];
  let factoryCalls = 0;
  const resource = createPrismaResource({
    provider: 'postgresql',
    datamodel,
    createClient: () => {
      factoryCalls++;
      const client: PrismaClientLike = {
        async $transaction(work, settings) {
          events.push('begin');
          assert.deepEqual(settings, {
            maxWait: 5000,
            timeout: 30000,
            isolationLevel: 'Serializable',
          });
          try {
            const result = await work({
              $queryRawUnsafe: async () => [{ safe: true }],
              order: {
                findMany: async () => {
                  events.push('find');
                  if (options.hangFind) await new Promise(() => {});
                  return options.foreign ? [{ tenantId: 'other' }] : [];
                },
                create: async () => {
                  events.push('insert');
                },
                updateMany: async () => ({ count: 1 }),
                deleteMany: async () => ({ count: 1 }),
              },
            });
            if (options.hangTransaction) await new Promise(() => {});
            if (options.commitFail) throw Error('commit lost');
            events.push('commit');
            return result;
          } catch (error) {
            events.push('rollback');
            throw error;
          }
        },
        async $disconnect() {
          events.push('disconnect');
          if (options.hangDisconnect) await new Promise(() => {});
          if (options.disconnectFail) throw Error('disconnect failed');
        },
      };
      return client;
    },
  });
  const adapter = createPrismaAdapter({
    resolveResource: () => resource,
    models,
    operationTimeoutMs: 20,
    cleanupTimeoutMs: 10,
  });
  return {
    resource,
    adapter,
    events,
    get factoryCalls() {
      return factoryCalls;
    },
  };
}
test('Prisma callback owns a transaction, closes facade and disconnects its client', async () => {
  const f = fake();
  let escaped!: import('../packages/prisma/src/index.js').PrismaRepository;
  await f.adapter.run(context, route, async (c) => {
    escaped = c.model('orders');
    await escaped.find();
  });
  await assert.rejects(() => escaped.find(), /outside/);
  assert.deepEqual(f.events, ['begin', 'find', 'commit', 'disconnect']);
  await f.adapter.run(context, route, async () => {});
  assert.equal(f.factoryCalls, 2);
  await f.resource.close();
});
test('Prisma preserves callback error identity after rollback and disconnection', async () => {
  const f = fake(),
    sentinel = Error('business');
  await assert.rejects(
    () =>
      f.adapter.run(context, route, async () => {
        throw sentinel;
      }),
    (e) => e === sentinel,
  );
  assert.deepEqual(f.events, ['begin', 'rollback', 'disconnect']);
});
test('Prisma caught validation errors poison preceding writes', async () => {
  const f = fake();
  await assert.rejects(
    () =>
      f.adapter.run(context, route, async (c) => {
        const repo = c.model('orders');
        await repo.insert({ id: 'a' });
        await repo.update({ id: 'a' }, { tenantId: 'other' }).catch(() => {});
      }),
    /immutable/,
  );
  assert.deepEqual(f.events, ['begin', 'insert', 'rollback', 'disconnect']);
});
test('Prisma commit rejection is unknown and business work is never rerun', async () => {
  const f = fake({ commitFail: true });
  let calls = 0;
  await assert.rejects(
    () =>
      f.adapter.run(context, route, async () => {
        calls++;
      }),
    (e) => e instanceof PrismaLifecycleError && e.commitOutcome === 'unknown',
  );
  assert.equal(calls, 1);
  assert.equal(f.events.at(-1), 'disconnect');
});
test('Prisma disconnect failure after success reports committed and retires resource', async () => {
  const f = fake({ disconnectFail: true });
  await assert.rejects(
    () => f.adapter.run(context, route, async () => {}),
    (e) => e instanceof PrismaLifecycleError && e.commitOutcome === 'committed',
  );
  assert.ok(f.resource.closed);
});
test('Prisma work deadlines stop hanging callbacks, roll back and revoke facades', async () => {
  const f = fake();
  let escaped!: import('../packages/prisma/src/index.js').PrismaRepository;
  await assert.rejects(
    () =>
      f.adapter.run(context, route, async (c) => {
        escaped = c.model('orders');
        await new Promise(() => {});
      }),
    PrismaTimeoutError,
  );
  await assert.rejects(() => escaped.find(), /outside/);
  assert.deepEqual(f.events, ['begin', 'rollback', 'disconnect']);
});
test('Prisma request timeouts poison caught native failures', async () => {
  const f = fake({ hangFind: true });
  const adapter = createPrismaAdapter({
    resolveResource: () => f.resource,
    models,
    requestTimeoutMs: 5,
  });
  await assert.rejects(
    () =>
      adapter.run(context, route, async (c) => {
        await c
          .model('orders')
          .find()
          .catch(() => {});
      }),
    PrismaTimeoutError,
  );
  assert.ok(!f.events.includes('commit'));
  assert.equal(f.events.at(-1), 'disconnect');
});
test('Prisma invalid contexts/routes and nested scopes never acquire extra clients', async () => {
  const f = fake();
  await assert.rejects(() =>
    f.adapter.run({ tenantId: '' }, route, async () => {}),
  );
  await assert.rejects(() =>
    f.adapter.run(context, { ...route, tenantId: 'other' }, async () => {}),
  );
  assert.equal(f.factoryCalls, 0);
  await f.adapter.run(context, route, async () => {
    await assert.rejects(
      () => f.adapter.run(context, route, async () => {}),
      /Nested/,
    );
  });
  assert.equal(f.factoryCalls, 1);
});
test('Prisma unawaited writes cannot commit', async () => {
  const f = fake();
  await assert.rejects(
    () =>
      f.adapter.run(context, route, async (c) => {
        void c.model('orders').insert({ id: 'unawaited' });
      }),
    /Unawaited/,
  );
  assert.ok(!f.events.includes('commit'));
});
test('Prisma client factories cannot reuse instances across scopes', async () => {
  const client: PrismaClientLike = {
    $transaction: async (work) =>
      work({ $queryRawUnsafe: async () => [{ safe: true }] }),
    $disconnect: async () => {},
  };
  const resource = createPrismaResource({
    provider: 'postgresql',
    datamodel,
    createClient: () => client,
  });
  const adapter = createPrismaAdapter({
    resolveResource: () => resource,
    models,
  });
  await adapter.run(context, route, async () => {});
  await assert.rejects(
    () => adapter.run(context, route, async () => {}),
    /reuse/,
  );
});
test('Prisma mismatched returned ownership fails closed', async () => {
  const f = fake({ foreign: true });
  await assert.rejects(
    () => f.adapter.run(context, route, (c) => c.model('orders').find()),
    /foreign tenant/,
  );
  assert.ok(f.events.includes('rollback'));
});
test('Prisma stalled disconnection is bounded and resource becomes terminal', async () => {
  const f = fake({ hangDisconnect: true });
  await assert.rejects(
    () => f.adapter.run(context, route, async () => {}),
    (e) => e instanceof PrismaLifecycleError && e.commitOutcome === 'committed',
  );
  assert.ok(f.resource.closed);
});
test('Prisma metadata refuses unsafe MySQL collations and PostgreSQL schemas', async () => {
  const model = validateModel(models.orders!, datamodel);
  for (const row of [{ safe: false }, { safe: null }])
    await assert.rejects(() =>
      verifyPrismaModels(
        { $queryRawUnsafe: async <T>() => [row] as T },
        'postgresql',
        [model],
      ),
    );
  const safe = {
    engine: 'InnoDB',
    table_type: 'BASE TABLE',
    data_type: 'varchar',
    nullable: 'NO',
    collation_name: 'utf8mb4_0900_bin',
    extra: '',
  };
  await verifyPrismaModels(
    { $queryRawUnsafe: async <T>() => [safe] as T },
    'mysql',
    [model],
  );
  for (const bad of [
    { collation_name: 'utf8mb4_bin' },
    { collation_name: 'utf8mb4_general_ci' },
    { engine: 'MyISAM' },
    { table_type: 'VIEW' },
    { nullable: 'YES' },
    { extra: 'STORED GENERATED' },
  ])
    await assert.rejects(() =>
      verifyPrismaModels(
        { $queryRawUnsafe: async <T>() => [{ ...safe, ...bad }] as T },
        'mysql',
        [model],
      ),
    );
});
test('Prisma unsettled commit retires the resource with unknown outcome', async () => {
  let calls = 0,
    disconnects = 0;
  const resource = createPrismaResource({
    provider: 'postgresql',
    datamodel,
    createClient: () => ({
      $transaction: async (work) => {
        const value = await work({
          $queryRawUnsafe: async () => [{ safe: true }],
        });
        await new Promise(() => {});
        return value;
      },
      $disconnect: async () => {
        disconnects++;
      },
    }),
  });
  const adapter = createPrismaAdapter({
    resolveResource: () => resource,
    models,
    maxWaitMs: 5,
    transactionTimeoutMs: 20,
    operationTimeoutMs: 10,
    cleanupTimeoutMs: 5,
  });
  await assert.rejects(
    () =>
      adapter.run(context, route, async () => {
        calls++;
      }),
    (e) => e instanceof PrismaLifecycleError && e.commitOutcome === 'unknown',
  );
  assert.equal(calls, 1);
  assert.equal(disconnects, 1);
  assert.ok(resource.closed);
});
test('Prisma late factories disconnect their client without starting transactions', async () => {
  let resolve!: (client: PrismaClientLike) => void,
    disconnects = 0,
    transactions = 0;
  const resource = createPrismaResource({
    provider: 'postgresql',
    datamodel,
    createClient: () =>
      new Promise((r) => {
        resolve = r;
      }),
  });
  const adapter = createPrismaAdapter({
    resolveResource: () => resource,
    models,
    maxWaitMs: 10,
  });
  await assert.rejects(
    () =>
      adapter.run(context, route, async () => assert.fail('callback invoked')),
    PrismaTimeoutError,
  );
  resolve({
    $transaction: async () => {
      transactions++;
      throw Error('must not run');
    },
    $disconnect: async () => {
      disconnects++;
    },
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(transactions, 0);
  assert.equal(disconnects, 1);
  await resource.close();
});
