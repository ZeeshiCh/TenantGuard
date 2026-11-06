# @tenantguard/drizzle

Restricted tenant-scoped CRUD using Drizzle 0.45.4, verified with PostgreSQL 17, MySQL 8.4 and MariaDB 11.8. This unpublished ESM package implements the portable `DatabaseAdapter<DrizzleScopedClient>` contract for Node, NestJS, Hono and other Node JS/TS backends.

This is application-filter isolation. Strict routing rejects it; native Drizzle/database calls bypass the facade. PostgreSQL support here does not install RLS or inherit the direct pg adapter's native-policy guarantees.

## Define tables and configure routing

Create your schema using reviewed migrations before handling requests. Drizzle table definitions describe existing tables; this adapter does not provision or migrate databases.

```ts
import { pgTable, text } from 'drizzle-orm/pg-core';
import { createTenantRouter } from '@tenantguard/core';
import {
  createDrizzlePgResource,
  createDrizzleAdapter,
} from '@tenantguard/drizzle';

const orders = pgTable('orders', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  value: text('value').notNull(),
});
const resource = createDrizzlePgResource({
  connection: { connectionString: process.env.DATABASE_URL },
});
const adapter = createDrizzleAdapter({
  resolveResource: (route) => {
    if (route.resource !== 'orders-main') throw new Error('Unknown resource');
    return resource;
  },
  tables: {
    orders: {
      table: orders,
      tenantColumn: 'tenantId',
      idColumn: 'id',
      columns: ['id', 'tenantId', 'value'],
    },
  },
});
const router = createTenantRouter({
  sources: { orders: { adapter, mode: 'application-filter' } },
  registry: {
    resolve: async (context, source) => ({
      tenantId: context.tenantId,
      source,
      adapter: 'drizzle',
      resource: 'orders-main',
      revision: '1',
      status: 'active',
      mode: 'application-filter',
    }),
  },
});

// Obtained from authentication and membership authorization in your backend.
const rows = await router.run(authorizedContext, 'orders', async (client) => {
  const repository = client.table<typeof orders.$inferSelect>('orders');
  await repository.insert({ id: 'order-1', value: 'created' });
  await repository.update({ id: 'order-1' }, { value: 'ready' });
  return repository.find({ id: 'order-1' }, { limit: 10 });
});

// Stop request admission before application shutdown:
await resource.close();
```

For MySQL and MariaDB use `mysqlTable`/`varchar` from drizzle-orm/mysql-core and `createDrizzleMysqlResource({ connection: { host, port, user, password, database } })`. Both engines use Drizzle's official mysql2 integration and are tested independently. Drizzle's node-postgres integration is used for PostgreSQL. Connection configuration is snapshotted and must be cloneable; configure authentication/TLS there. These factories own connections and do not accept external pools, clients or extended Drizzle instances.

Table aliases are application lookup names; tenantColumn/idColumn/columns refer to Drizzle property keys, while live schema checks use the underlying physical names. Use concrete table objects, kept immutable for the adapter's lifetime. Aliased tables/proxy projections, explicit cross-database MySQL schemas and unknown objects are rejected. PostgreSQL explicitly qualified schemas are supported; unqualified definitions target public. Flat ASCII identifiers up to 63 characters are supported.

The public table input is structurally typed as object and validated at runtime. This accepts genuine table definitions across Drizzle's ESM/CommonJS boundary without incompatible private class declarations. ESM is the library entry point; CommonJS backends can dynamically import it. Row generics, including Drizzle's `$inferSelect`, are application type assertions rather than automatic validation that a projection contains every model field.

Multiple named sources can use separate Drizzle resources/providers or other TenantGuard adapters. Routes and credentials must be server-controlled, not request URLs. Transactions are atomic within one scope, without cross-source ACID guarantees.

## Exact CRUD surface

`client.table(alias)` exposes promise-returning `find`, `insert`, `update` and `delete`. Callbacks receive no native connection, Drizzle database/query builder, raw SQL API, relation API or transaction/savepoint handles.

