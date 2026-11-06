# @tenantguard/sqlite

Tenant-scoped CRUD over real SQLite files using Node's built-in `node:sqlite` driver in private worker threads. This unpublished ESM package implements `DatabaseAdapter<SqliteScopedClient>` and requires Node.js >=22.16.0, including the driver transaction-state API. Node 22 exposes SQLite as experimental. No native npm addon or external database server is needed.

It uses the same explicit authorized context and portable router as the other database adapters. Plain Node, NestJS, Hono and other Node JS/TS backends can invoke it without a framework-specific database integration. Core/Fetch/Hono remain portable; this concrete adapter needs Node's SQLite and worker-thread APIs.

## Provision and configure

Create an ordinary database file and its schema during a trusted migration, before constructing the resource. Only existing absolute file paths are accepted; memory databases, URI connection strings and automatic provisioning are outside this API. The runtime process needs OS permissions on the file and directory for journal/WAL sidecars. Use durable local storage appropriate to your deployment; serverless ephemeral disks and network filesystems are not certified here.

```ts
// Trusted migration, not request code:
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('/srv/data/orders.sqlite');
db.exec(`
  CREATE TABLE orders (
    id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY (tenant_id COLLATE BINARY, id)
  );
`);
db.close();
```

```ts
import { createTenantRouter } from '@tenantguard/core';
import { createSqliteResource, createSqliteAdapter } from '@tenantguard/sqlite';

const resource = createSqliteResource({
  filename: '/srv/data/orders.sqlite',
  busyTimeoutMs: 100,
  maxQueue: 100,
});
const adapter = createSqliteAdapter({
  resolveResource: (route) => {
    if (route.resource !== 'orders-file') throw new Error('Unknown resource');
    return resource;
  },
  tables: {
    orders: {
      table: 'orders',
      tenantColumn: 'tenant_id',
      idColumn: 'id',
      columns: ['id', 'tenant_id', 'value'],
    },
  },
});
const router = createTenantRouter({
  sources: { orders: { adapter, mode: 'application-filter' } },
  registry: {
    resolve: async (context, source) => ({
      tenantId: context.tenantId,
      source,
      adapter: 'sqlite',
      resource: 'orders-file',
      revision: '1',
      status: 'active',
      mode: 'application-filter',
    }),
  },
});

// Obtained from your application's authentication/membership authorizer.
const result = await router.run(authorizedContext, 'orders', async (client) => {
  const orders = client.table('orders');
  await orders.insert({ id: 'order-1', value: 'created' });
  await orders.update({ id: 'order-1' }, { value: 'ready' });
  return orders.find({ id: 'order-1' });
});

// During application shutdown:
await resource.close();
```

Use one long-lived resource per canonical file in a process. Its bounded FIFO queue admits one scope at a time, matching SQLite's single-writer model. Independent resources/processes use independent connections and can encounter SQLite lock contention. Each scope starts a new worker and connection and closes both before admitting the next one, favoring lifecycle isolation over connection-pooling throughput. Worker startup is included in the request deadline. Keep transactions short; avoid remote network calls while holding a write transaction.

Paths, schema and resource references are server-controlled infrastructure, never raw tenant headers or client-provided URLs. Symlink targets, concurrent file replacement and the containing directory must remain trusted. The initial existence check is not an OS security boundary. Separate named sources can also use PostgreSQL, SQL Server, MySQL, MariaDB or MongoDB; each run is independently atomic and there is no cross-source ACID guarantee.

## Exact CRUD contract

`client.table(alias)` exposes promise-returning `find`, `insert`, `update` and `delete`. It does not expose DatabaseSync, workers, cursors, raw SQL, PRAGMA, ATTACH, extensions, transaction commands, joins, expressions, upserts, bulk operations or schema changes.

The shared portable SQL compiler generates SQLite-specific grammar and binds all values. Each read/update/delete requires scalar TEXT ownership and explicit BINARY collation, independent of a table's NOCASE default or SQLite's dynamic value types. Case/accent/padding aliases and BLOB-valued tenant identifiers cannot widen ownership. Opaque tenant IDs must be well-formed Unicode, with the core's length/whitespace/control-character restrictions.

The registered table must be an ordinary main-schema table; views, virtual/shadow tables and generated registered columns are rejected. The tenant column must be declared exactly TEXT, ordinary and NOT NULL. Only declared columns may be selected or written; identifier names follow the shared compiler's flat ASCII grammar and 64-character limit. Inserts inject tenant ownership and reject a different supplied tenant. ID/tenant updates are forbidden. Update/delete require at least one non-tenant equality filter and return affected counts. SQLite schema constraints determine uniqueness and required ID values; provision tenant-aware keys and foreign keys yourself.

Filters accept equality values only; null generates IS NULL. Find defaults to 100 rows (maximum 1000), offset 0 and ID ascending. Options permit an allowlisted column and asc/desc direction, plus bounded integer pagination. Every update/delete remains independently tenant-scoped regardless of filters.

