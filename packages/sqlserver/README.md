# SQL Server native RLS adapter

`@tenantguard/sqlserver` exports schema-bound native RLS migrations, a dedicated Tedious connection pool and `createSqlServerAdapter`. It implements the portable `DatabaseAdapter<SqlServerTenantClient>` contract. Use explicit contexts from Node, NestJS, Hono, Fetch or another Node backend; no framework/ORM or ambient tenant carrier is required.

## Configure runtime access

```ts
import { createTenantRouter } from '@tenantguard/core';
import {
  createSqlServerPool,
  createSqlServerAdapter,
} from '@tenantguard/sqlserver';

const pool = createSqlServerPool({
  connection: {
    server: 'sqlserver.internal',
    authentication: {
      type: 'default',
      options: { userName: 'tenantguard_app', password: readRuntimeSecret() },
    },
    options: {
      database: 'saas',
      encrypt: true,
      trustServerCertificate: false,
    },
  },
  max: 10,
});
const resources = new Map([['orders-main', pool]]);
const adapter = createSqlServerAdapter({
  resolvePool: (route) => {
    const selected = resources.get(route.resource);
    if (!selected) throw new Error('Unknown database resource');
    return selected;
  },
  tables: [{ schema: 'dbo', table: 'orders' }],
});
const router = createTenantRouter({
  strict: true,
  sources: { orders: { adapter, mode: 'database-policy' } },
  registry: {
    resolve: async (context, source) => ({
      tenantId: context.tenantId,
      source,
      adapter: 'sqlserver',
      resource: 'orders-main',
      revision: '1',
      status: 'active',
      mode: 'database-policy',
    }),
  },
});

// Obtain context from an authorizer that verified authentication and tenant membership.
const rows = await router.run(
  context,
  'orders',
  async (client) =>
    (
      await client.query('SELECT * FROM dbo.orders WHERE id = @id', {
        id: orderId,
      })
    ).rows,
);
// Stop accepting work, drain it, then await pool.close() during application shutdown.
```

Use server-controlled resource/secret mappings. Never turn client input into a connection configuration. The pool snapshots cloneable Tedious configuration; SQL login authentication is tested. Non-cloneable credential providers and Azure/Windows authentication modes are not certified. TLS verification remains enabled in production configurations. Test fixtures explicitly trust their ephemeral container's self-signed certificate.

The physical pool is owned by this adapter. Do not share leases with node-mssql, an ORM, arbitrary application queries or another transaction manager. Low-level SqlServerSession methods are for trusted infrastructure and migrations; expose only SqlServerTenantClient to business handlers. Driver callbacks do not release the connection at commit: it stays pinned until cleanup and verification finish.

## Prepare the database

Create a `uniqueidentifier NOT NULL` tenant column and apply the helper's migration batches with a separate administrative connection:

```ts
for (const batch of sqlServerPolicyBatches({
  schema: 'dbo',
  table: 'orders',
})) {
  await migrationSession.query(batch);
}
```

The three batches create the security schema, a schema-bound inline table-valued predicate, then an enabled schema-bound policy with a FILTER predicate and AFTER INSERT / AFTER UPDATE BLOCK predicates. CREATE FUNCTION starts its own batch. Missing, empty, malformed or incorrectly sized context cannot match the UUID predicate. There is no administrative bypass branch in the generated predicate.

Default names are `[tenantguard].[dbo_orders_tenant_predicate]` and `[tenantguard].[dbo_orders_tenant_policy]`. Override securitySchema, predicateName, policyName or tenantColumn consistently in migration and adapter table configuration when needed. Identifiers are bounded ASCII identifiers; names are not interpolated from requests. UUID contexts must be canonical lowercase strings.