Only declared standard scalar columns are selected or written. The schema guard rejects JSON, arrays, actual enum/numeric/decimal column types, custom encoders, generated/identity columns, SQL-valued defaults and runtime default/onUpdate hooks, including hooks on undeclared columns that Drizzle might execute implicitly. Database-side defaults/triggers and schema semantics still require independent review. Column objects/definitions and trusted application code are outside the arbitrary-code sandbox threat model.

Filters support scalar equality only; null uses IS NULL. Unknown columns, operators, SQL objects, callback expressions, relation options, nested writes, joins, upserts, aggregates, bulk/query-builder APIs and arbitrary Drizzle arguments are rejected. Inserts require an ID, inject tenant ownership and reject another supplied tenant. Updates prohibit ID/tenant reassignment and accept scalar assignments only. Update/delete require a non-tenant equality filter and return affected/matched counts. Tenant-aware keys, required fields and other constraints remain application-owned.

Find defaults to 100 rows, offset 0 and ID ascending. Limit is 1–1000, offset a bounded nonnegative integer, and ordering uses one declared column with asc/desc. Values are bound through Drizzle's operators/builders, with no text rewriting of caller SQL. Inputs are copied before entering the serialized queue: well-formed strings, finite numbers with safe integer representation, signed 64-bit bigint, boolean, valid Date, Uint8Array and null. The selected Drizzle column/driver must support the supplied scalar encoding; incompatible values fail and poison the transaction. Returned values follow Drizzle's column mappings. No implicit application-wide BSON/JSON/decimal codec is supplied.

An independent ownership predicate applies to every read/update/delete. PostgreSQL uses explicit COLLATE C equality and MySQL/MariaDB use binary equality in addition to ordinary equality. These are adapter-owned SQL fragments with bound values; caller SQL expressions remain forbidden. Supplied tenant filters also compare exactly. Case/accent/padding aliases cannot widen ownership even under permissive defaults or PostgreSQL nondeterministic collations. Decoded rows are checked again for exact tenant identity. Opaque tenant strings retain the core's bounds and require well-formed UTF-16 before encoding.

Live checks inside the transaction require ordinary PostgreSQL tables with ordinary TEXT/VARCHAR NOT NULL tenant columns, or ordinary InnoDB MySQL/MariaDB tables with ordinary VARCHAR NOT NULL tenant columns. Views, partitioned PostgreSQL tables, generated tenant columns, unsupported encodings and missing/invisible metadata fail closed. Unlike the restricted Prisma adapter, this adapter can enforce binary predicates through Drizzle SQL expressions and does not require changing the database's tenant collation to a particular allowlist.

Metadata checks do not audit every mapped field, privilege, policy, trigger, cascade or function. Review those separately, including tenant-aware foreign keys and uniqueness/existence leaks. Privileged concurrent DDL and mutable application schema objects remain trusted infrastructure boundaries. PostgreSQL UUID/citext/domain tenant columns are not supported here, and no tenant session variable or native RLS policy is configured.

## Transaction ownership and cleanup

Each run opens a fresh native connection, creates Drizzle against that connection and explicitly owns BEGIN/COMMIT/ROLLBACK on the same physical session. It uses Serializable isolation. This lifecycle does not delegate transaction ownership to a pool-backed Drizzle callback wrapper or expose nested transactions. No connection is reused by another adapter scope.

PostgreSQL pins search_path to public, pg_catalog, pg_temp for unqualified table resolution; qualified schemas retain their declared identity. PG connection settings enforce 5s statement, 1s lock and 30s idle-in-transaction timeouts; pipeline mode is disabled so pending work can be disconnected. MySQL uses UTF8MB4, UTC, single statements and FOUND_ROWS, verifies the selected database/autocommit state and sets a 1s InnoDB lock wait. Commit/rollback verify that no MySQL transaction status remains active. Authentication/TLS and server connection policy remain application configuration.

