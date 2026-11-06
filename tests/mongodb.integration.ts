import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMongoAdapter,
  createMongoResource,
  MongoSafetyError,
  MongoTimeoutError,
  type MongoScopedClient,
  type MongoRepository,
} from '../packages/mongodb/src/index.js';
import {
  type TenantRoute,
  createTenantRouter,
} from '../packages/core/src/index.js';
import {
  adapterConformanceCases,
  type AdapterConformanceFixture,
} from '../packages/testing/src/conformance.js';
import {
  mongodbFixture,
  mongoCollections,
  mongoTenantA,
  mongoTenantB,
} from './helpers/mongodb.js';
interface Row {
  id: string;
  tenantId: string;
  value: string;
}
test(
  'MongoDB replica set conformance, aggregation safeguards and session lifecycle',
  { timeout: 180000 },
  async (t) => {
    const db = await mongodbFixture();
    const resource = createMongoResource(db);
    const adapter = createMongoAdapter({
      resolveResource: () => resource,
      collections: mongoCollections,
    });
    const route = (tenantId = mongoTenantA.tenantId): TenantRoute => ({
      tenantId,
      source: 'orders',
      adapter: 'mongodb',
      resource: 'orders-main',
      revision: '1',
      status: 'active',
      mode: 'application-filter',
    });
    const run = <T>(work: (client: MongoScopedClient) => Promise<T>) =>
      adapter.run(mongoTenantA, route(), work);
    const raw = db.admin.db(db.database).collection('orders');
    try {
      for (const entry of adapterConformanceCases({
        transactional: true,
        createFixture: async (): Promise<
          AdapterConformanceFixture<MongoScopedClient>
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
            route: (context) => route(context.tenantId),
            read: (client, id) =>
              client
                .collection<Row>('orders')
                .find(id === undefined ? {} : { id }),
            insert: async (client, row) => {
              await client.collection('orders').insert({ ...row });
            },
            update: (client, id, changes) =>
              client.collection('orders').update({ id }, { ...changes }),
            delete: (client, id) => client.collection('orders').delete({ id }),
            close: async () => {},
          };
        },
      }))
        await t.test(entry.name, entry.run);
      await db.seed();
      await t.test(
        'strict mode rejects application filtering and raw access bypasses facade',
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
          assert.equal(
            await resource.client
              .db(db.database)
              .collection('orders')
              .countDocuments(),
            2,
          );
        },
      );
      await t.test(
        'scalar ownership and binary collation exclude array, accent and padding aliases',
        async () => {
          await raw.insertMany(
            [
              { id: 'array', tenantId: [mongoTenantA.tenantId], value: 'bad' },
              { id: 'padded', tenantId: 'Org_A ', value: 'bad' },
            ],
            { bypassDocumentValidation: true },
          );
          assert.deepEqual(
            (await run((c) => c.collection<Row>('orders').find())).map(
              (r) => r.id,
            ),
            ['seed-a'],
          );
          assert.equal(
            await run((c) =>
              c.collection('orders').update({ id: 'array' }, { value: 'oops' }),
            ),
            0,
          );
          assert.equal(
            await run((c) => c.collection('orders').delete({ id: 'array' })),
            0,
          );
          for (const tenantId of ['Café', 'Cafe', '$literal']) {
            await adapter.run({ tenantId }, route(tenantId), (c) =>
              c.collection('orders').insert({ id: tenantId, value: tenantId }),
            );
            const rows = await adapter.run({ tenantId }, route(tenantId), (c) =>
              c.collection<Row>('orders').find(),
            );
            assert.equal(rows.length, 1);
            assert.equal(rows[0]!.tenantId, tenantId);
          }
        },
      );
      await t.test(
        'aggregation remains scoped through grouping, projection, matching and counting',
        async () => {
          assert.deepEqual(
            await run((c) =>
              c
                .collection('orders')
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
                .collection('orders')
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
        'cross-collection, write and executable pipelines fail before execution',
        async () => {
          for (const stage of [
            '$lookup',
            '$unionWith',
            '$graphLookup',
            '$facet',
            '$out',
            '$merge',
            '$documents',
            '$replaceRoot',
            '$function',
            '$search',
          ])
            await assert.rejects(
              () =>
                run((c) =>
                  c.collection('orders').aggregate([{ [stage]: 'stolen' }]),
                ),
              MongoSafetyError,
            );
          assert.equal(
            await db.admin
              .db(db.database)
              .listCollections({ name: 'stolen' })
              .toArray()
              .then((x) => x.length),
            0,
          );
          await assert.rejects(
            () =>
              run((c) =>
                c.collection('orders').find({ id: { $ne: 'seed-b' } }),
              ),
            MongoSafetyError,
          );
        },
      );
      await t.test(
        'caught validation failures still roll back preceding writes',
        async () => {
          await assert.rejects(
            () =>
              run(async (c) => {
                const orders = c.collection('orders');
                await orders.insert({ id: 'rollback', value: 'bad' });
                await orders
                  .update({ id: 'seed-a' }, { tenantId: 'other' })
                  .catch(() => {});
              }),
            /immutable/,
          );
          assert.equal(await raw.countDocuments({ id: 'rollback' }), 0);
        },
      );
      await t.test(
        'parallel calls serialize and escaped repositories are revoked',
        async () => {
          let escaped: MongoRepository | undefined;
          await run(async (c) => {
            escaped = c.collection('orders');
            const rows = await Promise.all(
              Array.from({ length: 8 }, () => escaped!.find()),
            );
            assert.ok(rows.every((r) => r.length === 1));
          });
          await assert.rejects(() => escaped!.find(), /outside/);
        },
      );
      await t.test(
        'scope deadline aborts earlier writes and revokes late callbacks',
        async () => {
          const timed = createMongoAdapter({
            resolveResource: () => resource,
            collections: mongoCollections,
            operationTimeoutMs: 300,
          });
          let escaped: MongoRepository | undefined;
          await assert.rejects(
            () =>
              timed.run(mongoTenantA, route(), async (c) => {
                escaped = c.collection('orders');
                await escaped.insert({ id: 'timeout', value: 'bad' });
                await new Promise(() => {});
              }),
            MongoTimeoutError,
          );
          await assert.rejects(() => escaped!.find(), /outside/);
          assert.equal(await raw.countDocuments({ id: 'timeout' }), 0);
          assert.equal(
            (await run((c) => c.collection('orders').find())).length,
            1,
          );
        },
      );
      await t.test(
        'caught server errors abort earlier writes and end logical sessions',
        async () => {
          const sessions: import('mongodb').ClientSession[] = [];
          const original = resource.client.startSession.bind(resource.client);
          resource.client.startSession = (options) => {
            const session = original(options);
            sessions.push(session);
            return session;
          };
          try {
            await assert.rejects(
              () =>
                run(async (c) => {
                  const orders = c.collection('orders');
                  await orders.insert({ id: 'server-rollback', value: 'bad' });
                  await orders
                    .insert({ id: 'seed-a', value: 'duplicate' })
                    .catch(() => {});
                }),
              /duplicate key/i,
            );
            assert.equal(
              await raw.countDocuments({ id: 'server-rollback' }),
              0,
            );
            await run((c) => c.collection('orders').find());
            assert.ok(sessions.every((session) => session.hasEnded));
          } finally {
            resource.client.startSession = original;
          }
        },
      );
      await t.test('views are rejected before callbacks', async () => {
        await db.admin
          .db(db.database)
          .createCollection('view_orders', { viewOn: 'orders', pipeline: [] });
        const view = createMongoAdapter({
          resolveResource: () => resource,
          collections: {
            orders: { ...mongoCollections.orders, collection: 'view_orders' },
          },
        });
        await assert.rejects(
          () =>
            view.run(mongoTenantA, route(), async () =>
              assert.fail('callback invoked'),
            ),
          /ordinary collections/,
        );
      });
      await t.test(
        'closed resource cannot reconnect through adapter',
        async () => {
          await resource.close();
          await assert.rejects(
            () => run(async () => assert.fail('callback invoked')),
            /outside/,
          );
        },
      );
    } finally {
      await resource.close();
      await db.close();
    }
  },
);
