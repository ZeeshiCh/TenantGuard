# Shared scoped SQL CRUD

Internal implementation shared by @tenantguard/mysql and @tenantguard/mariadb. Use a concrete driver adapter for application data access. This package supplies the restricted CRUD compiler, lease lifecycle, native-transport contracts and errors; its low-level compiler/transport exports are trusted infrastructure APIs.

## Enforcement boundary

These adapters advertise only application-filter mode. They do not provide PostgreSQL/SQL Server-style database-enforced row policies. Direct native SQL using the same credentials can read other tenants; integration tests explicitly demonstrate that limitation. The portable router rejects these adapters when strict is true or database-policy mode is requested. Every tenant-owned operation must use the scoped facade.

```ts
const tables = {
  orders: {
    table: 'orders',
    tenantColumn: 'tenant_id',
    idColumn: 'id',
    columns: ['id', 'tenant_id', 'value'],
  },
};
// Inside router.run(verifiedContext, 'orders', ...):
const orders = client.table('orders');
await orders.insert({ id: 'order-1', value: 'created' }); // tenant_id injected
const rows = await orders.find({ id: 'order-1' });
await orders.update({ id: 'order-1' }, { value: 'updated' });
await orders.delete({ id: 'order-1' });
```

Table aliases, database/table names and columns are validated and snapshotted at construction. Only declared columns are selected. Unknown tables/columns and SQL fragments are rejected. The facade exposes no raw query, session, transaction, connection or release API. Repositories are bound to one callback and reject use after it ends.

## CRUD contract

- find(where = {}, options = {}) returns an array. Filters are column/value equality combined with AND; null uses IS NULL. Tenant predicates are added independently and cannot be replaced by caller filters.
- find defaults to limit 100, offset 0 and ascending idColumn ordering. Limits must be integers from 1 through 1000; offsets are nonnegative 32-bit integers. Ordering accepts one declared column and asc/desc only.
- insert(row) inserts one row and returns affectedRows. It injects the verified tenant ID; an explicitly supplied different tenant is rejected.
- update(where, changes) and delete(where) return affectedRows and require at least one non-tenant equality filter. ID/tenant updates, empty changes and tenant-only/unfiltered mutations are rejected. FOUND_ROWS semantics request matched-row counts for updates, including unchanged values.
- No OR/operator objects, joins, raw expressions, upserts, bulk operations, aggregates or relational/nested writes are implemented. Unsupported features fail rather than receive a partial scoping transformation.

Values are null, well-formed strings, booleans, finite safe numbers, signed 64-bit bigint, valid Date or Uint8Array. Invalid values, undefined and custom toSqlString objects are rejected. Dates/bytes and statement values are snapshotted before queueing. Native drivers still control result decoding; MySQL preserves large integers as strings and MariaDB uses its native BigInt/string defaults.

Core IDs are opaque and case-sensitive. The compiler adds an index-compatible tenant equality plus byte-exact BINARY equality, preventing case/accent/PAD SPACE collation aliases from sharing a scope. Unpaired UTF-16 surrogates are rejected to prevent distinct JS strings becoming the same UTF-8 replacement bytes. No case folding or Unicode normalization occurs. Schema capacity checks conservatively use JS string length.

## Schema and database trust

Each declared table must be an ordinary InnoDB table with all registered columns and a sufficiently large UTF8MB4 VARCHAR NOT NULL tenant column. Views, nontransactional tables, CHAR/binary/nullable tenant columns and missing metadata are rejected. Metadata queries match database/table names byte-exactly too. The configured database and authenticated identity must stay consistent, and factory server-family checks reject MySQL/MariaDB misrouting.

Use owner-run migrations and restricted runtime CRUD grants. Prefer tenant-aware composite keys and foreign keys. A compatible starting schema for either engine is:

```sql
CREATE TABLE orders (
  tenant_id VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  value VARCHAR(256) CHARACTER SET utf8mb4 NOT NULL,
  PRIMARY KEY (tenant_id, id)
) ENGINE=InnoDB;
```

