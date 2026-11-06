import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pgTable, text } from 'drizzle-orm/pg-core';
import {
  createDrizzleAdapter,
  DrizzleLifecycleError,
  DrizzleTimeoutError,
  type DrizzleRepository,
} from '../packages/drizzle/src/index.js';
import {
  ownedDrizzleResource,
  type DrizzleWire,
} from '../packages/drizzle/src/resource.js';
import type { TenantRoute } from '../packages/core/src/index.js';
const table = pgTable('orders', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  value: text('value'),
});
const tables = {
  orders: {
    table,
    tenantColumn: 'tenantId',
    idColumn: 'id',
    columns: ['id', 'tenantId', 'value'],
  },
};
const context = { tenantId: 'Org_A' },
  route: TenantRoute = {
    tenantId: 'Org_A',
    adapter: 'drizzle',
    source: 'orders',
    resource: 'main',
    revision: '1',
    status: 'active',
    mode: 'application-filter',
  };
function fixture(
  options: {
    commitFail?: boolean;
    rollbackFail?: boolean;
    closeFail?: boolean;
    hangRollback?: boolean;
    hangCommit?: boolean;
    hangFind?: boolean;
    foreign?: boolean;
    listenerFail?: boolean;
  } = {},
) {
  const events: string[] = [];
  let listener: ((error: Error) => void) | undefined;
  const builder = {
    from() {
      return this;
    },
    where() {
      return this;
    },
    orderBy() {
      return this;
    },
    limit() {
      return this;
    },
    async offset() {
      events.push('find');
      if (options.hangFind) await new Promise(() => {});
      return options.foreign ? [{ tenantId: 'other' }] : [];
    },
  };
  const db = {
    select: () => builder,
    insert: () => ({
      values: async () => {
        events.push('insert');
        return { rowCount: 1 };
      },
    }),
  } as unknown as Extract<DrizzleWire, { provider: 'postgresql' }>['db'];
  const makeWire = (): DrizzleWire => ({
    provider: 'postgresql',
    db,
    async query() {
      return [{ safe: true }];
    },
    async begin() {
      events.push('begin');
    },
    async commit() {
      events.push('commit');
      if (options.hangCommit) await new Promise(() => {});
      if (options.commitFail) throw Error('commit lost');
    },
    async rollback() {
      events.push('rollback');
      if (options.hangRollback) await new Promise(() => {});
      if (options.rollbackFail) throw Error('rollback failed');
    },
    async close() {
      events.push('close');
      if (options.closeFail) throw Error('close failed');
    },
    destroy() {
      events.push('destroy');
    },
    onError(fn) {
      if (options.listenerFail) throw Error('listener failed');
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
  });
  const resource = ownedDrizzleResource('postgresql', async () => makeWire());
  const adapter = createDrizzleAdapter({
    resolveResource: () => resource,
    tables,
    operationTimeoutMs: 50,
    cleanupTimeoutMs: 10,
  });
  return {
    events,
    resource,
    adapter,
    makeWire,
    emit: (error: Error) => listener?.(error),
  };
}
test('Drizzle scopes pin their native wire, commit and close before resolving', async () => {
  const f = fixture();
  let escaped!: DrizzleRepository;
  await f.adapter.run(context, route, async (c) => {
    escaped = c.table('orders');
    await escaped.find();
  });
  await assert.rejects(() => escaped.find(), /outside/);
  assert.deepEqual(f.events, ['begin', 'find', 'commit', 'close']);
});
test('Drizzle preserves callback errors when rollback and closure succeed', async () => {
  const f = fixture(),
    sentinel = Error('business');
  await assert.rejects(
    () =>
      f.adapter.run(context, route, async () => {
        throw sentinel;
      }),
    (e) => e === sentinel,
  );
  assert.deepEqual(f.events, ['begin', 'rollback', 'close']);
});
test('Drizzle caught validation failures poison earlier writes', async () => {
  const f = fixture();
  await assert.rejects(
    () =>
      f.adapter.run(context, route, async (c) => {
        const repo = c.table('orders');
        await repo.insert({ id: 'x' });
        await repo.update({ id: 'x' }, { tenantId: 'other' }).catch(() => {});
      }),
    /immutable/,
  );
  assert.deepEqual(f.events, ['begin', 'insert', 'rollback', 'close']);
});
test('Drizzle rollback failures destroy the physical connection and preserve both errors', async () => {
  const f = fixture({ rollbackFail: true }),
    sentinel = Error('business');
  await assert.rejects(
    () =>
      f.adapter.run(context, route, async () => {
        throw sentinel;
      }),
    (e) =>
      e instanceof DrizzleLifecycleError &&
      e.commitOutcome === 'not-committed' &&
      e.errors[0] === sentinel &&
      e.errors.length === 2,
  );
  assert.ok(f.events.includes('destroy'));
  assert.equal(f.events.at(-1), 'close');
});
test('Drizzle uncertain commits are surfaced without repeating the callback', async () => {
  const f = fixture({ commitFail: true });
  let calls = 0;
  await assert.rejects(
    () =>
      f.adapter.run(context, route, async () => {
        calls++;
      }),
    (e) => e instanceof DrizzleLifecycleError && e.commitOutcome === 'unknown',
  );
  assert.equal(calls, 1);
  assert.ok(f.events.includes('destroy'));
});
test('Drizzle closure failure after commit reports committed and retires the resource', async () => {
  const f = fixture({ closeFail: true });
  await assert.rejects(
    () => f.adapter.run(context, route, async () => {}),
    (e) =>
      e instanceof DrizzleLifecycleError && e.commitOutcome === 'committed',
  );
  assert.ok(f.resource.closed);
  assert.ok(f.events.includes('destroy'));
});
test('Drizzle callback deadlines roll back and revoke escaped repositories', async () => {
  const f = fixture();
  let escaped!: DrizzleRepository;
  await assert.rejects(
    () =>
      f.adapter.run(context, route, async (c) => {
        escaped = c.table('orders');
        await new Promise(() => {});
      }),
    DrizzleTimeoutError,
  );
  await assert.rejects(() => escaped.find(), /outside/);
  assert.deepEqual(f.events, ['begin', 'rollback', 'close']);
});
test('Drizzle request and rollback deadlines do not reuse a stalled wire', async () => {
  const f = fixture({ hangFind: true, hangRollback: true });
  const adapter = createDrizzleAdapter({
    resolveResource: () => f.resource,
    tables,
    requestTimeoutMs: 5,
    cleanupTimeoutMs: 5,
  });
  await assert.rejects(
    () => adapter.run(context, route, (c) => c.table('orders').find()),
    (e) =>
      e instanceof DrizzleLifecycleError &&
      e.errors[0] instanceof DrizzleTimeoutError,
  );
  assert.ok(f.events.includes('destroy'));
  assert.equal(f.events.at(-1), 'close');
});
test('Drizzle socket failures reject hanging callbacks and close their connection', async () => {
  const f = fixture(),
    sentinel = Error('socket lost');
  await assert.rejects(
    () =>
      f.adapter.run(context, route, async () => {
        f.emit(sentinel);
        await new Promise(() => {});
      }),
    (e) => e === sentinel,
  );
  assert.deepEqual(f.events, ['begin', 'rollback', 'close']);
});
test('Drizzle listener-registration failures still clean up the acquired connection', async () => {
  const f = fixture({ listenerFail: true });
  await assert.rejects(
    () => f.adapter.run(context, route, async () => assert.fail()),
    /listener failed/,
  );
  assert.deepEqual(f.events, ['rollback', 'close']);
});
test('Drizzle nested scopes and pending writes cannot silently commit', async () => {
  const f = fixture();
  await f.adapter.run(context, route, async () => {
    await assert.rejects(
      () => f.adapter.run(context, route, async () => {}),
      /Nested/,
    );
  });
  f.events.length = 0;
  await assert.rejects(
    () =>
      f.adapter.run(context, route, async (c) => {
        void c.table('orders').insert({ id: 'pending' });
      }),
    /Unawaited/,
  );
  assert.ok(!f.events.includes('commit'));
  assert.equal(f.events.at(-1), 'close');
});
test('Drizzle invalid context/routes never resolve a native resource', async () => {
  let resolved = 0;
  const f = fixture();
  const adapter = createDrizzleAdapter({
    tables,
    resolveResource: () => {
      resolved++;
      return f.resource;
    },
  });
  await assert.rejects(() =>
    adapter.run({ tenantId: '' }, route, async () => {}),
  );
  await assert.rejects(() =>
    adapter.run(context, { ...route, tenantId: 'other' }, async () => {}),
  );
  assert.equal(resolved, 0);
});
test('Drizzle late connection acquisition closes the wire before any transaction begins', async () => {
  const f = fixture();
  let resolve!: (wire: DrizzleWire) => void;
  const resource = ownedDrizzleResource(
    'postgresql',
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const adapter = createDrizzleAdapter({
    tables,
    resolveResource: () => resource,
    acquireTimeoutMs: 10,
  });
  await assert.rejects(
    () => adapter.run(context, route, async () => assert.fail()),
    DrizzleTimeoutError,
  );
  resolve(f.makeWire());
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(f.events, ['destroy', 'close']);
  await resource.close();
});
test('Drizzle exact read ownership is checked before returning decoded rows', async () => {
  const f = fixture({ foreign: true });
  await assert.rejects(
    () => f.adapter.run(context, route, (c) => c.table('orders').find()),
    /foreign tenant/,
  );
  assert.ok(f.events.includes('rollback'));
});
