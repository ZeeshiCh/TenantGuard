# @tenantguard/typeorm

PostgreSQL TypeORM transaction integration. `withTenantTransaction` owns a transaction-scoped manager and requires every query to use the callback manager.

```ts
await withTenantTransaction(dataSource, (manager) =>
  manager.query('SELECT * FROM orders'),
);
```

The PostgreSQL policy requires a canonical lowercase UUID tenant ID and a restricted runtime role. Do not return the manager, launch detached queries or use global repositories inside the callback. Other TypeORM providers and arbitrary query-builder access are outside the certified surface.
