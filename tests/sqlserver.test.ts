import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSqlServerAdapter,
  SqlServerCleanupError,
  SqlServerCommitError,
  SqlServerSafetyError,
  SqlServerTimeoutError,
  type SqlServerSession,
  type SqlServerSessionPool,
  type SqlServerResult,
  type SqlServerTenantClient,
} from '../packages/sqlserver/src/index.js';
import type { TenantRoute } from '../packages/core/src/index.js';
const context = { tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
const route: TenantRoute = {
  ...context,
  source: 'orders',
  adapter: 'sqlserver',
  resource: 'test',
  revision: '1',
  status: 'active',
  mode: 'database-policy',
};
const tables = [{ schema: 'dbo', table: 'orders' }];
function fixture(
  options: {
    role?: Record<string, unknown>;
    table?: Record<string, unknown>;
    query?: (text: string) => Promise<SqlServerResult> | undefined;
    commitError?: Error;
    resetError?: Error;
    acquire?: () => Promise<SqlServerSession>;
  } = {},
) {
  const state = {
    database_name: 'test',
    user_name: 'app',
    login_name: 'app',
    effective_login: 'app',
    tenant: null as string | null,
    transaction_count: 0,
    transaction_state: 0,
    lock_timeout: -1,
    xact_abort: 0,
  };
  const calls: string[] = [],
    releases: boolean[] = [],
    listeners = new Set<(error: Error) => void>();
  let resets = 0;
  const session = {
    query: async (text: string, parameters: Record<string, unknown> = {}) => {
      calls.push(text);
      const override = options.query?.(text);
      if (override) return override;
      if (text.includes('privilege_0'))
        return {
          rows: [
            {
              ...state,
              ...Object.fromEntries(
                Array.from({ length: 20 }, (_, index) => [
                  `privilege_${index}`,
                  0,
                ]),
              ),
              ...options.role,
            },
          ],
          rowCount: 1,
        };
      if (text.includes('sys.security_predicates'))
        return {
          rows: [
            {
              system_type_id: 36,
              is_nullable: false,
              is_enabled: true,
              is_schema_bound: true,
              table_alter: 0,
              schema_alter: 0,
              security_alter: 0,
              predicate_alter: 0,
              filters: 1,
              insert_blocks: 1,
              update_blocks: 1,
              ...options.table,
            },
          ],
          rowCount: 1,
        };
      if (text.includes('@@TRANCOUNT AS transaction_count'))
        return { rows: [{ ...state, ...options.role }], rowCount: 1 };
      if (text.includes('SET XACT_ABORT ON')) {
        state.xact_abort = 1;
        state.lock_timeout = Number(
          /SET LOCK_TIMEOUT (\d+)/.exec(text)?.[1] ?? 5000,
        );
      }
      if (text.includes('DECLARE @tenantValue'))
        state.tenant = parameters.tenant as string;
      if (text.startsWith('IF @@TRANCOUNT')) {
        state.transaction_count = 0;
        state.transaction_state = 0;
        if (text.includes('@value=NULL')) state.tenant = null;
      }
      return { rows: [], rowCount: 0 };
    },
    batch: async (text: string, timeoutMs?: number) =>
      session.query(text, {}, timeoutMs),
    begin: async () => {
      calls.push('BEGIN');
      state.transaction_count = 1;
      state.transaction_state = 1;
    },
    commit: async () => {
      calls.push('COMMIT');
      if (options.commitError) throw options.commitError;
      state.transaction_count = 0;
      state.transaction_state = 0;
    },
    reset: async () => {
      resets++;
      if (options.resetError) throw options.resetError;
    },
    release: (destroy = false) => {
      releases.push(destroy);
    },
    onError: (listener: (error: Error) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as SqlServerSession;
  const pool: SqlServerSessionPool = {
    acquire: options.acquire ?? (async () => session),
  };
  return {
    session,
    pool,
    state,
    calls,
    releases,
    listeners,
    resets: () => resets,
    adapter: (
      settings: Partial<Parameters<typeof createSqlServerAdapter>[0]> = {},
    ) =>
      createSqlServerAdapter({ tables, resolvePool: () => pool, ...settings }),
  };
}
test('SQL Server pins a physical session through commit, explicit clearing, reset and verification', async () => {
  const f = fixture();
  let escaped: SqlServerTenantClient | undefined;
  const result = await f.adapter().run(context, route, async (client) => {
    escaped = client;
    await client.query('SELECT @id', { id: 1 });
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(f.state.tenant, null);
  assert.equal(f.state.transaction_count, 0);
  assert.equal(f.resets(), 1);
  assert.deepEqual(f.releases, [false]);
  assert.equal(f.listeners.size, 0);
  await assert.rejects(() => escaped!.query('SELECT 1'), /outside/);
  assert.equal('release' in escaped!, false);
});
for (const role of [
  { privilege_0: 1 },
  { privilege_8: null },
  { tenant: context.tenantId },
  { effective_login: 'other' },
])
  test(`SQL Server rejects unsafe identity/permissions ${JSON.stringify(role)}`, async () => {
    const f = fixture({ role });
    await assert.rejects(
      () =>
        f
          .adapter()
          .run(context, route, async () => assert.fail('must not run')),
      SqlServerSafetyError,
    );
    assert.deepEqual(f.releases, [true]);
    assert.ok(!f.calls.includes('BEGIN'));
  });
for (const table of [
  { is_enabled: false },
  { is_schema_bound: false },
  { is_nullable: true },
  { table_alter: 1 },
  { predicate_alter: 1 },
  { filters: 0 },
  { insert_blocks: 0 },
  { update_blocks: 0 },
])
  test(`SQL Server rejects unsafe native policy ${JSON.stringify(table)}`, async () => {
    const f = fixture({ table });
    await assert.rejects(
      () =>
        f
          .adapter()
          .run(context, route, async () => assert.fail('must not run')),
      SqlServerSafetyError,
    );
    assert.deepEqual(f.releases, [true]);
  });
test('SQL Server validates configuration and scopes before acquisition', async () => {
  const f = fixture();
  assert.throws(() => f.adapter({ tables: [] }), /protected table/);
  assert.throws(() => f.adapter({ cleanupTimeoutMs: 0 }), /Timeout/);
  await assert.rejects(() =>
    f.adapter().run({ tenantId: '' }, route, async () => {}),
  );
  await assert.rejects(() =>
    f.adapter().run(context, { ...route, status: 'suspended' }, async () => {}),
  );
  assert.deepEqual(f.calls, []);
});
test('SQL Server preserves ordinary callback failures after rollback and clearing', async () => {
  const failure = new Error('business'),
    f = fixture();
  await assert.rejects(
    () =>
      f.adapter().run(context, route, async () => {
        throw failure;
      }),
    (error) => error === failure,
  );
  assert.equal(f.state.tenant, null);
  assert.deepEqual(f.releases, [false]);
  assert.ok(!f.calls.includes('COMMIT'));
});
test('SQL Server swallowed query failures cannot commit', async () => {
  const failure = new Error('query failed'),
    f = fixture({
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
  assert.ok(!f.calls.includes('COMMIT'));
  assert.equal(f.state.tenant, null);
});
test('SQL Server rejects nested scopes and raw transaction entry points', async () => {
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
      adapter.run(context, route, (client) =>
        client.query('COMMIT TRANSACTION'),
      ),
    SqlServerSafetyError,
  );
  assert.deepEqual(f.releases, [false, true]);
});
test('SQL Server preserves both callback and cleanup errors', async () => {
  const original = new Error('business'),
    cleanup = new Error('read-only context');
  const f = fixture({
    query: (text) =>
      text.includes('@value=NULL') ? Promise.reject(cleanup) : undefined,
  });
  await assert.rejects(
    () =>
      f.adapter().run(context, route, async () => {
        throw original;
      }),
    (error) =>
      error instanceof SqlServerCleanupError &&
      error.errors[0] === original &&
      error.errors[1] === cleanup &&
      error.commitOutcome === 'not-committed',
  );
  assert.deepEqual(f.releases, [true]);
});
test('SQL Server reports committed outcome when session reset fails', async () => {
  const f = fixture({ resetError: new Error('reset') });
  await assert.rejects(
    () => f.adapter().run(context, route, async () => {}),
    (error) =>
      error instanceof SqlServerCleanupError &&
      error.commitOutcome === 'committed',
  );
  assert.deepEqual(f.releases, [true]);
});
test('SQL Server reports unknown commit outcome and destroys the physical session', async () => {
  const f = fixture({ commitError: new Error('socket') });
  await assert.rejects(
    () => f.adapter().run(context, route, async () => {}),
    SqlServerCommitError,
  );
  assert.deepEqual(f.releases, [true]);
});
test('SQL Server operation deadline revokes the facade and prevents late commit', async () => {
  const f = fixture();
  let finish: () => void = () => {},
    escaped: SqlServerTenantClient | undefined;
  await assert.rejects(
    () =>
      f
        .adapter({ operationTimeoutMs: 20 })
        .run(context, route, async (client) => {
          escaped = client;
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        }),
    SqlServerTimeoutError,
  );
  await assert.rejects(() => escaped!.query('SELECT 1'), /outside/);
  finish();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(!f.calls.includes('COMMIT'));
  assert.deepEqual(f.releases, [true]);
});
test('SQL Server destroys sessions acquired after the adapter deadline', async () => {
  let deliver: (session: SqlServerSession) => void = () => {};
  const f = fixture({
    acquire: () =>
      new Promise((resolve) => {
        deliver = resolve;
      }),
  });
  await assert.rejects(
    () =>
      f.adapter({ acquireTimeoutMs: 10 }).run(context, route, async () => {}),
    SqlServerTimeoutError,
  );
  deliver(f.session);
  await Promise.resolve();
  assert.deepEqual(f.releases, [true]);
});
test('SQL Server cleanup deadlines destroy stalled sessions', async () => {
  const f = fixture({
    query: (text) =>
      text.includes('@value=NULL') ? new Promise(() => {}) : undefined,
  });
  await assert.rejects(
    () =>
      f.adapter({ cleanupTimeoutMs: 10 }).run(context, route, async () => {}),
    SqlServerCleanupError,
  );
  assert.deepEqual(f.releases, [true]);
});
test('SQL Server unawaited work is rejected instead of committed', async () => {
  const f = fixture();
  await assert.rejects(
    () =>
      f.adapter().run(context, route, async (client) => {
        void client.query('SELECT 1');
      }),
    /unawaited/,
  );
  assert.ok(!f.calls.includes('COMMIT'));
  assert.deepEqual(f.releases, [true]);
});
test('SQL Server physical socket failures reject the operation and destroy the session', async () => {
  const f = fixture();
  await assert.rejects(
    () =>
      f.adapter().run(context, route, async () => {
        for (const listener of f.listeners) listener(new Error('socket'));
        await new Promise(() => {});
      }),
    /socket/,
  );
  assert.deepEqual(f.releases, [true]);
});
test('SQL Server releases an acquired session if error-listener registration fails', async () => {
  const f = fixture();
  f.session.onError = () => {
    throw new Error('already closed');
  };
  await assert.rejects(
    () => f.adapter().run(context, route, async () => {}),
    /already closed/,
  );
  assert.deepEqual(f.releases, [true]);
});