Facade operations serialize even with Promise.all. Caught validation/database errors poison the scope, stop queued work and force rollback. Pending unawaited operations cannot commit. Socket failures interrupt hanging callbacks. Nested/detached scopes and expired repositories reject further use. Callbacks are never automatically retried, including serialization conflicts.

Resource resolution and connection acquisition default to 5s each, requests 5s, the whole operation 30s and each cleanup/closure phase 5s. Options accept 1ms–300s; native connect timeout is separately configurable with the same bounds. Request timers include initial transaction/metadata operations. Deadline expiry revokes the facade, then rollback is attempted before closure. Native statements can still be in flight while cleanup is queued; its deadline triggers physical destruction rather than handing the session to another tenant.

Rollback/closure uncertainty destroys the connection. PostgreSQL uses pg Client.end with non-pipelined pending-query disconnection; MySQL uses immediate connection destruction. Closure that cannot be confirmed retires the resource and attempts to close its other active sessions, which can interrupt concurrent scopes. New connections are denied once a resource is closed/retired; infrastructure must explicitly replace it. Closing a resource destroys active sessions, while late-acquired connections are closed without beginning a transaction. Native calls or OS-level close acknowledgment may still take time; deadlines are not proof of immediate server-side cancellation.

Ordinary callback errors preserve identity when rollback and closure succeed. DrizzleLifecycleError aggregates primary/cleanup errors and reports commitOutcome (`not-committed`, `committed`, `unknown`). A commit attempt without confirmed acknowledgment is unknown; post-commit closure failure is committed. Read the aggregate outcome before reconciliation/retry. DrizzleTimeoutError identifies phase/outcome; a timeout can race with a successful commit. Use application idempotency records for uncertain writes. Arbitrary non-database callback side effects cannot be rolled back or cancelled.

Fresh connections trade throughput for lifecycle isolation. Bound application request concurrency and database connection budgets; there is no internal shared pool or global admission queue in this adapter. Keep transactions short and stop request admission before closing resources.

## Verified scope and deployment

The same seven reusable conformance cases run against real PostgreSQL 17, MySQL 8.4 and MariaDB 11.8 using actual Drizzle tables/builders and restricted runtime credentials. Additional real tests cover raw Drizzle bypass, permissive collation aliases, explicit foreign tenant filters, injected SQL objects/operators, swallowed failures, serialized operations, expired facades, lock/request/work deadlines, pending writes, view/engine/schema refusal and native connection closure. Unit tests inject socket/listener failures, late acquisition, ambiguous commits and rollback/close failures. The three real-engine suites also pass separately on Node 22.

Packed-package checks exercise JavaScript/TypeScript consumers with actual Drizzle table definitions, resource construction and strict-routing refusal, plus CommonJS-defined tables crossing the ESM boundary. The original package consumer retains full strict declaration checking. The separate Drizzle consumer uses strict usage checks with skipLibCheck because Drizzle 0.45.4 references optional driver declarations and has upstream declaration errors; negative type assertions still verify rejection of SQL values and incomplete connection options. The pure guard/compiler graph is browser-bundled to verify its import boundary; the concrete native-driver adapter requires Node.

Only Drizzle 0.45.4 with node-postgres/mysql2 and the three engines above is verified. SQLite/SQL Server Drizzle providers, serverless HTTP/proxy drivers, full relation/query parity, generated/runtime-hook schemas, external pools, native-policy mode, edge/Bun/Deno, performance certification and independent review remain future work. No package or service has been published or deployed. Ship the library inside your backend with your own database schema, credentials and migrations.

References: [Drizzle transactions](https://orm.drizzle.team/docs/transactions), [Drizzle table introspection](https://github.com/drizzle-team/drizzle-orm/blob/main/docs/table-introspect-api.md), [Drizzle SQL/operators](https://orm.drizzle.team/docs/sql), [mysql2 integration](https://orm.drizzle.team/docs/mysql/get-started-mysql).
