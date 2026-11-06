import { test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {
  createMongooseAdapter,
  MongooseSafetyError,
  MongooseTimeoutError,
  MongooseLifecycleError,
  type MongooseScopedClient,
  type MongooseRepository,
} from '../packages/mongoose/src/index.js';
import {
  mongooseState,
  type MongooseSession,
} from '../packages/mongoose/src/resource.js';
import {
  createTenantRouter,
  type TenantRoute,
} from '../packages/core/src/index.js';
import {
  adapterConformanceCases,
  type AdapterConformanceFixture,
} from '../packages/testing/src/conformance.js';
import { mongooseFixture, mongooseModels } from './helpers/mongoose.js';
import { mongoTenantA, mongoTenantB } from './helpers/mongodb.js';
interface Row {
  id: string;
  tenantId: string;
  value: string;
}
test(
  'Mongoose real replica-set conformance, aggregation safeguards and session lifecycle',
  { timeout: 180000 },
  async (t) => {
    const db = await mongooseFixture(),
      adapter = createMongooseAdapter({ resolveResource: () => db.resource });
    const route = (tenantId = mongoTenantA.tenantId): TenantRoute => ({
      tenantId,
      adapter: 'mongoose',
      source: 'orders',
      resource: 'mongoose-main',
      revision: '1',
      status: 'active',
      mode: 'application-filter',
    });
    const run = <T>(work: (client: MongooseScopedClient) => Promise<T>) =>
      adapter.run(mongoTenantA, route(), work);
    const raw = db.admin.db(db.database).collection('orders');
    try {
      for (const entry of adapterConformanceCases({
        transactional: true,
        createFixture: async (): Promise<
          AdapterConformanceFixture<MongooseScopedClient>
        > => {
          await db.seed();
          return {
            adapter,
            tenantA: mongoTenantA,
            tenantB: mongoTenantB,
            seedA: {
              id: 'seed-a',
              tenantId: mongoTenantA.tenantId,
              value: 'a',
            },
            seedB: {
              id: 'seed-b',
              tenantId: mongoTenantB.tenantId,
              value: 'b',
            },
            route: (c) => route(c.tenantId),
            read: (c, id) =>
              c.model<Row>('orders').find(id === undefined ? {} : { id }),
            insert: async (c, row) => {
              await c.model('orders').insert({ ...row });
            },
            update: (c, id, changes) =>
              c.model('orders').update({ id }, { ...changes }),
            delete: (c, id) => c.model('orders').delete({ id }),
            close: async () => {},
          };
        },
      }))
        await t.test(entry.name, entry.run);
      await db.seed();
      await t.test(
        'strict mode refuses filtering and unwrapped Mongoose can read foreign documents',
        async () => {
          assert.throws(
            () =>
              createTenantRouter({
                strict: true,
                sources: { orders: { adapter, mode: 'application-filter' } },
                registry: { resolve: async () => undefined },
              }),
            /Strict/,
          );
          const outside = mongoose.createConnection(db.uri, {
            dbName: db.database,
            autoCreate: false,
            autoIndex: false,
          });
          try {
            await outside.asPromise();
            const model = outside.model(
              'Outside',
              new mongoose.Schema({
                id: String,
                tenantId: String,
                value: String,
              }),
              'orders',
            );
            assert.equal((await model.find().lean().exec()).length, 2);
          } finally {
            await outside.destroy(true);
          }
        },
      );
      await t.test(
        'scalar ownership and simple collation exclude array, case and padding aliases',
        async () => {
          await raw.insertMany(
            [
              { id: 'array', tenantId: [mongoTenantA.tenantId], value: 'bad' },
              { id: 'padded', tenantId: 'Org_A ', value: 'bad' },
            ],
            { bypassDocumentValidation: true },
          );
          assert.deepEqual(
            (await run((c) => c.model<Row>('orders').find())).map(
              (row) => row.id,
            ),
            ['seed-a'],
          );
          assert.equal(
            await run((c) =>
              c.model('orders').update({ id: 'array' }, { value: 'oops' }),
            ),
            0,
          );
          assert.equal(
            await run((c) => c.model('orders').delete({ id: 'array' })),
            0,
          );
          assert.deepEqual(
            await run((c) =>
              c.model('orders').find({ tenantId: mongoTenantB.tenantId }),
            ),
            [],
          );
          for (const tenantId of ['Café', 'Cafe', '$literal']) {
            await adapter.run({ tenantId }, route(tenantId), (c) =>
              c.model('orders').insert({ id: tenantId, value: tenantId }),
            );
            const rows = await adapter.run({ tenantId }, route(tenantId), (c) =>
              c.model<Row>('orders').find(),
            );
            assert.equal(rows.length, 1);
            assert.equal(rows[0]!.tenantId, tenantId);
          }
        },
      );
      await t.test(
        'aggregation remains tenant scoped across group, projection, matching and count',
        async () => {
          assert.deepEqual(
            await run((c) =>
              c
                .model('orders')
                .aggregate([
                  { $group: { _id: '$tenantId', total: { $sum: 1 } } },
                  { $sort: { total: -1 } },
                ]),
            ),
            [{ _id: mongoTenantA.tenantId, total: 1 }],
          );
          assert.deepEqual(
            await run((c) =>
              c
                .model('orders')
                .aggregate([
                  { $project: { id: 1 } },
                  { $match: { id: 'seed-b' } },
                  { $count: 'total' },
                ]),
            ),
            [],
          );
        },
      );
      await t.test(
        'foreign-stream, result-write, nested and executable aggregation stages are refused',
        async () => {
          for (const stage of [
            '$lookup',
            '$unionWith',
            '$graphLookup',
            '$facet',
            '$documents',
            '$out',
            '$merge',
            '$replaceRoot',
            '$replaceWith',
            '$search',
            '$vectorSearch',
            '$changeStream',
          ])
            await assert.rejects(
              () =>
                run((c) =>
                  c.model('orders').aggregate([{ [stage]: 'stolen' }]),
                ),
              MongooseSafetyError,
            );
          for (const stage of [
            { $group: { _id: '$$ROOT' } },
            { $group: { _id: null, all: { $push: '$value' } } },
            { $project: { value: { $function: { body: 'evil' } } } },
            { $match: { $where: 'evil' } },
          ])
            await assert.rejects(
              () => run((c) => c.model('orders').aggregate([stage])),
              MongooseSafetyError,
            );
          assert.equal(
            (
              await db.admin
                .db(db.database)
                .listCollections({ name: 'stolen' })
                .toArray()
            ).length,
            0,
          );
        },
      );
      await t.test(
        'operators, populate/options, casting and unknown model entry points fail closed',
        async () => {
          for (const work of [
            (c: MongooseScopedClient) =>
              c.model('orders').find({ id: { $ne: 'seed-b' } } as never),
            (c: MongooseScopedClient) =>
              c.model('orders').find({ id: 7 } as never),
            (c: MongooseScopedClient) =>
              c.model('orders').find({}, { populate: 'value' } as never),
            (c: MongooseScopedClient) => c.model('unknown').find(),
            (c: MongooseScopedClient) =>
              c.model('orders').update({ id: 'seed-a' }, {
                $set: { tenantId: 'other' },
              } as never),
          ])
            await assert.rejects(() => run<unknown>(work), MongooseSafetyError);
        },
      );
      await t.test(
        'caught schema, native constraint and ownership errors roll back earlier writes',
        async () => {
          const invalid = [
            (repo: MongooseRepository) =>
              repo.insert({ id: 'missing-required' }),
            (repo: MongooseRepository) =>
              repo.insert({ id: 'seed-a', value: 'duplicate' }),
            (repo: MongooseRepository) =>
              repo.update({ id: 'seed-a' }, { tenantId: 'other' }),
            (repo: MongooseRepository) =>
              repo.update({ id: 'seed-a' }, { value: null }),
          ];
          for (const operation of invalid) {
            await assert.rejects(() =>
              run(async (c) => {
                const orders = c.model('orders');
                await orders.insert({ id: 'prior-error', value: 'bad' });
                await operation(orders).catch(() => {});
              }),
            );
            assert.equal(await raw.countDocuments({ id: 'prior-error' }), 0);
          }
        },
      );
      await t.test(
        'default-instance plugins do not change the owned models',
        async () => {
          let pluginActive = true;
          mongoose.plugin((schema) => {
            if (!pluginActive) return;
            schema.pre('find', function () {
              throw Error('global plugin escaped isolation');
            });
          });
          const isolated = db.newResource();
          const isolatedAdapter = createMongooseAdapter({
            resolveResource: () => isolated,
          });
          try {
            const rows = await isolatedAdapter.run(mongoTenantA, route(), (c) =>
              c.model<Row>('orders').find(),
            );
            assert.equal(rows.length, 1);
            assert.equal(rows[0]!.tenantId, mongoTenantA.tenantId);
          } finally {
            pluginActive = false;
            await isolated.close();
          }
        },
      );
      await t.test(
        'parallel calls serialize and lean results cannot expose model/session handles',
        async () => {
          let escaped!: MongooseRepository;
          await run(async (c) => {
            escaped = c.model('orders');
            const rows = await Promise.all(
              Array.from({ length: 8 }, () => escaped.find()),
            );
            assert.ok(rows.every((result) => result.length === 1));
            assert.deepEqual(Object.keys(rows[0]![0]!).sort(), [
              'id',
              'tenantId',
              'value',
            ]);
            assert.equal('save' in rows[0]![0]!, false);
            assert.equal('$session' in rows[0]![0]!, false);
          });
          await assert.rejects(() => escaped.find(), /outside/);
        },
      );
      await t.test(
        'work deadlines abort preceding writes and revoke late callbacks',
        async () => {
          const timed = createMongooseAdapter({
            resolveResource: () => db.resource,
            operationTimeoutMs: 200,
          });
          let escaped!: MongooseRepository;
          await assert.rejects(
            () =>
              timed.run(mongoTenantA, route(), async (c) => {
                escaped = c.model('orders');
                await escaped.insert({ id: 'timeout', value: 'bad' });
                await new Promise(() => {});
              }),
            MongooseTimeoutError,
          );
          await assert.rejects(() => escaped.find(), /outside/);
          assert.equal(await raw.countDocuments({ id: 'timeout' }), 0);
          assert.equal((await run((c) => c.model('orders').find())).length, 1);
        },
      );
      await t.test(
        'pending writes cannot commit and nested scopes are refused',
        async () => {
          await assert.rejects(
            () =>
              run(async (c) => {
                void c.model('orders').insert({ id: 'pending', value: 'bad' });
              }),
            /Unawaited/,
          );
          assert.equal(await raw.countDocuments({ id: 'pending' }), 0);
          await run(async () => {
            await assert.rejects(() => run(async () => {}), /Nested/);
          });
        },
      );
      await t.test(
        'sessions end after commit and rollback without rerunning business work',
        async () => {
          const runtime = mongooseState(db.resource).runtime,
            original = runtime.startSession.bind(runtime),
            sessions: (MongooseSession & { hasEnded?: boolean })[] = [];
          runtime.startSession = async () => {
            const session = await original();
            sessions.push(session);
            return session;
          };
          let calls = 0;
          try {
            await run(async (c) => {
              calls++;
              await c.model('orders').find();
            });
            const sentinel = Error('business');
            await assert.rejects(
              () =>
                run(async () => {
                  calls++;
                  throw sentinel;
                }),
              (e) => e === sentinel,
            );
            assert.equal(calls, 2);
            assert.ok(sessions.every((session) => session.hasEnded === true));
          } finally {
            runtime.startSession = original;
          }
        },
      );
      await t.test(
        'real request expiry drains the native operation before ending its session',
        async () => {
          const timed = createMongooseAdapter({
            resolveResource: () => db.resource,
            requestTimeoutMs: 100,
            cleanupTimeoutMs: 2000,
          });
          await db.admin.db('admin').command({
            configureFailPoint: 'failCommand',
            mode: { times: 1 },
            data: {
              failCommands: ['find'],
              appName: 'tenantguard-mongoose-test',
              blockConnection: true,
              blockTimeMS: 500,
            },
          });
          try {
            await assert.rejects(
              () =>
                timed.run(mongoTenantA, route(), async (c) => {
                  const orders = c.model('orders');
                  await orders.insert({ id: 'request-prior', value: 'bad' });
                  await orders.find();
                }),
              MongooseTimeoutError,
            );
          } finally {
            await db.admin
              .db('admin')
              .command({ configureFailPoint: 'failCommand', mode: 'off' });
          }
          assert.equal(await raw.countDocuments({ id: 'request-prior' }), 0);
          assert.equal(db.resource.closed, false);
          await run((c) => c.model('orders').find());
        },
      );
      await t.test(
        'real cleanup expiry retires the Mongoose connection rather than reusing its session',
        async () => {
          const blocked = db.newResource(),
            timed = createMongooseAdapter({
              resolveResource: () => blocked,
              requestTimeoutMs: 100,
              cleanupTimeoutMs: 100,
            });
          await db.admin.db('admin').command({
            configureFailPoint: 'failCommand',
            mode: { times: 1 },
            data: {
              failCommands: ['find'],
              appName: 'tenantguard-mongoose-test',
              blockConnection: true,
              blockTimeMS: 1000,
            },
          });
          try {
            await assert.rejects(
              () =>
                timed.run(mongoTenantA, route(), async (c) => {
                  const orders = c.model('orders');
                  await orders.insert({ id: 'retired-prior', value: 'bad' });
                  await orders.find();
                }),
              (error) =>
                error instanceof MongooseLifecycleError &&
                error.commitOutcome === 'not-committed',
            );
            assert.equal(blocked.closed, true);
          } finally {
            await db.admin
              .db('admin')
              .command({ configureFailPoint: 'failCommand', mode: 'off' });
            await blocked.close();
          }
          assert.equal(await raw.countDocuments({ id: 'retired-prior' }), 0);
          await assert.rejects(
            () =>
              timed.run(mongoTenantA, route(), async () =>
                assert.fail('retired callback'),
              ),
            /closed|outside/,
          );
          await run((c) => c.model('orders').find());
        },
      );
      await t.test('views are refused before business work', async () => {
        await db.admin
          .db(db.database)
          .createCollection('view_orders', { viewOn: 'orders', pipeline: [] });
        const views = db.newResource({
          orders: { ...mongooseModels.orders, collection: 'view_orders' },
        });
        try {
          await assert.rejects(
            () =>
              createMongooseAdapter({ resolveResource: () => views }).run(
                mongoTenantA,
                route(),
                async () => assert.fail('view callback'),
              ),
            /ordinary/,
          );
        } finally {
          await views.close();
        }
      });
      await t.test(
        'closing an active resource rolls back its transaction and is terminal',
        async () => {
          const closing = db.newResource(),
            closer = createMongooseAdapter({ resolveResource: () => closing });
          let entered!: () => void, resume!: () => void;
          const ready = new Promise<void>((r) => {
              entered = r;
            }),
            pause = new Promise<void>((r) => {
              resume = r;
            });
          const active = closer.run(mongoTenantA, route(), async (c) => {
            await c
              .model('orders')
              .insert({ id: 'close-active', value: 'bad' });
            entered();
            await pause;
          });
          const rejected = assert.rejects(() => active);
          await ready;
          await closing.close();
          resume();
          await rejected;
          assert.equal(await raw.countDocuments({ id: 'close-active' }), 0);
          await assert.rejects(
            () =>
              closer.run(mongoTenantA, route(), async () =>
                assert.fail('closed callback'),
              ),
            /closed|outside/,
          );
        },
      );
    } finally {
      await db.close();
    }
  },
);