The compiler does not audit all grants, triggers, stored routines, cascades, foreign keys or unique constraints. Privileged database code can have effects outside generated statements; it must be reviewed separately. Global uniqueness/constraint errors can disclose existence information. Tenant-aware constraints and application error handling remain necessary. Shared/global tables and cross-tenant administrative access need separate audited paths. Do not run migrations or change storage engines concurrently with active scoped operations.

## Physical connection lifecycle

Concrete factories own dedicated physical pools, not native pools with automatic release/reset behavior. Do not share leases with ORMs or arbitrary application consumers.

1. Validate/snapshot context and route; reject missing/foreign/non-active/application-mode mismatches before acquisition. Bound pool resolution and acquisition, destroying late leases.
2. Roll back any unfinished transaction and reject a dirty tenant sentinel, changed database, wrong engine, changed identity or autocommit default other than 1.
3. Release advisory locks and perform a full protocol reset before work. Concrete transports also restore UTF8MB4 client charset. Verify clean state and inspect registered InnoDB/tenant-column metadata.
4. Enable strict SQL mode, UTC session timezone and a bounded InnoDB lock wait. Begin a pinned transaction and set a diagnostic @tenantguard_tenant sentinel. This variable is not used as database row-level security.
5. Serialize prepared CRUD statements. Swallowed validation or SQL failures poison the transaction; later queued statements cannot continue after a failure. Unawaited pending operations prevent commit.
6. Commit/rollback, explicitly release advisory locks, perform a full protocol reset and verify empty sentinel, correct database/identity and autocommit before reuse. Destroy on timeout, unsafe state, socket failure, uncertain commit or failed cleanup.

MySQL2 and MariaDB native reset methods clear server session state and their prepared-statement caches. Tests verify reuse after user variables, temporary tables and advisory locks, including successful recreation of a reset temporary-table name. Temporary-table privilege is granted only for that fault-injection test and revoked afterward; normal fixtures use CRUD-only runtime grants.

| Adapter option     | Default | Scope                                               |
| ------------------ | ------- | --------------------------------------------------- |
| acquireTimeoutMs   | 5000    | Separate bounds for resolver and acquisition        |
| operationTimeoutMs | 30000   | Acquired-session checks, callback and commit        |
| requestTimeoutMs   | 15000   | Each internal/native request                        |
| cleanupTimeoutMs   | 2000    | Each rollback, lock cleanup, reset and verification |
| lockTimeoutMs      | 5000    | InnoDB lock wait, rounded upward to whole seconds   |

The pool separately accepts max (default 10), connectTimeoutMs, acquireTimeoutMs and idleTimeoutMs. Timeouts must be positive 32-bit integer milliseconds. Cleanup is outside the work deadline and may use multiple cleanup periods. A request deadline destroys the connection; server cancellation timing is engine-dependent. Timeouts cannot cancel arbitrary application-side effects.

Ordinary callback/SQL errors are preserved after successful rollback/cleanup. ScopedSqlSafetyError indicates rejected state; ScopedSqlTimeoutError includes phase and commitOutcome; ScopedSqlCleanupError contains original/cleanup errors and commitOutcome; ScopedSqlCommitError marks an uncertain COMMIT. Outcomes are not-committed, committed or unknown. Post-commit reset failures do not undo committed writes. Use idempotency and reconcile uncertain outcomes rather than blindly retrying. Nested/detached scopes are rejected; use repositories in the current callback and reauthorize new top-level jobs.

## Verification

The exact seven reusable adapter conformance cases run separately against real MySQL 8.4 and MariaDB 11.8 using native mysql2 and mariadb drivers. Additional tests cover strict-mode refusal, outside-facade visibility, SQL/value injection attempts, automatic/immutable tenant assignment, poisoning, resets, dirty sessions, lock/request/work deadlines, nontransactional tables, serial requests, case/accent/padding aliases and killed connections.

Images are pinned multi-platform digests and run natively on this ARM Docker host; their manifests also include x86-64 for configured Linux CI. No remote CI run or independent security review has occurred. Pooling proxies, failover, alternate MySQL-compatible engines, ORM integration and version combinations beyond the tested images/drivers are not certified. The pure compiler source has a browser-target import-boundary test; driver packages and the shared lifecycle remain Node-only.
