import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  createSqliteResource,
  createSqliteAdapter,
  SqliteTimeoutError,
  SqliteLifecycleError,
  type SqliteScopedClient,
  type SqliteRepository,
} from '../packages/sqlite/src/index.js';
import {
  adapterConformanceCases,
  type AdapterConformanceFixture,
} from '../packages/testing/src/conformance.js';
import {
  createTenantRouter,
  type TenantRoute,
} from '../packages/core/src/index.js';
import {
  sqliteFixture,
  sqliteTables,
  sqliteTenantA,
  sqliteTenantB,
} from './helpers/sqlite.js';
interface Row {
  id: string;
  tenant_id: string;
  value: string;
}
test(
  'SQLite file conformance, scoped CRUD and transaction cleanup',
  { timeout: 120000 },
  async (t) => {
    const db = await sqliteFixture(),
      resource = createSqliteResource({ filename: db.filename });
    const adapter = createSqliteAdapter({
      resolveResource: () => resource,
      tables: sqliteTables,
    });
    const route = (tenantId = sqliteTenantA.tenantId): TenantRoute => ({
      tenantId,
      adapter: 'sqlite',
      source: 'orders',
      resource: 'orders-file',
      revision: '1',
      mode: 'application-filter',
      status: 'active',
    });
    const run = <T>(work: (c: SqliteScopedClient) => Promise<T>) =>
      adapter.run(sqliteTenantA, route(), work);
    const count = (id: string) =>
      db.admin.prepare('SELECT count(*) AS n FROM orders WHERE id=?').get(id)!
        .n;
    try {
      for (const entry of adapterConformanceCases({
        transactional: true,
        createFixture: async (): Promise<
          AdapterConformanceFixture<SqliteScopedClient>
        > => {
          await db.seed();
          return {
            adapter,
            tenantA: sqliteTenantA,
            tenantB: sqliteTenantB,
            seedA: {
              id: 'seed-a',
              tenantId: sqliteTenantA.tenantId,
              value: 'a',
            },
            seedB: {
              id: 'seed-b',
              tenantId: sqliteTenantB.tenantId,
              value: 'b',
            },
            route: (c) => route(c.tenantId),
            read: async (c, id) =>
              (
                await c
                  .table<Row>('orders')
                  .find(id === undefined ? {} : { id })
              ).map((row) => ({
                id: row.id,
                tenantId: row.tenant_id,
                value: row.value,
              })),
            insert: async (c, row) => {
              await c.table('orders').insert({
                id: row.id,
                tenant_id: row.tenantId,
                value: row.value,
              });
            },
            update: (c, id, changes) =>
              c.table('orders').update(
                { id },
                {
                  ...(changes.tenantId === undefined
                    ? {}
                    : { tenant_id: changes.tenantId }),
                  ...(changes.value === undefined
                    ? {}
                    : { value: changes.value }),
                },
              ),
            delete: (c, id) => c.table('orders').delete({ id }),
            close: async () => {},
          };
        },
      }))
        await t.test(entry.name, entry.run);
      await db.seed();
      await t.test(
        'strict mode refuses application filtering; native SQLite bypasses it',
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
            db.admin.prepare('SELECT count(*) AS n FROM orders').get()!.n,
            2,
          );
        },
      );
      await t.test(
        'binary scalar ownership defeats case, accent, padding and BLOB aliases',
        async () => {
          const insert = db.admin.prepare('INSERT INTO orders VALUES(?,?,?)');
          insert.run('blob', Buffer.from('Org_A'), 'bad');
          insert.run('padded', 'Org_A ', 'bad');
          assert.deepEqual(
            (await run((c) => c.table<Row>('orders').find())).map((r) => r.id),
            ['seed-a'],
          );
          assert.equal(
            await run((c) =>
              c.table('orders').update({ id: 'blob' }, { value: 'oops' }),
            ),
            0,
          );
          assert.equal(
            await run((c) => c.table('orders').delete({ id: 'padded' })),
            0,
          );
          for (const tenantId of ['Café', 'Cafe', '$tenant']) {
            await adapter.run({ tenantId }, route(tenantId), (c) =>
              c.table('orders').insert({ id: tenantId, value: tenantId }),
            );
            const rows = await adapter.run({ tenantId }, route(tenantId), (c) =>
              c.table<Row>('orders').find(),
            );
            assert.equal(rows.length, 1);
            assert.equal(rows[0]!.tenant_id, tenantId);
          }
        },
      );
      await t.test(
        'generated CRUD rejects injection, unknown tables and fragments',
        async () => {
          assert.deepEqual(
            await run((c) =>
              c.table('orders').find({ id: "' OR 1=1;COMMIT;--" }),
            ),
            [],
          );
          for (const work of [
            (c: SqliteScopedClient) => c.table('orders').find({ $or: '1=1' }),
            (c: SqliteScopedClient) =>
              c
                .table('orders')
                .find({ id: { toSqlString: () => '1=1' } as never }),
            (c: SqliteScopedClient) =>
              c.table('orders').find(
                {},
                {
                  orderBy: { column: 'id', direction: 'asc;COMMIT' as never },
                },
              ),
            (c: SqliteScopedClient) => c.table('sqlite_schema').find(),
          ])
            await assert.rejects(() => run(work));
        },
      );
      await t.test(
        'caught validation and constraint errors roll back prior writes',
        async () => {
          for (const invalid of [
            async (orders: SqliteRepository) =>
              orders.update({ id: 'seed-a' }, { tenant_id: 'other' }),
            async (orders: SqliteRepository) =>
              orders.insert({ id: 'seed-a', value: 'duplicate' }),
          ]) {
            await assert.rejects(() =>
              run(async (c) => {
                const orders = c.table('orders');
                await orders.insert({ id: 'rollback', value: 'bad' });
                await invalid(orders).catch(() => {});
              }),
            );
            assert.equal(count('rollback'), 0);
          }
        },
      );
      await t.test(
        'automatic rollback conflicts cannot turn subsequent statements into autocommit writes',
        async () => {
          db.admin.exec(
            "CREATE TRIGGER abort_scope BEFORE INSERT ON orders WHEN NEW.id='auto-abort' BEGIN SELECT RAISE(ROLLBACK,'forced rollback'); END",
          );
          try {
            await assert.rejects(() =>
              run(async (c) => {
                const orders = c.table('orders');
                await orders.insert({ id: 'prior-auto', value: 'bad' });
                await orders
                  .insert({ id: 'auto-abort', value: 'bad' })
                  .catch(() => {});
                await orders
                  .insert({ id: 'after-auto', value: 'bad' })
                  .catch(() => {});
              }),
            );
            assert.equal(count('prior-auto'), 0);
            assert.equal(count('after-auto'), 0);
          } finally {
            db.admin.exec('DROP TRIGGER abort_scope');
          }
        },
      );
      await t.test(
        'deferred foreign-key commit failures are rolled back with known outcome',
        async () => {
          db.admin.exec(
            'CREATE TABLE parent(id TEXT PRIMARY KEY);CREATE TABLE children(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,value TEXT REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)',
          );
          const deferred = createSqliteAdapter({
            resolveResource: () => resource,
            tables: { children: { ...sqliteTables.orders, table: 'children' } },
          });
          await assert.rejects(
            () =>
              deferred.run(sqliteTenantA, route(), (c) =>
                c.table('children').insert({ id: 'orphan', value: 'missing' }),
              ),
            (e) =>
              e instanceof SqliteLifecycleError &&
              e.commitOutcome === 'not-committed',
          );
          assert.equal(
            db.admin.prepare('SELECT count(*) AS n FROM children').get()!.n,
            0,
          );
          await run((c) => c.table('orders').find());
        },
      );
      await t.test(
        'BEGIN lock failures deny callbacks and do not block the main event loop',
        async () => {
          const locked = createSqliteResource({
            filename: db.filename,
            busyTimeoutMs: 200,
          });
          const lockedAdapter = createSqliteAdapter({
            resolveResource: () => locked,
            tables: sqliteTables,
          });
          let heartbeat = false;
          db.admin.exec('BEGIN IMMEDIATE');
          const timer = setTimeout(() => {
            heartbeat = true;
          }, 20);
          try {
            await assert.rejects(
              () =>
                lockedAdapter.run(sqliteTenantA, route(), async () =>
                  assert.fail('callback invoked'),
                ),
              /locked/,
            );
            assert.ok(heartbeat);
          } finally {
            clearTimeout(timer);
            db.admin.exec('ROLLBACK');
            await locked.close();
          }
          await run((c) => c.table('orders').find());
        },
      );
      await t.test(
        'busy COMMIT rolls back earlier writes before the next scope',
        async () => {
          db.admin.exec('BEGIN;SELECT * FROM orders');
          try {
            await assert.rejects(
              () =>
                run((c) =>
                  c.table('orders').insert({ id: 'commit-busy', value: 'bad' }),
                ),
              (e) =>
                e instanceof SqliteLifecycleError &&
                e.commitOutcome === 'not-committed',
            );
          } finally {
            db.admin.exec('ROLLBACK');
          }
          assert.equal(count('commit-busy'), 0);
          await run((c) => c.table('orders').find());
        },
      );
      await t.test(
        'operation deadlines roll back writes and revoke late repositories',
        async () => {
          const timed = createSqliteAdapter({
            resolveResource: () => resource,
            tables: sqliteTables,
            operationTimeoutMs: 200,
          });
          let escaped: SqliteRepository | undefined;
          await assert.rejects(
            () =>
              timed.run(sqliteTenantA, route(), async (c) => {
                escaped = c.table('orders');
                await escaped.insert({ id: 'timeout', value: 'bad' });
                await new Promise(() => {});
              }),
            SqliteTimeoutError,
          );
          await assert.rejects(() => escaped!.find(), /outside/);
          assert.equal(count('timeout'), 0);
          await run((c) => c.table('orders').find());
        },
      );
      await t.test(
        'parallel facade calls serialize and closed repositories cannot be reused',
        async () => {
          let escaped: SqliteRepository | undefined;
          await run(async (c) => {
            escaped = c.table('orders');
            const results = await Promise.all(
              Array.from({ length: 8 }, () => escaped!.find()),
            );
            assert.ok(results.every((rows) => rows.length === 1));
          });
          await assert.rejects(() => escaped!.find(), /outside/);
        },
      );
      await t.test(
        'nested scopes are rejected and unawaited writes cannot commit',
        async () => {
          await run(async () => {
            await assert.rejects(() => run(async () => {}), /Nested/);
          });
          await assert.rejects(
            () =>
              run(async (c) => {
                void c
                  .table('orders')
                  .insert({ id: 'unawaited', value: 'bad' });
              }),
            /Unawaited/,
          );
          assert.equal(count('unawaited'), 0);
        },
      );
      await t.test(
        'views, virtual tables and weak tenant schemas fail closed',
        async () => {
          db.admin.exec(
            'CREATE VIEW view_orders AS SELECT * FROM orders;CREATE TABLE weak_orders(id TEXT,tenant_id TEXT,value TEXT);CREATE VIRTUAL TABLE virtual_orders USING fts5(id,tenant_id,value)',
          );
          for (const table of [
            'view_orders',
            'weak_orders',
            'virtual_orders',
          ]) {
            const unsafe = createSqliteAdapter({
              resolveResource: () => resource,
              tables: { orders: { ...sqliteTables.orders, table } },
            });
            await assert.rejects(
              () =>
                unsafe.run(sqliteTenantA, route(), async () =>
                  assert.fail('callback invoked'),
                ),
              /ordinary|TEXT NOT NULL/,
            );
          }
        },
      );
      await t.test(
        'SQLite types retain 64-bit integers and copy BLOB/date/bool bindings',
        async () => {
          db.admin.exec(
            'CREATE TABLE types(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,value)',
          );
          const typed = createSqliteAdapter({
            resolveResource: () => resource,
            tables: { types: { ...sqliteTables.orders, table: 'types' } },
          });
          await typed.run(sqliteTenantA, route(), async (c) => {
            const repo = c.table('types');
            const bytes = new Uint8Array([1, 2]);
            const inserted = repo.insert({ id: 'blob', value: bytes });
            bytes[0] = 9;
            await inserted;
            await repo.insert({ id: 'big', value: 9223372036854775807n });
            await repo.insert({ id: 'bool', value: true });
            await repo.insert({
              id: 'date',
              value: new Date('2026-01-01T00:00:00Z'),
            });
            const rows = await repo.find();
            assert.deepEqual(
              rows.find((r) => r.id === 'blob')!.value,
              new Uint8Array([1, 2]),
            );
            assert.equal(
              rows.find((r) => r.id === 'big')!.value,
              9223372036854775807n,
            );
            assert.equal(rows.find((r) => r.id === 'bool')!.value, 1n);
            assert.equal(
              rows.find((r) => r.id === 'date')!.value,
              '2026-01-01T00:00:00.000Z',
            );
          });
        },
      );
      await t.test(
        'closing an active resource rolls back its file transaction and rejects waiters',
        async () => {
          const closing = createSqliteResource({ filename: db.filename });
          const closer = createSqliteAdapter({
            resolveResource: () => closing,
            tables: sqliteTables,
          });
          let entered!: () => void, resume!: () => void;
          const enteredPromise = new Promise<void>((r) => {
              entered = r;
            }),
            pause = new Promise<void>((r) => {
              resume = r;
            });
          const active = closer.run(sqliteTenantA, route(), async (c) => {
            await c
              .table('orders')
              .insert({ id: 'close-active', value: 'bad' });
            entered();
            await pause;
          });
          const caught = assert.rejects(() => active);
          await enteredPromise;
          const waiter = assert.rejects(() =>
            closer.run(sqliteTenantB, route(sqliteTenantB.tenantId), async () =>
              assert.fail('waiter callback invoked'),
            ),
          );
          await closing.close();
          resume();
          await caught;
          await waiter;
          assert.equal(count('close-active'), 0);
          await assert.rejects(
            () =>
              closer.run(sqliteTenantA, route(), async () =>
                assert.fail('closed callback invoked'),
              ),
            /closed/,
          );
        },
      );
      await t.test(
        'queue deadlines and operation expiry cannot execute callbacks later',
        async () => {
          const queued = createSqliteResource({
            filename: db.filename,
            maxQueue: 1,
          });
          const owner = createSqliteAdapter({
            resolveResource: () => queued,
            tables: sqliteTables,
          });
          const timed = createSqliteAdapter({
            resolveResource: () => queued,
            tables: sqliteTables,
            operationTimeoutMs: 30,
            acquireTimeoutMs: 500,
          });
          let entered!: () => void, release!: () => void;
          const ready = new Promise<void>((r) => {
              entered = r;
            }),
            pause = new Promise<void>((r) => {
              release = r;
            });
          const active = owner.run(sqliteTenantA, route(), async () => {
            entered();
            await pause;
          });
          await ready;
          let late = 0;
          const rejected = assert.rejects(
            () =>
              timed.run(sqliteTenantA, route(), async () => {
                late++;
              }),
            SqliteTimeoutError,
          );
          await new Promise((r) => setTimeout(r, 10));
          await assert.rejects(
            () =>
              owner.run(
                sqliteTenantB,
                route(sqliteTenantB.tenantId),
                async () => assert.fail('queue overflow callback'),
              ),
            /queue full/,
          );
          await rejected;
          release();
          await active;
          await owner.run(sqliteTenantA, route(), async () => {});
          assert.equal(late, 0);
          await queued.close();
        },
      );
      await t.test(
        'late resource resolution cannot open a transaction after its deadline',
        async () => {
          let resolve!: (r: typeof resource) => void;
          let calls = 0;
          const late = createSqliteAdapter({
            tables: sqliteTables,
            resolveResource: () =>
              new Promise((r) => {
                resolve = r;
              }),
            acquireTimeoutMs: 20,
          });
          await assert.rejects(
            () =>
              late.run(sqliteTenantA, route(), async () => {
                calls++;
              }),
            SqliteTimeoutError,
          );
          resolve(resource);
          await new Promise((r) => setImmediate(r));
          assert.equal(calls, 0);
          await run((c) => c.table('orders').find());
        },
      );
      await t.test(
        'request/cleanup deadlines retire a blocked worker instead of reusing its transaction',
        async () => {
          const blocked = createSqliteResource({
            filename: db.filename,
            busyTimeoutMs: 800,
          });
          const timed = createSqliteAdapter({
            resolveResource: () => blocked,
            tables: sqliteTables,
            requestTimeoutMs: 100,
            cleanupTimeoutMs: 20,
          });
          db.admin.exec('BEGIN IMMEDIATE');
          try {
            await assert.rejects(
              () =>
                timed.run(sqliteTenantA, route(), async () =>
                  assert.fail('blocked callback'),
                ),
              (e) =>
                e instanceof SqliteLifecycleError &&
                e.commitOutcome === 'not-committed',
            );
            assert.ok(blocked.closed);
          } finally {
            db.admin.exec('ROLLBACK');
            await blocked.close();
          }
          await assert.rejects(
            () =>
              timed.run(sqliteTenantA, route(), async () =>
                assert.fail('retired callback'),
              ),
            /closed/,
          );
          await run((c) => c.table('orders').find());
        },
      );
      await t.test(
        'successful writes survive a fresh independent connection',
        async () => {
          await run((c) =>
            c.table('orders').insert({ id: 'durable', value: 'ok' }),
          );
          const reader = new DatabaseSync(db.filename);
          try {
            assert.equal(
              reader
                .prepare('SELECT value FROM orders WHERE id=?')
                .get('durable')!.value,
              'ok',
            );
            assert.equal(reader.isTransaction, false);
          } finally {
            reader.close();
          }
        },
      );
    } finally {
      await resource.close();
      await db.close();
    }
  },
);
