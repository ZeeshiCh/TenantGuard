# MariaDB adapter

Direct native MariaDB Connector/Node.js adapter, sharing the [restricted CRUD and cleanup contract](../scoped-sql/README.md) with MySQL. It advertises application-filter mode. It does not implement native row-level policies or protect direct native queries outside its facade.

```ts
import { createMariadbPool, createMariadbAdapter } from '@tenantguard/mariadb';

const pool = createMariadbPool({
  connection: {
    host: 'mariadb.internal',
    database: 'saas',
    user: 'tenantguard_app',
    password: readRuntimeSecret(),
    ssl: { ca: readDatabaseCa(), rejectUnauthorized: true },
  },
  max: 10,
});
const adapter = createMariadbAdapter({
  resolvePool: (route) => lookupAllowlistedPool(route.resource),
  tables: {
    orders: {
      table: 'orders',
      tenantColumn: 'tenant_id',
      idColumn: 'id',
      columns: ['id', 'tenant_id', 'value'],
    },
  },
});
// Register pool in your server-controlled lookup. Route fields must use:
// adapter: 'mariadb', mode: 'application-filter'.
// Use the portable router with a membership-verified context, then:
// client.table('orders').find / insert / update / delete.
// Drain outstanding work and await pool.close() at shutdown.
```

The factory snapshots cloneable native connector configuration and requires a database name. It fixes positional, single-statement prepared requests, object rows, UTF8MB4, UTC client interpretation and FOUND_ROWS. Native BigInt/DECIMAL decoding stays precise by default. Full native reset clears session and prepared-cache state; the adapter also releases advisory locks and restores UTF8MB4 before verification/reuse.

Tested separately against MariaDB 11.8 with mariadb 3.5.4; the package requires the tested 3.5.4 minimum within major 3. It uses the native MariaDB connector, not MySQL2. Oracle MySQL server connections are rejected by engine validation. Both native drivers pass the same reusable cases plus connection-hardening tests; their similar protocol does not imply identical driver/reset behavior.

The portable router's strict mode rejects this weaker enforcement level. No joins, raw SQL, upserts, ORM integration or database-per-tenant mode is certified by this adapter. See the shared guide for schema requirements, exact tenant matching, timeouts, cleanup failure and commit-outcome semantics.

Reference: [MariaDB Connector/Node.js promise and reset APIs](https://mariadb.com/docs/connectors/mariadb-connector-nodejs/connector-nodejs-promise-api).
