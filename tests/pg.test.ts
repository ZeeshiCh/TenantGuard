import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Pool, PoolClient, QueryResult } from 'pg';
import type { TenantRoute } from '../packages/core/src/index.js';
import {
  createPgAdapter,
  PgCleanupError,
  PgCommitError,
  PgSafetyError,
  PgTimeoutError,
  type PgTenantClient,
} from '../packages/postgres/src/pg.js';
const context = { tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
const route: TenantRoute = {
  ...context,
  adapter: 'pg',
  source: 'orders',
  resource: 'pool',
  revision: '1',
  status: 'active',
  mode: 'database-policy',
};
const tables = [{ schema: 'public', table: 'orders' }];
const result = (
  command: string,
  rows: Record<string, unknown>[] = [],
): QueryResult => ({
  command,
  rows,
  rowCount: rows.length,
  oid: 0,
  fields: [],
});
function fixture(
  options: {
    role?: Record<string, unknown>;
    table?: Record<string, unknown>;
    query?: (text: string) => QueryResult | Promise<QueryResult> | undefined;
    acquire?: () => Promise<PoolClient>;
  } = {},
) {
  const queries: string[] = [],
    releases: boolean[] = [];
  const emitter = new EventEmitter();
  const client = Object.assign(emitter, {
    query: async (input: string | { text: string }) => {
      const text = typeof input === 'string' ? input : input.text;
      queries.push(text);
      const override = options.query?.(text);
      if (override) return override;
      if (text.includes('AS privileged'))
        return result('SELECT', [
          {
            identity_ok: true,
            tenant: null,
            privileged: false,
            ...options.role,
          },
        ]);
      if (text.includes('AS restrictive_policy'))
        return result('SELECT', [
          {
            relkind: 'r',
            relrowsecurity: true,
            relforcerowsecurity: true,
            owns_table: false,
            can_truncate: false,
            can_create: false,
            tenant_column: true,
            restrictive_policy: true,
            ...options.table,
          },
        ]);
      if (text.includes('AS identity_ok'))
        return result('SELECT', [{ identity_ok: true, tenant: null }]);
      return result(text.split(/\s/)[0]!.toUpperCase());
    },
    release: (destroy?: boolean | Error) => {
      releases.push(Boolean(destroy));
    },
  }) as unknown as PoolClient;
  const pool = {
    connect: options.acquire ?? (async () => client),
  } as unknown as Pool;
  const adapter = (
    settings: Partial<Parameters<typeof createPgAdapter>[0]> = {},
  ) => createPgAdapter({ tables, resolvePool: () => pool, ...settings });
  return { adapter, client, pool, emitter, queries, releases };
}

test('pg pins the connection, commits and cleans the session before release', async () => {
  const f = fixture();
  let escaped: PgTenantClient | undefined;
  assert.equal(
    await f.adapter().run(context, route, async (client) => {
      escaped = client;
      await client.query('SELECT $1', [1]);
      return 'ok';
    }),
    'ok',
  );
  assert.equal(f.queries.filter((sql) => sql === 'BEGIN').length, 1);
  assert.ok(f.queries.indexOf('COMMIT') < f.queries.indexOf('RESET ALL'));
  assert.deepEqual(f.releases, [false]);
  assert.equal('release' in escaped!, false);
  await assert.rejects(() => escaped!.query('SELECT 1'), /outside/);
});
for (const role of [
  { privileged: true },
  { identity_ok: false },
  { tenant: context.tenantId },
]) {
  test(`pg rejects unsafe session ${JSON.stringify(role)} without running callback`, async () => {
    const f = fixture({ role });
    await assert.rejects(
      () =>
        f
          .adapter()
          .run(context, route, async () => assert.fail('must not run')),
      PgSafetyError,
    );
    assert.deepEqual(f.releases, [true]);
    assert.ok(!f.queries.includes('BEGIN'));
  });
}
for (const table of [
  { relforcerowsecurity: false },
  { owns_table: true },
  { can_truncate: true },
  { can_create: true },
  { tenant_column: false },
  { restrictive_policy: false },
]) {
  test(`pg rejects unsafe declared table ${JSON.stringify(table)}`, async () => {
    const f = fixture({ table });
    await assert.rejects(
      () =>
        f
          .adapter()
          .run(context, route, async () => assert.fail('must not run')),
      PgSafetyError,
    );
    assert.deepEqual(f.releases, [true]);
  });
}
test('pg validates configuration/context/routes before acquiring', async () => {
  const f = fixture();
  assert.throws(() => f.adapter({ tables: [] }), /protected table/);
  assert.throws(() => f.adapter({ acquireTimeoutMs: 0 }), /Timeout/);
  await assert.rejects(() =>
    f.adapter().run({ tenantId: '' }, route, async () => {}),
  );
  await assert.rejects(() =>
    f.adapter().run(context, { ...route, status: 'suspended' }, async () => {}),
  );
  assert.deepEqual(f.queries, []);
});
test('pg preserves callback failures after successful rollback', async () => {
  const f = fixture(),
    failure = new Error('business failure');
  await assert.rejects(
    () =>
      f.adapter().run(context, route, async () => {
        throw failure;
      }),
    (error) => error === failure,
  );
  assert.ok(!f.queries.includes('COMMIT'));
  assert.deepEqual(f.releases, [false]);
});
test('pg refuses to commit after a swallowed SQL error', async () => {
  const failure = new Error('SQL failure');
  const f = fixture({
    query: (text) =>
      text === 'SELECT fail' ? Promise.reject(failure) : undefined,
  });
  await assert.rejects(
    () =>
      f.adapter().run(context, route, async (client) => {
        await client.query('SELECT fail').catch(() => {});
      }),
    (error) => error === failure,
  );
  assert.ok(!f.queries.includes('COMMIT'));
  assert.deepEqual(f.releases, [false]);
});
test('pg rejects transaction commands and nested adapter calls', async () => {
  const f = fixture(),
    adapter = f.adapter();
  await assert.rejects(
    () => adapter.run(context, route, (client) => client.query('COMMIT')),
    /data statements/,
  );
  await adapter.run(context, route, async () => {
    await assert.rejects(
      () => adapter.run(context, route, async () => {}),
      /Nested/,
    );
  });
  assert.deepEqual(f.releases, [true, false]);
});
test('pg preserves callback and cleanup failures and destroys the connection', async () => {
  let rollbacks = 0;
  const failure = new Error('business'),
    cleanup = new Error('rollback');
  const f = fixture({
    query: (text) =>
      text === 'ROLLBACK' && ++rollbacks > 1
        ? Promise.reject(cleanup)
        : undefined,
  });
  await assert.rejects(
    () =>
      f.adapter().run(context, route, async () => {
        throw failure;
      }),
    (error) =>
      error instanceof PgCleanupError &&
      error.errors[0] === failure &&
      error.errors[1] === cleanup &&
      error.commitOutcome === 'not-committed',
  );
  assert.deepEqual(f.releases, [true]);
});
test('pg reports committed writes when post-commit cleanup fails', async () => {
  const f = fixture({
    query: (text) =>
      text === 'RESET ALL' ? Promise.reject(new Error('reset')) : undefined,
  });
  await assert.rejects(
    () => f.adapter().run(context, route, async () => {}),
    (error) =>
      error instanceof PgCleanupError && error.commitOutcome === 'committed',
  );
  assert.deepEqual(f.releases, [true]);
});
test('pg reports uncertain commit outcomes and never reuses that connection', async () => {
  const f = fixture({
    query: (text) =>
      text === 'COMMIT' ? Promise.reject(new Error('socket')) : undefined,
  });
  await assert.rejects(
    () => f.adapter().run(context, route, async () => {}),
    PgCommitError,
  );
  assert.deepEqual(f.releases, [true]);
});
test('pg operation timeout closes escaped clients and prevents a late commit', async () => {
  const f = fixture();
  let finish: () => void = () => {};
  let escaped: PgTenantClient | undefined;
  await assert.rejects(
    () =>
      f
        .adapter({ operationTimeoutMs: 25 })
        .run(context, route, async (client) => {
          escaped = client;
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        }),
    PgTimeoutError,
  );
  await assert.rejects(() => escaped!.query('SELECT 1'), /outside/);
  finish();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(!f.queries.includes('COMMIT'));
  assert.deepEqual(f.releases, [true]);
});
test('pg discards clients acquired after the acquisition deadline', async () => {
  let deliver: (client: PoolClient) => void = () => {};
  const f = fixture({
    acquire: () =>
      new Promise((resolve) => {
        deliver = resolve;
      }),
  });
  await assert.rejects(
    () =>
      f.adapter({ acquireTimeoutMs: 10 }).run(context, route, async () => {}),
    PgTimeoutError,
  );
  deliver(f.client);
  await Promise.resolve();
  assert.deepEqual(f.releases, [true]);
});
test('pg handles acquired socket errors and discards the client', async () => {
  const f = fixture();
  await assert.rejects(
    () =>
      f.adapter().run(context, route, async () => {
        f.emitter.emit('error', new Error('socket lost'));
        await new Promise(() => {});
      }),
    /socket lost/,
  );
  assert.deepEqual(f.releases, [true]);
});
test('pg bounds cleanup and destroys a connection whose reset never completes', async () => {
  const f = fixture({
    query: (text) => (text === 'RESET ALL' ? new Promise(() => {}) : undefined),
  });
  await assert.rejects(
    () =>
      f.adapter({ cleanupTimeoutMs: 10 }).run(context, route, async () => {}),
    (error) =>
      error instanceof PgCleanupError &&
      error.commitOutcome === 'committed' &&
      error.errors[0] instanceof PgTimeoutError,
  );
  assert.deepEqual(f.releases, [true]);
});
test('pg does not start a late transaction after a timed-out preflight', async () => {
  let deliver: (value: QueryResult) => void = () => {};
  const f = fixture({
    query: (text) =>
      text === 'ROLLBACK'
        ? new Promise((resolve) => {
            deliver = resolve;
          })
        : undefined,
  });
  await assert.rejects(
    () =>
      f
        .adapter({ operationTimeoutMs: 10 })
        .run(context, route, async () => assert.fail('must not run')),
    PgTimeoutError,
  );
  deliver(result('ROLLBACK'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(f.queries, ['ROLLBACK']);
  assert.deepEqual(f.releases, [true]);
});
test('pg bounds pool resolution without acquiring from a late pool', async () => {
  const f = fixture();
  let deliver: (pool: Pool) => void = () => {};
  await assert.rejects(
    () =>
      f
        .adapter({
          acquireTimeoutMs: 10,
          resolvePool: () =>
            new Promise((resolve) => {
              deliver = resolve;
            }),
        })
        .run(context, route, async () => {}),
    PgTimeoutError,
  );
  deliver(f.pool);
  await Promise.resolve();
  assert.deepEqual(f.queries, []);
  assert.deepEqual(f.releases, []);
});
test('pg propagates failed acquisitions without trying to release an unacquired client', async () => {
  const failure = new Error('pool unavailable');
  const f = fixture({
    acquire: async () => {
      throw failure;
    },
  });
  await assert.rejects(
    () => f.adapter().run(context, route, async () => {}),
    (error) => error === failure,
  );
  assert.deepEqual(f.releases, []);
});
