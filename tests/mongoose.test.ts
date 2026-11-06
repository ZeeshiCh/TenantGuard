import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMongooseAdapter,
  MongooseLifecycleError,
  MongooseTimeoutError,
  type MongooseRepository,
} from '../packages/mongoose/src/index.js';
import {
  ownedMongooseResource,
  type MongooseRuntime,
  type MongooseSession,
  type MongooseOperations,
} from '../packages/mongoose/src/resource.js';
import type { TenantRoute } from '../packages/core/src/index.js';
const models = {
  orders: {
    collection: 'orders',
    tenantField: 'tenantId',
    idField: 'id',
    fields: {
      id: { type: 'string', required: true },
      tenantId: { type: 'string', required: true },
      value: { type: 'string', required: true },
    },
  },
} as const;
const context = { tenantId: 'Org_A' },
  route: TenantRoute = {
    tenantId: 'Org_A',
    adapter: 'mongoose',
    source: 'orders',
    resource: 'main',
    revision: '1',
    status: 'active',
    mode: 'application-filter',
  };
function fixture(
  options: {
    standalone?: boolean;
    commitFail?: boolean;
    abortFail?: boolean;
    endFail?: boolean;
    hangFind?: boolean;
    foreign?: boolean;
    closeFail?: boolean;
    sessionDelay?: number;
    hangSession?: boolean;
  } = {},
) {
  const events: string[] = [];
  let transaction = false,
    ended = false,
    listener: ((error: Error) => void) | undefined;
  const session: MongooseSession = {
    startTransaction() {
      transaction = true;
      events.push('begin');
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
      if (options.endFail) throw Error('end failed');
      ended = true;
    },
  };
  const operations: MongooseOperations = {
    async find(_filter, _projection, settings) {
      assert.equal(settings.session, session);
      assert.equal(settings.collation.locale, 'simple');
      events.push('find');
      if (options.hangFind) await new Promise(() => {});
      return options.foreign
        ? [{ id: 'foreign', tenantId: 'other', value: 'bad' }]
        : [];
    },
    async insert(_data, settings) {
      assert.equal(settings.session, session);
      events.push('insert');
    },
    async update() {
      return 1;
    },
    async delete() {
      return 1;
    },
    async aggregate(_pipeline, settings) {
      assert.equal(settings.session, session);
      events.push('aggregate');
      return [];
    },
  };
  const runtime: MongooseRuntime = {
    async connect() {
      events.push('connect');
    },
    async hello() {
      return options.standalone ? {} : { setName: 'rs0' };
    },
    async collection() {},
    async startSession() {
      events.push('session');
      if (options.hangSession) await new Promise(() => {});
      if (options.sessionDelay)
        await new Promise((r) => setTimeout(r, options.sessionDelay));
      return session;
    },
    model: () => operations,
    async close() {
      events.push('retire');
      if (options.closeFail) throw Error('close failed');
    },
    onError(fn) {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
  };
  const resource = ownedMongooseResource(models, runtime),
    adapter = createMongooseAdapter({
      resolveResource: () => resource,
      operationTimeoutMs: 100,
      cleanupTimeoutMs: 20,
    });
  return {
    resource,
    adapter,
    runtime,
    session,
    events,
    get ended() {
      return ended;
    },
    emit: (error: Error) => listener?.(error),
  };
}
test('Mongoose commits one owned session and ends it before resolving', async () => {
  const f = fixture();
  let escaped!: MongooseRepository;
  await f.adapter.run(context, route, async (c) => {
    escaped = c.model('orders');
    await escaped.find();
    await escaped.aggregate([{ $count: 'total' }]);
  });
  await assert.rejects(() => escaped.find(), /outside/);
  assert.deepEqual(f.events, [
    'connect',
    'session',
    'begin',
    'find',
    'aggregate',
    'commit',
    'end',
  ]);
  assert.ok(f.ended);
});
test('Mongoose standalone preflight denies callbacks before session creation', async () => {
  const f = fixture({ standalone: true });
  await assert.rejects(
    () => f.adapter.run(context, route, async () => assert.fail()),
    /replica set/,
  );
  assert.deepEqual(f.events, ['connect']);
});
test('Mongoose preserves ordinary callback errors after abort/end', async () => {
  const f = fixture(),
    sentinel = Error('business');
  await assert.rejects(
    () =>
      f.adapter.run(context, route, async () => {
        throw sentinel;
      }),
    (e) => e === sentinel,
  );
  assert.deepEqual(f.events, ['connect', 'session', 'begin', 'abort', 'end']);
});
test('Mongoose caught ownership failures poison preceding writes', async () => {
  const f = fixture();
  await assert.rejects(
    () =>
      f.adapter.run(context, route, async (c) => {
        const model = c.model('orders');
        await model.insert({ id: 'x', value: 'bad' });
        await model.update({ id: 'x' }, { tenantId: 'other' }).catch(() => {});
      }),
    /immutable/,
  );
  assert.ok(f.events.includes('abort'));
  assert.ok(!f.events.includes('commit'));
  assert.ok(f.ended);
});
test('Mongoose abort cleanup failure preserves the primary error and retires its pool', async () => {
  const f = fixture({ abortFail: true }),
    sentinel = Error('business');
  await assert.rejects(
    () =>
      f.adapter.run(context, route, async () => {
        throw sentinel;
      }),
    (e) =>
      e instanceof MongooseLifecycleError &&
      e.commitOutcome === 'not-committed' &&
      e.errors[0] === sentinel &&
      e.errors.length === 2,
  );
  assert.ok(f.resource.closed);
  assert.equal(f.events.at(-1), 'retire');
});
test('Mongoose endSession failure after acknowledged commit reports committed', async () => {
  const f = fixture({ endFail: true });
  await assert.rejects(
    () => f.adapter.run(context, route, async () => {}),
    (e) =>
      e instanceof MongooseLifecycleError && e.commitOutcome === 'committed',
  );
  assert.ok(f.resource.closed);
});
test('Mongoose ambiguous commit retires the pool without rerunning business logic', async () => {
  const f = fixture({ commitFail: true });
  let calls = 0;
  await assert.rejects(
    () =>
      f.adapter.run(context, route, async () => {
        calls++;
      }),
    (e) => e instanceof MongooseLifecycleError && e.commitOutcome === 'unknown',
  );
  assert.equal(calls, 1);
  assert.ok(f.resource.closed);
});
test('Mongoose work deadlines revoke escaped repositories and abort writes', async () => {
  const f = fixture();
  let escaped!: MongooseRepository;
  await assert.rejects(
    () =>
      f.adapter.run(context, route, async (c) => {
        escaped = c.model('orders');
        await escaped.insert({ id: 'x', value: 'v' });
        await new Promise(() => {});
      }),
    MongooseTimeoutError,
  );
  await assert.rejects(() => escaped.find(), /outside/);
  assert.ok(f.ended);
  assert.ok(f.events.includes('abort'));
});
test('Mongoose request cleanup cannot recycle a session while a native operation is pending', async () => {
  const f = fixture({ hangFind: true });
  const adapter = createMongooseAdapter({
    resolveResource: () => f.resource,
    requestTimeoutMs: 5,
    cleanupTimeoutMs: 10,
  });
  await assert.rejects(
    () => adapter.run(context, route, (c) => c.model('orders').find()),
    (e) =>
      e instanceof MongooseLifecycleError &&
      e.errors[0] instanceof MongooseTimeoutError,
  );
  assert.ok(f.resource.closed);
  assert.ok(!f.ended);
  assert.ok(!f.events.includes('commit'));
});
test('Mongoose late session acquisition is drained and ended before returning the error', async () => {
  const f = fixture({ sessionDelay: 30 });
  const adapter = createMongooseAdapter({
    resolveResource: () => f.resource,
    requestTimeoutMs: 5,
    cleanupTimeoutMs: 100,
  });
  await assert.rejects(
    () => adapter.run(context, route, async () => assert.fail()),
    MongooseTimeoutError,
  );
  assert.ok(f.ended);
  assert.ok(!f.events.includes('begin'));
  assert.ok(!f.resource.closed);
});
test('Mongoose stalled session acquisition retires the connection without reusing the late result', async () => {
  const f = fixture({ hangSession: true });
  const adapter = createMongooseAdapter({
    resolveResource: () => f.resource,
    requestTimeoutMs: 5,
    cleanupTimeoutMs: 10,
  });
  await assert.rejects(
    () => adapter.run(context, route, async () => assert.fail()),
    MongooseLifecycleError,
  );
  assert.ok(f.resource.closed);
  assert.ok(!f.events.includes('begin'));
});
test('Mongoose invalid contexts/routes and nested scopes never create extra sessions', async () => {
  const f = fixture();
  await assert.rejects(() =>
    f.adapter.run({ tenantId: '' }, route, async () => {}),
  );
  await assert.rejects(() =>
    f.adapter.run(context, { ...route, tenantId: 'other' }, async () => {}),
  );
  assert.equal(f.events.length, 0);
  await f.adapter.run(context, route, async () => {
    await assert.rejects(
      () => f.adapter.run(context, route, async () => {}),
      /Nested/,
    );
  });
  assert.equal(f.events.filter((event) => event === 'session').length, 1);
});
test('Mongoose unawaited work and foreign decoded rows cannot commit', async () => {
  const f = fixture({ foreign: true });
  await assert.rejects(
    () => f.adapter.run(context, route, (c) => c.model('orders').find()),
    /foreign ownership/,
  );
  await assert.rejects(
    () =>
      f.adapter.run(context, route, async (c) => {
        void c.model('orders').insert({ id: 'pending', value: 'v' });
      }),
    /Unawaited/,
  );
  assert.ok(!f.events.includes('commit'));
});
test('Mongoose transport errors interrupt hanging business callbacks and end the session', async () => {
  const f = fixture(),
    sentinel = Error('socket failed');
  await assert.rejects(
    () =>
      f.adapter.run(context, route, async () => {
        f.emit(sentinel);
        await new Promise(() => {});
      }),
    (e) => e === sentinel,
  );
  assert.ok(f.ended);
  assert.ok(!f.events.includes('commit'));
});
test('Mongoose global SchemaType transforms and defaults fail closed before opening connections', async () => {
  const mongoose = await import('mongoose');
  const { createMongooseResource } =
    await import('../packages/mongoose/src/index.js');
  const StringType = mongoose.default.Schema.Types.String,
    previous = { ...StringType.defaultOptions };
  try {
    for (const [option, value] of [
      ['lowercase', true],
      ['default', 'foreign'],
      ['set', (value: unknown) => String(value).toLowerCase()],
    ]) {
      StringType.defaultOptions = { ...previous };
      StringType.set(String(option), value);
      assert.throws(
        () =>
          createMongooseResource({
            uri: 'mongodb://localhost:27017',
            database: 'example',
            models,
          }),
        /Inherited Mongoose/,
      );
    }
  } finally {
    StringType.defaultOptions = previous;
  }
  const resource = createMongooseResource({
    uri: 'mongodb://localhost:27017',
    database: 'example',
    models,
  });
  await resource.close();
});
test('Mongoose reserved document paths cannot shadow model lifecycle methods', async () => {
  const { createMongooseResource } =
    await import('../packages/mongoose/src/index.js');
  assert.throws(
    () =>
      createMongooseResource({
        uri: 'mongodb://localhost:27017',
        database: 'example',
        models: {
          orders: {
            ...models.orders,
            fields: { ...models.orders.fields, save: { type: 'string' } },
          },
        },
      }),
    /Reserved Mongoose/,
  );
});