Values are string, finite numbers (integer numbers must be safe), signed 64-bit bigint, boolean, valid Date, Uint8Array or null. Mutable values are copied before queueing; unsupported objects/functions and ill-formed text are rejected. Booleans bind as INTEGER 0/1, dates as UTC ISO text and Uint8Array as BLOB. Returned INTEGER values are bigint to preserve 64-bit precision; REAL values are numbers, including values stored as REAL because of SQLite affinity or number binding. TEXT/null/BLOB are returned as strings/null/Uint8Array. Row generics are application type assertions, not schema validation or coercion.

## Transaction and cleanup guarantees

The worker opens a private connection with extensions and double-quoted string literals disabled. It enables foreign keys, FULL synchronization and recursive triggers, disables trusted schema and dirty reads, and checks supported journal mode, attachment state and schema metadata. It begins IMMEDIATE before callback execution, so writer-lock failures deny business work rather than allowing a later read-to-write upgrade to surprise the callback. Rollback-journal and WAL files are accepted; journal mode is not changed automatically. OFF and memory journaling are refused when observed on the connection.

Operations serialize even when the callback uses Promise.all. Every native CRUD operation verifies that its explicit transaction is still active, guarding against SQLite conflict algorithms that automatically roll back. Swallowed validation/database failures poison the scope and prevent subsequent statements or commit. Pending unawaited work prevents commit. Nested/detached scopes and expired facades are rejected; callers must await all work inside the callback.

After work, COMMIT is attempted once. If SQLite reports an error while the transaction remains active (including busy commit or deferred constraints), cleanup rolls it back and reports not-committed. A lost worker/reply during commit remains unknown. Cleanup rolls back any active transaction, verifies transaction and connection safety state, closes the connection and terminates the worker before releasing its queue slot. Connections are never reused between scopes.

Acquisition/resource resolution, each worker request, the whole operation and each cleanup/termination phase have finite deadlines. Defaults are 5s, 5s, 30s and 5s respectively; each option accepts 1ms–300s. The resource's native lock-wait timeout defaults to 100ms, also bounded to 300s. Queue capacity defaults to 100, configurable from 1–10000. Acquisition expiry cannot execute a queued callback later; late resolver results cannot start transactions after their deadline.

If cleanup or worker termination cannot be confirmed, the resource is terminally retired, queued callers are rejected and worker termination is requested. It cannot silently reopen; infrastructure must construct a replacement. Termination of a worker running native SQLite code may wait for that call to return. A retired worker is never reused, but its outstanding call can retain file locks until termination completes; a deadline is not proof of immediate OS-level cancellation. `close()` returns the retirement promise and may wait for native work; adapter waits are separately bounded. Use process isolation if immediate hard termination is a deployment requirement. Arbitrary non-database callback side effects also cannot be undone or cancelled by these deadlines.

Ordinary callback/database errors preserve identity when cleanup succeeds and no commit was attempted. `SqliteTimeoutError` includes phase and commitOutcome. `SqliteLifecycleError` aggregates primary/cleanup errors and includes commitOutcome (`not-committed`, `committed`, `unknown`); read that aggregate outcome after a cleanup or commit failure. A timeout during commit can race with a successful commit. No business callback or failed transaction is automatically retried; reconcile unknown outcomes using application idempotency records.

Closing a resource rejects queued acquisition and retires its active worker. The active callback may continue arbitrary application work, but its facade cannot execute new database operations or commit. Shut down request admission before closing resources.

## Enforcement and verified support

This is application-filter isolation, which strict routing rejects. Any native SQLite connection with file access can read every tenant. OS/file permissions, trusted application code and trusted schema/provisioning are required; tenant predicates do not sandbox compromised code. Review triggers, cascades, constraints and globally unique keys for indirect cross-tenant effects and existence leaks. Preflight metadata does not certify schema semantics. Database-per-tenant enforcement mode, ORM integration, aggregate/query languages and file provisioning are not implemented by this adapter.

Tests run the exact same seven reusable conformance cases against a real on-disk SQLite engine. Additional real cases verify byte/type aliases, injected inputs, swallowed constraint failures, automatic rollback conflicts, deferred foreign-key and busy commit failures, writer locks/main-loop responsiveness, deadlines, queue expiry, retirement, shutdown, types and durability. Unit tests cover compiler guards and transport failure/termination. The SQLite-focused suite passes on the local runtime and Node 22; all database integration suites are rerun after the shared compiler change. Packaged JavaScript consumers execute an actual worker from the installed tarball, and TypeScript consumers resolve installed declarations.

This is local engine/runtime evidence, not certification of every SQLite version, OS, network filesystem, encryption addon, libSQL, Cloudflare D1, Bun or Deno SQLite API. The audit CLI remains PostgreSQL-only. No package has been published or service deployed: install the library inside your backend, ship the worker asset with it and use your own durable database file.

References: [Node SQLite APIs and transaction state](https://nodejs.org/api/sqlite.html), [SQLite transactions and busy COMMIT](https://www.sqlite.org/lang_transaction.html), [SQLite PRAGMA settings](https://www.sqlite.org/pragma.html).