Grant runtime CRUD access only to the necessary tables and visibility of the configured policy/function metadata. For the default security schema:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.orders TO tenantguard_app;
GRANT VIEW DEFINITION ON SCHEMA::tenantguard TO tenantguard_app;
```

The adapter rejects administrative roles, effective database/server control and schema/security-management privileges, visible effective impersonation grants, table/schema/function ALTER privileges, missing metadata, nullable/non-UUID tenant columns and missing/disabled/unbound filter or insert/update block predicates. The predicate binding is compared with SQL Server's normalized form for the configured function/column. The function body and all other reachable tables/functions still require independent review.

## Physical session lifecycle

1. Validate context/route; resolve an allowlisted pool; bound acquisition and destroy any late lease.
2. Roll back unfinished user transactions, require empty SESSION_CONTEXT and unchanged login identity, and inspect runtime privileges and declared policy metadata.
3. Begin on the pinned TDS connection. Set XACT_ABORT and LOCK_TIMEOUT through a true TDS batch so settings persist outside sp_executesql. Set app.tenant_id with sp_set_session_context using read_only=0.
4. Serialize callback requests on that one connection. After each data batch, verify tenant, identity, database, transaction count/state and session options. Swallowed SQL errors and outstanding queries prevent adapter commit.
5. Commit or roll back, explicitly clear app.tenant_id, verify empty context and no user transaction, perform a driver connection reset, then verify again before release.
6. Destroy on timeout, socket failure, safety violation, uncertain commit or unverified cleanup. A read-only poisoned context cannot be cleared and is destroyed, never silently reused.

SQL Server SESSION_CONTEXT is session-scoped: rollback alone does not remove it. Outside an explicit user transaction, session inspection uses @@TRANCOUNT to avoid misclassifying transient internal transactions. Within a tenant scope, one committable user transaction is required.

Concurrent facade queries are queued because Tedious permits one active request per connection. Every query must be awaited. An escaped facade rejects new work after callback completion or timeout. Nested/detached adapter scopes are rejected; use the current facade inside an existing transaction and authorize detached jobs in a fresh top-level scope. Timeouts close database access but cannot cancel arbitrary application-side work.

## Query and error contract

`client.query<Row>(text, parameters)` returns `{ rows: Row[], rowCount: number }`. Parameter names omit `@`. Supported inferred values are null, strings, booleans, finite safe numbers, signed 64-bit bigint, valid Date and Uint8Array. Null uses NVARCHAR binding; explicitly CONVERT parameters when SQL requires another type. Strings over 4000 characters use NVARCHAR(MAX). Use OUTPUT when you need returned write records; complex multi-result batches are not modeled as separate recordsets.

Queries are trusted T-SQL data batches starting with SELECT, INSERT, UPDATE, DELETE or WITH. The prefix check is not a SQL parser or sandbox. Do not embed transaction/session management, DDL, privilege changes or impersonation in a data batch. Unlike pg extended protocol, T-SQL can contain multiple statements; transaction-control contract violations may already have side effects that cannot be undone. Parameterize values and never accept arbitrary SQL text from callers. SESSION_CONTEXT is an application-controlled identity channel, not protection against SQL injection or compromised application code.

| Adapter option     | Default | Bound                                                       |
| ------------------ | ------- | ----------------------------------------------------------- |
| acquireTimeoutMs   | 5000    | Separate limits for pool resolution and acquisition         |
| operationTimeoutMs | 30000   | Acquired-session work including checks, callback and commit |
| requestTimeoutMs   | 15000   | Tedious request cancellation deadline                       |
| lockTimeoutMs      | 5000    | Physical-session SQL Server lock wait limit                 |
| cleanupTimeoutMs   | 2000    | Each cleanup/reset/verification operation                   |

The pool separately bounds connection creation/acquisition and accepts max, connectTimeoutMs, acquireTimeoutMs and idleTimeoutMs. Configure pool and adapter bounds together. Cleanup is outside operationTimeoutMs and may use multiple cleanupTimeoutMs periods.

Ordinary callback/SQL errors are preserved when rollback/cleanup succeeds. SqlServerSafetyError denotes rejected state; SqlServerTimeoutError includes phase and commitOutcome; SqlServerCleanupError preserves errors and commitOutcome; SqlServerCommitError means an attempted commit has an unknown outcome. Outcomes are not-committed, committed or unknown. Post-commit cleanup failures do not undo committed writes. Use idempotency and reconcile uncertain outcomes instead of blindly retrying. Outcome semantics assume the supported callback contract, including no embedded transaction management.

## Verification and support limits

The adapter executes the same seven real-database conformance cases as direct pg and TypeORM. Additional real-engine tests cover physical reuse and clearing, read-only context poisoning, swallowed failures, cancellation, lock/operation timeouts, serialized requests, effective impersonation grants, inherited privileges, disabled policies and killed sessions. Fault-injection unit tests cover late acquisition, reset/cleanup/commit failures, expired facades and socket errors.

Tests use a pinned Microsoft SQL Server 2022 Developer image, accept its Developer EULA for non-production testing, create only synthetic data, and tear down containers. The integration command runs database files sequentially to bound memory use. Local runs used x86-64 emulation on ARM; Microsoft does not support that topology for production. CI targets native x86-64 Linux, but no remote CI run has been performed in this session. Allow at least 3 GiB for the SQL Server test container, image download space and time for startup.

Azure SQL, Windows authentication, MARS, pooling proxies, custom authentication callbacks, arbitrary policy bodies, signed/impersonating modules, all undeclared tables and SQL Server version combinations are not certified by this milestone. There is no independent security review or distributed transaction guarantee. The audit CLI remains PostgreSQL-specific.

References: [Microsoft RLS](https://learn.microsoft.com/en-us/sql/relational-databases/security/row-level-security), [SESSION_CONTEXT lifecycle](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-set-session-context-transact-sql), [Tedious connection lifecycle](https://tediousjs.github.io/tedious/api-connection.html), [Microsoft container platform requirements](https://learn.microsoft.com/en-us/sql/linux/install-upgrade/quickstart-install-docker).
