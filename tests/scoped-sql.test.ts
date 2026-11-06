import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createScopedSqlCompiler,
  createScopedSqlAdapter,
  ScopedSqlCleanupError,
  ScopedSqlCommitError,
  ScopedSqlSafetyError,
  ScopedSqlTimeoutError,
  type ScopedSqlSession,
  type ScopedSqlSessionPool,
  type ScopedSqlClient,
  type ScopedSqlResult,
} from '../packages/scoped-sql/src/index.js';
import type { TenantRoute } from '../packages/core/src/index.js';
const tables = {
  orders: {
    table: 'orders',
    tenantColumn: 'tenant_id',
    idColumn: 'id',
    columns: ['id', 'tenant_id', 'value'],
  },
};
const context = { tenantId: 'Org_A' };
const route: TenantRoute = {
  ...context,
  adapter: 'mysql',
  mode: 'application-filter',
  source: 'orders',
  resource: 'pool',
  revision: '1',
  status: 'active',
};
test('scoped compiler binds values and adds byte-exact tenant predicates to every read/write', () => {
  const compiler = createScopedSqlCompiler('saas', tables.orders, 'Org_A'),
    payload = "' OR 1=1; DROP TABLE orders;--";
  for (const plan of [
    compiler.find({ id: payload }),
    compiler.update({ id: payload }, { value: 'updated' }),
    compiler.delete({ id: payload }),
  ]) {
    assert.match(plan.text, /BINARY `tenant_id` = BINARY \?/);
    assert.ok(!plan.text.includes(payload));
    assert.ok(plan.values.includes(payload));
    assert.equal(plan.values.filter((value) => value === 'Org_A').length, 2);
  }
  const insert = compiler.insert({ id: 'new', value: 'new' });
  assert.ok(insert.values.includes('Org_A'));
  assert.match(insert.text, /`tenant_id`/);
});
test('compiler rejects foreign ownership, immutable columns and unbounded mutations', () => {
  const c = createScopedSqlCompiler('saas', tables.orders, 'Org_A');
  for (const call of [
    () => c.insert({ tenant_id: 'org_a' }),
    () => c.update({ id: 'a' }, { tenant_id: 'Org_A' }),
    () => c.update({ id: 'a' }, { id: 'changed' }),
    () => c.update({}, { value: 'mass' }),
    () => c.delete({ tenant_id: 'Org_A' }),
    () => c.find({ $or: 'unsafe' }),
    () => c.find({ id: { toSqlString: () => '1=1' } as never }),
  ])
    assert.throws(call);
});
test('compiler validates schema, projection, pagination and ordering identifiers', () => {
  assert.throws(() =>
    createScopedSqlCompiler('saas;DROP', tables.orders, 'Org_A'),
  );
  assert.throws(() =>
    createScopedSqlCompiler(
      'saas',
      { ...tables.orders, columns: ['id', 'value'] },
      'Org_A',
    ),
  );
  const c = createScopedSqlCompiler('saas', tables.orders, 'Org_A');
  for (const options of [
    { limit: 1001 },
    { offset: -1 },
    { orderBy: { column: 'id;DROP', direction: 'asc' as const } },
    { orderBy: { column: 'id', direction: 'desc;DROP' as never } },
  ])
    assert.throws(() => c.find({}, options));
  assert.match(
    c.find({ value: null }, { limit: 20, offset: 10 }).text,
    /`value` IS NULL.*LIMIT 20 OFFSET 10/,
  );
});
test('compiler snapshots allowed fields and mutable values and rejects lossy UTF-8 identities', () => {
  const config = { ...tables.orders, columns: [...tables.orders.columns] },
    c = createScopedSqlCompiler('saas', config, 'Org_A');
  config.table = 'other';
  config.columns.push('secret');
  assert.match(c.find().text, /`saas`.`orders`/);
  assert.throws(() => c.find({ secret: 'bad' }));
  const date = new Date('2026-01-01T00:00:00Z'),
    bytes = new Uint8Array([1]);
  const plan = c.insert({ id: 'x', value: date });
  date.setUTCFullYear(2000);
  assert.equal(
    (
      plan.values.find((value) => value instanceof Date) as Date
    ).getUTCFullYear(),
    2026,
  );
  const binary = c.insert({ id: 'x', value: bytes });
  bytes[0] = 9;
  assert.equal(
    (
      binary.values.find((value) => value instanceof Uint8Array) as Uint8Array
    )[0],
    1,
  );
  for (const id of ['\ud800', '\udfff'])
    assert.throws(
      () => createScopedSqlCompiler('saas', tables.orders, id),
      /surrogate/,
    );
});
function fixture(
  options: {
    execute?: (text: string) => Promise<ScopedSqlResult> | undefined;
    commitError?: Error;
    resetErrorAt?: number;
    dirty?: boolean;
    engine?: string;
    acquire?: () => Promise<ScopedSqlSession>;
  } = {},
) {
  const state = { tenant: options.dirty ? 'other' : (null as string | null) },
    calls: string[] = [],
    releases: boolean[] = [],
    listeners = new Set<(error: Error) => void>();
  let resets = 0;
  const session: ScopedSqlSession = {
    database: 'saas',
    async execute(text, values = []) {
      calls.push(text);
      const override = options.execute?.(text);
      if (override) return override;
      if (text.startsWith('SELECT DATABASE'))
        return {
          rows: [
            {
              database_name: 'saas',
              authenticated_user: 'app@%',
              autocommit: 1,
              tenant: state.tenant,
              version: options.engine ?? '8.4.0',
            },
          ],
          affectedRows: 0,
        };
      if (text.includes('information_schema.TABLES'))
        return {
          rows: [{ table_type: 'BASE TABLE', engine: 'InnoDB' }],
          affectedRows: 0,
        };
      if (text.includes('information_schema.COLUMNS'))
        return {
          rows: tables.orders.columns.map((name) => ({
            name,
            type: 'varchar',
            nullable: 'NO',
            charset: 'utf8mb4',
            capacity: 256,
          })),
          affectedRows: 0,
        };
      if (text.startsWith('SET @tenantguard_tenant'))
        state.tenant = values[0] as string;
      return { rows: [], affectedRows: 1 };
    },
    async begin() {
      calls.push('BEGIN');
    },
    async commit() {
      calls.push('COMMIT');
      if (options.commitError) throw options.commitError;
    },
    async rollback() {
      calls.push('ROLLBACK');
    },
    async reset() {
      resets++;
      calls.push('RESET');
      if (options.resetErrorAt === resets) throw new Error('reset failed');
      state.tenant = null;
    },
    release(destroy = false) {
      releases.push(destroy);
    },
    onError(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const pool: ScopedSqlSessionPool = {
    acquire: options.acquire ?? (async () => session),
  };
  return {
    session,
    pool,
    state,
    calls,
    releases,
    listeners,
    adapter: (
      settings: Partial<Parameters<typeof createScopedSqlAdapter>[1]> = {},
    ) =>
      createScopedSqlAdapter('mysql', {
        tables,
        resolvePool: () => pool,
        ...settings,
      }),
  };
}
test('shared adapter exposes scoped repositories, commits and resets before release', async () => {
  const f = fixture();
  let client: ScopedSqlClient | undefined;
  assert.equal(
    await f.adapter().run(context, route, async (scoped) => {
      client = scoped;
      assert.equal('query' in scoped, false);
      return scoped.table('orders').insert({ id: 'x', value: 'x' });
    }),
    1,
  );
  assert.equal(f.state.tenant, null);
  assert.deepEqual(f.releases, [false]);
  assert.equal(f.calls.filter((text) => text === 'RESET').length, 2);
  assert.throws(() => client!.table('orders'), /outside/);
});
test('both engine adapters refuse native-policy mode, wrong identity and missing context before acquisition', async () => {
  const f = fixture();
  for (const [ctx, routing] of [
    [{ tenantId: '' }, route],
    [context, { ...route, mode: 'database-policy' as const }],
    [context, { ...route, tenantId: 'other' }],
  ] as const)
    await assert.rejects(() => f.adapter().run(ctx, routing, async () => {}));
  assert.deepEqual(f.calls, []);
});
test('shared adapter rejects dirty sessions and engine mismatches before callback', async () => {
  for (const options of [{ dirty: true }, { engine: '11.8.0-MariaDB' }]) {
    const f = fixture(options);
    await assert.rejects(
      () =>
        f
          .adapter()
          .run(context, route, async () => assert.fail('must not run')),
      ScopedSqlSafetyError,
    );
    assert.deepEqual(f.releases, [true]);
  }
});
test('swallowed CRUD validation failures poison the transaction and roll back earlier work', async () => {
  const f = fixture();
  await assert.rejects(
    () =>
      f.adapter().run(context, route, async (client) => {
        const orders = client.table('orders');
        await orders.insert({ id: 'x' });
        await orders
          .update({ id: 'x' }, { tenant_id: 'other' })
          .catch(() => {});
      }),
    /immutable/,
  );
  assert.ok(!f.calls.includes('COMMIT'));
  assert.equal(f.state.tenant, null);
});
test('swallowed driver failures cannot commit or run subsequent queued statements', async () => {
  const failure = new Error('database failure'),
    f = fixture({
      execute: (text) =>
        text.startsWith('INSERT') ? Promise.reject(failure) : undefined,
    });
  await assert.rejects(
    () =>
      f.adapter().run(context, route, async (client) => {
        const orders = client.table('orders');
        await orders.insert({ id: 'x' }).catch(() => {});
        await orders.delete({ id: 'x' }).catch(() => {});
      }),
    (error) => error === failure,
  );
  assert.ok(!f.calls.some((text) => text.startsWith('DELETE')));
  assert.ok(!f.calls.includes('COMMIT'));
});
test('shared adapter preserves callback failures and aggregates failed cleanup', async () => {
  const failure = new Error('business');
  const f = fixture();
  await assert.rejects(
    () =>
      f.adapter().run(context, route, async () => {
        throw failure;
      }),
    (error) => error === failure,
  );
  assert.deepEqual(f.releases, [false]);
  const broken = fixture({ resetErrorAt: 2 });
  await assert.rejects(
    () =>
      broken.adapter().run(context, route, async () => {
        throw failure;
      }),
    (error) =>
      error instanceof ScopedSqlCleanupError &&
      error.errors[0] === failure &&
      error.commitOutcome === 'not-committed',
  );
  assert.deepEqual(broken.releases, [true]);
});
test('commit uncertainty and post-commit reset failures destroy the connection and report outcomes', async () => {
  const uncertain = fixture({ commitError: new Error('socket') });
  await assert.rejects(
    () => uncertain.adapter().run(context, route, async () => {}),
    ScopedSqlCommitError,
  );
  assert.deepEqual(uncertain.releases, [true]);
  const committed = fixture({ resetErrorAt: 2 });
  await assert.rejects(
    () => committed.adapter().run(context, route, async () => {}),
    (error) =>
      error instanceof ScopedSqlCleanupError &&
      error.commitOutcome === 'committed',
  );
  assert.deepEqual(committed.releases, [true]);
});
test('scope deadlines revoke repository access and stop late commits', async () => {
  const f = fixture();
  let finish: () => void = () => {},
    orders: ReturnType<ScopedSqlClient['table']> | undefined;
  await assert.rejects(
    () =>
      f
        .adapter({ operationTimeoutMs: 20 })
        .run(context, route, async (client) => {
          orders = client.table('orders');
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        }),
    ScopedSqlTimeoutError,
  );
  await assert.rejects(() => orders!.find(), /outside/);
  finish();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(!f.calls.includes('COMMIT'));
  assert.deepEqual(f.releases, [true]);
});
test('late acquisitions and socket failures never return an unsafe session to the pool', async () => {
  let deliver: (session: ScopedSqlSession) => void = () => {};
  const f = fixture({
    acquire: () =>
      new Promise((resolve) => {
        deliver = resolve;
      }),
  });
  await assert.rejects(
    () =>
      f.adapter({ acquireTimeoutMs: 10 }).run(context, route, async () => {}),
    ScopedSqlTimeoutError,
  );
  deliver(f.session);
  await Promise.resolve();
  assert.deepEqual(f.releases, [true]);
  const broken = fixture();
  await assert.rejects(
    () =>
      broken.adapter().run(context, route, async () => {
        for (const listener of broken.listeners) listener(new Error('socket'));
        await new Promise(() => {});
      }),
    /socket/,
  );
  assert.deepEqual(broken.releases, [true]);
});
test('nested scopes and unawaited operations are rejected', async () => {
  const f = fixture(),
    adapter = f.adapter();
  await adapter.run(context, route, async () => {
    await assert.rejects(
      () => adapter.run(context, route, async () => {}),
      /Nested/,
    );
  });
  await assert.rejects(
    () =>
      adapter.run(context, route, async (client) => {
        void client.table('orders').insert({ id: 'x' });
      }),
    /unawaited/,
  );
  assert.deepEqual(f.releases, [false, true]);
});
