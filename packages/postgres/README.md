# PostgreSQL policies and direct pg adapter

The root entry point exports SQL policy helpers and the basic audit inventory. The separate `@tenantguard/postgres/pg` entry point exports a Node-only direct driver adapter. Install pg alongside this package when using the direct adapter. No NestJS or ORM dependency is required.

```ts
import pg from 'pg';
import { createTenantRouter } from '@tenantguard/core';
import { createPgAdapter } from '@tenantguard/postgres/pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 10000,
});
pool.on('error', (error) => reportIdlePoolError(error));
const pools = new Map([['orders-main', pool]]);
const adapter = createPgAdapter({
  resolvePool: (route) => {
    const selected = pools.get(route.resource);
    if (!selected) throw new Error('Unknown database resource');
    return selected;
  },
  tables: [{ schema: 'public', table: 'orders' }],
});
const router = createTenantRouter({
  strict: true,
  sources: { orders: { adapter, mode: 'database-policy' } },
  registry: {
    resolve: async (context, source) => ({
      tenantId: context.tenantId,
      source,
      adapter: 'pg',
      resource: 'orders-main',
      revision: '1',
      status: 'active',
      mode: 'database-policy',
    }),
  },
});

// context must come from your membership-checking TenantGuard authorizer.
const rows = await router.run(
  context,
  'orders',
  async (client) =>
    (await client.query('SELECT * FROM public.orders WHERE id = $1', [orderId]))
      .rows,
);
// On application shutdown, stop accepting work, drain it, then await pool.end().
```

This works with explicit contexts from Fetch, Hono, NestJS or other Node backends. It does not need the Node ambient tenant carrier. Adapter-local AsyncLocalStorage rejects nested/detached direct-pg scopes. Use the provided client inside the existing callback instead of starting another transaction.

## Database preparation

Create tables/migrations under a separate owner. Each declared table must be an ordinary table (partitions are not certified), have ENABLE and FORCE RLS, a UUID NOT NULL tenant column, and an all-command restrictive policy applying to PUBLIC. `tenantPolicySql` generates the corresponding permissive/restrictive pair. The restrictive policy still needs a correct tenant predicate: the adapter checks its presence, not its expression semantics.

The login/current role must match and have no direct or reachable administrative, BYPASSRLS, role-creation, database-creation or replication privileges. Runtime membership in table-owner roles, TRUNCATE privileges and CREATE privileges in declared schemas are rejected. Older databases may require an owner-run `REVOKE CREATE ON SCHEMA public FROM PUBLIC`. Audit all other role grants, accessible functions, views and undeclared tables independently.

Tenant IDs must be canonical lowercase UUIDs. Dedicated, application-owned pools are required: do not share them with TypeORM, another tenant-session manager, named statement users or arbitrary pool consumers. Resolver lookups use allowlisted server-controlled resource references, not client-supplied connection URLs. Configure TLS and secrets in pg according to your deployment; the adapter does not weaken TLS settings or manage credentials.

## Connection lifecycle

1. Validate and snapshot context/route before resolving the dedicated pool.
2. Bound pool resolution and acquisition; destroy clients delivered after the acquisition deadline.
3. Pin one client, roll back any unfinished transaction, reject changed-role or nonempty session-tenant state, and inspect role/table safety flags.
4. BEGIN; set tenant ID, row_security, an explicit search path, statement/lock limits and idle-in-transaction timeout locally on that connection.
5. Execute the callback. Every query must be awaited. A swallowed SQL error prevents commit; an outstanding query when the callback returns also prevents commit.
6. COMMIT or ROLLBACK. Before safe reuse, verify empty tenant context, reset role/settings, release session advisory locks and verify state again. Destroy on timeout, socket error, safety violation, uncertain commit or failed cleanup.

The client facade exposes only promise-based, unnamed, single data statements starting with SELECT, INSERT, UPDATE, DELETE, WITH or VALUES. Leading SQL comments, EXPLAIN, transaction/session commands, DDL, cursors and query-config objects are not supported. Extended query protocol rejects multiple statements. Parameterize values. This is a deliberately bounded API, not an SQL parser or sandbox: functions and arbitrary trusted SQL can still change session state or bypass your intended schema boundaries. Do not expose query text to untrusted callers.

Escaped clients reject new queries after callback completion or timeout. A timeout cannot cancel arbitrary application code; that code may continue its non-database side effects. Detached async work must be reauthorized in a fresh top-level job, outside the transaction's inherited scope. The adapter does not automatically retry operations.

## Timeouts and errors

| Option             | Default | Meaning                                                                        |
| ------------------ | ------- | ------------------------------------------------------------------------------ |
| acquireTimeoutMs   | 5000    | Separate bound for pool resolution and for client acquisition                  |
| operationTimeoutMs | 30000   | Total acquired-session operation, including safety checks, callback and COMMIT |
| cleanupTimeoutMs   | 2000    | Bound for each cleanup statement                                               |
| statementTimeoutMs | 15000   | PostgreSQL transaction-local statement limit                                   |
| lockTimeoutMs      | 5000    | PostgreSQL transaction-local lock acquisition limit                            |

All limits require positive 32-bit integer milliseconds. Configure pool connectionTimeoutMillis too: adapter deadlines discard late clients but cannot remove arbitrary pool/resolver work from its own queue. Cleanup can take multiple per-statement limits; it is not included in operationTimeoutMs.

Ordinary callback/SQL errors are preserved when rollback and cleanup succeed. `PgSafetyError` signals a failed safety check or scope misuse. `PgTimeoutError` identifies the timed-out phase and commitOutcome. `PgCleanupError` preserves primary/cleanup failures in its errors array and reports commitOutcome. `PgCommitError` means COMMIT was attempted but its result is uncertain.

Commit outcomes are not-committed, committed or unknown. Post-commit cleanup can fail after writes have committed. Lost connections or deadlines while COMMIT is in flight may leave an unknown outcome. Do not blindly retry these failures; use application idempotency keys and reconcile against persisted state. The absence of an outcome field on a driver transport error does not imply retry safety.

## Verification and limits

Both direct pg and TypeORM execute the same reusable real-database conformance cases. Additional pg tests cover session contamination, unfinished transactions, swallowed SQL failures, statements/locks/operation deadlines, inherited bypass roles, ownership/FORCE checks, unawaited queries and backend termination. Fault-injection unit tests cover cleanup failure, stalled preflight/reset, late acquisition and uncertain commits.

These checks do not validate arbitrary policy expressions, classify every queried table, prove safety of SECURITY DEFINER functions/views, or certify partitions and transaction/statement-pooling proxies. Only direct PostgreSQL 17 connections are tested in this milestone. TypeORM retains its separate, less extensive lifecycle implementation; this hardening is not automatically applied to ORM-managed connections.

References: [node-postgres transactions](https://node-postgres.com/features/transactions), [pool lifecycle and error handling](https://node-postgres.com/apis/pool), [PostgreSQL session settings](https://www.postgresql.org/docs/current/runtime-config-client.html).
