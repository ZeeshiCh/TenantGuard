# MySQL adapter

Direct MySQL2 adapter with restricted tenant-scoped CRUD and dedicated physical connection cleanup. It advertises application-filter isolation, not native RLS. See the [shared CRUD/lifecycle guide](../scoped-sql/README.md) for the complete security and API contract.

```ts
import { createTenantRouter } from '@tenantguard/core';
import { createMysqlPool, createMysqlAdapter } from '@tenantguard/mysql';

const pool = createMysqlPool({
  connection: {
    host: 'mysql.internal',
    database: 'saas',
    user: 'tenantguard_app',
    password: readRuntimeSecret(),
    ssl: { ca: readDatabaseCa(), rejectUnauthorized: true },
  },
  max: 10,
});
const adapter = createMysqlAdapter({
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
// Register pool in your server-controlled lookup before accepting requests.
const router = createTenantRouter({
  sources: { orders: { adapter, mode: 'application-filter' } },
  registry: {
    resolve: async (context, source) => ({
      tenantId: context.tenantId,
      source,
      adapter: 'mysql',
      resource: 'orders-main',
      revision: '1',
      status: 'active',
      mode: 'application-filter',
    }),
  },
});
const rows = await router.run(verifiedContext, 'orders', (client) =>
  client.table('orders').find({ id: orderId }),
);
// Stop accepting work, drain it, then await pool.close().
```

The pool accepts cloneable MySQL2 connection configuration with a required database name. It forces single-statement prepared operations, positional parameters, object rows, UTF8MB4, UTC client interpretation, FOUND_ROWS and safe large-number decoding. Session SQL mode/timezone/lock limits are configured by the shared adapter. Full native connection reset clears server state and driver statement caches; UTF8MB4 is restored afterward.

Tested with MySQL 8.4 and mysql2 3.24.6. The package requires mysql2 >=3.24.6 within major 3 for the tested public reset API. Real-engine tests and clean packed JS/TS consumer checks pass locally. A MySQL2 connection to MariaDB is deliberately rejected by server-family validation; use the MariaDB package instead. Direct native SQL and ORM repositories are outside the filtering guarantee. TypeORM integration remains PostgreSQL-only.

References: [MySQL2 prepared statements](https://sidorares.github.io/node-mysql2/docs), [MySQL reset semantics](https://dev.mysql.com/doc/c-api/8.4/en/mysql-reset-connection.html).
