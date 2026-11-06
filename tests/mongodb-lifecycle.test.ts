import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MongoClient } from 'mongodb';
import {
  createMongoAdapter,
  MongoLifecycleError,
  MongoTimeoutError,
  type MongoResource,
} from '../packages/mongodb/src/index.js';
import type { TenantRoute } from '../packages/core/src/index.js';
const collections = {
  orders: {
    collection: 'orders',
    tenantField: 'tenantId',
    idField: 'id',
    fields: ['id', 'tenantId', 'value'],
  },
};
const context = { tenantId: 'a' };
const route: TenantRoute = {
  tenantId: 'a',
  adapter: 'mongodb',
  source: 'orders',
  resource: 'main',
  revision: '1',
  status: 'active',
  mode: 'application-filter',
};
function fake(
  options: {
    standalone?: boolean;
    commitFail?: boolean;
    abortFail?: boolean;
    hangFind?: boolean;
  } = {},
) {
  const events: string[] = [];
  let closed = false,
    transaction = false;
  const session = {
    startTransaction() {
      events.push('begin');
      transaction = true;
    },
    inTransaction: () => transaction,
    async commitTransaction() {
      events.push('commit');
      if (options.commitFail) throw Error('commit lost');
      transaction = false;
    },
    async abortTransaction() {
      events.push('abort');
      if (options.abortFail) throw Error('abort failed');
      transaction = false;
    },
    async endSession() {
      events.push('end');
    },
  };
  const client = {
    db() {
      return {
        admin() {
          return {
            command: async () => (options.standalone ? {} : { setName: 'rs0' }),
          };
        },
        listCollections() {
          return { toArray: async () => [{ type: 'collection', options: {} }] };
        },
        collection() {
          return {
            find() {
              return {
                toArray: async () => {
                  events.push('find');
                  if (options.hangFind) await new Promise(() => {});
                  return [];
                },
              };
            },
            insertOne: async () => {
              events.push('insert');
              return {};
            },
          };
        },
      };
    },
    startSession() {
      events.push('session');
      return session;
    },
  } as unknown as MongoClient;
  const resource: MongoResource = {
    client,
    database: 'test',
    get closed() {
      return closed;
    },
    async close() {
      closed = true;
      events.push('retire');
    },
  };
  const adapter = createMongoAdapter({
    resolveResource: () => resource,
    collections,
    operationTimeoutMs: 100,
    cleanupTimeoutMs: 30,
  });
  return { events, resource, adapter };
}
test('Mongo rejects standalone servers before creating sessions', async () => {
  const f = fake({ standalone: true });
  await assert.rejects(
    () => f.adapter.run(context, route, async () => assert.fail()),
    /replica set/,
  );
  assert.deepEqual(f.events, []);
});
test('Mongo preserves callback error identity after abort and end', async () => {
  const f = fake();
  const sentinel = Error('business');
  await assert.rejects(
    () =>
      f.adapter.run(context, route, async () => {
        throw sentinel;
      }),
    (e) => e === sentinel,
  );
  assert.deepEqual(f.events, ['session', 'begin', 'abort', 'end']);
});
test('Mongo abort cleanup failure retires the owned client', async () => {
  const f = fake({ abortFail: true });
  await assert.rejects(
    () =>
      f.adapter.run(context, route, async () => {
        throw Error('business');
      }),
    (e) =>
      e instanceof MongoLifecycleError &&
      e.commitOutcome === 'not-committed' &&
      e.errors.length === 2,
  );
  assert.ok(f.resource.closed);
  assert.equal(f.events.at(-1), 'retire');
});
test('Mongo ambiguous commit is surfaced without rerunning business callback', async () => {
  const f = fake({ commitFail: true });
  let calls = 0;
  await assert.rejects(
    () =>
      f.adapter.run(context, route, async () => {
        calls++;
      }),
    (e) => e instanceof MongoLifecycleError && e.commitOutcome === 'unknown',
  );
  assert.equal(calls, 1);
  assert.ok(f.resource.closed);
});
test('Mongo timed out native operations cannot recycle sessions before settling', async () => {
  const f = fake({ hangFind: true });
  await assert.rejects(
    () => f.adapter.run(context, route, (c) => c.collection('orders').find()),
    MongoLifecycleError,
  );
  assert.ok(f.resource.closed);
  assert.ok(!f.events.includes('end'));
  assert.ok(!f.events.includes('commit'));
});
test('Mongo late resource resolution cannot create a logical session', async () => {
  const f = fake();
  let resolve!: (r: MongoResource) => void;
  const adapter = createMongoAdapter({
    collections,
    resolveResource: () =>
      new Promise((r) => {
        resolve = r;
      }),
    operationTimeoutMs: 20,
  });
  await assert.rejects(
    () => adapter.run(context, route, async () => assert.fail()),
    MongoTimeoutError,
  );
  resolve(f.resource);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(f.events, []);
});
test('Mongo rejects nested scopes and revokes escaped facades', async () => {
  const f = fake();
  await f.adapter.run(context, route, async (c) => {
    await assert.rejects(
      () => f.adapter.run(context, route, async () => {}),
      /Nested/,
    );
    await c.collection('orders').find();
  });
  assert.deepEqual(f.events, ['session', 'begin', 'find', 'commit', 'end']);
});
test('Mongo unawaited operations cannot commit', async () => {
  const f = fake({ hangFind: true });
  await assert.rejects(
    () =>
      f.adapter.run(context, route, async (c) => {
        void c.collection('orders').find();
      }),
    MongoLifecycleError,
  );
  assert.ok(!f.events.includes('commit'));
});
test('Mongo request deadlines preserve in-flight tracking until retirement', async () => {
  const f = fake({ hangFind: true });
  const adapter = createMongoAdapter({
    collections,
    resolveResource: () => f.resource,
    operationTimeoutMs: 1000,
    requestTimeoutMs: 10,
    cleanupTimeoutMs: 20,
  });
  await assert.rejects(
    () => adapter.run(context, route, (c) => c.collection('orders').find()),
    (e) =>
      e instanceof MongoLifecycleError &&
      e.errors[0] instanceof MongoTimeoutError,
  );
  assert.ok(f.resource.closed);
  assert.ok(!f.events.includes('end'));
});
